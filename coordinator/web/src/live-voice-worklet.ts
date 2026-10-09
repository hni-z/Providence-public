import { LivePcmEncoder } from "./live-voice-pcm.js";
declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
  abstract process(inputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class ProvidenceLivePcm extends AudioWorkletProcessor {
  private recording = false;
  private ended = false;
  private encoder = new LivePcmEncoder(sampleRate, (pcm, sequence) => this.port.postMessage({ type: "pcm", pcm, sequence }, [pcm]));
  constructor(options?: unknown) {
    super(options);
    this.port.onmessage = ({ data }) => {
      if (data?.type === "start" && !this.ended) this.recording = true;
      if (data?.type === "stop" && !this.ended) {
        this.recording = false; this.ended = true; this.encoder.finish();
        this.port.postMessage({ type: "stopped" });
      }
      if (data?.type === "cancel") { this.recording = false; this.ended = true; this.encoder.cancel(); }
    };
  }
  process(inputs: Float32Array[][]): boolean {
    if (this.ended) return false;
    if (this.recording && inputs[0]?.length) {
      this.encoder.push(inputs[0]);
      if (this.encoder.limited) {
        this.recording = false; this.ended = true;
        this.port.postMessage({ type: "limit" }); return false;
      }
    }
    return true;
  }
}
registerProcessor("providence-live-pcm", ProvidenceLivePcm);
