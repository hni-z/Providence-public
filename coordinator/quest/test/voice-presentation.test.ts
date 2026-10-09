import { test } from "node:test";
import assert from "node:assert/strict";
import { voicePresentation } from "../src/voice-presentation";
import type { ChildTaskUpdate, Snapshot, Task } from "../src/types";

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "accepted-voice-task", chatId: "master", deviceId: "coordinator", status: "completed",
  prompt: "The deliberately accepted request", text: "  Exact response text.\n", createdAt: "2026-09-20T09:00:00Z", updatedAt: "2026-09-20T09:01:00Z", ...overrides,
});
const child = (overrides: Partial<ChildTaskUpdate> = {}): ChildTaskUpdate => ({
  id: "actual-child", chatId: "demoPC-work", chatName: "Windows work", deviceId: "demoPC", deviceName: "DemoPC",
  status: "completed", text: "  Exact child output.\n", updatedAt: "2026-09-20T09:02:00Z", hasLiveText: false, ...overrides,
});
const snapshot = (...tasks: Task[]): Snapshot => ({ tasks, chats: [], approvals: [], devices: [{ id: "demoPC", name: "Actual DemoPC", online: true }] });

test("idle has a placeholder, no fabricated transcript, and no history-derived response", () => {
  const view = voicePresentation({ snapshot: snapshot(task()), chatId: "master" });
  assert.equal(view.state, "idle"); assert.equal(view.response, undefined);
  assert.equal(view.transcript, ""); assert.equal(view.transcriptPlaceholder, "Your transcript will appear here.");
});

test("capture/transcription states report activity without inventing interim text", () => {
  const capturing = voicePresentation({ snapshot: snapshot(), chatId: "master", capturing: true });
  assert.equal(capturing.state, "capturing"); assert.equal(capturing.status, "Listening…");
  assert.equal(capturing.transcript, ""); assert.match(capturing.transcriptPlaceholder, /after capture finishes/);
  const transcribing = voicePresentation({ snapshot: snapshot(), chatId: "master", transcribing: true });
  assert.equal(transcribing.state, "transcribing"); assert.equal(transcribing.transcript, "");
  assert.match(transcribing.transcriptPlaceholder, /Waiting for the recorded transcript/);
});

test("transcript and exact accepted response text remain unchanged", () => {
  const accepted = task();
  const transcript = "  User’s exact final phrase.\n";
  const view = voicePresentation({ snapshot: snapshot(accepted), taskId: accepted.id, chatId: "master", transcript });
  assert.equal(view.transcript, transcript); assert.equal(view.state, "completed");
  assert.deepEqual(view.response, { taskId: accepted.id, deviceId: "coordinator", text: accepted.text });
});

test("wrong chat or missing accepted ID cannot display newer unrelated history", () => {
  const accepted = task();
  const newer = task({ id: "unrelated", text: "Never select this latest task", updatedAt: "2099-01-01T00:00:00Z" });
  for (const [taskId, chatId] of [[accepted.id, "another-chat"], ["missing-task", "master"]]) {
    const view = voicePresentation({ snapshot: snapshot(accepted, newer), taskId, chatId });
    assert.equal(view.response, undefined); assert.equal(view.state, "working");
    assert.equal(view.status, "Waiting for this request’s status…");
  }
});

test("completed coordinator reply stays hidden until linked work actually reaches terminal state", () => {
  const worker = child({ status: "running", text: "Transient progress", hasLiveText: true });
  const accepted = task({ text: "Old coordinator waiting note", childTaskIds: [worker.id], childUpdates: [worker], workStatus: "running" });
  const input = { snapshot: snapshot(accepted), taskId: accepted.id, chatId: "master" };
  assert.equal(voicePresentation(input).state, "working"); assert.equal(voicePresentation(input).response, undefined);
  worker.status = "completed"; worker.text = "  Actual final child reply.\n"; worker.hasLiveText = false;
  accepted.workStatus = "completed";
  const view = voicePresentation(input);
  assert.equal(view.state, "completed");
  assert.deepEqual(view.response, { taskId: worker.id, deviceId: "demoPC", deviceName: "Actual DemoPC", text: worker.text });
});

test("missing linked children and truncated coverage wait instead of exposing the parent’s stale note", () => {
  for (const accepted of [
    task({ childTaskIds: ["omitted-child"] }),
    task({ childUpdates: [child()], childUpdateCount: 2 }),
    task({ childUpdates: [child()], childUpdatesTruncated: true }),
  ]) {
    const view = voicePresentation({ snapshot: snapshot(accepted), taskId: accepted.id, chatId: "master" });
    assert.equal(view.state, "working"); assert.equal(view.response, undefined);
    assert.equal(view.status, "Waiting for task updates…");
  }
});

test("legacy explicit child IDs preserve actual task and device attribution", () => {
  const accepted = task({ childTaskIds: ["linked-worker"] });
  const worker = task({ id: "linked-worker", parentTaskId: accepted.id, chatId: "demoPC-work", deviceId: "demoPC", text: "Full legacy child response" });
  const view = voicePresentation({ snapshot: snapshot(accepted, worker), taskId: accepted.id, chatId: "master" });
  assert.deepEqual(view.response, { taskId: worker.id, deviceId: worker.deviceId, deviceName: "Actual DemoPC", text: worker.text });
});

test("needs-input and terminal failures are stated without adding an external-success claim", () => {
  const accepted = task({ childUpdates: [child({ status: "needs_input", text: "Decision needed" })] });
  const view = voicePresentation({ snapshot: snapshot(accepted), taskId: accepted.id, chatId: "master" });
  assert.equal(view.state, "needs-input"); assert.equal(view.status, "Your input is needed."); assert.equal(view.response, undefined);
  for (const status of ["failed", "interrupted", "cancelled"] as const) {
    const failed = task({ status, text: "Partial response remains unchanged", error: "Actual task error" });
    const result = voicePresentation({ snapshot: snapshot(failed), taskId: failed.id, chatId: "master" });
    assert.equal(result.state, status); assert.equal(result.response?.text, failed.text);
    assert.doesNotMatch(result.status, /verified|succeeded|successfully/);
  }
});

test("sending and speaking are explicit controller states, with errors preserved separately", () => {
  const sending = voicePresentation({ snapshot: snapshot(), chatId: "master", dispatching: true, transcript: "Final words" });
  assert.equal(sending.state, "dispatching"); assert.equal(sending.status, "Sending request…");
  const speaking = voicePresentation({ snapshot: snapshot(task()), chatId: "master", taskId: "accepted-voice-task", speaking: true });
  assert.equal(speaking.state, "speaking"); assert.equal(speaking.status, "Reading the response…");
  assert.equal(speaking.response?.text, "  Exact response text.\n");
  const error = "Microphone permission denied.";
  const failed = voicePresentation({ snapshot: snapshot(), chatId: "master", error });
  assert.equal(failed.state, "failed"); assert.equal(failed.error, error); assert.equal(failed.transcript, "");
});

test("projection neither mutates source objects nor derives linkage from task text", () => {
  const accepted = Object.freeze(task({ text: "A task called unlinked-child completed." }));
  const data = snapshot(accepted, task({ id: "unlinked-child", parentTaskId: accepted.id, status: "running" }));
  Object.freeze(data.tasks); Object.freeze(data);
  const view = voicePresentation({ snapshot: data, taskId: accepted.id, chatId: "master" });
  assert.equal(view.response?.taskId, accepted.id); assert.equal(view.response?.text, accepted.text);
  assert.equal(data.tasks[0], accepted);
});
