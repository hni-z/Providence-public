import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityEvidence, deriveCapabilityEvidence, type CapabilityEvidenceRecord, type CapabilityEvidenceTask } from "../src/capability-evidence.js";
import { Devices } from "../src/devices.js";
import { Runtime } from "../src/runtime.js";
import { runtimeMetadata } from "../src/device-config.js";

const now = Date.parse("2026-09-19T12:00:00Z");
const task: CapabilityEvidenceTask = { id: "verified-task", deviceId: "mac", status: "completed", createdAt: "2026-09-19T10:00:00Z" };
const record: CapabilityEvidenceRecord = {
  deviceId: "mac", taskId: task.id, capability: "desktop", observedAt: "2026-09-19T10:05:00Z",
  scope: "Observed a permitted operation in one native app; other apps and current grants are not established.",
  requiresApproval: true, verification: "independently_verified",
};
const document = (records: unknown[]) => ({ schemaVersion: 1, records });

test("completed tasks and declared capabilities alone never establish verified access", () => {
  const tasks = { [task.id]: { ...task, text: "I completed it", capabilities: { desktop: true, browser: true } } };
  const evidence = deriveCapabilityEvidence(document([]), tasks, "mac", now);
  assert.equal(evidence.desktop.status, "not_verified");
  assert.equal(evidence.browser.status, "not_verified");
  assert.equal(evidence.desktop.requiresApproval, true);
  assert.equal(evidence.desktop.grantsPermission, false);
});

test("only an explicit matching completed-task record exposes its observed scope", () => {
  const evidence = deriveCapabilityEvidence(document([record]), { [task.id]: task }, "mac", now);
  assert.deepEqual(evidence.desktop, { status: "verified_scoped", taskId: task.id, observedAt: record.observedAt, scope: record.scope, requiresApproval: true, grantsPermission: false });
  assert.equal(evidence.browser.status, "not_verified");
  assert.equal("online" in evidence, false, "historical verification must not change connection state");
  assert.equal("phoneMirroring" in evidence, false);
});

test("device/task mismatches and incomplete or missing tasks cannot upgrade capability", () => {
  for (const tasks of [
    {}, { [task.id]: { ...task, status: "running" } }, { [task.id]: { ...task, status: "failed" } },
    { [task.id]: { ...task, deviceId: "demoPC" } }, { [task.id]: { ...task, id: "other-task" } },
  ]) assert.equal(deriveCapabilityEvidence(document([record]), tasks, "mac", now).desktop.status, "not_verified");
  assert.equal(deriveCapabilityEvidence(document([record]), { [task.id]: task }, "demoPC", now).desktop.status, "not_verified");
});

test("invalid evidence, universal-grant claims and phone records fail closed", () => {
  for (const entry of [
    { ...record, requiresApproval: false }, { ...record, verification: "model_reported" },
    { ...record, capability: "phoneMirroring" }, { ...record, scope: "" },
    { ...record, scope: "x".repeat(601) }, { ...record, grantAllApps: true },
  ]) assert.equal(deriveCapabilityEvidence(document([entry]), { [task.id]: task }, "mac", now).desktop.status, "not_verified");
  assert.equal(deriveCapabilityEvidence({ schemaVersion: 2, records: [record] }, { [task.id]: task }, "mac", now).desktop.status, "not_verified");
});

test("observation must follow task creation and must not be dated in the future", () => {
  for (const observedAt of ["2026-09-19T09:59:59Z", "2026-09-19T12:00:01Z", "not-a-date"])
    assert.equal(deriveCapabilityEvidence(document([{ ...record, observedAt }]), { [task.id]: task }, "mac", now).desktop.status, "not_verified");
  assert.equal(deriveCapabilityEvidence(document([record]), { [task.id]: { ...task, createdAt: "invalid" } }, "mac", now).desktop.status, "not_verified");
});

test("latest valid observation is selected independently for each capability", () => {
  const entries = [record, { ...record, observedAt: "2026-09-19T10:10:00Z", scope: "More recent scoped observation." }, { ...record, capability: "browser", scope: "Observed a sign-in page only." }];
  const evidence = deriveCapabilityEvidence(document(entries), { [task.id]: task }, "mac", now);
  assert.equal(evidence.desktop.observedAt, "2026-09-19T10:10:00Z");
  assert.equal(evidence.browser.status, "verified_scoped");
  assert.equal(evidence.browser.scope, "Observed a sign-in page only.");
  evidence.desktop.scope = "Caller changed its response object";
  assert.equal(deriveCapabilityEvidence(document(entries), { [task.id]: task }, "mac", now).desktop.scope, "More recent scoped observation.");
});

test("file reader is cached and invalid files never take the service offline", () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-capability-"));
  const file = join(directory, "capability-evidence.json");
  try {
    const missing = new CapabilityEvidence(file);
    assert.equal(missing.sourceStatus, "missing");
    assert.equal(missing.forDevice("mac", { [task.id]: task }, now).desktop.status, "not_verified");
    writeFileSync(file, JSON.stringify(document([record])), { mode: 0o600 });
    const loaded = new CapabilityEvidence(file);
    assert.equal(loaded.sourceStatus, "loaded");
    assert.equal(loaded.forDevice("mac", { [task.id]: task }, now).desktop.status, "verified_scoped");
    writeFileSync(file, "{ broken secret input");
    assert.equal(loaded.forDevice("mac", { [task.id]: task }, now).desktop.status, "verified_scoped", "reader reload requires an explicit deployment");
    const invalid = new CapabilityEvidence(file);
    assert.equal(invalid.sourceStatus, "invalid");
    assert.equal(invalid.forDevice("mac", { [task.id]: task }, now).desktop.status, "not_verified");
    writeFileSync(file, "x".repeat(128 * 1024 + 1));
    assert.equal(new CapabilityEvidence(file).sourceStatus, "invalid");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("device reporting upgrades only proven scopes while leaving connection and phone state unchanged", () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-capability-device-"));
  try {
    const devices = new Devices("mac", "MacBook", new Runtime({ root: directory }), [{ id: "demoPC", name: "DemoPC" }], deviceId =>
      deriveCapabilityEvidence(document([record]), { [task.id]: task }, deviceId, now));
    const declared = runtimeMetadata(directory);
    declared.capabilities.browser = true;
    declared.capabilities.desktop = true;
    (devices as any).metadata.set("demoPC", declared);
    const [mac, windows] = devices.list();
    assert.equal(mac.online, false);
    assert.equal(mac.capabilities.desktop, true);
    assert.equal(mac.capabilities.browser, false);
    assert.equal(mac.capabilities.phoneMirroring, false);
    assert.equal("capabilityEvidence" in mac && mac.capabilityEvidence?.desktop.requiresApproval, true);
    assert.equal("capabilityEvidence" in mac && mac.capabilityEvidence?.desktop.grantsPermission, false);
    assert.equal(windows.online, false);
    assert.equal(windows.capabilities.desktop, false);
    assert.equal(windows.capabilities.browser, false);
    assert.equal("declaredCapabilities" in windows && windows.declaredCapabilities?.desktop, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
