import { fixtureStepUp } from "./fixtures/step-up.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Accounts } from "../src/hosted/accounts.js";
import { TerminalSetup } from "../src/hosted/terminal-setup.js";
import { createHostedServer } from "../src/hosted/server.js";
import type { Workspaces } from "../src/hosted/workspaces.js";
const key = "sk-" + "synthetic".repeat(8);

test("terminal device secret and comparison code have separate authority, expiry and ownership", async () => {
  let now = 1000;
  const accounts = new Accounts(":memory:", randomBytes(32), () => now);
  const setup = new TerminalSetup(accounts, {} as Workspaces, "https://providence.example", randomBytes(32), async () => true, () => now);
  try {
    const a = accounts.create("A"), b = accounts.create("B"), start = setup.start();
    assert.match(start.deviceCode, /^[\w-]{43}$/); assert.match(start.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.deepEqual(setup.poll(start.deviceCode), { status: "pending" });
    assert.throws(() => setup.poll(start.userCode));
    assert.equal(setup.inspect(start.userCode, a.id).status, "pending");
    assert.ok(!JSON.stringify(setup.inspect(start.userCode, a.id)).includes(start.deviceCode));
    setup.approve(start.userCode, a.id);
    assert.throws(() => setup.approve(start.userCode, b.id));
    assert.throws(() => setup.inspect(start.userCode, b.id));
    const grant = setup.poll(start.deviceCode); assert.equal(grant.status, "approved");
    if (grant.status !== "approved") throw new Error();
    assert.equal(grant.setupToken, (setup.poll(start.deviceCode) as typeof grant).setupToken);
    assert.equal(accounts.authenticate(grant.setupToken), undefined);
    assert.ok(!JSON.stringify(accounts.db.prepare("SELECT * FROM terminal_setups").all()).includes(start.deviceCode));
    assert.ok(!JSON.stringify(accounts.db.prepare("SELECT * FROM terminal_setups").all()).includes(grant.setupToken));
    now += 601_000; assert.throws(() => setup.poll(start.deviceCode));
    await assert.rejects(() => setup.setKey(grant.setupToken, key));
  } finally { accounts.close(); }
});

test("denied setup cannot be polled or reassigned", () => {
  const accounts = new Accounts(":memory:", randomBytes(32));
  const setup = new TerminalSetup(accounts, {} as Workspaces, "https://providence.example", randomBytes(32), async () => true);
  try { const a = accounts.create("A"), pending = setup.start(); setup.deny(pending.userCode, a.id);
    assert.throws(() => setup.approve(pending.userCode, a.id)); assert.throws(() => setup.poll(pending.deviceCode));
  } finally { accounts.close(); }
});

test("terminal-only key entry and registration preserve account boundaries and retry identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "providence-terminal-flow-"));
  let validations = 0;
  const origin = "https://providence.example";
  const app = createHostedServer({ directory: dir, origin, encryptionKey: randomBytes(32), validateApiKey: async value => { validations++; return value === key; } });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const send = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  try {
    const a = app.accounts.create("A"), b = app.accounts.create("B");
    const ownerRaw = app.accounts.session(a.id);
    const owner = { Origin: origin, Cookie: `__Host-providence=${ownerRaw}` };
    const browserUpload = await send("/auth/api-key", { apiKey: key }, owner);
    assert.equal(browserUpload.status, 410); assert.equal(app.accounts.get(a.id)?.key, null); assert.equal(validations, 0);
    const start = (await send("/setup/start", {})).body;
    assert.equal((await send("/setup/poll", { deviceCode: start.deviceCode })).status, 202);
    assert.equal((await send("/auth/setup/approve", { code: start.userCode })).status, 403);
    assert.equal((await send("/auth/setup/approve", { code: start.userCode, stepUpToken: fixtureStepUp(app.accounts, ownerRaw, "approve_setup", start.userCode) }, owner)).status, 200);
    const grant = (await send("/setup/poll", { deviceCode: start.deviceCode })).body;
    const terminal = { Authorization: `Bearer ${grant.setupToken}` };
    assert.equal((await send("/setup/api-key", { apiKey: key }, { ...owner, ...terminal })).status, 403);
    assert.equal((await send("/setup/api-key", { apiKey: key }, { Authorization: `Bearer ${app.accounts.session(a.id)}` })).status, 410);
    assert.equal((await send("/setup/api-key", { apiKey: key }, terminal)).status, 200);
    assert.equal((await send("/setup/api-key", { apiKey: key }, terminal)).status, 200);
    assert.equal(validations, 1); assert.equal(app.accounts.get(b.id)?.key, null);
    assert.equal(app.accounts.readKey(a.id), key);
    const params = { name: "My computer", workspace: "/home/developer/ProvidenceWorkspace", workerAccess: "full-access" };
    const connected = await send("/setup/connect", params, terminal); assert.equal(connected.status, 200);
    const repeated = await send("/setup/connect", params, terminal); assert.deepEqual(repeated, connected);
    assert.equal((await send("/setup/connect", { ...params, name: "Another computer" }, terminal)).status, 409);
    assert.equal((await send("/setup/api-key", { apiKey: key }, terminal)).status, 409);
    assert.equal(app.accounts.db.prepare("SELECT count(*) AS n FROM devices").get()!.n, 1);
    const workspace = await app.workspaces.get(a.id); assert.equal(workspace.app.config.devices.length, 1);
    assert.equal((await fetch(base + "/v1/devices", { headers: terminal })).status, 401);
    assert.equal(connected.body.url, "wss://providence.example/worker");
    const savedDevices = [...workspace.app.config.devices];
    workspace.app.config.devices = [];
    assert.equal((await send("/setup/connect", params, terminal)).status, 410);
    workspace.app.config.devices = savedDevices;
    const removal = await fetch(base + "/auth/api-key", { method: "DELETE", headers: owner });
    assert.equal(removal.status, 202);
    assert.deepEqual(await removal.json(), { ok: true, keyRemoved: true, workStopping: true, providerKeyRevoked: false });
    const list = await fetch(base + "/auth/devices", { headers: owner });
    assert.equal(list.status, 200);
    const listing = await list.json() as any;
    assert.equal(listing.devices.length, 1); assert.equal(listing.devices[0].online, false);
    assert.equal(JSON.stringify(listing).includes(connected.body.token), false);
    assert.equal(JSON.stringify(listing).includes(key), false);
    assert.equal((await fetch(base + "/auth/devices", { headers: terminal })).status, 401);


  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("setup download routes expose only the manifest and fixed versioned archive names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "providence-install-files-"));
  const version = "a".repeat(64); mkdirSync(join(dir, "downloads", version), { recursive: true });
  writeFileSync(join(dir, "downloads", "companion-manifest.json"), '{"schemaVersion":1}');
  writeFileSync(join(dir, "downloads", version, "providence-companion.zip"), "test zip");
  writeFileSync(join(dir, "accounts-backup"), "private");
  const app = createHostedServer({ directory: dir, origin: "https://providence.example", encryptionKey: randomBytes(32) });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening"); const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  try {
    assert.equal((await fetch(base + "/downloads/companion-manifest.json")).status, 200);
    const archive = await fetch(base + `/downloads/${version}/providence-companion.zip`);
    assert.equal(archive.status, 200); assert.match(archive.headers.get("cache-control")!, /immutable/);
    for (const path of ["/downloads/accounts.sqlite", "/downloads/../accounts-backup", `/downloads/${version}/config.json`, "/downloads/%2e%2e%2faccounts-backup"])
      assert.equal((await fetch(base + path)).status, 404);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
