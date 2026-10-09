import type { AcceptedVoiceTask, VoiceOutcome } from "./browser-voice.js";
export type VoiceQueueCapability = { version: 1; supported: true; requestField: "queueIfBusy"; maxQueuedPerChat: 8; restartBehavior: "interrupt_no_replay" };
export function parseVoiceQueueCapability(value: unknown): VoiceQueueCapability | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || candidate.supported !== true || candidate.requestField !== "queueIfBusy" ||
      candidate.maxQueuedPerChat !== 8 || candidate.restartBehavior !== "interrupt_no_replay") return;
  return { version: 1, supported: true, requestField: "queueIfBusy", maxQueuedPerChat: 8, restartBehavior: "interrupt_no_replay" };
}
export type VoiceJob = AcceptedVoiceTask & { transcript: string };
const terminal = new Set(["completed", "failed", "interrupted", "cancelled"]);
/** Session-local index of durable server ACKs. Never adds drafts or infers delivery.
 * Capture resets do not touch it. The server remains the durable task/history store.
 */
export class VoiceJobLedger {
  private jobs = new Map<string, VoiceJob>();
  private outcomes = new Map<string, VoiceOutcome>();
  accept(task: AcceptedVoiceTask, transcript: string): VoiceJob {
    if (![task?.id, task?.requestId, task?.chatId].every(value => typeof value === "string" && value.length > 0))
      throw new Error("The voice request did not receive a matching task acknowledgement.");
    const previous = [...this.jobs.values()].find(job => job.id === task.id || job.requestId === task.requestId);
    if (previous) {
      if (previous.id !== task.id || previous.requestId !== task.requestId || previous.chatId !== task.chatId || previous.transcript !== transcript)
        throw new Error("The voice request acknowledgement changed identity.");
      return previous;
    }
    const job = Object.freeze({ id: task.id, requestId: task.requestId, chatId: task.chatId, transcript });
    this.jobs.set(job.id, job); return job;
  }
  list(context: string) { return [...this.jobs.values()].filter(job => job.chatId === context); }
  allows(context: string, outcome: VoiceOutcome): boolean {
    return outcome.contextKey === context && this.list(context).some(job => outcome.id === job.id || (context === "master" && outcome.parentTaskId === job.id));
  }
  observe(values: readonly VoiceOutcome[]): boolean {
    let changed = false;
    for (const value of values) {
      if (!this.allows(value.contextKey, value)) continue;
      const key = `${value.contextKey}:${value.id}`, old = this.outcomes.get(key);
      if (old && (value.updatedAt < old.updatedAt || (terminal.has(old.status) && !terminal.has(value.status)))) continue;
      if (JSON.stringify(old) !== JSON.stringify(value)) { this.outcomes.set(key, { ...value }); changed = true; }
    }
    return changed;
  }
  replies(jobId: string, context: string): VoiceOutcome[] {
    const job = this.jobs.get(jobId);
    if (!job || job.chatId !== context) return [];
    return [...this.outcomes.values()].filter(outcome => outcome.contextKey === context &&
      (outcome.id === job.id || (context === "master" && outcome.parentTaskId === job.id)));
  }
}
