import test from "node:test";
import assert from "node:assert/strict";
import { VoiceJobLedger, parseVoiceQueueCapability } from "../web/src/live-voice-ledger.js";
import { VoiceSessionGuard } from "../web/src/browser-voice.js";
import { MessageNotSentError, findRequestDelivery, requestMatchesTask, submitToDestination } from "../web/src/message-delivery.js";
import type { Envelope, Task } from "../web/src/types.js";
const cap = { version: 1, supported: true, requestField: "queueIfBusy", maxQueuedPerChat: 8, restartBehavior: "interrupt_no_replay" };
const state = { connected: true, chats: [{ id: "chat", name: "Windows fixture", deviceId: "windows", threadId: "thread", online: true }],
  devices: [{ id: "windows", name: "Windows", online: true }], tasks: [] as Task[], approvals: [] };
function task(request: Envelope, index: number): Task {
  return { id: `task-${index}`, requestId: request.requestId, chatId: request.chatId, deviceId: "windows", prompt: request.text,
    text: "", status: index === 1 ? "running" : "queued", queueIfBusy: request.queueIfBusy,
    ...(index === 2 ? { admissionQueue: { reason: "chat_busy" as const, predecessorTaskId: "task-1" } } : {}),
    createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z" };
}
test("queue opt-in requires exact server capability and never infers support", () => {
  assert.deepEqual(parseVoiceQueueCapability(cap), cap);
  for (const value of [undefined, {}, { ...cap, supported: false }, { ...cap, requestField: "afterTaskId" }, { ...cap, maxQueuedPerChat: 999 }])
    assert.equal(parseVoiceQueueCapability(value), undefined);
});
test("two recordings create distinct acknowledged tasks; older replies survive the next capture", async t => {
  const guard = new VoiceSessionGuard(), ledger = new VoiceJobLedger(); const sent: unknown[] = [];
  const first: Envelope = { requestId: "11111111-1111-4111-8111-111111111111", chatId: "chat", expectedDeviceId: "windows", voice: true, text: "First request", sourceChatIds: [], queueIfBusy: true };
  const second: Envelope = { ...first, requestId: "22222222-2222-4222-8222-222222222222", text: "Second request" };
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body)); sent.push(body);
    return Response.json(task({ ...body, chatId: "chat" }, sent.length));
  });
  for (const [index, envelope] of [first, second].entries()) {
    const token = guard.begin("chat");
    assert.equal(guard.claimTranscript(token, "chat", envelope.text), envelope.text);
    assert.equal(guard.claimTranscript(token, "chat", envelope.text), undefined);
    const accepted = await submitToDestination("fixture", envelope, { ...state, queueSupported: true, tasks: index ? [task(first, 1)] : [] });
    assert.equal(guard.acceptTranscript(token, "chat", accepted), true);
    ledger.accept(accepted, envelope.text);
  }
  assert.equal(sent.length, 2); assert.deepEqual(ledger.list("chat").map(job => job.requestId), [first.requestId, second.requestId]);
  assert.ok(sent.every(body => (body as any).queueIfBusy === true && !Object.hasOwn(body as object, "afterTaskId") && !Object.hasOwn(body as object, "voice")));
  ledger.observe([{ id: "task-2", contextKey: "chat", status: "completed", text: "Second result", updatedAt: "2026-09-20T00:02:00Z" }]);
  guard.begin("chat"); // Third capture cannot erase either earlier accepted job.
  ledger.observe([{ id: "task-1", contextKey: "chat", status: "completed", text: "First result", updatedAt: "2026-09-20T00:03:00Z" }]);
  assert.equal(ledger.replies("task-1", "chat")[0].text, "First result"); assert.equal(ledger.replies("task-2", "chat")[0].text, "Second result");
  assert.equal(ledger.replies("task-1", "another-chat").length, 0);
});
test("legacy busy behavior remains and queue opt-in never bypasses unavailable destinations", async t => {
  let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not send"); });
  const request: Envelope = { requestId: "request", chatId: "chat", text: "Fixture", sourceChatIds: [] };
  await assert.rejects(submitToDestination("fixture", request, { ...state, tasks: [task(request, 1)] }), MessageNotSentError);
  await assert.rejects(submitToDestination("fixture", { ...request, queueIfBusy: true }, state), MessageNotSentError);
  await assert.rejects(submitToDestination("fixture", { ...request, queueIfBusy: true }, { ...state, queueSupported: true, connected: false }), MessageNotSentError);
  await assert.rejects(submitToDestination("fixture", { ...request, queueIfBusy: true, expectedDeviceId: "other" }, { ...state, queueSupported: true }), MessageNotSentError);
  assert.equal(calls, 0);
});
test("an unanswered worker request leaves an idle Superagent available for independent typed and voice messages", async t => {
  const childRequest: Envelope = { requestId: "child-request", chatId: "chat", text: "Child work", sourceChatIds: [] };
  const child = { ...task(childRequest, 1), status: "needs_input" };
  const approval = { id: "child-input", taskId: child.id, deviceId: "windows", method: "item/tool/requestUserInput", status: "pending", details: {} };
  const paths: string[] = [], bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (path: unknown, options: RequestInit) => {
    paths.push(String(path)); const body = JSON.parse(String(options.body)); bodies.push(body);
    return Response.json({ ...task({ ...body, chatId: "master" }, bodies.length), deviceId: "coordinator" });
  });
  for (const [voice, queue] of [[false, false], [true, false], [true, true]]) {
    const request: Envelope = { requestId: `independent-${voice}-${queue}`, chatId: "master", expectedDeviceId: "coordinator", text: "Independent fixture work", sourceChatIds: [],
      ...(voice ? { voice: true } : {}), ...(queue ? { queueIfBusy: true } : {}) };
    await submitToDestination("fixture", request, { ...state, queueSupported: queue, tasks: [child], approvals: [approval] });
    assert.equal(approval.status, "pending"); assert.equal(child.status, "needs_input");
  }
  assert.deepEqual(paths, ["/v1/messages", "/v1/messages", "/v1/messages"]);
  assert.ok(bodies.every(body => !Object.hasOwn(body, "answers") && !Object.hasOwn(body, "decision") && !Object.hasOwn(body, "afterTaskId")));
});
test("a conversation's own unresolved request still blocks immediate typed and voice messages", async t => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("an unresolved conversation must not receive a new immediate turn"));
  for (const chatId of ["master", "chat"]) for (const status of ["pending", "resolving"]) for (const voice of [false, true]) {
    const request: Envelope = { requestId: "new", chatId, text: "Not yet", sourceChatIds: [], ...(voice ? { voice: true } : {}) };
    const prior = { ...task({ ...request, requestId: "earlier" }, 1), deviceId: chatId === "master" ? "coordinator" : "windows", status: "needs_input" };
    const approval = { id: "own-input", taskId: prior.id, deviceId: prior.deviceId, method: "item/tool/requestUserInput", status, details: {} };
    await assert.rejects(submitToDestination("fixture", request, { ...state, tasks: [prior], approvals: [approval] }), /unresolved input or permission/);
    assert.equal(approval.status, status);
  }
});
test("queueing an independent request behind native input never resolves that input", async t => {
  const request: Envelope = { requestId: "independent", chatId: "chat", text: "Separate fixture task", sourceChatIds: [], queueIfBusy: true };
  const prior = { ...task({ ...request, requestId: "earlier" }, 1), status: "needs_input" };
  const pending = { id: "native-input", taskId: prior.id, deviceId: "windows", method: "item/tool/requestUserInput", status: "pending", details: {} };
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (path: unknown) => { paths.push(String(path)); return Response.json(task(request, 2)); });
  const accepted = await submitToDestination("fixture", request, { ...state, queueSupported: true, tasks: [prior], approvals: [pending] });
  assert.equal(accepted.status, "queued"); assert.equal(pending.status, "pending");
  assert.deepEqual(paths, ["/v1/chats/chat/messages"]);
});
test("unknown delivery never becomes accepted until exact read-only reconciliation; no duplicate POST", async t => {
  const ledger = new VoiceJobLedger();
  const request: Envelope = { requestId: "uncertain", chatId: "chat", expectedDeviceId: "windows", text: "Unknown outcome", sourceChatIds: [], queueIfBusy: true };
  const accepted = task(request, 2); let posts = 0, gets = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    if (options?.method === "POST") { posts++; throw new Error("Network outcome unknown"); }
    gets++; return Response.json({ tasks: [accepted] });
  });
  await assert.rejects(submitToDestination("fixture", request, { ...state, queueSupported: true }), /unknown/);
  assert.equal(ledger.list("chat").length, 0);
  assert.equal(requestMatchesTask(request, { ...accepted, queueIfBusy: false }), false);
  assert.equal(requestMatchesTask(request, { ...accepted, deviceId: "other" }), false);
  const found = await findRequestDelivery("fixture", request); assert.ok(found);
  ledger.accept(found, request.text); assert.equal(ledger.list("chat").length, 1);
  assert.equal(posts, 1); assert.equal(gets, 1);
});
test("ledger cannot change ACK identity or acquire unrelated replies, and stale snapshots cannot regress completion", () => {
  const ledger = new VoiceJobLedger(); ledger.accept({ id: "one", requestId: "request", chatId: "master" }, "Task");
  assert.throws(() => ledger.accept({ id: "changed", requestId: "request", chatId: "master" }, "Task"));
  ledger.observe([{ id: "child", parentTaskId: "one", contextKey: "master", status: "completed", text: "Actual child", updatedAt: "2026-09-20T00:02:00Z" },
    { id: "unrelated", contextKey: "master", status: "completed", text: "Wrong reply", updatedAt: "2026-09-20T00:03:00Z" }]);
  ledger.observe([{ id: "child", parentTaskId: "one", contextKey: "master", status: "running", text: "Stale", updatedAt: "2026-09-20T00:03:00Z" }]);
  assert.deepEqual(ledger.replies("one", "master").map(reply => reply.text), ["Actual child"]);
});
