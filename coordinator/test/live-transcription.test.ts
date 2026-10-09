import assert from "node:assert/strict";
import test from "node:test";
import { LiveTranscriptionSession } from "../src/live-transcription.js";

class FakeTimers { callbacks = new Map<number, () => void>(); next = 1; setTimeout = (callback: () => void) => { const id = this.next++; this.callbacks.set(id, callback); return id; }; clearTimeout = (id: unknown) => this.callbacks.delete(id as number); fire(id: number) { this.callbacks.get(id)?.(); } ids() { return [...this.callbacks.keys()]; } }
function fixture() { const frames: Record<string, unknown>[] = [], updates: any[] = [], timers = new FakeTimers(); const session = new LiveTranscriptionSession({ requestId: "request-1", streamId: "stream-1", deviceId: "device-1" }, { send: frame => frames.push(frame), close: () => frames.push({ type: "closed" }) }, { timers, handshakeTimeoutMs: 5, finalTimeoutMs: 5, captureTimeoutMs: 9, onUpdate: update => updates.push(update) }); return { session, frames, updates, timers }; }
const pcm = Buffer.alloc(240, 1).toString("base64");
function acknowledge(session: LiveTranscriptionSession) { session.ingest({ type: "session.created" }); session.ingest({ type: "rate_limits.updated" }); session.ingest({ type: "session.updated", session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24_000 }, transcription: { model: "gpt-live-transcribe" }, turn_detection: null } } } }); }

test("streams partial transcription before commit and completes only after matching commit acknowledgement", () => {
  const { session, frames, updates } = fixture(); session.open(); assert.equal(session.snapshot().state, "opening"); acknowledge(session); assert.equal(session.snapshot().state, "capturing"); session.append(0, pcm); session.ingest({ type: "provider.informational" }); assert.equal(session.snapshot().state, "capturing"); session.ingest({ type: "conversation.item.input_audio_transcription.delta", item_id: "item-1", delta: "hello " }); assert.equal(session.snapshot().partial, "hello "); assert.equal(session.snapshot().userCommitted, false);
  session.commit(0); session.ingest({ type: "conversation.item.input_audio_transcription.completed", item_id: "item-1", transcript: "hello world" }); assert.equal(session.snapshot().state, "committed"); session.ingest({ type: "input_audio_buffer.committed", item_id: "item-1" }); assert.equal(session.snapshot().state, "completed"); assert.equal(session.snapshot().final, "hello world"); assert.ok(updates.some(update => update.partial === "hello ")); assert.equal(frames.filter(frame => frame.type === "input_audio_buffer.commit").length, 1);
});

test("enforces chunk ordering, duplicate acknowledgement, and no commit resend after acknowledgement loss", () => {
  const { session, frames } = fixture(); session.open(); assert.throws(() => session.append(0, pcm), /not accepting/); acknowledge(session); session.append(0, pcm); const before = frames.length; session.append(0, pcm); assert.equal(frames.length, before); assert.throws(() => session.append(0, Buffer.alloc(240, 2).toString("base64")), /Conflicting/); assert.throws(() => session.append(2, pcm), /gap/); session.commit(0); session.commit(0); assert.equal(frames.filter(frame => frame.type === "input_audio_buffer.commit").length, 1); assert.throws(() => session.commit(1), /Conflicting/);
});

test("rejects mismatched items, malformed input, provider loss, timeout, and late callbacks", () => {
  const { session, timers } = fixture(); session.open(); acknowledge(session); assert.throws(() => session.append(0, "not base64"), /Invalid/); session.append(0, pcm); session.ingest({ type: "conversation.item.input_audio_transcription.delta", item_id: "item-1", delta: "a" }); session.ingest({ type: "conversation.item.input_audio_transcription.delta", item_id: "item-2", delta: "b" }); assert.equal(session.snapshot().state, "failed"); const revision = session.snapshot().revision; session.ingest({ type: "conversation.item.input_audio_transcription.completed", item_id: "item-1", transcript: "late" }); assert.equal(session.snapshot().revision, revision);
  const lost = fixture(); lost.session.open(); lost.session.transportClosed(); assert.equal(lost.session.snapshot().state, "transport_closed"); assert.equal(lost.frames.some(frame => frame.type === "closed"), false); const timed = fixture(); timed.session.open(); timed.timers.fire(timed.timers.ids()[0]); assert.equal(timed.session.snapshot().state, "timed_out"); timers.ids().forEach(id => timers.fire(id));
});

test("cancellation closes promptly and validates bounded PCM/transcripts", () => {
  const { session, frames } = fixture(); session.open(); acknowledge(session); session.cancel(); assert.equal(session.snapshot().state, "cancelled"); assert.equal(frames.at(-1)?.type, "closed"); assert.throws(() => session.append(0, pcm), /not accepting/);
  const oversized = fixture(); oversized.session.open(); acknowledge(oversized.session); oversized.session.append(0, pcm); oversized.session.commit(0); oversized.session.ingest({ type: "conversation.item.input_audio_transcription.completed", item_id: "item-1", transcript: "x".repeat(8001) }); assert.equal(oversized.session.snapshot().errorCode, "transcript_too_large");
});

test("bounds chunk count and total audio, separates capture from final timeout, and contains transport exceptions", () => {
  const counted = fixture(); counted.session.open(); acknowledge(counted.session); for (let index = 0; index < 600; index++) counted.session.append(index, pcm); assert.throws(() => counted.session.append(600, pcm), /count limit/);
  const total = fixture(), large = Buffer.alloc(65_536, 1).toString("base64"); total.session.open(); acknowledge(total.session); for (let index = 0; index < 21; index++) total.session.append(index, large); assert.throws(() => total.session.append(21, large), /30 second/);
  const timing = fixture(); timing.session.open(); acknowledge(timing.session); timing.session.append(0, pcm); timing.session.commit(0); assert.equal(timing.timers.ids().length, 1, "capture timer is cleared once final wait starts"); timing.timers.fire(timing.timers.ids()[0]); assert.equal(timing.session.snapshot().errorCode, "final_timeout");
  const broken = new LiveTranscriptionSession({ requestId: "request-2", streamId: "stream-2", deviceId: "device-2" }, { send: () => { throw new Error("secret provider text"); }, close: () => { throw new Error("secret close text"); } }); assert.doesNotThrow(() => broken.open()); assert.equal(broken.snapshot().state, "transport_closed");
});

test("handles a short stop frame, starts the capture deadline after readiness, and rejects empty or premature transcripts", () => {
  const tail = fixture(); tail.session.open(); assert.equal(tail.timers.ids().length, 1); acknowledge(tail.session);
  tail.session.append(0, Buffer.from([1, 0]).toString("base64")); tail.session.commit(0);
  tail.session.ingest({ type: "input_audio_buffer.committed", item_id: "tail" });
  tail.session.ingest({ type: "conversation.item.input_audio_transcription.completed", item_id: "tail", transcript: "stop" });
  assert.equal(tail.session.snapshot().state, "completed"); assert.equal(tail.timers.ids().length, 0);
  const early = fixture(); early.session.open(); early.session.ingest({ type: "conversation.item.input_audio_transcription.delta", item_id: "old", delta: "old capture" });
  assert.equal(early.session.snapshot().errorCode, "provider_sequence_invalid");
  const empty = fixture(); empty.session.open(); acknowledge(empty.session); empty.session.append(0, pcm); empty.session.commit(0);
  empty.session.ingest({ type: "conversation.item.input_audio_transcription.completed", item_id: "empty", transcript: "  " });
  assert.equal(empty.session.snapshot().errorCode, "empty_transcript");
  const mismatch = fixture(); mismatch.session.open(); mismatch.session.ingest({ type: "session.updated", session: { type: "realtime" } });
  assert.equal(mismatch.session.snapshot().errorCode, "provider_session_mismatch");
});

test("a provider final or commit before the user stops cannot become a later capture result", () => {
  for (const event of [
    { type: "input_audio_buffer.committed", item_id: "premature" },
    { type: "conversation.item.input_audio_transcription.completed", item_id: "premature", transcript: "Only the first words" },
  ]) {
    const { session } = fixture(); session.open(); acknowledge(session); session.append(0, pcm);
    session.ingest(event);
    assert.equal(session.snapshot().state, "failed");
    assert.equal(session.snapshot().errorCode, "provider_sequence_invalid");
    assert.equal(session.snapshot().final, undefined);
    assert.throws(() => session.append(1, pcm), /not accepting/);
    assert.throws(() => session.commit(0), /not accepting/);
  }
});
