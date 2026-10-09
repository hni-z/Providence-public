import test from "node:test";
import assert from "node:assert/strict";
import { VoiceSessionGuard, TranscriptionUploadRefused, browserTranscript, recognitionConstructor, recordingTimeslice, transcriptionRefused, MAX_VOICE_REPLY_CHARS } from "../web/src/browser-voice.js";
import { ApiError } from "../web/src/api.js";
import type { VoiceOutcome, AcceptedVoiceTask } from "../web/src/browser-voice.js";
const at = (time: number) => new Date(time).toISOString();
const outcome = (id: string, time: number, overrides: Partial<VoiceOutcome> = {}): VoiceOutcome => ({ id, contextKey: "master", text: "A final reply", status: "completed", updatedAt: at(time), ...overrides });
const accepted = (id: string, chatId = "master"): AcceptedVoiceTask => ({ id, requestId: `request-${id}`, chatId });

test("voice remains silent on mount, start and submission until the exact task acknowledgement arrives", () => {
  const guard = new VoiceSessionGuard(), old = outcome("old", 1000);
  assert.equal(guard.claimFreshOutcome("master", [old]), undefined);
  const token = guard.begin("master", [old]);
  assert.equal(guard.claimFreshOutcome("master", [outcome("new", 3000)]), undefined);
  assert.equal(guard.claimTranscript(token, "master", "  hello  "), "hello");
  assert.equal(guard.claimTranscript(token, "master", "duplicate"), undefined);
  assert.equal(guard.claimFreshOutcome("master", [outcome("new", 3000)]), undefined);
  assert.equal(guard.acceptTranscript(token, "master", accepted("new")), true);
  assert.equal(guard.claimFreshOutcome("master", [old]), undefined);
  assert.equal(guard.claimFreshOutcome("master", [outcome("new", 3000)])?.id, "new");
  assert.equal(guard.claimFreshOutcome("master", [outcome("new", 4000, { text: "refreshed same result" })]), undefined);
});

test("two same-chat tasks completing out of order cannot make another task speak", () => {
  for (const ownTime of [1000, 5000]) {
    const guard = new VoiceSessionGuard(), token = guard.begin("master");
    guard.claimTranscript(token, "master", "voice command A");
    guard.acceptTranscript(token, "master", accepted("A"));
    const unrelated = outcome("B", 3000);
    assert.equal(guard.claimFreshOutcome("master", [unrelated]), undefined);
    assert.equal(guard.claimFreshOutcome("master", [unrelated, outcome("A", ownTime)])?.id, "A");
    assert.equal(guard.claimFreshOutcome("master", [unrelated, outcome("A", ownTime)]), undefined);
    assert.equal(guard.allowsPlayback("master", unrelated), false);
  }
});

test("own task is clock-independent even when server completion predates the local voice start", t => {
  t.mock.method(Date, "now", () => Date.parse("2099-01-01T00:00:00Z"));
  const guard = new VoiceSessionGuard(), token = guard.begin("master");
  guard.claimTranscript(token, "master", "request");
  guard.acceptTranscript(token, "master", accepted("own"));
  assert.equal(guard.claimFreshOutcome("master", [outcome("other", Date.now()), outcome("own", 1)])?.id, "own");
});

test("Superagent reads only children linked to its exact accepted parent", () => {
  const guard = new VoiceSessionGuard(), token = guard.begin("master");
  guard.claimTranscript(token, "master", "request");
  guard.acceptTranscript(token, "master", accepted("parent-A"));
  const values = [
    outcome("other-child", 1000, { parentTaskId: "parent-B" }),
    outcome("unlinked-child", 1200),
    outcome("second", 3000, { parentTaskId: "parent-A" }),
    outcome("first", 2000, { parentTaskId: "parent-A" }),
  ];
  assert.equal(guard.claimFreshOutcome("master", values)?.id, "first");
  assert.equal(guard.claimFreshOutcome("master", values)?.id, "second");
  assert.equal(guard.claimFreshOutcome("master", values), undefined);
  assert.equal(guard.acceptTranscript(token, "master", accepted("parent-B")), false);
  assert.equal(guard.allowsPlayback("master", values[0]), false);
});

test("a direct chat cannot inherit some other task through parent provenance", () => {
  const guard = new VoiceSessionGuard(), token = guard.begin("child-chat");
  guard.claimTranscript(token, "child-chat", "request");
  assert.throws(() => guard.acceptTranscript(token, "child-chat", accepted("own")), /conversation/);
  guard.acceptTranscript(token, "child-chat", accepted("own", "child-chat"));
  assert.equal(guard.claimFreshOutcome("child-chat", [outcome("other", 1000, { contextKey: "child-chat", parentTaskId: "own" })]), undefined);
  assert.equal(guard.claimFreshOutcome("child-chat", [outcome("own", 1000, { contextKey: "child-chat" })])?.id, "own");
});

test("cancellation before a resolved ACK suppresses playback and duplicate callbacks never dispatch another task", async () => {
  for (const nextContext of ["master", "other-chat"]) {
    const guard = new VoiceSessionGuard(), token = guard.begin("master");
    let finish!: (task: AcceptedVoiceTask) => void, dispatches = 0;
    const providerAcknowledgement = new Promise<AcceptedVoiceTask>(resolve => { finish = resolve; });
    const submit = async () => {
      if (!guard.claimTranscript(token, "master", "one voice request")) return false;
      dispatches++;
      const task = await providerAcknowledgement;
      return guard.acceptTranscript(token, "master", task);
    };
    const pending = submit();
    assert.equal(await submit(), false);
    guard.reset(nextContext);
    const task = accepted("accepted-before-cancellation");
    finish(task);
    assert.equal(await pending, false);
    assert.equal(dispatches, 1);
    assert.equal(task.id, "accepted-before-cancellation");
    assert.equal(guard.claimFreshOutcome("master", [outcome(task.id, 2000)]), undefined);
    assert.equal(await submit(), false);
    assert.equal(dispatches, 1);
  }
});

test("an uncertain acknowledgement cannot infer acceptance from later polling or retry dispatch", async () => {
  const guard = new VoiceSessionGuard(), token = guard.begin("master");
  let dispatches = 0;
  const submit = async () => {
    if (!guard.claimTranscript(token, "master", "one request")) return;
    dispatches++;
    throw new Error("Unknown acknowledgement");
  };
  await assert.rejects(submit(), /Unknown/);
  assert.equal(guard.claimFreshOutcome("master", [outcome("possibly-ours", 1000)]), undefined);
  await submit();
  assert.equal(dispatches, 1);
});

test("stop, context switch and a new capture invalidate late recognition or transcription callbacks", () => {
  const guard = new VoiceSessionGuard(), old = guard.begin("master");
  guard.reset("child");
  assert.equal(guard.claimTranscript(old, "master", "late transcript"), undefined);
  assert.equal(guard.acceptTranscript(old, "master", accepted("old")), false);
  const first = guard.begin("master"), second = guard.begin("master");
  assert.equal(guard.claimTranscript(first, "master", "late earlier capture"), undefined);
  assert.equal(guard.claimTranscript(second, "master", "current capture"), "current capture");
  guard.reset();
  assert.equal(guard.acceptTranscript(second, "master", accepted("current")), false);
});

test("muted linked results stay consumed and long Unicode speech text stays bounded", () => {
  const guard = new VoiceSessionGuard(), token = guard.begin("master");
  guard.claimTranscript(token, "master", "request"); guard.acceptTranscript(token, "master", accepted("parent"));
  const muted = outcome("muted", 2000, { parentTaskId: "parent" });
  guard.ignoreOutcomes("master", [muted]);
  assert.equal(guard.claimFreshOutcome("master", [muted]), undefined);
  const result = guard.claimFreshOutcome("master", [outcome("long", 3000, { parentTaskId: "parent", text: "x".repeat(MAX_VOICE_REPLY_CHARS - 1) + "🦉long" })]);
  assert.ok(result); assert.ok(result.text.length <= MAX_VOICE_REPLY_CHARS); assert.doesNotMatch(result.text, /[\uD800-\uDBFF]$/);
});

test("browser detection is honest and interim recognition never becomes a final transcript", () => {
  assert.equal(recognitionConstructor({}), undefined); class Recognition {}
  assert.equal(recognitionConstructor({ webkitSpeechRecognition: Recognition }), Recognition);
  assert.deepEqual(browserTranscript({ results: [{ isFinal: false, length: 1, 0: { transcript: "unfinished" } }] }), { finalText: "", interimText: "unfinished" });
  assert.deepEqual(browserTranscript({ results: [{ isFinal: true, length: 1, 0: { transcript: "final phrase" } }, { isFinal: false, length: 1, 0: { transcript: "partial" } }] }), { finalText: "final phrase", interimText: "partial" });
});

test("a refused transcription keeps its recording while an unknown outcome does not", () => {
  assert.equal(transcriptionRefused(new TranscriptionUploadRefused("Upload not admitted")), true);
  for (const status of [400, 409, 413, 422, 429, 500, 502, 503, 504])
    assert.equal(transcriptionRefused(new ApiError("Failed", status)), false, String(status));
  assert.equal(transcriptionRefused(new Error("The connection failed.")), false);
  assert.equal(transcriptionRefused(undefined), false);
});

test("only a current refused recording can release its claim for one explicit retry", () => {
  const guard = new VoiceSessionGuard(), token = guard.begin("master");
  assert.equal(guard.releaseRefusedRecording(token, "master"), false);
  assert.equal(guard.claimRecording(token, "master"), true);
  assert.equal(guard.claimRecording(token, "master"), false);
  assert.equal(guard.releaseRefusedRecording(token, "master"), true);
  assert.equal(guard.claimRecording(token, "master"), true);
  assert.equal(guard.claimRecording(token, "master"), false);
  guard.claimTranscript(token, "master", "accepted transcript");
  assert.equal(guard.releaseRefusedRecording(token, "master"), false);
  const next = guard.begin("other");
  guard.claimRecording(next, "other");
  assert.equal(guard.releaseRefusedRecording(token, "master"), false);
  assert.equal(guard.claimRecording(next, "other"), false);
});

test("only webm recordings are timesliced", () => {
  assert.equal(recordingTimeslice("audio/webm;codecs=opus"), 250);
  assert.equal(recordingTimeslice("audio/webm"), 250);
  assert.equal(recordingTimeslice("audio/mp4"), undefined);
  assert.equal(recordingTimeslice("audio/ogg;codecs=opus"), undefined);
  assert.equal(recordingTimeslice(undefined), undefined);
});
