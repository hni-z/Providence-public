import assert from "node:assert/strict";
import test from "node:test";
import { deriveMirroringCapability } from "./capability-publisher.mjs";

const now = 1_000;
const selection = { deviceId: "demo-mac", chatId: "chat_1", phoneId: "demo-phone", phoneName: "Demo iPhone" };
const observation = () => ({
  verification: "independently_verified", source: "normal_worker_native_cua", ...selection,
  sessionId: "lease_1", observedAt: 990, expiresAt: 1_010,
  appPresent: true, phoneReachable: true, authenticated: true, identityVerified: true,
  controllable: true, executable: true,
});
const record = (action = "messaging") => ({
  verification: "independently_verified", source: "normal_worker_native_cua", taskId: "task_1",
  deviceId: "demo-mac", chatId: "chat_1", phoneId: "demo-phone", action, scope: "Inspect authorized compose controls without sending.",
  observedAt: 985, preToolCallId: "pre_1", inputToolCallId: "input_1", postToolCallId: "post_1",
  phoneEffectObserved: true, ownerConfirmedPhone: true,
});
const tasks = () => ({ task_1: { id: "task_1", deviceId: "demo-mac", chatId: "chat_1", status: "completed", createdAt: "1970-01-01T00:16:00.000Z" } });
const derive = (overrides = {}) => deriveMirroringCapability({
  selection, acceptanceRecords: [record()], observation: observation(), tasks: tasks(), now, ...overrides,
});

test("derives only accepted action categories and preserves the trusted observation", () => {
  const email = record("email"); email.taskId = "task_2"; email.preToolCallId = "pre_2"; email.inputToolCallId = "input_2"; email.postToolCallId = "post_2";
  const manyTasks = tasks(); manyTasks.task_2 = { ...manyTasks.task_1, id: "task_2" };
  const result = derive({ acceptanceRecords: [record(), email, record()], tasks: manyTasks });
  assert.deepEqual(result.supportedActions, ["messaging", "email"]);
  assert.equal(result.sessionId, "lease_1");
  assert.equal(result.observedAt, 990);
  assert.equal(result.effectVerified, true);
});

test("a completed task alone never creates capability evidence", () => {
  assert.equal(derive({ acceptanceRecords: [] }), undefined);
  assert.equal(derive({ acceptanceRecords: [null, {}, false] }), undefined);
  assert.equal(derive({ acceptanceRecords: [record()], tasks: { task_1: { ...tasks().task_1, status: "running" } } }), undefined);
});

test("rejects records with wrong binding, task, source, future date, or missing independent proof", () => {
  for (const change of [
    (value) => { value.phoneId = "other-phone"; }, (value) => { value.chatId = "other-chat"; },
    (value) => { value.taskId = "other-task"; }, (value) => { value.source = "client"; },
    (value) => { value.observedAt = now + 1; }, (value) => { value.inputToolCallId = value.preToolCallId; },
    (value) => { value.phoneEffectObserved = false; }, (value) => { value.scope = "  "; },
    (value) => { value.observedAt = 991; },
  ]) {
    const value = record(); change(value);
    assert.equal(derive({ acceptanceRecords: [value] }), undefined);
  }
});

test("requires fresh, exact trusted observation but retains false diagnostic gates", () => {
  const stale = observation(); stale.expiresAt = now;
  assert.equal(derive({ observation: stale }), undefined);
  const wrongPhone = observation(); wrongPhone.phoneId = "other-phone";
  assert.equal(derive({ observation: wrongPhone }), undefined);
  const blocked = observation(); blocked.controllable = false;
  const result = derive({ observation: blocked });
  assert.equal(result.controllable, false);
  assert.equal(result.effectVerified, true);
});

test("does not mutate records, tasks, selection, or observation and performs no actions", () => {
  const records = [record()];
  const suppliedTasks = tasks();
  const suppliedObservation = observation();
  const before = structuredClone({ selection, records, suppliedTasks, suppliedObservation });
  const result = deriveMirroringCapability({ selection, acceptanceRecords: records, observation: suppliedObservation, tasks: suppliedTasks, now });
  assert.ok(result);
  assert.deepEqual({ selection, records, suppliedTasks, suppliedObservation }, before);
});

test("preserves real shared action/post call IDs only with inspected operation order", () => {
  const value = { ...record(), postToolCallId: "input_1", preOperationIndex: 0, inputOperationIndex: 0, postOperationIndex: 1 };
  assert.ok(derive({ acceptanceRecords: [value] }));
  for (const change of [{ postOperationIndex: 0 }, { postOperationIndex: -1 }, { inputOperationIndex: null },
    { postToolCallId: "pre_1" }, { phoneEffectObserved: false }]) {
    assert.equal(derive({ acceptanceRecords: [{ ...value, ...change }] }), undefined);
  }
  assert.ok(derive({ acceptanceRecords: [{ ...value, preToolCallId: "input_1", preOperationIndex: 0, inputOperationIndex: 1, postOperationIndex: 2 }] }));
});
