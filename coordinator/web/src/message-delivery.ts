import { api, active } from "./api.js";
import { destinationIssue } from "./destination.js";
import { blockingApprovals } from "./navigation.js";
import type { Approval, Chat, Device, Envelope, Task } from "./types.js";

export class MessageNotSentError extends Error {}

export async function submitToDestination(token: string, request: Envelope, state: {
  connected: boolean; chats: Chat[]; devices: Device[]; tasks: Task[]; approvals: Approval[]; queueSupported?: boolean;
}): Promise<Task> {
  const issue = destinationIssue(request.chatId, state.chats, state.devices, state.connected);
  if (issue) throw new MessageNotSentError(issue);
  const expectedDevice = request.chatId === "master" ? "coordinator" : state.chats.find((chat) => chat.id === request.chatId)?.deviceId;
  if (request.expectedDeviceId && request.expectedDeviceId !== expectedDevice)
    throw new MessageNotSentError("The captured destination changed. Nothing was sent.");
  if (request.queueIfBusy === true && state.queueSupported !== true)
    throw new MessageNotSentError("Background queuing is not available. Nothing was sent.");
  const queue = request.queueIfBusy === true && state.queueSupported === true;
  if (!queue && blockingApprovals(request.chatId, state.tasks, state.approvals).length)
    throw new MessageNotSentError("This conversation has an unresolved input or permission request. Review its status before continuing.");
  if (!queue && state.tasks.some((task) => task.chatId === request.chatId && active(task.status)))
    throw new MessageNotSentError("This conversation is still working. Wait or stop it before sending another request.");
  const task = await api<Task>(token,
    request.chatId === "master" ? "/messages" : `/chats/${encodeURIComponent(request.chatId)}/messages`, {
      requestId: request.requestId, text: request.text,
      ...(request.queueIfBusy === true ? { queueIfBusy: true } : {}),
      ...(request.chatId === "master" ? {} : { sourceChatIds: request.sourceChatIds }),
    });
  if (!task?.id || !requestMatchesTask(request, task) || (expectedDevice && task.deviceId !== expectedDevice))
    throw new Error("Delivery could not be confirmed for this destination. Check delivery before sending again.");
  return task;
}

/** An uncertain acknowledgement is reconciled by reading, never by resubmitting. */
export async function findRequestDelivery(token: string, request: Envelope): Promise<Task | undefined> {
  const { tasks } = await api<{ tasks: Task[] }>(token, "/tasks");
  return tasks.find(task => requestMatchesTask(request, task));
}
export function requestMatchesTask(request: Envelope, task: Task): boolean {
  return task.requestId === request.requestId && task.chatId === request.chatId &&
    (!request.expectedDeviceId || task.deviceId === request.expectedDeviceId) &&
    task.prompt === request.text && (task.queueIfBusy === true) === (request.queueIfBusy === true) &&
    JSON.stringify(task.sourceChatIds ?? []) === JSON.stringify(request.chatId === "master" ? [] : request.sourceChatIds);
}
