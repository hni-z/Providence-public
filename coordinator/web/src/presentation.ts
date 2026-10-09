import type { Artifact, Task, Chat, Device, ChildUpdate } from "./types.js";

export function linkedWork(parent: Task, tasks: Task[]) {
  if (parent.chatId !== "master") return [];
  return tasks
    .filter(
      (task) =>
        task.chatId !== "master" &&
        (task.parentTaskId === parent.id ||
          parent.childTaskIds?.includes(task.id) ||
          new RegExp(
            `(^|[^a-zA-Z0-9-])${task.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-zA-Z0-9-]|$)`,
          ).test(parent.text)),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function artifactKey(artifact: Artifact) {
  return `${artifact.chatId ?? artifact.taskId}:${(artifact.path ?? artifact.relativePath ?? artifact.name).replaceAll("\\", "/")}`;
}

export function groupArtifacts(artifacts: Artifact[]) {
  const unique = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const groups = new Map<string, Artifact[]>();
  for (const artifact of unique.values()) {
    const key = artifactKey(artifact);
    groups.set(key, [...(groups.get(key) ?? []), artifact]);
  }
  return [...groups.values()]
    .map((group) =>
      group.sort(
        (a, b) =>
          (b.revision ?? 0) - (a.revision ?? 0) ||
          (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
      ),
    )
    .sort((a, b) => (b[0].createdAt ?? "").localeCompare(a[0].createdAt ?? ""));
}

export function newestArtifact(artifact: Artifact, all: Artifact[]) {
  return (
    all
      .filter((candidate) => artifactKey(candidate) === artifactKey(artifact))
      .sort(
        (a, b) =>
          (b.revision ?? 0) - (a.revision ?? 0) ||
          (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
      )[0] ?? artifact
  );
}

export function queuedDependencyLabel(
  task: Pick<Task, "status" | "afterTaskId">,
  tasks: Task[],
  chatName: (id: string) => string,
) {
  if (task.status !== "queued" || !task.afterTaskId) return undefined;
  const source = tasks.find((candidate) => candidate.id === task.afterTaskId);
  return source
    ? `Waiting for ${chatName(source.chatId)}`
    : "Waiting for source task";
}

export function filterRegisteredChats(
  chats: Chat[],
  devices: Device[],
  query: string,
) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return chats;
  const deviceNames = new Map(
    devices.map((device) => [device.id, device.name]),
  );
  return chats.filter((chat) => {
    const searchable = [
      chat.name,
      chat.deviceId,
      deviceNames.get(chat.deviceId) ?? "",
      chat.workspace ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => searchable.includes(word));
  });
}

export function childUpdatesFor(
  parent: Task,
  tasks: Task[],
  chats: Chat[],
  devices: Device[],
): ChildUpdate[] {
  if (parent.chatId !== "master") return [];
  if (parent.childUpdates !== undefined) return parent.childUpdates;
  return linkedWork(parent, tasks).map((task) => ({
    id: task.id,
    chatId: task.chatId,
    chatName:
      chats.find((chat) => chat.id === task.chatId)?.name ?? task.chatId,
    deviceId: task.deviceId,
    deviceName:
      devices.find((device) => device.id === task.deviceId)?.name ??
      task.deviceId,
    status: task.status,
    text: task.text,
    updatedAt: task.updatedAt,
    artifacts: task.artifacts,
    afterTaskId: task.afterTaskId,
    hasLiveText:
      ["running", "needs_input"].includes(task.status) && !!task.text,
    ...(task.error
      ? {
          progress: {
            kind: "result" as const,
            text: task.error,
            updatedAt: task.updatedAt,
          },
        }
      : {}),
  }));
}
export function historicalSuperagentReply(task: Task) {
  return (
    task.chatId === "master" &&
    task.hasNewerChildUpdates === true &&
    !!task.text
  );
}
