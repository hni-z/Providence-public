import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator.js";
import { IPhoneMirroringEvidence } from "../src/iphone-mirroring-evidence.js";
import { RequestNotAcceptedError } from "../src/iphone-mirroring-route.js";
import { createHttpServer } from "../src/server.js";
import { DeviceRequestNotSentError } from "../src/devices.js";

// The route reads evidence gated on POSIX mode bits and file ownership, which Windows does not provide.
const skipOnWindows = process.platform === "win32" ? "evidence reader requires POSIX mode bits and file ownership" : false;

async function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "providence-phone-wire-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = Date.now() / 1000;
  const app = new Coordinator({ clientToken: "c".repeat(64), localDeviceId: "mac", localDeviceName: "Fixture Mac",
    workspace: directory, devices: [{ id: "other", name: "Other fixture", token: "d".repeat(64) }] }, directory);
  const file = join(directory, "iphone-mirroring-evidence.json");
  Object.defineProperty(app, "mirroringEvidence", { value: new IPhoneMirroringEvidence(file, () => now) });
  app.devices.local.start = async () => ({ type: "synthetic" });
  await app.devices.start();
  const actualList = app.devices.list.bind(app.devices);
  app.devices.list = () => actualList().map(device => ({ ...device, online: true, platform: "darwin" }));
  const chat = app.store.addChat("Phone fixture", "mac", "phone-thread");
  const second = app.store.addChat("Another chat", "mac", "second-thread");
  const other = app.store.addChat("Other Mac chat", "other", "other-thread");
  const accepted = app.store.createTask("prior-acceptance", chat.id, "mac", "Synthetic independently observed native input").task;
  app.store.update(accepted.id, { status: "completed" });
  // Start the synthetic evidence clock after the acceptance task exists.
  // Slow CI setup must not make the observation predate that task.
  now = Date.now() / 1000 + 0.2;
  const selection = { deviceId: "mac", chatId: chat.id, phoneId: "phone_fixture", phoneName: "Fixture iPhone" };
  const target = { transport: "apple-iphone-mirroring" as const, ...selection, leaseId: "lease_fixture", action: "general" as const };
  const document = {
    selection,
    acceptanceRecords: [{ verification: "independently_verified", source: "normal_worker_native_cua",
      taskId: accepted.id, deviceId: "mac", chatId: chat.id, phoneId: selection.phoneId, action: "general",
      scope: "Synthetic Settings pre/input/post observation", observedAt: now - 0.05,
      preToolCallId: "pre", inputToolCallId: "input", postToolCallId: "post",
      phoneEffectObserved: true, ownerConfirmedPhone: true }],
    observation: { verification: "independently_verified", source: "normal_worker_native_cua", ...selection,
      sessionId: target.leaseId, observedAt: now, expiresAt: now + 30, appPresent: true, phoneReachable: true,
      authenticated: true, identityVerified: true, controllable: true, executable: true },
    quiescence: [] as Record<string, unknown>[],
  };
  const publish = () => writeFileSync(file, JSON.stringify(document), { mode: 0o600 });
  publish();
  const calls: { deviceId: string; method: string; params: any }[] = [];
  app.devices.call = async (deviceId, method, params) => { calls.push({ deviceId, method, params }); return { turnId: "synthetic-turn" }; };
  return { app, chat, second, other, target, document, publish, calls, directory,
    input: (requestId: string) => ({ requestId, text: "Open Settings on my iPhone", executionTarget: target }),
    advance: (seconds: number) => { now += seconds; }, now: () => now };
}

test("real dispatch binds/persists/echoes the phone and reconciles UUID before expired readiness", { skip: skipOnWindows }, async t => {
  const f = await fixture(t);
  const task = await f.app.dispatch(f.chat.id, f.input("phone-one"));
  assert.deepEqual(f.app.task(task.id).executionTarget, f.target);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].deviceId, "mac");
  assert.match(f.calls[0].params.text, /Providence admitted this exact iPhone Mirroring route/);
  assert.match(f.calls[0].params.text, /com.apple.ScreenContinuity/);
  f.advance(120);
  assert.equal((await f.app.dispatch(f.chat.id, f.input("phone-one"))).id, task.id);
  assert.equal(f.calls.length, 1, "same UUID must not perform the phone action again");
  await assert.rejects(f.app.dispatch(f.chat.id, { ...f.input("phone-one"), executionTarget: { ...f.target, phoneId: "different" } }), /different input/);
  await assert.rejects(f.app.dispatch(f.chat.id, { requestId: "phone-one", text: "Open Settings on my iPhone" }), /different input/);
  assert.equal(f.calls.length, 1);
});

test("only internal fresh evidence is exposed, and rejection before admission creates no task", { skip: skipOnWindows }, async t => {
  const f = await fixture(t);
  const device = f.app.devices.list().find(value => value.id === "mac")!;
  assert.equal((device.capabilities.iphoneMirroring as any).phoneId, f.target.phoneId);
  assert.ok(!JSON.stringify(device).includes("acceptanceRecords"));
  f.app.mirroringEvidence.revoke("mac");
  assert.equal(f.app.devices.list().find(value => value.id === "mac")!.capabilities.iphoneMirroring, undefined);
  await assert.rejects(f.app.dispatch(f.chat.id, f.input("not-ready")), error =>
    error instanceof RequestNotAcceptedError && error.requestId === "not-ready");
  assert.equal(f.app.store.findRequest("not-ready"), undefined);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.app.message(f.input("wrong-master-route")), /exact registered Mac/);
});

test("phone reservations cover other chats and uncertain failure, with exact host-only release", { skip: skipOnWindows }, async t => {
  const f = await fixture(t);
  const task = await f.app.dispatch(f.chat.id, f.input("reserved"));
  f.app.store.update(task.id, { status: "needs_input" });
  await assert.rejects(f.app.dispatch(f.second.id, { requestId: "other-chat", text: "Read a title" }), /unfinished|active|unresolved/);
  assert.equal((await f.app.dispatch(f.other.id, { requestId: "other-mac", text: "Read a title" })).deviceId, "other");
  f.app.event("mac", { type: "task.interrupted", taskId: task.id, error: "Lost worker acknowledgement" });
  await assert.rejects(f.app.dispatch(f.second.id, { requestId: "still-reserved", text: "Read a title",
    executionQuiescence: { verification: "independently_verified", providerQuiescent: true, taskId: task.id, leaseId: f.target.leaseId } }), /unfinished|active|unresolved/);
  // Host quiescence must be observed after the actual interruption. The fixture's
  // frozen clock can lag wall-clock task updates when the full suite is loaded.
  const interrupted = f.app.task(task.id);
  assert.equal(interrupted.status, "interrupted");
  f.advance(Math.max(0, Date.parse(interrupted.updatedAt) / 1000 - f.now()));
  f.document.quiescence = [{ verification: "independently_verified", providerQuiescent: true,
    taskId: task.id, leaseId: "wrong_lease", observedAt: f.now() }]; f.publish();
  await assert.rejects(f.app.dispatch(f.second.id, { requestId: "wrong-proof", text: "Read a title" }), /unfinished|active|unresolved/);
  f.document.quiescence[0].leaseId = f.target.leaseId; f.publish();
  const next = await f.app.dispatch(f.second.id, { requestId: "after-proof", text: "Read a title" });
  assert.equal(next.deviceId, "mac");
  assert.equal(f.app.task(task.id).status, "interrupted", "quiescence does not rewrite an uncertain outcome to success");
});

test("normal active work prevents phone admission, while historical nonphone failure does not", { skip: skipOnWindows }, async t => {
  const f = await fixture(t);
  const work = await f.app.dispatch(f.second.id, { requestId: "ordinary", text: "Read a title" });
  await assert.rejects(f.app.dispatch(f.chat.id, f.input("busy-phone")), /unfinished|active|unresolved/);
  f.app.event("mac", { type: "task.failed", taskId: work.id, error: "Synthetic failure" });
  assert.equal((await f.app.dispatch(f.chat.id, f.input("phone-after"))).deviceId, "mac");
});

test("queued phone work revalidates; definite pre-dispatch rejection does not quarantine the Mac", { skip: skipOnWindows }, async t => {
  const f = await fixture(t);
  const dependency = await f.app.dispatch(f.other.id, { requestId: "dependency", text: "Read a title" });
  const task = await f.app.dispatch(f.chat.id, { ...f.input("queued-phone"), afterTaskId: dependency.id });
  assert.equal(task.status, "queued");
  assert.equal(f.calls.filter(value => value.deviceId === "mac").length, 0);
  f.advance(120);
  f.app.event("other", { type: "task.completed", taskId: dependency.id, text: "Synthetic result" });
  assert.equal(f.app.task(task.id).status, "failed");
  assert.equal(f.calls.filter(value => value.deviceId === "mac").length, 0);
  assert.equal(f.app.task(task.id).executionQuiescence?.providerQuiescent, true);
  assert.equal((await f.app.dispatch(f.second.id, { requestId: "normal-after", text: "Read a title" })).deviceId, "mac");
});

test("proven offline before worker send releases reservation; an unknown dispatch outcome does not", { skip: skipOnWindows }, async t => {
  for (const known of [true, false]) {
    const f = await fixture(t);
    f.app.devices.call = async () => { throw known ? new DeviceRequestNotSentError("Offline before dispatch") : new Error("Unknown transport result"); };
    const task = await f.app.dispatch(f.chat.id, f.input(known ? "never-sent" : "unknown-send"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.app.task(task.id).status, "failed");
    assert.equal(f.app.task(task.id).executionQuiescence?.providerQuiescent, known ? true : undefined);
  }
});

test("HTTP pre-admission rejection identifies the exact unused request UUID", { skip: skipOnWindows }, async t => {
  const f = await fixture(t);
  f.advance(120);
  const server = createHttpServer(f.app, f.app.config.clientToken, { webRoot: f.directory, questRoot: f.directory });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/chats/${f.chat.id}/messages`, {
    method: "POST", headers: { authorization: `Bearer ${f.app.config.clientToken}`, "content-type": "application/json" },
    body: JSON.stringify(f.input("unused_request")),
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.requestId, "unused_request"); assert.equal(body.requestStatus, "not_accepted");
  assert.equal(body.errorCode, "notConfigured");
  assert.equal(f.app.store.findRequest("unused_request"), undefined);
  assert.equal(f.calls.length, 0);
});

test("durable private binding exposes configuration and admits normal preflight, revocation cannot reuse legacy readiness", { skip: skipOnWindows }, async t => {
  const f = await fixture(t);
  const binding = { verification: "owner_confirmed_pairing", enabled: true, deviceId: "mac", chatId: f.chat.id,
    phoneId: f.target.phoneId, phoneName: f.target.phoneName, epoch: f.target.leaseId, allowedActions: ["general"], confirmedAt: f.now() };
  const publish = () => writeFileSync(join(f.directory, "iphone-mirroring-evidence.json"),
    JSON.stringify({ ...f.document, schemaVersion: 2, binding }), { mode: 0o600 });
  publish(); f.advance(86400);
  f.app.mirroringEvidence.revoke("mac"); // Offline resets live observations, not routing configuration.
  const view = f.app.devices.list().find(value => value.id === "mac")!.capabilities;
  assert.equal(view.iphoneMirroring, undefined);
  assert.equal((view.iphoneMirroringBinding as any).status, "configured");
  assert.equal((view.iphoneMirroringBinding as any).requiresLivePreflight, true);
  assert.equal((view.iphoneMirroringBinding as any).grantsPermission, false);
  assert.equal((view.iphoneMirroringBinding as any).executable, undefined);
  const task = await f.app.dispatch(f.chat.id, f.input("binding-attempt"));
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].params.text, /Complete live preflight through the normal worker first/);
  assert.match(f.calls[0].params.text, /fresh post-action observation may share one tool call/);
  binding.enabled = false; publish();
  assert.equal((await f.app.dispatch(f.chat.id, f.input("binding-attempt"))).id, task.id, "old UUID reconciles after revocation without replay");
  f.app.event("mac", { type: "task.completed", taskId: task.id, text: "Synthetic no-effect result" });
  await assert.rejects(f.app.dispatch(f.chat.id, f.input("revoked-attempt")), error =>
    error instanceof RequestNotAcceptedError && error.reasonCode === "notConfigured");
  assert.equal(f.calls.length, 1);
  assert.equal(f.app.store.findRequest("revoked-attempt"), undefined);
});

test("queued configured phone route checks changed binding epoch before provider dispatch", { skip: skipOnWindows }, async t => {
  const f = await fixture(t);
  const binding = { verification: "owner_confirmed_pairing", enabled: true, deviceId: "mac", chatId: f.chat.id,
    phoneId: f.target.phoneId, phoneName: f.target.phoneName, epoch: f.target.leaseId, allowedActions: ["general"], confirmedAt: f.now() };
  const publish = () => writeFileSync(join(f.directory, "iphone-mirroring-evidence.json"), JSON.stringify({ schemaVersion: 2, binding }), { mode: 0o600 });
  publish();
  const dependency = await f.app.dispatch(f.other.id, { requestId: "binding-dependency", text: "Read a title" });
  const task = await f.app.dispatch(f.chat.id, { ...f.input("queued-binding"), afterTaskId: dependency.id });
  binding.epoch = "new-binding-epoch"; publish();
  f.app.event("other", { type: "task.completed", taskId: dependency.id, text: "Synthetic result" });
  assert.equal(f.app.task(task.id).status, "failed");
  assert.equal(f.calls.filter(value => value.deviceId === "mac").length, 0);
  assert.equal(f.app.task(task.id).executionQuiescence?.providerQuiescent, true);
});
