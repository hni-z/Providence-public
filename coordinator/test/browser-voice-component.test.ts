import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptionUploadRefused } from "../web/src/browser-voice.js";
import { deferred, fakeStream, voiceComponent } from "./fixtures/browser-voice-component.js";

test("late microphone permission cannot hide a newer active recording", async () => {
  const f = voiceComponent();
  try {
    f.render().start();
    f.render().stop();
    f.render().start();
    const current = fakeStream(); f.media[1].resolve(current);
    assert.equal((await f.settle()).phase, "recording");
    const stale = fakeStream(); f.media[0].resolve(stale);
    const view = await f.settle();
    assert.equal(stale.stopped(), 1);
    assert.equal(current.stopped(), 0);
    assert.equal(view.phase, "recording");
    assert.equal(view.captureBusy, true);
    view.start(); assert.equal(f.media.length, 2, "cannot open another microphone while recording");
  } finally { f.dispose(); }
});

test("late transcription after switching conversations cannot reset or send from a newer recording", async () => {
  const transcript = deferred<string>(); let sent = 0;
  const f = voiceComponent({ transcribe: () => transcript.promise, onTranscript: async () => { sent++; return { id: "task", requestId: "request", chatId: "master" }; } });
  try {
    f.render().start(); f.media[0].resolve(fakeStream());
    (await f.settle()).sendRecording();
    assert.equal(f.render().phase, "transcribing");
    f.update({ contextKey: "other" }).start(); f.media[1].resolve(fakeStream());
    assert.equal((await f.settle()).phase, "recording");
    transcript.resolve("old conversation request");
    assert.equal((await f.settle()).phase, "recording");
    assert.equal(sent, 0);
  } finally { f.dispose(); }
});

test("a confirmed refused recording permits one explicit retry and only one task send", async () => {
  let uploads = 0, sent = 0;
  const f = voiceComponent({
    transcribe: async () => { uploads++; if (uploads === 1) throw new TranscriptionUploadRefused("Busy"); return "hello"; },
    onTranscript: async () => { sent++; return { id: "task", requestId: "request", chatId: "master" }; },
  });
  try {
    f.render().start(); f.media[0].resolve(fakeStream()); (await f.settle()).sendRecording();
    const retry = await f.settle();
    assert.equal(retry.phase, "ready"); assert.equal(uploads, 1); assert.equal(sent, 0);
    await f.settle(); assert.equal(uploads, 1, "nothing retries automatically");
    retry.sendRecording(); retry.sendRecording();
    assert.equal((await f.settle()).phase, "waiting");
    assert.equal(uploads, 2); assert.equal(sent, 1);
  } finally { f.dispose(); }
});

test("denied permission remains stopped until an explicit new start", async () => {
  const f = voiceComponent();
  try {
    f.render().start(); f.media[0].reject(new DOMException("Denied", "NotAllowedError"));
    const view = await f.settle();
    assert.equal(view.phase, "idle"); assert.match(view.error, /permission was denied/);
    f.update({ connected: false }); f.update({ connected: true });
    assert.equal(f.media.length, 1);
  } finally { f.dispose(); }
});

test("offline and hidden-page transitions release the microphone without sending or resuming", async () => {
  for (const hide of [false, true]) {
    let sent = 0, uploaded = 0;
    const f = voiceComponent({ transcribe: async () => { uploaded++; return "hello"; }, onTranscript: async () => { sent++; return { id:"task", requestId:"request", chatId:"master" }; } });
    try {
      f.render().start(); const stream = fakeStream(); f.media[0].resolve(stream); await f.settle();
      if (hide) { f.document.visibilityState = "hidden"; f.document.dispatchEvent(new Event("visibilitychange")); }
      else f.window.dispatchEvent(new Event("offline"));
      assert.equal(f.render().phase, "idle"); assert.ok(stream.stopped() > 0);
      f.document.visibilityState = "visible"; f.document.dispatchEvent(new Event("visibilitychange"));
      f.window.dispatchEvent(new Event("online")); f.window.dispatchEvent(new Event("pageshow"));
      await f.settle(); assert.equal(f.media.length, 1); assert.equal(uploaded, 0); assert.equal(sent, 0);
    } finally { f.dispose(); }
  }
});

test("muting aborts active playback and unmuting cannot replay the consumed reply", async () => {
  const signals: AbortSignal[] = [];
  const f = voiceComponent({ speak: (_text: string, signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true }));
  } });
  try {
    f.render().start(); f.media[0].resolve(fakeStream()); (await f.settle()).sendRecording(); await f.settle();
    f.update({ outcomes: [{ id: "task", contextKey: "master", text: "Accepted reply", status: "completed", updatedAt: new Date(0).toISOString() }] });
    assert.equal(f.render().speaking, true); assert.equal(signals.length, 1);
    f.render().toggleMute();
    assert.equal(signals[0].aborted, true); assert.equal((await f.settle()).speaking, false);
    assert.equal(f.render().muted, true);
    f.render().toggleMute(); await f.settle();
    assert.equal(f.render().muted, false); assert.equal(signals.length, 1);
    assert.equal(f.render().canRetry, false);
  } finally { f.dispose(); }
});

test("unmount while permission is pending stops a late microphone without uploading", async () => {
  let uploaded = 0;
  const f = voiceComponent({ transcribe: async () => { uploaded++; return "hello"; } });
  f.render().start(); f.dispose();
  const late = fakeStream(); f.media[0].resolve(late);
  for (let n = 0; n < 8; n++) await Promise.resolve();
  assert.equal(late.stopped(), 1); assert.equal(uploaded, 0);
});
