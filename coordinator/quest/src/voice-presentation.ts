import { voiceReply } from "./controller-state";
import type { Snapshot, Task } from "./types";

export interface VoicePresentationInput {
  snapshot: Snapshot;
  taskId?: string;
  chatId: string;
  capturing?: boolean;
  transcribing?: boolean;
  dispatching?: boolean;
  speaking?: boolean;
  transcript?: string;
  error?: string;
}

export interface VoicePresentation {
  state: "idle" | "capturing" | "transcribing" | "dispatching" | "working" | "needs-input"
    | "speaking" | "completed" | "failed" | "cancelled" | "interrupted";
  status: string;
  transcript: string;
  transcriptPlaceholder: string;
  response?: { taskId: string; deviceId: string; deviceName?: string; text: string };
  error?: string;
}

const active = new Set(["queued", "running", "needs_input"]);
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);

function linkedState(snapshot: Snapshot, task: Task) {
  const children = task.childUpdates ?? [];
  const ids = new Set([...(task.childTaskIds ?? []), ...children.map((child) => child.id)]);
  const listed = snapshot.tasks.filter((candidate) => ids.has(candidate.id));
  const states = [task.status, ...(task.workStatus ? [task.workStatus] : []),
    ...children.map((child) => child.status),
    ...listed.flatMap((child) => [child.status, ...(child.workStatus ? [child.workStatus] : [])])];
  const count = task.childUpdateCount;
  const total = typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
  const incomplete = [...ids].some((id) => !children.some((child) => child.id === id) && !listed.some((child) => child.id === id))
    || (total !== undefined && total > ids.size)
    || (task.childUpdatesTruncated === true && total === undefined);
  return { states, incomplete };
}

/** Plain presentation only. The caller supplies the accepted request ID, never a latest-task guess. */
export function voicePresentation(input: VoicePresentationInput): VoicePresentation {
  const { snapshot } = input;
  const task = input.taskId ? snapshot.tasks.find((candidate) => candidate.id === input.taskId && candidate.chatId === input.chatId) : undefined;
  const reply = task ? voiceReply(snapshot, task.id) : undefined;
  const owner = reply && task
    ? reply.id === task.id ? task
      : snapshot.tasks.find((candidate) => candidate.id === reply.id)
        ?? task.childUpdates?.find((candidate) => candidate.id === reply.id)
    : undefined;
  let state: VoicePresentation["state"] = "idle";
  let status = "Ready for a voice request.";
  const reportedError = typeof input.error === "string" && input.error ? input.error : undefined;
  if (input.capturing) { state = "capturing"; status = "Listening…"; }
  else if (input.transcribing) { state = "transcribing"; status = "Transcribing…"; }
  else if (input.dispatching) { state = "dispatching"; status = "Sending request…"; }
  else if (input.speaking) { state = "speaking"; status = "Reading the response…"; }
  else if (reportedError) { state = "failed"; status = "Voice request needs attention."; }
  else if (task) {
    const { states, incomplete } = linkedState(snapshot, task);
    if (states.includes("needs_input")) { state = "needs-input"; status = "Your input is needed."; }
    else if (states.some((value) => active.has(value))) { state = "working"; status = "Working on your request…"; }
    else if (incomplete || states.some((value) => !terminal.has(value))) { state = "working"; status = "Waiting for task updates…"; }
    else if (states.includes("failed")) { state = "failed"; status = "The task reported a failure."; }
    else if (states.includes("interrupted")) { state = "interrupted"; status = "The task was interrupted."; }
    else if (states.includes("cancelled")) { state = "cancelled"; status = "The task was stopped."; }
    else { state = "completed"; status = reply ? "Response ready." : "The task finished without response text."; }
  } else if (input.taskId) {
    state = "working"; status = "Waiting for this request’s status…";
  }
  const transcript = input.transcript ?? "";
  const transcriptPlaceholder = input.capturing
    ? "Your transcript will appear after capture finishes."
    : input.transcribing ? "Waiting for the recorded transcript."
    : "Your transcript will appear here.";
  const error = reportedError ?? (task?.status === "failed" || task?.status === "interrupted" ? task.error : undefined);
  return {
    state, status, transcript, transcriptPlaceholder,
    ...(reply && owner ? { response: { taskId: reply.id, deviceId: owner.deviceId, text: reply.text,
      ...(reply.deviceName ? { deviceName: reply.deviceName } : {}) } } : {}),
    ...(error ? { error } : {}),
  };
}
