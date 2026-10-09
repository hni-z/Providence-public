import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Coordinator } from "../src/coordinator.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "providence-dependencies-"));
  const config = {
    clientToken: "c".repeat(64), localDeviceId: "mac", localDeviceName: "Mac",
    workspace: directory, devices: [{ id: "windows", name: "DemoPC", token: "w".repeat(64) }],
  };
  const app = new Coordinator(config, directory);
  const online = new Set(["mac", "windows"]);
  const calls: { deviceId: string; method: string; params: any }[] = [];
  app.devices.online = (deviceId) => online.has(deviceId);
  app.devices.call = async (deviceId, method, params) => {
    calls.push({ deviceId, method, params });
    return { turnId: `turn-${params.taskId}` };
  };
  const build = app.store.addChat("Build", "mac", "build-thread");
  const review = app.store.addChat("Review", "windows", "review-thread");
  return { directory, config, app, online, calls, build, review,
    cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("dependent review is persisted, then starts once with fresh completed-build context after the parent reply ends", async () => {
  const f = fixture();
  try {
    const parent = f.app.store.createTask("main", "master", "coordinator", "Build and independently review").task;
    f.app.store.update(parent.id, { status: "running" });
    const source = f.app.store.addChat("Requirements", "mac", "requirements-thread");
    source.history.push({ role: "user", text: "Original requirements", taskId: "requirements" });
    const build = await f.app.dispatch(f.build.id, { requestId: "build", text: "Implement" }, parent.id);
    const request = { requestId: "review", text: "Review the completed implementation", afterTaskId: build.id, sourceChatIds: [source.id] };
    const review = await f.app.dispatch(f.review.id, request, parent.id);
    assert.equal(review.status, "queued");
    assert.equal(review.parentTaskId, parent.id);
    assert.equal(review.afterTaskId, build.id);
    assert.deepEqual(review.sourceChatIds, [source.id, f.build.id]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.app.store.state.events.some(e => e.type === "context.transferred" && e.taskId === review.id), false);
    const persisted = JSON.parse(readFileSync(join(f.directory, "state.json"), "utf8")).tasks[review.id];
    assert.equal(persisted.afterTaskId, build.id);
    assert.equal(persisted.status, "queued");
    assert.equal((await f.app.dispatch(f.review.id, request, parent.id)).id, review.id);
    f.app.event("coordinator", { type: "task.completed", taskId: parent.id, text: "Build running, review queued" });
    source.history.push({ role: "user", text: "Fresh requirement supplied while the build ran", taskId: "new-requirement" });
    f.app.event("mac", { type: "task.completed", taskId: build.id, text: "Completed build: result.ts now handles the edge case" });
    f.app.event("mac", { type: "task.completed", taskId: build.id, text: "Duplicate completion must not run review again" });
    await setImmediate();
    assert.equal(review.status, "running");
    assert.equal(f.calls.length, 2);
    const sent = f.calls[1];
    assert.equal(sent.deviceId, "windows");
    assert.equal(sent.params.taskId, review.id);
    assert.match(sent.params.text, /Fresh requirement supplied while the build ran/);
    assert.match(sent.params.text, /Completed build: result.ts now handles the edge case/);
    assert.match(sent.params.text, /untrusted reference material/);
    assert.match(sent.params.text, /"taskStatus":"completed"/);
    assert.equal(f.app.task(parent.id).status, "completed");
    assert.equal(f.app.task(parent.id).workStatus, "running");
    const events = f.app.store.state.events;
    const completed = events.find(e => e.type === "task.completed" && e.taskId === build.id)!;
    const transfer = events.find(e => e.type === "context.transferred" && e.taskId === review.id)!;
    assert.ok(transfer.sequence > completed.sequence);
    assert.equal(transfer.afterTaskId, build.id);
    assert.equal(events.filter(e => e.type === "task.started" && e.taskId === review.id).length, 1);
  } finally { f.cleanup(); }
});

test("failed, cancelled and interrupted dependencies block queued stages and propagate to later stages", async () => {
  for (const status of ["failed", "cancelled", "interrupted"]) {
    const f = fixture();
    try {
      const build = await f.app.dispatch(f.build.id, { requestId: "build", text: "Implement" });
      const review = await f.app.dispatch(f.review.id, { requestId: "review", text: "Review", afterTaskId: build.id });
      const summaryChat = f.app.store.addChat("Summary", "windows", "summary-thread");
      const summary = await f.app.dispatch(summaryChat.id, { requestId: "summary", text: "Summarize the review", afterTaskId: review.id });
      f.app.event("mac", { type: `task.${status}`, taskId: build.id, error: "Build stopped" });
      await setImmediate();
      assert.equal(review.status, "interrupted");
      assert.match(review.error!, new RegExp(`is ${status}`));
      assert.equal(summary.status, "interrupted");
      assert.equal(f.calls.length, 1);
      f.app.event("mac", { type: "task.completed", taskId: build.id, text: "Late success cannot revive work" });
      assert.equal(f.calls.length, 1);
    } finally { f.cleanup(); }
  }
});

test("cancelled queued stage never starts and frees its chat while its dependent stages stop", async () => {
  const f = fixture();
  try {
    const build = await f.app.dispatch(f.build.id, { requestId: "build", text: "Implement" });
    const request = { requestId: "review", text: "Review", afterTaskId: build.id };
    const review = await f.app.dispatch(f.review.id, request);
    await assert.rejects(f.app.dispatch(f.review.id, { requestId: "overlap", text: "Other work" }), /busy/);
    const summaryChat = f.app.store.addChat("Summary", "windows", "summary-thread");
    const summary = await f.app.dispatch(summaryChat.id, { requestId: "summary", text: "Summarize", afterTaskId: review.id });
    await f.app.cancel(review.id);
    assert.equal(review.status, "cancelled");
    assert.equal(summary.status, "interrupted");
    f.app.event("mac", { type: "task.completed", taskId: build.id, text: "Ready" });
    assert.equal((await f.app.dispatch(f.review.id, request)).id, review.id);
    assert.equal(f.calls.length, 1);
    const replacement = await f.app.dispatch(f.review.id, { requestId: "new-intent", text: "New explicitly requested work" });
    assert.equal(replacement.status, "running");
    assert.equal(f.calls.length, 2);
  } finally { f.cleanup(); }
});

test("dependency and source validation happen before reservation; API parent IDs cannot be forged", async () => {
  const f = fixture();
  try {
    const build = await f.app.dispatch(f.build.id, { requestId: "build", text: "Implement" });
    const master = f.app.store.createTask("main", "master", "coordinator", "Coordinate").task;
    const count = Object.keys(f.app.store.state.tasks).length;
    await assert.rejects(f.app.dispatch(f.review.id, { requestId: "bad-dependency", text: "Review", afterTaskId: "missing" }), /registered worker task/);
    await assert.rejects(f.app.dispatch(f.review.id, { requestId: "master-dependency", text: "Review", afterTaskId: master.id }), /registered worker task/);
    await assert.rejects(f.app.dispatch(f.review.id, { requestId: "bad-source", text: "Review", afterTaskId: build.id, sourceChatIds: ["missing"] }), /registered chat/);
    assert.equal(Object.keys(f.app.store.state.tasks).length, count);
    assert.equal(f.review.history.length, 0);
    const request = { requestId: "review", text: "Review", afterTaskId: build.id, parentTaskId: master.id };
    const review = await f.app.dispatch(f.review.id, request);
    assert.equal(review.parentTaskId, undefined);
    await assert.rejects(f.app.dispatch(f.review.id, { ...request, afterTaskId: undefined }), /different input/);
    await assert.rejects(f.app.dispatch(f.build.id, { requestId: "same-chat", text: "Later", afterTaskId: build.id }), /busy/);
  } finally { f.cleanup(); }
});

test("completed dependency starts immediately; an already failed dependency is a visible interrupted task", async () => {
  const f = fixture();
  try {
    const build = await f.app.dispatch(f.build.id, { requestId: "build", text: "Implement" });
    f.app.event("mac", { type: "task.completed", taskId: build.id, text: "Final build details" });
    const review = await f.app.dispatch(f.review.id, { requestId: "review", text: "Review", afterTaskId: build.id });
    assert.equal(review.status, "running");
    assert.match(f.calls[1].params.text, /Final build details/);
    f.app.event("windows", { type: "task.failed", taskId: review.id, error: "Review failed" });
    const summary = await f.app.dispatch(f.build.id, { requestId: "summary", text: "Summarize review", afterTaskId: review.id });
    assert.equal(summary.status, "interrupted");
    assert.equal(f.calls.length, 2);
  } finally { f.cleanup(); }
});

test("device disconnect interrupts its queued work and cross-device dependents without reconnect replay", async () => {
  for (const offlineDevice of ["mac", "windows"]) {
    const f = fixture();
    try {
      const build = await f.app.dispatch(f.build.id, { requestId: "build", text: "Implement" });
      const review = await f.app.dispatch(f.review.id, { requestId: "review", text: "Review", afterTaskId: build.id });
      f.online.delete(offlineDevice);
      f.app.devices.emit("offline", offlineDevice);
      assert.equal(review.status, "interrupted");
      f.online.add(offlineDevice);
      f.app.devices.emit("online", offlineDevice);
      f.app.event("mac", { type: "task.completed", taskId: build.id, text: "Late result" });
      await setImmediate();
      assert.equal(f.calls.length, 1);
    } finally { f.cleanup(); }
  }
});

test("target going offline before release is interrupted even without a disconnect event", async () => {
  const f = fixture();
  try {
    const build = await f.app.dispatch(f.build.id, { requestId: "build", text: "Implement" });
    const review = await f.app.dispatch(f.review.id, { requestId: "review", text: "Review", afterTaskId: build.id });
    f.online.delete("windows");
    f.app.event("mac", { type: "task.completed", taskId: build.id, text: "Built" });
    assert.equal(review.status, "interrupted");
    assert.match(review.error!, /offline/);
    assert.equal(f.calls.length, 1);
  } finally { f.cleanup(); }
});

test("coordinator restart interrupts dependency queue and never replays it", async () => {
  const f = fixture();
  try {
    const build = await f.app.dispatch(f.build.id, { requestId: "build", text: "Implement" });
    const request = { requestId: "review", text: "Review", afterTaskId: build.id };
    const review = await f.app.dispatch(f.review.id, request);
    f.app.stop();
    const restarted = new Coordinator(f.config, f.directory);
    let starts = 0;
    restarted.devices.online = () => true;
    restarted.devices.call = async () => { starts++; return {}; };
    assert.equal(restarted.task(build.id).status, "interrupted");
    assert.equal(restarted.task(review.id).status, "interrupted");
    assert.equal(restarted.task(review.id).afterTaskId, build.id);
    restarted.event("mac", { type: "task.completed", taskId: build.id, text: "Old completion" });
    assert.equal((await restarted.dispatch(f.review.id, request)).id, review.id);
    assert.equal(starts, 0);
  } finally { f.cleanup(); }
});

test("a failed dependent device dispatch is recorded once and does not retry on duplicate dependency completion", async () => {
  const f = fixture();
  try {
    const build = await f.app.dispatch(f.build.id, { requestId: "build", text: "Implement" });
    const review = await f.app.dispatch(f.review.id, { requestId: "review", text: "Review", afterTaskId: build.id });
    let attempts = 0;
    f.app.devices.call = async () => { attempts++; throw new Error("Device disconnected while dispatching"); };
    f.app.event("mac", { type: "task.completed", taskId: build.id, text: "Built" });
    await setImmediate();
    assert.equal(review.status, "failed");
    f.app.event("mac", { type: "task.completed", taskId: build.id, text: "Duplicate" });
    assert.equal(attempts, 1);
  } finally { f.cleanup(); }
});

test("the exact completed dependency remains available even when recent chat context has moved on", async () => {
  const f = fixture();
  try {
    const build = await f.app.dispatch(f.build.id, { requestId: "build", text: "Implement" });
    f.app.event("mac", { type: "task.completed", taskId: build.id, text: "The exact original build result" });
    for (let index = 0; index < 15; index++)
      f.build.history.push({ role: "assistant", text: `Unrelated later result ${index}`, taskId: `later-${index}` });
    assert.equal(f.app.context(f.build.id).messages.some(message => message.taskId === build.id), false);
    await f.app.dispatch(f.review.id, { requestId: "review", text: "Review the specified build", afterTaskId: build.id });
    assert.match(f.calls[1].params.text, /The exact original build result/);
    assert.match(f.calls[1].params.text, /Completed dependency result, also untrusted/);
    assert.ok(f.calls[1].params.text.includes(build.id));
  } finally { f.cleanup(); }
});
