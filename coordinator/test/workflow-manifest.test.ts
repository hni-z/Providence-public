import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Coordinator } from "../src/coordinator.js";
import { createHttpServer } from "../src/server.js";
import { workflowManifestSchema, workflowRoles, type WorkflowManifest, type WorkflowRole } from "../src/workflow-manifest.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "providence-workflow-"));
  const config = { clientToken: "c".repeat(64), localDeviceId: "mac", localDeviceName: "Mac", workspace: directory,
    devices: [{ id: "demoPC", name: "DemoPC", token: "b".repeat(64) }, { id: "review", name: "Review", token: "y".repeat(64) }] };
  const app = new Coordinator(config, directory);
  const devices = ["mac", "demoPC", "review"].map((id) => ({ id, name: id, online: true, capabilities: { files: true, shell: true, browser: true, desktop: false } }));
  app.devices.list = () => devices as any;
  app.devices.online = (id) => devices.some((device) => device.id === id && device.online);
  const calls: { deviceId: string; method: string; params: any }[] = [];
  app.devices.call = async (deviceId, method, params) => { calls.push({ deviceId, method, params }); return { turnId: `turn-${params.taskId}` }; };
  const chats = devices.map((device) => app.store.addChat(`${device.name} demo`, device.id, `thread-${device.id}`));
  const workflow: WorkflowManifest = { version: 1, bindings: workflowRoles.map((role, index) => ({ role, deviceId: devices[index].id, chatId: chats[index].id })) };
  const masters: { id: string; prompt: string }[] = [];
  app.master.create = async () => ({ threadId: "workflow-master", workspace: directory });
  app.master.execute = async (_thread, id, prompt) => { masters.push({ id, prompt }); return { turnId: `master-${id}` }; };
  const input = { requestId: "workflow-root", text: "Research then independently analyze and present", workflow };
  const admit = async () => { const parent = await app.message(input); await setImmediate(); return app.store.state.tasks[parent.id]; };
  const child = (parentId: string, role: WorkflowRole, afterTaskId?: string, extra = {}) => app.dispatch(workflow.bindings.find((binding) => binding.role === role)!.chatId,
    { requestId: `request-${role}`, role, text: `Do ${role}`, ...(afterTaskId ? { afterTaskId } : {}), ...extra }, parentId);
  const bundle = (task: { id: string; deviceId: string; chatId: string }, fact = "A fixture researched fact") => JSON.stringify({
    version: 1, topic: "Fixture topic", criteria: "Fixture comparison", generatedAt: "2026-09-20T00:00:00Z",
    origin: { taskId: task.id, deviceId: task.deviceId, chatId: task.chatId, artifact: { status: "not_published" } },
    sources: [{ id: "source", url: "https://example.com/research", title: "Fixture source", retrievedAt: "2026-09-20T00:00:00Z" }],
    facts: [{ id: "fact", text: fact, sourceIds: ["source"] }],
  });
  return { app, config, directory, devices, chats, workflow, input, calls, masters, admit, child, bundle,
    finish: (task: { id: string; deviceId: string; chatId: string; workflowRole?: WorkflowRole }, type = "task.completed", text?: string) => app.event(task.deviceId, {
      type, taskId: task.id, text: text ?? (task.workflowRole === "research" && type === "task.completed" ? bundle(task) : "Actual completed result"), error: type === "task.failed" ? "Failed" : undefined }),
    cleanup: async () => { await setImmediate(); rmSync(directory, { recursive: true, force: true }); } };
}

test("manifest is strict, exactly three unique roles/computers/chats and validated before parent reservation", async () => {
  const f = fixture();
  try {
    const b = f.workflow.bindings;
    for (const workflow of [
      { ...f.workflow, version: 2 }, { ...f.workflow, bindings: b.slice(0, 2) }, { ...f.workflow, extra: true },
      { ...f.workflow, bindings: [b[0], b[0], b[2]] },
      { ...f.workflow, bindings: [b[0], { ...b[1], deviceId: b[0].deviceId }, b[2]] },
      { ...f.workflow, bindings: [b[0], { ...b[1], chatId: b[0].chatId }, b[2]] },
      { ...f.workflow, bindings: [{ ...b[0], target: "phone" }, b[1], b[2]] },
    ]) await assert.rejects(f.app.message({ ...f.input, workflow } as any));
    assert.equal(Object.keys(f.app.store.state.tasks).length, 0);
    assert.equal(f.masters.length, 0); assert.equal(f.calls.length, 0);
    assert.deepEqual(workflowManifestSchema.parse({ ...f.workflow, bindings: [...b].reverse() }), f.workflow);
  } finally { await f.cleanup(); }
});

test("all three visible-workflow bindings require exact registration, online and file/shell/app support", async () => {
  const f = fixture();
  try {
    for (const device of f.devices) {
      device.online = false;
      await assert.rejects(f.app.message(f.input), /offline or unavailable/);
      device.online = true;
      for (const key of ["files", "shell", "browser"] as const) {
        device.capabilities[key] = false;
        await assert.rejects(f.app.message(f.input), key === "browser" ? /browser or desktop/ : /file and shell/);
        device.capabilities[key] = true;
      }
    }
    await assert.rejects(f.app.message({ ...f.input, workflow: { ...f.workflow, bindings: f.workflow.bindings.map((binding, index) => index === 0 ? { ...binding, deviceId: "missing" } : binding) } }), /exact registered/);
    assert.equal(Object.keys(f.app.store.state.tasks).length, 0);
    f.devices[0].capabilities.browser = false; f.devices[0].capabilities.desktop = true;
    await f.admit();
    assert.equal(f.masters.length, 1); assert.equal(f.calls.length, 0);
    assert.match(f.masters[0].prompt, /server-enforced three-computer workflow/);
  } finally { await f.cleanup(); }
});

test("root retry retains frozen assignments and existing children even offline; changed manifest conflicts", async () => {
  const f = fixture();
  try {
    const parent = await f.admit();
    assert.ok(Object.isFrozen(parent.workflow)); assert.ok(Object.isFrozen(parent.workflow!.bindings[0]));
    const research = await f.child(parent.id, "research");
    f.devices[0].online = false;
    const retry = await f.app.message({ ...f.input, workflow: { ...f.workflow, bindings: [...f.workflow.bindings].reverse() } });
    assert.equal(retry.id, parent.id); assert.deepEqual(retry.childTaskIds, [research.id]);
    const changed = structuredClone(f.workflow);
    [changed.bindings[0].deviceId, changed.bindings[1].deviceId] = [changed.bindings[1].deviceId, changed.bindings[0].deviceId];
    await assert.rejects(f.app.message({ ...f.input, workflow: changed }), /different input/);
    await assert.rejects(f.app.message({ requestId: f.input.requestId, text: f.input.text }), /different input/);
    const persisted = JSON.parse(readFileSync(join(f.directory, "state.json"), "utf8"));
    assert.deepEqual(persisted.tasks[parent.id].workflow, f.workflow);
    assert.equal(f.masters.length, 1); assert.equal(f.calls.length, 1);
  } finally { await f.cleanup(); }
});

test("guarded child target/role/dependency errors and extra side-effect tools reserve nothing", async () => {
  const f = fixture();
  try {
    const parent = await f.admit();
    const count = Object.keys(f.app.store.state.tasks).length;
    await assert.rejects(f.app.dispatch(f.chats[0].id, { requestId: "missing-role", text: "Research" }, parent.id), /explicit.*role/);
    await assert.rejects(f.child(parent.id, "analysis"), /exact research task/);
    await assert.rejects(f.app.dispatch(f.chats[1].id, { requestId: "wrong-target", text: "Research", role: "research" }, parent.id), /frozen assignment/);
    await assert.rejects(f.child(parent.id, "research", undefined, { sourceChatIds: [f.chats[1].id] }), /without dependencies/);
    await assert.rejects((f.app as any).handleTool("providence_create_chat", { deviceId: "mac", name: "Extra" }, "new-chat", parent.id), /three frozen/);
    await assert.rejects((f.app as any).handleTool("providence_phone_open_url", { url: "https://example.com" }, "phone", parent.id), /three frozen/);
    assert.equal(Object.keys(f.app.store.state.tasks).length, count); assert.equal(f.calls.length, 0);
    await assert.rejects(f.app.dispatch(f.chats[0].id, { requestId: "forged-parent", role: "research", text: "Research", parentTaskId: parent.id }), /guarded coordinator/);
    await assert.rejects(f.app.dispatch(f.chats[0].id, { ...f.input, requestId: "wrong-route" }), /coordinator messages route/);
  } finally { await f.cleanup(); }
});

test("duplicate semantic role calls return the original task; conflicting or fourth assignments cannot fan out", async () => {
  const f = fixture();
  try {
    const parent = await f.admit(), research = await f.child(parent.id, "research");
    assert.equal((await f.child(parent.id, "research")).id, research.id);
    assert.equal((await f.child(parent.id, "research", undefined, { requestId: "new-call-same-role" })).id, research.id);
    assert.equal(f.app.store.findRequest("new-call-same-role")?.id, research.id);
    await assert.rejects(f.child(parent.id, "analysis", research.id, { requestId: "new-call-same-role" }), /different input/);
    await assert.rejects(f.child(parent.id, "research", undefined, { requestId: "new-call-same-role", text: "Changed alias input" }), /different input/);
    await assert.rejects(f.app.message({ requestId: "new-call-same-role", text: "Reused as root", workflow: f.workflow }), /different input/);
    const persisted = JSON.parse(readFileSync(join(f.directory, "state.json"), "utf8"));
    assert.deepEqual(persisted.tasks[research.id].workflowRequestAliases, ["new-call-same-role"]);
    await assert.rejects(f.child(parent.id, "research", undefined, { requestId: "conflict", text: "Different work" }), /different input/);
    await assert.rejects(f.child(parent.id, "analysis", research.id, { requestId: "request-research" }), /different input/);
    f.finish(parent);
    assert.equal((await f.child(parent.id, "research", undefined, { requestId: "terminal-retry" })).id, research.id);
    assert.equal(f.calls.length, 1); assert.equal(Object.keys(f.app.store.state.tasks).length, 2);
  } finally { await f.cleanup(); }
});

test("analysis and presentation depend only on this parent's research and run independently after its actual completion", async () => {
  const f = fixture();
  try {
    const parent = await f.admit(), research = await f.child(parent.id, "research");
    const other = f.app.store.createTask("unrelated", "other-chat", "mac", "Unrelated").task;
    const otherChat = f.app.store.addChat("Other", "mac", "other-thread"); other.chatId = otherChat.id;
    await assert.rejects(f.child(parent.id, "analysis", other.id), /exact research task/);
    await assert.rejects(f.child(parent.id, "analysis", research.id, { sourceChatIds: [otherChat.id] }), /only from its research/);
    const analysis = await f.child(parent.id, "analysis", research.id);
    const presentation = await f.child(parent.id, "presentation", research.id);
    assert.equal(analysis.status, "queued"); assert.equal(presentation.status, "queued"); assert.equal(f.calls.length, 1);
    assert.deepEqual(analysis.sourceChatIds, [research.chatId]);
    f.finish(parent, "task.completed", "Queued the assigned stages");
    assert.equal(f.app.task(parent.id).workflowStatus?.state, "waiting_research");
    assert.equal(f.app.task(parent.id).workflowStatus?.outputsReady, false);
    f.chats[0].history.push({ role: "assistant", text: "UNRELATED OLD HISTORY MUST NOT TRANSFER", taskId: "old-task" });
    f.finish(research, "task.completed", f.bundle(research, "Two sources and six researched facts"));
    assert.equal(analysis.status, "running"); assert.equal(presentation.status, "running"); assert.equal(f.calls.length, 3);
    for (const call of f.calls.slice(1)) {
      assert.match(call.params.text, /Two sources and six researched facts/); assert.ok(call.params.text.includes(research.id));
      assert.doesNotMatch(call.params.text, /UNRELATED OLD HISTORY/);
    }
    assert.ok(f.calls[0].params.text.includes(research.id));
    assert.match(f.calls[0].params.text, /ONLY one complete JSON fact bundle/);
    const audit = f.app.store.state.events.find((event) => event.type === "context.transferred" && event.taskId === analysis.id);
    assert.deepEqual(audit?.sourceChatIds, [research.chatId]);
    assert.equal(audit?.contextScope, "exact_workflow_fact_bundle");
    f.finish(analysis, "task.failed");
    assert.equal(presentation.status, "running");
    assert.equal(f.app.task(parent.id).workflowStatus?.state, "partial_failure");
    assert.equal(f.app.task(parent.id).workflowStatus?.outputsReady, false);
    f.finish(presentation);
    assert.equal(f.app.task(parent.id).workStatus, "failed");
    f.finish(research); assert.equal(f.calls.length, 3);
  } finally { await f.cleanup(); }
});

test("failed research blocks queued dependents and later dependent calls without replay", async () => {
  for (const queued of [false, true]) {
    const f = fixture();
    try {
      const parent = await f.admit(), research = await f.child(parent.id, "research");
      const siblings = queued ? [await f.child(parent.id, "analysis", research.id), await f.child(parent.id, "presentation", research.id)] : [];
      f.finish(research, "task.failed");
      if (!queued) {
        const count = Object.keys(f.app.store.state.tasks).length;
        await assert.rejects(f.child(parent.id, "analysis", research.id), /did not complete successfully/);
        assert.equal(Object.keys(f.app.store.state.tasks).length, count);
      }
      for (const sibling of siblings) assert.equal(sibling.status, "interrupted");
      assert.equal(f.app.task(parent.id).workflowStatus?.state, "partial_failure");
      await f.app.message(f.input);
      assert.equal(f.calls.length, 1); assert.equal(f.masters.length, 1);
    } finally { await f.cleanup(); }
  }
});

test("terminal parent with zero, one or two assigned roles is incomplete rather than a false completion", async () => {
  for (const count of [0, 1, 2]) {
    const f = fixture();
    try {
      const parent = await f.admit();
      const research = count ? await f.child(parent.id, "research") : undefined;
      if (research) f.finish(research);
      if (count === 2) f.finish(await f.child(parent.id, "analysis", research!.id));
      f.finish(parent, "task.completed", "All done, visibly verified");
      const status = f.app.task(parent.id).workflowStatus!;
      assert.equal(status.state, "partial_failure"); assert.equal(status.reasonCode, "required_role_not_started");
      assert.equal(status.requiredRolesCompleted, count); assert.equal(status.effectVerification, "not_verified");
      assert.equal(status.outputsReady, false);
      assert.equal(f.app.task(parent.id).workStatus, "interrupted");
    } finally { await f.cleanup(); }
  }
});

test("all three role completions expose authoritative published metadata without claiming visible effects", async () => {
  const f = fixture();
  try {
    const parent = await f.admit(), research = await f.child(parent.id, "research");
    const analysis = await f.child(parent.id, "analysis", research.id), presentation = await f.child(parent.id, "presentation", research.id);
    f.finish(research); f.finish(analysis); f.finish(presentation); f.finish(parent);
    assert.equal(f.app.task(parent.id).workflowStatus?.artifactsPublished, 0);
    assert.equal(f.app.task(parent.id).workflowStatus?.state, "completed");
    assert.equal(f.app.task(parent.id).workflowStatus?.outputsReady, false);
    for (const task of [research, analysis, presentation]) {
      const bytes = Buffer.from(`Verified bytes from ${task.workflowRole}`);
      f.app.artifacts.save(task, { path: `${task.workflowRole}.txt`, name: "ignored", mime: "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), base64: bytes.toString("base64") });
    }
    const status = f.app.task(parent.id).workflowStatus!;
    assert.equal(status.state, "completed"); assert.equal(status.requiredRolesCompleted, 3);
    assert.equal(status.artifactsPublished, 3); assert.equal(status.effectVerification, "not_verified");
    assert.equal(status.outputsReady, true);
    assert.equal(status.publishedArtifacts.length, 3);
    for (const artifact of status.publishedArtifacts) assert.equal(f.app.artifacts.content(artifact.id).bytes.length, artifact.size);
    assert.equal(f.app.task(parent.id).workStatus, "completed");
    const artifact = f.app.store.state.artifacts![status.publishedArtifacts[0].id];
    const original = { ...artifact };
    for (const patch of [{ taskId: "other-task" }, { deviceId: "wrong-device" }, { chatId: "wrong-chat" }, { size: 0 }, { sha256: "invalid-hash" }]) {
      Object.assign(artifact, patch);
      assert.equal(f.app.task(parent.id).workflowStatus?.outputsReady, false);
      Object.assign(artifact, original);
    }
    const expectedDependency = analysis.afterTaskId;
    analysis.afterTaskId = "other-research";
    assert.equal(f.app.task(parent.id).workflowStatus?.outputsReady, false);
    analysis.afterTaskId = expectedDependency;
    f.app.store.update(analysis.id, { status: "running" });
    assert.equal(f.app.task(parent.id).workflowStatus?.state, "running");
    assert.equal(f.app.task(parent.id).workflowStatus?.outputsReady, false);
    f.app.store.update(analysis.id, { status: "completed" });
    f.app.store.update(parent.id, { status: "cancelled" });
    assert.equal(f.app.task(parent.id).workflowStatus?.reasonCode, "parent_failed");
    assert.equal(f.app.task(parent.id).workflowStatus?.outputsReady, false);
  } finally { await f.cleanup(); }
});

test("legacy general requests and ordinary dependency dispatch do not acquire workflow capability requirements", async () => {
  const f = fixture();
  try {
    for (const device of f.devices) device.capabilities.browser = false;
    const parent = await f.app.message({ requestId: "general", text: "Ordinary work" }); await setImmediate();
    const child = await f.app.dispatch(f.chats[0].id, { requestId: "direct", text: "Write a file" }, parent.id);
    assert.equal(child.workflowRole, undefined); assert.equal(f.app.task(parent.id).workflowStatus, undefined);
    assert.equal(f.calls.length, 1);
  } finally { await f.cleanup(); }
});

test("HTTP messages retain the optional manifest and reject malformed manifests before admission", async () => {
  const f = fixture(), server = createHttpServer(f.app, f.config.clientToken);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const post = (body: unknown, route = "/v1/messages") => fetch(`http://127.0.0.1:${address.port}${route}`, { method: "POST",
      headers: { Authorization: `Bearer ${f.config.clientToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let dispatches = 0;
    const originalDispatch = f.app.dispatch.bind(f.app);
    f.app.dispatch = async (...args) => { dispatches++; return originalDispatch(...args); };
    const wrongRoute = await post(f.input, `/v1/chats/${f.chats[0].id}/messages`);
    assert.equal(wrongRoute.status, 409); assert.equal(dispatches, 0);
    assert.match((await wrongRoute.json() as any).error, /must use \/v1\/messages/);
    assert.equal(Object.keys(f.app.store.state.tasks).length, 0); assert.equal(f.calls.length, 0);
    const bad = await post({ ...f.input, workflow: { ...f.workflow, bindings: f.workflow.bindings.slice(0, 2) } });
    assert.equal(bad.status, 400); assert.equal(Object.keys(f.app.store.state.tasks).length, 0);
    const accepted = await post(f.input);
    assert.equal(accepted.status, 202);
    const body = await accepted.json() as any;
    assert.deepEqual(body.workflow, f.workflow);
    assert.equal(body.workflowStatus.state, "waiting_research");
    assert.equal(body.workflowStatus.effectVerification, "not_verified");
    assert.equal(f.calls.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve())); await f.cleanup();
  }
});

test("a queued role losing visible support fails before execution without stopping its sibling", async () => {
  const f = fixture();
  try {
    const parent = await f.admit(), research = await f.child(parent.id, "research");
    const analysis = await f.child(parent.id, "analysis", research.id), presentation = await f.child(parent.id, "presentation", research.id);
    f.devices[1].capabilities.browser = false;
    f.finish(research);
    assert.equal(analysis.status, "failed"); assert.equal(presentation.status, "running");
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].deviceId, "review");
    assert.equal(f.app.task(parent.id).workflowStatus?.state, "partial_failure");
  } finally { await f.cleanup(); }
});

test("invalid, oversized or wrong-origin research blocks both dependents without repairing or truncating text", async () => {
  for (const corrupt of [
    (_valid: string) => "The research is done.",
    (valid: string) => "```json\n" + valid + "\n```",
    (valid: string) => JSON.stringify({ ...JSON.parse(valid), origin: { ...JSON.parse(valid).origin, taskId: "other-task" } }),
    (valid: string) => JSON.stringify({ ...JSON.parse(valid), origin: { ...JSON.parse(valid).origin, deviceId: "other-device" } }),
    (valid: string) => JSON.stringify({ ...JSON.parse(valid), sources: [] }),
    (valid: string) => " ".repeat(2048) + valid,
  ]) {
    const f = fixture();
    try {
      const parent = await f.admit(), research = await f.child(parent.id, "research");
      const analysis = await f.child(parent.id, "analysis", research.id), presentation = await f.child(parent.id, "presentation", research.id);
      f.finish(research, "task.completed", corrupt(f.bundle(research)));
      assert.equal(analysis.status, "interrupted"); assert.equal(presentation.status, "interrupted");
      assert.match(analysis.error!, /complete valid fact bundle/);
      assert.equal(f.calls.length, 1);
      assert.equal(f.app.task(parent.id).workflowStatus?.outputsReady, false);
      assert.equal(f.app.store.state.events.filter((event) => event.type === "context.transferred").length, 0);
    } finally { await f.cleanup(); }
  }
});

test("verified local publication without a server ID remains unconfirmed until its exact registry record exists", async () => {
  const f = fixture();
  try {
    const parent = await f.admit(), research = await f.child(parent.id, "research");
    const analysis = await f.child(parent.id, "analysis", research.id), presentation = await f.child(parent.id, "presentation", research.id);
    const payload = (name: string) => {
      const bytes = Buffer.from(`${name} output bytes`);
      return { path: `${name}.txt`, name: `${name}.txt`, mime: "text/plain", size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"), base64: bytes.toString("base64") };
    };
    const local = payload("research");
    const facts = JSON.parse(f.bundle(research));
    facts.origin.artifact = { status: "publication_unconfirmed", path: local.path, size: local.size, sha256: local.sha256 };
    f.finish(research, "task.completed", JSON.stringify(facts));
    assert.equal(analysis.status, "running"); assert.equal(presentation.status, "running");
    assert.match(f.calls[0].params.text, /publication_unconfirmed/);
    assert.match(f.calls[0].params.text, /but no server artifact ID/);
    for (const child of [analysis, presentation]) { f.app.artifacts.save(child, payload(child.workflowRole!)); f.finish(child); }
    f.finish(parent);
    assert.equal(f.app.task(parent.id).workflowStatus?.outputsReady, false);
    const record = f.app.artifacts.save(research, local);
    assert.equal(f.app.task(parent.id).workflowStatus?.outputsReady, true);
    assert.equal(f.app.task(parent.id).workflowStatus?.effectVerification, "not_verified");
    const original = { ...record };
    for (const patch of [{ taskId: "wrong-task" }, { deviceId: "wrong-device" }, { chatId: "wrong-chat" },
      { path: "different.txt" }, { size: record.size + 1 }, { sha256: "b".repeat(64) }]) {
      Object.assign(record, patch);
      assert.equal(f.app.task(parent.id).workflowStatus?.outputsReady, false);
      Object.assign(record, original);
    }
    // A claimed server publication must match the actual ID and hash as well.
    facts.origin.artifact = { status: "published", id: record.id, sha256: record.sha256 };
    research.text = JSON.stringify(facts);
    assert.equal(f.app.task(parent.id).workflowStatus?.outputsReady, true);
    facts.origin.artifact.id = "invented-id";
    research.text = JSON.stringify(facts);
    assert.equal(f.app.task(parent.id).workflowStatus?.outputsReady, false);
  } finally { await f.cleanup(); }
});

test("a fabricated published artifact reference blocks dependent dispatch before any effect", async () => {
  const f = fixture();
  try {
    const parent = await f.admit(), research = await f.child(parent.id, "research");
    const analysis = await f.child(parent.id, "analysis", research.id), presentation = await f.child(parent.id, "presentation", research.id);
    const facts = JSON.parse(f.bundle(research));
    facts.origin.artifact = { status: "published", id: "invented-id", sha256: "a".repeat(64) };
    f.finish(research, "task.completed", JSON.stringify(facts));
    assert.equal(analysis.status, "interrupted"); assert.equal(presentation.status, "interrupted");
    assert.equal(f.calls.length, 1); assert.equal(f.app.task(parent.id).workflowStatus?.outputsReady, false);
  } finally { await f.cleanup(); }
});
