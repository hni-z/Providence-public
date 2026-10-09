import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { liveTranscriptionFactory, liveTranscriptionSessionConfiguration, loadLiveTranscriptionCredentials } from "../src/provider-live-transcription.js";

test("live input reuses only the explicitly configured OpenAI key file and leaves batch/output settings unchanged", () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-live-key-"));
  try {
    const file = join(directory, "fixture.env");
    writeFileSync(file, "OPENAI_API_KEY=fixture-only-openai-key\n", { mode: 0o600 });
    const config = Object.freeze({ transcriptionProvider: "openai" as const, transcriptionEnvFile: file,
      transcriptionModel: "gpt-4o-mini-transcribe", speechProvider: "elevenlabs" as const, elevenLabsVoiceId: "existing-voice" });
    assert.deepEqual(loadLiveTranscriptionCredentials(config), { apiKey: "fixture-only-openai-key" });
    assert.equal(config.transcriptionModel, "gpt-4o-mini-transcribe");
    assert.equal(config.speechProvider, "elevenlabs");
    assert.equal(loadLiveTranscriptionCredentials({}), undefined);
    assert.equal(loadLiveTranscriptionCredentials({ transcriptionEnvFile: join(directory, "missing") }), undefined);
    assert.equal(loadLiveTranscriptionCredentials({ transcriptionProvider: "elevenlabs", transcriptionEnvFile: file }), undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

class FakeSocket extends EventEmitter {
  readyState = 0; bufferedAmount = 0; sent: any[] = []; closes = 0;
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.closes++; this.readyState = 3; }
  terminate() { this.close(); }
  open() { this.readyState = 1; this.emit("open"); }
  receive(value: any) { this.emit("message", Buffer.from(JSON.stringify(value)), false); }
}
function providerFixture() {
  const socket = new FakeSocket(), events: any[] = [];
  const factory = liveTranscriptionFactory("fixture-only-openai-key", "wss://api.openai.com/v1/realtime?intent=transcription", (url, options) => {
    assert.equal(url, "wss://api.openai.com/v1/realtime?intent=transcription");
    assert.equal(options.headers.Authorization, "Bearer fixture-only-openai-key");
    assert.equal(options.followRedirects, false);
    return socket as any;
  });
  const connection = factory({ requestId: "request", streamId: "stream", deviceId: "mac" }, event => events.push(event));
  const ready = () => { socket.open(); socket.receive({ type: "session.updated", event_id: "ready-event", session: liveTranscriptionSessionConfiguration() }); };
  return { socket, events, connection, ready };
}
test("provider adapter waits for the validated session and relays only genuine incremental/final identity", () => {
  const f = providerFixture();
  try {
    assert.throws(() => f.connection.append(0, Buffer.alloc(4800).toString("base64")), /not accepting/);
    assert.equal(f.events.length, 0);
    f.ready();
    assert.deepEqual(f.events, [{ type: "ready", sessionId: "stream" }]);
    assert.equal(f.socket.sent[0].type, "session.update");
    f.connection.append(0, Buffer.alloc(4800).toString("base64"));
    const delta = { type: "conversation.item.input_audio_transcription.delta", event_id: "delta1", item_id: "item1", content_index: 0, delta: "Actual words" };
    f.socket.receive(delta); f.socket.receive(delta);
    assert.equal(f.events.filter(event => event.type === "partial").length, 1);
    assert.deepEqual(f.events.at(-1), { type: "partial", sessionId: "stream", eventId: "delta1", itemId: "item1", contentIndex: 0, delta: "Actual words", text: "Actual words" });
    f.connection.finish(0); f.connection.finish(0);
    assert.equal(f.socket.sent.filter(event => event.type === "input_audio_buffer.commit").length, 1);
    f.socket.receive({ type: "conversation.item.input_audio_transcription.completed", event_id: "final1", item_id: "item1", content_index: 0, transcript: "Actual words." });
    assert.equal(f.events.some(event => event.type === "final"), false);
    f.socket.receive({ type: "input_audio_buffer.committed", event_id: "commit1", item_id: "item1" });
    assert.deepEqual(f.events.at(-1), { type: "final", sessionId: "stream", eventId: "final1", itemId: "item1", text: "Actual words." });
    assert.equal(f.socket.closes, 1);
  } finally { f.connection.cancel(); }
});
test("cancel and provider failures never replay audio or expose raw provider diagnostics", () => {
  for (const mode of ["cancel", "error", "backpressure"] as const) {
    const f = providerFixture();
    try {
      f.ready();
      if (mode === "cancel") f.connection.cancel();
      else if (mode === "error") f.socket.receive({ type: "error", error: { message: "private-key-and-account-fixture" } });
      else { f.socket.bufferedAmount = 70_000; assert.throws(() => f.connection.append(0, Buffer.alloc(4800).toString("base64")), /unavailable/); }
      f.socket.receive({ type: "conversation.item.input_audio_transcription.delta", event_id: "late", item_id: "item1", content_index: 0, delta: "late" });
      assert.equal(f.events.some(event => event.type === "partial" || event.type === "final"), false);
      assert.equal(f.socket.sent.some(event => event.type === "input_audio_buffer.commit"), false);
      assert.equal(JSON.stringify(f.events).includes("private-key-and-account-fixture"), false);
      assert.equal(f.socket.closes, 1);
    } finally { f.connection.cancel(); }
  }
});
test("the live session config is transcription-only, manual commit and contains no output voice or credentials", () => {
  const config = liveTranscriptionSessionConfiguration();
  assert.deepEqual(config, { type: "transcription", audio: { input: {
    format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "gpt-live-transcribe", delay: "low" }, turn_detection: null,
  } } });
  assert.doesNotMatch(JSON.stringify(config), /apiKey|Authorization|voice|output|response/);
});
