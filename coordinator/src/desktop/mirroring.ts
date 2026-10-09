import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export const PHONE_LABEL = "iPhone — via Mac";
export const reasonSchema = z.enum([
  "adapter_not_configured", "phone_locked_required", "phone_not_found",
  "authentication_required", "permission_required", "app_not_running",
  "mac_offline", "stale_observation", "restart_interrupted", "cancelled",
]);
export type PhoneReason = z.infer<typeof reasonSchema>;
export const PHONE_GUIDANCE: Record<PhoneReason, string> = {
  adapter_not_configured: "Phone control is not connected to Providence yet. A Codex desktop test does not enable product access.",
  phone_locked_required: "Lock the iPhone and leave it near the Mac. Continue from your Mac or another device, then retry this request.",
  phone_not_found: "Place the powered-on iPhone near the Mac with Wi-Fi and Bluetooth on. Unlock it once, then lock it and retry.",
  authentication_required: "Complete the authentication shown by iPhone Mirroring on the Mac, then retry.",
  permission_required: "The Mac desktop adapter needs its own approved observation/input permissions before it can control Mirroring.",
  app_not_running: "Open iPhone Mirroring on the Mac, connect the iPhone, then retry.",
  mac_offline: "Reconnect the Mac companion before retrying this phone request.",
  stale_observation: "The phone state could not be freshly verified. Retry to observe iPhone Mirroring again.",
  restart_interrupted: "The coordinator restarted during this action. Inspect the phone before creating a new request.",
  cancelled: "Cancellation was requested. If execution had begun, inspect the phone for any action already taken.",
};

const observationSchema = z.object({
  id: z.string().min(1).max(200),
  at: z.string().datetime(),
  state: z.enum(["ready", "needs_input", "offline", "unavailable"]),
  reason: reasonSchema.optional(),
  detail: z.string().max(2000),
  source: z.literal("product_adapter"),
});
export type PhoneObservation = z.infer<typeof observationSchema>;

/** A real product adapter must independently observe the app before and after input.
 * This contract does not expose or reuse the development task's CUA credentials/tools. */
export interface MirroringAdapter {
  observe(signal: AbortSignal): Promise<PhoneObservation>;
  openSafariUrl(url: string, signal: AbortSignal): Promise<{
    observedUrl: string;
    observation: PhoneObservation;
    evidence: string;
  }>;
}

const requestSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  url: z.string().trim().min(1).max(2048),
  sourceTaskId: z.string().min(1).max(200).optional(),
});
export type PhoneRequest = z.infer<typeof requestSchema>;
const jobSchema = requestSchema.extend({
  id: z.string(),
  deviceId: z.string(),
  label: z.literal(PHONE_LABEL),
  action: z.literal("safari.open_url"),
  status: z.enum(["queued", "running", "needs_input", "completed", "failed", "cancelled", "interrupted"]),
  reason: reasonSchema.optional(),
  message: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  observation: observationSchema.optional(),
  evidence: z.string().optional(),
});
export type PhoneJob = z.infer<typeof jobSchema>;

function navigationUrl(value: string): string {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Phone navigation requires an HTTP(S) URL without embedded credentials");
  return url.href;
}

/** Share this lock with all future GUI operations for the same physical desktop. */
export class DesktopSerialQueue {
  private pending = new Map<string, Promise<unknown>>();
  run<T>(deviceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(deviceId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    this.pending.set(deviceId, result);
    void result.finally(() => {
      if (this.pending.get(deviceId) === result) this.pending.delete(deviceId);
    }).catch(() => {});
    return result;
  }
}
export const desktopSerialQueue = new DesktopSerialQueue();

/** A single-coordinator durable queue. Construct once per data directory. */
export class MirroringQueue {
  private jobs: PhoneJob[];
  private active = new Map<string, AbortController>();
  constructor(private readonly options: {
    file: string;
    macDeviceId: string;
    adapter?: MirroringAdapter;
    unavailableReason?: "adapter_not_configured" | "permission_required";
    now?: () => number;
    onChange?: (job: PhoneJob) => void;
    serial?: DesktopSerialQueue;
  }) {
    this.jobs = existsSync(options.file)
      ? z.array(jobSchema).max(1000).parse(JSON.parse(readFileSync(options.file, "utf8"))) : [];
    for (const job of this.jobs) {
      if (job.status === "running") {
        job.status = "interrupted";
        job.reason = "restart_interrupted";
        job.message = PHONE_GUIDANCE.restart_interrupted;
        job.updatedAt = this.now();
      }
    }
    this.save();
  }
  private now() { return new Date((this.options.now ?? Date.now)()).toISOString(); }
  private unavailableReason() { return this.options.unavailableReason ?? "adapter_not_configured"; }
  private save() {
    mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.options.file + ".tmp", JSON.stringify(this.jobs, null, 2), { mode: 0o600 });
    renameSync(this.options.file + ".tmp", this.options.file);
  }
  private update(job: PhoneJob, patch: Partial<PhoneJob>) {
    Object.assign(job, patch, { updatedAt: this.now() });
    this.save();
    this.options.onChange?.(structuredClone(job));
    return structuredClone(job);
  }
  list() { return structuredClone(this.jobs); }
  get(id: string) {
    const job = this.jobs.find((item) => item.id === id);
    if (!job) throw new Error("Unknown phone request");
    return structuredClone(job);
  }
  capability() {
    return {
      id: "iphone-via-mac", name: PHONE_LABEL, parentDeviceId: this.options.macDeviceId,
      executable: Boolean(this.options.adapter),
      state: this.options.adapter ? "unverified" : "unavailable",
      reason: this.options.adapter ? undefined : this.unavailableReason(),
      detail: this.options.adapter
        ? "Connection is checked when a request is resumed. The iPhone must be nearby and locked."
        : PHONE_GUIDANCE[this.unavailableReason()],
      actions: ["safari.open_url"],
    };
  }
  enqueue(input: PhoneRequest) {
    const request = requestSchema.parse(input);
    request.url = navigationUrl(request.url);
    const prior = this.jobs.find((job) => job.requestId === request.requestId);
    if (prior) {
      if (prior.url !== request.url || prior.sourceTaskId !== request.sourceTaskId)
        throw new Error("requestId already used for a different phone action");
      return structuredClone(prior);
    }
    if (this.jobs.length >= 1000) throw new Error("Phone request history is full");
    if (this.jobs.filter((job) => ["queued", "running", "needs_input"].includes(job.status)).length >= 20)
      throw new Error("The phone queue is full");
    const now = this.now();
    const job: PhoneJob = {
      ...request, id: randomUUID(), deviceId: this.options.macDeviceId,
      label: PHONE_LABEL, action: "safari.open_url",
      status: this.options.adapter ? "queued" : "needs_input",
      reason: this.options.adapter ? undefined : this.unavailableReason(),
      message: this.options.adapter ? "Waiting for a fresh phone observation." : PHONE_GUIDANCE[this.unavailableReason()],
      createdAt: now, updatedAt: now,
    };
    this.jobs.push(job);
    return this.update(job, {});
  }
  cancel(id: string) {
    const job = this.jobs.find((item) => item.id === id);
    if (!job) throw new Error("Unknown phone request");
    if (!["queued", "running", "needs_input"].includes(job.status)) return structuredClone(job);
    this.active.get(id)?.abort();
    return this.update(job, { status: "cancelled", reason: "cancelled", message: PHONE_GUIDANCE.cancelled });
  }
  /** Explicit resume re-observes the real app; an arbitrary chat "yes" never calls this. */
  resume(id: string): Promise<PhoneJob> {
    return (this.options.serial ?? desktopSerialQueue).run(this.options.macDeviceId, async () => {
      const job = this.jobs.find((item) => item.id === id);
      if (!job) throw new Error("Unknown phone request");
      if (!["queued", "needs_input"].includes(job.status)) return structuredClone(job);
      const adapter = this.options.adapter;
      if (!adapter) return this.update(job, { status: "needs_input", reason: this.unavailableReason(), message: PHONE_GUIDANCE[this.unavailableReason()] });
      const controller = new AbortController();
      this.active.set(id, controller);
      try {
        const observation = observationSchema.parse(await adapter.observe(controller.signal));
        if (controller.signal.aborted) return structuredClone(job);
        if (!this.fresh(observation)) return this.update(job, { status: "needs_input", reason: "stale_observation", message: PHONE_GUIDANCE.stale_observation, observation });
        if (observation.state !== "ready") {
          const reason = observation.reason ?? "phone_locked_required";
          return this.update(job, { status: "needs_input", reason, message: PHONE_GUIDANCE[reason], observation });
        }
        this.update(job, { status: "running", reason: undefined, message: "Opening the requested URL in Safari on the iPhone.", observation });
        const result = await adapter.openSafariUrl(job.url, controller.signal);
        if (controller.signal.aborted) return structuredClone(job);
        const after = observationSchema.parse(result.observation);
        if (!this.fresh(after) || after.id === observation.id || after.state !== "ready" || navigationUrl(result.observedUrl) !== job.url || !result.evidence?.trim())
          return this.update(job, { status: "failed", message: "The phone action was attempted, but the requested URL was not independently verified. Inspect the phone before retrying.", observation: after });
        return this.update(job, { status: "completed", message: "The requested Safari URL was observed on the iPhone.", observation: after, evidence: result.evidence.slice(0, 2000) });
      } catch {
        if (controller.signal.aborted) return structuredClone(job);
        return this.update(job, { status: "failed", message: "The phone adapter failed. Inspect the phone before creating another request." });
      } finally {
        this.active.delete(id);
      }
    });
  }
  private fresh(observation: PhoneObservation) {
    const age = (this.options.now ?? Date.now)() - Date.parse(observation.at);
    return age >= 0 && age <= 5000;
  }
}
