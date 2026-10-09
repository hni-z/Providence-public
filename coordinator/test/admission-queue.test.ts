import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Coordinator } from "../src/coordinator.js";
import { RequestNotAcceptedError } from "../src/iphone-mirroring-route.js";
import { admissionQueueCapabilities, MAX_QUEUED_PER_CHAT } from "../src/admission-queue.js";
import type { Task } from "../src/store.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "providence-admission-"));
  const config = { clientToken: "c".repeat(64), localDeviceId: "mac", localDeviceName: "Fixture Mac", workspace: directory,
    devices: [{ id: "other", name: "Fixture Windows", token: "o".repeat(64) }] };
  const app = new Coordinator(config, directory);
  const main = app.store.addChat("Main", "mac", "main-thread"), phone = app.store.addChat("Phone", "mac", "phone-thread"),
    second = app.store.addChat("Second", "mac", "second-thread"), other = app.store.addChat("Other", "other", "other-thread");
  const target = { transport: "apple-iphone-mirroring" as const, deviceId: "mac", chatId: phone.id, phoneId: "fixture-phone", phoneName: "Fixture phone", leaseId: "fixture-epoch", action: "general" as const };
  let binding: any = { schemaVersion: 1, transport: target.transport, appBundleId: "com.apple.ScreenContinuity", status: "configured",
    deviceId: "mac", chatId: phone.id, phoneId: target.phoneId, phoneName: target.phoneName, bindingEpoch: target.leaseId,
    allowedActions: ["general"], requiresLivePreflight: true, grantsPermission: false };
  const online = new Set(["mac", "other"]);
  app.devices.online = (id) => online.has(id);
  app.devices.list = () => ["mac", "other"].map((id) => ({ id, name: id, online: online.has(id), platform: id === "mac" ? "darwin" : "win32",
    capabilities: { files: true, shell: true, browser: false, desktop: false, ...(id === "mac" && binding ? { iphoneMirroringBinding: binding } : {}) } })) as any;
  const calls: { deviceId: string; method: string; params: any }[] = [];
  app.devices.call = async (deviceId, method, params) => { calls.push({ deviceId, method, params }); return { turnId: `turn-${params.taskId}` }; };
  const masters: { taskId: string; prompt: string }[] = [];
  app.master.create = async () => ({ threadId: "master-thread", workspace: directory });
  app.master.execute = async (_thread, taskId, prompt) => { masters.push({ taskId, prompt }); return { turnId: `turn-${taskId}` }; };
  const finish = (task: Task, status = "completed") => app.event(task.deviceId, { type: `task.${status}`, taskId: task.id, text: `Result for ${task.id}` });
  return { app, directory, config, main, phone, second, other, online, target, calls, masters, finish,
    setBinding: (value: any) => { binding = value; }, getBinding: () => binding,
    cleanup: async () => { app.stop(); await setImmediate(); rmSync(directory, { recursive: true, force: true }); } };
}

test("opt-in queues simultaneous same-chat requests exactly once while legacy callers still reject busy", async () => {
  const f = fixture();
  try {
    const input = (requestId: string) => ({ requestId, text: requestId, queueIfBusy: true });
    const [first, second, third] = await Promise.all(["one", "two", "three"].map((id) => f.app.dispatch(f.main.id, input(id))));
    assert.deepEqual([first.status, second.status, third.status], ["running", "queued", "queued"]);
    assert.equal(f.calls.length, 1); assert.equal(second.afterTaskId, undefined); assert.deepEqual(second.sourceChatIds, []);
    assert.deepEqual(second.admissionQueue, { reason: "chat_busy", predecessorTaskId: first.id });
    const persisted = JSON.parse(readFileSync(join(f.directory, "state.json"), "utf8"));
    assert.equal(persisted.tasks[second.id].queueIfBusy, true); assert.equal(persisted.tasks[second.id].deviceId, "mac");
    assert.equal((await f.app.dispatch(f.main.id, input("two"))).id, second.id);
    await assert.rejects(f.app.dispatch(f.main.id, { ...input("two"), queueIfBusy: false }), /different input/);
    await assert.rejects(f.app.dispatch(f.main.id, { requestId: "legacy", text: "Legacy" }), (error) => error instanceof RequestNotAcceptedError && error.reasonCode === "chatBusy");
    assert.equal(f.app.store.findRequest("legacy"), undefined);
    f.finish(first);
    assert.equal(f.calls.length, 1, "wait for the provider's terminal notification stack to release its active turn");
    await setImmediate();
    assert.equal(second.status, "running"); assert.equal(third.status, "queued");
    f.finish(first); await setImmediate(); assert.equal(f.calls.length, 2);
    f.finish(second, "failed"); await setImmediate();
    assert.equal(third.status, "running");
    assert.deepEqual(f.calls.map((call) => call.params.text), ["one", "two", "three"]);
    assert.equal(f.app.store.state.events.filter((event) => event.type === "context.transferred").length, 0);
  } finally { await f.cleanup(); }
});

test("independent chats remain parallel and cancelling a queued item does not cancel the following intent", async () => {
  const f = fixture();
  try {
    const first = await f.app.dispatch(f.main.id, { requestId: "first", text: "First" });
    const cancelled = await f.app.dispatch(f.main.id, { requestId: "cancelled", text: "Cancel this", queueIfBusy: true });
    const last = await f.app.dispatch(f.main.id, { requestId: "last", text: "Independent last", queueIfBusy: true });
    const parallel = await f.app.dispatch(f.second.id, { requestId: "parallel", text: "Parallel" });
    assert.equal(parallel.status, "running"); assert.equal(f.calls.length, 2);
    await f.app.cancel(cancelled.id); await setImmediate();
    assert.equal(cancelled.status, "cancelled"); assert.equal(last.status, "queued");
    f.finish(first, "failed"); await setImmediate();
    assert.equal(last.status, "running"); assert.equal(f.calls.at(-1)?.params.text, "Independent last");
    assert.equal(f.calls.filter((call) => call.params.taskId === cancelled.id).length, 0);
  } finally { await f.cleanup(); }
});

test("queue depth is bounded and duplicate reconciliation precedes the typed full-queue rejection", async () => {
  const f = fixture();
  try {
    await f.app.dispatch(f.main.id, { requestId: "active", text: "Active" });
    for (let index = 0; index < MAX_QUEUED_PER_CHAT; index++)
      await f.app.dispatch(f.main.id, { requestId: `waiting-${index}`, text: "Waiting", queueIfBusy: true });
    const count = Object.keys(f.app.store.state.tasks).length;
    await assert.rejects(f.app.dispatch(f.main.id, { requestId: "full", text: "No room", queueIfBusy: true }),
      (error) => error instanceof RequestNotAcceptedError && error.requestId === "full" && error.reasonCode === "queueFull");
    assert.equal(Object.keys(f.app.store.state.tasks).length, count);
    assert.equal((await f.app.dispatch(f.main.id, { requestId: "waiting-0", text: "Waiting", queueIfBusy: true })).status, "queued");
    assert.deepEqual(admissionQueueCapabilities(), { version: 1, supported: true, requestField: "queueIfBusy", maxQueuedPerChat: 8, restartBehavior: "interrupt_no_replay" });
  } finally { await f.cleanup(); }
});

test("phone and later Mac requests queue without self-deadlock and retain actual GUI exclusion", async () => {
  const f = fixture();
  try {
    const active = await f.app.dispatch(f.main.id, { requestId: "mac-first", text: "Mac first" });
    const phone = await f.app.dispatch(f.phone.id, { requestId: "phone-next", text: "Phone next", executionTarget: f.target, queueIfBusy: true });
    const later = await f.app.dispatch(f.second.id, { requestId: "mac-last", text: "Mac last", queueIfBusy: true });
    assert.equal(phone.status, "queued"); assert.equal(later.status, "queued");
    assert.equal(phone.admissionQueue?.reason, "device_busy");
    assert.deepEqual(phone.executionTarget, f.target);
    await assert.rejects(f.app.dispatch(f.phone.id, { requestId: "legacy-phone", text: "No queue", executionTarget: f.target }), RequestNotAcceptedError);
    f.finish(active); await setImmediate();
    assert.equal(phone.status, "running"); assert.equal(later.status, "queued"); assert.equal(f.calls.length, 2);
    f.finish(phone); await setImmediate();
    assert.equal(later.status, "running"); assert.equal(f.calls.length, 3);
  } finally { await f.cleanup(); }
});

test("unknown phone outcomes remain reserved; only exact existing host quiescence evidence releases a wait", async () => {
  const f = fixture();
  try {
    const phone = await f.app.dispatch(f.phone.id, { requestId: "uncertain-phone", text: "Phone", executionTarget: f.target });
    const queued = await f.app.dispatch(f.main.id, { requestId: "waiting-mac", text: "Wait for Mac", queueIfBusy: true });
    f.finish(phone, "interrupted"); await setImmediate();
    assert.equal(queued.status, "queued"); assert.equal(phone.executionQuiescence, undefined);
    f.app.devices.emit("online", "mac"); await setImmediate();
    assert.equal(queued.status, "queued"); assert.equal(f.calls.length, 1);
    f.app.mirroringEvidence.quiescenceForTask = (task) => task.id === phone.id ? {
      verification: "independently_verified", providerQuiescent: true, taskId: phone.id, leaseId: f.target.leaseId,
    } : undefined;
    f.app.devices.emit("online", "mac"); await setImmediate();
    assert.equal(queued.status, "running"); assert.equal(f.calls.length, 2);
  } finally { await f.cleanup(); }
});

test("offline and invalid phone binding reject before admission; changed queued binding never reroutes", async () => {
  const f = fixture();
  try {
    const active = await f.app.dispatch(f.main.id, { requestId: "active", text: "First" });
    f.online.delete("other");
    await assert.rejects(f.app.dispatch(f.other.id, { requestId: "offline", text: "Offline", queueIfBusy: true }), /offline/);
    const binding = f.getBinding(); f.setBinding({ ...binding, phoneId: "wrong-phone" });
    await assert.rejects(f.app.dispatch(f.phone.id, { requestId: "wrong-phone", text: "Phone", executionTarget: f.target, queueIfBusy: true }), /binding changed/);
    assert.equal(f.app.store.findRequest("wrong-phone"), undefined);
    f.setBinding(binding);
    const queued = await f.app.dispatch(f.main.id, { requestId: "queued", text: "Exact Mac", queueIfBusy: true });
    f.main.deviceId = "other";
    f.finish(active); await setImmediate();
    assert.equal(queued.status, "failed"); assert.match(queued.error!, /computer changed/);
    assert.equal(f.calls.length, 1);
  } finally { await f.cleanup(); }
});

test("phone epoch is rechecked at release without fallback", async () => {
  const f = fixture();
  try {
    const active = await f.app.dispatch(f.main.id, { requestId: "active", text: "First" });
    const queued = await f.app.dispatch(f.phone.id, { requestId: "phone", text: "Exact phone", executionTarget: f.target, queueIfBusy: true });
    f.setBinding({ ...f.getBinding(), bindingEpoch: "new-epoch" });
    f.finish(active); await setImmediate();
    assert.equal(queued.status, "failed"); assert.match(queued.error!, /route changed/); assert.equal(f.calls.length, 1);
    assert.equal(queued.executionQuiescence?.taskId, queued.id);
  } finally { await f.cleanup(); }
});

test("queue opt-in never turns a known phone authentication blocker into accepted work", async () => {
  const f = fixture();
  try {
    await f.app.dispatch(f.main.id, { requestId: "active", text: "First" });
    f.setBinding(undefined);
    const originalList = f.app.devices.list.bind(f.app.devices), now = Date.now() / 1000;
    f.app.devices.list = () => originalList().map((device) => device.id !== "mac" ? device : { ...device, capabilities: { ...device.capabilities,
      iphoneMirroring: { schemaVersion: 1, transport: f.target.transport, appBundleId: "com.apple.ScreenContinuity", sessionId: f.target.leaseId,
        deviceId: f.target.deviceId, chatId: f.target.chatId, phoneId: f.target.phoneId, phoneName: f.target.phoneName,
        observedAt: now, expiresAt: now + 30, configured: true, appPresent: true, phoneReachable: true, authenticated: false,
        identityVerified: true, controllable: true, effectVerified: true, executable: true, supportedActions: ["general"] },
    } }) as any;
    await assert.rejects(f.app.dispatch(f.phone.id, { requestId: "auth-blocked", text: "Phone", executionTarget: f.target, queueIfBusy: true }),
      (error) => error instanceof RequestNotAcceptedError && error.reasonCode === "authenticationRequired");
    assert.equal(f.app.store.findRequest("auth-blocked"), undefined); assert.equal(f.calls.length, 1);
  } finally { await f.cleanup(); }
});

test("cancelled never-started phone work releases only its own unused reservation", async () => {
  const f = fixture();
  try {
    await f.app.dispatch(f.main.id, { requestId: "active", text: "First" });
    const phone = await f.app.dispatch(f.phone.id, { requestId: "queued-phone", text: "Phone", executionTarget: f.target, queueIfBusy: true });
    const independent = await f.app.dispatch(f.second.id, { requestId: "independent", text: "Independent", queueIfBusy: true });
    await f.app.cancel(phone.id); await setImmediate();
    assert.equal(phone.status, "cancelled"); assert.equal(phone.executionQuiescence?.taskId, phone.id);
    assert.equal(independent.status, "running"); assert.equal(f.calls.filter((call) => call.params.taskId === phone.id).length, 0);
  } finally { await f.cleanup(); }
});

test("a pending provider input holds its conversation queue until the actual task finishes", async () => {
  const f = fixture();
  try {
    const first = await f.app.dispatch(f.main.id, { requestId: "first", text: "First" });
    f.app.event("mac", { type: "approval.requested", taskId: first.id, approvalId: "fixture-approval", method: "item/tool/requestUserInput", details: {} });
    const queued = await f.app.dispatch(f.main.id, { requestId: "queued", text: "Next", queueIfBusy: true });
    assert.equal(first.status, "needs_input"); assert.equal(queued.status, "queued");
    f.app.event("mac", { type: "approval.resolved", taskId: first.id, approvalId: "fixture-approval" });
    await setImmediate(); assert.equal(queued.status, "queued"); assert.equal(f.calls.length, 1);
    f.finish(first); await setImmediate();
    assert.equal(queued.status, "running"); assert.equal(f.calls.length, 2);
  } finally { await f.cleanup(); }
});

test("semantic dependency failure stops dependent work but not an independent admission successor", async () => {
  const f = fixture();
  try {
    const first = await f.app.dispatch(f.main.id, { requestId: "first", text: "First" });
    const independent = await f.app.dispatch(f.main.id, { requestId: "independent", text: "Independent", queueIfBusy: true });
    const dependent = await f.app.dispatch(f.other.id, { requestId: "dependent", text: "Needs success", afterTaskId: first.id, queueIfBusy: true });
    f.finish(first, "failed"); await setImmediate();
    assert.equal(independent.status, "running"); assert.equal(dependent.status, "interrupted");
    assert.equal(independent.afterTaskId, undefined); assert.deepEqual(independent.sourceChatIds, []);
    assert.equal(f.calls.length, 2);
  } finally { await f.cleanup(); }
});

test("master FIFO and request-scoped child opt-in preserve background work after the parent reply", async () => {
  const f = fixture();
  try {
    const [first, second] = await Promise.all(["root-one", "root-two"].map((requestId) => f.app.message({ requestId, text: requestId, queueIfBusy: true })));
    await setImmediate(); assert.equal(f.masters.length, 1); assert.equal(second.status, "queued");
    await assert.rejects(f.app.message({ requestId: "legacy-root", text: "No queue" }), /busy/);
    f.finish(first, "failed"); await setImmediate();
    assert.equal(f.masters.length, 2); assert.equal(f.masters[1].prompt, "root-two");
    const existing = await f.app.dispatch(f.main.id, { requestId: "existing", text: "Existing worker" });
    const child = await (f.app as any).handleTool("providence_dispatch", { chatId: f.main.id, text: "Background child" }, "child-request", second.id) as Task;
    assert.equal(child.queueIfBusy, true); assert.equal(child.status, "queued");
    await assert.rejects((f.app as any).handleTool("providence_dispatch", { chatId: f.main.id, text: "Explicit legacy", queueIfBusy: false }, "no-inherit", second.id), /busy/);
    f.finish(second); assert.equal(f.app.task(second.id).workStatus, "queued");
    f.finish(existing); await setImmediate();
    assert.equal(child.status, "running"); assert.equal(f.app.task(second.id).workStatus, "running");
  } finally { await f.cleanup(); }
});

test("restart interrupts a durable admission queue and same request IDs never replay", async () => {
  const f = fixture();
  try {
    await f.app.dispatch(f.main.id, { requestId: "active", text: "First" });
    const input = { requestId: "queued", text: "Second", queueIfBusy: true };
    const queued = await f.app.dispatch(f.main.id, input);
    f.app.stop();
    const restarted = new Coordinator(f.config, f.directory);
    let starts = 0; restarted.devices.call = async () => { starts++; return {}; };
    assert.equal(restarted.task(queued.id).status, "interrupted");
    assert.equal((await restarted.dispatch(f.main.id, input)).id, queued.id);
    restarted.devices.emit("online", "mac"); await setImmediate();
    assert.equal(starts, 0);
    restarted.stop();
  } finally { await f.cleanup(); }
});
