/** Validate a complete poll before any part replaces the last usable UI state. */
export function validateWorkspaceResponse(briefing: unknown, chats: unknown, tasks: unknown, activity: unknown): void {
  const object = (value: any): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
  const rows = (value: unknown, strings: string[]) => Array.isArray(value) && value.every(row => object(row) && strings.every(key => typeof row[key] === "string"));
  if (!object(briefing) || !rows(briefing.devices, ["id", "name"]) || !rows(briefing.approvals, ["id", "taskId", "deviceId", "method", "status"]) ||
      !object(chats) || !rows(chats.chats, ["id", "name", "deviceId", "threadId"]) ||
      !object(tasks) || !rows(tasks.tasks, ["id", "chatId", "deviceId", "prompt", "text", "status", "createdAt", "updatedAt"]) ||
      !object(activity) || !rows(activity.events, ["type", "at"]) || !Number.isSafeInteger(activity.latestSequence) || activity.latestSequence < 0 ||
      !activity.events.every((event: any) => Number.isSafeInteger(event.sequence) && event.sequence >= 0))
    throw new Error("Providence could not read the latest workspace update. Reconnecting without changing your existing conversations.");
}
