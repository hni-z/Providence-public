import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Coordinator } from "../src/coordinator.js";
import { createHttpServer } from "../src/server.js";

test("HTTP consumer helper protects its lease, refuses repeat starts, and retries only the same result acknowledgement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-host-client-"));
  const config = { clientToken: "f".repeat(64), localDeviceId: "mac", localDeviceName: "Mac", workspace: directory, devices: [] };
  const configFile = join(directory, "config.json");
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const app = new Coordinator(config, directory);
  const server = createHttpServer(app, config.clientToken);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const script = fileURLToPath(new URL("../scripts/host-bridge-client.mjs", import.meta.url));
  const run = async (...args: string[]) => {
    const result = await promisify(execFile)(process.execPath, [script, ...args], {
      env: { ...process.env, PROVIDENCE_VERIFY_CONFIG: configFile, PROVIDENCE_BRIDGE_ORIGIN: origin },
    });
    assert.equal(result.stdout.includes(config.clientToken), false);
    return result;
  };
  try {
    const response = await fetch(origin + "/v1/host-bridge/jobs", { method: "POST", headers: { Authorization: `Bearer ${config.clientToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "helper-fixture", probeId: "PHW-0919-HELPER" }) });
    const { job } = await response.json();
    const claim = await run("claim", job.id, "fixture-consumer");
    const leaseFile = join(directory, "host-bridge-leases", job.id + ".json");
    const lease = JSON.parse(readFileSync(leaseFile, "utf8"));
    // Windows has no POSIX permission bits and reports 0o666 for every file.
    if (process.platform !== "win32") assert.equal(statSync(leaseFile).mode & 0o777, 0o600);
    assert.equal(claim.stdout.includes(lease.leaseToken), false);
    await assert.rejects(run("claim", job.id, "fixture-consumer"));
    await run("start", job.id);
    await assert.rejects(run("start", job.id));
    const resultFile = join(directory, "fixture-result.json");
    writeFileSync(resultFile, JSON.stringify({ hostTaskId: "fixture-host", toolNames: ["mcp__codex_app__list_threads"], observedAt: new Date().toISOString(), tasks: [{ id: "fixture-task", title: "HTN fixture", status: "idle" }] }));
    const first = JSON.parse((await run("complete", job.id, resultFile)).stdout);
    const again = JSON.parse((await run("complete", job.id, resultFile)).stdout);
    assert.equal(first.job.status, "completed");
    assert.equal(again.job.completedAt, first.job.completedAt);
    assert.equal(JSON.stringify(again).includes(lease.leaseToken), false);
    assert.equal(Object.keys(app.store.state.tasks).length, 0, "helper never invokes a standalone model or host tool");
    writeFileSync(resultFile, JSON.stringify({ ...first.job.result, tasks: [] }));
    await assert.rejects(run("complete", job.id, resultFile));
    const browserResponse = await fetch(origin + "/v1/host-bridge/jobs", { method: "POST", headers: { Authorization: `Bearer ${config.clientToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "helper-browser-fixture", probeId: "PHW-0919-CHROME", action: "mac-chrome-typing-proof" }) });
    const browserJob = (await browserResponse.json()).job;
    const browserClaim = JSON.parse((await run("claim", browserJob.id, "fixture-consumer")).stdout);
    assert.equal(browserClaim.job.browserRequest.url, "https://www.google.com/");
    await run("start", browserJob.id);
    writeFileSync(resultFile, JSON.stringify({ hostTaskId: "fixture-host", toolNames: ["mcp__cua_repl.js"], observedAt: new Date().toISOString(), browser: {
      deviceId: "mac", url: "https://www.google.com/", field: "Search", expectedText: browserJob.browserRequest.text, observedText: browserJob.browserRequest.text, submitted: false, evidence: "accessibility",
    } }));
    const browserDone = JSON.parse((await run("complete", browserJob.id, resultFile)).stdout);
    assert.equal(browserDone.job.status, "completed");
    assert.equal(browserDone.job.result.browser.observedText, browserJob.browserRequest.text);
    assert.equal(Object.keys(app.store.state.tasks).length, 0);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});
