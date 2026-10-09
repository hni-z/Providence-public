import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IPhoneMirroringEvidence, type TaskLike } from "../src/iphone-mirroring-evidence.js";

// The evidence reader requires POSIX mode bits and file ownership, which Windows does not provide.
const skipOnWindows = process.platform === "win32" ? "evidence reader requires POSIX mode bits and file ownership" : false;

const selection = { deviceId: "demo-mac", chatId: "chat_1", phoneId: "demo-phone", phoneName: "Demo iPhone" };
const task: TaskLike = {
  id: "accepted-task", deviceId: "demo-mac", chatId: "chat_1", status: "completed",
  createdAt: "1970-01-01T00:16:00.000Z", updatedAt: "1970-01-01T00:16:20.000Z",
};

function document(overrides: Record<string, unknown> = {}) {
  return {
    selection,
    acceptanceRecords: [{
      verification: "independently_verified", source: "normal_worker_native_cua", taskId: task.id,
      deviceId: selection.deviceId, chatId: selection.chatId, phoneId: selection.phoneId,
      action: "messaging", scope: "Observed the exact selected phone and a completed supported workflow.",
      observedAt: 985, preToolCallId: "pre_1", inputToolCallId: "input_1", postToolCallId: "post_1",
      phoneEffectObserved: true, ownerConfirmedPhone: true,
    }],
    observation: {
      verification: "independently_verified", source: "normal_worker_native_cua", ...selection,
      sessionId: "lease_1", observedAt: 990, expiresAt: 1_010,
      appPresent: true, phoneReachable: true, authenticated: true, identityVerified: true,
      controllable: true, executable: true,
    },
    ...overrides,
  };
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    verification: "owner_confirmed_pairing", enabled: true, ...selection, epoch: "epoch_1",
    allowedActions: ["browser", "messaging"], confirmedAt: 990, ...overrides,
  };
}

function bindingDocument(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 2, binding: binding(), ...overrides };
}

function withEvidence(run: (file: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "providence-iphone-evidence-"));
  const file = join(directory, "evidence.json");
  try { run(file); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function write(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

test("fresh host evidence derives only the publisher's public capability fields", { skip: skipOnWindows }, () => withEvidence(file => {
  write(file, document());
  let now = 900;
  const evidence = new IPhoneMirroringEvidence(file, () => now);
  now = 1_000;
  const capability = evidence.forDevice("demo-mac", { [task.id]: task });
  assert.equal(capability?.transport, "apple-iphone-mirroring");
  assert.equal(capability?.sessionId, "lease_1");
  assert.equal(capability?.observedAt, 990);
  assert.deepEqual(capability?.supportedActions, ["messaging"]);
  assert.equal("acceptanceRecords" in (capability ?? {}), false);
}));

test("startup and device revocation require a later observed record without minting time", { skip: skipOnWindows }, () => withEvidence(file => {
  write(file, document());
  const atStartup = new IPhoneMirroringEvidence(file, () => 990);
  assert.equal(atStartup.forDevice("demo-mac", { [task.id]: task }), undefined);

  let now = 900;
  const evidence = new IPhoneMirroringEvidence(file, () => now);
  now = 1_000;
  assert.equal(evidence.forDevice("demo-mac", { [task.id]: task })?.observedAt, 990);
  evidence.revoke("demo-mac");
  assert.equal(evidence.forDevice("demo-mac", { [task.id]: task }), undefined);
  write(file, document({ observation: { ...document().observation, observedAt: 1_001, expiresAt: 1_020 } }));
  now = 1_005;
  assert.equal(evidence.forDevice("demo-mac", { [task.id]: task })?.observedAt, 1_001);
}));

test("stale, mismatched, false, corrupt, oversized, symlinked, and unrelated evidence fail closed", { skip: skipOnWindows }, () => withEvidence(file => {
  for (const value of [
    document({ observation: { ...document().observation, expiresAt: 1_000 } }),
    document({ selection: { ...selection, deviceId: "other-mac" } }),
    document({ observation: { ...document().observation, controllable: false } }),
    { selection, acceptanceRecords: new Array(65), observation: document().observation },
    { ...document(), quiescence: new Array(65) },
  ]) {
    write(file, value);
    assert.equal(new IPhoneMirroringEvidence(file, () => 1_000).forDevice("demo-mac", { [task.id]: task }), undefined);
  }
  writeFileSync(file, "{ corrupt");
  assert.equal(new IPhoneMirroringEvidence(file, () => 1_000).forDevice("demo-mac", { [task.id]: task }), undefined);
  writeFileSync(file, "x".repeat(256 * 1024 + 1), { mode: 0o600 });
  assert.equal(new IPhoneMirroringEvidence(file, () => 1_000).forDevice("demo-mac", { [task.id]: task }), undefined);
  write(file, document());
  chmodSync(file, 0o622);
  assert.equal(new IPhoneMirroringEvidence(file, () => 1_000).forDevice("demo-mac", { [task.id]: task }), undefined);
  const target = join(file, "..", "target.json");
  write(target, document());
  rmSync(file, { force: true });
  symlinkSync(target, file);
  assert.equal(new IPhoneMirroringEvidence(file, () => 1_000).forDevice("demo-mac", { [task.id]: task }), undefined);
}));

test("fresh reads preserve recorded timestamps and never authorize another device", { skip: skipOnWindows }, () => withEvidence(file => {
  let now = 900;
  write(file, document());
  const evidence = new IPhoneMirroringEvidence(file, () => now);
  now = 1_000;
  assert.equal(evidence.forDevice("demo-mac", { [task.id]: task })?.observedAt, 990);
  now = 1_005;
  assert.equal(evidence.forDevice("demo-mac", { [task.id]: task })?.observedAt, 990);
  assert.equal(evidence.forDevice("other-mac", { [task.id]: task }), undefined);
}));

test("operator binding remains configured across startup and readiness revocation without claiming live proof", { skip: skipOnWindows }, () => withEvidence(file => {
  let now = 1_000;
  write(file, bindingDocument());
  const evidence = new IPhoneMirroringEvidence(file, () => now);
  const configured = evidence.bindingForDevice("demo-mac");
  assert.equal(configured?.status, "configured");
  assert.equal(configured?.requiresLivePreflight, true);
  assert.equal(configured?.grantsPermission, false);
  assert.equal(evidence.forDevice("demo-mac", { [task.id]: task }), undefined);
  evidence.revoke("demo-mac");
  now = 1_005;
  assert.equal(evidence.bindingForDevice("demo-mac")?.bindingEpoch, "epoch_1");
  assert.equal(evidence.forDevice("demo-mac", { [task.id]: task }), undefined);
}));

test("invalid or revoked v2 binding disables legacy readiness fallback", { skip: skipOnWindows }, () => withEvidence(file => {
  const legacyWithRevokedBinding = { ...document(), schemaVersion: 2, binding: binding({ enabled: false }) };
  write(file, legacyWithRevokedBinding);
  let now = 900;
  const evidence = new IPhoneMirroringEvidence(file, () => now);
  now = 1_000;
  assert.equal(evidence.bindingForDevice("demo-mac"), undefined);
  assert.equal(evidence.forDevice("demo-mac", { [task.id]: task }), undefined);
  write(file, bindingDocument({ binding: binding({ allowedActions: [] }) }));
  assert.equal(evidence.bindingForDevice("demo-mac"), undefined);
  assert.equal(evidence.bindingForDevice("other-mac"), undefined);
}));

test("only exact, current quiescence releases an uncertain mirror reservation", { skip: skipOnWindows }, () => withEvidence(file => {
  const uncertain: TaskLike = {
    ...task, id: "uncertain-task", status: "interrupted", updatedAt: "1970-01-01T00:16:30.000Z",
    executionTarget: { transport: "apple-iphone-mirroring", leaseId: "lease_1" },
  };
  const quiescence = { verification: "independently_verified", providerQuiescent: true, taskId: uncertain.id, leaseId: "lease_1", observedAt: 991 };
  write(file, document({ quiescence: [quiescence] }));
  const evidence = new IPhoneMirroringEvidence(file, () => 1_000);
  assert.deepEqual(evidence.quiescenceForTask(uncertain), {
    verification: "independently_verified", providerQuiescent: true, taskId: uncertain.id, leaseId: "lease_1",
  });
  for (const change of [
    { leaseId: "lease_2" }, { observedAt: 989 },
  ]) {
    write(file, document({ quiescence: [{ ...quiescence, ...change }] }));
    assert.equal(evidence.quiescenceForTask(uncertain), undefined);
  }
  write(file, document({ quiescence: [quiescence] }));
  assert.equal(evidence.quiescenceForTask({ ...uncertain, status: "running" }), undefined);
}));

test("v2 binding documents retain exact terminal quiescence without renewing routing", { skip: skipOnWindows }, () => withEvidence(file => {
  const uncertain: TaskLike = {
    ...task, id: "v2-uncertain", status: "failed", updatedAt: "1970-01-01T00:16:30.000Z",
    executionTarget: { transport: "apple-iphone-mirroring", leaseId: "lease_1" },
  };
  write(file, bindingDocument({ quiescence: [{
    verification: "independently_verified", providerQuiescent: true,
    taskId: uncertain.id, leaseId: "lease_1", observedAt: 991,
  }] }));
  const evidence = new IPhoneMirroringEvidence(file, () => 1_000);
  assert.equal(evidence.bindingForDevice("demo-mac")?.bindingEpoch, "epoch_1");
  assert.deepEqual(evidence.quiescenceForTask(uncertain), {
    verification: "independently_verified", providerQuiescent: true, taskId: uncertain.id, leaseId: "lease_1",
  });
}));
