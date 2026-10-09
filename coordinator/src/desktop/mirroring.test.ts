import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopSerialQueue, MirroringQueue, type MirroringAdapter, type PhoneObservation } from "./mirroring.js";

function setup(adapter?: MirroringAdapter) {
  const directory = mkdtempSync(join(tmpdir(), "providence-phone-"));
  const file = join(directory, "phone.json");
  const queue = new MirroringQueue({ file, macDeviceId: "mac", adapter });
  return { queue, file, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
function observation(id: string, state: PhoneObservation["state"] = "ready"): PhoneObservation {
  return { id, state, source: "product_adapter", at: new Date().toISOString(), detail: "Test adapter observation" };
}

test("no product adapter means needs_input, never simulated success; request identity persists", async () => {
  const { queue, file, cleanup } = setup();
  try {
    const first = queue.enqueue({ requestId: "one", url: "https://example.com" });
    assert.equal(first.status, "needs_input");
    assert.equal(first.reason, "adapter_not_configured");
    assert.equal((await queue.resume(first.id)).status, "needs_input");
    assert.equal(queue.capability().executable, false);
    const resumed = new MirroringQueue({ file, macDeviceId: "mac" });
    assert.equal(resumed.enqueue({ requestId: "one", url: "https://example.com/" }).id, first.id);
    assert.throws(() => resumed.enqueue({ requestId: "one", url: "https://example.org" }), /different phone action/);
    assert.throws(() => resumed.enqueue({ requestId: "two", url: "javascript:alert(1)" }), /HTTP/);
    assert.throws(() => resumed.enqueue({ requestId: "two", url: "https://secret:password@example.org" }), /credentials/);
  } finally { cleanup(); }
});

test("an unlocked phone blocks input; explicit resume obtains a new observation", async () => {
  let observations = 0, actions = 0;
  const { queue, cleanup } = setup({
    async observe() {
      observations++;
      return observations === 1
        ? { ...observation("locked-needed", "needs_input"), reason: "phone_locked_required" }
        : observation("ready-now");
    },
    async openSafariUrl(url) {
      actions++;
      return { observedUrl: url, observation: observation("after-action"), evidence: "Test evidence" };
    },
  });
  try {
    const job = queue.enqueue({ requestId: "one", url: "https://example.com" });
    const blocked = await queue.resume(job.id);
    assert.equal(blocked.reason, "phone_locked_required");
    assert.equal(actions, 0);
    await Promise.all([queue.resume(job.id), queue.resume(job.id)]);
    assert.equal(queue.get(job.id).status, "completed");
    assert.equal(actions, 1);
    assert.equal(observations, 2);
  } finally { cleanup(); }
});

test("stale observations cannot authorize input", async () => {
  let actions = 0;
  const { queue, cleanup } = setup({
    async observe() { return { ...observation("stale"), at: new Date(Date.now() - 6000).toISOString() }; },
    async openSafariUrl() { actions++; throw new Error("must not execute"); },
  });
  try {
    const job = queue.enqueue({ requestId: "one", url: "https://example.com" });
    assert.equal((await queue.resume(job.id)).reason, "stale_observation");
    assert.equal(actions, 0);
  } finally { cleanup(); }
});

test("a reported action needs a different fresh observation of the requested URL", async () => {
  const { queue, cleanup } = setup({
    async observe() { return observation("before"); },
    async openSafariUrl() { return { observedUrl: "https://wrong.example/", observation: observation("after"), evidence: "Test evidence" }; },
  });
  try {
    const job = queue.enqueue({ requestId: "one", url: "https://example.com" });
    assert.equal((await queue.resume(job.id)).status, "failed");
  } finally { cleanup(); }
});

test("cancel while input is pending preserves cancellation despite late adapter completion", async () => {
  let finish!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const inputPending = new Promise<void>((resolve) => { finish = resolve; });
  const { queue, cleanup } = setup({
    async observe() { return observation("before"); },
    async openSafariUrl(url) {
      started(); await inputPending;
      return { observedUrl: url, observation: observation("after"), evidence: "Test evidence" };
    },
  });
  try {
    const job = queue.enqueue({ requestId: "one", url: "https://example.com" });
    const pending = queue.resume(job.id);
    await startedPromise;
    queue.cancel(job.id);
    finish();
    assert.equal((await pending).status, "cancelled");
    assert.equal(queue.get(job.id).status, "cancelled");
  } finally { cleanup(); }
});

test("restart interrupts uncertain in-flight actions without replay", () => {
  const { queue, file, cleanup } = setup();
  try {
    const job = queue.enqueue({ requestId: "one", url: "https://example.com" });
    const stored = JSON.parse(readFileSync(file, "utf8"));
    stored[0].status = "running";
    writeFileSync(file, JSON.stringify(stored));
    const restarted = new MirroringQueue({ file, macDeviceId: "mac" });
    assert.equal(restarted.get(job.id).status, "interrupted");
    assert.equal(restarted.get(job.id).reason, "restart_interrupted");
  } finally { cleanup(); }
});

test("GUI operations serialize per desktop, including after a failed operation", async () => {
  const serial = new DesktopSerialQueue();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = serial.run("mac", async () => { order.push("first-start"); await gate; order.push("first-end"); throw new Error("expected failure"); });
  const second = serial.run("mac", async () => { order.push("second"); });
  const other = serial.run("demoPC", async () => { order.push("other-desktop"); });
  await other;
  assert.deepEqual(order, ["first-start", "other-desktop"]);
  release();
  await assert.rejects(first, /expected failure/);
  await second;
  assert.deepEqual(order, ["first-start", "other-desktop", "first-end", "second"]);
});
