import {
  validateAudio, MAX_TRANSCRIPT_CHARS, TRANSCRIPTION_TIMEOUT_MS,
  TranscriptionError, type AudioMimeType, type TranscriptionResult,
} from "./transcription.js";
import { SpeechError } from "./speech-error.js";

const TRANSCRIPTION_ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";
const MAX_JSON_BYTES = 64 * 1024;
const MAX_SPEECH_CHARS = 4000;
const modelId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const voiceIdentifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const extensions: Record<AudioMimeType, string> = {
  "audio/webm": "webm", "audio/mp4": "mp4", "audio/ogg": "ogg", "audio/wav": "wav",
};

function validKey(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{16,512}$/.test(value.trim());
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

async function readTranscript(response: Response, signal: AbortSignal): Promise<TranscriptionResult> {
  if (!response.body) throw new TranscriptionError("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) {
        void reader.cancel().catch(() => {});
        throw new TranscriptionError("provider_timeout");
      }
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        void reader.cancel().catch(() => {});
        throw new TranscriptionError("invalid_response");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new TranscriptionError("invalid_response"); }
  if (!value || typeof value !== "object" || typeof (value as { text?: unknown }).text !== "string")
    throw new TranscriptionError("invalid_response");
  const text = (value as { text: string }).text.trim();
  if (text.length > MAX_TRANSCRIPT_CHARS) throw new TranscriptionError("transcript_too_long");
  if (!text) throw new TranscriptionError("no_speech");
  return { text };
}

/** Device-local upload only; caller owns durable request identity. One attempt, no fallback.
 * https://elevenlabs.io/docs/api-reference/speech-to-text/convert
 */
export async function transcribeElevenLabsAudio(
  input: unknown,
  apiKey: string,
  model = "scribe_v2",
  fetcher: typeof fetch = fetch,
): Promise<TranscriptionResult> {
  const { audio, bytes } = validateAudio(input);
  if (!validKey(apiKey) || typeof model !== "string" || !modelId.test(model))
    throw new TranscriptionError("provider_not_configured");
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(bytes)], { type: audio.mimeType }), `recording.${extensions[audio.mimeType]}`);
  form.set("model_id", model);
  form.set("tag_audio_events", "false");
  form.set("diarize", "false");
  form.set("timestamps_granularity", "none");
  form.set("webhook", "false");
  form.set("use_multi_channel", "false");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);
  try {
    const response = await fetcher(TRANSCRIPTION_ENDPOINT, {
      method: "POST", headers: { "xi-api-key": apiKey.trim() },
      body: form, signal: controller.signal, redirect: "error",
    });
    if (controller.signal.aborted) {
      cancelBody(response);
      throw new TranscriptionError("provider_timeout");
    }
    if (!response.ok) {
      cancelBody(response);
      if (response.status === 401 || response.status === 403) throw new TranscriptionError("provider_authentication");
      if (response.status === 429) throw new TranscriptionError("provider_rate_limited");
      if (response.status >= 500) throw new TranscriptionError("provider_unavailable");
      throw new TranscriptionError("provider_rejected");
    }
    const result = await readTranscript(response, controller.signal);
    if (controller.signal.aborted) throw new TranscriptionError("provider_timeout");
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new TranscriptionError("provider_timeout");
    if (error instanceof TranscriptionError) throw error;
    throw new TranscriptionError("provider_network");
  } finally { clearTimeout(timeout); }
}

function stopped(): never { throw new DOMException("Voice request stopped.", "AbortError"); }

/** Transport only. Speech owns identity, concurrency, timeout, HTTP errors and audio bounds.
 * No default voice: the configured account's available voice must be selected separately.
 * https://elevenlabs.io/docs/api-reference/text-to-speech/stream
 */
export async function requestElevenLabsSpeech(
  text: string,
  apiKey: string,
  voiceId: string,
  model: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (typeof text !== "string" || !text.trim() || text.length > MAX_SPEECH_CHARS)
    throw new SpeechError(400, "Provide 1–4000 characters of speech text.");
  if (!validKey(apiKey) || typeof voiceId !== "string" || !voiceIdentifier.test(voiceId)
    || typeof model !== "string" || !modelId.test(model))
    throw new SpeechError(503, "ElevenLabs voice is not configured with a valid private key, voice ID and model.");
  if (signal.aborted) stopped();
  try {
    const response = await fetcher(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`,
      {
        method: "POST", headers: { "xi-api-key": apiKey.trim(), "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: model }), signal, redirect: "error",
      },
    );
    if (signal.aborted) { cancelBody(response); stopped(); }
    return response;
  } catch {
    if (signal.aborted) stopped();
    // Preserve outer Speech's 499/504 handling without exposing transport diagnostics.
    throw new Error("The ElevenLabs speech connection failed. No automatic retry was made.");
  }
}
