import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_WORKFLOW_FACT_BUNDLE_BYTES,
  parseWorkflowFactBundle,
  serializeWorkflowFactBundle,
  type WorkflowFactBundle,
} from "../src/workflow-facts.js";

function bundle(overrides: Partial<WorkflowFactBundle> = {}): WorkflowFactBundle {
  return {
    version: 1,
    topic: "Climate briefing",
    criteria: "Give sourced, concise facts for the pitch.",
    generatedAt: "2026-09-20T12:00:00Z",
    origin: { taskId: "task-1", chatId: "chat-1", deviceId: "device-1", artifact: { status: "published", id: "report-1", sha256: "a".repeat(64) } },
    sources: [{ id: "source-1", url: "https://example.com/report", title: "Report", retrievedAt: "2026-09-20T11:59:00Z" }],
    facts: [{ id: "fact-1", text: "The report contains a published summary.", sourceIds: ["source-1"] }],
    ...overrides,
  };
}

test("round trips published, local-unconfirmed, and not-published bundles without modifying their content", () => {
  const published = bundle();
  assert.deepEqual(parseWorkflowFactBundle(serializeWorkflowFactBundle(published)), published);
  const unconfirmed = bundle({ origin: { taskId: "task-1", chatId: "chat-1", deviceId: "device-1", artifact: { status: "publication_unconfirmed", sha256: "b".repeat(64), size: 42, path: "outputs\\brief.md" } } });
  assert.deepEqual(parseWorkflowFactBundle(serializeWorkflowFactBundle(unconfirmed), { taskId: "task-1", chatId: "chat-1", deviceId: "device-1" }), unconfirmed);
  const unpublished = bundle({ origin: { taskId: "task-1", chatId: "chat-1", deviceId: "device-1", artifact: { status: "not_published" } } });
  assert.deepEqual(parseWorkflowFactBundle(unpublished), unpublished);
});

test("rejects unknown and missing fields", () => {
  assert.throws(() => parseWorkflowFactBundle({ ...bundle(), extra: true }), /Unrecognized key/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ origin: { taskId: "task-1", chatId: "chat-1", deviceId: "device-1", artifact: { status: "not_published", id: "fabricated" } as any } })), /Unrecognized key/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ origin: { taskId: "task-1", chatId: "chat-1", deviceId: "device-1", artifact: { status: "publication_unconfirmed", sha256: "b".repeat(64), size: 42, path: "out.md", id: "fabricated" } as any } })), /Unrecognized key/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ origin: { taskId: "task-1", chatId: "chat-1", deviceId: "device-1", artifact: { status: "publication_unconfirmed", sha256: "b".repeat(64), size: 42 } as any } })), /path/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ sources: [{ id: "source-1", url: "https://example.com", title: "A", retrievedAt: "2026-09-20T11:59:00Z", extra: true } as any] })), /Unrecognized key/);
  const missing = bundle();
  delete (missing as Partial<WorkflowFactBundle>).criteria;
  assert.throws(() => parseWorkflowFactBundle(missing), /criteria/);
});

test("rejects borrowed provenance", () => {
  assert.throws(() => parseWorkflowFactBundle(bundle(), { taskId: "other", chatId: "chat-1", deviceId: "device-1" }), /origin does not match/);
});

test("rejects duplicate ids and dangling fact citations", () => {
  assert.throws(() => parseWorkflowFactBundle(bundle({ sources: [
    { id: "source-1", url: "https://example.com/a", title: "A", retrievedAt: "2026-09-20T11:59:00Z" },
    { id: "source-1", url: "https://example.com/b", title: "B", retrievedAt: "2026-09-20T11:59:00Z" },
  ] })), /source ids must be unique/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ facts: [{ id: "fact-1", text: "x", sourceIds: ["missing"] }] })), /does not exist/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ facts: [
    { id: "fact-1", text: "x", sourceIds: ["source-1"] }, { id: "fact-1", text: "y", sourceIds: ["source-1"] },
  ] })), /fact ids must be unique/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ facts: [{ id: "fact-1", text: "x", sourceIds: ["source-1", "source-1"] }] })), /fact source ids must be unique/);
});

test("rejects malformed timestamps, URLs, credentials, and artifact hashes", () => {
  assert.throws(() => parseWorkflowFactBundle(bundle({ generatedAt: "tomorrow" })), /generatedAt/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ sources: [{ id: "source-1", url: "ftp://example.com", title: "A", retrievedAt: "2026-09-20T11:59:00Z" }] })), /HTTP/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ sources: [{ id: "source-1", url: "https://user:pass@example.com", title: "A", retrievedAt: "2026-09-20T11:59:00Z" }] })), /credentials/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ sources: [{ id: "source-1", url: " https://example.com", title: "A", retrievedAt: "2026-09-20T11:59:00Z" }] })), /whitespace/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ sources: [{ id: "source-1", url: "https://example.com/\tpath", title: "A", retrievedAt: "2026-09-20T11:59:00Z" }] })), /whitespace/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ origin: { taskId: "task-1", chatId: "chat-1", deviceId: "device-1", artifact: { status: "published", id: "x", sha256: "not-a-hash" } } })), /sha256/);
  for (const artifact of [
    { status: "publication_unconfirmed", sha256: "bad", size: 1, path: "out.md" },
    { status: "publication_unconfirmed", sha256: "b".repeat(64), size: 0, path: "out.md" },
    { status: "publication_unconfirmed", sha256: "b".repeat(64), size: 524289, path: "out.md" },
    { status: "publication_unconfirmed", sha256: "b".repeat(64), size: 1.5, path: "out.md" },
  ]) assert.throws(() => parseWorkflowFactBundle(bundle({ origin: { taskId: "task-1", chatId: "chat-1", deviceId: "device-1", artifact } as any })), /sha256|size/);
});

test("accepts ordinary relative artifact paths without normalization and rejects unsafe paths", () => {
  for (const path of ["outputs/brief.md", "outputs\\brief.md", "folder with spaces/report.md", "資料/brief.md", "percent%20name.md"]) {
    const value = bundle({ origin: { taskId: "task-1", chatId: "chat-1", deviceId: "device-1", artifact: { status: "publication_unconfirmed", sha256: "b".repeat(64), size: 42, path } } });
    assert.equal(parseWorkflowFactBundle(value).origin.artifact.status, "publication_unconfirmed");
  }
  for (const path of ["", "/tmp/report", "\\\\server\\share\\report", "\\rooted\\report", "C:report", "C:\\report", "reports/../secret", "reports\\..\\secret", "report\u0000.md"]) {
    assert.throws(() => parseWorkflowFactBundle(bundle({ origin: { taskId: "task-1", chatId: "chat-1", deviceId: "device-1", artifact: { status: "publication_unconfirmed", sha256: "b".repeat(64), size: 42, path } } })), /artifact path/);
  }
});

test("enforces collection and string bounds", () => {
  assert.throws(() => parseWorkflowFactBundle(bundle({ sources: [] })), /at least one source/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ facts: [] })), /at least one fact/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ sources: Array.from({ length: 3 }, (_, index) => ({ id: `s-${index}`, url: `https://example.com/${index}`, title: "A", retrievedAt: "2026-09-20T11:59:00Z" })) })), /at most 2/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ facts: Array.from({ length: 7 }, (_, index) => ({ id: `f-${index}`, text: "A", sourceIds: ["source-1"] })) })), /at most 6/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ topic: "x".repeat(241) })), /topic/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ topic: " \n " })), /non-whitespace/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ criteria: "\t" })), /non-whitespace/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ sources: [{ id: " ", url: "https://example.com", title: " ", retrievedAt: "2026-09-20T11:59:00Z" }] })), /non-whitespace/);
  assert.throws(() => parseWorkflowFactBundle(bundle({ facts: [{ id: "fact-1", text: "\n", sourceIds: ["source-1"] }] })), /non-whitespace/);
});

test("counts serialized UTF-8 bytes, including multibyte characters", () => {
  const exactly = bundle({
    sources: [
      { id: "source-1", url: "https://example.com/a", title: "A", retrievedAt: "2026-09-20T11:59:00Z" },
      { id: "source-2", url: "https://example.com/b", title: "B", retrievedAt: "2026-09-20T11:59:00Z" },
    ],
    facts: Array.from({ length: 6 }, (_, index) => ({ id: `fact-${index}`, text: "x", sourceIds: ["source-1"] })),
  });
  for (const fact of exactly.facts) {
    while (Buffer.byteLength(fact.text, "utf8") + 2 <= 640 && Buffer.byteLength(JSON.stringify(exactly), "utf8") + 2 <= MAX_WORKFLOW_FACT_BUNDLE_BYTES) fact.text += "é";
  }
  for (const fact of exactly.facts) {
    while (Buffer.byteLength(fact.text, "utf8") < 640 && Buffer.byteLength(JSON.stringify(exactly), "utf8") < MAX_WORKFLOW_FACT_BUNDLE_BYTES) fact.text += "x";
  }
  assert.equal(Buffer.byteLength(JSON.stringify(exactly), "utf8"), MAX_WORKFLOW_FACT_BUNDLE_BYTES);
  assert.equal(serializeWorkflowFactBundle(exactly), JSON.stringify(exactly));
  exactly.criteria += "é";
  assert.throws(() => parseWorkflowFactBundle(exactly), /serialized bundle/);
});
