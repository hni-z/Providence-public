import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { ApiError } from "../web/src/api.js";
import { configuredTranscriptionRoute, destinationIssue, deviceConnectionDetail, deviceConnectionLabel, parseTranscriptionAvailability } from "../web/src/destination.js";
import { findRequestDelivery, MessageNotSentError, submitToDestination } from "../web/src/message-delivery.js";
import { selectedChatAfter } from "../web/src/navigation.js";
import { transcribeVoice } from "../web/src/voice-api.js";
import { voiceCaptureMethod } from "../web/src/browser-voice.js";
import type { Approval, Chat, Device, Envelope, Task } from "../web/src/types.js";

const devices: Device[] = [
  { id: "mac", name: "Demo Mac", online: true },
  { id: "device-demoPC", name: "DemoPC", online: true },
  { id: "device-review", name: "Review Mac", online: true },
];
const chats: Chat[] = devices.map((device) => ({ id: `chat-${device.id}`, deviceId: device.id, name: `${device.name} demo`, threadId: `thread-${device.id}`, online: true }));
const request: Envelope = { requestId: "same-request", chatId: chats[2].id, text: "Report the current time", sourceChatIds: [] };
const task: Task = { id: "accepted", requestId: request.requestId, chatId: request.chatId, deviceId: devices[2].id, prompt: request.text, text: "", status: "running", createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z" };
const state = { connected: true, chats, devices, tasks: [] as Task[], approvals: [] as Approval[] };
const input = { available: true, devices: devices.map((device) => ({ ...device, configured: device.id === "mac" })) };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("three enrolled action destinations stay explicit when offline, removed or missing", () => {
  for (const chat of chats) {
    assert.equal(destinationIssue(chat.id, chats, devices, true), undefined);
    const offline = devices.map((device) => ({ ...device, online: device.id !== chat.deviceId }));
    assert.match(destinationIssue(chat.id, chats, offline, true)!, /offline/);
    assert.equal(selectedChatAfter(chat.id, { kind: "refreshed" }), chat.id);
    assert.match(destinationIssue(chat.id, [], devices, true)!, /conversation is unavailable/);
    assert.match(destinationIssue(chat.id, chats, [], true)!, /computer is unavailable/);
  }
  assert.match(destinationIssue("master", chats, devices, false)!, /Connection unavailable/);
  assert.equal(destinationIssue("master", chats, devices, true), undefined);
});

test("connection labels use current transport readiness and never invent a historical failure cause", () => {
  const d = devices[0];
  assert.equal(deviceConnectionLabel({ ...d, connectionStatus: { state: "action_required", reasonCode: "old-error" } }, true), "Connected");
  for (const [status, label] of [["connecting", "Connecting"], ["action_required", "Needs attention"], ["offline", "Offline"], ["online", "Offline"]] as const)
    assert.equal(deviceConnectionLabel({ ...d, online: false, connectionStatus: { state: status } }, true), label);
  assert.equal(deviceConnectionLabel(d, false), "Status unavailable");
  assert.equal(deviceConnectionLabel(undefined, true), "Device unavailable");
  const rejected: Device = { ...d, online: false, connectionStatus: { state: "action_required", reasonCode: "authentication_required" } };
  assert.match(deviceConnectionDetail(rejected, true)!, /Sign in to Codex/);
  assert.equal(deviceConnectionDetail(rejected, false), undefined);
  assert.equal(deviceConnectionDetail({ ...rejected, online: true }, true), undefined);
  assert.equal(deviceConnectionDetail({ ...rejected, connectionStatus: { state: "offline", reasonCode: "unknown diagnostic" } }, true), undefined);
});

test("only the authenticated default transcribes; an unavailable default never selects another host or browser", () => {
  const config = { deviceId: "mac", transcriptionConfigured: true };
  assert.deepEqual(configuredTranscriptionRoute(config, input), { deviceId: "mac", ready: true });
  for (const availability of [null, { ...input, devices: [] }, { ...input, devices: input.devices.map((device) => ({ ...device, configured: device.id === "device-review", online: device.id !== "mac" })) }]) {
    const route = configuredTranscriptionRoute(config, availability);
    assert.equal(route.deviceId, "mac");
    assert.equal(route.ready, false);
    assert.equal(voiceCaptureMethod(route.ready, false), undefined);
  }
  assert.deepEqual(configuredTranscriptionRoute(config, input), { deviceId: "mac", ready: true });
  assert.deepEqual(configuredTranscriptionRoute(null, input), { deviceId: "", ready: false });
  assert.equal(configuredTranscriptionRoute({ ...config, transcriptionConfigured: false }, input).ready, false);
  assert.equal(configuredTranscriptionRoute({ ...config, deviceId: "device-review" }, input).ready, false);
  assert.equal(voiceCaptureMethod(true, false), "recording");
  assert.equal(voiceCaptureMethod(false, false), undefined);
  assert.deepEqual(parseTranscriptionAvailability({ transcription: input }), input);
  assert.throws(() => parseTranscriptionAvailability({ transcription: { ...input, devices: [{ id: "mac" }] } }), /could not be confirmed/);
});

test("actual submission helper blocks stale destinations and pending decisions before any POST", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("should not send"); };
  const approval: Approval = { id: "decision", taskId: task.id, deviceId: task.deviceId, method: "item/tool/requestUserInput", status: "pending", details: {} };
  for (const guarded of [
    { ...state, connected: false }, { ...state, chats: [] }, { ...state, devices: [] },
    { ...state, devices: devices.map((device) => ({ ...device, online: false })) },
    { ...state, tasks: [task] }, { ...state, tasks: [{ ...task, status: "completed" }], approvals: [approval] },
  ]) await assert.rejects(submitToDestination("fixture", request, guarded), MessageNotSentError);
  assert.equal(calls, 0);
});

test("transcription on Demo Mac and a task on Review use separate exact destinations", async () => {
  const calls: { path: string; body: any }[] = [];
  globalThis.fetch = async (path, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture");
    calls.push({ path: String(path), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(String(path).endsWith("/transcriptions") ? { status: "completed", text: request.text } : task), { headers: { "Content-Type": "application/json" } });
  };
  const route = configuredTranscriptionRoute({ deviceId: "mac", transcriptionConfigured: true }, input);
  const transcript = await transcribeVoice("fixture", route.deviceId, new Blob(["fixture"], { type: "audio/webm" }), new AbortController().signal);
  assert.equal((await submitToDestination("fixture", { ...request, text: transcript }, state)).id, task.id);
  assert.equal(calls[0].body.deviceId, "mac");
  assert.equal(calls[1].path, `/v1/chats/${request.chatId}/messages`);
  assert.equal(calls[1].body.requestId, request.requestId);
  assert.equal(calls.length, 2);
});

test("lost acknowledgements reconcile by GET even if the destination is now offline; no resend or route switch", async () => {
  const methods: string[] = [];
  globalThis.fetch = async (_path, init) => {
    methods.push(init?.method ?? "GET");
    if (methods.length === 1) throw new Error("lost acknowledgement");
    return new Response(JSON.stringify({ tasks: [{ ...task, chatId: "wrong-chat" }, task] }));
  };
  await assert.rejects(submitToDestination("fixture", request, state), /lost acknowledgement/);
  assert.equal((await findRequestDelivery("fixture", request))?.id, task.id);
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.equal(request.requestId, "same-request");
});

test("auth rejection and mismatched acknowledgements do not retry or report success", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: "Access expired" }), { status: 401 }); };
  await assert.rejects(submitToDestination("fixture", request, state), (error) => error instanceof ApiError && error.status === 401);
  assert.equal(calls, 1);
  globalThis.fetch = async () => new Response(JSON.stringify({ ...task, deviceId: "mac" }));
  await assert.rejects(submitToDestination("fixture", request, state), /could not be confirmed/);
  globalThis.fetch = async () => new Response(JSON.stringify({ tasks: [{ ...task, chatId: "wrong-chat" }] }));
  assert.equal(await findRequestDelivery("fixture", request), undefined);
});

test("shared voice presentation has no input-host selector and states unavailability without offering fallback", async () => {
  const require = createRequire(new URL("../web/package.json", import.meta.url));
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { default: Screen } = await tsImport("../web/src/VoiceScreen.tsx", { parentURL: import.meta.url, tsconfig: fileURLToPath(new URL("../web/tsconfig.json", import.meta.url)) });
  const render = (availability: typeof input | null) => {
    const route = configuredTranscriptionRoute({ deviceId: "mac", transcriptionConfigured: true }, availability);
    return renderToStaticMarkup(React.createElement(Screen, { phase: "idle", speaking: false, playing: false, recording: true, canStart: route.ready,
      captureAvailable: route.ready, connected: true, captureBusy: false, transcript: "", replies: [], note: "", error: "",
      providerLabel: "ElevenLabs replies", muted: false, canRetry: false,
      start() {}, sendRecording() {}, stop() {}, stopPlayback() {}, toggleMute() {}, retry() {} }));
  };
  for (const html of [render(input), render(null)]) {
    assert.doesNotMatch(html, /<select|processed by|Browser recognition|Choose an input|Demo Mac|Review Mac/);
    assert.match(html, /class="voice-circle/);
  }
  assert.match(render(null), /Voice input (?:is )?unavailable/);
  assert.doesNotMatch(render(null), /Ready to listen/);
  assert.match(render(null), /disabled=""/);
  assert.match(render(input), /Tap (?:the microphone )?to record/);
});
