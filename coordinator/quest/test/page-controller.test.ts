import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { clearSpatialLogin } from "../src/account-session";
import { ApiError } from "../src/api";
import { CompletionSpeechGate } from "../src/completion-speech";
import { restoreControllerState, voiceReply } from "../src/controller-state";
import { bindPageLifecycle, PollingLoop, type PollingClock } from "../src/page-lifecycle";
import type { Snapshot, Task } from "../src/types";

// Software simulation only, not a browser Back/BFCache or headset test.
// Extract the actual controller functions and actual lifecycle binding from main.
// Rendering, spatial/media adapters, and voice-capability polling are spies;
// snapshot/retained-task reads use deferred fake API promises. Playback readiness
// is deliberately permissive, so stale completion eligibility cannot hide behind
// unavailable audio. No HTML mount, real storage, microphone, network, or provider.
const source = ts.createSourceFile("main.ts", readFileSync(new URL("../src/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const names = new Set([
  "storedSession", "restoreApiFromSession", "suspendPage", "resumePage", "disposePage",
  "refresh", "dataReady", "maybeSpeakCompletion", "resetVoice", "discardAudio", "voiceBusy", "authClear",
]);
const extracted = source.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text));
assert.equal(extracted.length, names.size, "Controller function extraction must match current main.ts");
const polling = source.statements.filter((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
  ts.isIdentifier(declaration.name) && ["taskPolling", "voicePolling"].includes(declaration.name.text)));
assert.equal(polling.length, 2, "Use the actual two main.ts polling declarations");
const lifecycle = source.statements.find((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "bindPageLifecycle");
assert.ok(lifecycle && ts.isExpressionStatement(lifecycle));
const lifecycleCode = lifecycle.expression.getText(source);

class FakeTarget {
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (!listener) return;
    const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (listener) this.listeners.get(type)?.delete(listener);
  }
  emit(type: "pagehide" | "pageshow", persisted: boolean) {
    const event = new Event(type); Object.defineProperty(event, "persisted", { value: persisted });
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      if (typeof listener === "function") listener(event); else listener.handleEvent(event);
    }
  }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}
class FakeClock implements PollingClock {
  private next = 0;
  readonly timers = new Map<number, () => void>();
  setTimeout(callback: () => void): number { const id = ++this.next; this.timers.set(id, callback); return id; }
  clearTimeout(handle: unknown) { this.timers.delete(handle as number); }
}
class FakeStorage {
  readonly values = new Map<string, string>();
  unavailable = false;
  getItem(key: string) { if (this.unavailable) throw new Error("MOCK storage unavailable"); return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.unavailable) throw new Error("MOCK storage unavailable"); this.values.set(key, value); }
  removeItem(key: string) { if (this.unavailable) throw new Error("MOCK storage unavailable"); this.values.delete(key); }
}
interface DeferredRead {
  client: { disposed: boolean };
  kind: "snapshot" | "task";
  id?: string;
  resolve(value: Snapshot | Task): void;
  reject(error: unknown): void;
}
const SESSION = "providence.quest.session", PENDING = "providence.quest.pending";
const accepted = (text = "Original accepted response"): Task => ({
  id: "accepted-task", chatId: "master", deviceId: "coordinator", status: "completed",
  prompt: "Original deliberate request", text, createdAt: "2026-09-19T12:00:00Z", updatedAt: "2026-09-19T12:01:00Z",
});
const data = (task = accepted()): Snapshot => ({ tasks: [task], devices: [], chats: [], approvals: [] });
const pending = Object.freeze({ requestId: "original-request-id", chatId: "original-device-chat", text: "  Preserve exact unconfirmed text.\n" });
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function controller(options: { pending?: typeof pending; selectedChat?: string; selectedTask?: string; armCompletion?: boolean } = {}) {
  const target = new FakeTarget(), clock = new FakeClock(), storage = new FakeStorage();
  storage.setItem(SESSION, JSON.stringify({ token: "fixture-token-only" }));
  if (options.pending) storage.setItem(PENDING, JSON.stringify(options.pending));
  const initialSnapshot = data();
  const reads: DeferredRead[] = [], clients: FakeApi[] = [];
  const counters = { send: 0, transcribe: 0, speech: 0, playback: 0, taskDisposes: 0,
    voiceReads: 0, renders: 0, microphoneDisable: 0, microphoneDispose: 0,
    dictationDispose: 0, spokenDispose: 0, spatialSuspend: 0, spatialResume: 0, spatialDispose: 0,
    inputAborts: 0, outputAborts: 0, audioClears: 0 };
  class FakeApi {
    disposed = false;
    constructor(readonly token: string) { clients.push(this); }
    private read(kind: DeferredRead["kind"], id?: string): Promise<any> {
      if (this.disposed) return Promise.reject(new DOMException("Disposed mock API", "AbortError"));
      return new Promise((resolve, reject) => reads.push({ client: this, kind, id, resolve, reject }));
    }
    snapshot() { return this.read("snapshot"); }
    task(id: string) { return this.read("task", id); }
    // Dispose intentionally leaves existing promises settleable: the real controller
    // must reject their stale results even if transport cancellation arrives late.
    dispose() { this.disposed = true; counters.taskDisposes++; }
    send() { counters.send++; throw new Error("Unexpected mock task dispatch"); }
    transcribe() { counters.transcribe++; throw new Error("Unexpected mock transcription dispatch"); }
    speech() { counters.speech++; throw new Error("Unexpected mock speech dispatch"); }
  }
  class ClockedPollingLoop extends PollingLoop {
    constructor(run: () => Promise<void>, delay?: number) { super(run, delay, clock); }
  }
  const code = `
    const window = target, sessionStorage = storage, document = {hidden:false};
    const empty = {devices:[],chats:[],tasks:[],approvals:[]};
    let snapshot = initialSnapshot, api = new ProvidenceApi("fixture-token-only");
    let selectedChat = options.selectedChat ?? "master", selectedTask = options.selectedTask ?? "accepted-task";
    let pendingSend = options.pending, syncedAt = "2026-09-19T12:01:00Z", alive = true, generation = 1, busy = false;
    let suspendedSession, voiceEpoch = 0, audioEpoch = 0, audioSubmitting = false;
    let voiceRequest = options.armCompletion ? {id:"accepted-task",chatId:"master"} : undefined;
    let completionEnabled = true;
    const completionSpeech = new CompletionSpeechGate();
    if (options.armCompletion) completionSpeech.arm("accepted-task", "master");
    let voiceContext, transcriptionVoiceContext, pendingSpeechReplyId = "", spokenReplyId = "";
    let voiceMessage = "", dictationState = "Not started", speechState = "Not started";
    let voiceConfig = {speechConfigured:true}, voiceConfigAt = 1, voiceConfigMessage = "";
    let transcriptionCapability = {available:true}, transcriptionCapabilityAt = 1, transcriptionMessage = "";
    let recordedBlob, recordingUrl = "", transcriptionRequest, transcriptionJob, artifactPreview;
    let voiceInputAbort = new AbortController(), voiceOutputAbort = new AbortController();
    voiceInputAbort.signal.addEventListener("abort", () => counters.inputAborts++);
    voiceOutputAbort.signal.addEventListener("abort", () => counters.outputAborts++);
    const caps = {active:false,focused:true,arranging:false};
    const elements = new Map();
    const $ = id => { if (!elements.has(id)) elements.set(id, {value:"",textContent:"",hidden:false,removeAttribute(){}}); return elements.get(id); };
    const microphone = {recording:false,cancel(){},disable(){counters.microphoneDisable++;},dispose(){counters.microphoneDispose++;}};
    const dictation = {active:false,cancel(){},dispose(){counters.dictationDispose++;}};
    const spokenReply = {active:false,cancel(){},dispose(){counters.spokenDispose++;}};
    const serverSpeech = {active:false,clear(){counters.audioClears++;}};
    const spatial = {suspend(){counters.spatialSuspend++;return Promise.resolve();},resume(){counters.spatialResume++;},dispose(){counters.spatialDispose++;}};
    const notices = [], failures = [];
    function renderWorkspace(){counters.renders++;}
    function renderCapabilities(){} function renderVoice(){} function renderSpatial(){}
    function notice(message){notices.push(message);}
    function fail(error){failures.push(error);}
    function replyPlaybackAvailable(){return true;}
    async function readVoiceReply(){counters.playback++;}
    // Capability polling is a read-only spy boundary, not the task refresh logic.
    async function refreshTranscription(){if(alive&&api)counters.voiceReads++;}
    ${extracted.map((node) => node.getText(source)).join("\n")}
    ${polling.map((node) => node.getText(source)).join("\n")}
    const cleanup = ${lifecycleCode};
    return {
      cleanup, start(){taskPolling.start();voicePolling.start();}, refresh, dataReady, maybeSpeakCompletion,
      inspect(){return {snapshot,pendingSend,selectedChat,selectedTask,alive,generation,syncedAt,voiceRequest,voiceEpoch,api,notices,failures};},
      restoreStaleVoiceIdentity(){voiceRequest={id:"accepted-task",chatId:"master"};},
      restoreApi:restoreApiFromSession
    };
  `;
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const ui = new Function("target", "storage", "initialSnapshot", "options", "counters", "ProvidenceApi", "ApiError", "CompletionSpeechGate", "PollingLoop", "bindPageLifecycle", "restoreControllerState", "voiceReply", "clearSpatialLogin", compiled)(
    target, storage, initialSnapshot, options, counters, FakeApi, ApiError, CompletionSpeechGate,
    ClockedPollingLoop, bindPageLifecycle, restoreControllerState, voiceReply, clearSpatialLogin,
  );
  return { ui, target, clock, storage, counters, reads, clients, initialSnapshot };
}

function noDispatch(counters: ReturnType<typeof controller>["counters"]) {
  assert.deepEqual([counters.send, counters.transcribe, counters.speech, counters.playback], [0, 0, 0, 0]);
}

test("real controller BFCache recovery preserves exact pending identity, retains accepted state, and restores GET readiness", async () => {
  const h = controller({ pending, selectedChat: "original-device-chat", armCompletion: true });
  h.ui.start(); await flush();
  assert.equal(h.reads.length, 1); assert.equal(h.target.listenerCount, 2);
  h.target.emit("pagehide", true); h.target.emit("pagehide", true);
  assert.equal(h.ui.dataReady(), false);
  assert.equal(h.ui.inspect().snapshot, h.initialSnapshot);
  assert.equal(h.ui.inspect().pendingSend, pending);
  assert.equal(h.clients[0].disposed, true);
  assert.equal(h.counters.microphoneDisable, 1);
  assert.equal(h.counters.inputAborts, 1); assert.equal(h.counters.outputAborts, 1);
  assert.equal(h.clock.timers.size, 0);
  h.target.emit("pageshow", true); h.target.emit("pageshow", true); await flush();
  assert.equal(h.clients.length, 2); assert.equal(h.reads.length, 2);
  assert.equal(h.ui.inspect().selectedChat, "master");
  assert.deepEqual(h.ui.inspect().pendingSend, pending);
  assert.equal(h.storage.getItem(PENDING), JSON.stringify(pending));
  assert.equal(h.ui.inspect().snapshot, h.initialSnapshot);
  assert.equal(h.ui.dataReady(), false);
  assert.equal(h.clock.timers.size, 1, "Only the fresh voice-read loop is scheduled while task GET is pending");
  const fresh = data(accepted("Fresh accepted-task result"));
  h.reads[1].resolve(fresh); await flush();
  assert.equal(h.ui.dataReady(), true); assert.equal(h.ui.inspect().snapshot, fresh);
  assert.equal(h.clock.timers.size, 2);
  h.reads[0].resolve(data(accepted("Stale read must never overwrite the fresh result"))); await flush();
  assert.equal(h.ui.inspect().snapshot, fresh);
  assert.equal(h.clock.timers.size, 2, "Stale task completion cannot add another polling timer");
  assert.deepEqual(h.ui.inspect().pendingSend, pending);
  assert.equal(h.ui.inspect().voiceRequest, undefined);
  // Even accidental restoration of the old voice identity cannot revive the real gate.
  h.ui.restoreStaleVoiceIdentity(); await h.ui.maybeSpeakCompletion();
  noDispatch(h.counters);
  assert.equal(h.counters.spatialSuspend, 1); assert.equal(h.counters.spatialResume, 1);
  h.ui.cleanup(); assert.equal(h.clock.timers.size, 0); assert.equal(h.target.listenerCount, 0);
});

test("real refresh retrieves a retained accepted task absent from the fresh bounded task list", async () => {
  const h = controller({ selectedChat: "master", selectedTask: "accepted-task" });
  h.ui.start(); h.target.emit("pagehide", true); h.target.emit("pageshow", true); await flush();
  assert.equal(h.ui.inspect().selectedTask, "accepted-task");
  assert.equal(h.ui.inspect().snapshot, h.initialSnapshot);
  h.reads[1].resolve({ devices: [], chats: [], tasks: [], approvals: [] }); await flush();
  assert.equal(h.reads[2].kind, "task"); assert.equal(h.reads[2].id, "accepted-task");
  assert.equal(h.ui.dataReady(), false);
  const returned = accepted("Retained task refreshed by exact ID");
  h.reads[2].resolve(returned); await flush();
  assert.equal(h.ui.dataReady(), true); assert.equal(h.ui.inspect().snapshot.tasks[0], returned);
  h.reads[0].resolve({ devices: [], chats: [], tasks: [], approvals: [] }); await flush();
  assert.equal(h.ui.inspect().snapshot.tasks[0], returned);
  assert.equal(h.reads.length, 3, "A disposed old API cannot issue another retained-task read");
  assert.equal(h.clock.timers.size, 2); noDispatch(h.counters); h.ui.cleanup();
});

test("repeated persisted restores use one pair of listeners and only the current polling generations", async () => {
  const h = controller({ pending });
  h.ui.start();
  for (let cycle = 0; cycle < 2; cycle++) {
    h.target.emit("pagehide", true); h.target.emit("pagehide", true);
    h.target.emit("pageshow", true); h.target.emit("pageshow", true); await flush();
    assert.equal(h.target.listenerCount, 2);
    assert.equal(h.clock.timers.size, 1);
  }
  assert.equal(h.clients.length, 3); assert.equal(h.reads.length, 3);
  h.reads[0].resolve(data(accepted("First stale response")));
  h.reads[1].resolve(data(accepted("Second stale response"))); await flush();
  assert.equal(h.ui.inspect().snapshot, h.initialSnapshot); assert.equal(h.ui.dataReady(), false);
  assert.equal(h.clock.timers.size, 1);
  h.reads[2].resolve(data(accepted("Current response"))); await flush();
  assert.equal(h.ui.dataReady(), true); assert.equal(h.clock.timers.size, 2);
  assert.equal(h.counters.voiceReads, 3); assert.equal(h.counters.spatialResume, 2);
  noDispatch(h.counters); h.ui.cleanup();
});

test("real final disposal cannot resume or resurrect state/timers from an in-flight read", async () => {
  const h = controller({ pending, armCompletion: true });
  h.ui.start(); await flush();
  h.target.emit("pagehide", false); h.target.emit("pagehide", false);
  h.target.emit("pageshow", true); h.ui.cleanup(); h.ui.cleanup();
  h.reads[0].resolve(data(accepted("Late final read"))); await flush();
  assert.equal(h.ui.inspect().alive, false); assert.equal(h.ui.dataReady(), false);
  assert.equal(h.ui.inspect().snapshot, h.initialSnapshot);
  assert.equal(h.ui.inspect().pendingSend, pending);
  assert.equal(h.target.listenerCount, 0); assert.equal(h.clock.timers.size, 0);
  assert.equal(h.clients.length, 1); assert.equal(h.reads.length, 1);
  assert.deepEqual([h.counters.dictationDispose, h.counters.spokenDispose, h.counters.microphoneDispose, h.counters.spatialDispose], [1, 1, 1, 1]);
  noDispatch(h.counters);
});

test("a changed stored session clears the old workspace until a fresh authenticated read succeeds", async () => {
  const h = controller({ selectedChat: "old-device-chat" });
  h.ui.start(); h.target.emit("pagehide", true);
  h.storage.setItem(SESSION, JSON.stringify({ token: "different-fixture-token-only" }));
  h.target.emit("pageshow", true); await flush();
  assert.equal(h.clients[1].token, "different-fixture-token-only");
  assert.deepEqual(h.ui.inspect().snapshot.tasks, []);
  assert.equal(h.ui.inspect().selectedChat, "master"); assert.equal(h.ui.dataReady(), false);
  const newWorkspace = data(accepted("New authorized snapshot"));
  h.reads[1].resolve(newWorkspace); await flush();
  assert.equal(h.ui.dataReady(), true); assert.equal(h.ui.inspect().snapshot, newWorkspace);
  noDispatch(h.counters); h.ui.cleanup();
});

test("expired or malformed stored sessions cannot authorize reads after BFCache return", async () => {
  for (const saved of [JSON.stringify({ token: "expired-fixture-token", expiresAt: "2000-01-01T00:00:00Z" }), "malformed-json"]) {
    const h = controller({ pending });
    h.ui.start(); h.target.emit("pagehide", true); h.storage.setItem(SESSION, saved);
    h.target.emit("pageshow", true); await flush();
    assert.equal(h.ui.inspect().api, undefined); assert.equal(h.ui.dataReady(), false);
    assert.equal(h.clients.length, 1); assert.equal(h.reads.length, 1);
    assert.equal(h.ui.inspect().selectedChat, "master");
    assert.deepEqual(h.ui.inspect().snapshot.tasks, []); assert.deepEqual(h.ui.inspect().pendingSend, pending);
    noDispatch(h.counters); h.ui.cleanup();
  }
});

test("unavailable storage preserves the in-memory pending identity while failing closed on authentication", async () => {
  const h = controller({ pending });
  h.ui.start(); h.target.emit("pagehide", true); h.storage.unavailable = true;
  h.target.emit("pageshow", true); await flush();
  assert.equal(h.ui.inspect().pendingSend, pending);
  assert.equal(h.ui.inspect().api, undefined); assert.equal(h.ui.dataReady(), false);
  assert.equal(h.ui.inspect().selectedChat, "master");
  noDispatch(h.counters); h.ui.cleanup();
});

test("a restored session rejected by fresh GET clears authentication without dispatch or autoplay", async () => {
  const h = controller({ pending, armCompletion: true });
  h.ui.start(); h.target.emit("pagehide", true); h.target.emit("pageshow", true);
  h.reads[1].reject(new ApiError("Fixture session expired", 401, "http_error")); await flush();
  assert.equal(h.ui.dataReady(), false); assert.equal(h.ui.inspect().api, undefined);
  assert.equal(h.storage.getItem(SESSION), null); assert.equal(h.storage.getItem(PENDING), null);
  assert.equal(h.ui.inspect().pendingSend, undefined); assert.deepEqual(h.ui.inspect().snapshot.tasks, []);
  noDispatch(h.counters); h.ui.cleanup();
});
