import { ApiError, apiPath, sessionCredentials } from "./api.js";
import { TranscriptionUploadRefused } from "./browser-voice.js";

import { parseVoiceConfig } from "./voice-config.js";
import type { VoiceConfig } from "./voice-config.js";
import { parseTranscriptionAvailability } from "./destination.js";
import { readSpeechAudio, ServerSpeechPlayer } from "./server-audio.js";
import type { SpeechPlaybackEnvironment } from "./server-audio.js";
export type {
  VoiceConfig,
  VoiceProvider,
  VoiceConfigState,
} from "./voice-config.js";
export {
  voiceProviderLabel,
  voiceConfigurationIdentity,
  noVoiceConfig,
  voiceConfigAfterLookup,
  voiceConfigAfterFailedLookup,
} from "./voice-config.js";
async function voiceRequest(
  token: string,
  path: string,
  body: unknown,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const response = await fetch(apiPath(path), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: sessionCredentials(token),
    cache: "no-store",
    mode: "same-origin",
    // no-referrer + same-origin POST serializes Origin as null in WebKit.
    // Keep requests same-origin while retaining their real origin identity.
    referrerPolicy: "same-origin",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (data?.errorCode === "ai_consent_required")
      throw new ApiError("Allow OpenAI processing in Account before using voice.", response.status, "ai_consent_required");
    // An error while polling may follow an accepted/provider-billed upload. Only
    // explicit pre-admission errors on the initial POST permit a manual re-upload.
    if (path === "/transcriptions" && body !== undefined && (
      (response.status === 409 && ["transcription_busy", "history_full"].includes(data.errorCode)) ||
      (response.status === 503 && data.errorCode === "provider_not_configured")
    )) throw new TranscriptionUploadRefused(data.error ?? "Transcription is unavailable.");
    throw new ApiError(data.error ?? "Voice is unavailable.", response.status);
  }
  return response;
}
export async function loadVoiceConfig(
  token: string,
  signal: AbortSignal,
): Promise<VoiceConfig> {
  const value = await (
    await voiceRequest(token, "/voice", undefined, signal)
  ).json();
  signal.throwIfAborted();
  return parseVoiceConfig(value);
}
export async function loadTranscriptionAvailability(token: string, signal: AbortSignal) {
  const value = await (await voiceRequest(token, "/transcriptions", undefined, signal)).json();
  signal.throwIfAborted();
  return parseTranscriptionAvailability(value);
}
export async function transcribeVoice(
  token: string,
  deviceId: string,
  blob: Blob,
  signal: AbortSignal,
): Promise<string> {
  if (!blob.size || blob.size > 512 * 1024)
    throw new Error("Record a shorter message (up to 512 KiB).");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  signal.throwIfAborted();
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  let job = await (
    await voiceRequest(
      token,
      "/transcriptions",
      {
        requestId: crypto.randomUUID(),
        deviceId,
        mimeType: blob.type.split(";")[0],
        base64: btoa(binary),
      },
      signal,
    )
  ).json();
  signal.throwIfAborted();
  const deadline = Date.now() + 70_000;
  while (job.status === "pending") {
    if (Date.now() > deadline)
      throw new Error(
        "Transcription is still pending. It was not submitted again.",
      );
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Voice stopped", "AbortError"));
        return;
      }
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException("Voice stopped", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, 700);
      signal.addEventListener("abort", abort, { once: true });
    });
    job = await (
      await voiceRequest(
        token,
        `/transcriptions/${encodeURIComponent(job.id)}`,
        undefined,
        signal,
      )
    ).json();
    signal.throwIfAborted();
  }
  if (job.status !== "completed" || !job.text)
    throw new Error(job.error ?? "No speech was recognized.");
  signal.throwIfAborted();
  return job.text;
}
export function createVoiceSpeechPlayer(
  token: string,
  environment?: SpeechPlaybackEnvironment,
) {
  return new ServerSpeechPlayer(async (text, requestId, signal) => {
    const response = await voiceRequest(
      token,
      "/speech",
      { requestId, text },
      signal,
    );
    return readSpeechAudio(response, signal);
  }, environment);
}
export async function speakVoice(
  token: string,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const player = createVoiceSpeechPlayer(token);
  try {
    await player.play("explicit-reply", text, signal);
  } finally {
    player.clear();
  }
}
