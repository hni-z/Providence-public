import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";

const origin = "https://providence.example";
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "providence-auth-limits-"));
  const app = createHostedServer({ directory, origin, encryptionKey: randomBytes(32), validateApiKey: async () => assert.fail("Rate-limit tests must not contact a provider") });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const account = app.accounts.create("Private account name");
  const owner = { Cookie: `__Host-providence=${app.accounts.session(account.id)}`, Origin: origin };
  const send = async (path: string, headers: Record<string, string> = {}, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(base + path, { method, headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { app, account, owner, send };
}

test("authenticated refresh and activity calls neither consume nor depend on the peer's passkey attempt budget", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 60; i++) {
    const response = i % 3 === 0 ? await f.send("/auth/session", f.owner)
      : i % 3 === 1 ? await f.send("/auth/devices", f.owner)
      : await f.send("/auth/activity", f.owner, { clientId: "fixture-account-tab", active: false });
    assert.equal(response.status, 200);
  }
  const attempts = [
    { path: "/auth/login/options", body: {}, status: 200 },
    { path: "/auth/login/verify", body: {}, status: 400 },
    { path: "/auth/registration/options", body: { name: "Fixture newcomer" }, status: 200 },
    { path: "/auth/registration/verify", body: {}, status: 400 },
  ];
  for (let i = 0; i < 40; i++) {
    const attempt = attempts[i % attempts.length];
    assert.equal((await f.send(attempt.path, { Origin: origin }, attempt.body)).status, attempt.status);
  }
  for (const attempt of attempts) {
    const refused = await f.send(attempt.path, { Origin: origin }, attempt.body);
    assert.equal(refused.status, 429); assert.deepEqual(refused.body, { error: "Too many sign-in requests; wait a minute" });
  }
  assert.equal((await f.send("/auth/session", f.owner)).status, 200);
  assert.equal((await f.send("/auth/devices", f.owner)).status, 200);
  assert.equal((await f.send("/auth/activity", f.owner, { clientId: "fixture-account-tab", active: false })).status, 200);
});

test("protected auth routes still reject anonymous, forged and cross-origin access without account details", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 45; i++) {
    const denied = await f.send("/auth/devices"); assert.equal(denied.status, 401);
    assert.equal(JSON.stringify(denied.body).includes(f.account.name), false);
  }
  assert.equal((await f.send("/auth/activity", { Origin: origin }, { clientId: "fixture-unknown-tab", active: false })).status, 401);
  assert.equal((await f.send("/auth/activity", {}, { clientId: "fixture-unknown-tab", active: false })).status, 403);
  assert.equal((await f.send("/auth/devices", { ...f.owner, Origin: "https://outside.example" })).status, 403);
  assert.equal((await f.send("/auth/devices", { Cookie: "__Host-providence=" + "invalid".repeat(8) })).status, 401);
  const session = await f.send("/auth/session");
  assert.deepEqual(session, { status: 200, body: { hosted: true, authenticated: false } });
  // Unauthenticated protected reads did not exhaust the separate attempt budget.
  assert.equal((await f.send("/auth/login/options", { Origin: origin }, {})).status, 200);
  for (const path of ["/auth/login/options/extra", "/auth/registration/options-extra"])
    assert.equal((await f.send(path, { Origin: origin }, {})).status, 404);
});

test("the unchanged 900-request account budget spans sessions and stays isolated between accounts", async t => {
  const f = await fixture(t);
  const secondSession = `__Host-providence=${f.app.accounts.session(f.account.id)}`;
  const neighbor = f.app.accounts.create("Separate account");
  const neighborCookie = `__Host-providence=${f.app.accounts.session(neighbor.id)}`;
  const handle = f.app.server.listeners("request")[0] as (request: IncomingMessage, response: ServerResponse) => Promise<unknown>;
  // Exercise the real request handler without 900 sockets or workspace startups.
  const invoke = async (cookie: string) => {
    let status = 0, text = "";
    const request = { method: "GET", url: "/auth/session", headers: { cookie }, socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage;
    const response = { setHeader() {}, writeHead(code: number) { status = code; }, end(value: string) { text = value; } } as unknown as ServerResponse;
    await handle(request, response);
    return { status, body: JSON.parse(text) };
  };
  for (let i = 0; i < 900; i++) assert.equal((await invoke(i % 2 ? f.owner.Cookie : secondSession)).status, 200);
  assert.deepEqual(await invoke(f.owner.Cookie), { status: 429, body: { error: "Too many requests; wait a minute" } });
  assert.equal((await invoke(secondSession)).status, 429);
  assert.equal((await invoke(neighborCookie)).status, 200);
  assert.deepEqual(await invoke("__Host-providence=" + "invalid".repeat(8)), { status: 200, body: { hosted: true, authenticated: false } });
});

test("terminal setup keeps its independent per-peer start limit", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await f.send("/setup/start", {}, {})).status, 200);
  const limited = await f.send("/setup/start", {}, {});
  assert.equal(limited.status, 429); assert.deepEqual(limited.body, { error: "Too many setup attempts; wait a minute" });
  assert.equal((await f.send("/auth/login/options", { Origin: origin }, {})).status, 200);
});
