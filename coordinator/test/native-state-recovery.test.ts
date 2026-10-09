import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator.js";
import { Runtime } from "../src/runtime.js";
import { masterInstructions } from "../src/tools.js";
import { nativeStateRecoveryGuidance } from "../src/working-style.js";

test("idle-chat recovery guidance preserves purpose/identity and affects the next dispatch without replaying work", async () => {
  const root = mkdtempSync(join(tmpdir(), "providence-state-recovery-"));
  try {
    const app = new Coordinator({ clientToken: "x".repeat(64), localDeviceId: "mac", localDeviceName: "Mac", workspace: root, devices: [] }, root);
    const chat = app.store.addChat("Existing demo", "mac", "original-provider");
    chat.instructions = "Preserve the existing project purpose.";
    const calls: { method: string; params: any }[] = [];
    app.devices.online = () => true;
    app.devices.call = async (_device, method, params) => { calls.push({ method, params }); return { turnId: "turn" }; };
    app.updateChat(chat.id, { appendInstructions: nativeStateRecoveryGuidance });
    const exactInstructions = chat.instructions;
    app.updateChat(chat.id, { appendInstructions: nativeStateRecoveryGuidance });
    assert.equal(chat.instructions, exactInstructions, "an uncertain PATCH retry must not duplicate guidance");
    assert.equal(chat.threadId, "original-provider");
    assert.equal(Object.keys(app.store.state.tasks).length, 0, "configuration must not replay a prior request");
    assert.equal(Object.keys(app.store.state.approvals).length, 0);
    const task = await app.dispatch(chat.id, { requestId: "new-explicit-request", text: "Read the current window title only." });
    await new Promise(resolve => setImmediate(resolve));
    const sent = calls.filter(call => call.method === "task.start");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].params.threadId, "original-provider");
    assert.ok(sent[0].params.text.includes("Preserve the existing project purpose."));
    assert.ok(sent[0].params.text.includes(nativeStateRecoveryGuidance));
    assert.ok(sent[0].params.text.includes("Current request:\nRead the current window title only."));
    for (const error of [
      "The user changed '/Applications/Discord.app'. Re-query the latest state with get_app_state before sending more actions.",
      "Permission denied", "User cancelled", "Account changed", "Send acknowledgement unknown",
    ]) app.event("mac", { type: "tool.completed", taskId: task.id, threadId: "original-provider", error });
    assert.equal(calls.filter(call => call.method === "task.start").length, 1, "tool errors never trigger coordinator action replay");
    assert.equal(Object.keys(app.store.state.tasks).length, 1);
    assert.equal(Object.keys(app.store.state.approvals).length, 0, "guidance cannot invent or approve a permission grant");
    assert.throws(() => app.updateChat(chat.id, { appendInstructions: "different guidance" }), /busy/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("new and resumed workers receive recovery guidance without altering their permission/profile contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-recovery-parameters-"));
  const root = realpathSync(directory);
  try {
    const worker = new Runtime({ root, workerAccess: "full-access" });
    const calls: { method: string; params: any }[] = [];
    worker.rpc.call = async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/read") return { thread: { cwd: root } };
      return { thread: { id: "same-thread" }, model: "gpt-6-sol", reasoningEffort: "low", serviceTier: "priority",
        approvalPolicy: "never", sandbox: { type: "dangerFullAccess" } };
    };
    await worker.create({ instructions: "Existing purpose" });
    await worker.importThread("same-thread");
    for (const call of calls.filter(call => ["thread/start", "thread/resume"].includes(call.method))) {
      assert.ok(call.params.developerInstructions.includes(nativeStateRecoveryGuidance));
      assert.equal(call.params.permissions, ":danger-full-access");
      assert.equal(call.params.approvalPolicy, "never");
      assert.equal(call.params.model, "gpt-6-sol");
      assert.equal(call.params.serviceTier, "priority");
    }
    assert.equal(calls.some(call => call.method === "turn/start" || call.method === "turn/steer"), false);
    assert.ok(masterInstructions.includes(nativeStateRecoveryGuidance));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
