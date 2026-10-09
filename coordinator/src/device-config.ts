import {
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, parse } from "node:path";
import { z } from "zod";
import { voiceConfigFields, loadTranscriptionConfig, type ProviderLabel } from "./voice-config.js";
export type { PrivateTranscriptionConfig } from "./voice-config.js";

export const deviceConfigSchema = z.object({
  deviceId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  token: z.string().min(32),
  url: z.string().url(),
  workspace: z.string().min(1),
  browserControl: z.literal("chrome").optional(),
  workerAccess: z.enum(["workspace", "full-access"]).optional(),
  keepAwake: z.boolean().optional(),
  transcriptionEnvFile: voiceConfigFields.transcriptionEnvFile,
  transcriptionModel: voiceConfigFields.transcriptionModel,
  transcriptionProvider: voiceConfigFields.transcriptionProvider,
  elevenLabsEnvFile: voiceConfigFields.elevenLabsEnvFile,
  elevenLabsTranscriptionModel: voiceConfigFields.elevenLabsTranscriptionModel,
  workerModel: z.string().trim().min(1).max(200).optional(),
  workerReasoningEffort: z.string().trim().min(1).max(80).optional(),
});

/** The configured worker mode is authoritative; omitted values default safely to
 * workspace access. Full access remains an explicit trusted-controller choice. */
export function workerAccessForProvidence(
  configured?: "workspace" | "full-access",
): "workspace" | "full-access" {
  return configured ?? "workspace";
}

export function parseDeviceConfig(
  text: string,
): z.infer<typeof deviceConfigSchema> {
  try {
    return deviceConfigSchema.parse(JSON.parse(text.replace(/^\uFEFF/, "")));
  } catch {
    // JSON syntax errors can include excerpts from the input, which contains a token.
    throw new Error(
      "Invalid device configuration. Check deviceId, token, url, workspace and optional workerAccess (workspace or full-access), transcription or worker profile settings in its private JSON file.",
    );
  }
}

/** Reads only the explicitly selected private provider configuration. */
export const loadDeviceTranscription = loadTranscriptionConfig;

export function workerUrl(value: string, allowPlaintext = false): URL {
  const url = new URL(value);
  if (!["ws:", "wss:"].includes(url.protocol))
    throw new Error(
      "The companion URL must use wss:// (or ws:// on loopback).",
    );
  if (url.username || url.password || url.hash || url.search)
    throw new Error(
      "The companion URL must not include credentials, a query, or a fragment.",
    );
  if (url.pathname !== "/worker")
    throw new Error("The companion URL must end in /worker.");
  if (
    url.protocol !== "wss:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    !allowPlaintext
  )
    throw new Error(
      "Use wss:// for remote connections. Plaintext requires explicit PROVIDENCE_ALLOW_PLAINTEXT=1 on a trusted private network.",
    );
  return url;
}

export function prepareWorkspace(workspace: string): string {
  if (!isAbsolute(workspace) || workspace === "CHANGE_TO_LOCAL_WORKSPACE")
    throw new Error(
      "Set workspace to an absolute local folder this device may work in.",
    );
  if (parse(workspace).root === workspace)
    throw new Error(
      "Choose a dedicated workspace folder, not a filesystem root.",
    );
  mkdirSync(workspace, { recursive: true });
  const root = realpathSync(workspace);
  if (!statSync(root).isDirectory())
    throw new Error("The workspace must be a folder.");
  if (parse(root).root === root)
    throw new Error("The workspace must not resolve to a filesystem root.");
  return root;
}

export const capabilitySchema = z.object({
  files: z.boolean(),
  shell: z.boolean(),
  browser: z.boolean(),
  desktop: z.boolean(),
  phoneMirroring: z.boolean(),
  transcription: z.boolean().default(false),
});
export type DeviceCapabilities = z.infer<typeof capabilitySchema>;
export const runtimeCapabilities: DeviceCapabilities = {
  files: true,
  shell: true,
  browser: false,
  desktop: false,
  phoneMirroring: false,
  transcription: false,
};
export const unavailableCapabilities: DeviceCapabilities = {
  files: false,
  shell: false,
  browser: false,
  desktop: false,
  phoneMirroring: false,
  transcription: false,
};
export const keepAwakeStateSchema = z.object({
  enabled: z.boolean(), active: z.boolean(),
  method: z.enum(["caffeinate-idle", "windows-execution-state", "logind-idle"]).optional(),
  reason: z.enum(["idle_sleep_inhibited", "unsupported_platform", "invalid_parent", "helper_unavailable", "assertion_unavailable", "startup_unconfirmed", "helper_exited", "stopped", "stop_unconfirmed", "disabled", "disconnected", "waiting_for_activity"]).optional(),
}).strict();
export type KeepAwakeState = z.infer<typeof keepAwakeStateSchema>;
export const deviceMetadataSchema = z.object({
  protocolVersion: z.literal(1),
  platform: z.enum([
    "darwin",
    "win32",
    "linux",
    "aix",
    "freebsd",
    "openbsd",
    "sunos",
    "android",
    "cygwin",
    "netbsd",
    "haiku",
  ]),
  hostname: z.string().min(1).max(255),
  workspace: z.string().min(1).max(4096),
  capabilities: capabilitySchema,
  keepAwake: keepAwakeStateSchema.optional(),
  workerAccess: z.enum(["workspace", "full-access"]).optional(),
  transcriptionProvider: z.enum(["OpenAI", "ElevenLabs"]).optional(),
});
export type DeviceMetadata = z.infer<typeof deviceMetadataSchema>;
export function runtimeMetadata(
  workspace: string,
  hasTranscription = false,
  transcriptionProvider?: ProviderLabel,
  workerAccess?: "workspace" | "full-access",
  browserControl?: "chrome",
  keepAwake?: KeepAwakeState,
): DeviceMetadata {
  return {
    protocolVersion: 1,
    platform: process.platform,
    hostname: hostname(),
    workspace,
    ...(workerAccess ? { workerAccess } : {}),
    ...(keepAwake ? { keepAwake } : {}),
    ...(hasTranscription && transcriptionProvider ? { transcriptionProvider } : {}),
    capabilities: {
      ...runtimeCapabilities,
      browser: browserControl === "chrome",
      transcription: hasTranscription === true,
    },
  };
}
