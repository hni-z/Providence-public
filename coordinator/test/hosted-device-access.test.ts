import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createHostedServer } from "../src/hosted/server.js";

const origin = "https://providence.example", key = "sk-" + "synthetic".repeat(8);
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "providence-remove-access-"));
  const app = createHostedServer({ directory, origin, encryptionKey: randomBytes(32), validateApiKey: async () => assert.fail("No provider requests in this test") });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const port = (app.server.address() as { port: number }).port, base = `http://127.0.0.1:${port}`;
  const a = app.accounts.create("A"), b = app.accounts.create("B");
  app.accounts.setKey(a.id, key); app.accounts.setKey(b.id, key);
  const owner = (account: string) => ({ Origin: origin, Cookie: `__Host-providence=${app.accounts.session(account)}` });
  const send = async (path: string, method: string, headers: Record<string, string> = {}, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const enroll = async (account: string, name: string) => {
    const start = app.setup.start(); app.setup.approve(start.userCode, account);
    const grant = app.setup.poll(start.deviceCode); assert.equal(grant.status, "approved");
    if (grant.status !== "approved") throw new Error();
    const settings = { name, workspace: "/home/developer/work", workerAccess: "workspace" };
    const device = await app.setup.connect(grant.setupToken, settings);
    return { ...device, grant: grant.setupToken, settings };
  };
  const sockets: WebSocket[] = [];
  const connect = async (device: { deviceId: string; token: string }) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/worker?deviceId=${device.deviceId}`, { headers: { Authorization: `Bearer ${device.token}` } });
    sockets.push(ws); ws.on("error", () => {}); await once(ws, "open");
    const ready = once(ws, "message"); ws.send(JSON.stringify({ kind: "ready", capabilities: { readyAck: true } }));
    assert.equal(JSON.parse(String((await ready)[0])).kind, "ready_ack"); return ws;
  };
  const rejectedReconnect = (device: { deviceId: string; token: string }) => new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/worker?deviceId=${device.deviceId}`, { headers: { Authorization: `Bearer ${device.token}` } });
    sockets.push(ws); ws.on("error", () => {});
    ws.on("unexpected-response", (_request, response) => { resolve(response.statusCode!); response.destroy(); ws.terminate(); });
    ws.on("open", () => reject(new Error("Revoked credential reconnected")));
  });
  t.after(async () => { for (const socket of sockets) socket.terminate(); await app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { app, a, b, owner, send, enroll, connect, rejectedReconnect };
}

test("owner removal is account-bound, fences pending work, rejects old tokens and preserves other devices/key/history", async t => {
  const f = await fixture(t), removed = await f.enroll(f.a.id, "First laptop"), kept = await f.enroll(f.a.id, "Second laptop"), other = await f.enroll(f.b.id, "Other account");
  const socket = await f.connect(removed), keptSocket = await f.connect(kept);
  const workspace = await f.app.workspaces.get(f.a.id);
  const chat = workspace.app.store.addChat("Keep history", removed.deviceId, "fixture-thread");
  chat.history.push({ role: "user", text: "History remains", taskId: "historical-fixture" });
  const task = workspace.app.store.createTask("fixture-task", chat.id, removed.deviceId, "Fixture work").task;
  workspace.app.store.update(task.id, { status: "running" });
  const beforeB = (await f.app.workspaces.get(f.b.id)).app.config.devices;
  assert.equal((await f.send(`/auth/devices/${removed.deviceId}`, "DELETE", f.owner(f.b.id))).status, 404);
  assert.equal((await f.send(`/auth/devices/${removed.deviceId}`, "DELETE")).status, 403);
  assert.equal((await f.send(`/v1/devices/${removed.deviceId}`, "DELETE", { Authorization: `Bearer ${f.app.accounts.session(f.a.id, "client")}`, Origin: origin })).status, 403);
  const received = once(socket, "message");
  const pending = assert.rejects(workspace.app.devices.call(removed.deviceId, "session.list"), /disconnected/);
  await received;
  const closed = once(socket, "close");
  const result = await f.send(`/auth/devices/${removed.deviceId}`, "DELETE", f.owner(f.a.id));
  assert.deepEqual(result, { status: 200, body: { revoked: true, deviceId: removed.deviceId } });
  await pending; assert.equal((await closed)[0], 1008);
  assert.equal(workspace.app.store.state.tasks[task.id].status, "interrupted");
  assert.deepEqual(chat.history, [{ role: "user", text: "History remains", taskId: "historical-fixture" }]);
  assert.equal(workspace.app.devices.online(kept.deviceId), true); assert.equal(keptSocket.readyState, WebSocket.OPEN);
  assert.equal(f.app.accounts.readKey(f.a.id), key);
  assert.deepEqual((await f.app.workspaces.get(f.b.id)).app.config.devices, beforeB);
  assert.ok(beforeB.some(device => device.id === other.deviceId));
  assert.equal(f.app.accounts.db.prepare("SELECT account FROM devices WHERE id=?").get(removed.deviceId), undefined);
  assert.equal(await f.rejectedReconnect(removed), 401);
  await assert.rejects(f.app.setup.connect(removed.grant, removed.settings), /revoked/);
  const saved = readFileSync(join(workspace.app.directory, "config.json"), "utf8");
  assert.ok(!saved.includes(removed.token)); assert.ok(saved.includes(kept.token));
  const receipts = JSON.stringify(f.app.accounts.db.prepare("SELECT * FROM revoked_devices").all());
  assert.ok(!receipts.includes(removed.token));
  assert.equal((await f.send(`/v1/devices/${removed.deviceId}`, "DELETE", f.owner(f.a.id))).status, 200);
});

test("local self-removal accepts only the exact device token and an idempotent hashed receipt", async t => {
  const f = await fixture(t), a = await f.enroll(f.a.id, "A laptop"), b = await f.enroll(f.b.id, "B laptop");
  const self = (deviceId: string, token: string, extra: Record<string, string> = {}) => f.send("/device/revoke", "POST", { Authorization: `Bearer ${token}`, ...extra }, { deviceId });
  assert.equal((await self(a.deviceId, b.token)).status, 401);
  assert.equal((await self(a.deviceId, a.token, { Origin: origin })).status, 403);
  assert.equal((await self(a.deviceId, a.token, { Cookie: "unrelated=value" })).status, 403);
  assert.equal((await self(b.deviceId, a.token)).status, 401);
  assert.equal((await self(a.deviceId, a.token)).status, 200);
  assert.equal((await self(a.deviceId, a.token)).status, 200);
  assert.equal((await self(a.deviceId, b.token)).status, 401);
  assert.equal(await f.rejectedReconnect(a), 401);
  assert.equal(f.app.accounts.readKey(f.a.id), key);
  assert.ok((await f.app.workspaces.get(f.b.id)).app.config.devices.some(device => device.id === b.deviceId));
});

test("device access can still be removed after the shared key has been removed", async t => {
  const f = await fixture(t), device = await f.enroll(f.a.id, "Offline laptop"), other = await f.enroll(f.b.id, "Unaffected laptop");
  await f.app.workspaces.disable(f.a.id);
  f.app.accounts.db.prepare("UPDATE accounts SET key=NULL WHERE id=?").run(f.a.id);
  assert.equal((await f.send(`/auth/devices/${device.deviceId}`, "DELETE", f.owner(f.a.id))).status, 200);
  assert.equal(f.app.accounts.get(f.a.id)?.key, null);
  assert.deepEqual(await f.app.workspaces.inspectDevices(f.a.id), []);
  assert.ok((await f.app.workspaces.get(f.b.id)).app.config.devices.some(value => value.id === other.deviceId));
});
