import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export const HOST_BRIDGE_ACTION = "htn-task-inventory" as const;
export const HOST_BRIDGE_BROWSER_ACTION = "mac-chrome-typing-proof" as const;
const actionSchema = z.enum([HOST_BRIDGE_ACTION, HOST_BRIDGE_BROWSER_ACTION]);
const browserProbeId = /^[A-Za-z0-9_-]{1,100}$/;
const id = z.string().trim().min(1).max(200);
const lease = z.string().regex(/^[a-f0-9]{64}$/);
const toolName = z.enum(["mcp__codex_app__list_threads", "mcp__codex_app__read_thread"]);
const inventoryResultSchema = z.object({
  hostTaskId: id,
  toolNames: z.array(toolName).min(1).max(2).refine(names => names.includes("mcp__codex_app__list_threads") && new Set(names).size === names.length),
  observedAt: z.string().datetime({ offset: true }),
  tasks: z.array(z.object({ id, title: z.string().min(1).max(512), status: z.string().min(1).max(100) }).strict()).max(50),
  summary: z.string().max(6144).refine(value => Buffer.byteLength(value, "utf8") <= 6144).optional(),
}).strict();
export type HostBridgeInventoryResult = z.infer<typeof inventoryResultSchema>;
const browserRequestSchema = z.object({
  deviceId: z.literal("mac"), url: z.literal("https://www.google.com/"), field: z.literal("Search"),
  text: z.string().min(1).max(200), submit: z.literal(false),
}).strict();
export type HostBridgeBrowserRequest = z.infer<typeof browserRequestSchema>;
const browserResultSchema = z.object({
  hostTaskId: id,
  toolNames: z.tuple([z.literal("mcp__cua_repl.js")]),
  observedAt: z.string().datetime({ offset: true }),
  browser: z.object({
    deviceId: z.literal("mac"), url: z.literal("https://www.google.com/"), field: z.literal("Search"),
    expectedText: z.string().min(1).max(200), observedText: z.string().min(1).max(200),
    submitted: z.literal(false), evidence: z.literal("accessibility"),
  }).strict(),
  summary: z.string().max(6144).refine(value => Buffer.byteLength(value, "utf8") <= 6144).optional(),
}).strict();
export type HostBridgeBrowserResult = z.infer<typeof browserResultSchema>;
export const hostBridgeResultSchema = z.union([inventoryResultSchema, browserResultSchema]);
export type HostBridgeResult = z.infer<typeof hostBridgeResultSchema>;
const publicSchema = z.object({
  id: z.string().uuid(), requestId: id, probeId: id, action: actionSchema,
  status: z.enum(["queued", "claimed", "running", "completed", "failed", "interrupted"]),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  claimedAt: z.string().datetime().optional(), startedAt: z.string().datetime().optional(), completedAt: z.string().datetime().optional(),
  consumerId: id.optional(), result: hostBridgeResultSchema.optional(), error: z.string().max(1024).optional(),
  browserRequest: browserRequestSchema.optional(),
});
export type HostBridgeJob = z.infer<typeof publicSchema>;
const storedSchema = publicSchema.omit({ browserRequest: true }).extend({
  claimId: id.optional(), leaseHash: lease.optional(), completionId: id.optional(), completionFingerprint: lease.optional(),
}).strict();
type StoredJob = z.infer<typeof storedSchema>;
const createSchema = z.object({ requestId: id, probeId: id, action: actionSchema.default(HOST_BRIDGE_ACTION) }).strict();
const claimSchema = z.object({ claimId: id, consumerId: id }).strict();
const leasedSchema = z.object({ probeId: id, leaseToken: lease }).strict();
const completeSchema = leasedSchema.extend({ completionId: id, result: hostBridgeResultSchema }).strict();
const failSchema = leasedSchema.extend({ error: z.string().trim().min(1).max(1024) }).strict();

const failures = {
  invalid_request: [400, "Invalid host-bridge request or result."],
  unknown_job: [404, "Unknown host-bridge job."],
  request_conflict: [409, "Request ID or probe ID already belongs to a different host-bridge submission."],
  claim_conflict: [409, "This job is already claimed or the claim ID was already used. No new lease was issued; inspect the existing job."],
  invalid_lease: [403, "The host-bridge job lease is invalid."],
  probe_mismatch: [409, "The probe ID does not match this host-bridge job."],
  state_conflict: [409, "The host-bridge job is not in the required state. It will not be replayed automatically."],
  completion_conflict: [409, "Completion ID or result does not match the recorded completion."],
  history_full: [409, "Host-bridge history is full; existing job identities are retained."],
  invalid_state: [500, "Host-bridge state could not be loaded. Preserve the private state file for inspection."],
  storage_failed: [500, "Host-bridge state could not be saved. No new claim or result was confirmed."],
} as const;
export class HostBridgeError extends Error {
  readonly status: number;
  readonly statusCode: number;
  constructor(readonly code: keyof typeof failures) {
    super(failures[code][1]); this.name = "HostBridgeError";
    this.status = this.statusCode = failures[code][0];
  }
}
function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new HostBridgeError("invalid_request");
  return result.data;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function browserRequest(probeId: string): HostBridgeBrowserRequest {
  return { deviceId: "mac", url: "https://www.google.com/", field: "Search", text: "Providence Mac control check " + probeId, submit: false };
}
function resultMatchesAction(job: StoredJob, result: HostBridgeResult): boolean {
  if (job.action === HOST_BRIDGE_ACTION) return "tasks" in result;
  return "browser" in result && result.browser.expectedText === browserRequest(job.probeId).text &&
    result.browser.observedText === result.browser.expectedText;
}

/** Single-writer private store. No tools, RPC, prompts, timers, lease reassignment,
 * daemon access or executable code. The owner-authorized host consumer performs
 * one fixed action (inventory or non-submitting Mac Chrome typing); HTTP authentication belongs to the caller.
 */
export class HostBridgeJobs {
  private jobs: StoredJob[];
  private readonly maxJobs: number;
  constructor(private readonly options: { file: string; maxJobs?: number; now?: () => number }) {
    this.maxJobs = options.maxJobs ?? 50;
    if (!Number.isInteger(this.maxJobs) || this.maxJobs < 1 || this.maxJobs > 50) throw new HostBridgeError("invalid_state");
    try {
      if (existsSync(options.file) && statSync(options.file).size > 8 * 1024 * 1024) throw new Error();
      this.jobs = existsSync(options.file) ? z.array(storedSchema).max(50).parse(JSON.parse(readFileSync(options.file, "utf8"))) : [];
      for (const field of ["id", "requestId", "probeId", "claimId", "completionId"] as const) {
        const values = this.jobs.map(job => job[field]).filter(value => value !== undefined);
        if (new Set(values).size !== values.length) throw new Error();
      }
      for (const job of this.jobs) if (job.status !== "queued" && (!job.claimId || !job.leaseHash || !job.consumerId)) throw new Error();
      for (const job of this.jobs) {
        if (job.action === HOST_BRIDGE_BROWSER_ACTION && !browserProbeId.test(job.probeId)) throw new Error();
        if (job.result && !resultMatchesAction(job, job.result)) throw new Error();
        if (job.status === "queued" && (job.claimId || job.leaseHash || job.consumerId)) throw new Error();
        if (job.status === "completed" && (!job.completionId || !job.result || !job.startedAt ||
            job.completionFingerprint !== digest(JSON.stringify({ probeId: job.probeId, result: job.result })))) throw new Error();
      }
    } catch { throw new HostBridgeError("invalid_state"); }
    for (const job of this.jobs) if (["claimed", "running"].includes(job.status)) {
      job.status = "interrupted";
      job.error = "Coordinator restarted after claim. Host execution may have occurred; this job will not be reassigned or replayed.";
      job.updatedAt = this.now();
    }
    this.save();
  }
  private now() { return new Date((this.options.now ?? Date.now)()).toISOString(); }
  private save() {
    try {
      mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
      const temporary = this.options.file + ".tmp";
      writeFileSync(temporary, JSON.stringify(this.jobs, null, 2), { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.options.file);
    } catch { throw new HostBridgeError("storage_failed"); }
  }
  private find(jobId: string): StoredJob {
    const job = this.jobs.find(value => value.id === jobId);
    if (!job) throw new HostBridgeError("unknown_job");
    return job;
  }
  private view(job: StoredJob): HostBridgeJob {
    return publicSchema.parse({ ...job, ...(job.action === HOST_BRIDGE_BROWSER_ACTION ? { browserRequest: browserRequest(job.probeId) } : {}) });
  }
  private update(job: StoredJob, patch: Partial<StoredJob>): StoredJob {
    const index = this.jobs.indexOf(job);
    const updated = { ...job, ...patch, updatedAt: this.now() };
    this.jobs[index] = updated;
    try { this.save(); } catch (error) { this.jobs[index] = job; throw error; }
    return updated;
  }
  private authorize(job: StoredJob, input: { probeId: string; leaseToken: string }) {
    if (job.probeId !== input.probeId) throw new HostBridgeError("probe_mismatch");
    const provided = Buffer.from(digest(input.leaseToken), "hex");
    const expected = Buffer.from(job.leaseHash ?? "0".repeat(64), "hex");
    if (!timingSafeEqual(provided, expected) || !job.leaseHash) throw new HostBridgeError("invalid_lease");
  }
  list(): HostBridgeJob[] { return this.jobs.map(job => this.view(job)); }
  get(jobId: string): HostBridgeJob { return this.view(this.find(jobId)); }
  create(input: unknown): HostBridgeJob {
    if (input && typeof input === "object" && (input as any).action === HOST_BRIDGE_BROWSER_ACTION &&
        (typeof (input as any).probeId !== "string" || !browserProbeId.test((input as any).probeId)))
      throw new HostBridgeError("invalid_request");
    const request = parse(createSchema, input);
    const prior = this.jobs.find(job => job.requestId === request.requestId);
    if (prior) {
      if (prior.probeId !== request.probeId || prior.action !== request.action) throw new HostBridgeError("request_conflict");
      return this.view(prior);
    }
    if (this.jobs.some(job => job.probeId === request.probeId)) throw new HostBridgeError("request_conflict");
    // A finished job is history, so the oldest one makes room rather than
    // letting a full log refuse every later job. Unfinished work is never cut.
    let evictedAt = -1;
    let evicted: StoredJob | undefined;
    if (this.jobs.length >= this.maxJobs) {
      evictedAt = this.jobs.findIndex(job => ["completed", "failed", "interrupted"].includes(job.status));
      if (evictedAt < 0) throw new HostBridgeError("history_full");
      [evicted] = this.jobs.splice(evictedAt, 1);
    }
    const now = this.now();
    const job: StoredJob = { ...request, id: randomUUID(), status: "queued", createdAt: now, updatedAt: now };
    this.jobs.push(job);
    try { this.save(); } catch (error) {
      this.jobs.pop();
      if (evicted) this.jobs.splice(evictedAt, 0, evicted);
      throw error;
    }
    return this.view(job);
  }
  claim(jobId: string, input: unknown): { job: HostBridgeJob; leaseToken: string } {
    const request = parse(claimSchema, input);
    const job = this.find(jobId);
    if (job.status !== "queued" || this.jobs.some(value => value.claimId === request.claimId)) throw new HostBridgeError("claim_conflict");
    const leaseToken = randomBytes(32).toString("hex");
    const claimed = this.update(job, { status: "claimed", claimId: request.claimId, consumerId: request.consumerId,
      claimedAt: this.now(), leaseHash: digest(leaseToken) });
    return { job: this.view(claimed), leaseToken };
  }
  start(jobId: string, input: unknown): HostBridgeJob {
    const request = parse(leasedSchema, input);
    const job = this.find(jobId);
    this.authorize(job, request);
    if (job.status === "running") return this.view(job);
    if (job.status !== "claimed") throw new HostBridgeError("state_conflict");
    return this.view(this.update(job, { status: "running", startedAt: this.now() }));
  }
  complete(jobId: string, input: unknown): HostBridgeJob {
    const request = parse(completeSchema, input);
    const job = this.find(jobId);
    this.authorize(job, request);
    if (!resultMatchesAction(job, request.result)) throw new HostBridgeError("invalid_request");
    const fingerprint = digest(JSON.stringify({ probeId: request.probeId, result: request.result }));
    if (job.status === "completed") {
      if (job.completionId === request.completionId && job.completionFingerprint === fingerprint) return this.view(job);
      throw new HostBridgeError("completion_conflict");
    }
    if (job.status !== "running") throw new HostBridgeError("state_conflict");
    if (this.jobs.some(value => value.completionId === request.completionId)) throw new HostBridgeError("completion_conflict");
    if (JSON.stringify(request.result).includes(request.leaseToken)) throw new HostBridgeError("invalid_request");
    return this.view(this.update(job, { status: "completed", completionId: request.completionId,
      completionFingerprint: fingerprint, result: request.result, completedAt: this.now() }));
  }
  fail(jobId: string, input: unknown): HostBridgeJob {
    const request = parse(failSchema, input);
    const job = this.find(jobId);
    this.authorize(job, request);
    if (job.status === "failed" && job.error === request.error) return this.view(job);
    if (!["claimed", "running"].includes(job.status)) throw new HostBridgeError("state_conflict");
    if (request.error.includes(request.leaseToken)) throw new HostBridgeError("invalid_request");
    return this.view(this.update(job, { status: "failed", error: request.error, completedAt: this.now() }));
  }
}
