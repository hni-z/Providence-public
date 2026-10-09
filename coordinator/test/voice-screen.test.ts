import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { VoiceSessionGuard } from "../web/src/browser-voice.js";
import type { VoiceCaptureToken, VoiceOutcome } from "../web/src/browser-voice.js";
import { activateVoiceCircle, initialWorkspaceView, voiceCircleAction, voiceJobStatus, voiceRequestFinished, voiceScreenGuidance, voiceScreenReplies, voiceScreenState, voiceSessionControl, workspaceViewUrl } from "../web/src/voice-screen.js";
import type { VoicePhase } from "../web/src/voice-screen.js";

test("voice entry and view toggle retain the current origin path, query and fragment without an auth route", () => {
  assert.equal(initialWorkspaceView("?view=voice"), "voice");
  for (const search of ["", "?view=other", "?voice=true"]) assert.equal(initialWorkspaceView(search), "workspace");
  assert.equal(initialWorkspaceView("?view=workspace"), "workspace");
  assert.equal(workspaceViewUrl("https://example.com/?other=kept#same", "voice"), "/?other=kept&view=voice#same");
  assert.equal(workspaceViewUrl("https://example.com/?view=voice&other=kept#same", "workspace"), "/?other=kept#same");
  assert.equal(workspaceViewUrl("https://example.com/?view=voice", "workspace"), "/");
});

test("the circle records first, submits only on the explicit second tap, and reserves one upload on the captured route", () => {
  const guard = new VoiceSessionGuard();
  const route = Object.freeze({ action: "chat-demoPC", input: "mac" });
  let token: VoiceCaptureToken | undefined;
  let phase: VoicePhase = "idle";
  const uploads: typeof route[] = [];
  let stops = 0;
  const actions = {
    start() { token = guard.begin(route.action); phase = "recording"; },
    sendRecording() {
      if (token && guard.claimRecording(token, route.action)) uploads.push(route);
    },
    stopPlayback() { stops++; },
    stop() { guard.reset(route.action); phase = "idle"; },
  };
  activateVoiceCircle(phase, false, true, true, actions);
  assert.equal(phase, "recording"); assert.equal(uploads.length, 0);
  assert.equal(voiceCircleAction(phase, false, true).label, "Stop and send recording");
  activateVoiceCircle(phase, false, true, false, actions);
  activateVoiceCircle(phase, false, true, false, actions); // Before MediaRecorder.onstop arrives.
  assert.deepEqual(uploads, [{ action: "chat-demoPC", input: "mac" }]);
  for (const busyPhase of ["requesting", "ready", "transcribing", "sending", "waiting"] as const) {
    activateVoiceCircle(busyPhase, false, true, true, actions);
    assert.equal(uploads.length, 1);
  }
  activateVoiceCircle("waiting", true, true, false, actions);
  assert.equal(stops, 1); assert.equal(uploads.length, 1);
  actions.stop();
  assert.equal(guard.claimRecording(token!, "chat-demoPC"), false);
  token = guard.begin("chat-demoPC");
  assert.equal(guard.claimRecording(token, "chat-review"), false);
  guard.reset("chat-review");
  assert.equal(guard.claimRecording(token, "chat-demoPC"), false);
  assert.equal(uploads.length, 1);
});

test("view labels use real lifecycle and audio state; text selects only the acknowledged task", () => {
  for (const [phase, expected] of [["recording", "Recording"], ["transcribing", "Transcribing"], ["waiting", "Working"]] as const)
    assert.equal(voiceScreenState(phase, false, false, false), expected);
  assert.equal(voiceScreenState("waiting", true, false, true), "Preparing reply audio");
  assert.equal(voiceScreenState("waiting", true, true, true), "Speaking");
  assert.equal(voiceScreenState("waiting", false, false, false, "failed"), "Request failed");
  assert.equal(voiceScreenState("waiting", false, false, false, "needs_input"), "Your decision is needed");
  assert.equal(voiceScreenState("waiting", false, false, true, "running"), "Working", "a partial reply does not mark a running request complete");
  assert.equal(voiceScreenState("waiting", false, false, false, "completed"), "Request completed", "completion without reply text must not claim a reply was received");
  assert.equal(voiceScreenState("waiting", false, false, true, "queued"), "Request queued");
  const outcome = (id: string, contextKey = "master", parentTaskId?: string): VoiceOutcome => ({ id, contextKey, parentTaskId, text: `${id} actual response`, status: "completed", updatedAt: "2026-09-20T00:00:00Z" });
  const values = [outcome("old"), outcome("own"), outcome("child", "master", "own"), outcome("other-child", "master", "old"), outcome("own", "another-chat")];
  assert.deepEqual(voiceScreenReplies(undefined, "master", values), []);
  assert.deepEqual(voiceScreenReplies({ id: "own", requestId: "r", chatId: "master" }, "master", values).map(value => value.id), ["own", "child"]);
  assert.deepEqual(voiceScreenReplies({ id: "own", requestId: "r", chatId: "master" }, "another-chat", values), []);
});

test("voice guidance does not claim readiness while disconnected, unavailable or delivery is uncertain", () => {
  const context = { phase: "idle" as VoicePhase, speaking: false, playing: false, recording: true, hasReply: false, connected: true, captureAvailable: true, canStart: true };
  assert.equal(voiceScreenGuidance(context).status, "Ready to listen");
  assert.equal(voiceScreenGuidance({ ...context, connected: false, canStart: false }).status, "Connection lost");
  assert.equal(voiceScreenGuidance({ ...context, captureAvailable: false, canStart: false }).status, "Voice input unavailable");
  assert.equal(voiceScreenGuidance({ ...context, canStart: false }).status, "Voice is not ready");
  assert.equal(voiceScreenGuidance({ ...context, uncertain: true, canStart: false }).status, "Delivery is unconfirmed");
  assert.equal(voiceScreenGuidance({ ...context, phase: "sending", uncertain: true, canStart: false }).status, "Sending your request", "an in-flight submission is not yet a delivery failure");
  assert.equal(voiceScreenGuidance({ ...context, phase: "sending", connected: false, uncertain: true, canStart: false }).status, "Delivery is unconfirmed");
  assert.equal(voiceScreenGuidance({ ...context, phase: "waiting", backgroundReady: true, connected: false, canStart: false, requestStatus: "running" }).status, "Connection lost");
  assert.equal(voiceScreenGuidance({ ...context, phase: "waiting", backgroundReady: true, canStart: false, requestStatus: "running" }).status, "Working");
  assert.equal(voiceScreenGuidance({ ...context, phase: "waiting", backgroundReady: true, requestStatus: "needs_input" }).status, "Your decision is needed");
  assert.equal(voiceScreenGuidance({ ...context, phase: "waiting", backgroundReady: true, requestStatus: "failed" }).status, "Request failed");
  assert.equal(voiceScreenGuidance({ ...context, phase: "waiting", backgroundReady: true, requestStatus: "running" }).status, "Ready for another request");
  assert.match(voiceScreenGuidance({ ...context, speaking: true, playing: true, connected: false }).help, /stops audio, not the task/);
});

test("session controls distinguish unsubmitted input from work that may already be dispatched", () => {
  for (const phase of ["requesting", "recording", "ready", "listening", "transcribing"] as const)
    assert.equal(voiceSessionControl(phase, true, false, false), "discard");
  assert.equal(voiceSessionControl("sending", true, false, false), "end");
  assert.equal(voiceSessionControl("waiting", false, false, false), "end");
  assert.equal(voiceSessionControl("waiting", false, true, false), undefined);
  assert.equal(voiceSessionControl("waiting", false, false, true), undefined);
  assert.equal(voiceSessionControl("idle", false, false, false), undefined);
  assert.equal(voiceJobStatus("needs_input"), "Needs your decision");
  assert.equal(voiceJobStatus("arbitrary_new_status"), "Status unavailable");
});

test("a matched terminal request enables the next explicit recording tap only after playback ends", () => {
  let recordings = 0, uploads = 0, stoppedAudio = 0;
  const actions = { start() { recordings++; }, sendRecording() { uploads++; }, stopPlayback() { stoppedAudio++; }, stop() {} };
  const finished = voiceRequestFinished("completed", true);
  assert.equal(finished, true);
  assert.equal(voiceRequestFinished("running", true), false);
  assert.equal(voiceCircleAction("waiting", false, true, false).action, "none");
  assert.equal(voiceCircleAction("waiting", true, true, finished).action, "stop_playback");
  assert.equal(recordings, 0, "completion and playback state alone never start a recording");
  activateVoiceCircle("waiting", true, true, true, actions, finished);
  assert.equal(recordings, 0); assert.equal(stoppedAudio, 1);
  assert.equal(voiceCircleAction("waiting", false, true, finished).label, "Start recording");
  activateVoiceCircle("waiting", false, true, true, actions, finished);
  assert.equal(recordings, 1); assert.equal(uploads, 0);
  activateVoiceCircle("recording", false, true, false, actions, false);
  assert.equal(uploads, 1);
  activateVoiceCircle("waiting", false, true, false, actions, finished);
  assert.equal(recordings, 1, "a disabled destination cannot start another recording");
});

test("rendered phone view has one circle, honest transcript/reply panels and deliberate send labels", async () => {
  const require = createRequire(new URL("../web/package.json", import.meta.url));
  const React = require("react"), { renderToStaticMarkup } = require("react-dom/server");
  const options = { parentURL: import.meta.url, tsconfig: fileURLToPath(new URL("../web/tsconfig.json", import.meta.url)) };
  const { default: Screen } = await tsImport("../web/src/VoiceScreen.tsx", options);
  const props = { phase: "idle", speaking: false, playing: false, recording: true, canStart: true, captureAvailable: true, connected: true, captureBusy: false,
    transcript: "", replies: [], note: "", error: "", providerLabel: "ElevenLabs replies", muted: false, canRetry: false,
    start() {}, sendRecording() {}, stop() {}, stopPlayback() {}, toggleMute() {}, retry() {} };
  const render = (patch = {}) => renderToStaticMarkup(React.createElement(Screen, { ...props, ...patch }));
  const idle = render();
  assert.equal((idle.match(/class="voice-circle/g) ?? []).length, 1);
  assert.match(idle, /aria-label="Start recording"/);
  assert.match(idle, /class="voice-circle"[^>]*><svg[^>]*aria-hidden="true"/);
  assert.ok(idle.indexOf('class="voice-circle"') < idle.indexOf('class="voice-screen-status"'));
  assert.match(idle, /No transcript yet/);
  assert.match(idle, /aria-label="AI-generated voice"/);
  assert.doesNotMatch(idle, />AI-generated voice</);
  assert.match(idle, /aria-label="Mute replies"/);
  const recording = render({ phase: "recording", captureBusy: true });
  assert.match(recording, /aria-label="Stop and send recording"/);
  assert.match(recording, /class="voice-circle is-listening"[^>]*><svg[^>]*aria-hidden="true"/);
  assert.match(recording, /Tap to stop and send/);
  assert.match(recording, /Discard voice input/);
  const transcribing = render({ phase: "transcribing", captureBusy: true, canStart: false });
  assert.match(transcribing, /disabled=""/);
  assert.match(transcribing, /Your transcript appears when transcription finishes/);
  const live = render({ phase: "recording", captureBusy: true, live: true, transcript: "Partial fixture words" });
  assert.match(live, /Live transcription/); assert.match(live, /Partial fixture words/);
  assert.match(live, /Provisional transcript — not submitted/); assert.match(live, /aria-live="polite"/);
  const finalizing = render({ phase: "transcribing", captureBusy: true, canStart: false, live: true, transcript: "Partial fixture words" });
  assert.match(finalizing, /Finalizing transcript/); assert.match(finalizing, /Nothing is submitted from partial text/);
  const background = render({ phase: "waiting", requestStatus: "queued", backgroundReady: true,
    jobs: [{ id: "acked", requestId: "request", chatId: "chat", transcript: "Second request", status: "queued" }], selectedJobId: "acked" });
  assert.match(background, /Ready for another request/); assert.match(background, /Start recording/);
  assert.match(background, /Queued: waiting for earlier work/);
  const uncertain = render({ phase: "idle", canStart: false, uncertain: true });
  assert.match(uncertain, /Delivery is unconfirmed/); assert.match(uncertain, /disabled=""/);
  assert.equal((uncertain.match(/Delivery is unconfirmed/g) ?? []).length, 1);
  const disconnected = render({ connected: false, canStart: false });
  assert.match(disconnected, /Connection lost/); assert.doesNotMatch(disconnected, /Ready to listen/);
  assert.doesNotMatch(render({ connected: false, canStart: false, note: "Disconnected. Start voice again after reconnecting." }), /Disconnected\. Start voice/);
  const waiting = render({ phase: "waiting", requestStatus: "running", canStart: false });
  assert.match(waiting, /End voice session/); assert.match(waiting, /Ending voice does not stop submitted work/);
  const muted = render({ muted: true, canRetry: true });
  assert.match(muted, /aria-label="Retry reply audio"[^>]*disabled=""/);
  assert.match(muted, /Unmute replies<\/button>/);
  const failed = render({ error: "Synthetic voice failure" });
  assert.ok(failed.indexOf('role="alert"') < failed.indexOf('class="voice-screen-content"'));
  const replied = render({ phase: "waiting", transcript: "Report the current time.", replies: [{ id: "actual-task", text: "The time is **10:30**.", status: "completed" }] });
  assert.ok(replied.indexOf("voice-circle") < replied.indexOf("Report the current time."));
  assert.ok(replied.indexOf("Report the current time.") < replied.indexOf("The time is"));
  assert.match(replied, /<strong>10:30<\/strong>/);
  const { default: Drawer } = await tsImport("../web/src/VoiceChatDrawer.tsx", options);
  const drawer = renderToStaticMarkup(React.createElement(Drawer, { selected: "chat-demoPC", chats: [{ id: "chat-demoPC", deviceId: "demoPC", name: "DemoPC demo" }],
    devices: [{ id: "demoPC", name: "DemoPC", online: false }], connected: true, disabled: true, onSelect() {}, onClose() {} }));
  assert.match(drawer, /role="dialog"/); assert.match(drawer, /aria-label="Close conversations"/);
  assert.match(drawer, /DemoPC demo.*DemoPC.*Offline/); assert.match(drawer, /Superagent/);
  assert.match(drawer, /aria-current="page"/); assert.match(drawer, /disabled=""/);
});

test("rendering BrowserVoice with a live adapter performs no capture, provider or task call", async () => {
  const require = createRequire(new URL("../web/package.json", import.meta.url));
  const React = require("react"), { renderToStaticMarkup } = require("react-dom/server");
  const options = { parentURL: import.meta.url, tsconfig: fileURLToPath(new URL("../web/tsconfig.json", import.meta.url)) };
  const { default: BrowserVoice } = await tsImport("../web/src/BrowserVoice.tsx", options);
  let provider = 0, task = 0;
  const html = renderToStaticMarkup(React.createElement(BrowserVoice, { contextKey: "fixture-chat", configurationKey: "fixture-live",
    outcomes: [], presentation: "screen", liveInput: async () => { provider++; throw new Error("must not start on render"); },
    onTranscript: async () => { task++; throw new Error("must not dispatch on render"); }, allowBrowserRecognition: false }));
  assert.match(html, /Voice for this conversation/); assert.equal(provider, 0); assert.equal(task, 0);
});
