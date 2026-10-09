import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Runtime, type Event } from "../src/runtime.js";
import { masterTools, masterInstructions } from "../src/tools.js";
import { runtimeRequest } from "../src/devices.js";

const retired = "providence_request_decision";
function fixture(master: boolean) {
  const root = mkdtempSync(join(tmpdir(), "providence-retired-decision-"));
  const calls: { method: string; params: any }[] = [], events: Event[] = [];
  const runtime = new Runtime({ root, ...(master ? { master: true, tools: masterTools, instructions: masterInstructions } : {}) });
  const profile = { model: runtime.profile.model, reasoningEffort: runtime.profile.reasoningEffort, serviceTier: runtime.profile.serviceTier };
  runtime.rpc.call = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id: params.threadId, cwd: runtime.root } };
    if (method === "thread/resume") return { thread: { id: params.threadId, cwd: runtime.root }, ...profile };
    if (method === "thread/start") return { thread: { id: "new-thread", cwd: runtime.root }, ...profile };
    return { turn: { id: "current-turn" } };
  };
  runtime.on("event", event => events.push(event));
  return { runtime, calls, events, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const retiredRequest = (threadId: string) => ({ threadId, turnId: "current-turn", tool: retired,
  arguments: { question: "untrusted-fixture-question", options: ["untrusted-fixture-answer", "Cancel"] } });

test("new master and worker conversations do not advertise the retired product tool", async () => {
  assert.equal(masterTools.some(tool => tool.name === retired), false);
  for (const master of [false, true]) {
    const f = fixture(master);
    try {
      await f.runtime.create();
      const created = f.calls.find(call => call.method === "thread/start")!;
      assert.equal(created.params.dynamicTools.some((tool: any) => tool.name === retired), false);
      if (!master) assert.deepEqual(created.params.dynamicTools.map((tool: any) => tool.name), ["providence_publish_artifact"]);
      assert.match(created.params.developerInstructions, /optional providence_request_decision tool has been removed/);
      assert.match(created.params.developerInstructions, /not an approval or permission grant/);
    } finally { f.cleanup(); }
  }
});

test("retired calls on new or resumed active chats return only failure and no approval or fabricated answer", async () => {
  for (const master of [false, true]) for (const resumed of [false, true]) {
    const f = fixture(master);
    try {
      const threadId = resumed ? "preserved-provider-thread" : (await f.runtime.create()).threadId;
      await f.runtime.execute(threadId, "active-task", "Continue the existing authorized fixture work");
      if (resumed) {
        const resume = f.calls.find(call => call.method === "thread/resume")!;
        assert.equal(resume.params.threadId, threadId);
        assert.equal(Object.hasOwn(resume.params, "dynamicTools"), false, "the documented resume contract has no tool registry replacement");
        assert.equal(f.calls.some(call => call.method === "thread/start"), false, "do not reset context to remove a tool");
        assert.match(resume.params.developerInstructions, /has been removed/);
      }
      const result = await f.runtime.rpc.onRequest!("item/tool/call", retiredRequest(threadId), "retired-provider-id");
      assert.equal(result.success, false);
      assert.equal(result.contentItems.length, 1);
      assert.match(result.contentItems[0].text, /has been removed/);
      assert.match(result.contentItems[0].text, /not an approval or a user answer/);
      assert.equal(JSON.stringify(result).includes("untrusted-fixture"), false);
      assert.equal(Object.hasOwn(result, "answers"), false);
      assert.equal(f.events.some(event => event.type.startsWith("approval.")), false);
      const diagnostic = f.events.find(event => event.reasonCode === "product_decision_removed")!;
      assert.equal(diagnostic.taskId, "active-task"); assert.equal(diagnostic.threadId, threadId);
      assert.equal(diagnostic.providerRequestId, "retired-provider-id");
      f.runtime.rpc.emit("notification", "turn/completed", { threadId, turn: { id: "current-turn", status: "completed" } });
      const timing = f.events.find(event => event.type === "runtime.timing")!.timing;
      assert.equal(timing.approvalsRequested, 0); assert.equal(timing.approvalsResolved, 0);
    } finally { f.cleanup(); }
  }
});

test("retired calls still require the matching active task and turn", async () => {
  const f = fixture(false);
  try {
    await assert.rejects(f.runtime.rpc.onRequest!("item/tool/call", retiredRequest("inactive"), 1), /active task/);
    await f.runtime.create(); await f.runtime.execute("new-thread", "task", "Fixture work");
    await assert.rejects(f.runtime.rpc.onRequest!("item/tool/call", { ...retiredRequest("new-thread"), turnId: "previous-turn" }, 2));
    assert.equal(f.events.some(event => event.reasonCode === "product_decision_removed"), false);
    assert.equal(f.events.some(event => event.type === "approval.requested"), false);
  } finally { f.cleanup(); }
});

test("a native provider question still pauses after a retired-tool call and accepts exactly one explicit answer", async () => {
  const f = fixture(true);
  try {
    await f.runtime.execute("preserved-provider-thread", "task", "Continue fixture work");
    await f.runtime.rpc.onRequest!("item/tool/call", retiredRequest("preserved-provider-thread"), "old-registry-call");
    let settled = false;
    const pending = f.runtime.rpc.onRequest!("item/tool/requestUserInput", {
      threadId: "preserved-provider-thread", turnId: "current-turn",
      questions: [{ id: "native-choice", question: "Native provider requires this fixture input",
        options: [{ label: "Continue", description: "Explicit fixture answer" }, { label: "Cancel", description: "Cancel fixture" }] }],
    }, "native-question").then(value => { settled = true; return value; });
    await setImmediate(); assert.equal(settled, false);
    const requested = f.events.filter(event => event.type === "approval.requested");
    assert.equal(requested.length, 1); assert.equal(requested[0].providerRequestId, "native-question");
    assert.throws(() => f.runtime.resolveApproval(requested[0].approvalId, "accept"), /requires answers/);
    assert.equal(settled, false);
    const answers = { "native-choice": { answers: ["Continue"] } };
    await runtimeRequest(f.runtime, "approval.resolve", { approvalId: requested[0].approvalId, answers });
    assert.deepEqual(await pending, { answers });
    await assert.rejects(runtimeRequest(f.runtime, "approval.resolve", { approvalId: requested[0].approvalId, answers }), /no longer pending/);
    assert.equal(f.events.filter(event => event.type === "approval.resolved").length, 1);
    assert.equal(f.calls.filter(call => call.method === "turn/start").length, 1);
  } finally { f.cleanup(); }
});
