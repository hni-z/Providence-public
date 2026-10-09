import test from "node:test";
import assert from "node:assert/strict";
import { LivePcmEncoder, LIVE_PCM_CHUNK_SAMPLES } from "../web/src/live-voice-pcm.js";
import { LiveVoiceInput } from "../web/src/live-voice-session.js";
import { prepareLivePcmCapture, type PcmCaptureEnvironment } from "../web/src/live-voice-capture.js";

function encoded(rate: number, channels: Float32Array[], splits = [channels[0].length], maxSamples?: number) {
  const chunks: ArrayBuffer[] = [], sequences: number[] = [];
  const encoder = new LivePcmEncoder(rate, (pcm, sequence) => { chunks.push(pcm); sequences.push(sequence); }, maxSamples);
  let offset = 0, part = 0;
  while (offset < channels[0].length) {
    const end = Math.min(offset + splits[part++ % splits.length], channels[0].length);
    encoder.push(channels.map(channel => channel.subarray(offset, end))); offset = end;
  }
  encoder.finish(); encoder.finish();
  return { encoder, chunks, sequences, bytes: Buffer.concat(chunks.map(chunk => Buffer.from(chunk))) };
}
test("PCM is signed mono16 little endian with bounded clipping and stereo downmix", () => {
  const result = encoded(24_000, [new Float32Array([0, 1, -1, .5, -.5, 2, -2, NaN])]);
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => result.bytes.readInt16LE(i * 2)), [0, 32767, -32768, 16384, -16384, 32767, -32768, 0]);
  assert.deepEqual(result.sequences, [0]);
  assert.deepEqual(encoded(24_000, [new Float32Array([1, .5]), new Float32Array([-1, -.5])]).bytes, Buffer.alloc(4));
});
test("44.1/48kHz streaming resampling is independent of quantum boundaries", () => {
  for (const rate of [44_100, 48_000]) {
    const input = Float32Array.from({ length: rate }, (_, i) => Math.sin(i / 37) * .6);
    const whole = encoded(rate, [input]); const split = encoded(rate, [input], [128, 127, 511, 1]);
    assert.deepEqual(split.bytes, whole.bytes); assert.equal(split.bytes.length, 48_000);
    assert.ok(split.chunks.every(chunk => chunk.byteLength <= LIVE_PCM_CHUNK_SAMPLES * 2));
    assert.deepEqual(split.sequences, split.sequences.map((_, i) => i));
  }
});
test("duration cap flushes exactly one bounded tail; cancellation discards unfinished samples", () => {
  const limited = encoded(48_000, [new Float32Array(10_000).fill(.25)], [128], 2500);
  assert.equal(limited.encoder.limited, true); assert.equal(limited.bytes.length, 5000);
  assert.deepEqual(limited.chunks.map(chunk => chunk.byteLength), [4800, 200]);
  let calls = 0; const cancelled = new LivePcmEncoder(24_000, () => calls++);
  cancelled.push([new Float32Array(100)]); cancelled.cancel(); cancelled.finish(); cancelled.push([new Float32Array(5000)]);
  assert.equal(calls, 0);
});
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
test("live audio writes in sequence through a bounded window and finalizes after every write", async () => {
  let release!: () => void; const writes: number[] = [], final: number[] = [];
  const input = new LiveVoiceInput({ write: async (_pcm, sequence) => {
    writes.push(sequence); if (sequence === 0) await new Promise<void>(done => { release = done; });
  }, finish: async last => { final.push(last); return " Final words "; }, cancel() {} }, () => assert.fail("Unexpected failure"), new AbortController().signal);
  input.write(new ArrayBuffer(4800), 0); input.write(new ArrayBuffer(100), 1); await flush();
  assert.deepEqual(writes, [0, 1]); const one = input.finish(), duplicate = input.finish(); assert.equal(one, duplicate);
  assert.deepEqual(final, []); release(); assert.equal(await one, "Final words");
  assert.deepEqual(writes, [0, 1]); assert.deepEqual(final, [1]);
});
test("sustained 100ms capture tolerates 200–300ms acknowledgements without growing an inevitable backlog", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const latency of [200, 300]) {
    let inFlight = 0, maxInFlight = 0, failures = 0, commits = 0; const written: number[] = [];
    const input = new LiveVoiceInput({
      write: async (_pcm, sequence) => {
        written.push(sequence); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>(done => setTimeout(done, latency)); inFlight--;
      },
      finish: async last => { assert.equal(last, 249); commits++; return "Full 25-second fixture"; },
      cancel() { assert.fail("Healthy delayed acknowledgements must not cancel capture"); },
    }, () => failures++, new AbortController().signal);
    for (let sequence = 0; sequence < 250; sequence++) {
      input.write(new ArrayBuffer(4800), sequence); t.mock.timers.tick(100); await flush();
    }
    const final = input.finish(); t.mock.timers.tick(300); await flush();
    assert.equal(await final, "Full 25-second fixture"); assert.equal(failures, 0); assert.equal(commits, 1);
    assert.ok(maxInFlight <= 8 && maxInFlight > 1); assert.deepEqual(written, Array.from({ length: 250 }, (_, i) => i));
  }
});
test("cancel fences late final transcript and bounded backpressure cancels without commit", async () => {
  let resolve!: (text: string) => void, cancels = 0, commits = 0;
  const abort = new AbortController();
  const input = new LiveVoiceInput({ write: async () => {}, finish: async () => { commits++; return new Promise(done => { resolve = done; }); }, cancel() { cancels++; } }, () => {}, abort.signal);
  input.write(new ArrayBuffer(10), 0); const final = input.finish(); await flush(); abort.abort(); resolve("late text");
  await assert.rejects(final, { name: "AbortError" }); assert.equal(commits, 1); assert.equal(cancels, 1);
  let failed = 0, overloadedCancel = 0;
  const blocked = new LiveVoiceInput({ write: () => new Promise(() => {}), finish: async () => { assert.fail("Never commit overloaded audio"); }, cancel() { overloadedCancel++; } }, () => failed++, new AbortController().signal);
  for (let i = 0; i < 20; i++) blocked.write(new ArrayBuffer(4800), i);
  assert.equal(failed, 1); assert.equal(overloadedCancel, 1);
});

function captureFixture() {
  const port = { onmessage: null as ((event: { data: unknown }) => void) | null, messages: [] as any[], closed: false,
    postMessage(data: unknown) { this.messages.push(data); }, close() { this.closed = true; } };
  const track = { stops: 0, stop() { this.stops++; } };
  const stream = { getTracks: () => [track] };
  const source = { connect() {}, disconnect() {} };
  const node = { port, onprocessorerror: null, connect() {}, disconnect() {} };
  const context = { closes: 0, resume: async () => {}, close: async () => { context.closes++; },
    audioWorklet: { addModule: async (_url: string) => {} }, createMediaStreamSource: () => source, destination: {} };
  const environment = { getUserMedia: async () => stream, context: () => context, worklet: () => node, moduleUrl: async () => "/fixture-worklet.js" } as unknown as PcmCaptureEnvironment;
  const controller = new AbortController(), chunks: number[] = [], errors: string[] = [];
  const options = { signal: controller.signal, onChunk: (_pcm: ArrayBuffer, sequence: number) => chunks.push(sequence), onError: (error: string) => errors.push(error) };
  return { environment, options, controller, port, track, context, stream, chunks, errors,
    message: (data: unknown) => port.onmessage?.({ data }) };
}
test("capture has no audio until explicit start and finish preserves the FIFO tail before cleanup", async () => {
  const f = captureFixture(); const capture = await prepareLivePcmCapture(f.options, f.environment);
  assert.deepEqual(f.port.messages, []); capture.start(); capture.start(); assert.deepEqual(f.port.messages, [{ type: "start" }]);
  f.message({ type: "pcm", pcm: new ArrayBuffer(4800), sequence: 0 });
  let finished = false; const result = capture.finish().then(() => { finished = true; });
  await flush(); assert.equal(finished, false);
  f.message({ type: "pcm", pcm: new ArrayBuffer(100), sequence: 1 }); f.message({ type: "stopped" }); await result;
  assert.deepEqual(f.chunks, [0, 1]); assert.equal(f.track.stops, 1); assert.equal(f.context.closes, 1); assert.equal(f.port.closed, true);
  f.message({ type: "pcm", pcm: new ArrayBuffer(100), sequence: 2 }); assert.deepEqual(f.chunks, [0, 1]);
});
test("cancel while microphone permission is pending stops the late stream and never starts processing", async () => {
  const f = captureFixture(); let grant!: (stream: MediaStream) => void;
  f.environment.getUserMedia = () => new Promise(done => { grant = done; });
  const pending = prepareLivePcmCapture(f.options, f.environment); f.controller.abort(); grant(f.stream as unknown as MediaStream);
  await assert.rejects(pending, { name: "AbortError" }); assert.equal(f.track.stops, 1); assert.deepEqual(f.port.messages, []);
});
test("invalid worklet output aborts capture and discards stop result", async () => {
  const f = captureFixture(); const capture = await prepareLivePcmCapture(f.options, f.environment); capture.start();
  const finishing = capture.finish(); f.message({ type: "pcm", pcm: new ArrayBuffer(10), sequence: 9 });
  await assert.rejects(finishing, { name: "AbortError" }); assert.equal(f.errors.length, 1); assert.deepEqual(f.chunks, []);
  assert.equal(f.track.stops, 1);
});
