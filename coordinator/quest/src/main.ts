import "./style.css";
import { SPATIAL_ACCOUNT_HREF, hostedAccountMode, clearSpatialLogin } from "./account-session";
import {
  ApiError,
  ProvidenceApi,
  prepareTranscription,
  type TranscriptionCapability,
  type TranscriptionRequest,
  type TranscriptionJob,
  type VoiceConfig,
} from "./api";
import { MicrophoneCapture } from "./audio";
import { SpatialWorkspace } from "./spatial";
import { taskUpdates, childUpdateLines } from "./task-updates";
import { actionTarget, deviceConnection, targetOptions } from "./target-selection";
import { selectVoiceInput } from "./voice-input-selection";
import { voicePresentation } from "./voice-presentation";
import {
  requestReadiness,
  voiceReply,
  restoreControllerState,
  submissionForSend,
  dictationPresentation,
  type PendingSubmission,
} from "./controller-state";
import { BrowserDictation, BrowserSpeech } from "./browser-voice";
import { voiceConfigurationIdentity } from "../../web/src/voice-config.js";
import {
  ServerSpeechPlayer,
  SpeechPlaybackError,
} from "../../web/src/server-audio.js";
import { CompletionSpeechGate } from "./completion-speech";
import { bindPageLifecycle, PollingLoop } from "./page-lifecycle";
import type {
  Action,
  Approval,
  Artifact,
  Panel,
  Snapshot,
  SpatialCapabilities,
  Task,
} from "./types";

const root = document.querySelector<HTMLDivElement>("#app")!;
root.innerHTML = `<main class="shell">
<header class="masthead"><a class="wordmark" href="/" aria-label="Providence home"><img class="brand-mark" src="/favicon.svg?v=3" alt="">Providence<span class="pill" style="margin-left:18px">SPATIAL</span></a><nav class="row" aria-label="Providence views"><a href="/">Chat</a><a href="/account#devices">Devices</a><span id="connection" class="muted">Not connected</span><a id="account-signin" href="${SPATIAL_ACCOUNT_HREF}" hidden>Sign in</a><button id="signout" class="subtle" hidden>Sign out</button></nav></header>
<section class="hero"><div><div class="eyebrow">A little more room to think</div><h1 style="margin-top:12px">Your world, within reach.</h1><p>Speak to the sphere. Follow your computers as they work. Open this page in a Meta Quest browser to step inside.</p></div><div class="stack"><button id="enter-vr" class="primary" disabled>Enter spatial workspace</button><button id="enter-ar" hidden>Enter with passthrough</button><small id="xr-note">Checking immersive support…</small><div class="row"><button id="arrange-panels" class="subtle">Arrange panels</button><button id="recenter-panels" class="subtle">Recenter</button></div></div></section>
<details class="spatial-wrap" id="spatial-preview" open><summary>Spatial workspace <span>Interactive desktop view · headset mode available on Quest</span></summary><div id="viewport" class="viewport"></div><div class="spatial-control"><button id="spatial-talk" type="button" class="primary" disabled>Speak to Providence</button><p id="spatial-voice-status" role="status">Sign in to begin.</p><a href="#type-instead">Type a request</a></div></details>
<details class="setup-details"><summary>Microphone &amp; headset setup</summary><section class="card preflight"><div><div class="eyebrow">Headset readiness</div><h2>Set up your space</h2><p class="muted">Allow the microphone here before entering. Point forward and pinch to select. Controllers work too.</p><div class="row" style="margin-top:16px"><button id="enable-mic">Enable microphone</button><button id="skip-mic" class="subtle">Use text only</button></div><p class="message" id="mic-status">Microphone has not been requested.</p></div><div class="stack"><div class="capabilities" id="capabilities"></div><div class="login" id="login"><a class="account-link" href="${SPATIAL_ACCOUNT_HREF}">Sign in to Providence →</a><p class="muted">Use the same account as your other devices. No API key is entered on this page.</p><details class="legacy-login" id="legacy-login"><summary>Private server or one-use code</summary><form id="login-form" class="stack"><label for="credential" id="credential-label">Workspace access key</label><div class="row"><input id="credential" type="password" autocomplete="off" placeholder="Enter your existing private access key" required maxlength="256"><button class="primary" type="submit">Connect</button></div><label class="row muted"><input id="owner-key" type="checkbox" checked style="min-height:20px;width:18px">Use the reusable workspace key</label></form><small>Use your existing workspace key for repeat testing. Uncheck the option above to use a one-use code. Credentials remain in this tab’s session.</small></details></div></div></section></details>
<div id="notice" class="message" role="status" aria-live="polite"></div>
<section id="pending-recovery" class="card stack" hidden><strong>Unconfirmed request</strong><p id="pending-destination" class="muted"></p><p id="pending-text" class="output"></p><div class="row"><button id="retry-pending" class="primary" type="button">Retry exact request</button><button id="inspect-pending" type="button">Inspect original chat</button><button id="dismiss-pending" class="subtle" type="button">Dismiss local retry</button></div><small>Retry preserves the original chat, text and identity. Dismissing clears only this tab’s saved retry; it does not cancel any submitted task. Nothing is resent automatically.</small></section>
<section class="grid"><aside class="card"><div class="panel-title"><h2>Computers</h2><span id="device-count" class="badge">0 online</span></div><div id="devices" class="items"></div><div class="panel-title" style="margin-top:28px"><h2>Chat</h2></div><label for="chat-select" class="muted">Action computer and conversation</label><select id="chat-select" style="width:100%"></select></aside>
<section class="card voice-workspace">
  <div class="panel-title"><h2 id="conversation-title">Providence</h2><span class="label">Voice workspace</span></div>
  <p id="destination-note" class="muted"></p>
  <section id="voice-stage" class="voice-stage" data-state="unavailable" aria-label="Voice request">
    <button id="talk" class="voice-orb" type="button" disabled aria-label="Tap to speak" aria-describedby="talk-label voice-stage-status">

    </button>
    <p id="talk-label" class="voice-orb-label">Tap to speak</p>
    <p id="voice-stage-status" class="voice-stage-status" role="status">Connect to start a voice request.</p>
    <div class="voice-transcript-block">
      <span class="eyebrow">You said</span>
      <p id="voice-transcript" class="voice-transcript-text" hidden></p>
      <p id="voice-transcript-placeholder" class="voice-transcript-text muted">Your words will appear here after you stop recording.</p>
    </div>
    <div class="voice-response-block">
      <div class="panel-title"><h3>Response</h3><button id="read-reply" type="button" class="subtle" disabled>Play response</button></div>
      <p id="voice-response-text" class="voice-response-text">Your response will appear here.</p>
      <small id="voice-response-source"></small>
    </div>
    <div class="voice-secondary-controls"><button id="stop-voice" type="button" disabled>Stop voice</button><button id="mute-replies" type="button" aria-pressed="false">Mute replies</button></div>
  </section>
  <p id="browser-voice-status" class="message" role="status"></p>
  <p id="completion-note" class="muted">Replies play automatically through this device's speakers.</p>
  <p id="voice-provider-summary" class="muted"></p>
  <details class="voice-details"><summary>Voice settings</summary><div class="stack">
    <small>Audio is recorded and played on this device. Speech is transcribed through Providence's approved cloud service.</small>
    <p id="voice-note" class="muted">Checking voice services…</p>
  </div></details>
  <details class="voice-details" id="type-instead"><summary>Type instead</summary><form id="message-form" class="composer"><label for="message">What would you like to get done?</label><textarea id="message" placeholder="Ask Providence to work on a connected computer…" maxlength="30000"></textarea><button id="send" class="primary" type="submit" disabled>Send request</button></form></details>
  <details class="voice-details" id="audio-tests"><summary>Microphone test &amp; transcript review</summary><div class="stack">
    <button id="record" class="voice" type="button" disabled>Hold to record a mic test</button>
    <div id="recording-preview" hidden><audio id="recorded-audio" controls></audio><small id="recorded-size"></small><div id="transcription-controls" class="stack"><div class="row"><button id="transcribe" class="primary" type="button" disabled>Transcribe recording</button><button id="discard-audio" class="subtle" type="button">Discard recording &amp; transcript</button></div></div></div>
    <p id="transcription-status" class="message" role="status"></p><section id="transcript-review" class="stack" hidden><label for="transcript">Review transcript before sending</label><textarea id="transcript" maxlength="8000"></textarea><button id="send-transcript" class="primary" type="button">Send transcript to this conversation</button></section>
  </div></details>
  <details class="voice-details"><summary>Task activity</summary><div id="tasks" class="items"></div></details>
</section>
<aside class="card results-column"><div class="panel-title"><h2>Activity &amp; results</h2></div><div id="decisions" class="stack"></div><div id="selected-task" class="stack" style="margin-top:18px"></div></aside></section>
<footer class="footer">Device panels show connection, task activity, and returned files. Live desktop screen sharing is not available yet. In Quest, point and pinch to select; palm-facing pinch opens system controls.</footer></main>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const empty: Snapshot = { devices: [], chats: [], tasks: [], approvals: [] };
let snapshot: Snapshot = empty,
  api: ProvidenceApi | undefined,
  spatial: SpatialWorkspace | undefined;
let hostedService = hostedAccountMode(location.hostname);
let selectedChat = "master",
  selectedTask = "",
  selectedDevice = "",
  busy = false,
  generation = 0;
let micTextOnly = false,
  micState = "Not requested",
  recordingUrl = "";
let vrSupported = false,
  arSupported = false,
  syncedAt = "",
  lastError = "",
  alive = true;
let caps: SpatialCapabilities = {
  active: false,
  hands: 0,
  controllers: 0,
  keyboard: false,
  selections: 0,
};
let recordedBlob: Blob | undefined;
let transcriptionCapability: TranscriptionCapability | undefined;
let voiceConfig: VoiceConfig | undefined,
  voiceConfigAt = 0,
  voiceConfigMessage = "";
let voiceOutputAbort: AbortController | undefined;
const serverSpeech = new ServerSpeechPlayer(async (text, requestId, signal) => {
  const client = api;
  if (!client) throw new Error("Sign in before requesting reply audio.");
  return client.speech(text, requestId, signal);
});
let transcriptionRequest: TranscriptionRequest | undefined;
let transcriptionJob: TranscriptionJob | undefined;
let transcriptionDevice = "",
  transcriptionMessage = "",
  transcriptionCapabilityAt = 0;
let audioSubmitting = false,
  audioEpoch = 0;
let observedXR = false,
  observedHands = 0,
  observedControllers = 0;
let previousActive = false,
  decisionFingerprint = "";
let artifactPreview: { taskId: string; text: string } | undefined;
type VoiceContext = {
  generation: number;
  epoch: number;
  chatId: string;
  source: "browser" | "provider";
  inputHostId?: string;
  inputConfigIdentity?: string;
  finishing?: boolean;
};
let voiceEpoch = 0,
  voiceContext: VoiceContext | undefined,
  transcriptionVoiceContext: VoiceContext | undefined;
let voiceRequest: { id: string; chatId: string } | undefined;
const completionSpeech = new CompletionSpeechGate();
let completionEnabled = true;
try {
  completionEnabled =
    sessionStorage.getItem("providence.quest.reply-audio") !== "muted";
} catch {
  /* Session preference only. */
}
completionSpeech.setEnabled(completionEnabled);
let suspendedSession: string | null | undefined;
let voiceInputAbort: AbortController | undefined;
let pendingSpeechReplyId = "";
let preparedReply: { key: string; text: string } | undefined;
let spokenReplyId = "",
  voiceMessage = "",
  dictationState = "Not started",
  speechState = "Not started";
let pendingSend: PendingSubmission | undefined;
const microphone = new MicrophoneCapture((state) => {
  micState = state;
  $("mic-status").textContent = state;
  $("record").classList.toggle("recording", state === "Recording");
  if (state === "Recording limit reached") void stopRecording();
  renderCapabilities();
  renderSpatial();
});
const dictation = new BrowserDictation(
  (state) => {
    dictationState = state;
    const presentation = dictationPresentation(state, dictation.active);
    if (voiceContext?.source === "browser" && presentation.clearListening) {
      voiceMessage = "";
      if (presentation.discardContext) voiceContext = undefined;
    }
    renderVoice();
    renderCapabilities();
    renderSpatial();
  },
  (text) => {
    const context = voiceContext;
    if (!context || context.source !== "browser" || !voiceCurrent(context))
      return;
    void submitVoice(text, context);
  },
);
const spokenReply = new BrowserSpeech((state) => {
  speechState = state;
  if (state === "Read-aloud finished.") {
    spokenReplyId = pendingSpeechReplyId;
    pendingSpeechReplyId = "";
  } else if (!spokenReply.active) pendingSpeechReplyId = "";
  renderVoice();
  renderSpatial();
});
function chatName(id = selectedChat) {
  return id === "master"
    ? "Providence"
    : (snapshot.chats.find((chat) => chat.id === id)?.name ?? "Selected chat");
}
function canSend() {
  return (
    dataReady() &&
    !pendingSend &&
    requestReadiness(snapshot, selectedChat).ready
  );
}
function voiceCurrent(context: VoiceContext) {
  return (
    alive &&
    !!api &&
    context.generation === generation &&
    context.epoch === voiceEpoch &&
    (!context.inputConfigIdentity || context.inputConfigIdentity === voiceConfigurationIdentity(voiceConfig)) &&
    context.chatId === selectedChat
  );
}
function voiceInput() {
  return selectVoiceInput(transcriptionCapability, voiceConfig,
    transcriptionRequest?.deviceId ?? voiceContext?.inputHostId);
}
function voiceAvailable() {
  return voiceInput().ready;
}
function resetVoice() {
  completionSpeech.invalidate();
  voiceEpoch++;
  voiceInputAbort?.abort();
  voiceInputAbort = undefined;
  pendingSpeechReplyId = "";
  voiceContext = undefined;
  transcriptionVoiceContext = undefined;
  voiceRequest = undefined;
  spokenReplyId = "";
  dictation.cancel();
  spokenReply.cancel();
  voiceOutputAbort?.abort();
  voiceOutputAbort = undefined;
  serverSpeech.clear();
  preparedReply = undefined;
  microphone.cancel();
  audioSubmitting = false;
  voiceMessage = "";
  $("voice-transcript").textContent = "";
  $("voice-transcript").hidden = true;
  discardAudio();
  dictationState = "Not started";
  speechState = "Not started";
}
function beginVoice() {
  if (
    voiceContext?.finishing ||
    !canSend() ||
    !microphone.enabled ||
    voiceBusy() ||
    microphone.recording ||
    !voiceAvailable()
  )
    return;
  const input = voiceInput();
  resetVoice();
  transcriptionDevice = input.hostId;
  const context: VoiceContext = {
    generation,
    epoch: voiceEpoch,
    chatId: selectedChat,
    source: "provider",
    inputHostId: input.hostId,
    inputConfigIdentity: voiceConfigurationIdentity(voiceConfig),
  };
  voiceContext = context;
  voiceMessage = `Listening for one request to ${actionTarget(snapshot, context.chatId)}.`;
  if (context.source === "browser") dictation.start();
  else {
    try {
      microphone.start();
    } catch (error) {
      fail(error);
    }
  }
  renderVoice();
  renderSpatial();
}
function finishVoice() {
  const context = voiceContext;
  if (!context || !voiceCurrent(context) || context.finishing) return;
  context.finishing = true;
  renderVoice();
  renderSpatial();
  if (context.source === "browser") dictation.stop();
  else void stopRecording();
}
function toggleVoice() {
  if (voiceContext?.finishing) return;
  if (voiceContext) finishVoice();
  else beginVoice();
}
async function activateSpatialVoice() {
  if (!api) { location.assign('/account'); return; }
  if (voiceContext) { toggleVoice(); return; }
  if (!canSend() || voiceBusy() || !voiceAvailable()) return;
  const run = generation;
  try {
    if (!microphone.enabled) {
      await microphone.enable();
      if (!alive || run !== generation) { microphone.disable(); return; }
      micTextOnly = false;
      // Permission makes the microphone available; a fresh tap starts capture.
    } else toggleVoice();
  } catch (error) { fail(error); }
  renderCapabilities(); renderVoice(); renderSpatial();
}
function stopVoice() {
  resetVoice();
  voiceMessage =
    "Voice stopped. Any computer task already submitted keeps running.";
  renderVoice();
  renderCapabilities();
  renderSpatial();
}
async function submitVoice(text: string, context: VoiceContext) {
  if (!voiceCurrent(context)) return;
  // Reserve this utterance before dispatch so duplicate end/result callbacks cannot submit again.
  voiceContext = undefined;
  transcriptionVoiceContext = undefined;
  $("voice-transcript").textContent = text;
  $("voice-transcript").hidden = false;
  voiceMessage = `Sending one voice request to ${chatName(context.chatId)}…`;
  renderVoice();
  renderSpatial();
  const task = await dispatchText(text, context.chatId);
  if (!voiceCurrent(context)) return;
  if (task && task.chatId === context.chatId) {
    voiceRequest = { id: task.id, chatId: context.chatId };
    completionSpeech.arm(task.id, context.chatId);
    spokenReplyId = "";
    voiceMessage = `Voice request sent once to ${chatName(context.chatId)}. Follow the device updates below.`;
  } else
    voiceMessage =
      "Voice submission was not confirmed. Check task status before intentionally retrying; nothing is retried automatically.";
  renderVoice();
  renderSpatial();
  void maybeSpeakCompletion();
}
function setReplyAudio(enabled: boolean) {
  completionEnabled = enabled;
  completionSpeech.setEnabled(enabled);
  try {
    sessionStorage.setItem(
      "providence.quest.reply-audio",
      enabled ? "on" : "muted",
    );
  } catch {
    /* No provider or auth data persisted. */
  }
  if (!enabled) {
    voiceOutputAbort?.abort();
    voiceOutputAbort = undefined;
    spokenReply.cancel();
    serverSpeech.cancel();
    pendingSpeechReplyId = "";
    speechState = "Replies muted. Device work continues.";
  } else
    speechState =
      "Reply audio enabled for your next voice request. Current text remains available.";
  renderVoice();
  renderSpatial();
}
async function maybeSpeakCompletion() {
  if (
    !alive ||
    document.hidden ||
    !completionEnabled ||
    !dataReady() ||
    !voiceRequest ||
    voiceRequest.chatId !== selectedChat ||
    caps.arranging ||
    (caps.active && caps.focused === false) ||
    voiceBusy() ||
    microphone.recording ||
    spokenReply.active ||
    serverSpeech.active
  )
    return;
  const reply = voiceReply(snapshot, voiceRequest.id);
  if (!reply || reply.id === spokenReplyId || !replyPlaybackAvailable(reply))
    return;
  // Reserve before any provider request or playback promise. Failure is not auto-retried.
  if (!completionSpeech.claim(voiceRequest.id, selectedChat, reply.id)) return;
  await readVoiceReply(true);
}
function preparedReplyText(reply: NonNullable<ReturnType<typeof voiceReply>>) {
  const key = speechReplyKey(reply);
  // Reply audio is cached against this exact string. A device name or work
  // status that moves on afterwards must not strand the audio prepared for it.
  if (preparedReply?.key === key) return preparedReply.text;
  const parent = snapshot.tasks.find((task) => task.id === voiceRequest?.id);
  const status = parent?.workStatus ?? parent?.status;
  let text =
    `${status && status !== "completed" ? `Work status: ${status}. ` : ""}${reply.deviceName ? `${reply.deviceName}: ` : ""}${reply.text}`.slice(
      0,
      // Same audio cap reasoning as MAX_VOICE_REPLY_CHARS in web/src/browser-voice.ts.
      3400,
    );
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  preparedReply = { key, text };
  return text;
}
function speechReplyKey(reply: NonNullable<ReturnType<typeof voiceReply>>) {
  return `${voiceRequest?.id ?? ""}:${reply.id}`;
}
function replyPlaybackAvailable(reply: ReturnType<typeof voiceReply>) {
  if (!reply || !voiceConfig) return false;
  return voiceConfig.speechConfigured
    ? serverSpeech.canPlay(speechReplyKey(reply), preparedReplyText(reply))
    : spokenReply.available();
}
async function readVoiceReply(automatic = false) {
  if (!automatic) completionSpeech.invalidate();
  if (!completionEnabled || document.hidden) return;
  if (
    !voiceRequest ||
    voiceRequest.chatId !== selectedChat ||
    voiceBusy() ||
    microphone.recording ||
    spokenReply.active ||
    serverSpeech.active
  )
    return;
  const reply = voiceReply(snapshot, voiceRequest.id);
  if (!reply || reply.id === spokenReplyId || !replyPlaybackAvailable(reply))
    return;
  dictation.cancel();
  microphone.cancel();
  const text = preparedReplyText(reply);
  pendingSpeechReplyId = reply.id;
  if (!voiceConfig!.speechConfigured) {
    spokenReply.speak(text);
    renderVoice();
    renderSpatial();
    return;
  }
  const client = api,
    run = generation,
    epoch = voiceEpoch,
    chat = selectedChat;
  const controller = new AbortController();
  voiceOutputAbort = controller;
  const current = () =>
    alive &&
    api === client &&
    generation === run &&
    voiceEpoch === epoch &&
    selectedChat === chat &&
    !controller.signal.aborted;
  try {
    await serverSpeech.play(
      speechReplyKey(reply),
      text,
      controller.signal,
      (state) => {
        if (current()) {
          speechState =
            state === "preparing"
              ? `Preparing ${voiceConfig!.provider} reply audio…`
              : "Reading response aloud.";
          renderVoice();
          renderSpatial();
        }
      },
    );
    if (current()) {
      spokenReplyId = reply.id;
      pendingSpeechReplyId = "";
      speechState = "Read-aloud finished.";
    }
  } catch (error) {
    if (current()) {
      pendingSpeechReplyId = "";
      speechState =
        error instanceof SpeechPlaybackError && error.canReplay
          ? serverSpeech.hasAudio(speechReplyKey(reply), text)
            ? "Reply audio was downloaded but playback failed. Select Read new reply to replay that audio without another speech request."
            : "The reply audio request was refused before synthesis. Select Read new reply to ask for it again."
          : "Server reply audio was not returned. No retry or browser fallback was made; use the text response.";
    }
  } finally {
    if (voiceOutputAbort === controller) voiceOutputAbort = undefined;
    if (current()) {
      renderVoice();
      renderSpatial();
    }
  }
}
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(label: string, onClick: () => void, className = "") {
  const b = element("button", label, className);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}
function notice(text: string) {
  $("notice").textContent = text;
  lastError = text;
  renderSpatial();
}
function fail(error: unknown) {
  notice(
    error instanceof Error
      ? error.message
      : "The request could not be completed.",
  );
}
function taskTitle(t: Task) {
  return t.prompt || "Task";
}
function stateLine(t: Task) {
  return `Response: ${t.status}${t.workStatus ? ` · Delegated work: ${t.workStatus}` : ""}`;
}
function currentProgress(t: Task) {
  return t.progress &&
    t.progress.kind !== "result" &&
    t.progress.text !== t.text
    ? t.progress.text
    : "";
}
function active(t: Pick<Task, "status">) {
  return ["queued", "running", "needs_input"].includes(t.status);
}
function selected() {
  return snapshot.tasks.find((t) => t.id === selectedTask);
}
function deviceName(id: string) {
  return snapshot.devices.find((d) => d.id === id)?.name ?? (id === "coordinator" ? "Providence" : "Disconnected computer");
}
function selectTask(id: string) {
  selectedTask = id;
  artifactPreview = undefined;
  renderWorkspace();
  const client = api;
  if (client && !snapshot.tasks.some((t) => t.id === id))
    void client
      .task(id)
      .then((t) => {
        if (client !== api) return;
        snapshot.tasks.push(t);
        renderWorkspace();
      })
      .catch(fail);
}
function selectChat(id: string) {
  if (id !== selectedChat) resetVoice();
  selectedChat = id;
  selectedTask = "";
  renderWorkspace();
}
function chooseDevice(id: string) {
  selectedDevice = selectedDevice === id ? "" : id;
  renderWorkspace();
}
function dataReady() {
  return alive && !!api && !!syncedAt && !busy;
}
function renderCapabilities() {
  const values = [
    ["Transport", isSecureContext ? "Secure context" : "HTTPS required"],
    ["Immersive VR", vrSupported ? "Available" : "Unavailable"],
    ["Microphone", micState],
    [
      "Hand sources",
      caps.active
        ? `${caps.hands} live`
        : observedXR
          ? `${observedHands} seen in XR`
          : "Enter XR to check",
    ],
    [
      "Controller sources",
      caps.active
        ? `${caps.controllers} live`
        : observedXR
          ? `${observedControllers} seen in XR`
          : "Enter XR to check",
    ],
    ["Selections", `${caps.selections} in this tab`],
    [
      "Voice input",
      voiceInput().ready ? "Cloud transcription ready" : api && !voiceConfig && !voiceConfigMessage ? "Checking voice…" : "Unavailable",
    ],
    [
      "Reply audio",
      voiceConfig?.speechConfigured
        ? `${voiceConfig.provider} configured; test on headset`
        : voiceConfig
          ? spokenReply.available()
            ? "Browser detected; test on headset"
            : "Unavailable"
          : "Checking server voice",
    ],
  ];
  $("capabilities").replaceChildren(
    ...values.map(([label, value]) => {
      const box = element("div", undefined, "cap");
      box.append(element("strong", label), element("span", value));
      return box;
    }),
  );
  $<HTMLButtonElement>("enter-vr").disabled = !vrSupported;
  $<HTMLButtonElement>("enter-ar").disabled = !arSupported;
  $("enter-ar").hidden = !arSupported;
  $("arrange-panels").textContent = caps.arranging
    ? "Done arranging"
    : "Arrange panels";
  $("arrange-panels").setAttribute("aria-pressed", String(!!caps.arranging));
  $("xr-note").textContent = vrSupported
    ? "Enter, then select the sphere to speak. Microphone access is optional."
    : "Use the full workspace below in this browser.";
  $<HTMLButtonElement>("record").disabled = !microphone.enabled || voiceBusy();
}
function renderPendingRecovery() {
  $("pending-recovery").hidden = !pendingSend || busy;
  if (!pendingSend) return;
  const name =
    pendingSend.chatId === "master"
      ? "Providence"
      : (snapshot.chats.find((chat) => chat.id === pendingSend!.chatId)?.name ??
        "Original registered chat");
  $("pending-destination").textContent =
    `Original destination: ${name}. Inspect its task before intentionally retrying.`;
  $("pending-text").textContent = pendingSend.text;
  $<HTMLButtonElement>("retry-pending").disabled =
    !dataReady() || voiceBusy() || microphone.recording;
  $<HTMLButtonElement>("inspect-pending").disabled = !dataReady();
  $<HTMLButtonElement>("dismiss-pending").disabled = busy;
}
function renderWorkspace() {
  renderPendingRecovery();
  $("login").hidden = !!api;
  $("legacy-login").hidden = hostedService;
  $("account-signin").hidden = !!api || !hostedService;
  $("signout").hidden = !api;
  $("signout").textContent = api?.accountSession ? "Account" : "Sign out";
  $("connection").textContent = api
    ? syncedAt
      ? `Connected · refreshed ${new Date(syncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "Connecting…"
    : "Not connected";
  $<HTMLButtonElement>("send").disabled =
    !canSend() || voiceBusy() || microphone.recording;
  $("send").textContent = `Send to ${chatName()}`;
  const readiness = requestReadiness(snapshot, selectedChat);
  $("destination-note").textContent = !api
    ? "Sign in to use Providence on your computers."
    : !syncedAt
      ? "Connection unavailable. Requests are paused."
      : pendingSend
        ? "Recover the unconfirmed request above before starting another request."
        : readiness.reason === "offline"
          ? `Action target: ${actionTarget(snapshot, selectedChat)} is offline in Providence. This selection is kept while it reconnects.`
          : readiness.reason === "working"
            ? `${chatName()} is working or needs your input. Follow its task below.`
            : readiness.reason === "missing-chat"
              ? `Action target: ${actionTarget(snapshot, selectedChat)}. Its selection is kept; choose another conversation explicitly if needed.`
              : `Action target: ${actionTarget(snapshot, selectedChat)}`;
  $("device-count").textContent = api && syncedAt
    ? `${snapshot.devices.filter((d) => d.online).length} connected`
    : "Status unavailable";
  $("devices").replaceChildren(
    ...snapshot.devices.map((d) => {
      const card = element("section", undefined, "stack");
      const b = button(
        "",
        () => chooseDevice(d.id),
        `device${selectedDevice === d.id ? " selected" : ""}`,
      );
      b.append(
        element("strong", `${selectedDevice === d.id ? "Inspecting" : "Inspect"} ${d.name}`),
        element(
          "span",
          `${deviceConnection(d, !!api && !!syncedAt)} · ${d.platform ?? "platform unknown"}${d.hostname ? ` · ${d.hostname}` : ""}`,
          "task-meta",
        ),
      );
      const enabled = Object.entries(d.capabilities ?? {})
        .filter(([, v]) => v === true)
        .map(([k]) => k)
        .join(", ");
      b.append(
        element("span", enabled || "Capabilities not reported", "task-meta"),
      );
      b.setAttribute("aria-pressed", String(selectedDevice === d.id));
      card.append(b, element("small", "Task activity available · screen sharing not available", "screen-availability"));
      const chats = snapshot.chats.filter((chat) => chat.deviceId === d.id);
      for (const chat of chats) {
        const use = button(`${selectedChat === chat.id ? "Selected" : "Use"}: ${chat.name}`,
          () => selectChat(chat.id), selectedChat === chat.id ? "primary" : "subtle");
        use.setAttribute("aria-pressed", String(selectedChat === chat.id));
        card.append(use);
      }
      if (!chats.length) card.append(element("small", "No registered conversation for this computer."));
      return card;
    }),
  );
  if (!snapshot.devices.length)
    $("devices").append(
      element(
        "p",
        api ? "Add a computer in Devices to bring it into your space." : "Sign in to see your computers here.",
        "empty",
      ),
    );
  const chatSelect = $<HTMLSelectElement>("chat-select");
  const choices = targetOptions(snapshot, selectedChat, !!api && !!syncedAt);
  const chatSignature = JSON.stringify(choices);
  if (chatSelect.dataset.signature !== chatSignature) {
    chatSelect.dataset.signature = chatSignature;
    chatSelect.replaceChildren(...choices.map((choice) => new Option(choice.label, choice.id)));
  }
  chatSelect.value = selectedChat;
  $("conversation-title").textContent =
    selectedChat === "master"
      ? "Providence"
      : (snapshot.chats.find((c) => c.id === selectedChat)?.name ??
        "Conversation");
  const tasks = snapshot.tasks
    .filter((t) => t.chatId === selectedChat)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $("tasks").replaceChildren(
    ...tasks.slice(0, 8).map((t) => {
      const b = button(
        "",
        () => selectTask(t.id),
        `task${selectedTask === t.id ? " selected" : ""}`,
      );
      b.append(
        element("strong", taskTitle(t).slice(0, 150)),
        element("span", stateLine(t), "task-meta"),
      );
      return b;
    }),
  );
  if (!tasks.length)
    $("tasks").append(
      element(
        "p",
        api
          ? "Your next request starts here."
          : "Sign in to direct work and review its results.",
        "empty",
      ),
    );
  if (!selectedTask && tasks[0]) selectedTask = tasks[0].id;
  renderDecisions();
  renderResult();
  renderVoice();
  renderSpatial();
}
function renderDecisions() {
  const approvals = snapshot.approvals.filter((a) => a.status === "pending");
  const fingerprint = JSON.stringify([approvals, dataReady()]);
  if (fingerprint === decisionFingerprint) return;
  decisionFingerprint = fingerprint;
  const savedAnswers = new Map(
    [
      ...$("decisions").querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        "input, select",
      ),
    ].map((input) => [input.id, input.value]),
  );
  $("decisions").replaceChildren(
    ...approvals.map((a) => {
      const card = element("section", undefined, "decision stack");
      card.append(
        element("strong", `Decision · ${deviceName(a.deviceId)}`),
        element("small", `Task ${a.taskId}`),
      );
      const task = snapshot.tasks.find((t) => t.id === a.taskId);
      if (task) card.append(element("p", task.prompt));
      if (
        a.method === "item/tool/requestUserInput" &&
        a.details.questions?.length
      ) {
        const form = element("form", undefined, "stack");
        const fields = new Map<string, HTMLSelectElement | HTMLInputElement>();
        for (const q of a.details.questions) {
          const label = element("label", q.question);
          const input = q.options?.length
            ? element("select")
            : element("input");
          input.required = true;
          input.id = `answer-${a.id}-${q.id}`;
          label.htmlFor = input.id;
          if (input instanceof HTMLSelectElement) {
            input.append(new Option("Choose an answer", ""));
            q.options!.forEach((o) =>
              input.append(
                new Option(
                  o.label + (o.description ? ` — ${o.description}` : ""),
                  o.label,
                ),
              ),
            );
          } else input.type = q.isSecret ? "password" : "text";
          input.value = savedAnswers.get(input.id) ?? "";
          fields.set(q.id, input);
          form.append(label, input);
        }
        const submit = element("button", "Submit this decision", "primary");
        submit.type = "submit";
        submit.disabled = !dataReady();
        form.append(submit);
        form.onsubmit = (e) => {
          e.preventDefault();
          const answers = Object.fromEntries(
            [...fields].map(([id, input]) => [id, { answers: [input.value] }]),
          );
          void decide(a, { answers });
        };
        card.append(form);
      } else {
        card.append(element("pre", JSON.stringify(a.details, null, 2)));
        if (
          [
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
          ].includes(a.method)
        ) {
          const row = element("div", undefined, "row");
          for (const decision of ["accept", "decline", "cancel"]) {
            const b = button(
              decision === "accept"
                ? "Approve this action"
                : decision === "decline"
                  ? "Decline"
                  : "Cancel task",
              () => void decide(a, { decision }),
              decision === "accept" ? "primary" : "",
            );
            b.disabled = !dataReady();
            row.append(b);
          }
          card.append(row);
        } else
          card.append(
            element(
              "p",
              "Open this decision in the main workspace; its format is not supported here.",
            ),
          );
      }
      return card;
    }),
  );
  if (!approvals.length)
    $("decisions").append(element("p", "No pending decisions.", "muted"));
}
function renderResult() {
  const node = $("selected-task");
  const expandedReply = node.querySelector<HTMLDetailsElement>(
    "details[data-task-reply]",
  );
  const expandedReplyTask = expandedReply?.open
    ? expandedReply.dataset.taskReply
    : undefined;
  node.replaceChildren();
  const task = selected();
  if (!task) {
    node.append(
      element(
        "p",
        "Select a task to inspect its response and returned files.",
        "empty",
      ),
    );
    return;
  }
  const updates = taskUpdates(task);
  node.append(
    element("div", deviceName(task.deviceId), "eyebrow"),
    element("h3", stateLine(task)),
    element("small", `Task ${task.id}`),
  );
  if (currentProgress(task))
    node.append(element("p", currentProgress(task), "muted"));
  if (updates.children.length) {
    node.append(element("h3", "Latest device updates"));
    for (const child of updates.children) {
      const card = element("section", undefined, "result stack");
      const [heading, ...lines] = childUpdateLines(child);
      card.append(
        element("strong", heading),
        element("small", `Task ${child.id} · ${child.updatedAt}`),
        element("p", lines.join("\n"), "output"),
        button(`Open ${child.deviceName} task`, () => selectTask(child.id)),
      );
      if (active(child)) {
        const stop = button(`Stop ${child.deviceName} task`, () => void cancel(child), "danger");
        stop.disabled = !dataReady(); card.append(stop);
      }
      node.append(card);
    }
  }
  if (updates.coverageNote)
    node.append(element("p", updates.coverageNote, "muted"));
  const response = element(
    "p",
    task.text || task.error || "Waiting for a response…",
    "output",
  );
  if (updates.coordinatorLabel === "Earlier coordinator reply") {
    const previous = element("details");
    previous.dataset.taskReply = task.id;
    previous.open = expandedReplyTask === task.id;
    previous.append(element("summary", updates.coordinatorLabel), response);
    node.append(previous);
  } else {
    if (updates.children.length)
      node.append(element("h3", updates.coordinatorLabel));
    node.append(response);
  }
  if (task.error && task.text) node.append(element("p", task.error, "message"));
  if (active(task)) {
    const b = button("Stop this task", () => void cancel(task), "danger");
    b.disabled = !dataReady();
    node.append(b);
  }
  const shownChildren = new Set(updates.children.map((child) => child.id));
  const otherChildren = (task.childTaskIds ?? []).filter(
    (id) => !shownChildren.has(id),
  );
  if (otherChildren.length) {
    node.append(
      element(
        "h3",
        updates.children.length ? "Other delegated tasks" : "Delegated work",
      ),
    );
    for (const id of otherChildren) {
      const child = snapshot.tasks.find((t) => t.id === id);
      node.append(
        button(
          child
            ? `${deviceName(child.deviceId)} · ${child.status}`
            : `Open task ${id}`,
          () => selectTask(id),
        ),
      );
    }
  }
  if (artifactPreview?.taskId === task.id)
    node.append(element("pre", artifactPreview.text, "output"));
  for (const a of task.artifacts ?? []) {
    const item = element("div", undefined, "result stack");
    item.append(
      element("strong", a.name),
      element(
        "small",
        `Verified snapshot · revision ${a.revision} · ${a.size} bytes`,
      ),
      element("code", `SHA-256 ${a.sha256}`),
    );
    const b = button("Open returned file", () => void openArtifact(a));
    b.disabled = !dataReady();
    item.append(b);
    node.append(item);
  }
}
async function refresh() {
  const client = api,
    run = generation;
  if (!client || !alive) return;
  try {
    const next = await client.snapshot();
    const retainedId = selectedTask;
    if (retainedId && !next.tasks.some((task) => task.id === retainedId)) {
      try {
        next.tasks.push(await client.task(retainedId));
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
    }
    if (api !== client || generation !== run) return;
    snapshot = next;
    syncedAt = new Date().toISOString();
    renderWorkspace();
    void maybeSpeakCompletion();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    if (api === client && generation === run) {
      if (error instanceof ApiError && error.status === 401) authClear();
      else {
        if (syncedAt) resetVoice();
        syncedAt = "";
        renderWorkspace();
      }
      fail(error);
    }
  }
}
async function withAction(operation: () => Promise<void>) {
  if (!dataReady()) return;
  const client = api,
    run = generation;
  busy = true;
  renderWorkspace();
  try {
    await operation();
  } catch (e) {
    if (api === client && generation === run) fail(e);
  } finally {
    if (api === client && generation === run) {
      busy = false;
      await refresh();
      renderWorkspace();
    }
  }
}
async function decide(
  approval: Approval,
  body: { decision?: string; answers?: Record<string, { answers: string[] }> },
) {
  if (
    !snapshot.approvals.some(
      (a) =>
        a.id === approval.id &&
        a.taskId === approval.taskId &&
        a.status === "pending",
    )
  )
    return notice(
      "This decision is no longer pending. Refresh before choosing again.",
    );
  await withAction(async () => {
    await api!.decide(approval.id, body);
    notice("Decision submitted for this task.");
  });
}
async function cancel(task: Pick<Task, "id">) {
  await withAction(async () => {
    await api!.cancel(task.id);
    notice(
      "Stop requested. Earlier changes may remain; watch this task for its final state.",
    );
  });
}
async function dispatchText(
  text: string,
  chat: string,
): Promise<Task | undefined> {
  if (!dataReady() || !text.trim()) return;
  // An explicit exact retry may resolve an already-running request by its original ID.
  const exactRetry = pendingSend?.text === text && pendingSend.chatId === chat;
  if (!exactRetry && !requestReadiness(snapshot, chat).ready) return;
  const client = api!,
    run = generation;
  let submission: PendingSubmission;
  try {
    submission = submissionForSend(pendingSend, text, chat, () =>
      crypto.randomUUID(),
    );
  } catch (error) {
    fail(error);
    return;
  }
  pendingSend = submission;
  sessionStorage.setItem(
    "providence.quest.pending",
    JSON.stringify(submission),
  );
  let accepted: Task | undefined;
  await withAction(async () => {
    const task = await client.send(text, chat, submission.requestId);
    if (api !== client || generation !== run) return;
    if (
      !task || typeof task !== "object" || typeof task.id !== "string" ||
      !task.id.trim() || task.id.length > 256 || !("requestId" in task) ||
      task.requestId !== submission.requestId || task.chatId !== submission.chatId
    ) {
      throw new Error(
        "The coordinator acknowledgement did not match the submitted request. Its original identity is retained for recovery.",
      );
    }
    accepted = task;
    if (selectedChat === chat) selectedTask = task.id;
    if (pendingSend === submission) {
      pendingSend = undefined;
      sessionStorage.removeItem("providence.quest.pending");
    }
    notice(
      "Request received. Follow its response and delegated work separately.",
    );
  });
  return accepted;
}
async function sendMessage(source: "message" | "transcript" = "message") {
  if (!canSend() || voiceBusy() || microphone.recording) return;
  const input = $<HTMLTextAreaElement>(source),
    text = input.value.trim(),
    chat = selectedChat;
  if (!text) return;
  const task = await dispatchText(text, chat);
  if (task && input.value.trim() === text) {
    input.value = "";
    if (source === "transcript") {
      discardAudio();
      voiceRequest = { id: task.id, chatId: chat };
      spokenReplyId = "";
    }
  }
  renderVoice();
  renderSpatial();
}
async function openArtifact(a: Artifact) {
  const client = api;
  if (!client) return;
  try {
    const { blob } = await client.artifact(a.id);
    if (client !== api) return;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      await blob.arrayBuffer(),
    );
    const hash = [...new Uint8Array(digest)]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    if (client !== api) return;
    if (hash !== a.sha256)
      throw new Error(
        "Returned file did not match its verified snapshot hash.",
      );
    if (a.mime.startsWith("text/") || a.mime === "application/json") {
      // ceiling: the same preview cap the web client applies. The spatial panel
      // re-wraps its text character by character on every poll, so an unbounded
      // preview would be measured again every 1.5 seconds.
      const content = (await blob.text()).slice(0, 100_000);
      if (client !== api) return;
      artifactPreview = { taskId: a.taskId, text: content };
      renderResult();
      renderSpatial();
      if (!caps.active)
        $("selected-task").scrollIntoView({ behavior: "smooth" });
    } else {
      const url = URL.createObjectURL(blob);
      const link = element("a");
      link.href = url;
      link.download = a.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      notice(`Downloaded ${a.name}.`);
    }
  } catch (e) {
    fail(e);
  }
}
function voiceBusy() {
  return (
    audioSubmitting ||
    transcriptionJob?.status === "pending" ||
    dictation.active
  );
}
function canTranscribe() {
  return (
    !!api &&
    !!syncedAt &&
    !!recordedBlob &&
    !voiceBusy() &&
    !transcriptionJob &&
    voiceInput().ready && voiceInput().hostId === transcriptionDevice
  );
}
function renderVoice() {
  const capability = transcriptionCapability;
  const input = voiceInput();
  transcriptionDevice = input.hostId;
  $<HTMLButtonElement>("transcribe").disabled = !canTranscribe();
  $<HTMLButtonElement>("discard-audio").disabled = voiceBusy();
  $<HTMLButtonElement>("record").disabled = !microphone.enabled || voiceBusy();
  $("record").textContent = input.ready
    ? "Hold to record request"
    : "Hold to record a mic test";
  $<HTMLTextAreaElement>("transcript").disabled = voiceBusy();
  const transcript = $<HTMLTextAreaElement>("transcript").value.trim();
  $("transcript-review").hidden =
    !transcript && transcriptionJob?.status !== "completed";
  $<HTMLButtonElement>("send-transcript").disabled =
    !canSend() || !transcript || voiceBusy() || microphone.recording;
  const destinationName =
    selectedChat === "master"
      ? "Providence"
      : (snapshot.chats.find((c) => c.id === selectedChat)?.name ??
        "selected conversation");
  $("send-transcript").textContent = `Send transcript to ${destinationName}`;
  $("transcription-status").textContent = transcriptionMessage;
  const holding = !!voiceContext && !voiceContext.finishing && (dictation.active || microphone.recording);
  $<HTMLButtonElement>("talk").disabled = !holding && (
    !!voiceContext?.finishing || !canSend() || !microphone.enabled || voiceBusy() || microphone.recording || !voiceAvailable()
  );
  $("talk-label").textContent = holding ? "Tap to stop and send" : "Tap to speak";
  $("talk").setAttribute("aria-label", holding ? "Tap to stop recording and send this voice request" : `Tap to speak to ${actionTarget(snapshot, selectedChat)}`);
  $("talk").setAttribute("aria-pressed", String(holding));
  $("talk").classList.toggle("recording", holding);
  $<HTMLButtonElement>("stop-voice").disabled =
    !voiceContext &&
    !voiceRequest &&
    !voiceBusy() &&
    !microphone.recording &&
    !spokenReply.active &&
    !serverSpeech.active;
  const reply =
    voiceRequest?.chatId === selectedChat
      ? voiceReply(snapshot, voiceRequest.id)
      : undefined;
  $<HTMLButtonElement>("read-reply").disabled =
    !completionEnabled ||
    !reply ||
    reply.id === spokenReplyId ||
    !replyPlaybackAvailable(reply) ||
    spokenReply.active ||
    serverSpeech.active ||
    voiceBusy() ||
    microphone.recording;
  $("mute-replies").textContent = completionEnabled
    ? "Mute replies"
    : "Unmute replies";
  $("mute-replies").setAttribute("aria-pressed", String(!completionEnabled));
  $("completion-note").textContent = completionEnabled
    ? "New voice requests speak once when all their linked work finishes. Manual playback retry never re-sends the task."
    : "Reply audio is muted. Unmuting applies to your next voice request; nothing missed is read automatically.";
  $("browser-voice-status").textContent = [
    voiceMessage,
    voiceConfigMessage,
    dictationPresentation(dictationState, dictation.active).text,
    speechState !== "Not started" ? speechState : "",
  ]
    .filter(Boolean)
    .join(" ");
  const checkingVoice = !!api && !voiceConfig && !voiceConfigMessage;
  $("voice-note").textContent = checkingVoice ? "Checking voice…" : input.ready
    ? "Record on this device, then send the audio to Providence's approved cloud transcription service. Your action target stays separate."
    : "Cloud transcription is unavailable. Nothing is routed to another service; text requests remain available.";
  $("voice-note").textContent += voiceConfig?.speechConfigured
    ? ` Reply audio uses ${voiceConfig.provider} AI-generated voice.`
    : voiceConfig
      ? " Reply audio uses synthetic browser speech when available."
      : " Server reply-voice configuration has not been confirmed.";
  const presentation = voicePresentation({
    snapshot, taskId: voiceRequest?.id, chatId: selectedChat,
    capturing: holding,
    transcribing: audioSubmitting || transcriptionJob?.status === "pending" ||
      (!!voiceContext && !holding),
    dispatching: busy && !!$("voice-transcript").textContent,
    speaking: speechState === "Reading response aloud.",
    transcript: $("voice-transcript").textContent ?? "",
  });
  const state = presentation.state === "capturing" ? "recording"
    : presentation.state === "transcribing" ? "transcribing"
    : presentation.state === "speaking" ? "speaking"
    : ["dispatching", "working", "needs-input"].includes(presentation.state) ? "working"
    : $<HTMLButtonElement>("talk").disabled ? "unavailable" : "ready";
  $("voice-stage").dataset.state = state;
  $("voice-stage-status").textContent = presentation.state !== "idle" ? presentation.status
    : !api ? "Sign in to Providence to begin."
    : !syncedAt ? "Reconnecting. Your target selection is kept."
    : checkingVoice ? "Checking voice…"
    : !microphone.enabled ? "Enable the microphone above, then tap the circle."
    : !voiceAvailable() ? "Voice input is unavailable. Check Voice settings or type instead."
    : !canSend() ? $("destination-note").textContent ?? "Waiting for the current request."
    : "Tap to speak. Tap again to stop and send. Your response will play here.";
  const spatialTalk = $<HTMLButtonElement>("spatial-talk");
  if (spatialTalk) {
    spatialTalk.disabled = !!api && !holding && (!canSend() || voiceBusy() || !voiceAvailable());
    spatialTalk.textContent = !api ? "Sign in to Providence" : holding ? "Stop & send" : !microphone.enabled ? "Enable microphone" : "Speak to Providence";
    spatialTalk.setAttribute("aria-pressed", String(holding));
    $("spatial-voice-status").textContent = $("voice-stage-status").textContent;
  }
  $("voice-transcript-placeholder").hidden = !!presentation.transcript;
  $("voice-transcript-placeholder").textContent = presentation.transcriptPlaceholder;
  $("voice-response-text").textContent = presentation.response?.text ?? (
    presentation.state === "working" || presentation.state === "dispatching"
      ? "Working on your request…"
      : presentation.state === "needs-input" ? "A decision is needed. Review the decision panel."
      : "Your response will appear here.");
  $("voice-response-source").textContent = presentation.response
    ? `${presentation.response.deviceName ?? "Providence"} · ${presentation.response.taskId}` : "";
  $("voice-provider-summary").textContent = !api ? "Sign in to use voice." : checkingVoice ? "Checking voice…" : `${input.ready ? "Cloud transcription after recording" : "Cloud transcription unavailable"} · ${voiceConfig?.speechConfigured ? `${voiceConfig.provider} spoken replies` : "Reply voice unavailable"}`;

}
function acceptTranscription(job: TranscriptionJob) {
  transcriptionJob = job;
  if (job.status === "completed" && transcriptionVoiceContext) {
    const context = transcriptionVoiceContext;
    transcriptionVoiceContext = undefined;
    if (voiceCurrent(context)) void submitVoice(job.text, context);
  } else if (job.status === "completed") {
    $<HTMLTextAreaElement>("transcript").value = job.text;
    transcriptionMessage =
      "Transcript ready for review. No computer request has been sent.";
  } else if (job.status === "pending")
    transcriptionMessage =
      "Transcribing through the selected device. No computer request has been sent.";
  else
    transcriptionMessage = `${job.error ?? `Transcription ${job.status}.`} No automatic retry was made. Record a new clip to try again.`;
  renderVoice();
  renderSpatial();
}
function invalidateVoiceConfiguration() {
  completionSpeech.invalidate();
  voiceEpoch++;
  voiceInputAbort?.abort();
  voiceInputAbort = undefined;
  voiceOutputAbort?.abort();
  voiceOutputAbort = undefined;
  voiceContext = undefined;
  transcriptionVoiceContext = undefined;
  pendingSpeechReplyId = "";
  // Clearing cached audio also ends eligibility for the old accepted reply:
  // configuration recovery must never issue another paid request for it.
  voiceRequest = undefined;
  dictation.cancel();
  spokenReply.cancel();
  serverSpeech.clear();
  preparedReply = undefined;
  microphone.cancel();
  audioSubmitting = false;
  discardAudio();
  dictationState = "Not started";
  speechState = "Not started";
  voiceMessage =
    "Voice configuration changed or became unavailable. Capture and reply playback stopped; task text remains available and accepted computer tasks are unchanged.";
}
async function refreshVoiceConfiguration() {
  const client = api,
    run = generation;
  if (!client || !alive || Date.now() - voiceConfigAt <= 15000) return;
  voiceConfigAt = Date.now();
  try {
    const config = await client.voiceConfig(AbortSignal.timeout(10000));
    if (api !== client || generation !== run) return;
    if (
      voiceConfig &&
      voiceConfigurationIdentity(voiceConfig) !==
        voiceConfigurationIdentity(config)
    )
      invalidateVoiceConfiguration();
    voiceConfig = config;
    voiceConfigMessage = config.speechConfigured
      ? ""
      : config.reason === "voice_id_required"
        ? "Server reply voice has not been selected. Browser read-aloud remains available where supported."
        : "";
  } catch {
    if (api === client && generation === run) {
      // The first failed lookup must also retire accepted or in-flight voice
      // eligibility; later configuration recovery cannot speak that old request.
      invalidateVoiceConfiguration();
      voiceConfig = undefined;
      voiceConfigMessage =
        "Server reply-voice configuration could not be read. Text remains available.";
    }
  }
  if (api === client && generation === run) {
    renderVoice();
    renderCapabilities();
    renderSpatial();
    void maybeSpeakCompletion();
  }
}
async function refreshTranscription() {
  const client = api,
    run = generation;
  if (!client || !alive) return;
  void refreshVoiceConfiguration();
  if (Date.now() - transcriptionCapabilityAt > 15000) {
    transcriptionCapabilityAt = Date.now();
    try {
      const capability = await client.transcriptionCapabilities(
        AbortSignal.timeout(10000),
      );
      if (api === client && generation === run) {
        const previous = transcriptionCapability?.devices.find(
          (device) => device.id === transcriptionDevice,
        );
        const next = capability.devices.find(
          (device) => device.id === transcriptionDevice,
        );
        if (
          previous &&
          JSON.stringify([
            previous.provider,
            previous.configured,
            previous.online,
          ]) !==
            JSON.stringify([next?.provider, next?.configured, next?.online])
        )
          invalidateVoiceConfiguration();
        transcriptionCapability = capability;
      }
    } catch {
      if (api === client && generation === run) {
        if (transcriptionCapability) invalidateVoiceConfiguration();
        transcriptionCapability = undefined;
      }
    }
  }
  if (api !== client || generation !== run) return;
  const job = transcriptionJob;
  if (job?.status === "pending") {
    try {
      const result = await client.transcriptionJob(
        job.id,
        AbortSignal.timeout(10000),
      );
      if (
        result.requestId !== job.requestId ||
        result.deviceId !== job.deviceId
      )
        throw new Error("Transcription identity mismatch");
      if (
        api === client &&
        generation === run &&
        transcriptionJob?.id === job.id
      )
        acceptTranscription(result);
    } catch {
      if (api === client && generation === run)
        transcriptionMessage =
          "Waiting to recover the transcription status. Audio will not be uploaded again automatically.";
    }
  }
  if (api === client && generation === run) {
    renderVoice();
    renderSpatial();
  }
}
async function transcribeRecording(context?: VoiceContext) {
  if (!canTranscribe() || !recordedBlob || !api) return;
  const client = api,
    run = generation,
    epoch = audioEpoch,
    blob = recordedBlob,
    device = context?.inputHostId ?? transcriptionDevice;
  if (context && (!voiceCurrent(context) || device !== transcriptionDevice)) return;
  transcriptionVoiceContext = context;
  const controller = new AbortController();
  voiceInputAbort = controller;
  const timeout = setTimeout(() => controller.abort(), 15000);
  audioSubmitting = true;
  transcriptionMessage = "Preparing this recording for transcription…";
  renderVoice();
  renderSpatial();
  try {
    const request =
      transcriptionRequest ?? (await prepareTranscription(blob, device));
    if (api !== client || generation !== run || epoch !== audioEpoch) return;
    transcriptionRequest = request;
    const job = await client.transcribe(request, controller.signal);
    if (api !== client || generation !== run || epoch !== audioEpoch) return;
    acceptTranscription(job);
  } catch (error) {
    if (api === client && generation === run && epoch === audioEpoch)
      transcriptionMessage = `${error instanceof Error ? error.message : "Transcription could not be submitted."} No automatic retry was made. Selecting Transcribe again reuses this recording's request ID.`;
  } finally {
    clearTimeout(timeout);
    if (voiceInputAbort === controller) voiceInputAbort = undefined;
    if (api === client && generation === run && epoch === audioEpoch) {
      audioSubmitting = false;
      renderVoice();
      renderSpatial();
    }
  }
}
function discardAudio() {
  audioEpoch++;
  $<HTMLTextAreaElement>("transcript").value = "";
  transcriptionMessage = "";
  recordedBlob = undefined;
  transcriptionRequest = undefined;
  transcriptionJob = undefined;
  if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  recordingUrl = "";
  $<HTMLAudioElement>("recorded-audio").removeAttribute("src");
  $("recording-preview").hidden = true;
}
function startRecording() {
  if (voiceBusy() || microphone.recording) return;
  try {
    resetVoice();
    microphone.start();
    $("record").classList.add("recording");
    notice(
      "Recording locally. Release to stop; transcription is a separate action.",
    );
  } catch (e) {
    fail(e);
  }
}
async function stopRecording() {
  try {
    const context =
      voiceContext?.source === "provider" ? voiceContext : undefined;
    if (context) context.finishing = true;
    const blob = await microphone.stop();
    if (context && !voiceCurrent(context)) return;
    $("record").classList.remove("recording");
    if (!blob) return;
    discardAudio();
    recordedBlob = blob;
    recordingUrl = URL.createObjectURL(blob);
    $<HTMLAudioElement>("recorded-audio").src = recordingUrl;
    $("recording-preview").hidden = false;
    $("recorded-size").textContent =
      `${blob.size} bytes captured locally · ${blob.type || "browser audio"}`;
    renderVoice();
    if (context) {
      await transcribeRecording(context);
      return;
    }
    notice(
      transcriptionCapability?.available
        ? "Recording captured locally. Choose Transcribe recording to create a transcript."
        : "Microphone test captured locally. Transcription is unavailable; use text requests.",
    );
  } catch (e) {
    fail(e);
  }
}
function authClear() {
  generation++;
  resetVoice();
  api?.dispose();
  api = undefined;
  clearSpatialLogin(() => sessionStorage);
  pendingSend = undefined;
  artifactPreview = undefined;
  snapshot = empty;
  syncedAt = "";
  selectedTask = "";
  busy = false;
  audioSubmitting = false;
  transcriptionCapability = undefined;
  transcriptionCapabilityAt = 0;
  voiceConfig = undefined;
  voiceConfigAt = 0;
  voiceConfigMessage = "";
  transcriptionMessage = "";
  $<HTMLTextAreaElement>("transcript").value = "";
  microphone.cancel();
  discardAudio();
  renderWorkspace();
}
function storeSession(token: string, expiresAt?: string) {
  sessionStorage.setItem(
    "providence.quest.session",
    JSON.stringify({ token, expiresAt }),
  );
}
$("owner-key").addEventListener("change", () => {
  const reusable = $<HTMLInputElement>("owner-key").checked;
  $("credential-label").textContent = reusable
    ? "Workspace access key"
    : "One-use sign-in code";
  $<HTMLInputElement>("credential").placeholder = reusable
    ? "Enter your existing private access key"
    : "Enter your one-use code";
  $<HTMLInputElement>("credential").value = "";
});
let loginPending = false;
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (loginPending) return;
  const input = $<HTMLInputElement>("credential");
  const credential = input.value.trim();
  if (!credential) return;
  const useOwnerKey = $<HTMLInputElement>("owner-key").checked;
  const attempt = ++generation;
  loginPending = true;
  const controls = [
    ...$("login-form").querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      "input, button",
    ),
  ];
  controls.forEach((control) => (control.disabled = true));
  input.value = "";
  let candidate: ProvidenceApi | undefined;
  try {
    const signal = AbortSignal.timeout(15000);
    const session = useOwnerKey
      ? { token: credential, expiresAt: undefined }
      : await ProvidenceApi.exchange(credential, signal);
    if (!alive || attempt !== generation) return;
    candidate = new ProvidenceApi(session.token);
    const first = await candidate.snapshot(signal);
    if (!alive || attempt !== generation) return;
    api?.dispose();
    api = candidate;
    candidate = undefined;
    snapshot = first;
    syncedAt = new Date().toISOString();
    storeSession(session.token, session.expiresAt);
    notice("Connected. This tab can now direct Providence work.");
    renderWorkspace();
  } catch (error) {
    if (attempt === generation) fail(error);
  } finally {
    candidate?.dispose();
    loginPending = false;
    controls.forEach((control) => (control.disabled = false));
  }
});
$("signout").addEventListener("click", () => {
  if (api?.accountSession) { location.assign("/account"); return; }
  authClear();
  notice("Signed out of this tab.");
});
async function retryPendingSubmission() {
  const submission = pendingSend;
  if (!submission || !dataReady() || voiceBusy() || microphone.recording)
    return;
  const client = api,
    run = generation;
  const task = await dispatchText(submission.text, submission.chatId);
  if (task && api === client && generation === run)
    notice(
      `The original request to ${chatName(submission.chatId)} is confirmed. Inspect that chat for its result.`,
    );
}
function dismissLocalRetry() {
  if (!pendingSend || busy) return;
  pendingSend = undefined;
  sessionStorage.removeItem("providence.quest.pending");
  notice(
    "Local retry dismissed. Any task already received by the coordinator is unchanged and has not been cancelled.",
  );
  renderWorkspace();
}
$("retry-pending").addEventListener(
  "click",
  () => void retryPendingSubmission(),
);
$("dismiss-pending").addEventListener("click", dismissLocalRetry);
$("inspect-pending").addEventListener("click", () => {
  if (pendingSend && dataReady()) selectChat(pendingSend.chatId);
});
$("message-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void sendMessage();
});
$("enable-mic").addEventListener("click", async () => {
  try {
    await microphone.enable();
    micTextOnly = false;
  } catch (e) {
    fail(e);
  }
  renderCapabilities();
  renderSpatial();
});
$("skip-mic").addEventListener("click", () => {
  micTextOnly = true;
  resetVoice();
  microphone.disable();
  if (!voiceBusy()) discardAudio();
  micState = "Text only";
  $("mic-status").textContent =
    "Text only. You can enable the microphone here later.";
  renderCapabilities();
  renderSpatial();
});
$("chat-select").addEventListener("change", () =>
  selectChat($<HTMLSelectElement>("chat-select").value),
);
const talk = $("talk");
// Native button clicks cover mouse, touch, Enter and Space without duplicate
// pointer/key handlers. XR keeps its separate hold/release/cancel actions.
talk.addEventListener("click", toggleVoice);
$("spatial-talk").addEventListener("click", () => void activateSpatialVoice());
talk.addEventListener("pointercancel", stopVoice);
$("stop-voice").addEventListener("click", stopVoice);
$("read-reply").addEventListener("click", () => void readVoiceReply());
const record = $("record");
record.addEventListener("pointerdown", (e) => {
  if ((e as PointerEvent).button !== 0) return;
  record.setPointerCapture((e as PointerEvent).pointerId);
  startRecording();
});
record.addEventListener("pointerup", () => void stopRecording());
record.addEventListener("pointercancel", () => {
  microphone.cancel();
  $("record").classList.remove("recording");
});
record.addEventListener("keydown", (e) => {
  if ([" ", "Enter"].includes(e.key) && !e.repeat) {
    e.preventDefault();
    startRecording();
  }
});
record.addEventListener("keyup", (e) => {
  if ([" ", "Enter"].includes(e.key)) {
    e.preventDefault();
    void stopRecording();
  }
});
$("transcribe").addEventListener("click", () => void transcribeRecording());
$("send-transcript").addEventListener(
  "click",
  () => void sendMessage("transcript"),
);
$("transcript").addEventListener("input", () => {
  renderVoice();
  renderSpatial();
});
$("discard-audio").addEventListener("click", () => {
  if (voiceBusy()) return;
  discardAudio();
  transcriptionMessage = "";
  renderVoice();
  renderSpatial();
});
function initSpatial() {
  if (spatial) { spatial.resume(); return spatial; }
  spatial = new SpatialWorkspace($("viewport"), (next) => {
    caps = next;
    if (next.exitError) $<HTMLDetailsElement>("spatial-preview").open = true;
    observedXR ||= next.active;
    observedHands = Math.max(observedHands, next.hands);
    observedControllers = Math.max(observedControllers, next.controllers);
    if (previousActive && (!next.active || next.focused === false)) {
      resetVoice();
      $("record").classList.remove("recording");
    }
    previousActive = next.active;
    renderCapabilities();
    renderSpatial();
    if (alive) void maybeSpeakCompletion();
  });
  renderSpatial();
  return spatial;
}
function arrangePanels() {
  if (voiceContext || voiceBusy() || microphone.recording) stopVoice();
  const preview = $<HTMLDetailsElement>("spatial-preview");
  if (!caps.active) preview.open = true;
  const view = initSpatial();
  view.setArrangeMode(!view.isArranging);
  if (!caps.active)
    preview.scrollIntoView({ block: "center", behavior: "smooth" });
}
$("arrange-panels").addEventListener("click", () => {
  try {
    arrangePanels();
  } catch (error) {
    fail(error);
  }
});
$("recenter-panels").addEventListener("click", () => {
  try {
    if (voiceContext || voiceBusy() || microphone.recording) stopVoice();
    initSpatial().recenter();
  } catch (error) {
    fail(error);
  }
});
$("mute-replies").addEventListener("click", () =>
  setReplyAudio(!completionEnabled),
);
$("spatial-preview").addEventListener("toggle", () => {
  if ($<HTMLDetailsElement>("spatial-preview").open) {
    try {
      initSpatial();
    } catch (e) {
      fail(e);
    }
  } else if (!caps.active) void spatial?.suspend().catch(fail);
});
for (const [id, mode] of [
  ["enter-vr", "immersive-vr"],
  ["enter-ar", "immersive-ar"],
] as const)
  $(id).addEventListener("click", () => {
    try {
      void initSpatial().enter(mode).catch(fail);
    } catch (e) {
      fail(e);
    }
  });
function act(
  id: string,
  label: string,
  onSelect: () => void,
  tone?: "primary" | "danger",
  disabled = false,
): Action {
  return { id, label, onSelect, tone, disabled };
}
function renderSpatial() {
  if (!spatial) return;
  const task = selected();
  const updates = task ? taskUpdates(task) : undefined;
  const childIds = [
    ...new Set([
      ...(updates?.children.map((child) => child.id) ?? []),
      ...(task?.childTaskIds ?? []),
    ]),
  ];
  const pending =
    snapshot.approvals.find(
      (a) => a.status === "pending" && (!task || a.taskId === task.id),
    ) ?? snapshot.approvals.find((a) => a.status === "pending");
  const panels: Panel[] = [
    {
      id: "devices",
      title: selectedDevice ? deviceName(selectedDevice) : "Your computers",
      eyebrow: api ? "DEVICE STATUS" : "YOUR WORKSPACE",
      lines: api
        ? snapshot.devices
            .filter((d) => !selectedDevice || d.id === selectedDevice)
            .map(
              (d) =>
                `${d.name} · ${deviceConnection(d, !!api && !!syncedAt)}\n${d.platform ?? "unknown platform"}${d.hostname ? ` · ${d.hostname}` : ""}`,
            )
        : ["Sign in to bring your computers into this space.", "Use the same Providence account on every device."],
      actions: [
        ...(!api ? [act("sign-in", "Sign in to Providence", () => location.assign('/account'), "primary")] : []),
        ...snapshot.devices.map((d) =>
          act(
            `device-${d.id}`,
            `${selectedDevice === d.id ? "All computers" : "Inspect " + d.name}`,
            () => chooseDevice(d.id),
          ),
        ),
        act("chat-master", "Use Providence", () => selectChat("master")),
        ...snapshot.chats
          .filter((c) => !selectedDevice || c.deviceId === selectedDevice)
          .map((c) => act(`chat-${c.id}`, `Use ${actionTarget(snapshot, c.id)}`, () => selectChat(c.id))),
      ],
    },
    {
      id: "conversation",
      title:
        selectedChat === "master"
          ? "Providence"
          : (snapshot.chats.find((c) => c.id === selectedChat)?.name ??
            "Conversation"),
      eyebrow: "REQUESTS & TASKS",
      lines: [
        ...snapshot.tasks
          .filter((t) => t.chatId === selectedChat)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 4)
          .map((t) => `${t.prompt}\n${stateLine(t)}`),
        `Action target: ${actionTarget(snapshot, selectedChat)}`,
        `Workspace: ${api && syncedAt ? "Connected to Providence" : "Sign in to begin"}`,
        "Select the sphere to speak. Select it again to send.",
        caps.arranging
          ? "Arrange mode: hold a panel header to move it, then choose Done."
          : "Select a task to follow its progress and returned files.",
        ...(pendingSend
          ? [
              `Unconfirmed request to ${chatName(pendingSend.chatId)}: ${pendingSend.text}`,
              "Retry keeps its original identity. Dismiss local retry does not cancel any submitted task.",
            ]
          : []),
        ...(voiceMessage ? [voiceMessage] : []),
        ...($("voice-transcript").textContent
          ? [`Voice request: ${$("voice-transcript").textContent}`]
          : []),
        !voiceAvailable()
          ? `${voiceInput().label}. Voice input unavailable; text keeps the same action target.`
          : "Hold to talk sends one recognized request to this chat.",
        `Draft: ${$<HTMLTextAreaElement>("message").value || "No text yet."}`,
        `Transcript to review: ${$<HTMLTextAreaElement>("transcript").value || "No transcript yet."}`,
        transcriptionMessage ||
          (transcriptionCapability?.available
            ? "Recording stays local until you select Transcribe."
            : "Transcription unavailable. Text input works."),
      ],
      actions: [
        ...(pendingSend
          ? [
              act(
                `retry-pending-${pendingSend.requestId}`,
                "Retry exact saved request",
                () => void retryPendingSubmission(),
                "primary",
                !dataReady() || voiceBusy() || microphone.recording,
              ),
              act(
                `dismiss-pending-${pendingSend.requestId}`,
                "Dismiss local retry (does not cancel task)",
                dismissLocalRetry,
                undefined,
                busy,
              ),
            ]
          : []),
        {
          id: `talk-${selectedChat}`,
          label:
            voiceContext && (dictation.active || microphone.recording)
              ? "Release to send one request"
              : `Hold to talk to ${chatName()}`,
          disabled:
            !canSend() ||
            !microphone.enabled ||
            voiceBusy() ||
            microphone.recording ||
            !voiceAvailable(),
          onSelect: beginVoice,
          onRelease: finishVoice,
          onCancel: stopVoice,
        },
        act(
          "stop-voice",
          "Stop voice",
          stopVoice,
          undefined,
          !voiceContext &&
            !voiceRequest &&
            !voiceBusy() &&
            !microphone.recording &&
            !spokenReply.active &&
            !serverSpeech.active,
        ),
        act(
          "mute-voice-replies",
          completionEnabled ? "Mute replies" : "Unmute replies",
          () => setReplyAudio(!completionEnabled),
        ),
        act(
          "read-voice-reply",
          "Read new voice reply",
          readVoiceReply,
          undefined,
          !completionEnabled ||
            !voiceRequest ||
            voiceRequest.chatId !== selectedChat ||
            !voiceReply(snapshot, voiceRequest.id) ||
            voiceReply(snapshot, voiceRequest.id)?.id === spokenReplyId ||
            !replyPlaybackAvailable(
              voiceRequest ? voiceReply(snapshot, voiceRequest.id) : undefined,
            ) ||
            spokenReply.active ||
            serverSpeech.active ||
            voiceBusy() ||
            microphone.recording,
        ),
        act(
          "type",
          "Type a request",
          () => {
            $<HTMLDetailsElement>("type-instead").open = true;
            void spatial!.focusInput($<HTMLTextAreaElement>("message")).catch(fail);
          },
        ),
        act(
          "send",
          "Send this request",
          () => void sendMessage(),
          "primary",
          !canSend() ||
            voiceBusy() ||
            microphone.recording ||
            !$<HTMLTextAreaElement>("message").value.trim(),
        ),
        {
          id: "microphone-test",
          label: transcriptionCapability?.available
            ? "Hold to record request"
            : "Hold for mic test",
          disabled: !microphone.enabled || voiceBusy(),
          onSelect: startRecording,
          onRelease: () => void stopRecording(),
          onCancel: () => microphone.cancel(),
        },
        act(
          "transcribe-recording",
          `Transcribe recording with ${transcriptionCapability?.devices.find((device) => device.id === transcriptionDevice)?.provider ?? "configured service"}`,
          () => void transcribeRecording(),
          "primary",
          !canTranscribe(),
        ),
        act(
          "edit-transcript",
          "Review / edit transcript",
          () => {
            $<HTMLDetailsElement>("audio-tests").open = true;
            void spatial!.focusInput($<HTMLTextAreaElement>("transcript")).catch(fail);
          },
          undefined,
          (!$<HTMLTextAreaElement>("transcript").value &&
            transcriptionJob?.status !== "completed") ||
            voiceBusy(),
        ),
        act(
          "send-transcript",
          "Send reviewed transcript",
          () => void sendMessage("transcript"),
          "primary",
          !canSend() ||
            microphone.recording ||
            !$<HTMLTextAreaElement>("transcript").value.trim() ||
            voiceBusy(),
        ),
        ...snapshot.tasks
          .filter((t) => t.chatId === selectedChat)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 6)
          .map((t) =>
            act(`task-${t.id}`, `${t.status}: ${t.prompt.slice(0, 50)}`, () =>
              selectTask(t.id),
            ),
          ),
      ],
    },
    {
      id: "decision",
      title: pending ? "Your input" : "All clear",
      eyebrow: pending ? "INPUT REQUESTED" : "QUESTIONS",
      lines: pending
        ? [
            snapshot.tasks.find((t) => t.id === pending.taskId)?.prompt ??
              pending.taskId,
            ...decisionLines(pending),
          ]
        : [
            "Providence will keep working on clear requests.",
            "A question appears here only when your input is needed.",
          ],
      actions: pending ? decisionActions(pending) : [],
    },
    {
      id: `result-${task?.id ?? "empty"}`,
      title: updates?.children.length
        ? "Latest device updates"
        : task
          ? "Response & returned files"
          : "Results",
      eyebrow: task ? stateLine(task) : "VERIFIED SNAPSHOTS",
      lines: task
        ? [
            ...(updates?.children.flatMap((child) => [
              ...childUpdateLines(child),
              "",
            ]) ?? []),
            ...(updates?.coverageNote ? [updates.coverageNote] : []),
            ...(updates?.children.length ? [updates.coordinatorLabel] : []),
            ...(currentProgress(task) ? [currentProgress(task)] : []),
            artifactPreview?.taskId === task.id
              ? artifactPreview.text
              : task.text || task.error || "Waiting for a response…",
            ...(task.artifacts ?? []).map(
              (a) =>
                `${a.name} · revision ${a.revision} · ${a.size} bytes\nSHA-256 ${a.sha256}`,
            ),
          ]
        : [
            "Select a task to inspect its response and output.",
            "These panels are not live desktop streams.",
          ],
      actions: task
        ? [
            ...(active(task)
              ? [
                  act(
                    `stop-${task.id}`,
                    "Stop this task",
                    () => void cancel(task),
                    "danger",
                    !dataReady(),
                  ),
                ]
              : []),
            ...(updates?.children.filter(child => active(child)).map(child => act(`stop-child-${child.id}`, `Stop ${child.deviceName} task`, () => void cancel(child), "danger", !dataReady())) ?? []),
            ...childIds.map((id) =>
              act(
                `child-${id}`,
                `Open ${updates?.children.find((child) => child.id === id)?.deviceName ?? deviceName(snapshot.tasks.find((t) => t.id === id)?.deviceId ?? "child")} task`,
                () => selectTask(id),
              ),
            ),
            ...(task.artifacts ?? []).map((a) =>
              act(
                `file-${a.id}`,
                `Open ${a.name}`,
                () => void openArtifact(a),
                undefined,
                !dataReady(),
              ),
            ),
          ]
        : [],
    },
  ];
  // Keep typing and Send on the first action page even when voice is unavailable.
  const actions = panels[1].actions;
  const primaryIds = [...(voiceAvailable() ? [`talk-${selectedChat}`] : []), "type", "send", "stop-voice"];
  const primary = primaryIds.flatMap(id => actions.filter(action => action.id === id));
  panels[1].actions = [...primary, ...actions.filter(action => !primaryIds.includes(action.id) && (voiceAvailable() || !action.id.startsWith("talk-")))];
  if (api && !snapshot.devices.length) panels[0].lines.push("No computers connected yet. Add one in Devices.");
  panels[0].lines.push("Live task activity is available. Screen sharing is not available yet.");
  const holding = !!voiceContext && !voiceContext.finishing && (dictation.active || microphone.recording);
  spatial.update({
    panels,
    voice: {
      state: $("voice-stage").dataset.state ?? "unavailable",
      label: holding ? "Stop and send" : "Speak to Providence",
      action: act("spatial-voice", holding ? "Stop and send" : "Speak to Providence", () => void activateSpatialVoice(), "primary",
        !!api && !holding && (!canSend() || voiceBusy() || !voiceAvailable())),
    },
    status:
      lastError ||
      `${api ? "Connected" : "Capability check"} · Mic: ${micState}`,
  });
}
function decisionLines(a: Approval) {
  return (
    a.details.questions?.flatMap((q) => [
      q.question,
      ...(q.options ?? []).map(
        (o) => `${o.label}${o.description ? ` — ${o.description}` : ""}`,
      ),
    ]) ?? [JSON.stringify(a.details, null, 2)]
  );
}
function decisionActions(a: Approval): Action[] {
  const questions = a.details.questions;
  if (
    a.method === "item/tool/requestUserInput" &&
    questions?.length === 1 &&
    questions[0].options?.length
  ) {
    const q = questions[0];
    return q.options!.map((o) =>
      act(
        `decision-${a.id}-${q.id}-${o.label}`,
        o.label,
        () => void decide(a, { answers: { [q.id]: { answers: [o.label] } } }),
        "primary",
        !dataReady(),
      ),
    );
  }
  if (
    [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ].includes(a.method)
  )
    return ["accept", "decline", "cancel"].map((d) =>
      act(
        `decision-${a.id}-${d}`,
        d === "accept"
          ? "Approve this action"
          : d === "decline"
            ? "Decline"
            : "Cancel task",
        () => void decide(a, { decision: d }),
        d === "accept" ? "primary" : undefined,
        !dataReady(),
      ),
    );
  return [
    act(
      `decision-${a.id}-form`,
      "Answer in browser",
      () =>
        void spatial!
          .exit()
          .then(() => $("decisions").scrollIntoView({ behavior: "smooth" })),
    ),
  ];
}
$<HTMLTextAreaElement>("message").addEventListener("input", renderSpatial);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    resetVoice();
    $("record").classList.remove("recording");
  }
});
function storedSession(): string | null {
  try {
    return sessionStorage.getItem("providence.quest.session");
  } catch {
    return null;
  }
}
function restoreApiFromSession(): ProvidenceApi | undefined {
  try {
    const saved = JSON.parse(storedSession() ?? "null");
    if (saved?.mode === "account") return new ProvidenceApi("", true);
    if (
      typeof saved?.token === "string" &&
      saved.token &&
      (!saved.expiresAt || Date.parse(saved.expiresAt) > Date.now())
    )
      return new ProvidenceApi(saved.token);
    sessionStorage.removeItem("providence.quest.session");
  } catch {
    /* An invalid/unavailable stored login cannot authorize a request. */
  }
  return undefined;
}
/** Hosted sign-in uses the same HttpOnly cookie as Workspace; no key is copied into this tab. */
async function connectAccountSession() {
  if (api || !alive) return;
  const run = generation;
  try {
    const response = await fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) return;
    const session = await response.json();
    if (!alive || run !== generation || api) return;
    if (hostedAccountMode(location.hostname, session)) { hostedService = true; renderWorkspace(); }
    if (session?.authenticated !== true) return;
    api = new ProvidenceApi('', true);
    try { sessionStorage.setItem('providence.quest.session', JSON.stringify({ mode: 'account' })); } catch { /* Cookie remains the authority. */ }
    renderWorkspace();
    await refresh();
    void refreshTranscription();
  } catch { /* Private servers retain their explicit credential flow. */ }
}
function suspendPage() {
  if (!alive) return;
  suspendedSession = storedSession();
  alive = false;
  generation++;
  taskPolling.stop();
  voicePolling.stop();
  syncedAt = "";
  busy = false;
  resetVoice();
  microphone.disable();
  api?.dispose();
  api = undefined;
  voiceConfig = undefined;
  voiceConfigAt = 0;
  transcriptionCapability = undefined;
  transcriptionCapabilityAt = 0;
  if (spatial) void spatial.suspend().catch(() => undefined);
  renderCapabilities();
  renderWorkspace();
}
function resumePage() {
  if (alive) return;
  alive = true;
  generation++;
  busy = false;
  syncedAt = "";
  resetVoice();
  const currentSession = storedSession();
  api = restoreApiFromSession();
  if (!api || currentSession !== suspendedSession) {
    snapshot = empty;
    artifactPreview = undefined;
    selectedChat = "master";
    selectedTask = "";
  }
  try {
    const restored = restoreControllerState(
      sessionStorage.getItem("providence.quest.pending"),
    );
    pendingSend = restored.pending;
    if (pendingSend) {
      selectedChat = "master";
      selectedTask = "";
    }
  } catch {
    /* Keep any in-memory unconfirmed identity if storage is unavailable. */
  }
  voiceConfigAt = 0;
  transcriptionCapabilityAt = 0;
  spatial?.resume();
  notice(
    "Workspace restored. No request was resent; start a new voice capture when ready.",
  );
  renderCapabilities();
  renderWorkspace();
  taskPolling.start();
  voicePolling.start();
}
function disposePage() {
  alive = false;
  generation++;
  taskPolling.stop();
  voicePolling.stop();
  resetVoice();
  dictation.dispose();
  spokenReply.dispose();
  microphone.dispose();
  api?.dispose();
  api = undefined;
  spatial?.dispose();
}
const taskPolling = new PollingLoop(refresh);
const voicePolling = new PollingLoop(refreshTranscription);
bindPageLifecycle(window, {
  suspend: suspendPage,
  resume: resumePage,
  dispose: disposePage,
});
window.addEventListener("offline", () => {
  if (alive) {
    resetVoice();
    syncedAt = "";
    notice(
      "Connection lost. Voice stopped; accepted task state will refresh after reconnecting.",
    );
    renderWorkspace();
  }
});
api = restoreApiFromSession();
try {
  const restored = restoreControllerState(
    sessionStorage.getItem("providence.quest.pending"),
  );
  selectedChat = restored.selectedChat;
  if (api && restored.pending) {
    pendingSend = restored.pending;
    notice(
      "A previous request is unconfirmed. Providence remains selected; use its original request recovery controls before sending another request.",
    );
  } else if (!restored.pending)
    sessionStorage.removeItem("providence.quest.pending");
} catch {
  /* Storage may be unavailable; keep the default Providence destination. */
}
renderCapabilities();
renderWorkspace();
try { initSpatial(); } catch { notice("The 3D view is unavailable in this browser. The workspace controls below still work."); }
taskPolling.start();
voicePolling.start();
void connectAccountSession();
if (isSecureContext && navigator.xr) {
  void Promise.all([
    navigator.xr.isSessionSupported("immersive-vr"),
    navigator.xr.isSessionSupported("immersive-ar"),
  ])
    .then(([vr, ar]) => {
      vrSupported = vr;
      arSupported = ar;
      renderCapabilities();
    })
    .catch(() => renderCapabilities());
}
