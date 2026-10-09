import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, generateKeyPairSync, createHash, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { encodeCBOR } from "@levischuck/tiny-cbor";
import { Accounts, digest } from "../src/hosted/accounts.js";
import { createHostedServer } from "../src/hosted/server.js";
import { ClientSessions } from "../src/client-sessions.js";
import { loadConfig } from "../src/config.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const origin = "https://providence.example";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest();
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_accept, reject) => {
      timer = setTimeout(() => reject(new Error(`Local fixture did not settle: ${label}`)), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function authenticator() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), jwk = pair.publicKey.export({ format: "jwk" });
  const credentialID = randomBytes(32), id = credentialID.toString("base64url"); let counter = 0;
  const publicKey = encodeCBOR(new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))], [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))]]));
  return { id, publicKey,
    register(challenge: string) {
      const client = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
      const length = Buffer.alloc(2); length.writeUInt16BE(credentialID.length);
      const authData = Buffer.concat([hash(new URL(origin).hostname), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length, credentialID, publicKey]);
      const attestation = encodeCBOR(new Map<string, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(authData)]]));
      return { id, rawId: id, type: "public-key", response: { clientDataJSON: client.toString("base64url"), attestationObject: Buffer.from(attestation).toString("base64url"), transports: ["internal"] }, clientExtensionResults: {} };
    },
    assert(challenge: string, verified = true) {
      const client = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
      const count = Buffer.alloc(4); count.writeUInt32BE(++counter);
      const authData = Buffer.concat([hash(new URL(origin).hostname), Buffer.from([verified ? 5 : 1]), count]);
      return { id, rawId: id, type: "public-key", response: { clientDataJSON: client.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: sign("sha256", Buffer.concat([authData, hash(client)]), pair.privateKey).toString("base64url") }, clientExtensionResults: {} };
    },
  };
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "providence-step-up-"));
  const app = createHostedServer({ directory, origin, encryptionKey: randomBytes(32), validateApiKey: async () => assert.fail("No provider call is permitted") });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const jar = new Map<string, string>();
  const send = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST", headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, { method, headers: { Origin: origin, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const cookie of response.headers.getSetCookie()) { const [key, value] = cookie.split(";")[0].split("="); jar.set(key, value); }
    return { status: response.status, body: await response.json() as any, headers: response.headers };
  };
  const owner = authenticator();
  const options = await send("/auth/registration/options", { name: "Synthetic owner" });
  assert.equal((await send("/auth/registration/verify", owner.register(options.body.challenge))).status, 200);
  const raw = jar.get("__Host-providence")!, account = app.accounts.authenticate(raw)!.account;
  const proof = async (action: string, target?: string, key = owner) => {
    const options = await send("/auth/step-up/options", { action, target }); assert.equal(options.status, 200);
    const result = await send("/auth/step-up/verify", { response: key.assert(options.body.challenge) }); assert.equal(result.status, 200);
    return result.body.stepUpToken as string;
  };
  return { app, account, raw, owner, jar, send, proof, base, directory,
    close: async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("legacy account databases migrate without invalidating sessions or exposing their bearer hashes", () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-session-migrate-")), file = join(directory, "accounts.sqlite"), key = randomBytes(32);
  const old = new DatabaseSync(file), raw = randomBytes(32).toString("base64url");
  old.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL,created INTEGER NOT NULL,key TEXT); CREATE TABLE sessions(hash TEXT PRIMARY KEY,account TEXT NOT NULL,scope TEXT NOT NULL,expires INTEGER NOT NULL); CREATE TABLE passkeys(id TEXT PRIMARY KEY,account TEXT NOT NULL,publicKey TEXT NOT NULL,counter INTEGER NOT NULL,transports TEXT NOT NULL)");
  old.prepare("INSERT INTO accounts VALUES('account','Owner',1,NULL)").run();
  old.prepare("INSERT INTO sessions VALUES(?,'account','owner',999999)").run(digest(raw)); old.close();
  const accounts = new Accounts(file, key, () => 1000);
  try {
    assert.equal(accounts.authenticate(raw)?.account, "account");
    const list = accounts.security("account", raw); assert.match(list.sessions[0].id, /^[0-9a-f-]{36}$/);
    assert.equal(list.sessions[0].createdAt, null); assert.equal(list.sessions[0].current, true);
    assert.ok(!JSON.stringify(list).includes(raw)); assert.ok(!JSON.stringify(list).includes(digest(raw)));
    const id = list.sessions[0].id; accounts.close();
    const reopened = new Accounts(file, key, () => 1000);
    try { assert.equal(reopened.security("account", raw).sessions[0].id, id); } finally { reopened.close(); }
  } finally { try { accounts.close(); } catch {} rmSync(directory, { recursive: true, force: true }); }
});

test("revoking a session closes its active gateway response stream without revoking another session", { timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    f.app.accounts.setKey(f.account, "synthetic-key-no-provider-request");
    const workspace = await f.app.workspaces.get(f.account);
    const original = workspace.server.listeners("request")[0] as (req: IncomingMessage, res: ServerResponse) => unknown;
    workspace.server.removeAllListeners("request");
    workspace.server.on("request", (req, res) => {
      if (req.url === "/v1/fixture-stream") { res.writeHead(200, { "Content-Type": "text/plain" }); res.write("first"); }
      else void original(req, res);
    });
    const other = f.app.accounts.session(f.account);
    const id = f.app.accounts.security(f.account, other).sessions.find(value => value.current)!.id;
    const response = await fetch(f.base + "/v1/fixture-stream", { headers: { Cookie: `__Host-providence=${other}` } });
    const reader = response.body!.getReader(); await reader.read(); const pending = assert.rejects(reader.read());
    const revoked = await f.send(`/auth/sessions/${id}`, undefined, "DELETE"); assert.equal(revoked.status, 200);
    await bounded(pending, "revoked response stream"); reader.releaseLock();
    assert.equal((await f.send("/auth/devices", undefined, "GET", { Cookie: `__Host-providence=${other}` })).status, 401);
    assert.equal((await f.send("/auth/devices")).status, 200);
  } finally { await f.close(); }
});

test("logout everywhere fences pairing-code creation that was already waiting for its tenant response", async () => {
  const f = await fixture(), nativeFetch = globalThis.fetch;
  let release!: () => void;
  try {
    f.app.accounts.setKey(f.account, "synthetic-key-no-provider-request");
    const workspace = await f.app.workspaces.get(f.account);
    const endpoint = `http://127.0.0.1:${workspace.port}/v1/clients/pair`;
    let reached!: () => void, mintedCode = "";
    const entered = new Promise<void>(accept => { reached = accept; }), held = new Promise<void>(accept => { release = accept; });
    globalThis.fetch = async (input, init) => {
      const response = await nativeFetch(input, init);
      if (String(input) !== endpoint) return response;
      const body = await response.text(); mintedCode = JSON.parse(body).code; reached(); await held;
      return new Response(body, { status: response.status, headers: response.headers });
    };
    const token = await f.proof("pair_client", "Watch");
    const pairing = f.send("/v1/clients/pair", { name: "Watch", stepUpToken: token }); void pairing.catch(() => {});
    await bounded(entered, "tenant pairing issuance");
    assert.equal((await f.send("/auth/sessions/revoke-all", {})).status, 202);
    release(); const result = await bounded(pairing, "revoked pairing result");
    assert.equal(result.status, 401); assert.equal(result.body.code, undefined);
    assert.throws(() => f.app.accounts.consumeCode(mintedCode, "client"));
    assert.equal(f.app.accounts.authenticate(f.raw), undefined);
  } finally { release?.(); globalThis.fetch = nativeFetch; await f.close(); }
});

test("logout everywhere discards and cleans credentials minted by a pending device or controller exchange", async () => {
  for (const kind of ["device", "client"]) {
    const f = await fixture(), nativeFetch = globalThis.fetch; let release!: () => void;
    try {
      f.app.accounts.setKey(f.account, "synthetic-key-no-provider-request");
      const workspace = await f.app.workspaces.get(f.account);
      const path = kind === "device" ? "/pair/exchange" : "/client/exchange";
      const issue = await f.send(kind === "device" ? "/v1/devices/pair" : "/v1/clients/pair", {
        name: "Fixture", stepUpToken: await f.proof(kind === "device" ? "pair_device" : "pair_client", "Fixture"),
      }); assert.equal(issue.status, 201);
      let reached!: () => void, minted: any;
      const entered = new Promise<void>(accept => { reached = accept; }), held = new Promise<void>(accept => { release = accept; });
      globalThis.fetch = async (input, init) => {
        const response = await nativeFetch(input, init);
        if (String(input) !== `http://127.0.0.1:${workspace.port}${path}`) return response;
        const body = await response.text(); minted = JSON.parse(body); reached(); await held;
        return new Response(body, { status: response.status, headers: response.headers });
      };
      const exchange = f.send(path, { code: issue.body.code }); void exchange.catch(() => {});
      await bounded(entered, "tenant credential exchange");
      assert.equal((await f.send("/auth/sessions/revoke-all", {})).status, 202);
      release(); const result = await bounded(exchange, "revoked exchange result");
      assert.equal(result.status, 401); assert.equal(result.body.token, undefined);
      assert.equal(f.app.accounts.authenticate(minted.token), undefined);
      if (kind === "device") {
        assert.equal(f.app.accounts.db.prepare("SELECT 1 FROM devices WHERE id=?").get(minted.deviceId), undefined);
        assert.ok(!loadConfig(join(workspace.app.directory, "config.json")).devices.some(device => device.id === minted.deviceId));
      } else {
        const clients = new ClientSessions(join(workspace.app.directory, "client-sessions.json"));
        assert.ok(!clients.list().some(client => client.id === minted.clientId));
      }
    } finally { release?.(); globalThis.fetch = nativeFetch; await f.close(); }
  }
});

test("step-up proofs bind exact account/session/action/target, expire, and are single-use", () => {
  let now = 1000; const accounts = new Accounts(":memory:", randomBytes(32), () => now);
  try {
    const a = accounts.create("A"), b = accounts.create("B"), raw = accounts.session(a.id), otherSession = accounts.session(a.id), otherAccount = accounts.session(b.id);
    accounts.addPasskey(a.id, { id: "existing-key", publicKey: new Uint8Array([0]), counter: 0 });
    const issue = () => accounts.issueStepUp(raw, "existing-key", "approve_setup", "ABCD-EFGH").stepUpToken;
    const good = issue(); assert.ok(!JSON.stringify(accounts.db.prepare("SELECT * FROM step_up_grants").all()).includes(good));
    accounts.consumeStepUp(raw, good, "approve_setup", "abcd efgh");
    assert.throws(() => accounts.consumeStepUp(raw, good, "approve_setup", "ABCD-EFGH"), /existing passkey/);
    for (const [session, action, target] of [[otherSession, "approve_setup", "ABCD-EFGH"], [otherAccount, "approve_setup", "ABCD-EFGH"], [raw, "pair_client", "Watch"], [raw, "approve_setup", "JKLM-NPQR"]]) {
      const proof = issue(); assert.throws(() => accounts.consumeStepUp(session, proof, action, target));
      assert.throws(() => accounts.consumeStepUp(raw, proof, "approve_setup", "ABCD-EFGH"));
    }
    const expired = issue(); now += 300_000; assert.throws(() => accounts.consumeStepUp(raw, expired, "approve_setup", "ABCD-EFGH"));
    const loggedOut = issue(); accounts.logout(raw); assert.throws(() => accounts.consumeStepUp(raw, loggedOut, "approve_setup", "ABCD-EFGH"));
  } finally { accounts.close(); }
});

test("an owner cookie alone cannot add a passkey or approve setup; a verified existing key authorizes only the intended action", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send("/auth/registration/options", { name: "Owner" })).status, 428);
    const setup = f.app.setup.start();
    assert.equal((await f.send("/auth/setup/approve", { code: setup.userCode })).status, 428);
    const proof = await f.proof("approve_setup", setup.userCode);
    assert.equal((await f.send("/auth/setup/approve", { code: setup.userCode, stepUpToken: proof })).status, 200);
    assert.equal((await f.send("/auth/setup/approve", { code: setup.userCode, stepUpToken: proof })).status, 428);
    const added = authenticator(), token = await f.proof("add_passkey");
    const options = await f.send("/auth/registration/options", { name: "Owner", stepUpToken: token }); assert.equal(options.status, 200);
    assert.equal((await f.send("/auth/registration/verify", added.register(options.body.challenge))).status, 200);
    assert.equal(f.app.accounts.security(f.account, f.raw).passkeys.length, 2);
  } finally { await f.close(); }
});

test("step-up assertions reject wrong sessions, unknown keys, missing user verification and replay", async () => {
  const f = await fixture();
  try {
    let options = await f.send("/auth/step-up/options", { action: "add_passkey" });
    const challengeCookie = f.jar.get("__Host-providence-stepup")!;
    const otherRaw = f.app.accounts.session(f.account);
    assert.equal((await f.send("/auth/step-up/verify", { response: f.owner.assert(options.body.challenge) }, "POST", { Cookie: `__Host-providence=${otherRaw}; __Host-providence-stepup=${challengeCookie}` })).status, 428);
    options = await f.send("/auth/step-up/options", { action: "add_passkey" });
    assert.equal((await f.send("/auth/step-up/verify", { response: authenticator().assert(options.body.challenge) })).status, 428);
    options = await f.send("/auth/step-up/options", { action: "add_passkey" });
    assert.equal((await f.send("/auth/step-up/verify", { response: f.owner.assert(options.body.challenge, false) })).status, 400);
    options = await f.send("/auth/step-up/options", { action: "add_passkey" });
    const response = f.owner.assert(options.body.challenge);
    assert.equal((await f.send("/auth/step-up/verify", { response })).status, 200);
    assert.equal((await f.send("/auth/step-up/verify", { response })).status, 400);
    assert.equal((await f.send("/auth/step-up/options", { action: "add_passkey" }, "POST", { Origin: "https://outside.example" })).status, 403);
  } finally { await f.close(); }
});

test("pairing proofs bind device/controller type and exact name while work APIs need no step-up", async () => {
  const f = await fixture();
  try {
    f.app.accounts.setKey(f.account, "synthetic-key-never-sent-to-provider");
    assert.equal((await f.send("/v1/devices/pair", { name: "Desk" })).status, 428);
    const wrong = await f.proof("pair_device", "Desk");
    assert.equal((await f.send("/v1/clients/pair", { name: "Desk", stepUpToken: wrong })).status, 428);
    const token = await f.proof("pair_client", "Watch");
    assert.equal((await f.send("/v1/clients/pair", { name: "Other", stepUpToken: token })).status, 428);
    const good = await f.proof("pair_client", "Watch");
    assert.equal((await f.send("/v1/clients/pair", { name: "Watch", stepUpToken: good })).status, 201);
    assert.equal((await f.send("/v1/devices")).status, 200);
  } finally { await f.close(); }
});

test("additional-passkey registration cannot finish from a different owner session", async () => {
  const f = await fixture();
  try {
    const options = await f.send("/auth/registration/options", { name: "Owner", stepUpToken: await f.proof("add_passkey") });
    const newKey = authenticator(), other = f.app.accounts.session(f.account), challenge = f.jar.get("__Host-providence-challenge");
    assert.equal((await f.send("/auth/registration/verify", newKey.register(options.body.challenge), "POST", { Cookie: `__Host-providence=${other}; __Host-providence-challenge=${challenge}` })).status, 400);
    assert.equal(f.app.accounts.passkey(newKey.id), undefined);
  } finally { await f.close(); }
});

test("passkey removal requires another existing key and revokes other sessions and pending intents", async () => {
  const f = await fixture();
  try {
    const other = authenticator(); f.app.accounts.addPasskey(f.account, { id: other.id, publicKey: other.publicKey, counter: 0 });
    const otherSession = f.app.accounts.session(f.account), client = f.app.accounts.session(f.account, "client");
    const pending = f.app.setup.start(); f.app.setup.approve(pending.userCode, f.account);
    f.app.accounts.code(f.account, "client", "ABCD-EFGH-JKLM");
    const options = await f.send("/auth/step-up/options", { action: "remove_passkey", target: other.id });
    assert.deepEqual(options.body.allowCredentials.map((value: any) => value.id), [f.owner.id]);
    assert.equal((await f.send("/auth/step-up/verify", { response: other.assert(options.body.challenge) })).status, 428);
    const token = await f.proof("remove_passkey", other.id);
    const removed = await f.send(`/auth/passkeys/${other.id}`, { stepUpToken: token }, "DELETE"); assert.equal(removed.status, 200);
    assert.equal(f.app.accounts.passkey(other.id), undefined);
    assert.equal(f.app.accounts.authenticate(otherSession), undefined); assert.equal(f.app.accounts.authenticate(client), undefined);
    assert.ok(f.app.accounts.authenticate(f.raw)); assert.throws(() => f.app.setup.poll(pending.deviceCode));
    assert.throws(() => f.app.accounts.consumeCode("ABCD-EFGH-JKLM", "client"));
    assert.equal((await f.send("/auth/step-up/options", { action: "remove_passkey", target: f.owner.id })).status, 428);
  } finally { await f.close(); }
});

test("opaque session inventory and immediate revocation preserve account boundaries and clear current cookies", async () => {
  const f = await fixture();
  try {
    const other = f.app.accounts.create("Other"), otherRaw = f.app.accounts.session(other.id), client = f.app.accounts.session(f.account, "client");
    const inventory = await f.send("/auth/security"); assert.equal(inventory.status, 200);
    assert.ok(!JSON.stringify(inventory.body).includes(digest(f.raw))); assert.ok(!JSON.stringify(inventory.body).includes(f.raw));
    assert.ok(!JSON.stringify(inventory.body).includes("publicKey"));
    const foreign = f.app.accounts.security(other.id, otherRaw).sessions[0].id;
    assert.equal((await f.send(`/auth/sessions/${foreign}`, undefined, "DELETE")).status, 404);
    const controller = inventory.body.sessions.find((value: any) => value.scope === "client");
    assert.equal((await f.send(`/auth/sessions/${controller.id}`, undefined, "DELETE")).status, 200);
    assert.equal(f.app.accounts.authenticate(client), undefined); assert.ok(f.app.accounts.authenticate(otherRaw));
    const current = inventory.body.sessions.find((value: any) => value.current);
    const removed = await f.send(`/auth/sessions/${current.id}`, undefined, "DELETE"); assert.equal(removed.body.current, true);
    assert.equal(f.jar.get("__Host-providence"), ""); assert.equal(f.jar.get("__Host-providence-challenge"), ""); assert.equal(f.jar.get("__Host-providence-stepup"), "");
    assert.equal((await f.send("/auth/security")).status, 401);
  } finally { await f.close(); }
});

test("owner-bound option generation cannot publish a challenge after its revocation epoch changes", async () => {
  for (const kind of ["step-up", "registration"]) {
    const f = await fixture();
    try {
      const proof = kind === "registration" ? await f.proof("add_passkey") : undefined;
      const epoch = f.app.accounts.revocationEpoch(f.account);
      const invalidate = () => queueMicrotask(() => f.app.accounts.clearSensitiveIntents(f.account));
      if (kind === "step-up") {
        const security = f.app.accounts.security.bind(f.app.accounts);
        f.app.accounts.security = (...args) => { const result = security(...args); invalidate(); return result; };
      } else {
        const consume = f.app.accounts.consumeStepUp.bind(f.app.accounts);
        f.app.accounts.consumeStepUp = (...args) => { const result = consume(...args); invalidate(); return result; };
      }
      const response = await bounded(f.send(`/auth/${kind}/options`, kind === "step-up"
        ? { action: "add_passkey" } : { name: "Owner", stepUpToken: proof }), "options epoch fence");
      assert.equal(response.status, 428);
      assert.equal(response.body.challenge, undefined);
      assert.equal(f.app.accounts.revocationEpoch(f.account), epoch + 1);
      assert.ok(f.app.accounts.authenticate(f.raw), "Passkey removal can retain this session while invalidating its older intents");
    } finally { await f.close(); }
  }
});

test("consumed in-flight assertions and additional-passkey registrations cannot outlive their epoch", async () => {
  for (const kind of ["step-up", "registration"]) {
    const f = await fixture();
    try {
      const added = authenticator();
      const options = await f.send(`/auth/${kind}/options`, kind === "step-up"
        ? { action: "add_passkey" } : { name: "Owner", stepUpToken: await f.proof("add_passkey") });
      assert.equal(options.status, 200);
      const consume = f.app.accounts.consumeChallenge.bind(f.app.accounts);
      f.app.accounts.consumeChallenge = value => {
        const challenge = consume(value);
        // The challenge has already left the database, so deleting stored
        // challenges alone cannot invalidate this request's captured value.
        queueMicrotask(() => f.app.accounts.clearSensitiveIntents(f.account));
        return challenge;
      };
      const response = await bounded(f.send(`/auth/${kind}/verify`, kind === "step-up"
        ? { response: f.owner.assert(options.body.challenge) } : added.register(options.body.challenge)), "verification epoch fence");
      assert.equal(response.status, 428);
      assert.equal(response.body.stepUpToken, undefined);
      assert.equal(f.app.accounts.passkey(added.id), undefined);
      assert.equal(f.app.accounts.db.prepare("SELECT count(*) AS n FROM step_up_grants").get()!.n, 0);
      assert.ok(f.app.accounts.authenticate(f.raw));
    } finally { await f.close(); }
  }
});

test("setup denial and activity recheck the owner after reading a deferred request body", async () => {
  for (const path of ["/auth/setup/deny", "/auth/activity"]) for (const change of ["revoke", "scope"]) {
    const f = await fixture();
    try {
      const setup = f.app.setup.start(); let activityCalls = 0, status = 0, output = "";
      f.app.workspaces.noteActivity = async () => { activityCalls++; };
      const body = path.endsWith("deny") ? { code: setup.userCode } : { clientId: "fixture-tab", active: true };
      const req = { method: "POST", url: path, headers: { origin, cookie: `__Host-providence=${f.raw}` }, socket: { remoteAddress: "127.0.0.1" },
        async *[Symbol.asyncIterator]() {
          if (change === "revoke") f.app.accounts.logout(f.raw);
          else f.app.accounts.db.prepare("UPDATE sessions SET scope='client' WHERE hash=?").run(digest(f.raw));
          yield Buffer.from(JSON.stringify(body));
        },
      } as unknown as IncomingMessage;
      const res = { setHeader() {}, writeHead(value: number) { status = value; }, end(value: string) { output = value; } } as unknown as ServerResponse;
      const handle = f.app.server.listeners("request")[0] as (req: IncomingMessage, res: ServerResponse) => Promise<unknown>;
      await bounded(handle(req, res), "post-body owner fence");
      assert.equal(status, 401); assert.equal(activityCalls, 0);
      assert.deepEqual(f.app.setup.poll(setup.deviceCode), { status: "pending" });
      assert.match(JSON.parse(output).error, /revoked/);
    } finally { await f.close(); }
  }
});

test("device inventory awaiting a workspace cannot return after the owner's session is revoked", async () => {
  const f = await fixture();
  try {
    f.app.workspaces.inspectDevices = async () => { f.app.accounts.logout(f.raw); return [{ id: "private-fixture-device", name: "Private fixture", online: false }]; };
    const response = await bounded(f.send("/auth/devices"), "post-inventory owner fence");
    assert.equal(response.status, 401);
    assert.equal(response.body.devices, undefined);
    assert.ok(!JSON.stringify(response.body).includes("private-fixture-device"));
  } finally { await f.close(); }
});
