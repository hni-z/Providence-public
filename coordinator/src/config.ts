import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { voiceConfigFields } from "./voice-config.js";
export const configSchema = z.object({
  clientToken: z.string().min(32),
  localDeviceId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  localDeviceName: z.string(),
  workspace: z.string(),
  localWorkerAccess: z.enum(["workspace", "full-access"]).optional(),
  localWorkerModel: z.string().trim().min(1).max(200).optional(),
  localWorkerReasoningEffort: z.string().trim().min(1).max(80).optional(),
  masterModel: z.string().trim().min(1).max(200).optional(),
  masterReasoningEffort: z.string().trim().min(1).max(80).optional(),
  workerModel: z.string().trim().min(1).max(200).optional(),
  workerReasoningEffort: z.string().trim().min(1).max(80).optional(),
  ...voiceConfigFields,
  devices: z
    .array(
      z.object({
        id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
        name: z.string(),
        token: z.string().min(32),
      }),
    )
    .default([]),
}).superRefine((value, context) => {
  for (const [local, alias] of [["localWorkerModel", "workerModel"], ["localWorkerReasoningEffort", "workerReasoningEffort"]] as const)
    if (value[local] && value[alias] && value[local] !== value[alias])
      context.addIssue({ code: z.ZodIssueCode.custom, path: [alias], message: `${local} conflicts with ${alias}.` });
});

export function localWorkerProfile(config: Pick<z.infer<typeof configSchema>,
  "localWorkerModel" | "localWorkerReasoningEffort" | "workerModel" | "workerReasoningEffort">) {
  return {
    model: config.localWorkerModel ?? config.workerModel,
    reasoningEffort: config.localWorkerReasoningEffort ?? config.workerReasoningEffort,
  };
}
export const dataDir = resolve(
  process.env.PROVIDENCE_DATA_DIR ?? ".providence",
);
// The parse drops any key this build does not know, yet the file belongs to the
// operator, so writers merge their changes over what was read.
const asRead = new WeakMap<object, Record<string, unknown>>();
export function loadConfig(file = resolve(dataDir, "config.json")) {
  if (!existsSync(file)) throw new Error("Run npm run setup first.");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const c = configSchema.parse(raw);
  asRead.set(c, raw);
  mkdirSync(c.workspace, { recursive: true });
  return c;
}
export function saveConfig(file: string, config: z.infer<typeof configSchema>) {
  const content = { ...asRead.get(config), ...config };
  // Per-process temporary name: a shared one lets a second writer delete the file this rename needs.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(content, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}
export function tokenMatches(provided: unknown, expected: string) {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
