import type { Approval, Task } from "./types.js";
export type SelectionEvent =
  | { kind: "user_selected_chat"; chatId: string }
  | {
      kind:
        | "request_routed"
        | "task_progress"
        | "task_completed"
        | "approval_resolved"
        | "refreshed"
        | "task_inspected"
        | "device_inspected";
    };
export function initialSelectedChat(_previousSelection?: string | null) {
  return "master";
}
export function selectedChatAfter(current: string, event: SelectionEvent) {
  return event.kind === "user_selected_chat" ? event.chatId : current;
}
export function reachableApprovals(
  selected: string,
  tasks: Task[],
  approvals: Approval[],
) {
  return selected === "master"
    ? approvals
    : approvals.filter((approval) =>
        tasks.some(
          (task) => task.id === approval.taskId && task.chatId === selected,
        ),
      );
}

/** Visible worker questions do not reserve the Superagent conversation. Only
 * this conversation's own unresolved decisions block its immediate sends. */
export function blockingApprovals(selected: string, tasks: Task[], approvals: Approval[]) {
  const ownTasks = new Set(tasks.filter(task => task.chatId === selected).map(task => task.id));
  return approvals.filter(approval => ownTasks.has(approval.taskId) && ["pending", "resolving"].includes(approval.status));
}
// One approval reachable in the conversation and inside task details at the
// same time becomes two cards with separate state, and the second answer is
// rejected because the first already resolved it.
export function taskDecisions(
  approvals: Approval[],
  reachable: Approval[],
  taskId?: string,
) {
  return approvals.filter(
    (approval) =>
      approval.taskId === taskId &&
      !reachable.some((shown) => shown.id === approval.id),
  );
}
export type SelectedVoiceOutcome = {
  id: string;
  contextKey: string;
  parentTaskId?: string;
  text: string;
  status: string;
  updatedAt: string;
};
export function selectedVoiceOutcomes(
  selected: string,
  tasks: Task[],
): SelectedVoiceOutcome[] {
  const final = (status: string) =>
    ["completed", "failed", "cancelled", "interrupted"].includes(status);
  const outcomes = new Map<string, SelectedVoiceOutcome>();
  const add = (outcome: SelectedVoiceOutcome) => {
    if (!outcome.text.trim() || !final(outcome.status)) return;
    const previous = outcomes.get(outcome.id);
    if (!previous || outcome.updatedAt >= previous.updatedAt)
      outcomes.set(outcome.id, outcome);
  };
  for (const task of tasks) {
    if (task.chatId !== selected) continue;
    // A child completion is not the accepted Superagent request's completion.
    // Wait for both its own turn and the server's aggregate delegated state.
    if (!final(task.status)) continue;
    const hasChildren = !!task.childTaskIds?.length || !!task.childUpdates?.length ||
      (task.childUpdateCount ?? 0) > 0 || task.childUpdatesTruncated === true;
    const childIds = new Set([...(task.childTaskIds ?? []), ...(task.childUpdates ?? []).map(child => child.id)]);
    const parentStillWorking =
      selected === "master" && hasChildren &&
      (!task.workStatus || !final(task.workStatus) ||
        task.childUpdates?.some(child => !final(child.status) || child.hasLiveText) ||
        tasks.some(child => (child.parentTaskId === task.id || childIds.has(child.id)) &&
          (!final(child.status) || (!!child.workStatus && !final(child.workStatus)))));
    if (parentStillWorking) continue;
    if (!task.hasNewerChildUpdates)
      add({
        id: task.id,
        contextKey: selected,
        text: task.text,
        status: task.status,
        updatedAt: task.updatedAt,
      });
    if (selected === "master")
      for (const child of task.childUpdates ?? []) {
        const listed = tasks.find(candidate => candidate.id === child.id);
        if (!child.hasLiveText &&
          (!task.childTaskIds || task.childTaskIds.includes(child.id)) &&
          (!listed?.parentTaskId || listed.parentTaskId === task.id))
          add({
            id: child.id,
            contextKey: selected,
            parentTaskId: task.id,
            text: child.text,
            status: child.status,
            updatedAt: child.updatedAt,
          });
      }
  }
  return [...outcomes.values()].sort(
    (a, b) =>
      a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id),
  );
}
