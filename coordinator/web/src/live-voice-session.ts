import { LIVE_PCM_MAX_BYTES, LIVE_PCM_CHUNK_SAMPLES } from "./live-voice-pcm.js";

/** Adapter promise resolves only after the service's explicit live-ready ACK. */
export type LiveVoiceSession = {
  write(pcm: ArrayBuffer, sequence: number): Promise<void>;
  finish(lastSequence: number): Promise<string>;
  cancel(): void;
};
export type LiveVoiceAdapter = (options: { signal: AbortSignal; onPartial(text: string): void }) => Promise<LiveVoiceSession>;
export const LIVE_VOICE_IN_FLIGHT_CHUNKS = 8;

/** Ordered, bounded pipelined delivery; final text alone never executes a task.
 * Deliberate finish reserves one commit, and cancel fences every late completion.
 */
export class LiveVoiceInput {
  private pendingBytes = 0;
  private totalBytes = 0;
  private nextSequence = 0;
  private cancelled = false;
  private committed = false;
  private queue: Array<{ pcm: ArrayBuffer; sequence: number }> = [];
  private inFlight = 0;
  private drainResolve?: () => void;
  private drainReject?: (error: Error) => void;
  private result?: Promise<string>;
  constructor(private readonly session: LiveVoiceSession, private readonly onFailure: (message: string) => void,
    private readonly signal: AbortSignal) {
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.cancel();
  }
  private abort = () => this.cancel();
  write(pcm: ArrayBuffer, sequence: number) {
    if (this.cancelled || this.committed) return;
    if (sequence !== this.nextSequence || !pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > LIVE_PCM_CHUNK_SAMPLES * 2 ||
        this.totalBytes + pcm.byteLength > LIVE_PCM_MAX_BYTES || this.pendingBytes + pcm.byteLength > 64 * 1024) {
      this.failed(); return;
    }
    this.nextSequence++; this.pendingBytes += pcm.byteLength; this.totalBytes += pcm.byteLength;
    this.queue.push({ pcm, sequence }); this.pump();
  }
  private pump() {
    while (!this.cancelled && this.inFlight < LIVE_VOICE_IN_FLIGHT_CHUNKS && this.queue.length) {
      const next = this.queue.shift()!; this.inFlight++;
      let written: Promise<void>;
      try { written = this.session.write(next.pcm, next.sequence); }
      catch { this.failed(); return; }
      void written.then(() => {
        if (this.cancelled) return;
        this.inFlight--; this.pendingBytes -= next.pcm.byteLength;
        this.pump();
        if (!this.inFlight && !this.queue.length) this.drainResolve?.();
      }, () => this.failed());
    }
  }
  finish(): Promise<string> {
    if (this.result) return this.result;
    if (this.cancelled || this.signal.aborted) return Promise.reject(new DOMException("Live voice cancelled", "AbortError"));
    this.committed = true;
    const drained = this.inFlight || this.queue.length
      ? new Promise<void>((resolve, reject) => { this.drainResolve = resolve; this.drainReject = reject; }) : Promise.resolve();
    this.result = drained.then(async () => {
      if (this.cancelled || !this.totalBytes) throw new Error("No live recording was submitted.");
      const text = await this.session.finish(this.nextSequence - 1);
      if (this.cancelled || this.signal.aborted) throw new DOMException("Live voice cancelled", "AbortError");
      if (!text.trim() || text.length > 8000) throw new Error("The live transcript was empty or too long. Nothing was submitted.");
      this.signal.removeEventListener("abort", this.abort);
      return text.trim();
    });
    return this.result;
  }
  private failed() { if (this.cancelled) return; this.cancel(); this.onFailure("Live audio delivery failed or could not keep up. Nothing was submitted or retried."); }
  cancel() {
    if (this.cancelled) return; this.cancelled = true;
    this.signal.removeEventListener("abort", this.abort);
    this.queue.length = 0;
    this.drainReject?.(new DOMException("Live voice cancelled", "AbortError"));
    this.session.cancel();
  }
}
