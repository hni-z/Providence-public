import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listNativeSessions, readNativeSession, NativeSessionError, NATIVE_SOURCE_KINDS, MAX_NATIVE_READ_BYTES, MAX_NATIVE_MESSAGE_BYTES, type NativeSessionRpc, type NativeSessionReadResult } from "../src/native-sessions.js";
import { Runtime } from "../src/runtime.js";
import { runtimeRequest } from "../src/devices.js";

const thread = (overrides: Record<string, unknown> = {}) => ({
  id: "native-thread", name: "Exact title | unchanged", preview: "First user request", cwd: "/another/existing/project",
  createdAt: 1_789_794_362, updatedAt: 1_789_798_699, status: { type: "idle" }, source: "appServer",
  canAcceptDirectInput: true, sessionId: "hidden-session-id", path: "/private/rollout.jsonl",
  extra: { privateToken: "hidden-credential" }, environments: [{ secret: "hidden-environment" }],
  turns: [{ items: [{ type: "reasoning", text: "hidden-reasoning" }] }], ...overrides,
});
function rpcFixture(results: Record<string, unknown>) {
  const calls: { method: string; params: any }[] = [];
  const rpc: NativeSessionRpc = { async call(method, params) { calls.push({ method, params }); return results[method]; } };
  return { rpc, calls };
}
const user = (id: string, text: string) => ({ id, type: "userMessage", content: [{ type: "text", text }] });
const assistant = (id: string, text: string) => ({ id, type: "agentMessage", phase: "final_answer", text });

test("listing uses only the state index with explicit source/archive/title filters and opaque pagination", async () => {
  const f = rpcFixture({ "thread/list": { data: [thread()], nextCursor: "opaque-next" } });
  const result = await listNativeSessions(f.rpc, { query: "MiXeD title", cursor: "opaque-before", limit: 7, archived: true });
  assert.deepEqual(f.calls, [{ method: "thread/list", params: { cursor: "opaque-before", limit: 7, archived: true, sourceKinds: [...NATIVE_SOURCE_KINDS], useStateDbOnly: true, sortKey: "updated_at", sortDirection: "desc", searchTerm: "MiXeD title" } }]);
  assert.equal(result.nextCursor, "opaque-next");
  assert.equal(result.coverage.queryCaseSensitivity, "provider-defined");
  assert.equal(result.coverage.index, "state-db-only");
  assert.equal(result.sessions[0].title, "Exact title | unchanged");
  assert.equal(result.sessions[0].threadId, "native-thread");
  assert.equal(result.sessions[0].createdAt, new Date(1_789_794_362_000).toISOString());
  for (const value of ["hidden-session-id", "hidden-credential", "hidden-environment", "rollout.jsonl", "hidden-reasoning", "canAcceptDirectInput"]) assert.equal(JSON.stringify(result).includes(value), false);
});

test("native active, idle and unknown ownership never become executable; title fallback is separate", async () => {
  const f = rpcFixture({ "thread/list": { data: [thread({ id: "active", name: null, status: { type: "active", activeFlags: ["waitingOnApproval", "private-extra-flag"] } }), thread({ id: "unknown", name: "  User spacing  ", status: { type: "futureStatus" }, source: { subAgent: { thread_spawn: { parent_thread_id: "hidden-parent", depth: 2 } } } })] } });
  const result = await listNativeSessions(f.rpc);
  assert.equal(result.sessions[0].title, null);
  assert.equal(result.sessions[0].titleFallback, "First user request");
  assert.deepEqual(result.sessions[0].status, { type: "active", activeFlags: ["waitingOnApproval"] });
  assert.equal(result.sessions[1].title, "  User spacing  ");
  assert.equal(result.sessions[1].status.type, "unknown");
  assert.equal(result.sessions[1].source, "subAgentThreadSpawn");
  assert.equal(result.sessions.every(value => value.readOnly && value.ownership === "unknown"), true);
  assert.equal(result.coverage.executionOwnershipTransferred, false);
  assert.match(result.coverage.statusScope, /not global/);
});

test("read obtains metadata then one full turns page without resuming, importing, or executing", async () => {
  const f = rpcFixture({
    "thread/read": { thread: thread({ status: { type: "active", activeFlags: ["waitingOnUserInput"] } }) },
    "thread/turns/list": { data: [
      { id: "turn-new", status: "inProgress", itemsView: "full", items: [user("user-new", "Latest question"), { id: "thought", type: "reasoning", text: "hidden-reasoning" }, { id: "tool", type: "mcpToolCall", arguments: { apiKey: "hidden-secret" }, result: { content: [{ type: "text", text: "raw-tool-secret" }] } }, { id: "progress", type: "agentMessage", phase: "commentary", text: "interim-progress" }, assistant("answer-new", "Latest answer")] },
      { id: "turn-old", status: "completed", itemsView: "full", items: [user("user-old", "Earlier question"), { id: "image-user", type: "userMessage", content: [{ type: "image", url: "data:image/png;base64,hidden-image" }] }, assistant("answer-old", "Earlier answer")] },
    ], nextCursor: "older-turns" },
  });
  const result = await readNativeSession(f.rpc, { threadId: "native-thread", cursor: "turn-cursor", limit: 2 });
  assert.deepEqual(f.calls, [{ method: "thread/read", params: { threadId: "native-thread", includeTurns: false } }, { method: "thread/turns/list", params: { threadId: "native-thread", cursor: "turn-cursor", limit: 2, sortDirection: "desc", itemsView: "full" } }]);
  assert.deepEqual(result.messages.map(message => [message.turnId, message.id, message.role, message.text]), [["turn-old", "user-old", "user", "Earlier question"], ["turn-old", "answer-old", "assistant", "Earlier answer"], ["turn-new", "user-new", "user", "Latest question"], ["turn-new", "answer-new", "assistant", "Latest answer"]]);
  assert.equal(result.nextCursor, "older-turns");
  assert.equal(result.thread.readOnly, true);
  assert.equal(result.truncated, false);
  for (const hidden of ["hidden-", "raw-tool-secret", "interim-progress"]) assert.equal(JSON.stringify(result).includes(hidden), false);
});

test("read clips user and assistant UTF-8 text honestly while retaining newest messages", async () => {
  const huge = "🧪 bounded text ".repeat(4000);
  const f = rpcFixture({ "thread/read": { thread: thread() }, "thread/turns/list": { data: [{ id: "turn", status: "completed", itemsView: "full", items: [user("huge-user", huge), ...Array.from({ length: 7 }, (_, n) => assistant(`answer-${n}`, huge))] }], nextCursor: null } });
  const result = await readNativeSession(f.rpc, { threadId: "native-thread" });
  assert.equal(result.truncated, true);
  assert.ok(result.messages.reduce((sum, message) => sum + Buffer.byteLength(message.text), 0) <= MAX_NATIVE_READ_BYTES);
  assert.ok(result.messages.every(message => Buffer.byteLength(message.text) <= MAX_NATIVE_MESSAGE_BYTES && !message.text.includes("\ufffd")));
  assert.equal(result.messages.at(-1)?.id, "answer-6");
  const justUser = rpcFixture({ "thread/read": { thread: thread() }, "thread/turns/list": { data: [{ id: "turn", status: "completed", items: [user("huge-user", huge)] }] } });
  assert.equal((await readNativeSession(justUser.rpc, { threadId: "native-thread" })).truncated, true);
});

test("metadata identity mismatches and malformed pages fail without raw payload exposure", async () => {
  const f = rpcFixture({ "thread/read": { thread: thread({ id: "other-thread", privateToken: "never-print" }) } });
  await assert.rejects(readNativeSession(f.rpc, { threadId: "native-thread" }), error => error instanceof NativeSessionError && error.code === "invalid_response" && !error.message.includes("never-print"));
  assert.equal(f.calls.length, 1);
  const broken = rpcFixture({ "thread/list": { data: "raw-credential-body" } });
  await assert.rejects(listNativeSessions(broken.rpc), error => error instanceof NativeSessionError && error.code === "invalid_response" && !error.message.includes("raw-credential"));
});

test("input bounds are enforced before RPC and unsupported/unavailable failures are sanitized", async () => {
  const f = rpcFixture({});
  for (const input of [{ limit: 31 }, { limit: 0 }, { query: "a".repeat(201) }, { cursor: "a".repeat(4097) }, { sourceKinds: [] }]) await assert.rejects(listNativeSessions(f.rpc, input), NativeSessionError);
  for (const input of [{ threadId: "t", limit: 21 }, { threadId: "" }, { threadId: "t", resume: true }]) await assert.rejects(readNativeSession(f.rpc, input), NativeSessionError);
  assert.equal(f.calls.length, 0);
  await assert.rejects(listNativeSessions({ async call() { throw Object.assign(new Error("Method not found; secret-token"), { code: -32601 }); } }), error => error instanceof NativeSessionError && error.code === "unsupported_method" && !error.message.includes("secret-token"));
  await assert.rejects(listNativeSessions({ async call() { throw new Error("auth failure private-token"); } }), error => error instanceof NativeSessionError && error.code === "unavailable" && !error.message.includes("private-token"));
});

test("native device RPC routes use read adapters even for sessions outside the execution root", async () => {
  const root = mkdtempSync(join(tmpdir(), "providence-native-"));
  try {
    const runtime = new Runtime({ root });
    const calls: string[] = [];
    runtime.rpc.call = async (method) => { calls.push(method); return method === "thread/list" ? { data: [thread()] } : method === "thread/read" ? { thread: thread() } : { data: [] }; };
    runtime.importThread = async () => { throw new Error("must not import"); };
    await runtimeRequest(runtime, "session.list", {});
    const result = await runtimeRequest(runtime, "session.read", { threadId: "native-thread" }) as NativeSessionReadResult;
    assert.equal(result.thread.cwd, "/another/existing/project");
    assert.equal(result.thread.readOnly, true);
    assert.deepEqual(calls, ["thread/list", "thread/read", "thread/turns/list"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
