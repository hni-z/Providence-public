export const LIVE_PCM_SAMPLE_RATE = 24_000;
export const LIVE_PCM_CHUNK_SAMPLES = 2400; // 100 ms, 4800 bytes, explicit little endian.
export const LIVE_PCM_MAX_MS = 25_000;
export const LIVE_PCM_MAX_BYTES = LIVE_PCM_SAMPLE_RATE * 2 * LIVE_PCM_MAX_MS / 1000;

/** Stateful linear resampling across render-quantum boundaries, not per-block rounding.
 * Worklet buffers stay one chunk large. Input channel arrays are never retained.
 */
export class LivePcmEncoder {
  private inputIndex = -1;
  private previous = 0;
  private outputIndex = 0;
  private chunk = new ArrayBuffer(LIVE_PCM_CHUNK_SAMPLES * 2);
  private view = new DataView(this.chunk);
  private size = 0;
  private done = false;
  private sequence = 0;
  constructor(readonly inputRate: number, private readonly emit: (pcm: ArrayBuffer, sequence: number) => void,
    readonly maxSamples = LIVE_PCM_SAMPLE_RATE * LIVE_PCM_MAX_MS / 1000) {
    if (!Number.isFinite(inputRate) || inputRate < 8000 || inputRate > 192000 ||
        !Number.isSafeInteger(maxSamples) || maxSamples < 1 || maxSamples > LIVE_PCM_MAX_BYTES / 2)
      throw new Error("Unsupported live microphone sample rate or duration.");
  }
  get limited() { return this.outputIndex >= this.maxSamples; }
  get samples() { return this.outputIndex; }
  push(channels: readonly Float32Array[]): void {
    if (this.done || !channels.length) return;
    const length = Math.min(...channels.map(channel => channel.length));
    for (let frame = 0; frame < length && !this.done; frame++) {
      let sample = 0;
      for (const channel of channels) sample += Number.isFinite(channel[frame]) ? channel[frame] : 0;
      sample /= channels.length;
      this.inputIndex++;
      if (this.inputIndex === 0) this.previous = sample;
      while (this.outputIndex * this.inputRate / LIVE_PCM_SAMPLE_RATE <= this.inputIndex) {
        const position = this.outputIndex * this.inputRate / LIVE_PCM_SAMPLE_RATE;
        const fraction = this.inputIndex === 0 ? 1 : position - (this.inputIndex - 1);
        const value = Math.max(-1, Math.min(1, this.previous + (sample - this.previous) * fraction));
        this.view.setInt16(this.size * 2, Math.round(value < 0 ? value * 32768 : value * 32767), true);
        this.size++; this.outputIndex++;
        if (this.size === LIVE_PCM_CHUNK_SAMPLES) this.flushChunk();
        if (this.limited) { this.finish(); break; }
      }
      this.previous = sample;
    }
  }
  private flushChunk() {
    if (!this.size) return;
    const bytes = this.size === LIVE_PCM_CHUNK_SAMPLES ? this.chunk : this.chunk.slice(0, this.size * 2);
    this.chunk = new ArrayBuffer(LIVE_PCM_CHUNK_SAMPLES * 2); this.view = new DataView(this.chunk); this.size = 0;
    this.emit(bytes, this.sequence++);
  }
  finish() { if (this.done) return; this.done = true; this.flushChunk(); }
  cancel() { this.done = true; this.size = 0; }
}
