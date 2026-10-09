import assert from "node:assert/strict";
import test from "node:test";
import {
  HostRouteError,
  assertGUIAvailable,
  authorizeMirroringDispatch,
  executionTargetsEqual,
  parseExecutionTarget,
} from "./host-route.mjs";

const now = 1_000;
const target = () => ({
  transport: "apple-iphone-mirroring", deviceId: "demo-mac", chatId: "chat_1",
  phoneId: "demo-phone", phoneName: "Demo iPhone", leaseId: "lease_1", action: "messaging",
});
const device = { id: "demo-mac", online: true, platform: "macOS" };
const chat = { id: "chat_1", deviceId: "demo-mac", online: true };
const capability = () => ({
  schemaVersion: 1, transport: "apple-iphone-mirroring", appBundleId: "com.apple.ScreenContinuity",
  deviceId: "demo-mac", chatId: "chat_1", phoneId: "demo-phone", phoneName: "Demo iPhone",
  sessionId: "lease_1", observedAt: 990, expiresAt: 1_010, supportedActions: ["messaging"],
  configured: true, appPresent: true, phoneReachable: true, authenticated: true,
  identityVerified: true, controllable: true, effectVerified: true, executable: true,
});

function expectCode(action, code) {
  assert.throws(action, (error) => error instanceof HostRouteError && error.code === code);
}

test("canonicalizes only exact flat iPhone Mirroring targets", () => {
  const parsed = parseExecutionTarget(target());
  assert.deepEqual(Object.keys(parsed), ["transport", "deviceId", "chatId", "phoneId", "phoneName", "leaseId", "action"]);
  assert.equal(parseExecutionTarget(undefined), undefined);
  for (const change of [
    (value) => { value.extra = true; }, (value) => { delete value.leaseId; },
    (value) => { value.phoneName = " \n"; }, (value) => { value.action = "calls"; },
    (value) => { value.deviceId = "bad id"; },
  ]) {
    const value = target(); change(value);
    expectCode(() => parseExecutionTarget(value), "invalidExecutionTarget");
  }
  expectCode(() => parseExecutionTarget(Object.assign(Object.create({}), target())), "invalidExecutionTarget");
});

test("target equality includes the phone and readiness lease", () => {
  assert.equal(executionTargetsEqual(target(), target()), true);
  const phoneDrift = target(); phoneDrift.phoneId = "other-phone";
  const leaseDrift = target(); leaseDrift.leaseId = "lease_2";
  assert.equal(executionTargetsEqual(target(), phoneDrift), false);
  assert.equal(executionTargetsEqual(target(), leaseDrift), false);
});

test("admits only matching, live Mac/chat evidence and a fresh exact lease", () => {
  assert.deepEqual(authorizeMirroringDispatch({ executionTarget: target(), device, chat, capability: capability(), tasks: [], taskId: "task_1", now }), target());
  expectCode(() => authorizeMirroringDispatch({ executionTarget: target(), device: { ...device, id: "other" }, chat, capability: capability(), tasks: [], taskId: "task_1", now }), "wrongTarget");
  expectCode(() => authorizeMirroringDispatch({ executionTarget: target(), device: { ...device, online: false }, chat, capability: capability(), tasks: [], taskId: "task_1", now }), "macUnavailable");
  expectCode(() => authorizeMirroringDispatch({ executionTarget: target(), device, chat: { ...chat, online: false }, capability: capability(), tasks: [], taskId: "task_1", now }), "chatUnavailable");
  const expired = capability(); expired.expiresAt = now;
  expectCode(() => authorizeMirroringDispatch({ executionTarget: target(), device, chat, capability: expired, tasks: [], taskId: "task_1", now }), "staleEvidence");
  const changedLease = capability(); changedLease.sessionId = "lease_2";
  expectCode(() => authorizeMirroringDispatch({ executionTarget: target(), device, chat, capability: changedLease, tasks: [], taskId: "task_1", now }), "sessionChanged");
});

test("rejects overlapping persisted phone tasks while allowing other hosts and the same task", () => {
  const activePhone = { id: "task_phone", deviceId: "demo-mac", status: "running", executionTarget: target() };
  expectCode(() => assertGUIAvailable({ deviceId: "demo-mac", taskId: "task_ordinary", tasks: [activePhone] }), "deviceBusy");
  expectCode(() => assertGUIAvailable({ deviceId: "demo-mac", taskId: "task_two_phone", executionTarget: target(), tasks: [activePhone] }), "deviceBusy");
  assert.doesNotThrow(() => assertGUIAvailable({ deviceId: "other-mac", taskId: "task_ordinary", tasks: [activePhone] }));
  assert.doesNotThrow(() => assertGUIAvailable({ deviceId: "demo-mac", taskId: "task_phone", executionTarget: target(), tasks: [activePhone] }));
});

test("does not queue ordinary work behind ordinary work, preventing nested deadlock", () => {
  const ordinary = { id: "parent", deviceId: "demo-mac", status: "running" };
  assert.doesNotThrow(() => assertGUIAvailable({ deviceId: "demo-mac", taskId: "child", tasks: [ordinary] }));
});

test("phone admission rejects active ordinary work and retains approval-wait exclusivity", () => {
  for (const status of ["queued", "running", "needs_input"]) {
    expectCode(() => assertGUIAvailable({ deviceId: "demo-mac", taskId: "phone", executionTarget: target(),
      tasks: [{ id: "ordinary", deviceId: "demo-mac", status }] }), "deviceBusy");
    expectCode(() => assertGUIAvailable({ deviceId: "demo-mac", taskId: "ordinary",
      tasks: [{ id: "phone", deviceId: "demo-mac", status, executionTarget: target() }] }), "deviceBusy");
  }
  assert.doesNotThrow(() => assertGUIAvailable({ deviceId: "demo-mac", taskId: "ordinary",
    tasks: [{ id: "phone", deviceId: "demo-mac", status: "completed", executionTarget: target() }] }));
});

test("missing task inventory cannot silently bypass host reservation", () => {
  expectCode(() => assertGUIAvailable({ deviceId: "demo-mac" }), "invalidEvidence");
});

test("lost provider outcome quarantines only the mirrored host reservation", () => {
  for (const status of ["interrupted", "failed", "cancelled"]) {
    const uncertain = { id: "phone", deviceId: "demo-mac", status, executionTarget: target() };
    expectCode(() => assertGUIAvailable({ deviceId: "demo-mac", taskId: "ordinary", tasks: [uncertain] }), "deviceBusy");
    expectCode(() => assertGUIAvailable({ deviceId: "demo-mac", taskId: "other-phone", executionTarget: target(), tasks: [uncertain] }), "deviceBusy");
    assert.doesNotThrow(() => assertGUIAvailable({ deviceId: "other-mac", taskId: "ordinary", tasks: [uncertain] }));
    const ordinary = { ...uncertain }; delete ordinary.executionTarget;
    assert.doesNotThrow(() => assertGUIAvailable({ deviceId: "demo-mac", taskId: "next-phone", executionTarget: target(), tasks: [ordinary] }));
  }
});

test("only exact host-owned task/lease quiescence releases uncertain reservation", () => {
  const proof = { verification: "independently_verified", providerQuiescent: true, taskId: "phone", leaseId: "lease_1" };
  const uncertain = { id: "phone", deviceId: "demo-mac", status: "interrupted", executionTarget: target(), executionQuiescence: proof };
  assert.doesNotThrow(() => assertGUIAvailable({ deviceId: "demo-mac", taskId: "ordinary", tasks: [uncertain] }));
  for (const change of [{ verification: "client" }, { providerQuiescent: false }, { taskId: "other" }, { leaseId: "other" }]) {
    expectCode(() => assertGUIAvailable({ deviceId: "demo-mac", taskId: "ordinary",
      tasks: [{ ...uncertain, executionQuiescence: { ...proof, ...change } }] }), "deviceBusy");
  }
  expectCode(() => assertGUIAvailable({ deviceId: "demo-mac", taskId: "ordinary",
    tasks: [{ ...uncertain, status: "needs_input" }] }), "deviceBusy");
});

test("does not mutate supplied policy inputs", () => {
  const executionTarget = target();
  const evidence = capability();
  const tasks = [{ id: "other", deviceId: "other-mac", status: "queued", executionTarget: target() }];
  const before = structuredClone({ executionTarget, device, chat, evidence, tasks });
  authorizeMirroringDispatch({ executionTarget, device, chat, capability: evidence, tasks, taskId: "task_1", now });
  assert.deepEqual({ executionTarget, device, chat, evidence, tasks }, before);
});

test("configured binding admits an attempt without claiming live readiness", () => {
  const binding = {
    schemaVersion: 1, transport: "apple-iphone-mirroring", appBundleId: "com.apple.ScreenContinuity",
    status: "configured", deviceId: "demo-mac", chatId: "chat_1", phoneId: "demo-phone", phoneName: "Demo iPhone",
    bindingEpoch: "lease_1", allowedActions: ["general", "messaging"], requiresLivePreflight: true, grantsPermission: false,
  };
  const input = { executionTarget: target(), device, chat, binding, tasks: [], taskId: "task_1", now: now + 86400 };
  assert.deepEqual(authorizeMirroringDispatch(input), target());
  for (const change of [{ grantsPermission: true }, { requiresLivePreflight: false }, { status: "ready" }, { bindingEpoch: "" }]) {
    expectCode(() => authorizeMirroringDispatch({ ...input, capability: capability(), binding: { ...binding, ...change } }), "invalidEvidence");
  }
  expectCode(() => authorizeMirroringDispatch({ ...input, capability: capability(), binding: null }), "invalidEvidence");
  expectCode(() => authorizeMirroringDispatch({ ...input, binding: { ...binding, phoneId: "different" } }), "wrongTarget");
  expectCode(() => authorizeMirroringDispatch({ ...input, binding: { ...binding, bindingEpoch: "changed" } }), "sessionChanged");
  expectCode(() => authorizeMirroringDispatch({ ...input, binding: { ...binding, allowedActions: ["general"] } }), "unsupportedAction");
  expectCode(() => authorizeMirroringDispatch({ ...input, device: { ...device, online: false } }), "macUnavailable");
  expectCode(() => authorizeMirroringDispatch({ ...input, tasks: [{ id: "other", deviceId: "demo-mac", status: "running" }] }), "deviceBusy");
});
