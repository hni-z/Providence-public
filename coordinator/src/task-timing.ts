/**
 * Privacy-preserving, per-turn timing.  This deliberately records no prompts,
 * provider payloads, tool arguments, output, or provider/model identifiers.
 */
export type TaskTimingClock = () => number;
export type WorkerStartMode = "cold" | "warm" | "unknown";

export type TaskTimingSnapshot = Readonly<{
  observedWallMs: number;
  workerStartMode: WorkerStartMode;
  workerReadyMs: number | null;
  turnAcknowledgedMs: number | null;
  firstProviderNotificationMs: number | null;
  firstTextMs: number | null;
  toolElapsedMs: number;
  toolCount: number;
  approvalWaitMs: number;
  approvalsRequested: number;
  approvalsResolved: number;
  approvalsExpired: number;
  /** True when active correlation IDs exceeded the bounded timing capacity. */
  incomplete: boolean;
  /** Provider/model inference time is not observable from this runtime. */
  modelInferenceMs: null;
}>;

const MAX_ACTIVE_INTERVALS = 256;

function elapsed(start: number, end: number): number {
  return Math.max(0, end - start);
}

type ActiveIntervals = { entries: Map<string, true>; elapsedMs: number; lastAt: number };

/**
 * One instance belongs to one execute call. Call finish on its terminal event.
 * Durations are monotonic-clock deltas, so wall-clock changes cannot skew them.
 */
export class TaskTiming {
  readonly #now: TaskTimingClock;
  readonly #startedAt: number;
  #finishedAt: number | undefined;
  #workerStartMode: WorkerStartMode = "unknown";
  #workerReadyAt: number | undefined;
  #turnAcknowledgedAt: number | undefined;
  #firstProviderNotificationAt: number | undefined;
  #firstTextAt: number | undefined;
  readonly #tools: ActiveIntervals;
  readonly #approvals: ActiveIntervals;
  #toolCount = 0;
  #approvalsRequested = 0;
  #approvalsResolved = 0;
  #approvalsExpired = 0;
  #incomplete = false;

  constructor(options: { now?: TaskTimingClock } = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#startedAt = this.#now();
    this.#tools = { entries: new Map(), elapsedMs: 0, lastAt: this.#startedAt };
    this.#approvals = { entries: new Map(), elapsedMs: 0, lastAt: this.#startedAt };
  }

  workerReady(mode: Exclude<WorkerStartMode, "unknown">): void {
    if (this.#workerReadyAt !== undefined || this.#finishedAt !== undefined) return;
    this.#workerStartMode = mode;
    this.#workerReadyAt = this.#now();
  }

  turnAcknowledged(): void { this.#markFirst("#turnAcknowledgedAt"); }
  providerNotification(): void { this.#markFirst("#firstProviderNotificationAt"); }
  textReceived(): void { this.#markFirst("#firstTextAt"); }

  toolStarted(id: string): void { if (this.#started(this.#tools, id)) this.#toolCount++; }
  toolCompleted(id: string): void {
    if (this.#finishedAt !== undefined) return;
    if (!this.#completed(this.#tools, id)) this.#incomplete = true;
  }

  approvalRequested(id: string): void {
    if (this.#started(this.#approvals, id)) this.#approvalsRequested++;
  }

  approvalResolved(id: string): void {
    if (this.#completed(this.#approvals, id)) this.#approvalsResolved++;
  }

  approvalExpired(id: string): void {
    if (this.#completed(this.#approvals, id)) this.#approvalsExpired++;
  }

  finish(): TaskTimingSnapshot {
    const endedAt = this.#finishedAt ?? this.#now();
    this.#finishedAt = endedAt;
    this.#advance(this.#tools, endedAt);
    this.#advance(this.#approvals, endedAt);
    this.#tools.entries.clear();
    this.#approvals.entries.clear();
    const at = (value: number | undefined) => value === undefined ? null : elapsed(this.#startedAt, value);
    return Object.freeze({
      observedWallMs: elapsed(this.#startedAt, endedAt),
      workerStartMode: this.#workerStartMode,
      workerReadyMs: at(this.#workerReadyAt),
      turnAcknowledgedMs: at(this.#turnAcknowledgedAt),
      firstProviderNotificationMs: at(this.#firstProviderNotificationAt),
      firstTextMs: at(this.#firstTextAt),
      toolElapsedMs: this.#tools.elapsedMs,
      toolCount: this.#toolCount,
      approvalWaitMs: this.#approvals.elapsedMs,
      approvalsRequested: this.#approvalsRequested,
      approvalsResolved: this.#approvalsResolved,
      approvalsExpired: this.#approvalsExpired,
      incomplete: this.#incomplete,
      modelInferenceMs: null,
    });
  }

  #markFirst(field: "#turnAcknowledgedAt" | "#firstProviderNotificationAt" | "#firstTextAt"): void {
    if (this.#finishedAt !== undefined) return;
    if (field === "#turnAcknowledgedAt" && this.#turnAcknowledgedAt === undefined) this.#turnAcknowledgedAt = this.#now();
    if (field === "#firstProviderNotificationAt" && this.#firstProviderNotificationAt === undefined) this.#firstProviderNotificationAt = this.#now();
    if (field === "#firstTextAt" && this.#firstTextAt === undefined) this.#firstTextAt = this.#now();
  }

  #started(active: ActiveIntervals, id: string): boolean {
    if (this.#finishedAt !== undefined || active.entries.has(id)) return false;
    if (active.entries.size >= MAX_ACTIVE_INTERVALS) {
      this.#incomplete = true;
      return false;
    }
    this.#advance(active, this.#now());
    active.entries.set(id, true);
    return true;
  }

  #completed(active: ActiveIntervals, id: string): boolean {
    if (this.#finishedAt !== undefined || !active.entries.has(id)) return false;
    this.#advance(active, this.#now());
    active.entries.delete(id);
    return true;
  }

  #advance(active: ActiveIntervals, at: number): void {
    if (active.entries.size > 0) active.elapsedMs += elapsed(active.lastAt, at);
    active.lastAt = at;
  }
}
