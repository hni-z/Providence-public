import test from "node:test";
import assert from "node:assert/strict";
import { transcribeElevenLabsAudio, requestElevenLabsSpeech } from "../src/elevenlabs.js";
import {
  MAX_AUDIO_BYTES, MAX_TRANSCRIPT_CHARS, TRANSCRIPTION_TIMEOUT_MS,
  TranscriptionError, type AudioMimeType, type TranscriptionErrorCode,
} from "../src/transcription.js";
import { SpeechError } from "../src/speech-error.js";

const key = "test-only-elevenlabs-private-key";
const voice = "fixtureVoiceId12345";
const model = "eleven_flash_v2_5";
const recording = { base64: Buffer.from("synthetic audio fixture, never physical recording").toString("base64"), mimeType: "audio/webm" as const };
const errorCode = (code: TranscriptionErrorCode) => (error: unknown) => error instanceof TranscriptionError && error.code === code;

test("ElevenLabs STT sends one authenticated multipart file with a simple synchronous response shape", async () => {
  const formats: [AudioMimeType, string][] = [["audio/webm", "webm"], ["audio/mp4", "mp4"], ["audio/ogg", "ogg"], ["audio/wav", "wav"]];
  for (const [mimeType, extension] of formats) {
    let attempts = 0;
    const result = await transcribeElevenLabsAudio({ ...recording, mimeType }, key, undefined, async (url, init) => {
      attempts++;
      assert.equal(url, "https://api.elevenlabs.io/v1/speech-to-text");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(init?.headers, { "xi-api-key": key });
      assert.ok(init?.signal instanceof AbortSignal);
      const form = init?.body as FormData;
      assert.equal(form.get("model_id"), "scribe_v2");
      for (const field of ["tag_audio_events", "diarize", "webhook", "use_multi_channel"])
        assert.equal(form.get(field), "false");
      assert.equal(form.get("timestamps_granularity"), "none");
      assert.equal(form.has("source_url"), false);
      assert.equal(form.has("api_key"), false);
      const file = form.get("file") as File;
      assert.equal(file.name, `recording.${extension}`);
      assert.equal(file.type, mimeType);
      assert.equal(Buffer.from(await file.arrayBuffer()).toString("base64"), recording.base64);
      return Response.json({ text: "  Exact recognized phrase.  ", words: [], privateProviderField: key });
    });
    assert.deepEqual(result, { text: "Exact recognized phrase." });
    assert.equal(attempts, 1);
  }
});

test("STT validates canonical audio and bounded configuration before any provider request", async () => {
  let attempts = 0;
  const fetcher: typeof fetch = async () => { attempts++; return Response.json({ text: "Accepted fixture" }); };
  for (const base64 of ["", "Zh==", "Zg==\n", "not base64", "data:audio/wav;base64,Zg=="])
    await assert.rejects(transcribeElevenLabsAudio({ ...recording, base64 }, key, "scribe_v2", fetcher), errorCode("invalid_audio"));
  await assert.rejects(transcribeElevenLabsAudio({ ...recording, mimeType: "text/plain" }, key, "scribe_v2", fetcher), errorCode("invalid_audio"));
  await assert.rejects(transcribeElevenLabsAudio({ ...recording, base64: Buffer.alloc(MAX_AUDIO_BYTES + 1).toString("base64") }, key, "scribe_v2", fetcher), errorCode("audio_too_large"));
  for (const invalid of ["", "tiny", "a".repeat(513), "test\nprivatecredential", "test-credential-\u2603"])
    await assert.rejects(transcribeElevenLabsAudio(recording, invalid, "scribe_v2", fetcher), errorCode("provider_not_configured"));
  for (const invalid of ["", "scribe_v2\r\n", "x".repeat(201)])
    await assert.rejects(transcribeElevenLabsAudio(recording, key, invalid, fetcher), errorCode("provider_not_configured"));
  assert.equal(attempts, 0);
  await transcribeElevenLabsAudio({ ...recording, base64: Buffer.alloc(MAX_AUDIO_BYTES).toString("base64") }, key, "scribe_v2", fetcher);
  assert.equal(attempts, 1);
});

test("STT status failures are sanitized, cancelled and never retried", async () => {
  const cases: [number, TranscriptionErrorCode][] = [
    [400, "provider_rejected"], [401, "provider_authentication"], [402, "provider_rejected"],
    [403, "provider_authentication"], [404, "provider_rejected"], [422, "provider_rejected"],
    [429, "provider_rate_limited"], [500, "provider_unavailable"], [503, "provider_unavailable"],
  ];
  for (const [status, code] of cases) {
    let attempts = 0, cancelled = false;
    await assert.rejects(transcribeElevenLabsAudio(recording, key, "scribe_v2", async () => {
      attempts++;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(`private provider detail: ${key}`)); },
        cancel() { cancelled = true; },
      }), { status });
    }), error => {
      assert.ok(errorCode(code)(error));
      assert.equal((error as Error).message.includes(key), false);
      return true;
    });
    assert.equal(attempts, 1);
    assert.equal(cancelled, true);
  }
  await assert.rejects(transcribeElevenLabsAudio(recording, key, "scribe_v2", async () => { throw new Error(key); }), error => {
    assert.ok(errorCode("provider_network")(error));
    assert.equal((error as Error).message.includes(key), false);
    return true;
  });
});

test("STT rejects missing, empty, oversized or malformed transcripts and enforces streamed JSON bytes", async () => {
  for (const [body, code] of [
    [{ text: 1 }, "invalid_response"], [{ text: " \n" }, "no_speech"],
    [{ transcripts: [{ text: "unexpected multichannel" }] }, "invalid_response"],
    [{ text: "x".repeat(MAX_TRANSCRIPT_CHARS + 1) }, "transcript_too_long"],
  ] as [unknown, TranscriptionErrorCode][])
    await assert.rejects(transcribeElevenLabsAudio(recording, key, "scribe_v2", async () => Response.json(body)), errorCode(code));
  await assert.rejects(transcribeElevenLabsAudio(recording, key, "scribe_v2", async () => new Response("malformed JSON")), errorCode("invalid_response"));
  await assert.rejects(transcribeElevenLabsAudio(recording, key, "scribe_v2", async () => new Response(null)), errorCode("invalid_response"));
  let cancelled = false;
  await assert.rejects(transcribeElevenLabsAudio(recording, key, "scribe_v2", async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(32 * 1024));
      controller.enqueue(new Uint8Array(32 * 1024 + 1));
    },
    cancel() { cancelled = true; },
  }))), errorCode("invalid_response"));
  assert.equal(cancelled, true);
  const text = "x".repeat(MAX_TRANSCRIPT_CHARS);
  assert.deepEqual(await transcribeElevenLabsAudio(recording, key, "scribe_v2", async () => Response.json({ text })), { text });
});

test("STT aborts its one request at 60 seconds and hides transport rejection details", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  let signal: AbortSignal | undefined;
  const pending = transcribeElevenLabsAudio(recording, key, "scribe_v2", async (_url, init) => {
    attempts++;
    signal = init!.signal!;
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error(key)), { once: true }));
  });
  const rejected = assert.rejects(pending, errorCode("provider_timeout"));
  t.mock.timers.tick(TRANSCRIPTION_TIMEOUT_MS - 1);
  assert.equal(signal!.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(attempts, 1);
  t.mock.timers.reset();
});

test("a timed-out STT response cannot return a transcript when its headers arrive late", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolve!: (value: Response) => void;
  const pending = transcribeElevenLabsAudio(recording, key, "scribe_v2", async () => new Promise(done => { resolve = done; }));
  const rejected = assert.rejects(pending, errorCode("provider_timeout"));
  t.mock.timers.tick(TRANSCRIPTION_TIMEOUT_MS);
  resolve(Response.json({ text: "Must never submit this late transcript" }));
  await rejected;
  t.mock.timers.reset();
});

test("a timeout while reading STT body prevents late completed text", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let ready!: () => void;
  const reading = new Promise<void>(done => { ready = done; });
  const pending = transcribeElevenLabsAudio(recording, key, "scribe_v2", async () => new Response(new ReadableStream({
    start(controller) { stream = controller; },
    pull() { ready(); },
  })));
  const rejected = assert.rejects(pending, errorCode("provider_timeout"));
  await reading;
  t.mock.timers.tick(TRANSCRIPTION_TIMEOUT_MS);
  stream.enqueue(new TextEncoder().encode(JSON.stringify({ text: "Late transcript" })));
  stream.close();
  await rejected;
  t.mock.timers.reset();
});

test("TTS makes one exact authenticated streaming request and leaves response processing to Speech", async () => {
  let attempts = 0;
  const controller = new AbortController();
  const response = new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
  const result = await requestElevenLabsSpeech("  Exact reply.\n", key, voice, model, controller.signal, async (url, init) => {
    attempts++;
    assert.equal(url, `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=mp3_44100_128`);
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.signal, controller.signal);
    assert.deepEqual(init?.headers, { "xi-api-key": key, "Content-Type": "application/json" });
    assert.deepEqual(JSON.parse(String(init?.body)), { text: "  Exact reply.\n", model_id: model });
    return response;
  });
  assert.equal(result, response);
  assert.equal(response.bodyUsed, false);
  assert.equal(attempts, 1);
  for (const status of [401, 402, 422, 429, 503]) {
    const failure = new Response("provider body for outer Speech to discard", { status });
    assert.equal(await requestElevenLabsSpeech("Reply", key, voice, model, controller.signal, async () => failure), failure);
    assert.equal(failure.bodyUsed, false);
  }
});

test("TTS invalid text/configuration cannot dispatch and no voice defaults are invented", async () => {
  let attempts = 0;
  const fetcher: typeof fetch = async () => { attempts++; return new Response(); };
  const signal = new AbortController().signal;
  for (const text of ["", " \n", "x".repeat(4001)])
    await assert.rejects(requestElevenLabsSpeech(text, key, voice, model, signal, fetcher), error => error instanceof SpeechError && error.status === 400);
  for (const [apiKey, voiceId, modelId] of [["", voice, model], [key, "", model], [key, "../voice", model], [key, "x".repeat(201), model], [key, voice, ""], [key, voice, "model\r\n"], ["x".repeat(513), voice, model]])
    await assert.rejects(requestElevenLabsSpeech("Reply", apiKey, voiceId, modelId, signal, fetcher), error => error instanceof SpeechError && error.status === 503 && !error.message.includes(key));
  assert.equal(attempts, 0);
});

test("TTS propagates cancellation before and during fetch without leaking abort reasons or retrying", async () => {
  let attempts = 0;
  const early = new AbortController();
  early.abort(new Error(key));
  await assert.rejects(requestElevenLabsSpeech("Reply", key, voice, model, early.signal, async () => { attempts++; return new Response(); }), error => error instanceof DOMException && error.name === "AbortError" && !error.message.includes(key));
  assert.equal(attempts, 0);
  const controller = new AbortController();
  const pending = requestElevenLabsSpeech("Reply", key, voice, model, controller.signal, async (_url, init) => {
    attempts++;
    return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error(key)), { once: true }));
  });
  controller.abort(new Error(key));
  await assert.rejects(pending, error => error instanceof DOMException && error.name === "AbortError" && !error.message.includes(key));
  assert.equal(attempts, 1);
});

test("TTS discards headers received after Stop and sanitizes network errors", async () => {
  const controller = new AbortController();
  let cancelled = false;
  await assert.rejects(requestElevenLabsSpeech("Reply", key, voice, model, controller.signal, async () => {
    controller.abort();
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  }), error => error instanceof DOMException && error.name === "AbortError");
  assert.equal(cancelled, true);
  let attempts = 0;
  await assert.rejects(requestElevenLabsSpeech("Reply", key, voice, model, new AbortController().signal, async () => { attempts++; throw new Error(`xi-api-key=${key}`); }), error => error instanceof Error && !error.message.includes(key));
  assert.equal(attempts, 1);
});
