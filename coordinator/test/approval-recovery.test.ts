import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator.js";
import { Runtime, type Event } from "../src/runtime.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "providence-decision-recovery-"));
  const app = new Coordinator({ clientToken: "c".repeat(64), localDeviceId: "mac", localDeviceName: "Fixture", workspace: directory, devices: [] }, directory);
  const task = app.store.createTask("synthetic-request", "synthetic-chat", "mac", "Stage a synthetic message").task;
  const request = (id = "decision") => app.event("mac", { type: "approval.requested", taskId: task.id, approvalId: id,
    method: "item/tool/requestUserInput", details: { questions: [{ id: "choice", question: "Send synthetic text to synthetic recipient?" }] } });
  return { directory, app, task, request, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
const answer = { choice: { answers: ["Send"] } };

test("unknown remote decision delivery stays non-actionable and exact task identity survives polling", async () => {
  const f = fixture();
  try {
    f.request(); let calls = 0;
    f.app.devices.online = () => true;
    f.app.devices.call = async () => { calls++; throw new Error("Device RPC timed out"); };
    await assert.rejects(f.app.approval("decision", undefined, answer), /uncertain/);
    assert.equal(f.app.store.state.approvals.decision.status, "resolving");
    assert.deepEqual(f.app.task(f.task.id).approvalStates, [{ id: "decision", method: "item/tool/requestUserInput", status: "resolving" }]);
    assert.equal(f.app.briefing().approvals.length, 0);
    assert.match(f.app.task(f.task.id).progress!.text, /Do not submit/);
    await assert.rejects(f.app.approval("decision", undefined, answer), /no longer pending/);
    assert.equal(calls, 1);
    f.app.event("mac", { type: "approval.resolved", approvalId: "decision", taskId: f.task.id });
    assert.equal(f.app.task(f.task.id).approvalStates[0].status, "resolved");
    assert.equal(f.app.task(f.task.id).status, "running");
  } finally { f.cleanup(); }
});

test("invalid input fails locally while missing worker acknowledgement remains uncertain", async () => {
  const f = fixture();
  try {
    f.request(); let calls = 0;
    f.app.devices.call = async () => { calls++; return {}; };
    await assert.rejects(f.app.approval("decision", "accept"), /requires answers/);
    assert.equal(calls, 0);
    assert.equal(f.app.store.state.approvals.decision.status, "pending");
    await assert.rejects(f.app.approval("decision", undefined, answer), /uncertain/);
    assert.equal(calls, 1);
    assert.equal(f.app.store.state.approvals.decision.status, "resolving");
  } finally { f.cleanup(); }
});

test("proven offline pre-dispatch failure preserves pending; running with pending is a mismatch", async () => {
  const f = fixture();
  try {
    f.request();
    await assert.rejects(f.app.approval("decision", undefined, answer), /offline; the request was not sent/);
    assert.equal(f.app.store.state.approvals.decision.status, "pending");
    let calls = 0;
    f.app.devices.call = async () => { calls++; return { resolved: true }; };
    f.app.store.update(f.task.id, { status: "running" });
    await assert.rejects(f.app.approval("decision", undefined, answer), /do not match/);
    assert.equal(calls, 0);
    assert.equal(f.app.store.state.approvals.decision.status, "pending");
  } finally { f.cleanup(); }
});

test("provider completion with a real unresolved decision is interrupted; prose alone creates no approval", () => {
  for (const pending of [true, false]) {
    const f = fixture();
    try {
      if (pending) f.request();
      f.app.event("mac", { type: "task.completed", taskId: f.task.id, text: "Approval pending. Nothing sent yet." });
      const task = f.app.task(f.task.id);
      assert.equal(task.status, pending ? "interrupted" : "completed");
      assert.equal(task.approvalStates.length, pending ? 1 : 0);
      assert.equal(f.app.briefing().approvals.length, 0);
      if (pending) {
        assert.equal(task.approvalStates[0].status, "expired");
        assert.match(task.error!, /action is not confirmed/);
        assert.equal(f.app.store.state.events.at(-1)!.type, "task.interrupted");
      }
    } finally { f.cleanup(); }
  }
});

test("late remote acknowledgement cannot revive a terminal decision or enable replay", async () => {
  const f = fixture();
  try {
    f.request();
    let resolve!: (value: unknown) => void;
    f.app.devices.call = () => new Promise(done => { resolve = done; });
    const submitted = f.app.approval("decision", undefined, answer);
    f.app.event("mac", { type: "task.interrupted", taskId: f.task.id });
    assert.equal(f.app.store.state.approvals.decision.status, "expired");
    resolve({ resolved: true }); await submitted;
    assert.equal(f.app.store.state.approvals.decision.status, "expired");
    await assert.rejects(f.app.approval("decision", undefined, answer), /no longer pending/);
  } finally { f.cleanup(); }
});

test("an unanswered-input expiry wins over an in-flight answer without clearing another permission gate", async () => {
  for (const outcome of ["acknowledge", "reject"]) {
    const f = fixture();
    try {
      f.request();
      f.app.event("mac", { type: "approval.requested", taskId: f.task.id, approvalId: "required-permission",
        method: "item/commandExecution/requestApproval", details: { command: "fixture", availableDecisions: ["cancel"] } });
      let finish!: () => void;
      f.app.devices.call = () => new Promise((resolve, reject) => {
        finish = () => outcome === "acknowledge" ? resolve({ resolved: true }) : reject(new Error("Question expired without an answer"));
      });
      const submitted = f.app.approval("decision", undefined, answer).then(value => ({ value }), error => ({ error }));
      assert.equal(f.app.store.state.approvals.decision.status, "resolving");
      f.app.event("mac", { type: "approval.expired", approvalId: "decision", taskId: f.task.id, reason: "unanswered_input" });
      finish(); await submitted;
      assert.equal(f.app.store.state.approvals.decision.status, "expired");
      assert.equal(f.app.store.state.approvals["required-permission"].status, "pending");
      assert.equal(f.app.task(f.task.id).status, "needs_input");
      await assert.rejects(f.app.approval("decision", undefined, answer), /no longer pending/);
      assert.equal(f.app.briefing().approvals.some(value => value.id === "decision"), false);
    } finally { f.cleanup(); }
  }
});

test("resolving one decision cannot hide another uncertain decision", async () => {
  const f = fixture();
  try {
    f.request("one"); f.request("two");
    f.app.store.state.approvals.two.status = "resolving";
    f.app.event("mac", { type: "approval.resolved", approvalId: "one", taskId: f.task.id });
    assert.equal(f.app.task(f.task.id).status, "needs_input");
  } finally { f.cleanup(); }
});

test("approval settlement is monotonic and bound to typed provider request, thread and supplied turn", () => {
  for (const closed of ["resolved", "expired"]) {
    const f = fixture();
    try {
      f.app.event("mac", { type: "approval.requested", taskId: f.task.id, approvalId: "bound",
        providerRequestId: 42, method: "item/tool/requestUserInput", details: { threadId: "thread", turnId: "turn", questions: [] } });
      const base = { type: `approval.${closed}`, taskId: f.task.id, approvalId: "bound", providerRequestId: 42, threadId: "thread", turnId: "turn" };
      for (const change of [{ providerRequestId: "42" }, { providerRequestId: undefined }, { threadId: "other" }, { turnId: "old" }]) {
        f.app.event("mac", { ...base, ...change });
        assert.equal(f.app.store.state.approvals.bound.status, "pending");
      }
      f.app.event("mac", base);
      assert.equal(f.app.store.state.approvals.bound.status, closed);
      f.app.event("mac", { ...base, type: closed === "resolved" ? "approval.expired" : "approval.resolved" });
      assert.equal(f.app.store.state.approvals.bound.status, closed);
    } finally { f.cleanup(); }
  }
});

test("native provider input pauses synthetic effect and timing carries no message content", async () => {
  const f = fixture();
  try {
    const runtime = new Runtime({ root: f.directory });
    runtime.rpc.call = async method => method === "thread/start"
      ? { thread: { id: "thread" }, model: "gpt-6-sol", reasoningEffort: "low", serviceTier: "priority" }
      : { turn: { id: "turn" } };
    const events: Event[] = [];
    runtime.on("event", event => { events.push(event); f.app.event("mac", event); });
    await runtime.create(); await runtime.execute("thread", f.task.id, "private-fixture-content");
    runtime.rpc.emit("notification", "turn/started", { threadId: "thread", turn: { id: "turn" } });
    runtime.rpc.emit("notification", "item/started", { threadId: "thread", turnId: "turn", item: { type: "mcpToolCall", id: "browser", server: "fixture", tool: "stage" } });
    runtime.rpc.emit("notification", "item/completed", { threadId: "thread", turnId: "turn", item: { type: "mcpToolCall", id: "browser" } });
    let syntheticEffects = 0;
    const waiting = runtime.rpc.onRequest!("item/tool/requestUserInput", { threadId: "thread", turnId: "turn",
      questions: [{ id: "choice", question: "Send private-fixture-content to synthetic recipient?",
        options: [{ label: "Send", description: "Fixture accept" }, { label: "Cancel", description: "Fixture cancel" }] }] }, "provider-decision")
      .then(result => { if (result.answers.choice.answers[0] === "Send") syntheticEffects++; });
    assert.equal(f.app.task(f.task.id).status, "needs_input"); assert.equal(syntheticEffects, 0);
    const decision = f.app.briefing().approvals[0];
    runtime.resolveApproval(decision.id, undefined, { choice: { answers: ["Cancel"] } });
    await waiting; assert.equal(syntheticEffects, 0);
    assert.throws(() => runtime.resolveApproval(decision.id, undefined, answer), /no longer pending/);
    runtime.rpc.emit("notification", "turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed" } });
    const timing = events.find(event => event.type === "runtime.timing")!.timing;
    assert.equal(timing.toolCount, 1); assert.equal(timing.approvalsRequested, 1); assert.equal(timing.approvalsResolved, 1);
    assert.equal(timing.workerStartMode, "warm"); assert.equal(timing.modelInferenceMs, null);
    assert.equal(JSON.stringify(timing).includes("private-fixture-content"), false);
    assert.equal(f.app.task(f.task.id).status, "completed");
  } finally { f.cleanup(); }
});
