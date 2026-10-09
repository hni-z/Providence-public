import type { LiveVoiceAdapter, LiveVoiceSession } from "./live-voice-session.js";
import { LIVE_VOICE_IN_FLIGHT_CHUNKS } from "./live-voice-session.js";
import { sessionCredentials } from "./api.js";
export type LiveTranscriptionCapability = {
  available: boolean; transport: "websocket"; ticketPath: "/v1/transcriptions/live-sessions";
  websocketPath: "/v1/transcriptions/live"; model: "gpt-live-transcribe";
  sampleRate: 24000; channels: 1; encoding: "pcm16le";
  maxDurationMs: 25000; maxAudioBytes: 1200000; maxChunkBytes: 4800;
};
export function parseLiveTranscriptionCapability(input: unknown): LiveTranscriptionCapability | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const value = input as Record<string, unknown>;
  const fixed = { transport: "websocket", ticketPath: "/v1/transcriptions/live-sessions", websocketPath: "/v1/transcriptions/live",
    model: "gpt-live-transcribe", sampleRate: 24000, channels: 1, encoding: "pcm16le", maxDurationMs: 25000, maxAudioBytes: 1200000, maxChunkBytes: 4800 };
  if (typeof value.available !== "boolean" || Object.entries(fixed).some(([key, expected]) => value[key] !== expected)) return;
  return { available: value.available, ...fixed } as LiveTranscriptionCapability;
}
type Socket = Pick<WebSocket, "readyState" | "bufferedAmount" | "send" | "close" | "addEventListener" | "removeEventListener">;
const safeId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 500;
const abortError = () => new DOMException("Live voice cancelled", "AbortError");
const failure = () => new Error("Live transcription stopped. Nothing was submitted or automatically retried.");

/** Same-origin authenticated ticket, then one socket and one final commit. No fallback/retry. */
export function createLiveVoiceAdapter(token: string, capability: LiveTranscriptionCapability, environment: {
  origin?: string; fetcher?: typeof fetch; connect?: (url: string, protocols: string[]) => Socket; requestId?: () => string;
} = {}): LiveVoiceAdapter {
  return async ({ signal, onPartial }) => {
    signal.throwIfAborted();
    if (!capability.available || !parseLiveTranscriptionCapability(capability)) throw failure();
    const origin = new URL(environment.origin ?? location.origin);
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw failure();
    const requestId = (environment.requestId ?? (() => crypto.randomUUID()))();
    const ticketAbort = new AbortController();
    const abortTicket = () => ticketAbort.abort(); signal.addEventListener("abort", abortTicket, { once: true });
    const ticketTimeout = setTimeout(abortTicket, 10_000);
    let ticket: any;
    try {
      const response = await (environment.fetcher ?? fetch)(new URL(capability.ticketPath, origin), {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }), credentials: sessionCredentials(token), cache: "no-store", mode: "same-origin", referrerPolicy: "same-origin", redirect: "error", signal: ticketAbort.signal,
      });
      if (!response.ok) throw failure();
      ticket = await response.json(); signal.throwIfAborted();
      if (ticketAbort.signal.aborted) throw failure();
      if (!safeId(ticket?.sessionId) || ticket.requestId !== requestId ||
          typeof ticket.ticket !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(ticket.ticket) ||
          !Number.isFinite(Date.parse(ticket.expiresAt)) || ticket.websocketPath !== capability.websocketPath) throw failure();
    } catch { if (signal.aborted) throw abortError(); throw failure(); }
    finally { clearTimeout(ticketTimeout); signal.removeEventListener("abort", abortTicket); }
    signal.throwIfAborted();
    const address = new URL(capability.websocketPath, origin); address.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
    const socket = (environment.connect ?? ((url, protocols) => new WebSocket(url, protocols)))(address.href, ["providence-live-v1", `ticket.${ticket.ticket}`]);
    const sessionId: string = ticket.sessionId;
    ticket = undefined;
    let closed = false, ready = false, finishing = false, lastSent = -1, lastAck = -1, bytes = 0;
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    const readiness = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    let finalResolve: ((text: string) => void) | undefined, finalReject: ((error: Error) => void) | undefined, final: Promise<string> | undefined;
    const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
    const seen = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer); signal.removeEventListener("abort", cancel);
      socket.removeEventListener("message", message); socket.removeEventListener("close", disconnected); socket.removeEventListener("error", disconnected);
    };
    const fail = (error: Error) => {
      if (closed) return; closed = true; cleanup(); readyReject(error);
      for (const write of pending.values()) write.reject(error); pending.clear(); finalReject?.(error);
      socket.close(1000, "Live voice stopped");
    };
    const cancel = () => {
      if (closed) return;
      if (socket.readyState === 1) { try { socket.send(JSON.stringify({ type: "cancel" })); } catch {} }
      fail(abortError());
    };
    const deadline = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => fail(failure()), ms); };
    const disconnected = () => fail(failure());
    const message = (event: Event) => {
      if (closed || signal.aborted) return;
      let value: any;
      try {
        const data = (event as MessageEvent).data;
        if (typeof data !== "string" || data.length > 20_000) throw failure();
        value = JSON.parse(data);
        if (!value || typeof value !== "object" || value.sessionId !== sessionId) throw failure();
        if (value.type === "ready") {
          if (ready || finishing) throw failure(); ready = true; clearTimeout(timer); readyResolve(); return;
        }
        if (!ready) throw failure();
        if (value.type === "ack") {
          if (!Number.isSafeInteger(value.seq) || value.seq < 0) throw failure();
          if (value.seq <= lastAck) return;
          const done = pending.get(value.seq);
          if (!done || value.seq !== lastAck + 1) throw failure();
          clearTimeout(timer); lastAck = value.seq; pending.delete(value.seq);
          if (pending.size) deadline(10_000);
          done.resolve(); return;
        }
        if (value.type === "partial" || value.type === "final") {
          if ((value.eventId !== undefined && !safeId(value.eventId)) || !safeId(value.itemId) || typeof value.text !== "string" || value.text.length > 8000) throw failure();
          if (value.eventId !== undefined) {
            if (seen.has(value.eventId)) return;
            if (seen.size >= 1000) throw failure(); seen.add(value.eventId);
          }
          if (value.type === "partial") {
            if (value.contentIndex !== 0 || typeof value.delta !== "string" || value.delta.length > 8000) throw failure();
            onPartial(value.text); return;
          }
          if (!finishing || pending.size || lastAck !== lastSent || !value.text.trim()) throw failure();
          closed = true; cleanup(); finalResolve!(value.text); socket.close(1000, "Live transcript complete"); return;
        }
        throw failure(); // Includes provider error: no untrusted diagnostic echo.
      } catch { fail(failure()); }
    };
    socket.addEventListener("message", message); socket.addEventListener("close", disconnected); socket.addEventListener("error", disconnected);
    signal.addEventListener("abort", cancel, { once: true }); deadline(15_000);
    if (signal.aborted) cancel();
    await readiness;
    const session: LiveVoiceSession = {
      write(pcm, sequence) {
        if (closed || signal.aborted || finishing || pending.size >= LIVE_VOICE_IN_FLIGHT_CHUNKS || sequence !== lastSent + 1 ||
            !pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > capability.maxChunkBytes ||
            bytes + pcm.byteLength > capability.maxAudioBytes || socket.readyState !== 1 || socket.bufferedAmount > 64 * 1024)
          return Promise.reject(failure());
        let binary = ""; for (const byte of new Uint8Array(pcm)) binary += String.fromCharCode(byte);
        const written = new Promise<void>((resolve, reject) => { pending.set(sequence, { resolve, reject }); });
        lastSent = sequence; bytes += pcm.byteLength; deadline(10_000);
        try { socket.send(JSON.stringify({ type: "audio", seq: sequence, audio: btoa(binary) })); }
        catch { fail(failure()); }
        return written;
      },
      finish(lastSequence) {
        if (final) return final;
        if (closed || signal.aborted || pending.size || !bytes || lastSequence !== lastSent || lastAck !== lastSent) return Promise.reject(failure());
        finishing = true; final = new Promise<string>((resolve, reject) => { finalResolve = resolve; finalReject = reject; });
        deadline(20_000);
        try { socket.send(JSON.stringify({ type: "finish", lastSeq: lastSequence })); }
        catch { fail(failure()); }
        return final;
      }, cancel,
    };
    return session;
  };
}
