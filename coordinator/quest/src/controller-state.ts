import type { ChildTaskUpdate, Snapshot, Task } from "./types";

const active = new Set(["queued", "running", "needs_input"]);
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);

export function requestReadiness(
  snapshot: Snapshot,
  chatId: string,
): { ready: boolean; reason?: "missing-chat" | "offline" | "working" } {
  if (chatId === "master") {
    return snapshot.tasks.some(
      (task) => task.chatId === "master" &&
        (active.has(task.status) || active.has(task.workStatus ?? "")),
    ) ? { ready: false, reason: "working" } : { ready: true };
  }
  const chat = snapshot.chats.find((candidate) => candidate.id === chatId);
  if (!chat) return { ready: false, reason: "missing-chat" };
  if (!snapshot.devices.some((device) => device.id === chat.deviceId && device.online === true)) {
    return { ready: false, reason: "offline" };
  }
  return snapshot.tasks.some((task) => task.chatId === chatId && active.has(task.status))
    ? { ready: false, reason: "working" }
    : { ready: true };
}

type Response = { id: string; text: string; deviceName?: string };
type ChildRecord = Task | ChildTaskUpdate;

function finished(record: ChildRecord): boolean {
  return terminal.has(record.status) &&
    !("workStatus" in record && active.has(record.workStatus ?? ""));
}

function timestamp(record: ChildRecord): number {
  const value = Date.parse(record.updatedAt);
  return Number.isFinite(value) ? value : -Infinity;
}

function response(snapshot: Snapshot, record: ChildRecord): Response {
  const name = snapshot.devices.find((device) => device.id === record.deviceId)?.name
    ?? ("deviceName" in record ? record.deviceName : undefined);
  return { id: record.id, text: record.text, ...(name ? { deviceName: name } : {}) };
}

/** Select text for an explicit reply control. This never speaks, dispatches or changes state. */
export function voiceReply(snapshot: Snapshot, requestTaskId: string): Response | undefined {
  const task = snapshot.tasks.find((candidate) => candidate.id === requestTaskId);
  if (!task || !finished(task)) return;
  const updates = task.childUpdates ?? [];
  const ids = new Set([...(task.childTaskIds ?? []), ...updates.map((child) => child.id)]);
  const count = task.childUpdateCount;
  const total = typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
  const delegated = ids.size > 0 || (total !== undefined && total > 0) || task.childUpdatesTruncated === true;
  if (!delegated) return task.text.trim() ? response(snapshot, task) : undefined;

  // A partial update list cannot prove that an omitted task has finished. Explicit
  // child IDs can fill that gap only when their corresponding records are present.
  if (!ids.size || (total !== undefined && total > ids.size)
    || (task.childUpdatesTruncated === true && total === undefined)) return;
  const replies: ChildRecord[] = [];
  for (const id of ids) {
    if (id === task.id) return;
    const records: ChildRecord[] = updates.filter((update) => update.id === id);
    const listed = snapshot.tasks.find((candidate) => candidate.id === id);
    if (listed) {
      if (listed.parentTaskId && listed.parentTaskId !== task.id) return;
      if (records.some((record) => record.deviceId !== listed.deviceId || record.chatId !== listed.chatId)) return;
      // Prefer the full task response over its bounded summary when timestamps tie.
      records.unshift(listed);
    }
    if (!records.length || records.some((record) => !finished(record))) return;
    const latest = records.sort((left, right) => timestamp(right) - timestamp(left))[0];
    if (latest.text.trim()) replies.push(latest);
  }
  const latest = replies.sort((left, right) => timestamp(right) - timestamp(left))[0];
  return latest ? response(snapshot, latest) : undefined;
}

export interface PendingSubmission { requestId: string; text: string; chatId: string }

/** Recovery never chooses a chat or fills a differently routed composer. */
export function restoreControllerState(raw: string | null): { selectedChat: "master"; pending?: PendingSubmission } {
  const state: { selectedChat: "master"; pending?: PendingSubmission } = { selectedChat: "master" };
  if (!raw) return state;
  try {
    const value = JSON.parse(raw);
    if (value && typeof value.requestId === "string" && value.requestId.length > 0 && value.requestId.length <= 200
      && typeof value.chatId === "string" && value.chatId.length > 0 && value.chatId.length <= 200
      && typeof value.text === "string" && value.text.trim() && value.text.length <= 30000)
      state.pending = { requestId: value.requestId, text: value.text, chatId: value.chatId };
  } catch { /* Invalid saved input is not a submission. */ }
  return state;
}

export function submissionForSend(pending: PendingSubmission | undefined, text: string, chatId: string, newId: () => string): PendingSubmission {
  if (!pending) return { requestId: newId(), text, chatId };
  if (pending.text !== text || pending.chatId !== chatId)
    throw new Error("Recover the unconfirmed request before sending a different request. Its original chat and text are shown below.");
  return pending;
}

/** All terminal capture outcomes remain visible, without guessing from error keywords. */
export function dictationPresentation(state: string, capturing: boolean) {
  const ready = state === "Final transcript ready.";
  const ended = !capturing && state !== "Not started";
  return {
    text: state === "Not started" || ready ? "" : state,
    clearListening: ended,
    discardContext: ended && !ready,
  };
}
