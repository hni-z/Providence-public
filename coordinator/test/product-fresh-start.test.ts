import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { inspectProductFreshStart, materializeProductFreshStart, type ProductFreshStartInput } from "../src/product-fresh-start.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const retained = [
  { chatId: "chat-a", deviceId: "mac-a", name: "Mac A", workspace: "a" }, { chatId: "chat-b", deviceId: "mac-b", name: "Mac B", workspace: "b" }, { chatId: "chat-c", deviceId: "win-c", name: "Windows", workspace: "c" },
];
function state(extra: Record<string, unknown> = {}) { return JSON.stringify({ chats: Object.fromEntries(retained.map(chat => [chat.chatId, { ...chat, id: chat.chatId, threadId: `old-${chat.chatId}`, history: [{ role: "user", text: "old", taskId: "task-old" }] }])), tasks: { "task-old": { id: "task-old", requestId: "request-old", status: "completed" } }, approvals: {}, events: [{ sequence: 7, at: "2026-09-20T11:59:00Z", type: "old" }], sequence: 7, masterThreadId: "old-master", masterToolVersion: "old-tools", artifacts: { art: { id: "art", path: "saved", size: 1 } }, ...extra }); }
function input(bytes = state()): ProductFreshStartInput { const rules = "Current rules only"; return { stateBytes: bytes, resetId: "reset-1", generationId: "generation-1", retainedChats: retained, bindings: { watch: [{ chatId: "chat-a", deviceId: "mac-a" }], phone: { chatId: "chat-b", deviceId: "mac-b" }, workflow: retained.map(({ chatId, deviceId }) => ({ chatId, deviceId })) }, rules: { version: "rules-1", text: rules, sha256: hash(rules) }, masterToolVersion: "tools-1", quiescence: { nativeOperations: 0, providerOperations: 0, sttOperations: 0, phoneOperations: 0, hostBridgeOperations: 0, unresolvedOutcomes: 0, observedAt: "2026-09-20T12:00:00Z", operator: "operator-1" } }; }
const replacements = { masterThreadId: "new-master", chatReceipts: retained.map((chat, index) => ({ chatId: chat.chatId, deviceId: chat.deviceId, workspace: chat.workspace, threadId: `new-${String.fromCharCode(97 + index)}` })) };

test("previews and materializes three new provider threads with preserved bindings and no history", () => {
  const source = state(), preview = inspectProductFreshStart(input(source));
  assert.equal(preview.status, "ready"); assert.equal(preview.stagedChats.length, 3); assert.equal(preview.stagedChats[0].instructions, "Current rules only");
  const result = materializeProductFreshStart(preview, replacements, source); assert.equal(result.status, "materialized"); if (result.status !== "materialized") return;
  const next = result.nextState as any;
  assert.equal(next.sequence, 8); assert.equal(next.events[0].sequence, 8); assert.equal(next.masterThreadId, "new-master"); assert.equal(next.masterToolVersion, "tools-1");
  assert.deepEqual(next.chats["chat-a"].history, []); assert.deepEqual(next.chats["chat-a"].previousThreadIds, []); assert.equal(next.chats["chat-a"].instructions, "Current rules only"); assert.equal(next.chats["chat-a"].threadId, "new-a"); assert.equal(next.chats["chat-a"].providerState, "unstarted"); assert.deepEqual(next.tasks, {}); assert.deepEqual(next.approvals, {}); assert.equal(next.artifacts.art.path, "saved"); assert.ok(result.requestTombstones.includes("request-old")); assert.equal(next.productFreshStart.sealed, true); assert.match(result.rollbackCondition, /forbidden/);
});

test("blocks active work, approvals, non-quiescence, mapping drift, and sensitive state without leaking values", () => {
  for (const changed of [state({ tasks: { t: { requestId: "r", status: "running" } } }), state({ approvals: { a: { status: "pending" } } }), state({ credentials: "do-not-leak" })]) {
    const preview = inspectProductFreshStart(input(changed)); assert.equal(preview.status, "blocked"); assert.ok(!preview.blockers.join(" ").includes("do-not-leak"));
  }
  const value = input(); value.quiescence = { ...value.quiescence, sttOperations: 1 }; assert.equal(inspectProductFreshStart(value).status, "blocked");
  value.bindings = { ...value.bindings, phone: { chatId: "chat-a", deviceId: "mac-b" } }; assert.equal(inspectProductFreshStart(value).status, "blocked");
});

test("requires CAS basis and new exact replacement IDs", () => {
  const source = state(), preview = inspectProductFreshStart(input(source));
  assert.throws(() => materializeProductFreshStart(preview, replacements, state({ sequence: 8 })), /compare-and-swap/);
  assert.throws(() => materializeProductFreshStart(preview, { ...replacements, masterThreadId: "old-master" }, source), /Replacement/);
  assert.throws(() => materializeProductFreshStart(preview, { ...replacements, chatReceipts: [{ ...replacements.chatReceipts[0], workspace: "wrong" }, ...replacements.chatReceipts.slice(1)] }, source), /Replacement/);
});

test("same sealed reset is already applied and changed input conflicts", () => {
  const source = state(), preview = inspectProductFreshStart(input(source)), made = materializeProductFreshStart(preview, replacements, source); if (made.status !== "materialized") return;
  const sealed = new TextDecoder().decode(made.nextStateBytes), again = inspectProductFreshStart(input(sealed));
  assert.equal(again.status, "already_applied", again.blockers.join("; ")); const applied = materializeProductFreshStart(again, replacements, sealed); assert.equal(applied.status, "already_applied"); if (applied.status === "already_applied") assert.equal(applied.phase, "sealed");
  const changed = input(sealed); changed.rules = { ...changed.rules, version: "rules-2" }; assert.equal(inspectProductFreshStart(changed).status, "blocked");
});

test("archives exact input bytes, accepts refreshed quiescence, and rejects a mutated preview", () => {
  const source = '{\n  "chats": {"chat-a":{"id":"chat-a","name":"Mac A","deviceId":"mac-a","workspace":"a","threadId":"old-a","history":[]},"chat-b":{"id":"chat-b","name":"Mac B","deviceId":"mac-b","workspace":"b","threadId":"old-b","history":[]},"chat-c":{"id":"chat-c","name":"Windows","deviceId":"win-c","workspace":"c","threadId":"old-c","history":[]}}, "tasks": {}, "approvals": {}, "events": [], "sequence": 0\n}';
  const first = inspectProductFreshStart(input(source)), made = materializeProductFreshStart(first, replacements, source); if (made.status !== "materialized") return;
  assert.equal(new TextDecoder().decode(made.archiveBytes), source); assert.equal(made.archiveSha256, first.basisSha256);
  const refreshed = input(new TextDecoder().decode(made.nextStateBytes)); refreshed.quiescence = { ...refreshed.quiescence, observedAt: "2026-09-20T12:01:00Z", operator: "operator-2" }; assert.equal(inspectProductFreshStart(refreshed).status, "already_applied");
  const mutable = inspectProductFreshStart(input(state())); (mutable.stagedChats as any)[0].instructions = "old instructions"; assert.throws(() => materializeProductFreshStart(mutable, replacements, state()), /modified/);
});

test("fails closed for unknown roots, malformed identities, incomplete bindings, and retired threads", () => {
  for (const source of [state({ unknownContext: {} }), state({ tasks: { t: "not-object" } }), state({ tasks: { a: { requestId: "same", status: "completed" }, b: { requestId: "same", status: "completed" } } }), state({ approvals: { a: { status: "surprise" } } }), state({ productFreshStart: { requestTombstones: "wrong" } }), state({ sequence: Number.MAX_SAFE_INTEGER })]) assert.equal(inspectProductFreshStart(input(source)).status, "blocked");
  const badBindings = input(); badBindings.bindings = { ...badBindings.bindings, workflow: badBindings.bindings.workflow.slice(0, 2) }; assert.equal(inspectProductFreshStart(badBindings).status, "blocked");
  const source = state({ masterRuntimeHistory: [{ threadId: "retired-thread" }] });
  const preview = inspectProductFreshStart(input(source)); assert.throws(() => materializeProductFreshStart(preview, { ...replacements, masterThreadId: "retired-thread" }, source), /Replacement/);
});

test("does not plan over a different sealed generation and rechecks applied markers", () => {
  const sealed = state({ productFreshStart: { phase: "sealed", resetId: "other-reset", generationId: "other-generation", inputDigest: hash("other"), requestTombstones: [], retiredProviderThreadIds: [] } });
  assert.equal(inspectProductFreshStart(input(sealed)).status, "blocked");
  const source = state(), preview = inspectProductFreshStart(input(source)), made = materializeProductFreshStart(preview, replacements, source); if (made.status !== "materialized") return;
  const later = JSON.parse(new TextDecoder().decode(made.nextStateBytes)); later.productFreshStart = { ...later.productFreshStart, phase: "active", generationId: "other-generation" };
  assert.throws(() => materializeProductFreshStart(inspectProductFreshStart(input(new TextDecoder().decode(made.nextStateBytes))), replacements, JSON.stringify(later)), /no longer matches/);
});

test("cannot hide corrupt applied markers or promote a blocked preview by editing its status", () => {
  const source = state(), preview = inspectProductFreshStart(input(source));
  const made = materializeProductFreshStart(preview, replacements, source);
  if (made.status !== "materialized") return;
  const validBytes = new TextDecoder().decode(made.nextStateBytes);
  const applied = inspectProductFreshStart(input(validBytes));
  const corrupt = JSON.parse(validBytes);
  corrupt.productFreshStart.requestTombstones = "lost-ledger";
  const corruptBytes = JSON.stringify(corrupt);
  assert.equal(inspectProductFreshStart(input(corruptBytes)).status, "blocked");
  assert.throws(() => materializeProductFreshStart(applied, replacements, corruptBytes), /no longer matches/);

  const busyState = state({ tasks: { task: { requestId: "busy-request", status: "running" } } });
  const blocked = inspectProductFreshStart(input(busyState));
  assert.equal(blocked.status, "blocked");
  blocked.status = "ready";
  blocked.blockers = [];
  assert.throws(() => materializeProductFreshStart(blocked, replacements, busyState), /modified/);
});

test("retains workflow request aliases, binds master ID in the manifest, and rejects inconsistent events", () => {
  const source = state({ tasks: { workflow: { requestId: "root-request", workflowRole: "research", workflowRequestAliases: ["alias-one", "alias-two"], status: "completed" } } });
  const preview = inspectProductFreshStart(input(source)), first = materializeProductFreshStart(preview, replacements, source);
  assert.equal(first.status, "materialized"); if (first.status !== "materialized") return;
  assert.deepEqual(first.requestTombstones.slice().sort(), ["alias-one", "alias-two", "root-request"]);
  const alternate = materializeProductFreshStart(preview, { ...replacements, masterThreadId: "new-master-two" }, source);
  assert.equal(alternate.status, "materialized"); if (alternate.status === "materialized") assert.notEqual(first.manifestDigest, alternate.manifestDigest);
  const next = first.nextState as any; assert.equal(next.events[0].at, "2026-09-20T12:00:00Z");
  assert.equal(inspectProductFreshStart(input(state({ events: [{ sequence: 99, at: "2026-09-20T12:00:00Z", type: "bad" }], sequence: 7 }))).status, "blocked");
});
