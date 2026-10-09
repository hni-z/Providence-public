import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BENCHMARK_PROMPT, benchmarkCli, benchmarkPlan, runWorkerBenchmark } from "../src/benchmark-worker.js";

class FakeRpc extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  emitTool = false;
  onRequest?: (method: string, params: unknown, id: string | number) => Promise<unknown>;
  async call(method: string, params: any = {}) {
    this.calls.push({ method, params });
    if (method === "model/list") return { data: [
      { id: "baseline-id", model: "baseline", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }] },
      { id: "candidate-id", model: "candidate", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }] },
    ] };
    if (method === "thread/start") return { thread: { id: `thread-${this.calls.length}` } };
    if (method === "turn/start") {
      const threadId = params.threadId;
      queueMicrotask(() => this.emitTool
        ? this.emit("notification", "item/started", { threadId, item: { type: "mcpToolCall" } })
        : (this.emit("notification", "item/completed", { threadId, item: { type: "agentMessage", text: "42" } }), this.emit("notification", "turn/completed", { threadId, turn: { status: "completed" } })));
      return { turn: { id: `turn-${this.calls.length}` } };
    }
    return {};
  }
}

test("dry run has a source safety plan and makes zero RPC calls", async () => {
  const rpc = new FakeRpc();
  assert.match(benchmarkPlan(), /toolsAreIsolated:false/);
  assert.match(await benchmarkCli([], rpc as any), /Dry run/);
  assert.equal(rpc.calls.length, 0);
  assert.equal(BENCHMARK_PROMPT, "Return exactly 42. Do not use tools.");
});

test("run requests separate read-only synthetic threads and reports only metrics", async () => {
  const rpc = new FakeRpc();
  const result = await runWorkerBenchmark({ rpc, baseline: { model: "baseline", effort: "low" }, candidate: { model: "candidate", effort: "high" }, repetitions: 1, timeoutMs: 1000 });
  assert.equal(result.baseline.successfulRounds, 1);
  assert.equal(result.candidate.successfulRounds, 1);
  assert.equal(result.toolsAreIsolated, false);
  for (const call of rpc.calls.filter(call => call.method === "thread/start")) assert.deepEqual({ approvalPolicy: call.params.approvalPolicy, sandbox: call.params.sandbox, dynamicTools: call.params.dynamicTools, ephemeral: call.params.ephemeral, effort: call.params.effort }, { approvalPolicy: "never", sandbox: "read-only", dynamicTools: [], ephemeral: true, effort: undefined });
  assert.equal(rpc.calls.filter(call => call.method === "turn/start").every(call => call.params.input[0].text === BENCHMARK_PROMPT), true);
  assert.equal(JSON.stringify(result).includes(BENCHMARK_PROMPT), false);
});

test("a tool notification interrupts the round and is never successful", async () => {
  const rpc = new FakeRpc();
  rpc.emitTool = true;
  const result = await runWorkerBenchmark({ rpc, baseline: { model: "baseline", effort: "low" }, candidate: { model: "candidate", effort: "high" }, repetitions: 1, timeoutMs: 1000 });
  assert.equal(result.baseline.rounds[0]!.invalid, true);
  assert.ok(rpc.calls.some(call => call.method === "turn/interrupt"));
  assert.equal(result.candidate.rounds.length, 0);
});

test("rejects invalid repeat counts before any RPC", async () => {
  const rpc = new FakeRpc();
  await assert.rejects(runWorkerBenchmark({ rpc, baseline: { model: "baseline" }, candidate: { model: "candidate" }, repetitions: 11 }), /1 through 10/);
  assert.equal(rpc.calls.length, 0);
  let starts = 0;
  (rpc as any).start = async () => { starts++; };
  await assert.rejects(benchmarkCli(["--run", "--baseline-model", "baseline", "--baseline-effort", "low", "--candidate-model", "candidate", "--candidate-effort", "high", "--repetitions", "11"], rpc as any), /1 through 10/);
  assert.equal(starts, 0);
});
