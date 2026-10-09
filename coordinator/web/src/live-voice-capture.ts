/// <reference path="./live-voice-assets.d.ts" />
import { LIVE_PCM_CHUNK_SAMPLES, LIVE_PCM_MAX_BYTES, LIVE_PCM_MAX_MS, LIVE_PCM_SAMPLE_RATE } from "./live-voice-pcm.js";

export type LivePcmCapture = { start(): void; finish(): Promise<void>; cancel(): void };
export function livePcmSupported(scope: typeof globalThis = globalThis): boolean {
  return scope.isSecureContext !== false && typeof scope.AudioContext === "function" &&
    typeof scope.AudioWorkletNode === "function" && typeof scope.navigator?.mediaDevices?.getUserMedia === "function";
}
export type PcmCaptureEnvironment = {
  getUserMedia(): Promise<MediaStream>;
  context(): AudioContext;
  worklet(context: AudioContext): AudioWorkletNode;
  moduleUrl(): Promise<string>;
};
const browserEnvironment = (): PcmCaptureEnvironment => ({
  getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false }),
  context: () => {
    try { return new AudioContext({ sampleRate: LIVE_PCM_SAMPLE_RATE, latencyHint: "interactive" }); }
    catch (error) {
      if (!(error instanceof DOMException) || error.name !== "NotSupportedError") throw error;
      return new AudioContext({ latencyHint: "interactive" }); // Resample its actual rate in the worklet.
    }
  },
  worklet: context => new AudioWorkletNode(context, "providence-live-pcm", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] }),
  moduleUrl: async () => (await import("./live-voice-worklet.ts?worker&url")).default,
});

/** Prepare on an explicit user gesture; the worklet starts only after server readiness.
 * No network/provider dependency. finish awaits the worklet's FIFO tail/stop ACK.
 */
export async function prepareLivePcmCapture(options: {
  signal: AbortSignal;
  onChunk(pcm: ArrayBuffer, sequence: number): void;
  onError(message: string): void;
}, environment = browserEnvironment()): Promise<LivePcmCapture> {
  const { signal } = options;
  signal.throwIfAborted();
  const context = environment.context();
  let stream: MediaStream | undefined, node: AudioWorkletNode | undefined, source: MediaStreamAudioSourceNode | undefined;
  let ended = false, started = false, total = 0, expectedSequence = 0;
  let tracksStopped = false;
  let finishPromise: Promise<void> | undefined, finishResolve: (() => void) | undefined, finishReject: ((error: Error) => void) | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined, limitTimer: ReturnType<typeof setTimeout> | undefined;
  const stopTracks = () => { if (stream && !tracksStopped) { tracksStopped = true; stream.getTracks().forEach(track => track.stop()); } };
  const cleanup = () => {
    clearTimeout(flushTimer); clearTimeout(limitTimer); signal.removeEventListener("abort", abort);
    if (node) { node.port.onmessage = null; node.onprocessorerror = null; try { node.disconnect(); } catch {} node.port.close(); }
    try { source?.disconnect(); } catch {} stopTracks();
    void context.close().catch(() => {});
  };
  const cancel = () => {
    if (ended) return; ended = true;
    node?.port.postMessage({ type: "cancel" });
    finishReject?.(new DOMException("Live voice cancelled", "AbortError")); cleanup();
  };
  const abort = () => cancel();
  const fail = (message: string) => { if (ended) return; cancel(); options.onError(message); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    // Resume within the initial gesture, before waiting for microphone permission.
    const resumed = context.resume().then(() => undefined, () => new Error("The browser could not start live microphone processing."));
    stream = await environment.getUserMedia();
    if (signal.aborted || ended) { stopTracks(); signal.throwIfAborted(); throw new Error("Live capture stopped."); }
    const resumeError = await resumed;
    if (resumeError) throw resumeError;
    signal.throwIfAborted();
    await context.audioWorklet.addModule(await environment.moduleUrl()); signal.throwIfAborted();
    node = environment.worklet(context);
    node.onprocessorerror = () => fail("Live microphone processing stopped. Nothing was submitted.");
    node.port.onmessage = ({ data }) => {
      if (ended || signal.aborted) return;
      if (data?.type === "pcm") {
        if (!started || !(data.pcm instanceof ArrayBuffer) || data.sequence !== expectedSequence || !data.pcm.byteLength ||
            data.pcm.byteLength % 2 || data.pcm.byteLength > LIVE_PCM_CHUNK_SAMPLES * 2 || total + data.pcm.byteLength > LIVE_PCM_MAX_BYTES) {
          fail("Live microphone returned invalid audio. Nothing was submitted."); return;
        }
        expectedSequence++; total += data.pcm.byteLength;
        try { options.onChunk(data.pcm, data.sequence); }
        catch { fail("Live audio could not be delivered. Nothing was submitted."); }
      } else if (data?.type === "stopped" && finishPromise) {
        ended = true; cleanup(); finishResolve?.();
      } else if (data?.type === "limit") fail("The 25-second live recording limit was reached. Nothing was submitted.");
    };
    source = context.createMediaStreamSource(stream);
    source.connect(node); node.connect(context.destination); // Processor emits silence, never microphone monitoring.
    return {
      start() {
        if (ended || started || signal.aborted) return;
        started = true; node!.port.postMessage({ type: "start" });
        limitTimer = setTimeout(() => fail("The 25-second live recording limit was reached. Nothing was submitted."), LIVE_PCM_MAX_MS + 250);
      },
      finish() {
        if (finishPromise) return finishPromise;
        if (ended || !started || signal.aborted) return Promise.reject(new DOMException("Live voice stopped", "AbortError"));
        clearTimeout(limitTimer);
        finishPromise = new Promise<void>((resolve, reject) => { finishResolve = resolve; finishReject = reject; });
        node!.port.postMessage({ type: "stop" });
        stopTracks(); // User stop ends mic access immediately; queued PCM tail still drains before ACK.
        flushTimer = setTimeout(() => fail("The microphone could not finish this recording. Nothing was submitted."), 2000);
        return finishPromise;
      }, cancel,
    };
  } catch (error) { cancel(); throw error; }
}
