import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "providence-updates-"));
  const app = new Coordinator({ clientToken: "c".repeat(64), localDeviceId: "mac", localDeviceName: "MacBook", workspace: directory, devices: [] }, directory);
  const parent = app.store.createTask("parent", "master", "coordinator", "Coordinate the requested work").task;
  app.store.update(parent.id, { status: "completed", text: "The worker is waiting for permission." });
  parent.updatedAt = "2000-01-01T00:00:00.000Z";
  const chat = app.store.addChat("Exact saved chat name", "mac", "provider-thread");
  const child = app.store.createTask("child", chat.id, "mac", "Do the requested work").task;
  child.parentTaskId = parent.id;
  app.store.update(child.id, { status: "running" });
  return { app, parent, child, directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("parent exposes the final child response without rewriting its earlier reply or saved state", () => {
  const f = fixture();
  try {
    f.app.event("mac", { type: "task.completed", taskId: f.child.id, text: "Observed the requested result." });
    const before = readFileSync(join(f.directory, "state.json"), "utf8");
    const parent = f.app.task(f.parent.id);
    assert.equal(parent.text, "The worker is waiting for permission.");
    assert.equal(parent.workStatus, "completed");
    assert.equal(parent.hasNewerChildUpdates, true);
    assert.equal(parent.childUpdateCount, 1);
    assert.equal(parent.childUpdates![0].text, "Observed the requested result.");
    assert.equal(parent.childUpdates![0].chatName, "Exact saved chat name");
    assert.equal(parent.childUpdates![0].deviceName, "MacBook");
    assert.equal(parent.childUpdates![0].hasLiveText, false);
    assert.equal(parent.childUpdates![0].progress.kind, "result");
    assert.equal(parent.latestChildUpdateAt, f.child.updatedAt);
    assert.equal(readFileSync(join(f.directory, "state.json"), "utf8"), before);
  } finally { f.cleanup(); }
});

test("live message boundaries and newer tool or permission state reach the parent without token disk writes", () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.directory, "state.json"), "utf8");
    f.app.event("mac", { type: "text.delta", taskId: f.child.id, itemId: "one", text: "Opening the app." });
    f.app.event("mac", { type: "text.delta", taskId: f.child.id, itemId: "two", text: "Checking the form." });
    assert.equal(f.app.task(f.child.id).text, "Opening the app.\n\nChecking the form.");
    assert.equal(f.app.task(f.parent.id).childUpdates![0].progress.text, "Checking the form.");
    assert.equal(readFileSync(join(f.directory, "state.json"), "utf8"), before);
    f.app.event("mac", { type: "tool.started", taskId: f.child.id, item: { id: "tool", type: "mcpToolCall", server: "cua_repl", tool: "js" } });
    assert.equal(f.app.task(f.child.id).progress!.text, "Using Computer Use");
    f.app.event("mac", { type: "approval.requested", taskId: f.child.id, approvalId: "approval", method: "mcpServer/elicitation/request", details: { message: "Allow this app?" } });
    assert.equal(f.app.task(f.parent.id).workStatus, "needs_input");
    assert.equal(f.app.task(f.parent.id).childUpdates![0].progress.text, "Allow this app?");
    f.app.event("mac", { type: "approval.resolved", taskId: f.child.id, approvalId: "approval", requestedPersistence: "session" });
    assert.equal(f.app.store.state.approvals.approval.requestedPersistence, "session");
    f.app.event("mac", { type: "task.completed", taskId: f.child.id, text: "No action was performed." });
    const child = f.app.task(f.parent.id).childUpdates![0];
    assert.equal(child.text, "No action was performed.");
    assert.equal(child.hasLiveText, false);
    assert.equal(child.progress.text, "Agent response ready");
  } finally { f.cleanup(); }
});

test("parent only marks a genuinely newer child update and returns newest-first bounded excerpts", () => {
  const f = fixture();
  try {
    f.parent.updatedAt = "2099-01-01T00:00:00.000Z";
    assert.equal(f.app.task(f.parent.id).hasNewerChildUpdates, false);
    f.parent.updatedAt = "2000-01-01T00:00:00.000Z";
    for (let index = 0; index < 22; index++) {
      const task = f.app.store.createTask(`extra-${index}`, `chat-${index}`, "mac", "Fixture").task;
      task.parentTaskId = f.parent.id;
      task.status = "completed";
      task.text = "x".repeat(13000) + `ending-${index}`;
      task.artifacts = Array.from({ length: 25 }, (_, item) => ({ id: `artifact-${index}-${item}`, taskId: task.id, chatId: task.chatId, deviceId: "mac", path: `file-${item}.txt`, name: `file-${item}.txt`, mime: "text/plain", size: 0, sha256: "a".repeat(64), revision: 1, createdAt: task.createdAt }));
      task.updatedAt = `2090-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`;
    }
    const parent = f.app.task(f.parent.id);
    assert.equal(parent.childUpdateCount, 23);
    assert.equal(parent.childUpdatesTruncated, true);
    assert.equal(parent.childUpdates!.length, 20);
    assert.equal(parent.childUpdates![0].updatedAt, "2090-01-22T00:00:00.000Z");
    assert.ok(parent.childUpdates!.every(child => child.text.length <= 12000));
    assert.equal(parent.childUpdates![0].textTruncated, true);
    assert.match(parent.childUpdates![0].text, /ending-21$/);
    assert.equal(parent.childUpdates![0].artifactCount, 25);
    assert.equal(parent.childUpdates![0].artifactsTruncated, true);
    assert.equal(parent.childUpdates![0].artifacts!.length, 20);
    parent.childUpdates![0].artifacts![0].name = "Changed only in the view";
    assert.equal(f.app.store.state.tasks[parent.childUpdates![0].id].artifacts![5].name, "file-5.txt");
  } finally { f.cleanup(); }
});

test("streamed tool output reaches the progress label without touching the state file", () => {
  const f = fixture();
  try {
    const file = join(f.directory, "state.json");
    const before = readFileSync(file, "utf8");
    const sequence = f.app.store.state.sequence;
    for (let index = 0; index < 1000; index++)
      f.app.event("mac", { type: "tool.output", taskId: f.child.id, item: { id: "cmd", type: "commandExecution" }, output: "x".repeat(16 * 1024) });
    assert.equal(f.app.store.state.sequence, sequence);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.ok(statSync(file).size < 3_000_000, "streamed output must not enter the snapshot");
    assert.equal(f.app.task(f.child.id).progress!.text, "Running a command");
  } finally { f.cleanup(); }
});

test("retained tool events are bounded by bytes, not only by count", () => {
  const f = fixture();
  try {
    for (let index = 0; index < 200; index++)
      f.app.event("mac", { type: "tool.completed", taskId: f.child.id, item: { id: `cmd-${index}`, type: "commandExecution", status: "completed" }, output: "x".repeat(16 * 1024) });
    const events = f.app.store.state.events;
    assert.ok(events.length < 200, "the oldest large events must be dropped");
    assert.equal(events.at(-1)!.item.id, "cmd-199");
    assert.ok(statSync(join(f.directory, "state.json")).size < 3_000_000);
  } finally { f.cleanup(); }
});

test("a very long final reply is clamped in the task, the chat history and the event", () => {
  const f = fixture();
  try {
    f.app.event("mac", { type: "task.completed", taskId: f.child.id, text: "r".repeat(900 * 1024) + "measured ending" });
    const stored = f.app.store.state.tasks[f.child.id].text;
    assert.equal(stored.length, 30000);
    assert.ok(stored.endsWith("measured ending"));
    assert.equal(f.app.store.state.chats[f.child.chatId].history.at(-1)!.text, stored);
    assert.equal(f.app.store.state.events.at(-1)!.text, stored);
    assert.ok(statSync(join(f.directory, "state.json")).size < 200_000);
  } finally { f.cleanup(); }
});

test("the task list stays fast with many tasks and a full event ring", () => {
  const f = fixture();
  try {
    for (let index = 0; index < 299; index++) {
      const chat = f.app.store.addChat(`chat-${index}`, "mac", `thread-${index}`);
      const task = f.app.store.createTask(`extra-${index}`, chat.id, "mac", "Fixture").task;
      task.parentTaskId = f.parent.id;
      task.status = index % 3 === 0 ? "running" : "completed";
      task.text = "y".repeat(500);
    }
    for (let index = 0; index < 1000; index++)
      f.app.store.state.events.push({ sequence: index + 1, at: new Date().toISOString(), type: "tool.output", taskId: f.parent.id, deviceId: "mac", item: { id: `cmd-${index}`, type: "commandExecution" }, output: "z".repeat(200) });
    for (let index = 0; index < 10; index++) f.app.tasks();
    const start = process.hrtime.bigint();
    for (let index = 0; index < 20; index++) f.app.tasks();
    const perCall = Number(process.hrtime.bigint() - start) / 1e6 / 20;
    console.log(`task list: ${perCall.toFixed(2)} ms per call at ${Object.keys(f.app.store.state.tasks).length} tasks`);
    // A generous bound: the read path is index-bound now, so a return to per-task ring scans still fails here.
    assert.ok(perCall < 50, `task list took ${perCall.toFixed(2)} ms per call`);
  } finally { f.cleanup(); }
});
