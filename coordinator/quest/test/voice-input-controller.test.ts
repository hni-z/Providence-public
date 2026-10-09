import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { prepareTranscription, type TranscriptionCapability } from "../src/api";
import { CompletionSpeechGate } from "../src/completion-speech";
import { dictationPresentation, requestReadiness, voiceReply } from "../src/controller-state";
import { actionTarget } from "../src/target-selection";
import { selectVoiceInput } from "../src/voice-input-selection";
import { voicePresentation } from "../src/voice-presentation";
import type { Task } from "../src/types";
import { SPATIAL_ACCOUNT_HREF } from "../src/account-session";
import { voiceConfigurationIdentity } from "../../web/src/voice-config";

// Real controller functions with fake DOM/media/transport boundaries; no mounted
// browser, real microphone, network, or provider. The API upload spy returns a
// pending job so this suite observes input routing without executing a task.
const source = ts.createSourceFile("main.ts", readFileSync(new URL("../src/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const names = new Set([
  "voiceInput", "voiceAvailable", "voiceCurrent", "beginVoice", "finishVoice", "toggleVoice", "renderVoice",
  "transcribeRecording", "canTranscribe", "voiceBusy", "resetVoice", "discardAudio",
  "stopRecording", "acceptTranscription", "dataReady", "canSend", "chatName", "invalidateVoiceConfiguration", "refreshVoiceConfiguration",
]);
const extracted = source.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text));
assert.equal(extracted.length, names.size);
const clickListener = source.statements.find((node) => ts.isExpressionStatement(node)
  && node.getText(source).startsWith('talk.addEventListener("click",'));
assert.ok(clickListener, "Extract the real white-circle click binding");
const clickListenerCode = clickListener.getText(source);

const markupStatement = source.statements.find((node) => ts.isExpressionStatement(node)
  && ts.isBinaryExpression(node.expression) && node.expression.left.getText(source) === "root.innerHTML");
assert.ok(markupStatement && ts.isExpressionStatement(markupStatement) && ts.isBinaryExpression(markupStatement.expression));
const markup = markupStatement.expression.right;
assert.ok(ts.isNoSubstitutionTemplateLiteral(markup) || ts.isTemplateExpression(markup));
const html = ts.isNoSubstitutionTemplateLiteral(markup) ? markup.text : markup.head.text + markup.templateSpans.map(span => {
  assert.equal(span.expression.getText(source), "SPATIAL_ACCOUNT_HREF", "Only the fixed account return route is interpolated into static markup");
  return SPATIAL_ACCOUNT_HREF + span.literal.text;
}).join("");
const orbMarkup = /<button\b[^>]*id="talk"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? "";
assert.equal(orbMarkup.trim(), "", "The primary circle is plain and labelled outside the button");

const mac = { id: "mac-stt", name: "Mac input service", online: true, configured: true, provider: "OpenAI" as const };
const review = { id: "review-stt", name: "Review input service", online: true, configured: true, provider: "ElevenLabs" as const };
const capability = (devices = [mac, review], available = true): TranscriptionCapability => ({
  available, devices, provider: "OpenAI", mimeTypes: ["audio/webm"], maxAudioBytes: 524288,
});
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function controller(initialCapability: TranscriptionCapability | undefined = capability(), selectedHost = review.id) {
  const code = `
    const elements = new Map(), errors = [], uploads = [], submissions = [], timers = new Map();
    let timerId=0, microphoneStarts=0,browserStarts=0,browserStops=0,stopResolve;
    class Option { constructor(text,value){this.text=text;this.value=value;} }
    function $(id){if(!elements.has(id)){
      const classes=new Set();const element={value:'',hidden:id==='recording-preview',disabled:false,dataset:{},
        children:[],listeners:new Map(),attributes:new Map(),
        classList:{toggle(name,value){value?classes.add(name):classes.delete(name);},add(name){classes.add(name);},remove(name){classes.delete(name);},contains(name){return classes.has(name);}},
        replaceChildren(...children){this.children=children;},setAttribute(name,value){this.attributes.set(name,value);},removeAttribute(name){this.attributes.delete(name);},
        addEventListener(type,listener){this.listeners.set(type,listener);}};
      let text='';Object.defineProperty(element,'textContent',{get(){return text;},set(value){text=value;this.children=[];}});
      elements.set(id,element);
    }return elements.get(id);}
    const URL={createObjectURL(){return 'blob:mock-recording';},revokeObjectURL(){}};
    const setTimeout=(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id;};
    const clearTimeout=id=>timers.delete(id);
    const alive=true,generation=1;let selectedChat='demoPC-actions',selectedTask='',busy=false,syncedAt='mock-refreshed',pendingSend;
    const snapshot={devices:[{id:'demoPC-worker',name:'DemoPC',online:true}],chats:[{id:'demoPC-actions',name:'DemoPC work',deviceId:'demoPC-worker'}],tasks:[],approvals:[]};
    let transcriptionCapability=initialCapability,transcriptionDevice=selectedHost,transcriptionRequest,transcriptionJob,transcriptionVoiceContext;
    let transcriptionMessage='',recordedBlob,recordingUrl='',audioSubmitting=false,audioEpoch=0;
    let voiceEpoch=0,voiceContext,voiceRequest,voiceInputAbort,voiceOutputAbort,pendingSpeechReplyId='',spokenReplyId='',voiceMessage='';
    let dictationState='Not started',speechState='Not started',voiceConfigMessage='',voiceConfigAt=0;
    let voiceConfig={deviceId:selectedHost,transcriptionConfigured:true,transcriptionProvider:initialCapability?.devices.find(d=>d.id===selectedHost)?.provider??'OpenAI',provider:'ElevenLabs',speechConfigured:false,voice:null,maxAudioBytes:524288,maxSpeechChars:4000};
    const completionSpeech=new CompletionSpeechGate(),completionEnabled=true;
    const microphone={enabled:true,recording:false,start(){microphoneStarts++;this.recording=true;},cancel(){this.recording=false;},
      stop(){this.recording=false;return new Promise(resolve=>{stopResolve=resolve;});}};
    const dictation={active:false,available(){return true;},start(){browserStarts++;this.active=true;},
      stop(){browserStops++;dictationState='Finishing dictation…';},cancel(){this.active=false;}};
    const spokenReply={active:false,cancel(){}},serverSpeech={active:false,clear(){}};
    const api={async transcribe(request,signal){if(signal.aborted)throw new DOMException('Aborted','AbortError');uploads.push({...request});
      return {id:'mock-transcription',requestId:request.requestId,deviceId:request.deviceId,status:'pending',text:''};}};
    function replyPlaybackAvailable(){return false;}
    function renderSpatial(){} function renderCapabilities(){} function notice(){} async function maybeSpeakCompletion(){}
    function fail(error){errors.push(error.message);}
    async function submitVoice(text,context){submissions.push({text,chatId:context.chatId});}
    ${extracted.map((node) => node.getText(source)).join("\n")}
    const talk=$('talk');
    ${clickListenerCode}
    renderVoice();
    return {
      event(type){$('talk').listeners.get(type)?.();},
      render:renderVoice,begin:beginVoice,finish:finishVoice,stopRecording,available:voiceAvailable,input:voiceInput,
      transcribe:transcribeRecording,reset:resetVoice,
      replaceCapability(value){transcriptionCapability=value;renderVoice();},
      refreshConfig(value){api.voiceConfig=async()=>value;voiceConfigAt=0;return refreshVoiceConfiguration();},
      config(){return {...voiceConfig};},
      mutateHost(id){transcriptionDevice=id;},
      finishMedia(){stopResolve?.(new Blob(['mock captured audio'],{type:'audio/webm;codecs=opus'}));},
      setBlob(){recordedBlob=new Blob(['mock captured audio'],{type:'audio/webm'});},
      setTasks(tasks){snapshot.tasks=tasks;renderVoice();},
      selectAccepted(id,chatId='demoPC-actions'){voiceRequest={id,chatId};renderVoice();},
      setTranscript(text){$('voice-transcript').textContent=text;$('voice-transcript').hidden=!text;renderVoice();},
      inspect(){return {selectedChat,transcriptionDevice,voiceContext,transcriptionRequest,transcriptionJob,microphoneStarts,browserStarts,browserStops,uploads,submissions,errors,timers:timers.size,
        voiceNote:$('voice-note').textContent,previewHidden:$('recording-preview').hidden,
        talk:$('talk'),talkDisabled:$('talk').disabled,talkLabel:$('talk-label').textContent,stageState:$('voice-stage').dataset.state,stageStatus:$('voice-stage-status').textContent,
        renderedTranscript:$('voice-transcript').textContent,transcriptPlaceholderHidden:$('voice-transcript-placeholder').hidden,
        responseText:$('voice-response-text').textContent,responseSource:$('voice-response-source').textContent};}
    };
  `;
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function("initialCapability", "selectedHost", "selectVoiceInput", "actionTarget", "prepareTranscription", "CompletionSpeechGate", "dictationPresentation", "requestReadiness", "voiceReply", "voicePresentation", "orbMarkup", "voiceConfigurationIdentity", compiled)(
    initialCapability, selectedHost, selectVoiceInput, actionTarget, prepareTranscription,
    CompletionSpeechGate, dictationPresentation, requestReadiness, voiceReply, voicePresentation, orbMarkup, voiceConfigurationIdentity,
  );
}

test("transcribeRecording refuses a captured host mismatch rather than redirecting to an eligible Mac", async () => {
  const ui = controller();
  ui.begin();
  const captured = ui.inspect().voiceContext;
  ui.setBlob(); ui.mutateHost(mac.id);
  await ui.transcribe(captured);
  assert.equal(ui.inspect().uploads.length, 0);
  assert.equal(ui.inspect().selectedChat, "demoPC-actions");
  // A normal render restores the captured host; it never changes the action chat.
  ui.render();
  assert.equal(ui.inspect().transcriptionDevice, review.id);
  ui.reset();
});

test("an offline captured host cannot upload or fall back even while another host and browser recognition are ready", async () => {
  const ui = controller(); ui.begin();
  const captured = ui.inspect().voiceContext;
  ui.setBlob(); ui.replaceCapability(capability([mac, { ...review, online: false }]));
  await ui.transcribe(captured);
  assert.equal(ui.inspect().uploads.length, 0); assert.equal(ui.available(), false);
  assert.equal(ui.inspect().browserStarts, 0); assert.equal(ui.inspect().selectedChat, "demoPC-actions");
  ui.reset();
});

test("the plain circle keeps its external label and stays tappable while recording", () => {
  for (const ui of [controller()]) {
    assert.equal(ui.inspect().talk.children.length,0);
    ui.begin(); ui.render();
    assert.equal(ui.inspect().talkDisabled,false);
    assert.equal(ui.inspect().talkLabel,"Tap to stop and send");
    assert.equal(ui.inspect().talk.attributes.get("aria-pressed"),"true");
    assert.equal(ui.inspect().stageState,"recording");
    assert.equal(ui.inspect().talk.children.length,0);
    ui.reset();
  }
});

test("provider finalization stays disabled and transcribing through a rerender before media bytes arrive", async () => {
  const ui = controller(); ui.begin();
  const captured = ui.inspect().voiceContext;
  const finishing = ui.stopRecording();
  ui.render();
  const state = ui.inspect();
  assert.equal(state.voiceContext, captured);
  assert.equal(state.voiceContext.finishing, true);
  assert.equal(state.talkDisabled, true);
  assert.equal(state.stageState, "transcribing");
  assert.equal(state.stageStatus, "Transcribing…");
  assert.equal(state.talk.classList.contains("recording"), false);
  assert.equal(state.talk.children.length, 0);
  ui.begin();
  assert.equal(ui.inspect().microphoneStarts, 1, "A second press cannot discard the finalizing clip");
  assert.equal(ui.inspect().voiceContext, captured);
  ui.finishMedia(); await finishing; await flush();
  assert.equal(ui.inspect().uploads.length, 1);
  assert.equal(ui.inspect().stageState, "transcribing");
  assert.equal(ui.inspect().talkDisabled, true);
  ui.reset();
});

test("the stage renders only actual final words and the exact accepted linked result, never loaded history", () => {
  const ui = controller();
  const task = (overrides: Partial<Task> = {}): Task => ({
    id: "accepted", chatId: "demoPC-actions", deviceId: "demoPC-worker", status: "completed",
    text: "Old parent note", prompt: "Accepted request", createdAt: "2026-09-20T09:00:00Z", updatedAt: "2026-09-20T09:01:00Z", ...overrides,
  });
  const unrelated = task({ id: "newest-unrelated", text: "Do not show unrelated history", updatedAt: "2099-01-01T00:00:00Z" });
  ui.setTasks([unrelated]);
  assert.equal(ui.inspect().responseText, "Your response will appear here.");
  assert.equal(ui.inspect().responseSource, "");
  assert.equal(ui.inspect().renderedTranscript, "");
  assert.equal(ui.inspect().transcriptPlaceholderHidden, false);
  const transcript = "  Exact final recognized words.\n";
  ui.setTranscript(transcript);
  assert.equal(ui.inspect().renderedTranscript, transcript);
  assert.equal(ui.inspect().transcriptPlaceholderHidden, true);
  const accepted = task({ childTaskIds: ["accepted-child"], workStatus: "running" });
  const child = task({ id: "accepted-child", chatId: "child-work", parentTaskId: accepted.id, status: "running", text: "" });
  ui.setTasks([accepted, child, unrelated]); ui.selectAccepted(accepted.id);
  assert.equal(ui.inspect().stageState, "working");
  assert.equal(ui.inspect().responseText, "Working on your request…");
  assert.equal(ui.inspect().responseSource, "");
  accepted.workStatus = "completed"; child.status = "completed"; child.text = "  Exact final child response.\n";
  ui.render();
  assert.equal(ui.inspect().responseText, child.text);
  assert.equal(ui.inspect().responseSource, "DemoPC · accepted-child");
  assert.equal(ui.inspect().renderedTranscript, transcript);
  assert.equal(ui.inspect().uploads.length, 0); assert.equal(ui.inspect().submissions.length, 0);
  ui.selectAccepted("missing-accepted-task");
  assert.notEqual(ui.inspect().responseText, unrelated.text);
  assert.equal(ui.inspect().responseSource, "");
});


test("circle tap starts once, pointer release does not send, and the next tap finalizes once", async () => {
  const ui = controller();
  assert.equal(ui.inspect().talkLabel, "Tap to speak");
  ui.event("pointerdown"); ui.event("pointerup");
  assert.equal(ui.inspect().microphoneStarts, 0);
  ui.event("click");
  const captured = ui.inspect().voiceContext;
  assert.equal(ui.inspect().microphoneStarts, 1);
  assert.equal(ui.inspect().uploads.length, 0);
  ui.event("pointerup");
  assert.equal(captured.finishing, undefined);
  assert.equal(ui.inspect().talkDisabled, false);
  ui.event("click");
  assert.equal(captured.finishing, true);
  assert.equal(ui.inspect().talkDisabled, true);
  ui.event("click"); ui.event("click");
  assert.equal(ui.inspect().voiceContext, captured);
  assert.equal(ui.inspect().microphoneStarts, 1);
  ui.finishMedia(); await flush(); await flush();
  assert.equal(ui.inspect().uploads.length, 1);
  assert.equal(ui.inspect().uploads[0].deviceId, review.id);
  assert.equal(ui.inspect().selectedChat, "demoPC-actions");
  assert.equal(ui.inspect().submissions.length, 0);
  ui.reset();
});



test("processing selector and host label are absent; capture and playback stay on this client", () => {
  assert.doesNotMatch(html, /id="transcription-device"|id="input-host-note"|Input processed by|Transcription computer/);
  assert.match(html, /Audio is recorded and played on this device/);
  const ui = controller();
  assert.doesNotMatch(ui.inspect().voiceNote, /Review|Mac input service|local transcription/i);
});

test("approved input stays exact through offline/missing/recovery with no browser or alternative host fallback", () => {
  const ui = controller();
  for (const devices of [[mac, {...review,online:false}], [mac]]) {
    ui.replaceCapability(capability(devices)); ui.begin();
    assert.equal(ui.available(), false);
    assert.equal(ui.inspect().transcriptionDevice, review.id);
    assert.equal(ui.inspect().selectedChat, 'demoPC-actions');
    assert.equal(ui.inspect().microphoneStarts, 0);
    assert.equal(ui.inspect().browserStarts, 0);
  }
  ui.replaceCapability(capability()); ui.begin();
  assert.equal(ui.inspect().voiceContext.inputHostId, review.id);
  assert.equal(ui.inspect().voiceContext.chatId, 'demoPC-actions');
  assert.equal(ui.inspect().browserStarts, 0); ui.reset();
});

test("unconfigured approved input cannot start browser dictation even when browser recognition is available", async () => {
  const ui = controller();
  await ui.refreshConfig({...ui.config(),transcriptionConfigured:false});
  ui.event('click');
  assert.equal(ui.available(), false);
  assert.equal(ui.inspect().browserStarts, 0);
  assert.equal(ui.inspect().microphoneStarts, 0);
  assert.equal(ui.inspect().uploads.length, 0);
});

test("actual configuration refresh cancels capture instead of migrating its audio or action target", async () => {
  const ui = controller(); ui.begin();
  const captured=ui.inspect().voiceContext;
  ui.setBlob();
  await ui.refreshConfig({...ui.config(),deviceId:mac.id,transcriptionProvider:'OpenAI'});
  assert.equal(ui.inspect().voiceContext, undefined);
  assert.equal(ui.inspect().uploads.length, 0);
  assert.equal(ui.inspect().selectedChat, 'demoPC-actions');
  await ui.transcribe(captured);
  assert.equal(ui.inspect().uploads.length, 0);
  ui.begin();
  assert.equal(ui.inspect().voiceContext.inputHostId, mac.id);
  assert.equal(ui.inspect().voiceContext.chatId, 'demoPC-actions');
  assert.equal(ui.inspect().microphoneStarts, 2);
  ui.reset();
});

test("initial unavailable configuration and later recovery do not start capture automatically", async () => {
  const ui = controller();
  const valid=ui.config();
  await ui.refreshConfig(undefined); ui.begin();
  assert.equal(ui.inspect().microphoneStarts, 0);
  assert.equal(ui.inspect().browserStarts, 0);
  await ui.refreshConfig(valid);
  assert.equal(ui.available(), true);
  assert.equal(ui.inspect().microphoneStarts, 0);
  assert.equal(ui.inspect().uploads.length, 0);
});
