import { test } from "node:test";
import assert from "node:assert/strict";
import { childUpdateLines, taskUpdates } from "../src/task-updates";
import type { ChildTaskUpdate, Task } from "../src/types";

const parent = (overrides: Partial<Task> = {}): Task => ({
  id: "parent-task",
  chatId: "master",
  deviceId: "coordinator",
  status: "completed",
  prompt: "Prepare the result",
  text: "An earlier coordinator reply",
  createdAt: "2026-09-19T07:00:00Z",
  updatedAt: "2026-09-19T07:00:01Z",
  ...overrides,
});
const child = (overrides: Partial<ChildTaskUpdate> = {}): ChildTaskUpdate => ({
  id: "child-task",
  chatId: "device-chat",
  chatName: "Requested work",
  deviceId: "mac-device",
  deviceName: "Actual Mac",
  status: "completed",
  text: "The requested result is ready.",
  updatedAt: "2026-09-19T07:01:00Z",
  hasLiveText: false,
  ...overrides,
});

test("a newer completed child remains visible beside an earlier coordinator clarification", () => {
  const task = parent({
    status: "completed",
    text: "The device is waiting for approval.",
    childUpdates: [child()],
    hasNewerChildUpdates: true,
    workStatus: "completed",
  });
  const projection = taskUpdates(task);
  assert.equal(projection.coordinatorLabel, "Earlier coordinator reply");
  assert.equal(projection.children[0].status, "completed");
  assert.ok(
    childUpdateLines(projection.children[0]).includes(
      "Agent response: The requested result is ready.",
    ),
  );
  assert.equal(task.status, "completed");
  assert.equal(task.text, "The device is waiting for approval.");
  assert.equal(projection.coverageNote, undefined);
});

test("child updates sort by update time rather than creation/input order without mutating records", () => {
  const oldest = child({
    id: "created-second",
    updatedAt: "2026-09-19T07:02:00Z",
  });
  const newest = child({
    id: "created-first",
    updatedAt: "2026-09-19T03:04:00-04:00",
  });
  const middle = child({
    id: "created-third",
    updatedAt: "2026-09-19T07:03:00Z",
  });
  const updates = [oldest, newest, middle];
  updates.forEach(Object.freeze);
  Object.freeze(updates);
  const result = taskUpdates(parent({ childUpdates: updates }));
  assert.deepEqual(
    result.children.map((item) => item.id),
    ["created-first", "created-third", "created-second"],
  );
  assert.deepEqual(
    updates.map((item) => item.id),
    ["created-second", "created-first", "created-third"],
  );
  assert.notEqual(result.children, updates);
  assert.equal(result.children[0], newest);
});

test("legacy tasks do not infer children or stale replies from prose, child IDs, or timestamps", () => {
  const task = parent({
    text: "Child abc completed its work.",
    childTaskIds: ["abc"],
    hasNewerChildUpdates: true,
    latestChildUpdateAt: "2099-01-01T00:00:00Z",
  });
  assert.deepEqual(taskUpdates(task), {
    children: [],
    coordinatorLabel: "Coordinator reply",
  });
  assert.deepEqual(taskUpdates(parent({ chatId: "worker-chat" })), {
    children: [],
    coordinatorLabel: "Agent response",
  });
});

test("earlier coordinator label requires master, explicit children, and the exact newer flag", () => {
  assert.equal(
    taskUpdates(parent({ childUpdates: [child()] })).coordinatorLabel,
    "Coordinator reply",
  );
  assert.equal(
    taskUpdates(
      parent({ childUpdates: [child()], hasNewerChildUpdates: false }),
    ).coordinatorLabel,
    "Coordinator reply",
  );
  assert.equal(
    taskUpdates(
      parent({
        childUpdates: [child()],
        hasNewerChildUpdates: true,
        chatId: "worker-chat",
      }),
    ).coordinatorLabel,
    "Agent response",
  );
});

test("active live output and progress remain distinct, with actual attribution and no added success claim", () => {
  const update = child({
    status: "running",
    hasLiveText: true,
    text: "Inspecting the selected workspace.",
    progress: {
      kind: "tool",
      text: "Reading the result file",
      updatedAt: "2026-09-19T07:01:00Z",
    },
  });
  const lines = childUpdateLines(update);
  assert.ok(lines.includes("Actual Mac · Requested work · Status: running"));
  assert.ok(lines.includes("Progress: Reading the result file"));
  assert.ok(lines.includes("Live update: Inspecting the selected workspace."));
  assert.equal(
    lines.some((line) => /verified|successful|completed/.test(line)),
    false,
  );
});

test("terminal failed output is an agent response even if an old live flag remains", () => {
  const lines = childUpdateLines(
    child({
      status: "failed",
      hasLiveText: true,
      text: "The operation failed.",
      progress: {
        kind: "result",
        text: "Failure reported",
        updatedAt: "2026-09-19T07:01:00Z",
      },
    }),
  );
  assert.match(lines[0], /Status: failed$/);
  assert.ok(lines.includes("Progress: Failure reported"));
  assert.ok(lines.includes("Agent response: The operation failed."));
  assert.equal(
    lines.some((line) => line.startsWith("Live update:")),
    false,
  );
});

test("body is labelled live only when both the active status and live flag are present", () => {
  for (const status of ["queued", "running", "needs_input"]) {
    assert.ok(
      childUpdateLines(child({ status, hasLiveText: true })).some((line) =>
        line.startsWith("Live update:"),
      ),
    );
    assert.ok(
      childUpdateLines(child({ status, hasLiveText: false })).some((line) =>
        line.startsWith("Agent response:"),
      ),
    );
  }
  for (const status of ["completed", "failed", "cancelled", "interrupted"]) {
    assert.ok(
      childUpdateLines(child({ status, hasLiveText: true })).some((line) =>
        line.startsWith("Agent response:"),
      ),
    );
  }
});

test("identical progress and body text appears once, preserving the appropriate body label", () => {
  const text = "Waiting for the requested choice.";
  const update = child({
    status: "needs_input",
    hasLiveText: true,
    text,
    progress: {
      kind: "waiting_input",
      text,
      updatedAt: "2026-09-19T07:01:00Z",
    },
  });
  const lines = childUpdateLines(update);
  assert.equal(lines.filter((line) => line.includes(text)).length, 1);
  assert.ok(lines.includes(`Live update: ${text}`));
  assert.ok(
    childUpdateLines({ ...update, text: "" }).includes(`Progress: ${text}`),
  );
});

test("coverage reports bounded lists and declared totals without fabricating missing children", () => {
  const updates = [child()];
  assert.equal(
    taskUpdates(parent({ childUpdates: updates, childUpdateCount: 4 }))
      .coverageNote,
    "Showing 1 of 4 reported child updates.",
  );
  assert.equal(
    taskUpdates(
      parent({
        childUpdates: updates,
        childUpdateCount: 4,
        childUpdatesTruncated: true,
      }),
    ).coverageNote,
    "Showing 1 of 4 reported child updates. The update list is truncated.",
  );
  assert.equal(
    taskUpdates(parent({ childUpdatesTruncated: true })).coverageNote,
    "Showing 0 child updates; total not reported. The update list is truncated.",
  );
  assert.equal(
    taskUpdates(parent({ childUpdates: updates, childUpdateCount: 1 }))
      .coverageNote,
    undefined,
  );
  assert.equal(taskUpdates(parent({ childUpdateCount: 4 })).children.length, 0);
});

test("artifact, task, device, chat, and dependency identities survive the projection unchanged", () => {
  const artifact = {
    id: "immutable-artifact",
    taskId: "child-task",
    name: "result.txt",
    mime: "text/plain",
    size: 42,
    revision: 3,
    sha256: "a".repeat(64),
  };
  const update = child({
    artifacts: [artifact],
    afterTaskId: "prior-task",
    textTruncated: true,
  });
  const projected = taskUpdates(parent({ childUpdates: [update] })).children[0];
  assert.deepEqual(projected, update);
  assert.equal(projected.artifacts?.[0], artifact);
  assert.equal(projected.afterTaskId, "prior-task");
  const lines = childUpdateLines(projected);
  assert.ok(lines.includes("File: result.txt · revision 3 · 42 bytes"));
  assert.ok(
    lines.includes(
      "Only part of this child response is shown. Open the child task for its available response.",
    ),
  );
  assert.equal(
    lines.some((line) => /externally verified|execution verified/.test(line)),
    false,
  );
});

const fixtureArtifact = (index = 1) => ({
  id: `artifact-${index}`, taskId: "child-task", name: `result-${index}.txt`,
  mime: "text/plain", size: index * 10, revision: index, sha256: "a".repeat(64),
});

test("legacy artifact lists retain their existing lines without a fabricated coverage count", () => {
  const update = child({ artifacts: [fixtureArtifact()] });
  const lines = childUpdateLines(update);
  assert.ok(lines.includes("File: result-1.txt · revision 1 · 10 bytes"));
  assert.equal(lines.some((line) => line.startsWith("Showing ")), false);
  assert.equal(childUpdateLines(child()).some((line) => line.startsWith("Showing ")), false);
  assert.equal(childUpdateLines({ ...update, artifactCount: 1, artifactsTruncated: false }).some((line) => line.startsWith("Showing ")), false);
});

test("a capped artifact list reports the actual shown count and declared total without adding files", () => {
  const artifacts = Array.from({ length: 20 }, (_, index) => fixtureArtifact(index + 1));
  const update = child({ artifacts, artifactCount: 27, artifactsTruncated: true });
  const lines = childUpdateLines(update);
  assert.ok(lines.includes("Showing 20 of 27 reported artifacts. The artifact list is truncated."));
  assert.equal(lines.filter((line) => line.startsWith("File: ")).length, 20);
  assert.equal(lines.some((line) => line.includes("result-21.txt")), false);
  assert.equal(taskUpdates(parent({ childUpdates: [update] })).children[0].artifacts, artifacts);
  assert.deepEqual(artifacts.map((artifact) => artifact.id), Array.from({ length: 20 }, (_, index) => `artifact-${index + 1}`));
});

test("larger declared artifact counts report incomplete coverage even without a truncation flag", () => {
  assert.ok(childUpdateLines(child({ artifacts: [fixtureArtifact()], artifactCount: 3 })).includes("Showing 1 of 3 reported artifacts."));
  const empty = childUpdateLines(child({ artifactCount: 3 }));
  assert.ok(empty.includes("Showing 0 of 3 reported artifacts."));
  assert.equal(empty.some((line) => line.startsWith("File: ")), false);
});

test("a truncation flag with no total reports only the number actually supplied", () => {
  assert.ok(childUpdateLines(child({ artifacts: [fixtureArtifact()], artifactsTruncated: true })).includes("Showing 1 artifact; total unavailable. The artifact list is truncated."));
  assert.ok(childUpdateLines(child({ artifactsTruncated: true })).includes("Showing 0 artifacts; total unavailable. The artifact list is truncated."));
});

test("malformed and contradictory artifact totals cannot manufacture coverage or completeness", () => {
  const artifacts = [fixtureArtifact()];
  for (const artifactCount of [-1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "99" as unknown as number]) {
    const withoutFlag = childUpdateLines(child({ artifacts, artifactCount }));
    assert.equal(withoutFlag.some((line) => line.startsWith("Showing ")), false);
    const withFlag = childUpdateLines(child({ artifacts, artifactCount, artifactsTruncated: true }));
    assert.ok(withFlag.includes("Showing 1 artifact; total unavailable. The artifact list is truncated."));
    assert.equal(withFlag.filter((line) => line.startsWith("File: ")).length, 1);
  }
  const contradictory = childUpdateLines(child({ artifacts, artifactCount: 1, artifactsTruncated: true }));
  assert.ok(contradictory.includes("Showing 1 artifact; total unavailable. The artifact list is truncated."));
  assert.equal(contradictory.some((line) => /verified|successful/.test(line)), false);
});
