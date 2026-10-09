import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { deriveMirroringCapability, type MirroringEvidenceTask } from "../../iphone-mirroring/capability-publisher.mjs";
import { deriveMirroringBinding, type MirroringBinding } from "../../iphone-mirroring/binding.mjs";

const MAX_BYTES = 256 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const UNCERTAIN_TERMINAL = new Set(["interrupted", "failed", "cancelled"]);
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);

export type TaskLike = MirroringEvidenceTask & {
  updatedAt: string;
  executionTarget?: { transport: string; leaseId: string };
};
export type ExecutionQuiescence = {
  verification: "independently_verified";
  providerQuiescent: true;
  taskId: string;
  leaseId: string;
};

/** Operator-owned observations only. Markers are not authentication or a writer
 * interface: the host operator must independently inspect the actual evidence.
 * Reads never renew a lease, mutate tasks or claim a phone action succeeded.
 */
export class IPhoneMirroringEvidence {
  private readonly startedAt: number;
  private readonly revokedAt = new Map<string, number>();

  constructor(readonly file: string, private readonly clock: () => number = () => Date.now() / 1000) {
    this.startedAt = this.clock();
  }

  revoke(deviceId: string): void {
    const now = this.clock();
    this.revokedAt.set(deviceId, Number.isFinite(now)
      ? Math.max(now, this.revokedAt.get(deviceId) ?? -Infinity)
      : Infinity);
  }

  /** Routing configuration is not a permission or live-phone proof. The worker
   * must preflight the real selected phone before every native input. */
  bindingForDevice(deviceId: string): MirroringBinding | undefined {
    const document = this.read();
    return document && Object.hasOwn(document, "binding")
      ? deriveMirroringBinding(document.binding, deviceId, this.clock())
      : undefined;
  }

  forDevice(deviceId: string, tasks: Readonly<Record<string, TaskLike>>) {
    const now = this.clock();
    const document = this.read();
    // A v2 binding explicitly controls this device's routing. Never let stale
    // legacy readiness fields bypass an invalid or revoked operator binding.
    if (document && Object.hasOwn(document, "binding")) return undefined;
    if (!document || !Number.isFinite(this.startedAt) || !Number.isFinite(now) ||
        !object(document.selection) || document.selection.deviceId !== deviceId ||
        !object(document.observation) || typeof document.observation.observedAt !== "number" ||
        document.observation.observedAt <= Math.max(this.startedAt, this.revokedAt.get(deviceId) ?? -Infinity)) return undefined;
    return deriveMirroringCapability({ selection: document.selection, acceptanceRecords: document.acceptanceRecords,
      observation: document.observation, tasks, now });
  }

  quiescenceForTask(task: TaskLike): ExecutionQuiescence | undefined {
    if (!UNCERTAIN_TERMINAL.has(task.status) || !SAFE_ID.test(task.id) ||
        task.executionTarget?.transport !== "apple-iphone-mirroring" || !SAFE_ID.test(task.executionTarget.leaseId)) return undefined;
    const updatedAt = typeof task.updatedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(task.updatedAt)
      ? Date.parse(task.updatedAt) / 1000 : NaN;
    const now = this.clock();
    if (!Number.isFinite(updatedAt) || !Number.isFinite(now)) return undefined;
    const document = this.read();
    if (!document || !Array.isArray(document.quiescence)) return undefined;
    const found = document.quiescence.some(record => object(record) && record.taskId === task.id &&
      record.leaseId === task.executionTarget!.leaseId && record.verification === "independently_verified" &&
      record.providerQuiescent === true && typeof record.observedAt === "number" && Number.isFinite(record.observedAt) &&
      record.observedAt >= updatedAt && record.observedAt <= now);
    return found ? { verification: "independently_verified", providerQuiescent: true,
      taskId: task.id, leaseId: task.executionTarget.leaseId } : undefined;
  }

  private read(): JsonObject | undefined {
    let fd: number | undefined;
    try {
      const pathStat = lstatSync(this.file);
      if (!pathStat.isFile() || pathStat.isSymbolicLink()) return undefined;
      fd = openSync(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino || stat.size > MAX_BYTES ||
          (stat.mode & 0o022) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return undefined;
      // Never read an unbounded stream, including a regular file growing after stat.
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = readSync(fd, bytes, length, bytes.length - length, null);
        if (read === 0) break;
        length += read;
      }
      const after = fstatSync(fd);
      if (length > MAX_BYTES || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs || after.mode !== stat.mode || after.uid !== stat.uid) return undefined;
      const document: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      if (!object(document) ||
          (document.quiescence !== undefined && (!Array.isArray(document.quiescence) || document.quiescence.length > 64))) return undefined;
      if (Object.hasOwn(document, "binding")) {
        if (document.schemaVersion !== 2) return undefined;
        return document;
      }
      if (!object(document.selection) || !object(document.observation) ||
          !Array.isArray(document.acceptanceRecords) || document.acceptanceRecords.length > 64) return undefined;
      return document;
    } catch { return undefined; }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* No startup failure from optional evidence. */ } } }
  }
}
