import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { voiceReply } from "../src/controller-state";
import { ServerSpeechPlayer, SpeechPlaybackError } from "../../web/src/server-audio";
import type { Snapshot } from "../src/types";
import { CompletionSpeechGate } from "../src/completion-speech";

// Exercise the real controller entry points without mounting a browser, requesting
// microphone access, creating WebXR, or allowing any network request.
const source = ts.createSourceFile(
  "main.ts",
  readFileSync(new URL("../src/main.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const names = new Set([
  "preparedReplyText", "speechReplyKey", "replyPlaybackAvailable",
  "readVoiceReply", "invalidateVoiceConfiguration",
]);
const functions = source.statements.filter((node) =>
  ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text),
);
assert.equal(functions.length, names.size);

function controller(mode: "unknown-outcome" | "playback-failure", snapshot: Snapshot, pendingSend: object) {
  const code = `
    let requests = 0, browserCalls = 0;
    const completionSpeech = new CompletionSpeechGate(), completionEnabled = true, document = {hidden:false};
    const api = {}, alive = true, generation = 1, selectedChat = "master";
    let voiceEpoch = 0, voiceRequest = { id: "accepted-task", chatId: "master" };
    let voiceConfig = { provider: "ElevenLabs", speechConfigured: true };
    let voiceInputAbort, voiceOutputAbort, voiceContext, transcriptionVoiceContext;
    let pendingSpeechReplyId = "", spokenReplyId = "", voiceMessage = "";
    let preparedReply;
    let audioSubmitting = false, dictationState = "Not started", speechState = "Not started";
    const dictation = { cancel() {} }, microphone = { recording: false, cancel() {} };
    const spokenReply = { active: false, cancel() {}, available() { return true; }, speak() { browserCalls++; } };
    function voiceBusy() { return false; }
    function renderVoice() {} function renderSpatial() {} function discardAudio() {}
    const serverSpeech = new ServerSpeechPlayer(async () => {
      requests++;
      if (mode === "unknown-outcome") throw new Error("Provider response lost");
      return new Blob(["fixture audio"], { type: "audio/mpeg" });
    }, {
      createUrl() { return "blob:fixture"; }, revokeUrl() {},
      createAudio() { return { onended: null, onerror: null, pause() {}, removeAttribute() {},
        play() { return Promise.reject(new Error("Playback blocked")); } }; },
      setTimer() { return 0; }, clearTimer() {}
    }, () => "speech-request-" + (requests + 1));
    ${functions.map((node) => node.getText(source)).join("\n")}
    return {
      read: readVoiceReply,
      loseConfiguration() { invalidateVoiceConfiguration(); voiceConfig = undefined; },
      recoverConfiguration() { voiceConfig = { provider: "ElevenLabs", speechConfigured: true }; },
      inspect() { return { requests, browserCalls, voiceRequest, voiceMessage, speechState, snapshot, pendingSend }; }
    };
  `;
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function("ServerSpeechPlayer", "SpeechPlaybackError", "voiceReply", "CompletionSpeechGate", "mode", "snapshot", "pendingSend", compiled)(
    ServerSpeechPlayer, SpeechPlaybackError, voiceReply, CompletionSpeechGate, mode, snapshot, pendingSend,
  );
}

for (const mode of ["unknown-outcome", "playback-failure"] as const) {
  test(`Quest configuration recovery cannot reissue old reply speech after ${mode}`, async () => {
    const task = Object.freeze({
      id: "accepted-task", chatId: "master", deviceId: "coordinator", status: "completed",
      prompt: "Original accepted voice request", text: "Exact returned task text.",
      createdAt: "2026-09-19T12:00:00Z", updatedAt: "2026-09-19T12:01:00Z",
    });
    const snapshot: Snapshot = { tasks: [task], chats: [], devices: [], approvals: [] };
    Object.freeze(snapshot.tasks); Object.freeze(snapshot);
    const pending = Object.freeze({ requestId: "pending-identity", chatId: "other-chat", text: "Unrelated unconfirmed request" });
    const ui = controller(mode, snapshot, pending);
    await ui.read();
    assert.equal(ui.inspect().requests, 1);
    assert.match(ui.inspect().speechState, mode === "unknown-outcome" ? /No retry or browser fallback/ : /downloaded but playback failed/);
    ui.loseConfiguration();
    assert.equal(ui.inspect().voiceRequest, undefined);
    assert.match(ui.inspect().voiceMessage, /task text remains available/);
    ui.recoverConfiguration();
    await ui.read();
    await ui.read();
    const state = ui.inspect();
    assert.equal(state.requests, 1);
    assert.equal(state.browserCalls, 0);
    assert.equal(state.snapshot, snapshot);
    assert.equal(state.pendingSend, pending);
    assert.equal(state.snapshot.tasks[0], task);
    assert.deepEqual(state.pendingSend, { requestId: "pending-identity", chatId: "other-chat", text: "Unrelated unconfirmed request" });
  });
}
