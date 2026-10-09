import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRpc } from "../src/rpc.js";
import { Runtime, type Event } from "../src/runtime.js";

class FakeChild extends EventEmitter {
  pid: number | undefined = 123;
  exitCode: number | null = null;
  signalCode: string | null = null;
  signals: string[] = [];
  onSignal?: () => void;
  kill(signal: string) { this.signals.push(signal); this.onSignal?.(); return true; }
  exit() { this.signalCode = "SIGTERM"; this.emit("exit", null, "SIGTERM"); }
}
function fixture() {
  const rpc = new CodexRpc();
  const child = new FakeChild();
  (rpc as any).watchChild(child);
  return { rpc, child };
}

test("owned shutdown waits for the actual delayed exit and shares one promise/signal", async () => {
  const { rpc, child } = fixture();
  let finished = false;
  const stopping = rpc.stopAndWait();
  void stopping.then(() => { finished = true; });
  assert.strictEqual(rpc.stopAndWait(1), stopping);
  rpc.stop();
  await Promise.resolve();
  assert.equal(finished, false);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  child.exit();
  await stopping;
  assert.equal(finished, true);
  assert.equal(child.listenerCount("exit"), 1, "only the permanent RPC observer remains");
  assert.equal(child.listenerCount("error"), 1);
  assert.strictEqual(rpc.stopAndWait(), stopping);
});

test("exit listener precedes the signal and an earlier stop never causes a second signal", async () => {
  const synchronous = fixture();
  synchronous.child.onSignal = () => synchronous.child.exit();
  await synchronous.rpc.stopAndWait();
  assert.deepEqual(synchronous.child.signals, ["SIGTERM"]);
  const delayed = fixture();
  delayed.rpc.stop();
  const stopping = delayed.rpc.stopAndWait();
  delayed.rpc.stop();
  assert.deepEqual(delayed.child.signals, ["SIGTERM"]);
  delayed.child.exit();
  await stopping;
});

test("unconfirmed exit times out safely, without escalation or repeating a signal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { rpc, child } = fixture();
  child.onSignal = () => { throw new Error("private-signal-diagnostic"); };
  const stopping = rpc.stopAndWait(25);
  const rejected = assert.rejects(stopping, { message: "Codex child shutdown was not confirmed before the timeout." });
  child.emit("error", new Error("private-process-error"));
  t.mock.timers.tick(25);
  await rejected;
  assert.strictEqual(rpc.stopAndWait(), stopping);
  rpc.stop();
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(child.listenerCount("exit"), 1);
  assert.equal(child.listenerCount("error"), 1);
});

test("no child, confirmed prior exit and actual spawn failure need no new signal", async () => {
  const empty = new CodexRpc();
  const noChild = empty.stopAndWait();
  assert.strictEqual(empty.stopAndWait(), noChild);
  await noChild;
  const exited = fixture();
  exited.child.exit();
  await exited.rpc.stopAndWait();
  assert.deepEqual(exited.child.signals, []);
  const failed = fixture();
  failed.child.pid = undefined;
  failed.child.emit("error", new Error("private-spawn-error"));
  await failed.rpc.stopAndWait();
  assert.deepEqual(failed.child.signals, []);
  const failing = fixture();
  failing.child.pid = undefined;
  const stopping = failing.rpc.stopAndWait();
  failing.child.emit("error", new Error("private-spawn-error"));
  await stopping;
  assert.deepEqual(failing.child.signals, ["SIGTERM"]);
});

test("Runtime shutdown forwards the exact owned RPC completion promise", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "providence-runtime-stop-")));
  try {
    const runtime = new Runtime({ root });
    let finish!: () => void;
    const promise = new Promise<void>(resolve => { finish = resolve; });
    runtime.rpc.stopAndWait = timeoutMs => { assert.equal(timeoutMs, 42); return promise; };
    assert.strictEqual(runtime.stopAndWait(42), promise);
    finish();
    await promise;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only actual unauthorized provider error fields add fixed task failure provenance", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "providence-provider-failure-")));
  try {
    const runtime = new Runtime({ root });
    runtime.rpc.call = async method => method === "thread/start"
      ? { thread: { id: "thread" }, model: "gpt-6-sol", reasoningEffort: "low", serviceTier: "priority" }
      : { turn: { id: "turn" } };
    await runtime.create();
    const events: Event[] = [];
    runtime.on("event", event => events.push(event));
    const errors = [
      { message: "Sign-in is required", codexErrorInfo: "unauthorized" },
      { message: "Sign-in is required", codex_error_info: "unauthorized" },
      { message: "ordinary failure", codexErrorInfo: "rateLimitExceeded" },
      { message: "unauthorized text alone", code: "unauthorized" },
      { message: "ordinary failure", codexErrorInfo: { unauthorized: true } },
      { message: "ordinary failure", providerErrorCode: "unauthorized", account: "private-account" },
    ];
    for (const [index, error] of errors.entries()) {
      await runtime.execute("thread", `task-${index}`, "Fixture");
      runtime.rpc.emit("notification", "turn/completed", { threadId: "thread", turn: { id: "turn", status: "failed", error } });
      const event = events.find(event => event.taskId === `task-${index}` && event.type === "task.failed")!;
      assert.equal(event.error, error.message);
      assert.equal(event.providerErrorCode, index < 2 ? "unauthorized" : undefined);
      assert.equal(JSON.stringify(event).includes("private-account"), false);
      assert.equal("codexErrorInfo" in event, false);
      assert.equal("codex_error_info" in event, false);
    }
    for (const status of ["completed", "interrupted"]) {
      await runtime.execute("thread", status, "Fixture");
      runtime.rpc.emit("notification", "turn/completed", { threadId: "thread", turn: { id: "turn", status, error: errors[0] } });
      const event = events.find(event => event.taskId === status && event.type.startsWith("task."))!;
      assert.equal("providerErrorCode" in event, false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
