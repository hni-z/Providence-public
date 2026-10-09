import { createHash } from "node:crypto";

/**
 * Per-capture Realtime transcription protocol adapter. This is deliberately
 * transport-only: it does not open a URL, reconnect, replay, dispatch actions,
 * or claim that a provider capability is live.
 * Session shape follows https://developers.openai.com/api/docs/guides/realtime-transcription
 */
export const LIVE_TRANSCRIPTION_MAX_AUDIO_BYTES = 1_440_000;
export const LIVE_TRANSCRIPTION_MAX_CHUNK_BYTES = 65_536;
// A stop can flush a partial final frame containing a single complete PCM sample.
export const LIVE_TRANSCRIPTION_MIN_CHUNK_BYTES = 2;
export const LIVE_TRANSCRIPTION_MAX_CHUNKS = 600;
export const LIVE_TRANSCRIPTION_MAX_TRANSCRIPT_CHARS = 8_000;

export type LiveTranscriptionIdentity = Readonly<{ requestId: string; streamId: string; deviceId: string }>;
export type LiveTranscriptionTransport = Readonly<{ send(frame: Record<string, unknown>): void; close(): void }>;
export type LiveTranscriptionTimers = Readonly<{ setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }>;
export type LiveTranscriptionOptions = Readonly<{ handshakeTimeoutMs?: number; finalTimeoutMs?: number; captureTimeoutMs?: number; timers?: LiveTranscriptionTimers; onUpdate?: (snapshot: LiveTranscriptionSnapshot) => void }>;
export type LiveTranscriptionState = "new" | "opening" | "capturing" | "committed" | "completed" | "cancelled" | "transport_closed" | "timed_out" | "failed";
export type LiveTranscriptionSnapshot = Readonly<{
  identity: LiveTranscriptionIdentity; state: LiveTranscriptionState; revision: number; nextSequence: number; audioBytes: number;
  userCommitted: boolean; providerCommittedItemId?: string; itemId?: string; partial: string; final?: string; errorCode?: string;
}>;

const DEFAULT_TIMERS: LiveTranscriptionTimers = { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
const TERMINAL = new Set<LiveTranscriptionState>(["completed", "cancelled", "transport_closed", "timed_out", "failed"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const canonicalBase64 = (value: string) => /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0 && Buffer.from(value, "base64").toString("base64") === value;
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");

export class LiveTranscriptionSession {
  readonly identity: LiveTranscriptionIdentity;
  readonly #transport: LiveTranscriptionTransport;
  readonly #timers: LiveTranscriptionTimers;
  readonly #onUpdate?: (snapshot: LiveTranscriptionSnapshot) => void;
  readonly #handshakeTimeoutMs: number;
  readonly #finalTimeoutMs: number;
  readonly #captureTimeoutMs: number;
  #state: LiveTranscriptionState = "new";
  #revision = 0;
  #nextSequence = 0;
  #audioBytes = 0;
  #chunks = new Map<number, string>();
  #userCommitted = false;
  #providerCommittedItemId?: string;
  #itemId?: string;
  #partial = "";
  #pendingFinal?: { itemId: string; transcript: string };
  #final?: string;
  #errorCode?: string;
  #commitSequence?: number;
  #closed = false;
  #handshakeTimer?: unknown;
  #captureTimer?: unknown;
  #finalTimer?: unknown;

  constructor(identity: LiveTranscriptionIdentity, transport: LiveTranscriptionTransport, options: LiveTranscriptionOptions = {}) {
    if (!ID.test(identity.requestId) || !ID.test(identity.streamId) || !ID.test(identity.deviceId)) throw new Error("Invalid immutable transcription identity");
    this.identity = Object.freeze({ ...identity }); this.#transport = transport; this.#timers = options.timers ?? DEFAULT_TIMERS; this.#onUpdate = options.onUpdate;
    this.#handshakeTimeoutMs = boundedDuration(options.handshakeTimeoutMs, 10_000); this.#finalTimeoutMs = boundedDuration(options.finalTimeoutMs, 15_000); this.#captureTimeoutMs = boundedDuration(options.captureTimeoutMs, 35_000);
  }

  open(): LiveTranscriptionSnapshot {
    if (this.#state !== "new") throw new Error("Transcription session can only open once");
    this.#state = "opening";
    this.#handshakeTimer = this.#timers.setTimeout(() => this.#timeout("handshake_timeout"), this.#handshakeTimeoutMs);
    this.#send({ type: "session.update", session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24_000 }, transcription: { model: "gpt-live-transcribe", delay: "low" }, turn_detection: null } } } });
    return this.#emit();
  }

  append(sequence: number, base64PCM: string): LiveTranscriptionSnapshot {
    this.#requireCapturing();
    if (!Number.isSafeInteger(sequence) || sequence < 0 || typeof base64PCM !== "string" || base64PCM.length > 4 * Math.ceil(LIVE_TRANSCRIPTION_MAX_CHUNK_BYTES / 3) || !canonicalBase64(base64PCM)) throw new Error("Invalid PCM chunk");
    const audio = Buffer.from(base64PCM, "base64");
    if (audio.length < LIVE_TRANSCRIPTION_MIN_CHUNK_BYTES || audio.length % 2 || audio.length > LIVE_TRANSCRIPTION_MAX_CHUNK_BYTES) throw new Error("Invalid PCM chunk");
    const hash = digest(audio), previous = this.#chunks.get(sequence);
    if (previous) { if (previous !== hash) throw new Error("Conflicting PCM chunk sequence"); return this.snapshot(); }
    if (sequence !== this.#nextSequence || this.#chunks.size >= LIVE_TRANSCRIPTION_MAX_CHUNKS) throw new Error("PCM chunk sequence gap or count limit");
    if (this.#audioBytes + audio.length > LIVE_TRANSCRIPTION_MAX_AUDIO_BYTES) throw new Error("PCM capture exceeds 30 second limit");
    this.#chunks.set(sequence, hash); this.#nextSequence++; this.#audioBytes += audio.length;
    this.#send({ type: "input_audio_buffer.append", audio: base64PCM });
    return this.#emit();
  }

  commit(lastSequence: number): LiveTranscriptionSnapshot {
    if (this.#commitSequence !== undefined) { if (lastSequence !== this.#commitSequence) throw new Error("Conflicting PCM commit sequence"); return this.snapshot(); }
    this.#requireCapturing();
    if (!Number.isSafeInteger(lastSequence) || lastSequence !== this.#nextSequence - 1 || !this.#chunks.size) throw new Error("PCM capture is incomplete");
    this.#userCommitted = true; this.#commitSequence = lastSequence; this.#state = "committed"; this.#clear("capture");
    this.#finalTimer = this.#timers.setTimeout(() => this.#timeout("final_timeout"), this.#finalTimeoutMs);
    this.#send({ type: "input_audio_buffer.commit" });
    this.#acceptPendingFinal();
    return this.#emit();
  }

  ingest(event: unknown): LiveTranscriptionSnapshot {
    if (TERMINAL.has(this.#state)) return this.snapshot();
    const value = event && typeof event === "object" && !Array.isArray(event) ? event as Record<string, unknown> : undefined;
    if (!value || typeof value.type !== "string") return this.#fail("provider_event_invalid");
    const type = value.type, itemId = typeof value.item_id === "string" && ID.test(value.item_id) ? value.item_id : undefined;
    if (type === "session.updated") {
      if (!validSessionEcho(value.session)) return this.#fail("provider_session_mismatch");
      this.#clear("handshake");
      if (this.#state === "opening") {
        this.#state = "capturing";
        this.#captureTimer = this.#timers.setTimeout(() => this.#timeout("capture_timeout"), this.#captureTimeoutMs);
      }
      return this.#emit();
    }
    if (type === "session.created" || type === "conversation.item.created" || type === "rate_limits.updated") return this.snapshot();
    if (type === "error" || type === "transcription.failed" || type === "conversation.item.input_audio_transcription.failed") return this.#fail("provider_transcription_failed");
    if ((type === "input_audio_buffer.committed" || type.startsWith("conversation.item.input_audio_transcription.")) && (!this.#audioBytes || !["capturing", "committed"].includes(this.#state))) return this.#fail("provider_sequence_invalid");
    if (type === "input_audio_buffer.committed") {
      if (!this.#userCommitted || this.#state !== "committed") return this.#fail("provider_sequence_invalid");
      if (!itemId) return this.#fail("provider_event_invalid");
      if (!this.#acceptItem(itemId)) return this.snapshot();
      this.#providerCommittedItemId = itemId; this.#acceptPendingFinal(); return this.#emit();
    }
    if (type === "conversation.item.input_audio_transcription.delta") {
      if (!itemId || typeof value.delta !== "string") return this.#fail("provider_event_invalid");
      if (!this.#acceptItem(itemId)) return this.snapshot();
      if (this.#partial.length + value.delta.length > LIVE_TRANSCRIPTION_MAX_TRANSCRIPT_CHARS) return this.#fail("transcript_too_large");
      this.#partial += value.delta; return this.#emit();
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      if (!this.#userCommitted || this.#state !== "committed") return this.#fail("provider_sequence_invalid");
      const transcript = typeof value.transcript === "string" ? value.transcript : undefined;
      if (!itemId || transcript === undefined || transcript.length > LIVE_TRANSCRIPTION_MAX_TRANSCRIPT_CHARS) return this.#fail(transcript === undefined ? "provider_event_invalid" : "transcript_too_large");
      if (!transcript.trim()) return this.#fail("empty_transcript");
      if (!this.#acceptItem(itemId)) return this.snapshot();
      this.#pendingFinal = { itemId, transcript }; this.#acceptPendingFinal(); return this.#emit();
    }
    return /(?:^|[._])error(?:$|[._])|(?:^|[._])failed(?:$|[._])/.test(type) ? this.#fail("provider_transcription_failed") : this.snapshot();
  }

  cancel(): LiveTranscriptionSnapshot { if (!TERMINAL.has(this.#state)) { this.#state = "cancelled"; this.#finish(); } return this.#emit(); }
  transportClosed(): LiveTranscriptionSnapshot { if (!TERMINAL.has(this.#state)) { this.#state = "transport_closed"; this.#errorCode = "transport_closed"; this.#finish(false); } return this.#emit(); }
  snapshot(): LiveTranscriptionSnapshot { return Object.freeze({ identity: this.identity, state: this.#state, revision: this.#revision, nextSequence: this.#nextSequence, audioBytes: this.#audioBytes, userCommitted: this.#userCommitted, ...(this.#providerCommittedItemId ? { providerCommittedItemId: this.#providerCommittedItemId } : {}), ...(this.#itemId ? { itemId: this.#itemId } : {}), partial: this.#partial, ...(this.#final === undefined ? {} : { final: this.#final }), ...(this.#errorCode ? { errorCode: this.#errorCode } : {}) }); }

  #acceptItem(itemId: string): boolean { if (this.#itemId && this.#itemId !== itemId) { this.#fail("provider_item_mismatch"); return false; } this.#itemId ??= itemId; return true; }
  #acceptPendingFinal() { if (!this.#pendingFinal || !this.#userCommitted || this.#providerCommittedItemId !== this.#pendingFinal.itemId) return; this.#final = this.#pendingFinal.transcript; this.#state = "completed"; this.#finish(); }
  #requireCapturing() { if (this.#state !== "capturing") throw new Error("Transcription session is not accepting audio"); }
  #fail(code: string): LiveTranscriptionSnapshot { if (!TERMINAL.has(this.#state)) { this.#state = "failed"; this.#errorCode = code; this.#finish(); } return this.#emit(); }
  #timeout(code: string) { if (!TERMINAL.has(this.#state)) { this.#state = "timed_out"; this.#errorCode = code; this.#finish(); this.#emit(); } }
  #send(frame: Record<string, unknown>) { try { this.#transport.send(frame); } catch { this.#state = "transport_closed"; this.#errorCode = "transport_send_failed"; this.#finish(); } }
  #clear(which: "handshake" | "capture" | "final") { const timer = which === "handshake" ? this.#handshakeTimer : which === "capture" ? this.#captureTimer : this.#finalTimer; if (timer !== undefined) { this.#timers.clearTimeout(timer); if (which === "handshake") this.#handshakeTimer = undefined; else if (which === "capture") this.#captureTimer = undefined; else this.#finalTimer = undefined; } }
  #finish(closeTransport = true) { this.#clear("handshake"); this.#clear("capture"); this.#clear("final"); this.#pendingFinal = undefined; if (closeTransport && !this.#closed) { this.#closed = true; try { this.#transport.close(); } catch { /* close failures never escape protocol state */ } } }
  #emit(): LiveTranscriptionSnapshot { this.#revision++; const snapshot = this.snapshot(); try { this.#onUpdate?.(snapshot); } catch { /* observers cannot corrupt protocol state */ } return this.snapshot(); }
}

function boundedDuration(value: number | undefined, fallback: number): number { return value === undefined ? fallback : Number.isSafeInteger(value) && value > 0 && value <= 120_000 ? value : (() => { throw new Error("Invalid transcription timeout"); })(); }
function validSessionEcho(value: unknown): boolean { const session = value && typeof value === "object" ? value as Record<string, unknown> : undefined, audio = session?.audio && typeof session.audio === "object" ? session.audio as Record<string, unknown> : undefined, input = audio?.input && typeof audio.input === "object" ? audio.input as Record<string, unknown> : undefined, format = input?.format && typeof input.format === "object" ? input.format as Record<string, unknown> : undefined, transcription = input?.transcription && typeof input.transcription === "object" ? input.transcription as Record<string, unknown> : undefined; return session?.type === "transcription" && format?.type === "audio/pcm" && format.rate === 24_000 && transcription?.model === "gpt-live-transcribe" && input?.turn_detection === null; }
