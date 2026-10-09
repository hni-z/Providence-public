import { parseLiveTranscriptionCapability } from "./live-voice-client.js";
import type { LiveTranscriptionCapability } from "./live-voice-client.js";
import { parseVoiceQueueCapability } from "./live-voice-ledger.js";
import type { VoiceQueueCapability } from "./live-voice-ledger.js";
export type VoiceProvider = "OpenAI" | "ElevenLabs";
export type VoiceConfig = {
  configured: boolean;
  provider: VoiceProvider;
  deviceId: string;
  voice: string | null;
  speechConfigured: boolean;
  transcriptionConfigured: boolean;
  transcriptionProvider: VoiceProvider;
  maxSpeechChars: number;
  maxAudioBytes: number;
  maxSpeechAudioBytes?: number;
  reason?: "provider_not_configured" | "voice_id_required";
  liveTranscription?: LiveTranscriptionCapability;
  admissionQueue?: VoiceQueueCapability;
};
export function isVoiceProvider(value: unknown): value is VoiceProvider {
  return value === "OpenAI" || value === "ElevenLabs";
}
export function parseVoiceConfig(value: unknown): VoiceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Voice configuration is unavailable.");
  const config = value as Record<string, unknown>;
  if (
    typeof config.configured !== "boolean" ||
    !isVoiceProvider(config.provider) ||
    typeof config.deviceId !== "string" ||
    !config.deviceId ||
    !(config.voice === null || typeof config.voice === "string") ||
    !Number.isSafeInteger(config.maxSpeechChars) ||
    Number(config.maxSpeechChars) < 1 ||
    Number(config.maxSpeechChars) > 4000 ||
    !Number.isSafeInteger(config.maxAudioBytes) ||
    Number(config.maxAudioBytes) < 1 ||
    Number(config.maxAudioBytes) > 524288 ||
    (config.maxSpeechAudioBytes !== undefined &&
      (!Number.isSafeInteger(config.maxSpeechAudioBytes) ||
        Number(config.maxSpeechAudioBytes) < 1 ||
        Number(config.maxSpeechAudioBytes) > 4194304))
  )
    throw new Error("Voice configuration is unavailable.");
  if (
    (config.speechConfigured !== undefined &&
      typeof config.speechConfigured !== "boolean") ||
    (config.transcriptionConfigured !== undefined &&
      typeof config.transcriptionConfigured !== "boolean") ||
    (config.transcriptionProvider !== undefined &&
      !isVoiceProvider(config.transcriptionProvider))
  )
    throw new Error("Voice configuration is unavailable.");
  if (
    config.reason !== undefined &&
    !["provider_not_configured", "voice_id_required"].includes(
      String(config.reason),
    )
  )
    throw new Error("Voice configuration is unavailable.");
  return {
    ...(parseVoiceQueueCapability(config.admissionQueue) ? { admissionQueue: parseVoiceQueueCapability(config.admissionQueue) } : {}),
    ...(parseLiveTranscriptionCapability(config.liveTranscription) ? { liveTranscription: parseLiveTranscriptionCapability(config.liveTranscription) } : {}),
    configured: config.configured,
    provider: config.provider,
    deviceId: config.deviceId,
    voice: config.voice as string | null,
    speechConfigured:
      typeof config.speechConfigured === "boolean"
        ? config.speechConfigured
        : config.configured,
    transcriptionConfigured:
      typeof config.transcriptionConfigured === "boolean"
        ? config.transcriptionConfigured
        : config.provider === "OpenAI" && config.configured,
    transcriptionProvider: isVoiceProvider(config.transcriptionProvider)
      ? config.transcriptionProvider
      : "OpenAI",
    maxSpeechChars: Number(config.maxSpeechChars),
    maxAudioBytes: Number(config.maxAudioBytes),
    ...(config.maxSpeechAudioBytes !== undefined
      ? { maxSpeechAudioBytes: Number(config.maxSpeechAudioBytes) }
      : {}),
    ...(config.reason
      ? { reason: config.reason as VoiceConfig["reason"] }
      : {}),
  };
}
export function voiceProviderLabel(
  config: VoiceConfig | null | undefined,
): string {
  const input = config?.transcriptionConfigured
    ? config.transcriptionProvider
    : "Browser";
  const output = config?.speechConfigured ? config.provider : "Browser";
  return input === output
    ? `${input} voice`
    : `${input} transcription · ${output} replies`;
}

/** Nonsecret identity of the selected input/output configuration, never an account credential. */
export function voiceConfigurationIdentity(
  config: VoiceConfig | null | undefined,
): string {
  return config
    ? JSON.stringify([
        config.provider,
        config.voice,
        config.deviceId,
        config.speechConfigured,
        config.transcriptionConfigured,
        config.transcriptionProvider,
        config.maxAudioBytes,
        config.maxSpeechChars,
        config.maxSpeechAudioBytes ?? 4194304,
        config.liveTranscription ?? null,
        config.admissionQueue ?? null,
      ])
    : "voice-configuration-unavailable";
}

// Losing the configuration restarts the voice session, which cancels a capture
// already in progress, so one flaked lookup must not count as a change.
export const LOOKUPS_BEFORE_VOICE_IS_UNAVAILABLE = 3;
export type VoiceConfigState = {
  config: VoiceConfig | null;
  /** The last lookup failed, so the retained configuration may be out of date. */
  stale: boolean;
  failures: number;
};
export const noVoiceConfig: VoiceConfigState = {
  config: null,
  stale: false,
  failures: 0,
};
export function voiceConfigAfterLookup(
  state: VoiceConfigState,
  config: VoiceConfig,
): VoiceConfigState {
  return {
    config:
      voiceConfigurationIdentity(state.config) ===
      voiceConfigurationIdentity(config)
        ? state.config
        : config,
    stale: false,
    failures: 0,
  };
}
export function voiceConfigAfterFailedLookup(
  state: VoiceConfigState,
  unauthorized: boolean,
): VoiceConfigState {
  const failures = state.failures + 1;
  return {
    config:
      unauthorized || failures >= LOOKUPS_BEFORE_VOICE_IS_UNAVAILABLE
        ? null
        : state.config,
    stale: true,
    failures,
  };
}
