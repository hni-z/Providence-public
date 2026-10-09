import type { ChildTaskUpdate, Task } from "./types";

export interface TaskUpdates {
  children: ChildTaskUpdate[];
  coordinatorLabel: string;
  coverageNote?: string;
}

const active = new Set(["queued", "running", "needs_input"]);
const updateTime = (child: ChildTaskUpdate): number => {
  const time = Date.parse(child.updatedAt);
  return Number.isFinite(time) ? time : -Infinity;
};

/** Display only server-linked child updates. Parent prose never creates a child link. */
export function taskUpdates(task: Task): TaskUpdates {
  const children = [...(task.childUpdates ?? [])].sort(
    (left, right) => updateTime(right) - updateTime(left),
  );
  const master = task.chatId === "master";
  const coordinatorLabel = master
    ? children.length > 0 && task.hasNewerChildUpdates === true
      ? "Earlier coordinator reply"
      : "Coordinator reply"
    : "Agent response";
  const count = task.childUpdateCount;
  const declaredCount =
    typeof count === "number" && Number.isSafeInteger(count) && count >= 0
      ? count
      : undefined;
  let coverageNote: string | undefined;
  if (
    task.childUpdatesTruncated ||
    (declaredCount !== undefined && declaredCount > children.length)
  ) {
    coverageNote =
      declaredCount === undefined
        ? `Showing ${children.length} child updates; total not reported. The update list is truncated.`
        : `Showing ${children.length} of ${declaredCount} reported child updates.${task.childUpdatesTruncated ? " The update list is truncated." : ""}`;
  }
  return {
    children,
    coordinatorLabel,
    ...(coverageNote === undefined ? {} : { coverageNote }),
  };
}

/** Shared plain-text presentation for browser and spatial panels; no executable actions. */
export function childUpdateLines(child: ChildTaskUpdate): string[] {
  const lines = [
    `${child.deviceName} · ${child.chatName} · Status: ${child.status}`,
  ];
  const progress = child.progress?.text;
  if (progress && progress !== child.text) lines.push(`Progress: ${progress}`);
  if (child.text) {
    const label =
      child.hasLiveText && active.has(child.status)
        ? "Live update"
        : "Agent response";
    lines.push(`${label}: ${child.text}`);
  }
  if (child.textTruncated)
    lines.push(
      "Only part of this child response is shown. Open the child task for its available response.",
    );
  for (const artifact of child.artifacts ?? []) {
    lines.push(
      `File: ${artifact.name} · revision ${artifact.revision} · ${artifact.size} bytes`,
    );
  }
  const shown = child.artifacts?.length ?? 0;
  const truncated = child.artifactsTruncated === true;
  const count = child.artifactCount;
  // A truncated list cannot establish completeness from an equal/smaller total.
  // Ignore contradictory or malformed counts instead of inventing missing files.
  const total =
    typeof count === "number" && Number.isSafeInteger(count) && count >= shown &&
    (!truncated || count > shown)
      ? count
      : undefined;
  if (truncated || (total !== undefined && total > shown)) {
    lines.push(
      total === undefined
        ? `Showing ${shown} ${shown === 1 ? "artifact" : "artifacts"}; total unavailable. The artifact list is truncated.`
        : `Showing ${shown} of ${total} reported artifacts.${truncated ? " The artifact list is truncated." : ""}`,
    );
  }
  return lines;
}
