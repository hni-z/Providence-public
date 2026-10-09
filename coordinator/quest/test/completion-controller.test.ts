import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { CompletionSpeechGate } from "../src/completion-speech";
import { voiceReply, requestReadiness, submissionForSend } from "../src/controller-state";
import { voiceConfigurationIdentity } from "../../web/src/voice-config";
import {
  ServerSpeechPlayer,
  SpeechPlaybackError,
} from "../../web/src/server-audio";
import type { Snapshot, Task } from "../src/types";

const source = ts.createSourceFile(
  "main.ts",
  readFileSync(new URL("../src/main.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const names = new Set([
  "voiceCurrent",
  "submitVoice",
  "setReplyAudio",
  "maybeSpeakCompletion",
  "preparedReplyText",
  "speechReplyKey",
  "replyPlaybackAvailable",
  "readVoiceReply",
  "invalidateVoiceConfiguration",
  "refreshVoiceConfiguration",
]);
const functions = source.statements.filter(
  (node) =>
    ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text),
);
assert.equal(functions.length, names.size);
const task = (id = "accepted", status = "completed"): Task => ({
  id,
  chatId: "master",
  deviceId: "coordinator",
  status,
  text: "Fresh response from the accepted request.",
  prompt: "Fixture request",
  createdAt: "2026-09-19T10:00:00Z",
  updatedAt: "2026-09-19T10:01:00Z",
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

function controller(
  snapshot: Snapshot,
  mode: "success" | "unknown" | "playback-failure" = "success",
) {
  const code = `
    let requests=0, plays=0, sends=0, browserCalls=0, configReads=0, configurationLoader, acceptancePromise;
    const api={voiceConfig(){configReads++;return configurationLoader();}},alive=true,generation=1,document={hidden:false},caps={active:false,arranging:false};
    let selectedChat='master',voiceEpoch=0,voiceRequest,voiceContext,transcriptionVoiceContext;
    let voiceConfig={provider:'ElevenLabs',speechConfigured:true},voiceInputAbort,voiceOutputAbort;
    let voiceConfigAt=0,voiceConfigMessage='';
    let pendingSpeechReplyId='',spokenReplyId='',voiceMessage='',speechState='Not started',dictationState='Not started',audioSubmitting=false;
    let preparedReply;
    let completionEnabled=true, connected=true, accepted=snapshot.tasks[0];
    const completionSpeech=new CompletionSpeechGate();
    const elements=new Map();
    function $(id){if(!elements.has(id))elements.set(id,{textContent:'',hidden:false});return elements.get(id);}
    const sessionStorage={setItem(){}};
    const dictation={cancel(){}},microphone={recording:false,cancel(){}};
    const spokenReply={active:false,available(){return true;},cancel(){},speak(){browserCalls++;}};
    function dataReady(){return connected;}
    function voiceBusy(){return false;}
    function chatName(){return 'Superagent';}
    function renderVoice(){} function renderCapabilities(){} function renderSpatial(){} function discardAudio(){}
    async function dispatchText(){sends++;return acceptancePromise ? await acceptancePromise : accepted;}
    const synthesized=[];
    const serverSpeech=new ServerSpeechPlayer(async(text)=>{requests++;synthesized.push(text);if(mode==='unknown')throw new Error('Unknown provider outcome');return new Blob(['mock mp3'],{type:'audio/mpeg'});},{
      createUrl(){return 'blob:mock';},revokeUrl(){},setTimer(){return 1;},clearTimer(){},
      createAudio(){return {onended:null,onerror:null,pause(){},removeAttribute(){},play(){plays++;if(mode==='playback-failure')return Promise.reject(new Error('Playback blocked'));queueMicrotask(()=>this.onended?.());return Promise.resolve();}};}
    },()=> 'speech-'+(requests+1));
    ${functions.map((node) => node.getText(source)).join("\n")}
    return {
      submit(){return submitVoice('One deliberate request',{generation,epoch:voiceEpoch,chatId:selectedChat,source:'browser'});},
      auto:maybeSpeakCompletion,read:readVoiceReply,mute:setReplyAudio,
      accept(value){accepted=value;},
      loseConfig(){invalidateVoiceConfiguration();voiceConfig=undefined;},
      recoverConfig(){voiceConfig={provider:'ElevenLabs',speechConfigured:true};},
      startWithUnknownConfig(){voiceConfig=undefined;voiceConfigAt=0;},
      refreshConfig(loader){configurationLoader=loader;voiceConfigAt=0;return refreshVoiceConfiguration();},
      delayAcceptance(promise){acceptancePromise=promise;},
      arrange(value){caps.arranging=value;},
      availableText(){const reply=voiceReply(snapshot,voiceRequest?.id??'');return reply&&replyPlaybackAvailable(reply)?preparedReplyText(reply):undefined;},
      inspect(){return {requests,plays,sends,browserCalls,configReads,synthesized,voiceRequest,spokenReplyId,voiceMessage,speechState,voiceConfigMessage,transcript:$("voice-transcript").textContent};}
    };
  `;
  const compiled = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(
    "CompletionSpeechGate",
    "voiceReply",
    "ServerSpeechPlayer",
    "SpeechPlaybackError",
    "voiceConfigurationIdentity",
    "snapshot",
    "mode",
    compiled,
  )(
    CompletionSpeechGate,
    voiceReply,
    ServerSpeechPlayer,
    SpeechPlaybackError,
    voiceConfigurationIdentity,
    snapshot,
    mode,
  );
}
function snapshot(...tasks: Task[]): Snapshot {
  return { tasks, chats: [], devices: [], approvals: [] };
}

test("loaded history is silent; deliberate accepted voice request speaks once without another dispatch", async () => {
  const ui = controller(snapshot(task()));
  await ui.auto();
  assert.equal(ui.inspect().requests, 0);
  await ui.submit();
  await flush();
  await ui.auto();
  await flush();
  assert.equal(ui.inspect().sends, 1);
  assert.equal(ui.inspect().requests, 1);
  assert.equal(ui.inspect().plays, 1);
  assert.equal(ui.inspect().spokenReplyId, "accepted");
  assert.equal(ui.inspect().transcript, "One deliberate request");
});
test("completion waits for all explicitly linked work and ignores unrelated same-chat history", async () => {
  const parent = task();
  parent.childTaskIds = ["child"];
  parent.workStatus = "running";
  const child = {
    ...task("child", "running"),
    chatId: "worker",
    deviceId: "mac",
    parentTaskId: parent.id,
    text: "",
  };
  const data = snapshot(parent, child, {
    ...task("unrelated"),
    text: "Unrelated completed history.",
  });
  const ui = controller(data);
  await ui.submit();
  await flush();
  assert.equal(ui.inspect().requests, 0);
  parent.workStatus = "completed";
  child.status = "completed";
  child.text = "Actual linked device response.";
  await ui.auto();
  await flush();
  assert.equal(ui.inspect().requests, 1);
  assert.equal(ui.inspect().spokenReplyId, "child");
});
test("a mismatched accepted chat does not arm completion speech", async () => {
  const ui = controller(snapshot(task()));
  ui.accept({ ...task(), chatId: "other" });
  await ui.submit();
  await flush();
  await ui.auto();
  assert.equal(ui.inspect().sends, 1);
  assert.equal(ui.inspect().requests, 0);
  assert.equal(ui.inspect().voiceRequest, undefined);
});
test("unknown paid outcome is never automatically repeated or retried through browser speech", async () => {
  const ui = controller(snapshot(task()), "unknown");
  await ui.submit();
  await flush();
  await ui.auto();
  await ui.read();
  await ui.auto();
  await flush();
  assert.equal(ui.inspect().requests, 1);
  assert.equal(ui.inspect().browserCalls, 0);
  assert.match(ui.inspect().speechState, /No retry or browser fallback/);
});
test("blocked autoplay permits explicit cached-byte replay without another synthesis or task send", async () => {
  const ui = controller(snapshot(task()), "playback-failure");
  await ui.submit();
  await flush();
  await ui.auto();
  assert.equal(ui.inspect().plays, 1);
  await ui.read();
  await flush();
  await ui.auto();
  assert.equal(ui.inspect().requests, 1);
  assert.equal(ui.inspect().plays, 2);
  assert.equal(ui.inspect().sends, 1);
});
test("mute and unmute do not read a missed completion; a later new voice request may speak", async () => {
  const first = task("first", "running");
  const data = snapshot(first);
  const ui = controller(data);
  await ui.submit();
  ui.mute(false);
  first.status = "completed";
  ui.mute(true);
  await ui.auto();
  await flush();
  assert.equal(ui.inspect().requests, 0);
  const second = task("second");
  data.tasks.push(second);
  ui.accept(second);
  await ui.submit();
  await flush();
  assert.equal(ui.inspect().requests, 1);
  assert.equal(ui.inspect().spokenReplyId, "second");
});
test("configuration loss/recovery cannot replay a previously eligible completion", async () => {
  const pending = task("accepted", "running");
  const ui = controller(snapshot(pending));
  await ui.submit();
  ui.loseConfig();
  pending.status = "completed";
  ui.recoverConfig();
  await ui.auto();
  await ui.read();
  await flush();
  assert.equal(ui.inspect().requests, 0);
  assert.equal(ui.inspect().voiceRequest, undefined);
});
test("arrangement defers eligible completion without consuming it or moving application state", async () => {
  const ui = controller(snapshot(task()));
  ui.arrange(true);
  await ui.submit();
  await flush();
  assert.equal(ui.inspect().requests, 0);
  ui.arrange(false);
  await ui.auto();
  await flush();
  assert.equal(ui.inspect().requests, 1);
  assert.equal(ui.inspect().sends, 1);
});

test("failed first configuration lookup retires an accepted voice task before later lookup recovery", async () => {
  const oldTask = task("accepted-before-first-config");
  const data = snapshot(oldTask);
  const ui = controller(data);
  ui.startWithUnknownConfig();
  let failLookup!: (error: Error) => void;
  const firstLookup = ui.refreshConfig(() => new Promise((_resolve, reject) => { failLookup = reject; }));
  await ui.submit();
  await flush();
  assert.equal(ui.inspect().voiceRequest.id, oldTask.id);
  assert.equal(ui.inspect().requests, 0);
  failLookup(new Error("Mock first configuration lookup failed"));
  await firstLookup;
  assert.equal(ui.inspect().voiceRequest, undefined);
  assert.match(ui.inspect().voiceConfigMessage, /could not be read/);

  await ui.refreshConfig(async () => ({ provider: "ElevenLabs", speechConfigured: true }));
  await ui.auto(); await ui.read(); await flush();
  assert.equal(ui.inspect().configReads, 2);
  assert.equal(ui.inspect().requests, 0);
  assert.equal(ui.inspect().browserCalls, 0);
  assert.equal(ui.inspect().sends, 1);
  assert.equal(data.tasks[0], oldTask);
  assert.equal(oldTask.text, "Fresh response from the accepted request.");

  const freshTask = task("new-request-after-config-recovery");
  data.tasks.push(freshTask); ui.accept(freshTask);
  await ui.submit(); await flush();
  assert.equal(ui.inspect().requests, 1);
  assert.equal(ui.inspect().spokenReplyId, freshTask.id);
});

test("first configuration failure invalidates a voice dispatch still awaiting its acknowledgement", async () => {
  const accepted = task("accepted-after-config-failure");
  const ui = controller(snapshot(accepted));
  ui.startWithUnknownConfig();
  let accept!: (value: Task) => void;
  ui.delayAcceptance(new Promise<Task>((resolve) => { accept = resolve; }));
  const submission = ui.submit();
  await ui.refreshConfig(async () => { throw new Error("Mock initial configuration failure"); });
  accept(accepted);
  await submission;
  await ui.refreshConfig(async () => ({ provider: "ElevenLabs", speechConfigured: true }));
  await ui.auto(); await flush();
  assert.equal(ui.inspect().voiceRequest, undefined);
  assert.equal(ui.inspect().sends, 1);
  assert.equal(ui.inspect().requests, 0);
  assert.equal(ui.inspect().browserCalls, 0);
});

const dispatchNames = new Set([
  "dispatchText", "withAction", "dataReady", "voiceCurrent", "submitVoice",
  "maybeSpeakCompletion", "retryPendingSubmission",
]);
const dispatchFunctions = source.statements.filter((node) => ts.isFunctionDeclaration(node)
  && node.name && dispatchNames.has(node.name.text));
assert.equal(dispatchFunctions.length, dispatchNames.size);

// Actual dispatch/acceptance controller functions. Only the transport ACK, DOM,
// final read-only refresh and playback sink are fakes; no request is sent anywhere.
function acknowledgementController(initialAck: unknown) {
  const code = `
    let acknowledgement=initialAck, sends=0, playback=0, newIds=0, refreshes=0;
    const calls=[], failures=[], saved=new Map(), elements=new Map();
    const sessionStorage={setItem(key,value){saved.set(key,value);},removeItem(key){saved.delete(key);}};
    const crypto={randomUUID(){newIds++;return 'exact-submission-'+newIds;}};
    const $=id=>{if(!elements.has(id))elements.set(id,{textContent:'',hidden:false});return elements.get(id);};
    const alive=true,generation=1,document={hidden:false},caps={active:false,arranging:false};
    let selectedChat='master', selectedTask='previous-selection', busy=false,syncedAt='mock-refreshed';
    let snapshot={devices:[],chats:[],tasks:[],approvals:[]},pendingSend,voiceRequest;
    let voiceEpoch=0,voiceContext,transcriptionVoiceContext,spokenReplyId='',voiceMessage='';
    const completionSpeech=new CompletionSpeechGate(),completionEnabled=true;
    const microphone={recording:false},spokenReply={active:false},serverSpeech={active:false};
    const api={async send(text,chat,requestId){sends++;calls.push({text,chatId:chat,requestId});
      const value=typeof acknowledgement==='function'?acknowledgement(requestId,chat):acknowledgement;
      // A plausible returned record is also visible as background history, ensuring
      // missing ACK validation could actually arm/play it in this regression.
      if(value&&typeof value==='object')snapshot={...snapshot,tasks:[value]};
      return value;
    }};
    function voiceBusy(){return false;} function chatName(){return 'Superagent';}
    function renderWorkspace(){} function renderVoice(){} function renderSpatial(){}
    function fail(error){failures.push(error instanceof Error?error.message:String(error));}
    function notice(){} async function refresh(){refreshes++;}
    function replyPlaybackAvailable(){return true;} async function readVoiceReply(){playback++;}
    ${dispatchFunctions.map((node) => node.getText(source)).join("\n")}
    return {
      submit(){return submitVoice('Exact deliberate voice phrase',{generation,epoch:voiceEpoch,chatId:'master',source:'browser'});},
      auto:maybeSpeakCompletion,retry:retryPendingSubmission,
      setAck(value){acknowledgement=value;},
      inspect(){return {sends,playback,newIds,refreshes,calls,failures,pendingSend,selectedTask,voiceRequest,savedPending:saved.get('providence.quest.pending')};}
    };
  `;
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function("initialAck", "CompletionSpeechGate", "requestReadiness", "submissionForSend", "voiceReply", compiled)(
    initialAck, CompletionSpeechGate, requestReadiness, submissionForSend, voiceReply,
  );
}

test("invalid or mismatched ACKs preserve the original pending envelope and cannot arm speech", async () => {
  const base = task("returned-task");
  for (const acknowledgement of [
    null,
    { ...base, id: "", requestId: "exact-submission-1" },
    { ...base, id: " \n", requestId: "exact-submission-1" },
    { ...base, id: "x".repeat(257), requestId: "exact-submission-1" },
    { ...base, id: 4, requestId: "exact-submission-1" },
    base,
    { ...base, requestId: "wrong-request-id" },
    { ...base, requestId: "exact-submission-1", chatId: "other-chat" },
  ]) {
    const ui = acknowledgementController(acknowledgement);
    await ui.submit(); await ui.auto(); await flush();
    const state = ui.inspect();
    const expected = { requestId: "exact-submission-1", chatId: "master", text: "Exact deliberate voice phrase" };
    assert.deepEqual(state.pendingSend, expected);
    assert.deepEqual(JSON.parse(state.savedPending), expected);
    assert.equal(state.selectedTask, "previous-selection");
    assert.equal(state.voiceRequest, undefined);
    assert.equal(state.sends, 1); assert.equal(state.newIds, 1); assert.equal(state.playback, 0);
    assert.match(state.failures[0], /acknowledgement did not match/);
    assert.equal(state.refreshes, 1);
  }
});

test("a matching ACK alone clears pending state and selects the accepted task", async () => {
  const ui = acknowledgementController((requestId: string, chatId: string) => ({ ...task("matching-task"), requestId, chatId }));
  await ui.submit(); await flush();
  const state = ui.inspect();
  assert.equal(state.pendingSend, undefined); assert.equal(state.savedPending, undefined);
  assert.equal(state.selectedTask, "matching-task");
  assert.deepEqual(state.voiceRequest, { id: "matching-task", chatId: "master" });
  assert.equal(state.sends, 1); assert.equal(state.playback, 1); assert.deepEqual(state.failures, []);
});

test("explicit retry after a bad ACK keeps the exact envelope and never arms recovered autoplay", async () => {
  const ui = acknowledgementController({ ...task("wrong-ack"), requestId: "unrelated-identity" });
  await ui.submit();
  const original = ui.inspect().pendingSend;
  ui.setAck((requestId: string, chatId: string) => ({ ...task("recovered-task"), requestId, chatId }));
  await ui.retry(); await ui.auto(); await flush();
  const state = ui.inspect();
  assert.equal(state.sends, 2); assert.equal(state.newIds, 1);
  assert.deepEqual(state.calls[0], state.calls[1]);
  assert.deepEqual(state.calls[1], original);
  assert.equal(state.pendingSend, undefined); assert.equal(state.savedPending, undefined);
  assert.equal(state.selectedTask, "recovered-task"); assert.equal(state.voiceRequest, undefined);
  assert.equal(state.playback, 0);
});

test("a device renamed after eligibility still replays the audio that reply was prepared for", async () => {
  const data = snapshot(task());
  data.devices = [{ id: "coordinator", name: "Studio Mac", online: true }];
  const ui = controller(data, "playback-failure");
  await ui.submit();
  await flush();
  assert.equal(ui.inspect().requests, 1);
  assert.equal(ui.inspect().plays, 1);
  assert.deepEqual(ui.inspect().synthesized, ["Studio Mac: Fresh response from the accepted request."]);
  // The device list is live, and the cached audio is held against its exact text.
  data.devices[0].name = "Renamed Mac";
  assert.equal(ui.availableText(), ui.inspect().synthesized[0]);
  await ui.read();
  await flush();
  assert.equal(ui.inspect().plays, 2);
  assert.equal(ui.inspect().requests, 1);
  assert.deepEqual(ui.inspect().synthesized, ["Studio Mac: Fresh response from the accepted request."]);
  assert.doesNotMatch(ui.inspect().speechState, /identity has changed/);
});
