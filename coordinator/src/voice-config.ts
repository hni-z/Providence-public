import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";

const providerSchema = z.enum(["openai", "elevenlabs"]);
const modelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const envFileSchema = z.string().min(1).max(4096);

export type ProviderId = z.infer<typeof providerSchema>;
export type ProviderLabel = "OpenAI" | "ElevenLabs";
export function providerLabel(id: ProviderId): ProviderLabel {
  return id === "elevenlabs" ? "ElevenLabs" : "OpenAI";
}

/** Defaults belong to the loaders so existing parsed configuration stays unchanged. */
export const voiceConfigFields = {
  transcriptionProvider: providerSchema.optional(),
  speechProvider: providerSchema.optional(),
  speechEnvFile: envFileSchema.optional(),
  transcriptionEnvFile: envFileSchema.optional(),
  transcriptionModel: modelSchema.optional(),
  speechVoice: z.enum(["marin", "cedar"]).optional(),
  elevenLabsEnvFile: envFileSchema.optional(),
  elevenLabsVoiceId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional(),
  elevenLabsTranscriptionModel: modelSchema.optional(),
  elevenLabsSpeechModel: modelSchema.optional(),
};
const voiceConfigurationSchema = z.object(voiceConfigFields);
export type VoiceConfiguration = z.infer<typeof voiceConfigurationSchema>;
export type PrivateTranscriptionConfig = {
  apiKey: string;
  model: string;
  provider?: ProviderId;
};
export type PrivateSpeechConfig = {
  provider: ProviderId;
  apiKey?: string;
  model: string;
  voice?: string;
};
type VoiceEnvironment = { OPENAI_API_KEY?: string; ELEVENLABS_API_KEY?: string };

function selectedProvider(value: ProviderId | undefined): ProviderId {
  if (value === undefined) return "openai";
  if (value !== "openai" && value !== "elevenlabs")
    throw new Error("Invalid private voice provider configuration.");
  return value;
}

/** Read only the selected provider's explicit local file, or its named environment key.
 * An explicit file never falls back to process credentials. No shell evaluation or search.
 */
function loadKey(config: VoiceConfiguration, provider: ProviderId, environment: VoiceEnvironment,
  file = provider === "elevenlabs" ? config.elevenLabsEnvFile : config.transcriptionEnvFile,
): string | undefined {
  const keyName = provider === "elevenlabs" ? "ELEVENLABS_API_KEY" : "OPENAI_API_KEY";
  let key: string | undefined;
  if (file !== undefined) {
    if (!isAbsolute(file) || file.startsWith("\\\\") || file.startsWith("//"))
      throw new Error("The transcription environment file must be an explicitly configured absolute local path.");
    let fd: number | undefined;
    try {
      // lstat also protects platforms whose O_NOFOLLOW flag is unavailable.
      const before = lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size > 64 * 1024)
        throw new Error("Invalid local transcription environment file");
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 64 * 1024 || stat.dev !== before.dev || stat.ino !== before.ino)
        throw new Error("Invalid local transcription environment file");
      const bytes = readFileSync(fd);
      if (bytes.length > 64 * 1024) throw new Error("Invalid local transcription environment file");
      key = parseEnv(bytes.toString("utf8"))[keyName];
    } catch {
      throw new Error("Unable to read the private transcription environment file. Check its local path, format and permissions.");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  } else {
    key = environment[keyName];
  }
  const apiKey = key?.trim();
  return apiKey && apiKey.length >= 16 && !/\s/.test(apiKey) ? apiKey : undefined;
}

/** Private return value: never serialize it to clients, device metadata or event logs. */
export function loadTranscriptionConfig(
  config: VoiceConfiguration,
  environment: VoiceEnvironment = process.env,
): PrivateTranscriptionConfig | undefined {
  const provider = selectedProvider(config.transcriptionProvider);
  const apiKey = loadKey(config, provider, environment);
  if (!apiKey) return undefined;
  const model = provider === "elevenlabs"
    ? config.elevenLabsTranscriptionModel ?? "scribe_v2"
    : config.transcriptionModel ?? "gpt-transcribe";
  // Preserve the legacy implicit-OpenAI return shape as well as parsed config shape.
  return { apiKey, model, ...(config.transcriptionProvider === undefined ? {} : { provider }) };
}

/** Private return value. A chosen ElevenLabs voice is required separately from its key. */
export function loadSpeechConfig(
  config: VoiceConfiguration,
  environment: VoiceEnvironment = process.env,
): PrivateSpeechConfig {
  const provider = selectedProvider(config.speechProvider);
  // PR #11's explicit output file takes precedence only for speech. Input keeps
  // its existing provider-specific file, even when the output file is invalid.
  const apiKey = loadKey(config, provider, environment, config.speechEnvFile);
  const model = provider === "elevenlabs" ? config.elevenLabsSpeechModel ?? "eleven_flash_v2_5" : "gpt-4o-mini-tts";
  const voice = provider === "elevenlabs" ? config.elevenLabsVoiceId : config.speechVoice ?? "marin";
  return { provider, model, ...(apiKey ? { apiKey } : {}), ...(voice ? { voice } : {}) };
}
