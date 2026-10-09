import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime, type Event } from "../src/runtime.js";

test("disconnect during turn startup finalizes timing exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "providence-timing-disconnect-"));
  try {
    const runtime = new Runtime({ root }); const events: Event[] = [];
    runtime.on("event", event => events.push(event));
    runtime.rpc.call = async method => {
      if (method === "thread/start") return { thread: { id: "thread" }, model: "gpt-6-sol", reasoningEffort: "low", serviceTier: "priority" };
      runtime.rpc.emit("disconnected", "Fixture disconnected");
      throw new Error("Fixture disconnected");
    };
    await runtime.create();
    await assert.rejects(runtime.execute("thread", "task", "Fixture"), /disconnected/);
    assert.equal(events.filter(event => event.type === "runtime.timing").length, 1);
    assert.equal(events.filter(event => event.type === "task.failed").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("late startup acknowledgement cannot replace the identity or timing of a newer turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "providence-timing-identity-"));
  try {
    const runtime = new Runtime({ root }); const events: Event[] = [];
    let oldAck!: (value: any) => void;
    let starts = 0;
    runtime.rpc.call = async method => {
      if (method === "thread/start") return { thread: { id: "thread" }, model: "gpt-6-sol", reasoningEffort: "low", serviceTier: "priority" };
      if (++starts === 1) return new Promise(resolve => { oldAck = resolve; });
      return { turn: { id: "new-turn" } };
    };
    runtime.on("event", event => events.push(event));
    await runtime.create();
    const old = runtime.execute("thread", "old-task", "Fixture");
    runtime.rpc.emit("notification", "turn/completed", { threadId: "thread", turn: { id: "old-turn", status: "completed" } });
    await runtime.execute("thread", "new-task", "Fixture");
    oldAck({ turn: { id: "old-turn" } }); await old;
    runtime.rpc.emit("notification", "turn/completed", { threadId: "thread", turn: { id: "new-turn", status: "completed" } });
    assert.deepEqual(events.filter(event => event.type === "task.completed").map(event => event.taskId), ["old-task", "new-task"]);
    assert.deepEqual(events.filter(event => event.type === "runtime.turn_acknowledged").map(event => event.taskId), ["new-task"]);
    assert.equal(events.filter(event => event.type === "runtime.timing").length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
