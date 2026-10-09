import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/runtime.js";

test("explicit worker and master role profiles retain the deployed priority tier", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "providence-worker-settings-")));
  try {
    const calls: {method:string; params:any}[] = [];
    const worker = new Runtime({ root, workerModel: "fixture-model", workerReasoningEffort: "low" });
    worker.rpc.start = async () => {};
    worker.rpc.call = async (method, params) => {
      calls.push({ method, params });
      if (method === "account/read") return { account: { type: "fixture" } };
      if (method === "model/list") return { data: [{ id: "fixture-model", model: "fixture-model", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fixture" }], serviceTiers: [{ id: "priority" }] }], nextCursor: null };
      if (method === "thread/resume") return { thread: { id: "existing", cwd: root }, model: "fixture-model", reasoningEffort: "low", serviceTier: "priority" };
      return { turn: { id: "turn" } };
    };
    await worker.start(); await worker.execute("existing", "task", "Fixture", root);
    assert.deepEqual(calls.map(call => call.method), ["account/read", "model/list", "thread/resume", "turn/start"]);
    assert.equal(calls.find(call => call.method === "thread/resume")!.params.model, "fixture-model");
    assert.deepEqual(calls.find(call => call.method === "thread/resume")!.params.config, { model_reasoning_effort: "low" });
    const turn = calls.find(call => call.method === "turn/start")!.params;
    assert.equal(turn.model, "fixture-model"); assert.equal(turn.effort, "low");
    assert.equal(turn.serviceTier, "priority");
    const master = new Runtime({ root, master: true, masterModel: "fixture-model", masterReasoningEffort: "low" });
    master.rpc.start = async () => {};
    const masterCalls: any[] = [];
    master.rpc.call = async (method, params) => {
      masterCalls.push({ method, params });
      if (method === "account/read") return { account: { type: "fixture" } };
      if (method === "model/list") return { data: [{ id: "fixture-model", model: "fixture-model", supportedReasoningEfforts: [{ reasoningEffort: "low" }], serviceTiers: [{ id: "priority" }] }] };
      if (method === "thread/start") return { thread: { id: "master" }, model: "fixture-model", reasoningEffort: "low", serviceTier: "priority" };
      return { turn: { id: "master-turn" } };
    };
    await master.start(); await master.create(); await master.execute("master", "master-task", "Fixture");
    assert.equal(masterCalls.some(call => call.method === "model/list"), true);
    assert.equal(masterCalls.find(call => call.method === "turn/start").params.model, "fixture-model");
    assert.equal(masterCalls.find(call => call.method === "turn/start").params.effort, "low");
    assert.equal(masterCalls.find(call => call.method === "turn/start").params.serviceTier, "priority");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("saved workspace cold resume eliminates one read RPC; legacy discovery and warm turns remain correct", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "providence-worker-resume-")));
  try {
    for (const saved of [false, true]) {
      const worker = new Runtime({ root }); const calls: string[] = [];
      worker.rpc.call = async method => {
        calls.push(method);
        if (method === "thread/read") return { thread: { cwd: root } };
        if (method === "thread/resume") return { thread: { cwd: root }, model: "gpt-6-sol", reasoningEffort: "low", serviceTier: "priority" };
        return { turn: { id: "turn" } };
      };
      await worker.execute("existing", "first", "Fixture", saved ? root : undefined);
      assert.deepEqual(calls, saved ? ["thread/resume", "turn/start"] : ["thread/read", "thread/resume", "turn/start"]);
      worker.rpc.emit("notification", "turn/completed", { threadId: "existing", turn: { id: "turn", status: "completed" } });
      calls.length = 0;
      await worker.execute("existing", "second", "Fixture", saved ? root : undefined);
      assert.deepEqual(calls, ["turn/start"]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("saved workspace cannot escape root or ignore a resumed workspace mismatch", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "providence-worker-root-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "providence-worker-outside-")));
  try {
    const worker = new Runtime({ root }); const calls: string[] = [];
    worker.rpc.call = async method => { calls.push(method); return { thread: { cwd: outside } }; };
    await assert.rejects(worker.execute("existing", "outside", "Fixture", outside), /outside/);
    assert.equal(calls.length, 0);
    await assert.rejects(worker.execute("existing", "mismatch", "Fixture", root), /does not match/);
    assert.deepEqual(calls, ["thread/resume"]);
    worker.rpc.call = async method => { calls.push(method); return { thread: { id: "existing" } }; };
    await assert.rejects(worker.execute("existing", "unconfirmed", "Fixture", root), /does not match/);
    assert.equal(calls.includes("turn/start"), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
