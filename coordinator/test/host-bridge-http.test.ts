import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator.js";
import { createHttpServer } from "../src/server.js";

test("website clients may queue/read one fixed job; only the owner and exact claim can report its host result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-host-http-"));
  const config = { clientToken: "o".repeat(64), localDeviceId: "mac", localDeviceName: "Mac", workspace: directory, devices: [] };
  const app = new Coordinator(config, directory);
  const server = createHttpServer(app, config.clientToken, { publicOrigin: "https://providence.example" });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const request = (path: string, token: string | undefined, body?: unknown) => fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    assert.equal((await request("/v1/host-bridge/jobs", undefined)).status, 401);
    const issued = await (await request("/v1/clients/pair", config.clientToken, { name: "Website proof fixture" })).json();
    const client = await (await request("/client/exchange", undefined, { code: issued.code })).json();
    const queued = await request("/v1/host-bridge/jobs", client.token, { requestId: "fixture-request", probeId: "PHW-0919-fixture" });
    assert.equal(queued.status, 202);
    const { job } = await queued.json();
    assert.equal(job.status, "queued");
    assert.equal(job.action, "htn-task-inventory");
    assert.equal(Object.keys(app.store.state.tasks).length, 0, "queueing must not start a standalone Codex turn");
    const repeated = await (await request("/v1/host-bridge/jobs", client.token, { requestId: "fixture-request", probeId: "PHW-0919-fixture" })).json();
    assert.equal(repeated.job.id, job.id);
    const route = `/v1/host-bridge/jobs/${job.id}`;
    assert.equal((await request(`${route}/claim`, client.token, { claimId: "claim", consumerId: "actual-codex-host-fixture" })).status, 403);
    assert.equal((await request("/v1/host-bridge/jobs", client.token, { requestId: "wrong-action", probeId: "PHW-0919-other", action: "control-desktop" })).status, 400);
    const claim = await (await request(`${route}/claim`, config.clientToken, { claimId: "claim", consumerId: "actual-codex-host-fixture" })).json();
    assert.ok(claim.leaseToken?.length >= 32);
    assert.equal((await request(`${route}/claim`, config.clientToken, { claimId: "claim", consumerId: "actual-codex-host-fixture" })).status, 409, "a lost claim reply must not create another runnable claim");
    const publicJob = await (await request(route, client.token)).json();
    const publicList = await (await request("/v1/host-bridge/jobs", client.token)).json();
    assert.equal(JSON.stringify([publicJob, publicList]).includes(claim.leaseToken), false);
    assert.doesNotMatch(JSON.stringify([publicJob, publicList]), /leaseHash|completionHash|claimId/);
    const start = await request(`${route}/start`, config.clientToken, { probeId: job.probeId, leaseToken: claim.leaseToken });
    assert.equal(start.status, 200);
    const complete = { probeId: job.probeId, leaseToken: claim.leaseToken, completionId: "completion", result: {
      hostTaskId: "host-task-fixture", toolNames: ["mcp__codex_app__list_threads"], observedAt: new Date().toISOString(), tasks: [{ id: "htn-fixture", title: "HTN fixture", status: "active" }],
    } };
    assert.equal((await request(`${route}/complete`, client.token, complete)).status, 403);
    assert.notEqual((await request(`${route}/complete`, config.clientToken, { ...complete, probeId: "wrong-probe" })).status, 200);
    assert.equal((await request(`${route}/complete`, config.clientToken, complete)).status, 200);
    assert.equal((await request(`${route}/complete`, config.clientToken, complete)).status, 200, "only the identical completion acknowledgement may be retried");
    assert.equal((await request(`${route}/complete`, config.clientToken, { ...complete, result: { ...complete.result, tasks: [] } })).status, 409);
    const finished = await (await request(route, client.token)).json();
    assert.equal(finished.job.status, "completed");
    assert.deepEqual(finished.job.result, complete.result);
    assert.equal(Object.keys(app.store.state.tasks).length, 0);

    const browserCreate = await request("/v1/host-bridge/jobs", client.token, { requestId: "browser-fixture", probeId: "PHW-0919-BROWSER", action: "mac-chrome-typing-proof" });
    assert.equal(browserCreate.status, 202);
    const browserJob = (await browserCreate.json()).job;
    assert.equal(browserJob.browserRequest.url, "https://www.google.com/");
    assert.equal(browserJob.browserRequest.submit, false);
    const browserRoute = `/v1/host-bridge/jobs/${browserJob.id}`;
    const browserClaim = await (await request(`${browserRoute}/claim`, config.clientToken, { claimId: "browser-claim", consumerId: "actual-codex-host-fixture" })).json();
    const browserLease = { probeId: browserJob.probeId, leaseToken: browserClaim.leaseToken };
    assert.equal((await request(`${browserRoute}/start`, config.clientToken, browserLease)).status, 200);
    const browserResult = { hostTaskId: "host-task-fixture", toolNames: ["mcp__cua_repl.js"], observedAt: new Date().toISOString(), browser: {
      deviceId: "mac", url: "https://www.google.com/", field: "Search", expectedText: browserJob.browserRequest.text, observedText: browserJob.browserRequest.text, submitted: false, evidence: "accessibility",
    } };
    assert.notEqual((await request(`${browserRoute}/complete`, config.clientToken, { ...browserLease, completionId: "wrong-result-kind", result: complete.result })).status, 200);
    assert.notEqual((await request(`${browserRoute}/complete`, config.clientToken, { ...browserLease, completionId: "stale-observation", result: { ...browserResult, browser: { ...browserResult.browser, observedText: "an earlier probe" } } })).status, 200);
    const browserFinish = await request(`${browserRoute}/complete`, config.clientToken, { ...browserLease, completionId: "browser-completion", result: browserResult });
    assert.equal(browserFinish.status, 200);
    assert.equal((await browserFinish.json()).job.result.browser.observedText, browserJob.browserRequest.text);
    assert.equal(Object.keys(app.store.state.tasks).length, 0, "browser jobs also require an actual external host consumer");
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});
