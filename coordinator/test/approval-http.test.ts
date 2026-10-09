import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator.js";
import { createHttpServer } from "../src/server.js";

test("typed decisions retain their exact source and response through HTTP and cannot replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-approval-http-"));
  const config = {
    clientToken: "c".repeat(64), localDeviceId: "mac", localDeviceName: "Mac",
    workspace: directory, devices: [{ id: "windows", name: "Windows", token: "w".repeat(64) }],
  };
  const app = new Coordinator(config, directory);
  const server = createHttpServer(app, config.clientToken);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const headers = { Authorization: `Bearer ${config.clientToken}`, "Content-Type": "application/json" };
  const post = (id: string, body: unknown, authenticated = true) => fetch(`${origin}/v1/approvals/${id}`, {
    method: "POST", headers: authenticated ? headers : { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const calls: { deviceId: string; method: string; params: any }[] = [];
  app.devices.call = async (deviceId, method, params) => {
    calls.push({ deviceId, method, params });
    return { resolved: true };
  };
  try {
    const cases = [
      { id: "form", method: "mcpServer/elicitation/request",
        details: { threadId: "provider-thread", kind: "elicitation", mode: "form", persistenceModes: ["session"], requestedSchema: { type: "object", properties: {} } },
        response: { kind: "elicitation", action: "accept", content: {}, _meta: { persist: "session" } } },
      { id: "permission", method: "item/permissions/requestApproval",
        details: { threadId: "provider-thread", permissions: { network: { enabled: true }, fileSystem: null } },
        response: { kind: "permissions", permissions: { network: { enabled: true } }, scope: "turn" } },
    ];
    for (const fixture of cases) {
      const task = app.store.createTask(fixture.id, `chat-${fixture.id}`, "windows", "Fixture").task;
      app.event("windows", { type: "approval.requested", taskId: task.id, approvalId: fixture.id,
        providerRequestId: 41, method: fixture.method, details: fixture.details });
      assert.equal(app.store.state.approvals[fixture.id].providerRequestId, 41);
      assert.equal((await post(fixture.id, { response: fixture.response }, false)).status, 401);
      assert.equal((await post(fixture.id, { decision: "accept", response: fixture.response })).status, 400);
      assert.equal((await post(fixture.id, {})).status, 400);
      if (fixture.id === "form")
        assert.equal((await post(fixture.id, { response: { ...fixture.response, _meta: { receipt: "fixture" } } })).status, 400);
      assert.equal(calls.length, fixture.id === "form" ? 0 : 1);
      assert.equal((await post(fixture.id, { response: fixture.response })).status, 200);
      assert.deepEqual(calls.at(-1), { deviceId: "windows", method: "approval.resolve", params: {
        approvalId: fixture.id, decision: undefined, answers: undefined, response: fixture.response,
      } });
      assert.equal((await post(fixture.id, { response: fixture.response })).status, 409);
    }
    assert.equal(calls.length, 2);

    const task = app.store.createTask("resolved", "chat-resolved", "windows", "Fixture").task;
    app.event("windows", { type: "approval.requested", taskId: task.id, approvalId: "already-resolved", providerRequestId: "request-2", method: "mcpServer/elicitation/request", details: {} });
    const unrelated = app.store.createTask("unrelated", "chat-unrelated", "windows", "Fixture").task;
    app.event("windows", { type: "approval.resolved", taskId: unrelated.id, approvalId: "already-resolved" });
    assert.equal(app.store.state.approvals["already-resolved"].status, "pending");
    app.event("windows", { type: "approval.resolved", taskId: task.id, approvalId: "already-resolved", providerRequestId: "request-2" });
    assert.equal((await post("already-resolved", { response: { kind: "elicitation", action: "decline" } })).status, 409);
    assert.equal(calls.length, 2);

    const other = app.store.createTask("other", "chat-other", "mac", "Fixture").task;
    app.event("mac", { type: "approval.requested", taskId: other.id, approvalId: "form", method: "item/commandExecution/requestApproval", details: {} });
    assert.equal(app.store.state.approvals.form.deviceId, "windows");
    assert.equal(app.store.state.approvals.form.status, "resolved");
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("answering the last decision resumes its task even when the host never echoes the resolution", async () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-approval-resume-"));
  const config = {
    clientToken: "c".repeat(64), localDeviceId: "mac", localDeviceName: "Mac",
    workspace: directory, devices: [{ id: "windows", name: "Windows", token: "w".repeat(64) }],
  };
  const app = new Coordinator(config, directory);
  // A companion killed between resolving and forwarding answers exactly like this.
  app.devices.call = async () => ({ resolved: true });
  app.devices.online = () => true;
  const request = (taskId: string, approvalId: string) =>
    app.event("windows", { type: "approval.requested", taskId, approvalId,
      method: "item/commandExecution/requestApproval", details: {} });
  try {
    const chat = app.store.addChat("Project", "windows", "thread-project");
    const task = app.store.createTask("work", chat.id, "windows", "Do useful work").task;
    app.store.update(task.id, { status: "running" });
    request(task.id, "first");
    request(task.id, "second");
    assert.equal(app.task(task.id).status, "needs_input");
    await app.approval("first", "accept");
    assert.equal(app.store.state.approvals.first.status, "resolved");
    assert.equal(app.task(task.id).status, "needs_input", "a still-open decision keeps the task waiting");
    await app.approval("second", "accept");
    assert.equal(app.task(task.id).status, "running", "an answered task must not wait on a lost echo");

    const finished = app.store.createTask("finished", "chat-finished", "windows", "Other work").task;
    app.store.update(finished.id, { status: "running" });
    request(finished.id, "late");
    // The terminal write bypasses the coordinator so the decision is still pending.
    app.store.update(finished.id, { status: "completed" });
    await assert.rejects(app.approval("late", "accept"), /no longer active/);
    assert.equal(app.task(finished.id).status, "completed", "a finished task must not be resurrected");
  } finally {
    app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
