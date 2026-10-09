import { assertGUIAvailable, HostRouteError } from "../../iphone-mirroring/host-route.mjs";
import type { Task } from "./store.js";

export const MAX_QUEUED_PER_CHAT = 8;
export type AdmissionQueueWait = { reason: "chat_busy" | "device_busy"; predecessorTaskId: string };
export function admissionQueueCapabilities() {
  return { version: 1, supported: true, requestField: "queueIfBusy", maxQueuedPerChat: MAX_QUEUED_PER_CHAT, restartBehavior: "interrupt_no_replay" } as const;
}
const active = (task: Task) => ["queued", "running", "needs_input"].includes(task.status);

/** Store insertion order is the durable admission order. Later waiting requests
 * cannot acquire a resource ahead of this task, but active/uncertain work always counts. */
export function reservationTasksForStart(task: Task, ordered: readonly Task[]): Task[] {
  const index = ordered.findIndex((candidate) => candidate.id === task.id);
  return ordered.filter((candidate, candidateIndex) => candidate.id !== task.id &&
    (candidate.status !== "queued" || index < 0 || candidateIndex < index));
}

export function admissionQueueWait(task: Task, ordered: readonly Task[]): AdmissionQueueWait | undefined {
  const reservations = reservationTasksForStart(task, ordered);
  const sameChat = reservations.find((candidate) => candidate.chatId === task.chatId && active(candidate));
  if (sameChat) return { reason: "chat_busy", predecessorTaskId: sameChat.id };
  for (const candidate of reservations) {
    try {
      assertGUIAvailable({ deviceId: task.deviceId, taskId: task.id, executionTarget: task.executionTarget, tasks: [candidate] });
    } catch (error) {
      if (error instanceof HostRouteError && error.code === "deviceBusy")
        return { reason: "device_busy", predecessorTaskId: candidate.id };
      throw error;
    }
  }
  return undefined;
}
