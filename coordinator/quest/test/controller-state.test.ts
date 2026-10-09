import { test } from "node:test";
import assert from "node:assert/strict";
import { requestReadiness, voiceReply } from "../src/controller-state";
import type { ChildTaskUpdate, Snapshot, Task } from "../src/types";

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "voice-task", chatId: "master", deviceId: "coordinator", status: "completed",
  prompt: "A voice request", text: "Original coordinator reply", createdAt: "2026-09-19T07:00:00Z",
  updatedAt: "2026-09-19T07:00:01Z", ...overrides,
});
const update = (overrides: Partial<ChildTaskUpdate> = {}): ChildTaskUpdate => ({
  id: "linked-child", chatId: "mac-chat", chatName: "Mac work", deviceId: "actual-mac",
  deviceName: "Server-reported Mac", status: "completed", text: "  Exact child response.\n",
  updatedAt: "2026-09-19T07:02:00Z", hasLiveText: false, ...overrides,
});
const snapshot = (tasks: Task[] = []): Snapshot => ({
  devices: [{ id: "actual-mac", name: "Actual MacBook", online: true }, { id: "actual-windows", name: "Actual DemoPC", online: false }],
  chats: [{ id: "mac-chat", name: "Mac work", deviceId: "actual-mac", online: true }, { id: "windows-chat", name: "Windows work", deviceId: "actual-windows", online: true }],
  tasks, approvals: [],
});

test("direct readiness requires the exact registered chat and its actual online device", () => {
  const state = snapshot();
  assert.deepEqual(requestReadiness(state, "unknown-chat"), { ready: false, reason: "missing-chat" });
  assert.deepEqual(requestReadiness(state, "windows-chat"), { ready: false, reason: "offline" });
  assert.deepEqual(requestReadiness(state, "mac-chat"), { ready: true });
  state.chats[0].online = false;
  assert.deepEqual(requestReadiness(state, "mac-chat"), { ready: true });
  state.devices = [];
  assert.deepEqual(requestReadiness(state, "mac-chat"), { ready: false, reason: "offline" });
});

test("master remains a valid route but blocks its active turn or active delegated work", () => {
  assert.deepEqual(requestReadiness(snapshot(), "master"), { ready: true });
  for (const status of ["queued", "running", "needs_input"]) {
    assert.deepEqual(requestReadiness(snapshot([task({ status })]), "master"), { ready: false, reason: "working" });
    assert.deepEqual(requestReadiness(snapshot([task({ workStatus: status })]), "master"), { ready: false, reason: "working" });
  }
  assert.deepEqual(requestReadiness(snapshot([task({ status: "failed" })]), "master"), { ready: true });
});

test("direct readiness blocks only active work in the selected chat", () => {
  const other = task({ id: "other", chatId: "other-chat", status: "running" });
  assert.deepEqual(requestReadiness(snapshot([other]), "mac-chat"), { ready: true });
  for (const status of ["queued", "running", "needs_input"]) {
    assert.deepEqual(requestReadiness(snapshot([other, task({ chatId: "mac-chat", status })]), "mac-chat"), { ready: false, reason: "working" });
  }
});

test("voice reply is isolated to the exact accepted task ID, never a newer same-chat response", () => {
  const requested = task({ text: "  Preserve this exact reply.\n" });
  const unrelated = task({ id: "unrelated", text: "Do not read this", updatedAt: "2099-01-01T00:00:00Z" });
  assert.deepEqual(voiceReply(snapshot([requested, unrelated]), requested.id), { id: requested.id, text: requested.text });
  assert.equal(voiceReply(snapshot([unrelated]), requested.id), undefined);
});

test("a completed parent cannot supply its stale note while a linked child is still working", () => {
  for (const status of ["queued", "running", "needs_input"]) {
    const parent = task({ childUpdates: [update({ status })], childTaskIds: ["linked-child"] });
    assert.equal(voiceReply(snapshot([parent]), parent.id), undefined);
  }
  const parent = task({ workStatus: "running", childUpdates: [update()] });
  assert.equal(voiceReply(snapshot([parent]), parent.id), undefined);
});

test("newest terminal linked child response wins with unchanged ID/text and real device attribution", () => {
  const newer = update({ id: "newer-child", updatedAt: "2026-09-19T03:04:00-04:00", text: "  Newest result, verbatim.\n" });
  const parent = task({ text: "An old waiting note", childUpdates: [update(), newer], childTaskIds: ["linked-child", "newer-child"], childUpdateCount: 2 });
  const state = snapshot([parent, task({ id: "unrelated-same-chat", chatId: "mac-chat", text: "Unrelated", updatedAt: "2099-01-01T00:00:00Z" })]);
  assert.deepEqual(voiceReply(state, parent.id), { id: newer.id, text: newer.text, deviceName: "Actual MacBook" });
  assert.deepEqual(parent.childUpdates?.map((child) => child.id), ["linked-child", "newer-child"]);
});

test("legacy explicit child IDs resolve only their matching task records", () => {
  const parent = task({ childTaskIds: ["linked-child"] });
  const child = task({ id: "linked-child", parentTaskId: parent.id, chatId: "mac-chat", deviceId: "actual-mac", text: "Legacy linked reply" });
  assert.equal(voiceReply(snapshot([parent]), parent.id), undefined);
  assert.deepEqual(voiceReply(snapshot([parent, child]), parent.id), { id: child.id, text: child.text, deviceName: "Actual MacBook" });
  assert.equal(voiceReply(snapshot([parent, { ...child, parentTaskId: "other-parent" }]), parent.id), undefined);
});

test("missing IDs or omitted child-update coverage prevents a premature reply", () => {
  const child = update();
  assert.equal(voiceReply(snapshot([task({ childUpdates: [child], childTaskIds: [child.id, "missing-child"] })]), "voice-task"), undefined);
  assert.equal(voiceReply(snapshot([task({ childUpdates: [child], childUpdateCount: 2 })]), "voice-task"), undefined);
  assert.equal(voiceReply(snapshot([task({ childUpdates: [child], childUpdatesTruncated: true })]), "voice-task"), undefined);
  assert.equal(voiceReply(snapshot([task({ childUpdateCount: 1 })]), "voice-task"), undefined);
  const second = task({ id: "second-child", parentTaskId: "voice-task", chatId: "mac-chat", deviceId: "actual-mac", text: "Second child done", updatedAt: "2026-09-19T07:05:00Z" });
  const parent = task({ childUpdates: [child], childTaskIds: [child.id, second.id], childUpdateCount: 2, childUpdatesTruncated: true });
  assert.deepEqual(voiceReply(snapshot([parent, second]), parent.id), { id: second.id, text: second.text, deviceName: "Actual MacBook" });
});

test("no parent fallback is used when explicit children have no response text", () => {
  assert.equal(voiceReply(snapshot([task({ childUpdates: [update({ text: " \n" })] })]), "voice-task"), undefined);
  const state = snapshot([task({ childUpdates: [update({ text: "", status: "failed" }), update({ id: "other-linked", text: "A terminal child reply" })] })]);
  assert.equal(voiceReply(state, "voice-task")?.id, "other-linked");
});

test("task prose and unlinked parentTaskId records do not create delegation links", () => {
  const parent = task({ text: "The task named invisible-child may have finished." });
  const unlinked = task({ id: "invisible-child", parentTaskId: parent.id, chatId: "mac-chat", status: "running", text: "Unrelated to explicit reply linkage" });
  assert.deepEqual(voiceReply(snapshot([parent, unlinked]), parent.id), { id: parent.id, text: parent.text });
});

test("unknown or conflicting child state waits for reconciliation, including active nested work", () => {
  assert.equal(voiceReply(snapshot([task({ childUpdates: [update({ status: "unknown" })] })]), "voice-task"), undefined);
  const parent = task({ childUpdates: [update()], childTaskIds: ["linked-child"] });
  const listed = task({ id: "linked-child", chatId: "mac-chat", deviceId: "actual-mac", status: "running" });
  assert.equal(voiceReply(snapshot([parent, listed]), parent.id), undefined);
  assert.equal(voiceReply(snapshot([parent, { ...listed, status: "completed", workStatus: "running" }]), parent.id), undefined);
  assert.equal(voiceReply(snapshot([parent, { ...listed, status: "completed", deviceId: "actual-windows" }]), parent.id), undefined);
});

test("terminal failure text remains verbatim and unavailable device names are never invented", () => {
  const failed = update({ status: "failed", deviceId: "not-listed", deviceName: "Reported remote host", text: "The request failed." });
  assert.deepEqual(voiceReply(snapshot([task({ childUpdates: [failed] })]), "voice-task"), { id: failed.id, text: failed.text, deviceName: "Reported remote host" });
  const direct = task({ chatId: "old-chat", deviceId: "unknown-device", status: "interrupted", text: "Interrupted response" });
  assert.deepEqual(voiceReply(snapshot([direct]), direct.id), { id: direct.id, text: direct.text });
});

test("the full task body wins over its summary at equal update time without mutation", () => {
  const summarized = update({ text: "Short summary", textTruncated: true });
  const parent = task({ childUpdates: [summarized] });
  const full = task({ id: summarized.id, chatId: summarized.chatId, deviceId: summarized.deviceId, parentTaskId: parent.id, text: "Full response body unchanged", updatedAt: summarized.updatedAt });
  Object.freeze(summarized); Object.freeze(parent.childUpdates); Object.freeze(parent); Object.freeze(full);
  assert.deepEqual(voiceReply(snapshot([parent, full]), parent.id), { id: full.id, text: full.text, deviceName: "Actual MacBook" });
});

test("terminal dictation presentation clears Listening and preserves no-speech, timeout and unsupported messages", async () => {
  const { dictationPresentation } = await import("../src/controller-state");
  for (const message of [
    "No speech was recognized. Try again or use text input.",
    "Dictation did not finish. Try again or use text input.",
    "Browser dictation is unavailable. Use text input.",
    "Dictation was too long. Record a shorter request.",
  ]) {
    const view = dictationPresentation(message, false);
    assert.deepEqual(view, { text: message, clearListening: true, discardContext: true });
    const oldMessage = "Listening for one request to Superagent. Release to finish.";
    assert.equal([view.clearListening ? "" : oldMessage, view.text].filter(Boolean).join(" "), message);
  }
  assert.deepEqual(dictationPresentation("Final transcript ready.", false), { text: "", clearListening: true, discardContext: false });
  assert.equal(dictationPresentation("Listening. Speak now.", true).clearListening, false);
  assert.equal(dictationPresentation("Not started", false).text, "");
});

test("pending child recovery defaults to Superagent without altering the captured request", async () => {
  const { restoreControllerState, submissionForSend } = await import("../src/controller-state");
  const pending = Object.freeze({ requestId: "original-request-id", chatId: "windows-chat", text: "  Preserve this exact request.\n" });
  const restored = restoreControllerState(JSON.stringify(pending));
  assert.equal(restored.selectedChat, "master");
  assert.deepEqual(restored.pending, pending);
  let generated = 0;
  const retry = submissionForSend(restored.pending, pending.text, pending.chatId, () => { generated++; return "must-not-be-used"; });
  assert.equal(retry, restored.pending);
  assert.deepEqual(retry, pending);
  assert.equal(generated, 0);
  assert.throws(() => submissionForSend(restored.pending, pending.text, "master", () => "new"), /Recover the unconfirmed request/);
  assert.throws(() => submissionForSend(restored.pending, "different", pending.chatId, () => "new"), /Recover the unconfirmed request/);
  assert.deepEqual(restored.pending, pending);
  assert.equal(restored.selectedChat, "master");
});

test("invalid recovery state never changes the default destination or creates an implicit request", async () => {
  const { restoreControllerState, submissionForSend } = await import("../src/controller-state");
  for (const value of [null, "{bad", "null", JSON.stringify({ requestId: true, chatId: "child", text: "test" }), JSON.stringify({ requestId: "id", chatId: "child", text: "" })])
    assert.deepEqual(restoreControllerState(value), { selectedChat: "master" });
  assert.deepEqual(submissionForSend(undefined, "New explicit request", "master", () => "new-id"), { requestId: "new-id", text: "New explicit request", chatId: "master" });
});

test("dictation controller keeps exactly one final delivery while clearing the stale listening label", async () => {
  const { BrowserDictation } = await import("../src/browser-voice");
  const { dictationPresentation } = await import("../src/controller-state");
  let recognition: any, context = true, message = "Listening for one request", displayed = "";
  const deliveries: string[] = [];
  class FakeRecognition {
    continuous = false; interimResults = false;
    onstart: (() => void) | null = null; onend: (() => void) | null = null;
    onerror: ((event: { error?: string }) => void) | null = null;
    onresult: ((event: any) => void) | null = null;
    constructor() { recognition = this; }
    start() {} stop() {} abort() {}
  }
  const helper = new BrowserDictation(state => {
    const view = dictationPresentation(state, helper.active);
    if (context && view.clearListening) { message = ""; if (view.discardContext) context = false; }
    displayed = [message, view.text].filter(Boolean).join(" ");
  }, text => { if (context) { context = false; deliveries.push(text); } }, { SpeechRecognition: FakeRecognition });
  helper.start();
  recognition.onerror({ error: "no-speech" });
  assert.equal(context, false);
  assert.match(displayed, /No speech was recognized/);
  assert.ok(!displayed.includes("Listening"));
  context = true; message = "Listening for one request";
  helper.start();
  recognition.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "One captured request" } }] });
  const end = recognition.onend;
  end(); end();
  assert.deepEqual(deliveries, ["One captured request"]);
  assert.equal(message, "");
  helper.dispose();
});
