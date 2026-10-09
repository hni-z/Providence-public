import { TaskTiming } from "../src/task-timing.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import { CodexRpc } from "../src/rpc.js";
import { Devices } from "../src/devices.js";
import { Runtime, type Event } from "../src/runtime.js";

function fixture() {
  const rpc = new CodexRpc();
  const sent: any[] = [];
  (rpc as any).send = (value: any) => sent.push(value);
  const receive = (value: unknown) => (rpc as any).receiveLine(JSON.stringify(value));
  return { rpc, sent, receive };
}

test("a request cleared in the same transport tick never reaches a handler or sends a late reply", async () => {
  const f = fixture();
  let handlers = 0;
  f.rpc.onRequest = async () => { handlers++; return { accepted: true }; };
  f.receive({ method: "mcpServer/elicitation/request", id: 4, params: { threadId: "thread" } });
  f.receive({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: 4 } });
  await setImmediate();
  assert.equal(handlers, 0);
  assert.deepEqual(f.sent, []);
});

test("wrong thread or differently typed request ID cannot clear a live provider request", async () => {
  const f = fixture();
  let resolve!: (value: any) => void;
  f.rpc.onRequest = () => new Promise(done => { resolve = done; });
  f.receive({ method: "mcpServer/elicitation/request", id: 4, params: { threadId: "thread" } });
  await setImmediate();
  f.receive({ method: "serverRequest/resolved", params: { threadId: "other", requestId: 4 } });
  f.receive({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: "4" } });
  resolve({ action: "decline", content: null, _meta: null });
  await setImmediate();
  assert.deepEqual(f.sent, [{ id: 4, result: { action: "decline", content: null, _meta: null } }]);
});

test("a provider-cleared in-flight handler cannot send its eventual result or error", async () => {
  for (const fail of [false, true]) {
    const f = fixture();
    let finish!: () => void;
    f.rpc.onRequest = () => new Promise((resolve, reject) => { finish = () => fail ? reject(new Error("private diagnostic")) : resolve({ action: "accept" }); });
    f.receive({ method: "mcpServer/elicitation/request", id: "pending", params: { threadId: "thread" } });
    await setImmediate();
    f.receive({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: "pending" } });
    finish();
    await setImmediate();
    assert.deepEqual(f.sent, []);
  }
});

test("unexpected handler diagnostics are not echoed to the provider transport", async () => {
  const f = fixture();
  f.rpc.onRequest = async () => { throw new Error("private-token-fixture"); };
  f.receive({ method: "unsupported", id: 1, params: { threadId: "thread" } });
  await setImmediate();
  assert.deepEqual(f.sent, [{ id: 1, error: { code: -32603, message: "Provider request could not be handled." } }]);
});

test("a Codex child that exits is respawned on the same transport and brings the device back online", async () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-respawn-"));
  try {
    const runtime = new Runtime({ root: directory, reconnect: { minMs: 1, maxMs: 2 } });
    const devices = new Devices("mac", "Mac", runtime, []);
    const events: Event[] = [];
    runtime.on("event", (event: Event) => events.push(event));
    let starts = 0;
    let available = true;
    runtime.rpc.start = async () => {
      starts++;
      if (!available) throw new Error("codex is still unavailable");
    };
    runtime.rpc.call = async (method) => {
      if (method === "account/read") return { account: { type: "chatgpt" } };
      if (method === "model/list")
        return { data: [{ model: "gpt-6-sol", supportedReasoningEfforts: [{ reasoningEffort: "low" }],
          serviceTiers: [{ id: "priority" }] }], nextCursor: null };
      throw new Error(`Unexpected method ${method}`);
    };
    await devices.start();
    assert.equal(devices.online("mac"), true);
    (runtime as any).loaded.add("thread");
    (runtime as any).workspaces.set("thread", directory);
    (runtime as any).active.set("thread", { taskId: "task", text: "", items: new Set(), timing: new TaskTiming() });
    available = false;
    const started = starts;
    runtime.rpc.emit("disconnected", "Codex exited (1)");
    assert.equal(devices.online("mac"), false);
    assert.deepEqual(
      events.map((event) => event.type),
      ["runtime.timing", "task.failed", "runtime.offline"],
      "the interrupted task fails once and is never replayed",
    );
    assert.equal((runtime as any).loaded.size, 0, "the next task must re-import its conversation");
    assert.equal((runtime as any).workspaces.size, 0);
    await setTimeout(10);
    assert.equal(starts > started, true, "an exited child is respawned without waiting for a restart");
    available = true;
    // The runtime timer that respawns the child does not hold the event loop open; this poll does.
    for (let waited = 0; waited < 2000 && !devices.online("mac"); waited += 5) await setTimeout(5);
    assert.equal(devices.online("mac"), true);
    assert.equal(runtime.connected, true);
    assert.equal(starts > started + 1, true, "a failed respawn is retried");
    runtime.stop();
    const quiet = starts;
    runtime.rpc.emit("disconnected", "Codex exited (1)");
    await setTimeout(20);
    assert.equal(starts, quiet, "a stopped runtime is never respawned");
    assert.equal(devices.online("mac"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a resumed conversation carries the Providence tool contract only behind its flag", async () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-resume-tools-"));
  const configured = process.env.PROVIDENCE_RESUME_TOOLS;
  const resume = async (flag?: string) => {
    if (flag === undefined) delete process.env.PROVIDENCE_RESUME_TOOLS;
    else process.env.PROVIDENCE_RESUME_TOOLS = flag;
    const runtime = new Runtime({ root: directory });
    const calls: { method: string; params: any }[] = [];
    runtime.rpc.call = async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/read") return { thread: { cwd: directory } };
      return { model: "gpt-6-sol", reasoningEffort: "low", serviceTier: "priority" };
    };
    try {
      await runtime.importThread("resumed");
    } finally {
      runtime.stop();
    }
    assert.equal(calls.at(-1)!.method, "thread/resume");
    return { params: calls.at(-1)!.params as Record<string, any>, root: runtime.root };
  };
  try {
    for (const flag of [undefined, "0", "1"]) {
      const { params, root } = await resume(flag);
      const { developerInstructions, dynamicTools, ...rest } = params;
      assert.match(developerInstructions, /^You are a Providence device worker\./);
      assert.deepEqual(rest, {
        threadId: "resumed", cwd: root, approvalPolicy: "on-request", sandbox: "workspace-write",
        model: "gpt-6-sol", serviceTier: "priority", config: { model_reasoning_effort: "low" },
        excludeTurns: true,
      });
      if (flag !== "1") {
        assert.equal("dynamicTools" in params, false, "an unflagged resume must send today's exact parameters");
        continue;
      }
      assert.deepEqual(dynamicTools.map((tool: any) => tool.name), [
        "providence_publish_artifact",
      ]);
    }
  } finally {
    if (configured === undefined) delete process.env.PROVIDENCE_RESUME_TOOLS;
    else process.env.PROVIDENCE_RESUME_TOOLS = configured;
    rmSync(directory, { recursive: true, force: true });
  }
});
