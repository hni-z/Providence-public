import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClientSessions } from "../src/client-sessions.js";
import { Coordinator } from "../src/coordinator.js";
import { createHttpServer } from "../src/server.js";
const alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const tenMinutes = 10 * 60 * 1000;
const eightHours = 8 * 60 * 60 * 1000;
const twentyFourHours = 24 * 60 * 60 * 1000;
function fixture(t: TestContext, randomIndex?: (max: number) => number) {
  const dir = mkdtempSync(join(tmpdir(), "providence-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = 0;
  const file = join(dir, "clients.json");
  const sessions = new ClientSessions(file, () => now, randomIndex);
  return { sessions, file, clock: () => now, advance: (ms: number) => { now += ms; } };
}
function codesRandom(...codes: string[]) {
  const chars = codes.join("").split("");
  return (max: number) => {
    assert.equal(max, alphabet.length);
    const char = chars.shift();
    assert.ok(char, "unexpected random draw");
    const index = alphabet.indexOf(char);
    assert.ok(index >= 0);
    return index;
  };
}
function distinctRandom() {
  let draws = 0;
  return (max: number) => Math.floor(draws++ / 12) % max;
}
function fail(sessions: ClientSessions, count: number) {
  for (let i = 0; i < count; i++)
    assert.throws(() => sessions.exchange("not a code"), {
      message: "Client code is invalid or expired",
    });
}

test("codes use twelve unbiased alphabet draws, display XXXX-XXXX-XXXX and normalize case, spaces and hyphens", (t) => {
  const { sessions } = fixture(t, codesRandom("2AZ9WX234567", "23456789ABCD", "89ABCDEF2345"));
  const first = sessions.issue("Watch");
  assert.deepEqual(first, { code: "2AZ9-WX23-4567", expiresAt: new Date(tenMinutes).toISOString() });
  assert.match(sessions.exchange(" \t2 a-z\n9-w x 2 3-4 5 6 7 ").token, /^[a-f0-9]{64}$/);
  const second = sessions.issue("Watch 2");
  assert.ok(sessions.exchange(second.code.replace("-", "")));
  assert.ok(sessions.exchange(sessions.issue("Watch 3").code));
  assert.deepEqual(sessions.list().map((s) => s.name), ["Watch", "Watch 2", "Watch 3"]);
});

test("a collision retries without overwriting the original pending code", (t) => {
  const { sessions } = fixture(t, codesRandom("AAAAAAAAAAAA", "AAAAAAAAAAAA", "ZZZZZZZZZZZZ"));
  const first = sessions.issue("Original Watch");
  const second = sessions.issue("Second Watch");
  assert.equal(second.code, "ZZZZ-ZZZZ-ZZZZ");
  const original = sessions.exchange(first.code);
  const other = sessions.exchange(second.code);
  assert.equal(sessions.list().find((s) => s.id === original.clientId)?.name, "Original Watch");
  assert.equal(sessions.list().find((s) => s.id === other.clientId)?.name, "Second Watch");
});

test("collision exhaustion is bounded and leaves the original code redeemable", (t) => {
  let draws = 0;
  const { sessions } = fixture(t, () => { draws++; return 0; });
  const original = sessions.issue("Original");
  assert.throws(() => sessions.issue("Collision"), /unique client code/);
  assert.equal(draws, 12 + 10 * 12);
  assert.ok(sessions.exchange(original.code));
  assert.equal(sessions.list()[0].name, "Original");
});

test("concurrent issuance retains ten distinct codes and rejects excess pending codes", async (t) => {
  const { sessions, advance } = fixture(t, distinctRandom());
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) => Promise.resolve().then(() => sessions.issue(`Watch ${i}`))),
  );
  const issued = results.flatMap((r) => r.status === "fulfilled" ? [r.value] : []);
  assert.equal(issued.length, 10);
  assert.equal(new Set(issued.map((p) => p.code)).size, 10);
  for (const result of results.slice(10)) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.match(result.reason.message, /Too many pending/);
  }
  for (const p of issued) assert.match(p.code, /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
  advance(tenMinutes);
  assert.ok(sessions.issue("After expiry"));
});

test("many wrong codes and replays do not invalidate another live twelve-character code", (t) => {
  const { sessions } = fixture(t, distinctRandom());
  const used = sessions.issue("Used");
  const waiting = sessions.issue("Waiting");
  sessions.exchange(used.code);
  fail(sessions, 25);
  for (let i = 0; i < 25; i++)
    assert.throws(() => sessions.exchange(used.code), /invalid or expired/);
  assert.ok(sessions.exchange(waiting.code));
});

test("new sessions survive eight hours and restart, expire at exactly 24 hours; restart discards codes", (t) => {
  const { sessions, file, advance, clock } = fixture(t);
  const result = sessions.exchange(sessions.issue("Watch").code);
  const pending = sessions.issue("Pending at restart");
  assert.match(result.token, /^[a-f0-9]{64}$/);
  assert.equal(result.expiresAt, new Date(twentyFourHours).toISOString());
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved[0].hash, createHash("sha256").update(result.token).digest("hex"));
  assert.equal(readFileSync(file, "utf8").includes(result.token), false);
  assert.equal(readFileSync(file, "utf8").includes(pending.code), false);
  // Windows has no POSIX permission bits and reports 0o666 for every file.
  if (process.platform !== "win32")
    assert.equal(statSync(file).mode & 0o777, 0o600);
  const restarted = new ClientSessions(file, clock);
  assert.ok(restarted.accepts(`Bearer ${result.token}`));
  assert.throws(() => restarted.exchange(pending.code), /invalid or expired/);
  advance(eightHours);
  assert.ok(sessions.accepts(`Bearer ${result.token}`));
  assert.ok(restarted.accepts(`Bearer ${result.token}`));
  advance(twentyFourHours - eightHours - 1);
  assert.ok(sessions.accepts(`Bearer ${result.token}`));
  assert.ok(restarted.accepts(`Bearer ${result.token}`));
  advance(1);
  assert.equal(sessions.accepts(`Bearer ${result.token}`), false);
  assert.equal(restarted.accepts(`Bearer ${result.token}`), false);
  assert.equal(sessions.list()[0].expired, true);
  for (const auth of [undefined, {}, result.token, `bearer ${result.token}`, "Bearer wrong"])
    assert.equal(sessions.accepts(auth), false);
  restarted.revoke(result.clientId);
  assert.equal(new ClientSessions(file).accepts(`Bearer ${result.token}`), false);
  assert.deepEqual(new ClientSessions(file).list(), []);
  assert.throws(() => restarted.revoke(result.clientId), /Unknown client session/);
});

test("preexisting eight-hour grants keep their saved expiry across issuance, restart and revocation", (t) => {
  const { file, clock, advance } = fixture(t);
  const oldToken = "a".repeat(64);
  const oldGrant = {
    id: "existing-client", name: "Existing Watch",
    hash: createHash("sha256").update(oldToken).digest("hex"),
    createdAt: new Date(0).toISOString(), expiresAt: new Date(eightHours).toISOString(),
  };
  writeFileSync(file, JSON.stringify([oldGrant]), { mode: 0o600 });
  const sessions = new ClientSessions(file, clock);
  const fresh = sessions.exchange(sessions.issue("Fresh Watch").code);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8"))[0], oldGrant);
  const restarted = new ClientSessions(file, clock);
  advance(eightHours - 1);
  assert.ok(restarted.accepts(`Bearer ${oldToken}`));
  advance(1);
  assert.equal(restarted.accepts(`Bearer ${oldToken}`), false);
  assert.ok(restarted.accepts(`Bearer ${fresh.token}`));
  restarted.revoke(fresh.clientId);
  const afterRevoke = new ClientSessions(file, clock);
  assert.equal(afterRevoke.accepts(`Bearer ${fresh.token}`), false);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [oldGrant]);
});

test("at most 100 active sessions are retained, with capacity freed by revoke or expiry", (t) => {
  const { sessions, advance } = fixture(t, distinctRandom());
  for (let i = 0; i < 100; i++) sessions.exchange(sessions.issue(`Watch ${i}`).code);
  assert.equal(sessions.list().length, 100);
  const overLimit = sessions.issue("Over limit");
  assert.throws(() => sessions.exchange(overLimit.code), /Too many active client sessions/);
  assert.equal(sessions.list().length, 100);
  sessions.revoke(sessions.list()[0].id);
  sessions.exchange(sessions.issue("After revoke").code);
  assert.equal(sessions.list().length, 100);
  advance(twentyFourHours);
  sessions.exchange(sessions.issue("After expiry").code);
  assert.equal(sessions.list().length, 1);
});

test("one-use client login issues separate expiring access, stores no raw token, survives restart and revokes", () => {
  const d = mkdtempSync(join(tmpdir(), "providence-client-"));
  try {
    let now = 0;
    const f = join(d, "clients.json");
    const sessions = new ClientSessions(f, () => now);
    const pair = sessions.issue("Windows browser");
    const result = sessions.exchange(pair.code.match(/.{1,4}/g)!.join(" "));
    assert.throws(() => sessions.exchange(pair.code), /invalid or expired/);
    assert.equal(sessions.accepts("Bearer " + result.token), true);
    assert.equal(sessions.accepts("Bearer wrong"), false);
    assert.equal(readFileSync(f, "utf8").includes(result.token), false);
    const after = new ClientSessions(f, () => now);
    assert.equal(after.accepts("Bearer " + result.token), true);
    assert.equal(JSON.stringify(after.list()).includes("hash"), false);
    after.revoke(result.clientId);
    assert.equal(after.accepts("Bearer " + result.token), false);
    const second = after.exchange(after.issue("phone").code);
    now = 24 * 60 * 60 * 1000;
    assert.equal(after.accepts("Bearer " + second.token), false);
    const stale = after.issue("stale");
    now += 10 * 60 * 1000;
    assert.throws(() => after.exchange(stale.code), /expired/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

async function httpFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "providence-client-http-"));
  const config = {
    clientToken: "d".repeat(64), localDeviceId: "mac", localDeviceName: "Mac",
    workspace: dir, devices: [],
  };
  const app = new Coordinator(config, dir);
  const server = createHttpServer(app, config.clientToken, { publicOrigin: "https://providence.example" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const owner = { Authorization: `Bearer ${config.clientToken}`, "Content-Type": "application/json" };
  const pair = (path: string, headers: Record<string, string>) =>
    fetch(base + path, { method: "POST", headers, body: JSON.stringify({ name: "Watch" }) });
  const exchange = (path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const login = async () => {
    const issued = await pair("/v1/clients/pair", owner);
    assert.equal(issued.status, 201);
    return exchange("/client/exchange", { code: (await issued.json()).code });
  };
  return { base, owner, pair, exchange, login };
}

test("a client session reads tasks but cannot manage device or client credentials", async (t) => {
  const { base, owner, pair, exchange, login } = await httpFixture(t);
  const session = await (await login()).json();
  const client = { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" };
  const issued = await (await pair("/v1/devices/pair", owner)).json();
  const device = await (await exchange("/pair/exchange", { code: issued.code })).json();
  const remove = (path: string, headers: Record<string, string>) =>
    fetch(base + path, { method: "DELETE", headers });
  assert.equal((await fetch(base + "/v1/tasks", { headers: client })).status, 200);
  assert.equal((await fetch(base + "/v1/clients", { headers: client })).status, 403);
  assert.equal((await pair("/v1/devices/pair", client)).status, 403);
  assert.equal((await pair("/v1/clients/pair", client)).status, 403);
  assert.equal((await remove("/v1/devices/" + device.deviceId, client)).status, 403);
  assert.equal((await remove("/v1/clients/" + session.clientId, client)).status, 403);
  assert.equal((await fetch(base + "/v1/tasks", { headers: owner })).status, 200);
  assert.equal((await pair("/v1/devices/pair", owner)).status, 201);
  assert.equal((await pair("/v1/clients/pair", owner)).status, 201);
  assert.equal((await remove("/v1/devices/" + device.deviceId, owner)).status, 200);
  assert.equal((await remove("/v1/clients/" + session.clientId, owner)).status, 200);
});

test("ten malformed exchange bodies leave a live client code redeemable", async (t) => {
  const { owner, pair, exchange } = await httpFixture(t);
  const live = await (await pair("/v1/clients/pair", owner)).json();
  const bodies: unknown[] = [{}, { code: 42 }, { code: "" }, { code: null }, { code: ["A"] },
    { codes: "ABC-DEF" }, [], "{", "", { code: "X".repeat(51) }];
  for (const body of bodies) {
    const response = await exchange("/client/exchange", body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Client code is invalid or expired" });
  }
  assert.equal((await exchange("/client/exchange", { code: live.code })).status, 200);
});

test("many wrong client codes do not invalidate a live code, and a valid code bypasses a shared-address cooldown", async (t) => {
  const { owner, pair, exchange } = await httpFixture(t);
  const live = await (await pair("/v1/clients/pair", owner)).json();
  for (let i = 0; i < 25; i++)
    assert.equal(
      (await exchange("/client/exchange", { code: `WRO-NG${i}` })).status,
      i < 20 ? 400 : 429,
    );
  assert.equal((await exchange("/client/exchange", { code: live.code })).status, 200);
});
