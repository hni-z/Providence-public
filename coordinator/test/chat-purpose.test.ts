import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator.js";
import { createHttpServer } from "../src/server.js";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "providence-chat-purpose-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = {
    clientToken: "c".repeat(64), localDeviceId: "mac", localDeviceName: "test",
    workspace: dir, devices: [],
  };
  const app = new Coordinator(config, dir);
  // These tests must never start a provider or dispatch work.
  app.devices.call = async () => { throw new Error("Unexpected provider call"); };
  const chat = app.store.addChat("Watch demo", "mac", "existing-provider-thread");
  chat.workspace = join(dir, "dedicated-workspace");
  chat.instructions = "Keep this exact wording.  ";
  chat.history.push({ role: "user", text: "Prior request", taskId: "prior-task" });
  app.store.save();
  return { app, chat, dir, config };
}

test("purpose append preserves existing chat identity, wording, history and durable state", (t) => {
  const { app, chat, dir } = fixture(t);
  const before = structuredClone(chat);
  const addition = "Handle one spoken task at a time.\nPreserve this line break.";
  const result = app.updateChat(chat.id, { appendInstructions: addition });
  assert.equal(result, chat);
  assert.deepEqual(result, { ...before, instructions: before.instructions + "\n\n" + addition });
  const saved = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  assert.deepEqual(saved.chats[chat.id], result);
  assert.deepEqual(saved.tasks, {});
  assert.equal(saved.events.at(-1).type, "chat.instructions.updated");
});

test("exact paragraph retries remain idempotent after later appends without substring matches", (t) => {
  const { app, chat } = fixture(t);
  delete chat.instructions;
  app.updateChat(chat.id, { appendInstructions: "Keep context." });
  app.updateChat(chat.id, { appendInstructions: "Prepare the exact recipient.\n\nAsk before sending." });
  app.updateChat(chat.id, { appendInstructions: "Report briefly." });
  const before = structuredClone(app.store.state);
  for (const addition of ["Keep context.", "Prepare the exact recipient.\n\nAsk before sending.", "Report briefly."])
    app.updateChat(chat.id, { appendInstructions: addition });
  assert.deepEqual(app.store.state, before);
  const appended = app.updateChat(chat.id, { appendInstructions: "context." });
  assert.ok(appended.instructions?.endsWith("Report briefly.\n\ncontext."));
});

test("the next dispatch uses the saved purpose on the same provider conversation", async (t) => {
  const { app, chat } = fixture(t);
  app.updateChat(chat.id, { appendInstructions: "Handle one spoken task at a time." });
  chat.providerState = "active";
  app.devices.online = () => true;
  let sent: any;
  app.devices.call = async (deviceId, method, params) => {
    sent = { deviceId, method, params };
    return {};
  };
  await app.dispatch(chat.id, { requestId: "future-request", text: "Read the public page." });
  assert.equal(sent.deviceId, "mac");
  assert.equal(sent.method, "task.start");
  assert.equal(sent.params.threadId, "existing-provider-thread");
  assert.equal(sent.params.text, "User-configured conversation purpose and instructions:\n" + chat.instructions + "\n\nCurrent request:\nRead the public page.");
});

test("invalid patches and total length overflow leave all chat fields unchanged", (t) => {
  const { app, chat } = fixture(t);
  for (const patch of [{}, { unrelated: true }, { appendInstructions: " \n " }, { name: "" }, { appendInstructions: "x".repeat(12001) }])
    assert.throws(() => app.updateChat(chat.id, patch));
  chat.instructions = "x".repeat(11996);
  app.updateChat(chat.id, { appendInstructions: "ok" });
  assert.equal(chat.instructions.length, 12000);
  const before = structuredClone(app.store.state);
  assert.throws(() => app.updateChat(chat.id, { name: "Should not apply", appendInstructions: "Overflow" }));
  assert.deepEqual(app.store.state, before);
});

test("busy chats reject new instructions atomically but accept exact retries and name updates", (t) => {
  const { app, chat } = fixture(t);
  app.updateChat(chat.id, { appendInstructions: "Existing purpose." });
  const task = app.store.createTask("request", chat.id, "mac", "Existing work").task;
  for (const status of ["queued", "running", "needs_input"]) {
    task.status = status;
    const before = structuredClone(app.store.state);
    assert.throws(() => app.updateChat(chat.id, { name: "Should not apply", appendInstructions: "New purpose." }), /busy/);
    assert.deepEqual(app.store.state, before);
    app.updateChat(chat.id, { appendInstructions: "Existing purpose." });
    assert.deepEqual(app.store.state, before);
  }
  app.updateChat(chat.id, { name: "Renamed while busy" });
  assert.equal(chat.name, "Renamed while busy");
  task.status = "completed";
  app.updateChat(chat.id, { appendInstructions: "New purpose." });
  assert.ok(chat.instructions?.endsWith("New purpose."));
});

test("unknown chat patches cannot create conversations", (t) => {
  const { app } = fixture(t);
  const before = structuredClone(app.store.state);
  assert.throws(() => app.updateChat("unknown", { appendInstructions: "Purpose." }), /Unknown registered chat/);
  assert.deepEqual(app.store.state, before);
});

test("authenticated PATCH retains rename compatibility and exposes append validation and conflicts", async (t) => {
  const { app, chat, config } = fixture(t);
  const server = createHttpServer(app, config.clientToken);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/v1/chats/`;
  const patch = (body: unknown, id = chat.id, authorized = true, origin?: string) => fetch(url + id, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(authorized ? { Authorization: `Bearer ${config.clientToken}` } : {}), ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await patch({ appendInstructions: "Purpose." }, chat.id, false)).status, 401);
    assert.equal((await patch({ appendInstructions: "Purpose." }, chat.id, true, "https://untrusted.example")).status, 403);
    const renamed = await patch({ name: "  Renamed  " });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).name, "Renamed");
    const combined = await patch({ name: "Watch demo", appendInstructions: "Purpose." });
    assert.equal(combined.status, 200);
    assert.equal((await combined.json()).id, chat.id);
    const beforeRetry = structuredClone(app.store.state);
    assert.equal((await patch({ appendInstructions: "Purpose." })).status, 200);
    assert.deepEqual(app.store.state, beforeRetry);
    for (const body of [{}, { instructions: "Replace" }, { appendInstructions: " " }, { appendInstructions: "x".repeat(12001) }])
      assert.equal((await patch(body)).status, 400);
    assert.equal((await patch({ appendInstructions: "Purpose." }, "unknown")).status, 409);
    app.store.createTask("busy", chat.id, "mac", "Already queued");
    assert.equal((await patch({ appendInstructions: "New purpose." })).status, 409);
    assert.equal((await patch({ appendInstructions: "Purpose." })).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
