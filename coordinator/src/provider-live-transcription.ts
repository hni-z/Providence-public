import { loadTranscriptionConfig, type VoiceConfiguration } from "./voice-config.js";
import { WebSocket } from "ws";
import { LiveTranscriptionSession, type LiveTranscriptionIdentity, type LiveTranscriptionSnapshot } from "./live-transcription.js";

export const LIVE_TRANSCRIPTION_MODEL = "gpt-live-transcribe";
export const LIVE_TRANSCRIPTION_AUDIO = Object.freeze({ type: "audio/pcm", rate: 24000 });

/** Reuse only the configured OpenAI key file. Never search credentials or fall back to ambient keys. */
export function loadLiveTranscriptionCredentials(config: VoiceConfiguration): { apiKey: string } | undefined {
  if ((config.transcriptionProvider ?? "openai") !== "openai" || !config.transcriptionEnvFile)
    return undefined;
  try {
    const value = loadTranscriptionConfig(config, {});
    return value?.apiKey ? { apiKey: value.apiKey } : undefined;
  } catch { return undefined; }
}

/** Dedicated input transcription only; does not change the existing batch model or speech provider. */
export function liveTranscriptionSessionConfiguration() {
  return {
    type: "transcription" as const,
    audio: { input: {
      format: { ...LIVE_TRANSCRIPTION_AUDIO },
      transcription: { model: LIVE_TRANSCRIPTION_MODEL, delay: "low" as const },
      turn_detection: null,
    } },
  };
}

export type LiveTranscriptionClientEvent = {
  type: "ready" | "partial" | "final" | "error";
  sessionId: string; eventId?: string; itemId?: string; contentIndex?: number;
  delta?: string; text?: string; code?: string; message?: string;
};
export interface LiveTranscriptionConnection {
  append(sequence: number, audio: string): void;
  finish(lastSequence: number): void;
  cancel(): void;
}
export type LiveTranscriptionFactory = (identity: LiveTranscriptionIdentity,
  emit: (event: LiveTranscriptionClientEvent) => void) => LiveTranscriptionConnection;
type ProviderSocket = Pick<WebSocket, "on" | "send" | "close" | "terminate" | "readyState" | "bufferedAmount">;
type ProviderDial = (url: string, options: { headers: Record<string, string>; handshakeTimeout: number; maxPayload: number; followRedirects: false }) => ProviderSocket;

/** Construct only after the integration owner verifies the exact endpoint with a zero-audio handshake. */
export function liveTranscriptionFactory(apiKey: string, verifiedEndpoint: string,
  dial: ProviderDial = (url, options) => new WebSocket(url, options)): LiveTranscriptionFactory {
  if (verifiedEndpoint !== "wss://api.openai.com/v1/realtime?intent=transcription")
    throw new Error("Live transcription transport is not verified.");
  if (!apiKey || apiKey.length < 16 || /\s/.test(apiKey)) throw new Error("Live transcription is unavailable.");
  return (identity, emit) => {
    const socket = dial(verifiedEndpoint, { headers: { Authorization: `Bearer ${apiKey}` },
      handshakeTimeout: 10_000, maxPayload: 128 * 1024, followRedirects: false });
    let ready = false, terminal = false, closed = false, lastPartial = "", currentEvent: Record<string, unknown> | undefined;
    let finalEventId: string | undefined;
    const eventIds = new Set<string>();
    const close = () => {
      if (closed) return;
      closed = true;
      try { if (socket.readyState === WebSocket.CONNECTING) socket.terminate(); else socket.close(); } catch {}
    };
    const identityFields = () => ({ sessionId: identity.streamId,
      ...(typeof currentEvent?.event_id === "string" ? { eventId: currentEvent.event_id } : {}),
    });
    const update = (snapshot: LiveTranscriptionSnapshot) => {
      if (terminal) return;
      if (snapshot.state === "capturing" && !ready) { ready = true; emit({ type: "ready", sessionId: identity.streamId }); }
      if (snapshot.partial !== lastPartial && snapshot.itemId) {
        const delta = snapshot.partial.slice(lastPartial.length);
        lastPartial = snapshot.partial;
        emit({ type: "partial", ...identityFields(), itemId: snapshot.itemId, contentIndex: 0, delta, text: snapshot.partial });
      }
      if (snapshot.state === "completed" && snapshot.final !== undefined && snapshot.itemId) {
        terminal = true;
        emit({ type: "final", sessionId: identity.streamId, ...(finalEventId ? { eventId: finalEventId } : {}), itemId: snapshot.itemId, text: snapshot.final });
      } else if (["failed", "timed_out", "transport_closed"].includes(snapshot.state)) {
        terminal = true;
        emit({ type: "error", sessionId: identity.streamId, code: snapshot.errorCode ?? "provider_unavailable",
          message: "Live transcription could not finish. Nothing was submitted or retried." });
      } else if (snapshot.state === "cancelled") terminal = true;
    };
    const session = new LiveTranscriptionSession(identity, {
      send(frame) {
        if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64 * 1024) throw new Error("Provider unavailable");
        socket.send(JSON.stringify(frame));
      }, close,
    }, { onUpdate: update, captureTimeoutMs: 30_000 });
    socket.on("open", () => { if (!terminal) session.open(); });
    socket.on("message", (data, binary) => {
      if (terminal) return;
      let event: any;
      try { if (binary) throw new Error(); event = JSON.parse(data.toString()); }
      catch { session.ingest(null); return; }
      if (typeof event?.event_id === "string") {
        if (!/^[A-Za-z0-9._:-]{1,200}$/.test(event.event_id) || eventIds.size >= 2048) { session.ingest(null); return; }
        if (eventIds.has(event.event_id)) return;
        eventIds.add(event.event_id);
      }
      if (typeof event?.type === "string" && event.type.startsWith("conversation.item.input_audio_transcription.") && event.content_index !== 0) {
        session.ingest(null); return;
      }
      currentEvent = event;
      if (event?.type === "conversation.item.input_audio_transcription.completed") finalEventId = event.event_id;
      session.ingest(event);
      currentEvent = undefined;
    });
    socket.on("error", () => { session.transportClosed(); close(); });
    socket.on("close", () => session.transportClosed());
    socket.on("unexpected-response", (_request, response) => { response.resume(); session.transportClosed(); close(); });
    return {
      append(sequence, audio) {
        const snapshot = session.append(sequence, audio);
        if (snapshot.state !== "capturing") throw new Error("Live transcription is unavailable.");
      },
      finish(lastSequence) { session.commit(lastSequence); },
      cancel() { session.cancel(); close(); },
    };
  };
}
