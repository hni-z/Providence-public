import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { Devices, reconnectBudget, registrationEnded } from "../src/devices.js";
import type { Runtime } from "../src/runtime.js";
import { deviceConfigSchema, parseDeviceConfig, prepareWorkspace, runtimeMetadata, workerUrl } from "../src/device-config.js";

test("companion configuration rejects unintended transport and workspace scope", () => {
  const dir = mkdtempSync(join(tmpdir(), "providence-windows-"));
  try {
    assert.equal(workerUrl("wss://example.com/worker").protocol, "wss:");
    assert.equal(workerUrl("ws://127.0.0.1:8787/worker").protocol, "ws:");
    assert.throws(() => workerUrl("ws://example.com/worker"), /wss/);
    assert.throws(() => workerUrl("https://example.com/worker"), /wss/);
    assert.throws(() => workerUrl("wss://secret@example.com/worker"), /credentials/);
    assert.throws(() => workerUrl("wss://example.com/worker?token=secret"), /query/);
    assert.throws(() => workerUrl("wss://example.com/other"), /worker/);
    assert.equal(workerUrl("ws://example.com/worker", true).protocol, "ws:");
    assert.throws(() => prepareWorkspace("relative-folder"), /absolute/);
    assert.throws(() => prepareWorkspace(parse(dir).root), /root/);
    const folder = prepareWorkspace(join(dir, "new-workspace"));
    assert.equal(folder.endsWith("new-workspace"), true);
    writeFileSync(join(dir, "file"), "content");
    assert.throws(() => prepareWorkspace(join(dir, "file")));
    if (process.platform !== "win32") {
      symlinkSync("/", join(dir, "root-link"));
      assert.throws(() => prepareWorkspace(join(dir, "root-link")), /root/);
    }
    assert.throws(() => deviceConfigSchema.parse({ deviceId: "../bad", token: "s".repeat(64), url: "wss://example.com/worker", workspace: dir }));
    assert.throws(() => parseDeviceConfig('{"token":"private-secret" broken'), (error: any) => !error.message.includes("private-secret"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function fixture() {
  const local = Object.assign(new EventEmitter(), { root: tmpdir(), start: async () => ({}), stop: () => {} });
  const registrations = [{ id: "demoPC", name: "DemoPC", token: "private-device-credential" }];
  const devices = new Devices("mac", "Mac", local as unknown as Runtime, registrations);
  return { devices, local };
}

test("device lists never expose registration credentials to clients or master tools", () => {
  const { devices } = fixture();
  const json = JSON.stringify(devices.list());
  assert.equal(json.includes("private-device-credential"), false);
  assert.equal(json.includes('"token"'), false);
  const remote = devices.list().find((d) => d.id === "demoPC")!;
  assert.equal(remote.online, false);
  assert.equal(remote.capabilities.desktop, false);
});

async function connectionFixture(attachAs = "demoPC") {
  const { devices } = fixture();
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  server.on("connection", (socket) => devices.attach(attachAs, socket));
  const port = (server.address() as { port: number }).port;
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(client, "open");
  return {
    devices, client, port,
    cleanup: async () => {
      for (const socket of server.clients) socket.terminate();
      client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("companion becomes ready with metadata; a reconnect replaces its stale socket; disconnect rejects pending work", async () => {
  const f = await connectionFixture();
  try {
    assert.equal(f.devices.online("demoPC"), false);
    const ready = once(f.devices, "online");
    f.client.send(JSON.stringify({ kind: "ready", metadata: { ...runtimeMetadata(tmpdir()), platform: "win32", hostname: "DemoPC" } }));
    await ready;
    const device = f.devices.list().find((d) => d.id === "demoPC")!;
    assert.equal(device.online, true);
    assert.equal(device.hostname, "DemoPC");
    assert.equal(device.capabilities.files, true);
    assert.equal(device.capabilities.browser, false);
    const reconnect = new WebSocket(`ws://127.0.0.1:${f.port}`);
    let refused: number | undefined;
    reconnect.on("close", (code) => { refused = code; });
    await once(reconnect, "open");
    await delay(100);
    assert.equal(refused, undefined, "the reconnecting socket must not be refused");
    assert.equal(f.client.readyState, WebSocket.CLOSED, "the stale socket must be dropped");
    const rejoined = once(f.devices, "online");
    reconnect.send(JSON.stringify({ kind: "ready", metadata: { ...runtimeMetadata(tmpdir()), platform: "win32", hostname: "DemoPC" } }));
    await rejoined;
    assert.equal(reconnect.readyState, WebSocket.OPEN);
    assert.equal(f.devices.online("demoPC"), true);
    const pending = assert.rejects(f.devices.call("demoPC", "chat.create"), /disconnected/);
    const offline = once(f.devices, "offline");
    f.devices.disconnect("demoPC");
    assert.equal(f.devices.online("demoPC"), false);
    await offline;
    await pending;
    assert.equal(f.devices.list().find((d) => d.id === "demoPC")!.hostname, "DemoPC");
    await assert.rejects(f.devices.call("demoPC", "chat.create"), /offline/);
  } finally { await f.cleanup(); }
});

test("a dead companion executor is not reported as online while its socket closes", async () => {
  const f = await connectionFixture();
  try {
    const ready = once(f.devices, "online");
    f.client.send(JSON.stringify({ kind: "ready", metadata: runtimeMetadata(tmpdir()) }));
    await ready;
    const offline = once(f.devices, "offline");
    f.client.send(JSON.stringify({ kind: "event", event: { type: "runtime.offline", error: "process exited" } }));
    await offline;
    assert.equal(f.devices.online("demoPC"), false);
  } finally { await f.cleanup(); }
});

test("invalid readiness metadata cannot claim a connected device", async () => {
  const f = await connectionFixture();
  try {
    const closed = once(f.client, "close");
    f.client.send(JSON.stringify({ kind: "ready", metadata: { platform: "win32" } }));
    const [code] = await closed;
    assert.equal(code, 1008);
    assert.equal(f.devices.online("demoPC"), false);
  } finally { await f.cleanup(); }
});

test("the companion retries every coordinator close except a revoked registration", async () => {
  const f = await connectionFixture("unregistered");
  try {
    const [code, reason] = await once(f.client, "close");
    assert.equal(code, 1008);
    assert.equal(registrationEnded(reason.toString()), true);
    assert.equal(registrationEnded("Device did not become ready"), false);
    assert.equal(registrationEnded("Device already connected"), false);
  } finally { await f.cleanup(); }
});

test("the reconnect budget is refunded by a held connection, not by a bare open", async () => {
  const production = reconnectBudget();
  assert.deepEqual(
    Array.from({ length: 7 }, () => production.next()),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000],
  );
  const flapping = reconnectBudget(3, 40);
  assert.equal(flapping.next(), 1000);
  assert.equal(flapping.next(), 2000);
  for (let i = 0; i < 5; i++) {
    // A socket the coordinator closes right after the handshake earns nothing back.
    flapping.opened();
    flapping.closed();
  }
  assert.equal(flapping.next(), 4000);
  assert.equal(flapping.next(), undefined, "a flapping companion runs out");
  const stable = reconnectBudget(3, 40);
  for (let i = 0; i < 3; i++) stable.next();
  assert.equal(stable.next(), undefined);
  stable.opened();
  await delay(80);
  stable.closed();
  assert.equal(stable.next(), 1000, "a connection that holds refunds the budget");
});
