import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { HostBridgeError, HostBridgeJobs, type HostBridgeInventoryResult, type HostBridgeBrowserResult } from "../src/host-bridge.js";

function fixture(maxJobs = 50) {
  const directory = mkdtempSync(join(tmpdir(), "providence-host-bridge-"));
  const file = join(directory, "private", "jobs.json");
  const jobs = new HostBridgeJobs({ file, maxJobs });
  return { jobs, file, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
const matches = (code: HostBridgeError["code"]) => (error: unknown) => error instanceof HostBridgeError && error.code === code;
function result(): HostBridgeInventoryResult {
  return { hostTaskId: "actual-host-task", toolNames: ["mcp__codex_app__list_threads"], observedAt: new Date().toISOString(),
    tasks: [{ id: "task-one", title: "HTN MAIN", status: "running" }], summary: "One observed task." };
}

test("fixed action creation is persisted and exact request retries never create another job", () => {
  const f = fixture();
  try {
    const input = { requestId: "request-one", probeId: "PHC-one" };
    const first = f.jobs.create(input);
    assert.equal(first.action, "htn-task-inventory");
    assert.equal(first.status, "queued");
    assert.equal(f.jobs.create(input).id, first.id);
    assert.throws(() => f.jobs.create({ ...input, probeId: "changed" }), matches("request_conflict"));
    assert.throws(() => f.jobs.create({ ...input, requestId: "other" }), matches("request_conflict"));
    assert.throws(() => f.jobs.create({ ...input, action: "arbitrary-action" }), matches("invalid_request"));
    assert.throws(() => f.jobs.create({ ...input, prompt: "arbitrary prompt" }), matches("invalid_request"));
    const restarted = new HostBridgeJobs({ file: f.file });
    assert.equal(restarted.get(first.id).status, "queued");
    assert.equal(restarted.create(input).id, first.id);
  } finally { f.cleanup(); }
});

test("claim returns its fresh lease once, persists only its hash, and never reissues a lost reply", () => {
  const f = fixture();
  try {
    const job = f.jobs.create({ requestId: "request-one", probeId: "PHC-one" });
    const claim = { claimId: "private-claim-id", consumerId: "TOTAL MAIN" };
    const response = f.jobs.claim(job.id, claim);
    assert.equal(response.job.status, "claimed");
    assert.match(response.leaseToken, /^[a-f0-9]{64}$/);
    assert.throws(() => f.jobs.claim(job.id, claim), matches("claim_conflict"));
    assert.throws(() => f.jobs.claim(job.id, { claimId: "new-attempt", consumerId: "another" }), matches("claim_conflict"));
    assert.equal(f.jobs.get(job.id).status, "claimed");
    const saved = readFileSync(f.file, "utf8");
    assert.equal(saved.includes(response.leaseToken), false);
    assert.equal(saved.includes(createHash("sha256").update(response.leaseToken).digest("hex")), true);
    const publicData = JSON.stringify({ listed: f.jobs.list(), fetched: f.jobs.get(job.id), claimed: response.job });
    assert.equal(publicData.includes("leaseHash"), false);
    assert.equal(publicData.includes("leaseToken"), false);
    assert.equal(publicData.includes("private-claim-id"), false);
    if (process.platform !== "win32") assert.equal(statSync(f.file).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});

test("simultaneous claim attempts have one winner and claim IDs cannot be recycled for another job", async () => {
  const f = fixture();
  try {
    const job = f.jobs.create({ requestId: "r1", probeId: "p1" });
    const attempts = await Promise.allSettled(["a", "b"].map(claimId => Promise.resolve().then(() => f.jobs.claim(job.id, { claimId, consumerId: claimId }))));
    assert.equal(attempts.filter(attempt => attempt.status === "fulfilled").length, 1);
    const other = f.jobs.create({ requestId: "r2", probeId: "p2" });
    assert.throws(() => f.jobs.claim(other.id, { claimId: "a", consumerId: "a" }), matches("claim_conflict"));
  } finally { f.cleanup(); }
});

test("start and completion require the exact job/probe lease, and completion is precisely idempotent", () => {
  const f = fixture();
  try {
    const job = f.jobs.create({ requestId: "r1", probeId: "p1" });
    const claimed = f.jobs.claim(job.id, { claimId: "c1", consumerId: "TOTAL MAIN" });
    const authorization = { probeId: job.probeId, leaseToken: claimed.leaseToken };
    assert.throws(() => f.jobs.start(job.id, { ...authorization, probeId: "wrong" }), matches("probe_mismatch"));
    assert.throws(() => f.jobs.start(job.id, { ...authorization, leaseToken: "0".repeat(64) }), matches("invalid_lease"));
    assert.throws(() => f.jobs.complete(job.id, { ...authorization, completionId: "done", result: result() }), matches("state_conflict"));
    assert.equal(f.jobs.start(job.id, authorization).status, "running");
    assert.equal(f.jobs.start(job.id, authorization).status, "running");
    const completion = { ...authorization, completionId: "done", result: result() };
    const completed = f.jobs.complete(job.id, completion);
    assert.equal(completed.status, "completed");
    assert.deepEqual(f.jobs.complete(job.id, completion), completed);
    assert.throws(() => f.jobs.complete(job.id, { ...completion, result: { ...completion.result, summary: "changed" } }), matches("completion_conflict"));
    assert.throws(() => f.jobs.complete(job.id, { ...completion, completionId: "new-id" }), matches("completion_conflict"));
    assert.throws(() => f.jobs.start(job.id, authorization), matches("state_conflict"));
    const publicData = JSON.stringify(f.jobs.get(job.id));
    assert.equal(publicData.includes("completionFingerprint"), false);
    assert.equal(publicData.includes("completionId"), false);
    const restarted = new HostBridgeJobs({ file: f.file });
    assert.deepEqual(restarted.complete(job.id, completion), completed);
  } finally { f.cleanup(); }
});

test("result scope is fixed to inventory tools and bounded task/summary output", () => {
  const f = fixture();
  try {
    const job = f.jobs.create({ requestId: "r1", probeId: "p1" });
    const { leaseToken } = f.jobs.claim(job.id, { claimId: "c1", consumerId: "TOTAL MAIN" });
    const authorization = { probeId: "p1", leaseToken };
    f.jobs.start(job.id, authorization);
    const valid = result();
    for (const invalid of [
      { ...valid, toolNames: ["mcp__codex_app__send_message_to_thread"] },
      { ...valid, toolNames: ["mcp__codex_app__read_thread"] },
      { ...valid, toolNames: ["mcp__codex_app__list_threads", "mcp__codex_app__list_threads"] },
      { ...valid, tasks: Array.from({ length: 51 }, () => valid.tasks[0]) },
      { ...valid, summary: "🙂".repeat(1537) },
      { ...valid, summary: leaseToken },
      { ...valid, arbitraryCode: "not allowed" },
    ]) assert.throws(() => f.jobs.complete(job.id, { ...authorization, completionId: "done", result: invalid }), matches("invalid_request"));
    assert.equal(f.jobs.get(job.id).status, "running");
    assert.equal(f.jobs.complete(job.id, { ...authorization, completionId: "done", result: { ...valid, summary: "🙂".repeat(1536) } }).status, "completed");
  } finally { f.cleanup(); }
});

test("restart interrupts claimed or running work without lease reassignment or late completion", () => {
  for (const started of [false, true]) {
    const f = fixture();
    try {
      const job = f.jobs.create({ requestId: "r1", probeId: "p1" });
      const { leaseToken } = f.jobs.claim(job.id, { claimId: "c1", consumerId: "TOTAL MAIN" });
      const authorization = { probeId: "p1", leaseToken };
      if (started) f.jobs.start(job.id, authorization);
      const restarted = new HostBridgeJobs({ file: f.file });
      assert.equal(restarted.get(job.id).status, "interrupted");
      assert.throws(() => restarted.claim(job.id, { claimId: "c2", consumerId: "replacement" }), matches("claim_conflict"));
      assert.throws(() => restarted.start(job.id, authorization), matches("state_conflict"));
      assert.throws(() => restarted.complete(job.id, { ...authorization, completionId: "done", result: result() }), matches("state_conflict"));
    } finally { f.cleanup(); }
  }
});

test("failed jobs stay terminal, and the oldest finished job makes room for the next one", () => {
  const f = fixture(1);
  try {
    const request = { requestId: "r1", probeId: "p1" };
    const job = f.jobs.create(request);
    const { leaseToken } = f.jobs.claim(job.id, { claimId: "c1", consumerId: "TOTAL MAIN" });
    const failure = { probeId: "p1", leaseToken, error: "Host interface was unavailable; action not confirmed." };
    assert.equal(f.jobs.fail(job.id, failure).status, "failed");
    assert.equal(f.jobs.fail(job.id, failure).status, "failed");
    assert.equal(f.jobs.create(request).id, job.id);
    assert.throws(() => f.jobs.claim(job.id, { claimId: "c2", consumerId: "retry" }), matches("claim_conflict"));
    assert.equal(f.jobs.create({ requestId: "r2", probeId: "p2" }).status, "queued");
    assert.throws(() => f.jobs.get(job.id), matches("unknown_job"));
    assert.throws(() => f.jobs.create({ requestId: "r3", probeId: "p3" }), matches("history_full"));
  } finally { f.cleanup(); }
});

test("a history full of completed jobs accepts new work; a history full of queued jobs does not", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 50; i++) {
      const job = f.jobs.create({ requestId: `r${i}`, probeId: `p${i}` });
      const { leaseToken } = f.jobs.claim(job.id, { claimId: `c${i}`, consumerId: "TOTAL MAIN" });
      const lease = { probeId: job.probeId, leaseToken };
      f.jobs.start(job.id, lease);
      f.jobs.complete(job.id, { ...lease, completionId: `done-${i}`, result: result() });
    }
    const fresh = f.jobs.create({ requestId: "r50", probeId: "p50" });
    assert.equal(fresh.status, "queued");
    assert.equal(f.jobs.list().length, 50);
    assert.equal(f.jobs.list()[0].requestId, "r1");
    assert.equal(new HostBridgeJobs({ file: f.file }).get(fresh.id).status, "queued");
  } finally { f.cleanup(); }
});

test("queued jobs are never evicted to make room", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 50; i++) f.jobs.create({ requestId: `q${i}`, probeId: `qp${i}` });
    assert.throws(() => f.jobs.create({ requestId: "q50", probeId: "qp50" }), matches("history_full"));
    assert.equal(f.jobs.list().length, 50);
  } finally { f.cleanup(); }
});

test("a lease and completion ID cannot be transferred to another job", () => {
  const f = fixture();
  try {
    const first = f.jobs.create({ requestId: "r1", probeId: "p1" });
    const second = f.jobs.create({ requestId: "r2", probeId: "p2" });
    const one = f.jobs.claim(first.id, { claimId: "c1", consumerId: "TOTAL MAIN" });
    const two = f.jobs.claim(second.id, { claimId: "c2", consumerId: "TOTAL MAIN" });
    assert.throws(() => f.jobs.start(second.id, { probeId: "p2", leaseToken: one.leaseToken }), matches("invalid_lease"));
    f.jobs.start(first.id, { probeId: "p1", leaseToken: one.leaseToken });
    f.jobs.start(second.id, { probeId: "p2", leaseToken: two.leaseToken });
    const observed = result();
    f.jobs.complete(first.id, { probeId: "p1", leaseToken: one.leaseToken, completionId: "one-completion", result: observed });
    assert.throws(() => f.jobs.complete(second.id, { probeId: "p2", leaseToken: two.leaseToken, completionId: "one-completion", result: observed }), matches("completion_conflict"));
    assert.equal(f.jobs.get(second.id).status, "running");
  } finally { f.cleanup(); }
});

function chromeResult(probeId: string): HostBridgeBrowserResult {
  const text = "Providence Mac control check " + probeId;
  return { hostTaskId: "actual-host-task", toolNames: ["mcp__cua_repl.js"], observedAt: new Date().toISOString(),
    browser: { deviceId: "mac", url: "https://www.google.com/", field: "Search", expectedText: text, observedText: text, submitted: false, evidence: "accessibility" } };
}

test("Chrome action generates its exact public browser request without accepting caller instructions", () => {
  const f = fixture();
  try {
    const input = { requestId: "chrome-create", probeId: "PHC_CU-0919-A", action: "mac-chrome-typing-proof" };
    const job = f.jobs.create(input);
    assert.deepEqual(job.browserRequest, { deviceId: "mac", url: "https://www.google.com/", field: "Search", text: "Providence Mac control check PHC_CU-0919-A", submit: false });
    assert.equal(f.jobs.create(input).id, job.id);
    assert.throws(() => f.jobs.create({ ...input, action: "htn-task-inventory" }), matches("request_conflict"));
    assert.throws(() => f.jobs.create({ ...input, browserRequest: { url: "https://elsewhere.example/" } }), matches("invalid_request"));
    assert.throws(() => f.jobs.create({ ...input, prompt: "Different action" }), matches("invalid_request"));
    for (const probeId of ["spaces here", "ends-with-newline\n", "slash/path", "é", "a".repeat(101)])
      assert.throws(() => f.jobs.create({ ...input, requestId: "invalid", probeId }), matches("invalid_request"));
    const disk = JSON.parse(readFileSync(f.file, "utf8"));
    assert.equal("browserRequest" in disk[0], false, "request is derived from the fixed action, not stored caller configuration");
    const restarted = new HostBridgeJobs({ file: f.file });
    assert.deepEqual(restarted.get(job.id).browserRequest, job.browserRequest);
    const inventory = restarted.create({ requestId: "inventory", probeId: "inventory" });
    assert.equal("browserRequest" in inventory, false);
    assert.equal(restarted.create({ requestId: "inventory", probeId: "inventory", action: "htn-task-inventory" }).id, inventory.id);
  } finally { f.cleanup(); }
});

test("Chrome completion requires the fixed tool, URL, exact accessibility text and no submission", () => {
  const f = fixture();
  try {
    const job = f.jobs.create({ requestId: "chrome", probeId: "CU-123", action: "mac-chrome-typing-proof" });
    const { leaseToken } = f.jobs.claim(job.id, { claimId: "chrome-claim", consumerId: "TOTAL MAIN" });
    const authorization = { probeId: job.probeId, leaseToken };
    f.jobs.start(job.id, authorization);
    const valid = chromeResult(job.probeId);
    for (const invalid of [
      result(),
      { ...valid, browser: { ...valid.browser, expectedText: "different", observedText: "different" } },
      { ...valid, browser: { ...valid.browser, observedText: valid.browser.expectedText + " " } },
      { ...valid, browser: { ...valid.browser, submitted: true } },
      { ...valid, browser: { ...valid.browser, url: "https://www.google.com/search?q=test" } },
      { ...valid, browser: { ...valid.browser, field: "Other" } },
      { ...valid, browser: { ...valid.browser, deviceId: "demoPC" } },
      { ...valid, browser: { ...valid.browser, evidence: "model-claim" } },
      { ...valid, toolNames: ["mcp__codex_app__list_threads"] },
      { ...valid, tasks: [] },
    ]) assert.throws(() => f.jobs.complete(job.id, { ...authorization, completionId: "chrome-complete", result: invalid }), matches("invalid_request"));
    assert.equal(f.jobs.get(job.id).status, "running");
    const completion = { ...authorization, completionId: "chrome-complete", result: valid };
    const complete = f.jobs.complete(job.id, completion);
    assert.equal(complete.status, "completed");
    assert.deepEqual(f.jobs.complete(job.id, completion), complete);
    const restarted = new HostBridgeJobs({ file: f.file });
    assert.deepEqual(restarted.complete(job.id, completion), complete);
    assert.deepEqual(complete.browserRequest?.text, valid.browser.observedText);
  } finally { f.cleanup(); }
});

test("inventory cannot complete with a browser result and Chrome restart keeps one-time claim semantics", () => {
  const f = fixture();
  try {
    const inventory = f.jobs.create({ requestId: "inventory", probeId: "inv" });
    const invClaim = f.jobs.claim(inventory.id, { claimId: "inv-claim", consumerId: "TOTAL MAIN" });
    const invAuthorization = { probeId: inventory.probeId, leaseToken: invClaim.leaseToken };
    f.jobs.start(inventory.id, invAuthorization);
    assert.throws(() => f.jobs.complete(inventory.id, { ...invAuthorization, completionId: "wrong-kind", result: chromeResult(inventory.probeId) }), matches("invalid_request"));
    const oldResult = result();
    f.jobs.complete(inventory.id, { ...invAuthorization, completionId: "inventory-completion", result: oldResult });
    const chrome = f.jobs.create({ requestId: "chrome", probeId: "CU-456", action: "mac-chrome-typing-proof" });
    const chromeClaim = f.jobs.claim(chrome.id, { claimId: "chrome-claim", consumerId: "TOTAL MAIN" });
    const restarted = new HostBridgeJobs({ file: f.file });
    assert.equal(restarted.get(chrome.id).status, "interrupted");
    assert.deepEqual(restarted.get(inventory.id).result, oldResult);
    assert.throws(() => restarted.claim(chrome.id, { claimId: "retry", consumerId: "TOTAL MAIN" }), matches("claim_conflict"));
    assert.throws(() => restarted.start(chrome.id, { probeId: chrome.probeId, leaseToken: chromeClaim.leaseToken }), matches("state_conflict"));
  } finally { f.cleanup(); }
});
