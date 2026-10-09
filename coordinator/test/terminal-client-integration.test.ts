import { fixtureStepUp } from "./fixtures/step-up.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
// @ts-expect-error The distributable installer deliberately uses dependency-free Node ESM.
import { authorize, ORIGIN, post, runSetup } from "../scripts/connect-helpers.mjs";

const fixtureKey = "sk-integration-fixture-" + "synthetic".repeat(6);
type Result = { status: number; data: Record<string, unknown> };
type RequestOptions = { token?: string; retryAfterMs?: number };
type SetupRequest = (path: string, body: unknown, options?: RequestOptions) => Promise<Result>;

for (const confirmAccount of [true, false]) test(`terminal client and hosted server integrate with account confirmation ${confirmAccount ? "accepted" : "declined"}`, async t => {
  const directory = mkdtempSync(join(tmpdir(), "providence-terminal-integration-"));
  const terminalHome = join(directory, "terminal-home"); mkdirSync(terminalHome);
  const output: string[] = [], browserUrls: string[] = [], stages: string[] = [];
  let validations = 0, launches = 0, identityConfirmed = false, connects = 0, lostConnectResponse = false;
  const realFetch = globalThis.fetch;
  // All network access in this test is loopback, including accidental provider calls.
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(url.hostname, "127.0.0.1", "This integration test must never contact an external provider");
    return realFetch(input, init);
  });
  const app = createHostedServer({ directory: join(directory, "hosted"), origin: ORIGIN, encryptionKey: randomBytes(32), validateApiKey: async key => {
    assert.equal(launches, 0); assert.equal(identityConfirmed, true); assert.equal(key, fixtureKey);
    stages.push("validated"); validations++; return true;
  } });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const localBase = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const account = app.accounts.create("Integration fixture account");
  const otherAccount = app.accounts.create("Other fixture account");
  const ownerSession = app.accounts.session(account.id);
  const log = (line: string) => { output.push(line); assert.ok(!line.includes(fixtureKey)); };
  const request: SetupRequest = (path, body, options = {}) => post(path, body, {
    ...options, sleep: async (ms: number) => assert.ok(ms >= 3000),
    fetcher: async (canonical: string, init: RequestInit) => {
      const address = new URL(canonical); assert.equal(address.origin, ORIGIN);
      assert.match(address.pathname, /^\/setup\/(?:start|poll|api-key|connect)$/);
      assert.equal(address.search, ""); assert.ok(!canonical.includes(fixtureKey));
      const headers = new Headers(init.headers);
      assert.equal(headers.has("cookie"), false); assert.equal(headers.has("origin"), false);
      if (path === "/setup/api-key") { assert.equal(identityConfirmed, true); stages.push("key-upload"); }
      if (path === "/setup/connect") {
        assert.equal(app.accounts.readKey(account.id), fixtureKey);
        assert.equal(validations, 1); assert.equal(launches, 0); connects++; stages.push("register");
      }
      // Only this test transport rewrites the canonical URL to the local server.
      const response = await fetch(localBase + address.pathname, init);
      if (path === "/setup/connect" && !lostConnectResponse) {
        assert.equal(response.status, 200); await response.arrayBuffer();
        lostConnectResponse = true; throw new Error("Simulated lost registration acknowledgement");
      }
      return response;
    },
  });
  const authorizeSetup = ({ request: realRequest, log: realLog }: { request: SetupRequest; log: (line: string) => void }) => authorize({
    request: realRequest, log: realLog, sleep: async (ms: number) => assert.equal(ms, 3000),
    open: async (url: string) => {
      browserUrls.push(url); assert.ok(!url.includes(fixtureKey));
      const address = new URL(url); assert.equal(address.origin, ORIGIN); assert.equal(address.pathname, "/account");
      const code = address.searchParams.get("setup"); assert.match(code!, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      assert.equal([...address.searchParams.keys()].join(","), "setup");
      const approval = await fetch(localBase + "/auth/setup/approve", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: `__Host-providence=${ownerSession}` },
        body: JSON.stringify({ code, stepUpToken: fixtureStepUp(app.accounts, ownerSession, "approve_setup", code!) }),
      });
      assert.equal(approval.status, 200); stages.push("browser-approved"); return true;
    },
  });
  const ask = async (prompt: string) => {
    if (prompt.startsWith("Name this computer")) return "";
    if (prompt.startsWith("Starting folder")) return "";
    if (prompt.startsWith("Connect this computer with full access")) return "yes";
    if (prompt.startsWith("Keep this computer awake")) return "yes";
    assert.match(prompt, /intended Providence account/);
    assert.ok(output.some(line => line === `Approved Providence account: ${account.name}`));
    assert.equal(app.accounts.get(account.id)?.key, null);
    assert.equal(app.accounts.db.prepare("SELECT count(*) AS n FROM devices").get()!.n, 0);
    identityConfirmed = confirmAccount; stages.push("identity-confirmed");
    return confirmAccount ? "yes" : "no";
  };
  const options = {
    args: ["--full-access"], home: terminalHome, name: "Fixture computer", log, ask, request, authorizeSetup,
    checkLogin: async () => { stages.push("local-login-checked"); },
    configureBackground: async () => ({ foreground: true, installed: false }),
    secret: async () => { assert.equal(identityConfirmed, true); assert.equal(launches, 0); return fixtureKey; },
    launch: async (file: string) => {
      assert.equal(app.accounts.readKey(account.id), fixtureKey); assert.equal(validations, 1);
      const text = readFileSync(file, "utf8"); assert.ok(!text.includes(fixtureKey));
      const config = JSON.parse(text);
      assert.equal(config.workerAccess, "full-access"); assert.equal(config.url, "wss://providence.hani.so/worker");
      assert.match(config.deviceId, /^device-/); assert.match(config.token, /^[a-f0-9]{64}$/);
      assert.equal(app.accounts.db.prepare("SELECT count(*) AS n FROM devices").get()!.n, 1);
      stages.push("launched"); launches++; return 0;
    },
  };
  try {
    if (!confirmAccount) {
      await assert.rejects(runSetup(options), /cancelled before API-key changes/);
      assert.equal(validations, 0); assert.equal(launches, 0); assert.equal(connects, 0);
      assert.equal(app.accounts.get(account.id)?.key, null);
      assert.equal(app.accounts.db.prepare("SELECT count(*) AS n FROM devices").get()!.n, 0);
      assert.equal(existsSync(join(terminalHome, ".providence", "companion", "device.json")), false);
    } else {
      await runSetup(options);
      assert.equal(validations, 1); assert.equal(connects, 2); assert.equal(launches, 1);
      assert.ok(stages.indexOf("identity-confirmed") < stages.indexOf("key-upload"));
      assert.ok(stages.indexOf("validated") < stages.indexOf("register"));
      assert.ok(stages.indexOf("register") < stages.indexOf("launched"));
      const configFile = join(terminalHome, ".providence", "companion", "device.json");
      const saved = readFileSync(configFile, "utf8");
      assert.notEqual(app.accounts.get(account.id)?.key, fixtureKey);
      assert.equal(app.accounts.get(otherAccount.id)?.key, null);
      assert.equal((await app.workspaces.get(account.id)).app.config.devices.length, 1);
      const unexpected = async () => assert.fail("An existing device must resume without enrollment, sign-in approval, or a key prompt");
      await runSetup({ ...options, ask: unexpected, authorizeSetup: unexpected, request: unexpected, secret: unexpected });
      assert.equal(launches, 2); assert.equal(connects, 2); assert.equal(validations, 1);
      assert.equal(readFileSync(configFile, "utf8"), saved);
      assert.equal(app.accounts.db.prepare("SELECT count(*) AS n FROM devices").get()!.n, 1);
    }
    assert.equal(browserUrls.length, 1);
    assert.ok(!output.join("\n").includes(fixtureKey)); assert.ok(!browserUrls.join("\n").includes(fixtureKey));
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
