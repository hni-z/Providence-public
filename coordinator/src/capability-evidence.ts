import { lstatSync, readFileSync } from "node:fs";
import { z } from "zod";

/** Explicit operator verification, not automatic inference from a model's text or
 * a completed turn. This module only reads records; it never grants permissions.
 */
const capability = z.enum(["browser", "desktop"]);
const recordSchema = z.object({
  deviceId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  taskId: z.string().min(1).max(200),
  capability,
  observedAt: z.string().datetime({ offset: true }),
  scope: z.string().trim().min(1).max(600).refine(value => Buffer.byteLength(value, "utf8") <= 1200),
  requiresApproval: z.literal(true),
  verification: z.literal("independently_verified"),
}).strict();
const documentSchema = z.object({ schemaVersion: z.literal(1), records: z.array(recordSchema).max(100) }).strict();
export type CapabilityEvidenceRecord = z.infer<typeof recordSchema>;
export type CapabilityEvidenceDocument = z.infer<typeof documentSchema>;
export type CapabilityEvidenceTask = {
  id: string;
  deviceId: string;
  status: string;
  createdAt: string;
};
export type ScopedCapabilityEvidence = {
  status: "not_verified" | "verified_scoped";
  requiresApproval: true;
  grantsPermission: false;
  taskId?: string;
  observedAt?: string;
  scope?: string;
};
export type DeviceCapabilityEvidence = { browser: ScopedCapabilityEvidence; desktop: ScopedCapabilityEvidence };

function unverified(): DeviceCapabilityEvidence {
  return {
    browser: { status: "not_verified", requiresApproval: true, grantsPermission: false },
    desktop: { status: "not_verified", requiresApproval: true, grantsPermission: false },
  };
}
function derive(
  records: readonly CapabilityEvidenceRecord[],
  tasks: Readonly<Record<string, CapabilityEvidenceTask>>,
  deviceId: string,
  now: number,
): DeviceCapabilityEvidence {
  const evidence = unverified();
  if (!Number.isFinite(now)) return evidence;
  for (const record of records) {
    if (record.deviceId !== deviceId) continue;
    const task = tasks[record.taskId];
    if (!task || task.id !== record.taskId || task.deviceId !== deviceId || task.status !== "completed") continue;
    const observedAt = Date.parse(record.observedAt);
    const createdAt = Date.parse(task.createdAt);
    if (!Number.isFinite(observedAt) || !Number.isFinite(createdAt) || observedAt < createdAt || observedAt > now) continue;
    const previous = evidence[record.capability];
    if (previous.observedAt && Date.parse(previous.observedAt) >= observedAt) continue;
    evidence[record.capability] = {
      status: "verified_scoped", requiresApproval: true, grantsPermission: false,
      taskId: record.taskId, observedAt: record.observedAt, scope: record.scope,
    };
  }
  return evidence;
}

/** Pure validation and derivation for tests or a private pre-deployment record. */
export function deriveCapabilityEvidence(
  document: unknown,
  tasks: Readonly<Record<string, CapabilityEvidenceTask>>,
  deviceId: string,
  now = Date.now(),
): DeviceCapabilityEvidence {
  const parsed = documentSchema.safeParse(document);
  return parsed.success ? derive(parsed.data.records, tasks, deviceId, now) : unverified();
}

/** Startup-cached private file reader. Missing, malformed, oversized or unreadable
 * evidence fails closed without preventing the coordinator from starting.
 * Seed/update explicitly before deployment; there is deliberately no API writer.
 */
export class CapabilityEvidence {
  readonly sourceStatus: "loaded" | "missing" | "invalid";
  private readonly records: readonly CapabilityEvidenceRecord[];
  constructor(file: string) {
    let records: CapabilityEvidenceRecord[] = [];
    let status: CapabilityEvidence["sourceStatus"] = "invalid";
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 128 * 1024) throw new Error("Invalid evidence file");
      const parsed = documentSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) { records = parsed.data.records; status = "loaded"; }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") status = "missing";
    }
    this.records = records;
    this.sourceStatus = status;
  }
  forDevice(deviceId: string, tasks: Readonly<Record<string, CapabilityEvidenceTask>>, now = Date.now()): DeviceCapabilityEvidence {
    return derive(this.records, tasks, deviceId, now);
  }
}
