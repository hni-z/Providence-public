import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import {
  HOST_PROOF_REQUEST,
  computerProofRequest,
  hostProofActionForHash,
  hostProofStorageKey,
  hostProofRequestBody,
  hostProofStatusText,
  makeHostProofRecord,
  parseHostProofRecord,
  retainNewestHostProofJob,
  validateHostProofJob,
} from "../web/src/hostProofState.js";
import type {
  HostBridgeJob,
  HostProofRecord,
} from "../web/src/hostProofState.js";
const webRequire = createRequire(
  new URL("../web/package.json", import.meta.url),
);
const React = webRequire("react") as {
  createElement: (...args: any[]) => unknown;
};
const { renderToStaticMarkup } = webRequire("react-dom/server") as {
  renderToStaticMarkup: (element: unknown) => string;
};
let ProofView: any;
before(async () => {
  ({ HostBridgeProofView: ProofView } = await tsImport(
    "../web/src/HostBridgeProof.tsx",
    {
      parentURL: import.meta.url,
      tsconfig: fileURLToPath(new URL("../web/tsconfig.json", import.meta.url)),
    },
  ));
});
const record: HostProofRecord = {
  requestId: "request-fixture",
  probeId: "PHW-0919-ABCDEF12",
};
const queued: HostBridgeJob = {
  id: "job-fixture",
  ...record,
  action: "htn-task-inventory",
  status: "queued",
  createdAt: "2026-09-19T09:30:00Z",
  updatedAt: "2026-09-19T09:30:00Z",
};
function render(job: HostBridgeJob | null, identity = record) {
  let actions = 0;
  const html = renderToStaticMarkup(
    React.createElement(ProofView, {
      record: identity,
      job,
      onSend: () => actions++,
      onRefresh: () => actions++,
      onBack: () => actions++,
      onLock: () => actions++,
    }),
  );
  assert.equal(
    actions,
    0,
    "rendering must not enqueue, claim, run, poll or navigate",
  );
  return html;
}

test("proof record survives refresh and retries keep the same request and probe identities", () => {
  const values = ["request-id", "a1b2c3d4-1111-4111-8111-111111111111"];
  const fresh = makeHostProofRecord(() => values.shift()!);
  assert.deepEqual(fresh, {
    requestId: "request-id",
    probeId: "PHW-0919-A1B2C3D4",
  });
  const saved = { ...fresh, submitted: true, jobId: "job-id" };
  const restored = parseHostProofRecord(JSON.stringify(saved));
  assert.deepEqual(restored, saved);
  assert.deepEqual(
    hostProofRequestBody(restored!),
    hostProofRequestBody(fresh),
  );
  assert.deepEqual(Object.keys(hostProofRequestBody(saved)).sort(), [
    "probeId",
    "requestId",
  ]);
  assert.equal(parseHostProofRecord("{bad"), undefined);
  assert.equal(
    parseHostProofRecord(JSON.stringify({ ...fresh, probeId: "other-proof" })),
    undefined,
  );
});

test("proof accepts only its own fixed action and identity and does not replace terminal state with stale progress", () => {
  assert.equal(validateHostProofJob(queued, record), queued);
  for (const changed of [
    { probeId: "PHW-0919-WRONG" },
    { requestId: "different" },
    { action: "arbitrary-action" },
    { status: "invented-status" },
  ])
    assert.throws(
      () =>
        validateHostProofJob(
          { ...queued, ...changed } as HostBridgeJob,
          record,
        ),
      /does not match/,
    );
  const completed = {
    ...queued,
    status: "completed" as const,
    updatedAt: "2026-09-19T09:31:00Z",
  };
  assert.equal(retainNewestHostProofJob(completed, queued), completed);
  assert.equal(retainNewestHostProofJob(queued, completed), completed);
});

test("SSR proof requires explicit Send and makes manual one-job scope visible", () => {
  const html = render(null);
  assert.ok(html.includes(HOST_PROOF_REQUEST));
  assert.ok(html.includes(record.probeId));
  assert.ok(html.includes(record.requestId));
  assert.ok(html.includes("Send proof request"));
  assert.ok(html.includes("manually claimed"));
  assert.ok(html.includes("TOTALMAIN must claim"));
  assert.ok(!html.includes("Reported tools"));
  assert.ok(!html.includes("Host result"));
  const unconfirmed = render(null, { ...record, submitted: true });
  assert.ok(unconfirmed.includes("Retry same request"));
  assert.ok(unconfirmed.includes("Delivery has not been confirmed"));
  assert.ok(unconfirmed.includes("Awaiting server confirmation"));
});

test("queued, claimed and running states do not imply completed host tool execution", () => {
  for (const status of ["queued", "claimed", "running"] as const) {
    const html = render(
      { ...queued, status },
      { ...record, jobId: queued.id, submitted: true },
    );
    assert.ok(html.includes(hostProofStatusText(status)));
    assert.ok(!html.includes("Send proof request"));
    assert.ok(!html.includes("Host result"));
    assert.ok(!html.includes("mcp__codex_app__list_threads"));
  }
  const html = render(queued, { ...record, jobId: queued.id });
  assert.ok(html.includes("No host execution has been reported"));
});

test("reported host result displays actual returned identifiers, tool names, observation and escaped task fields", () => {
  const job: HostBridgeJob = {
    ...queued,
    status: "completed",
    result: {
      hostTaskId: "actual-host-task",
      toolNames: ["mcp__codex_app__list_threads"],
      observedAt: "2026-09-19T09:31:00Z",
      tasks: [
        {
          id: "actual-task-id",
          title: "HTN <script>untrusted title</script>",
          status: "running",
        },
      ],
      summary: "One observed task.",
    },
  };
  const html = render(job, { ...record, jobId: job.id });
  for (const item of [
    job.id,
    record.probeId,
    "actual-host-task",
    "mcp__codex_app__list_threads",
    "actual-task-id",
    "running",
    "One observed task.",
    "Result reported by Codex host",
  ])
    assert.ok(html.includes(item), item);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("mcp__codex_app__read_thread"));
  assert.ok(!html.includes("Send proof request"));
});

test("failure and interruption retain exact error without creating a replacement job", () => {
  for (const status of ["failed", "interrupted"] as const) {
    const html = render(
      { ...queued, status, error: "Host consumer unavailable" },
      { ...record, jobId: queued.id, submitted: true },
    );
    assert.ok(html.includes(hostProofStatusText(status)));
    assert.ok(html.includes("Host consumer unavailable"));
    assert.ok(!html.includes("Send proof request"));
    assert.ok(!html.includes("Retry same request"));
  }
});

test("computer-use intent has a separate storage key and cannot reuse or convert inventory intent", () => {
  assert.equal(
    hostProofActionForHash("#host-bridge-proof"),
    "htn-task-inventory",
  );
  assert.equal(
    hostProofActionForHash("#computer-use-proof"),
    "mac-chrome-typing-proof",
  );
  assert.equal(hostProofActionForHash("#other"), undefined);
  assert.notEqual(
    hostProofStorageKey("htn-task-inventory"),
    hostProofStorageKey("mac-chrome-typing-proof"),
  );
  assert.equal(
    parseHostProofRecord(JSON.stringify(record), "mac-chrome-typing-proof"),
    undefined,
  );
  const ids = ["computer-request", "11223344-1111-4111-8111-111111111111"];
  const computerRecord = makeHostProofRecord(
    () => ids.shift()!,
    "mac-chrome-typing-proof",
  );
  assert.equal(parseHostProofRecord(JSON.stringify(computerRecord)), undefined);
  assert.deepEqual(
    parseHostProofRecord(
      JSON.stringify(computerRecord),
      "mac-chrome-typing-proof",
    ),
    computerRecord,
  );
  assert.deepEqual(hostProofRequestBody(computerRecord), {
    requestId: "computer-request",
    probeId: "PHW-0919-11223344",
    action: "mac-chrome-typing-proof",
  });
  assert.throws(
    () =>
      validateHostProofJob(
        {
          ...queued,
          requestId: computerRecord.requestId,
          probeId: computerRecord.probeId,
        },
        computerRecord,
      ),
    /does not match/,
  );
});

test("computer-use view shows fixed Mac Google Search text and no-submit instruction before explicit Send", () => {
  const computerRecord: HostProofRecord = {
    ...record,
    action: "mac-chrome-typing-proof",
  };
  const request = computerProofRequest(computerRecord.probeId);
  assert.deepEqual(request, {
    deviceId: "mac",
    url: "https://www.google.com/",
    field: "Search",
    text: "Providence Mac control check PHW-0919-ABCDEF12",
    submit: false,
  });
  const html = render(null, computerRecord);
  for (const label of [
    "ONE-JOB COMPUTER USE PROOF",
    "Mac browser typing check",
    request.url,
    request.field,
    request.text,
    "without submitting",
    "fresh accessibility observation",
    "Send proof request",
  ])
    assert.ok(html.includes(label), label);
  assert.ok(!html.includes(HOST_PROOF_REQUEST));
  assert.ok(!html.includes("Observed text"));
  assert.ok(!html.includes("Reported tools"));
});

test("computer-use result shows actual expected and observed accessibility text without inventory claims", () => {
  const computerRecord: HostProofRecord = {
    ...record,
    action: "mac-chrome-typing-proof",
    jobId: "computer-job",
    submitted: true,
  };
  const request = computerProofRequest(computerRecord.probeId);
  const job: HostBridgeJob = {
    ...queued,
    id: "computer-job",
    action: "mac-chrome-typing-proof",
    browserRequest: request,
    status: "completed",
    result: {
      hostTaskId: "actual-cua-host-task",
      toolNames: ["mcp__cua_repl.js"],
      observedAt: "2026-09-19T10:00:00Z",
      browser: {
        deviceId: "mac",
        url: "https://www.google.com/",
        field: "Search",
        expectedText: request.text,
        observedText: request.text,
        submitted: false,
        evidence: "accessibility",
      },
    },
  };
  assert.equal(validateHostProofJob(job, computerRecord), job);
  const html = render(job, computerRecord);
  for (const label of [
    "actual-cua-host-task",
    "mcp__cua_repl.js",
    "Expected text",
    "Observed text",
    request.text,
    "Search submitted",
    "accessibility",
  ])
    assert.ok(html.includes(label), label);
  assert.ok(!html.includes("<th>Task</th>"));
  assert.ok(!html.includes("mcp__codex_app__list_threads"));
  assert.ok(!html.includes("Send proof request"));
});
