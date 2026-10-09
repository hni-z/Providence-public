import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime, USER_INPUT_WAIT_MS, type Event } from "../src/runtime.js";
import { setImmediate } from "node:timers/promises";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "providence-input-wait-"));
  const runtime = new Runtime({ root, workerAccess: "full-access", reconnect: { attempts: 0 } });
  const calls: { method: string; params: any }[] = [], events: Event[] = [];
  let threads = 0, turns = 0;
  runtime.rpc.call = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: `thread-${++threads}`, cwd: root },
      model: runtime.profile.model, reasoningEffort: runtime.profile.reasoningEffort, serviceTier: runtime.profile.serviceTier,
      approvalPolicy: "never", sandbox: { type: "dangerFullAccess" } };
    return { turn: { id: `turn-${++turns}` } };
  };
  runtime.on("event", event => events.push(event));
  const { threadId } = await runtime.create();
  await runtime.execute(threadId, "task-a", "Complete the authorized fixture work");
  const question = (extra: any = {}, id: string | number = "question-a") => runtime.rpc.onRequest!("item/tool/requestUserInput", {
    threadId, turnId: "turn-1", questions: [{ id: "choice", question: "Which exact fixture recipient?",
      options: [{ label: "Alex work", description: "Work contact" }, { label: "Alex personal", description: "Personal contact" }] }], ...extra,
  }, id);
  const complete = (turnId = "turn-1") => runtime.rpc.emit("notification", "turn/completed", {
    threadId, turn: { id: turnId, status: "completed" },
  });
  return { runtime, threadId, calls, events, question, complete,
    cleanup: () => { runtime.stop(); runtime.rpc.emit("disconnected", "Fixture shutdown"); rmSync(root, { recursive: true, force: true }); } };
}

test("an unanswered nonblocking question closes at 20 seconds with no answer or grant, and the turn continues", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = await fixture();
  try {
    let settled = false;
    const pending = f.question().then(value => { settled = true; return value; });
    const requested = f.events.find(event => event.type === "approval.requested")!;
    assert.equal(requested.details.replyDeadlineAt, new Date(USER_INPUT_WAIT_MS).toISOString());
    t.mock.timers.tick(USER_INPUT_WAIT_MS - 1); await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    assert.deepEqual(await pending, { answers: {} });
    const expired = f.events.filter(event => event.type === "approval.expired");
    assert.equal(expired.length, 1); assert.equal(expired[0].reason, "unanswered_input");
    assert.equal(expired[0].providerRequestId, "question-a");
    assert.equal(f.events.some(event => event.type === "approval.resolved"), false);
    assert.equal(f.calls.some(call => call.method === "turn/interrupt"), false);
    assert.throws(() => f.runtime.resolveApproval(requested.approvalId, undefined,
      { choice: { answers: ["Alex work"] } }), /no longer pending/);
    await assert.rejects(f.runtime.execute(f.threadId, "replacement", "Do not duplicate work"), /active task/);
    assert.deepEqual(await f.question({}, "repeat-question"), { answers: {} });
    assert.equal(f.events.filter(event => event.type === "approval.requested").length, 1, "an unanswered question is not asked repeatedly");
    f.runtime.rpc.emit("notification", "item/completed", { threadId: f.threadId, turnId: "turn-1",
      item: { id: "result", type: "agentMessage", text: "Independent work finished. Exact recipient remains unresolved." } });
    f.complete();
    assert.match(f.events.find(event => event.type === "task.completed")!.text, /remains unresolved/);
    const timing = f.events.find(event => event.type === "runtime.timing")!.timing;
    assert.equal(timing.approvalsExpired, 1); assert.equal(timing.approvalsResolved, 0);
  } finally { f.cleanup(); }
});

test("blocking connector input and actual permission requests do not auto-resolve", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = await fixture();
  try {
    let settled = 0;
    const blocking = f.question({ isBlocking: true, autoResolutionMs: 1 }).then(value => { settled++; return value; });
    const command = f.runtime.rpc.onRequest!("item/commandExecution/requestApproval", {
      threadId: f.threadId, turnId: "turn-1", itemId: "command", command: "fixture", availableDecisions: ["decline", "cancel"],
    }, "command").then(value => { settled++; return value; });
    t.mock.timers.tick(2 * USER_INPUT_WAIT_MS); await Promise.resolve();
    assert.equal(settled, 0);
    const prompts = f.events.filter(event => event.type === "approval.requested");
    assert.ok(prompts.every(event => event.details.replyDeadlineAt === undefined));
    assert.equal(f.events.some(event => event.type === "approval.expired"), false);
    f.runtime.resolveApproval(prompts[0].approvalId, undefined, { choice: { answers: ["Alex work"] } });
    f.runtime.resolveApproval(prompts[1].approvalId, "decline");
    assert.deepEqual(await blocking, { answers: { choice: { answers: ["Alex work"] } } });
    assert.deepEqual(await command, { decision: "decline" });
  } finally { f.cleanup(); }
});

test("invalid submissions retain the deadline and late submissions cannot beat a delayed timer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = await fixture();
  try {
    const pending = f.question();
    const id = f.events.find(event => event.type === "approval.requested")!.approvalId;
    assert.throws(() => f.runtime.resolveApproval(id, "accept"), /requires answers/);
    t.mock.timers.tick(USER_INPUT_WAIT_MS - 1);
    t.mock.method(Date, "now", () => USER_INPUT_WAIT_MS);
    assert.throws(() => f.runtime.resolveApproval(id, undefined, { choice: { answers: ["Alex work"] } }), /expired without an answer/);
    assert.deepEqual(await pending, { answers: {} });
    t.mock.timers.tick(1);
    assert.equal(f.events.filter(event => event.type === "approval.expired").length, 1);
    assert.equal(f.events.some(event => event.type === "approval.resolved"), false);
  } finally { f.cleanup(); }
});

test("answered input clears its timer and cannot expire a later task in the same chat", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = await fixture();
  try {
    const first = f.question();
    const id = f.events.find(event => event.type === "approval.requested")!.approvalId;
    t.mock.timers.tick(10_000);
    f.runtime.resolveApproval(id, undefined, { choice: { answers: ["Alex work"] } });
    await first; f.complete();
    await f.runtime.execute(f.threadId, "task-b", "New explicit user request");
    let settled = false;
    const second = f.question({ turnId: "turn-2" }, "question-b").then(value => { settled = true; return value; });
    t.mock.timers.tick(10_000); await Promise.resolve(); assert.equal(settled, false);
    t.mock.timers.tick(10_000); assert.deepEqual(await second, { answers: {} });
    assert.deepEqual(f.events.filter(event => event.type === "approval.expired").map(event => event.taskId), ["task-b"]);
  } finally { f.cleanup(); }
});

test("shorter provider deadlines are respected and malformed auto-resolution fields are rejected", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = await fixture();
  try {
    for (const values of [{ isBlocking: "false" }, { autoResolutionMs: -1 }, { autoResolutionMs: 1.5 }])
      await assert.rejects(f.question(values), /supported approval contract/);
    const pending = f.question({ autoResolutionMs: 500 });
    t.mock.timers.tick(499);
    assert.equal(f.events.some(event => event.type === "approval.expired"), false);
    t.mock.timers.tick(1); assert.deepEqual(await pending, { answers: {} });
  } finally { f.cleanup(); }
});

test("provider clear, turn end, disconnect and stop prevent a stale empty response", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  for (const mode of ["provider-clear", "turn-end", "disconnect", "stop"]) {
    const f = await fixture();
    try {
      let empty = false;
      const pending = f.question().then(() => { empty = true; }, () => {});
      if (mode === "provider-clear") f.runtime.rpc.emit("notification", "serverRequest/resolved", { threadId: f.threadId, requestId: "question-a" });
      if (mode === "turn-end") f.complete();
      if (mode === "disconnect") f.runtime.rpc.emit("disconnected", "Fixture disconnect");
      if (mode === "stop") f.runtime.stop();
      t.mock.timers.tick(USER_INPUT_WAIT_MS); await Promise.resolve();
      assert.equal(empty, false);
      assert.equal(f.events.some(event => event.reason === "unanswered_input"), false);
      if (mode === "stop") f.runtime.rpc.emit("disconnected", "Fixture disconnect");
      await pending;
    } finally { f.cleanup(); }
  }
});

test("the actual RPC adapter sends the supported empty answer once without an error or approval", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = await fixture(), sent: any[] = [];
  try {
    (f.runtime.rpc as any).send = (value: unknown) => sent.push(value);
    (f.runtime.rpc as any).receiveLine(JSON.stringify({ id: 42, method: "item/tool/requestUserInput",
      params: { threadId: f.threadId, turnId: "turn-1", questions: [{ id: "choice", question: "Exact fixture recipient?" }] } }));
    await setImmediate();
    t.mock.timers.tick(USER_INPUT_WAIT_MS); await setImmediate();
    assert.deepEqual(sent, [{ id: 42, result: { answers: {} } }]);
    t.mock.timers.tick(USER_INPUT_WAIT_MS); await setImmediate();
    assert.equal(sent.length, 1);
  } finally { f.cleanup(); }
});

test("cancellation or direct awaited shutdown disables input expiry before the provider stops", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  for (const mode of ["cancel", "stopAndWait"]) {
    const f = await fixture();
    try {
      let answered = false;
      const pending = f.question().then(() => { answered = true; }, () => {});
      const id = f.events.find(event => event.type === "approval.requested")!.approvalId;
      t.mock.timers.tick(USER_INPUT_WAIT_MS - 1);
      let stopped!: () => void;
      const stopPromise = new Promise<void>(resolve => { stopped = resolve; });
      f.runtime.rpc.stopAndWait = () => stopPromise;
      if (mode === "cancel") await f.runtime.cancel(f.threadId);
      else assert.strictEqual(f.runtime.stopAndWait(), stopPromise);
      t.mock.timers.tick(2); await Promise.resolve();
      assert.equal(answered, false);
      assert.equal(f.events.some(event => event.reason === "unanswered_input"), false);
      assert.throws(() => f.runtime.resolveApproval(id, undefined, { choice: { answers: ["Alex work"] } }), /task is stopping/);
      await assert.rejects(f.question({}, "new-question-during-stop"), /does not match an active task/);
      f.complete(); stopped(); await stopPromise; await pending;
    } finally { f.cleanup(); }
  }
});
