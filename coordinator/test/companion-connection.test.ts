import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { WebSocket, WebSocketServer } from "ws";
import { CompanionConnection, startupGuidance, startupFailure, type ConnectionClock, type ConnectionStatus } from "../src/companion-connection.js";
import { Devices } from "../src/devices.js";
import { runtimeMetadata } from "../src/device-config.js";
import type { Runtime } from "../src/runtime.js";

class Clock implements ConnectionClock {
  now = 0; next = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, ms: number) { const id = ++this.next; this.timers.set(id, { at: this.now + ms, callback }); return id; }
  clearTimeout(timer: unknown) { this.timers.delete(timer as number); }
  advance(ms: number) {
    const until = this.now + ms;
    for (;;) {
      const next = [...this.timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at; this.timers.delete(next[0]); next[1].callback();
    }
    this.now = until;
  }
}
class FakeRuntime extends EventEmitter {
  stops = 0;
  start: () => Promise<unknown> = async () => ({});
  shutdown: () => Promise<void> = async () => {};
  stopAndWait() { this.stops++; this.emit("event", { type: "runtime.offline", error: "Codex exited (0)" }); return this.shutdown(); }
}
class FakeSocket extends EventEmitter {
  readyState = 0; terminated = 0; pings = 0; autoPong = false; sent: any[] = [];
  send(data: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(data)); callback?.(); }
  ping() { this.pings++; if (this.autoPong) this.emit("pong"); }
  terminate() { this.terminated++; this.readyState = 3; this.emit("close", 1006); }
  open() { this.readyState = 1; this.emit("open"); }
  receive(value: unknown) { this.emit("message", Buffer.from(JSON.stringify(value))); }
  closeWith(code: number) { this.readyState = 3; this.emit("close", code); }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(options: { start?: (runtime: FakeRuntime) => Promise<unknown>; stop?: () => Promise<void>; legacy?: boolean; activity?: (active: boolean, ttlMs: number) => void } = {}) {
  const clock = new Clock(), runtimes: FakeRuntime[] = [], sockets: FakeSocket[] = [], status: ConnectionStatus[] = [];
  const requests: unknown[] = [];
  const connection = new CompanionConnection({
    deviceId: "fixture-device", clock,
    createRuntime: () => { const runtime = new FakeRuntime(); if (options.start) runtime.start = () => options.start!(runtime); if (options.stop) runtime.shutdown = options.stop; runtimes.push(runtime); return runtime; },
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    metadata: () => ({ hostname: "fixture", platform: "win32" }),
    request: async (_runtime, method, params) => { requests.push({ method, params }); return { ok: true }; },
    status: value => status.push(value), allowLegacyReady: options.legacy, activity: options.activity,
  });
  const ready = async () => { connection.start(); await flush(); sockets.at(-1)!.open(); sockets.at(-1)!.receive({ kind: "ready_ack", deviceId: "fixture-device" }); await flush(); };
  return { clock, runtimes, sockets, status, requests, connection, ready };
}

test("readiness requires matching acknowledgement and explicit legacy mode stays labelled", async () => {
  const f = fixture(); f.connection.start(); f.connection.start(); await flush();
  assert.equal(f.runtimes.length, 1); f.sockets[0].open();
  assert.equal(f.status.at(-1)?.phase, "awaiting_ack");
  assert.deepEqual(f.sockets[0].sent[0].capabilities, { readyAck: true, powerActivity: true });
  f.sockets[0].receive({ kind: "ready_ack", deviceId: "fixture-device" });
  assert.equal(f.status.at(-1)?.phase, "connected"); await f.connection.stop();
  const legacy = fixture({ legacy: true }); legacy.connection.start(); await flush(); legacy.sockets[0].open();
  assert.equal(legacy.status.at(-1)?.phase, "legacy_connected"); await legacy.connection.stop();
});

test("missing ack retires only its generation and retries without legacy fallback", async () => {
  const f = fixture(); f.connection.start(); await flush(); f.sockets[0].open();
  f.clock.advance(15_000); await flush();
  assert.equal(f.status.at(-1)?.reason, "ready_timeout");
  assert.equal(f.status.at(-1)?.retryInMs, 1000);
  assert.equal(f.runtimes[0].stops, 1); assert.equal(f.sockets[0].terminated, 1);
  assert.equal(f.clock.timers.size, 1);
  f.clock.advance(1000); await flush(); assert.equal(f.runtimes.length, 2);
  assert.equal(f.status.some(value => value.phase === "connected" || value.phase === "legacy_connected"), false);
  await f.connection.stop();
});

test("wrong ack, malformed messages, credential rejection and unknown protocol closes stop", async () => {
  for (const failure of ["wrong_ack", "malformed", "401", "403", "1008", "1002", "404"]) {
    const f = fixture(); f.connection.start(); await flush(); const ws = f.sockets[0]; ws.open();
    if (failure === "wrong_ack") ws.receive({ kind: "ready_ack", deviceId: "other" });
    else if (failure === "malformed") ws.emit("message", Buffer.from("{broken"));
    else if (failure.startsWith("10")) ws.closeWith(Number(failure));
    else ws.emit("unexpected-response", {}, { statusCode: Number(failure), resume() {} });
    await flush();
    assert.equal(f.status.at(-1)?.phase, "action_required", failure);
    f.clock.advance(100_000); await flush(); assert.equal(f.runtimes.length, 1);
    assert.equal(f.clock.timers.size, 0);
  }
});

test("transient startup failures retry while auth/config/unknown failures require action", async () => {
  for (const error of [new Error("Run codex login on this device first."), new Error("The runtime did not return a model catalog."), new Error("unknown private detail")]) {
    const f = fixture({ start: async () => { throw error; } }); f.connection.start(); await flush();
    assert.equal(f.status.at(-1)?.phase, "action_required"); assert.equal(f.runtimes[0].stops, 1);
    assert.equal(JSON.stringify(f.status).includes(error.message), false); assert.equal(f.clock.timers.size, 0);
  }
  const f = fixture({ start: async () => { throw new Error("Codex timeout: initialize"); } });
  f.connection.start(); await flush(); assert.equal(f.status.at(-1)?.retryInMs, 1000);
  f.clock.advance(1000); await flush(); assert.equal(f.runtimes.length, 2);
  assert.equal(f.status.at(-1)?.retryInMs, 2000); assert.equal(f.sockets.length, 0); await f.connection.stop();
  assert.equal(startupFailure(Object.assign(new Error("connect"), { code: "ECONNRESET" })), "transient");
  assert.equal(startupFailure(Object.assign(new Error("spawn"), { code: "ENOENT" })), "action_required");
});

test("flapping open/ack never resets exponential backoff; stable acknowledged connection does", async () => {
  const f = fixture(); await f.ready();
  const delays = [];
  for (let i = 0; i < 7; i++) {
    f.sockets.at(-1)!.closeWith(1006); await flush(); const delay = f.status.at(-1)!.retryInMs!; delays.push(delay);
    assert.equal(f.clock.timers.size, 1);
    f.clock.advance(delay); await flush(); const ws = f.sockets.at(-1)!; ws.open(); ws.receive({ kind: "ready_ack", deviceId: "fixture-device" });
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  f.sockets.at(-1)!.autoPong = true; f.clock.advance(60_000);
  f.sockets.at(-1)!.closeWith(1006); await flush(); assert.equal(f.status.at(-1)?.retryInMs, 1000); await f.connection.stop();
});

test("half-open watchdog terminates owned socket and stops runtime, pong keeps it alive", async () => {
  const f = fixture(); await f.ready(); f.clock.advance(15_000); assert.equal(f.sockets[0].pings, 1);
  f.clock.advance(15_000); await flush(); assert.equal(f.status.at(-1)?.reason, "heartbeat_timeout");
  assert.equal(f.sockets[0].terminated, 1); assert.equal(f.runtimes[0].stops, 1); assert.equal(f.clock.timers.size, 1);
  await f.connection.stop();
  const alive = fixture(); await alive.ready(); alive.sockets[0].autoPong = true; alive.clock.advance(120_000);
  assert.equal(alive.sockets[0].terminated, 0); assert.equal(alive.runtimes[0].stops, 0); await alive.connection.stop();
});

test("a missed pong at the stability deadline does not erase prior retry backoff", async () => {
  const f = fixture(); await f.ready(); f.sockets[0].closeWith(1006); await flush();
  f.clock.advance(1000); await flush(); const ws = f.sockets[1]; ws.open(); ws.receive({ kind: "ready_ack", deviceId: "fixture-device" });
  f.clock.advance(15_000); ws.emit("pong");
  f.clock.advance(45_000); await flush();
  assert.equal(f.status.at(-1)?.reason, "heartbeat_timeout");
  assert.equal(f.status.at(-1)?.retryInMs, 2000); await f.connection.stop();
});

test("startup timeout/stop prevents stale runtime completion from creating another socket", async () => {
  let resolve!: () => void;
  const f = fixture({ start: () => new Promise<void>(done => { resolve = done; }) });
  f.connection.start(); f.clock.advance(65_000); await flush(); assert.equal(f.runtimes[0].stops, 1);
  resolve(); await flush(); assert.equal(f.sockets.length, 0); assert.equal(f.clock.timers.size, 1);
  await f.connection.stop(); assert.equal(f.clock.timers.size, 0);
  const stopped = fixture({ start: () => new Promise<void>(done => { resolve = done; }) });
  stopped.connection.start(); await stopped.connection.stop(); resolve(); await flush();
  assert.equal(stopped.sockets.length, 0); assert.equal(stopped.runtimes[0].stops, 1);
});

test("runtime death schedules one retry; stale events cannot replay old requests", async () => {
  const f = fixture(); await f.ready(); const old = f.sockets[0];
  old.receive({ kind: "request", id: "one", method: "task.start", params: { taskId: "original" } }); await flush();
  assert.equal(f.requests.length, 1);
  f.runtimes[0].emit("event", { type: "runtime.offline", error: "Codex exited (0)" }); old.emit("close", 1006); await flush();
  assert.equal(f.clock.timers.size, 1); f.clock.advance(1000); await flush();
  old.receive({ kind: "request", id: "late", method: "task.start" });
  assert.equal(f.requests.length, 1); assert.equal(f.runtimes.length, 2); await f.connection.stop();
});

test("late operation result after disconnect is discarded instead of sent on new socket", async () => {
  const clock = new Clock(), sockets: FakeSocket[] = []; let resolve!: (value: unknown) => void; let calls = 0;
  const connection = new CompanionConnection({ deviceId: "fixture", clock, createRuntime: () => new FakeRuntime(),
    createSocket: () => { const ws = new FakeSocket(); sockets.push(ws); return ws; }, metadata: () => ({}), status: () => {},
    request: async () => { calls++; return new Promise(done => { resolve = done; }); } });
  connection.start(); await flush(); sockets[0].open(); sockets[0].receive({ kind: "ready_ack", deviceId: "fixture" });
  sockets[0].receive({ kind: "request", id: "one", method: "task.start" }); await flush();
  sockets[0].closeWith(1006); await flush(); clock.advance(1000); await flush(); sockets[1].open(); sockets[1].receive({ kind: "ready_ack", deviceId: "fixture" });
  resolve({ result: "late" }); await flush();
  assert.equal(calls, 1); assert.equal(sockets[1].sent.some(value => value.kind === "response"), false); await connection.stop();
});

test("only transient handshake statuses reconnect", async () => {
  for (const statusCode of [408, 429, 502, 503]) {
    const f = fixture(); f.connection.start(); await flush();
    f.sockets[0].emit("unexpected-response", {}, { statusCode, resume() {} });
    await flush(); assert.equal(f.status.at(-1)?.phase, "retrying"); assert.equal(f.clock.timers.size, 1); await f.connection.stop();
  }
});

test("retirement waits for confirmed exit before scheduling retry or spawning a generation", async () => {
  let confirm!: () => void;
  const f = fixture({ stop: () => new Promise<void>(resolve => { confirm = resolve; }) });
  await f.ready(); f.sockets[0].closeWith(1006); await flush();
  assert.equal(f.status.at(-1)?.phase, "retiring"); assert.equal(f.clock.timers.size, 0);
  assert.equal(f.runtimes[0].stops, 1);
  f.clock.advance(120_000); f.connection.start(); await flush(); assert.equal(f.runtimes.length, 1);
  f.sockets[0].receive({ kind: "ready_ack", deviceId: "fixture-device" });
  confirm(); await flush();
  assert.equal(f.status.at(-1)?.phase, "retrying"); assert.equal(f.status.at(-1)?.retryInMs, 1000);
  f.clock.advance(999); await flush(); assert.equal(f.runtimes.length, 1);
  f.clock.advance(1); await flush(); assert.equal(f.runtimes.length, 2);
  f.runtimes[1].shutdown = async () => {}; await f.connection.stop();
});

test("unconfirmed runtime shutdown is terminal and cannot launch another runtime", async () => {
  const f = fixture({ stop: async () => { throw new Error("private shutdown diagnostic"); } });
  await f.ready(); f.sockets[0].closeWith(1006); await flush();
  assert.equal(f.status.at(-1)?.phase, "action_required");
  assert.equal(f.status.at(-1)?.reason, "runtime_shutdown_unconfirmed");
  assert.equal(f.clock.timers.size, 0); assert.equal(f.runtimes[0].stops, 1);
  f.connection.start(); f.clock.advance(120_000); await flush(); assert.equal(f.runtimes.length, 1);
  await assert.rejects(f.connection.stop(), /shutdown was not confirmed/);
  assert.equal(f.runtimes[0].stops, 1);
  assert.equal(JSON.stringify(f.status).includes("private"), false);
});

test("owner stop shares an in-progress retirement and suppresses its later retry", async () => {
  let confirm!: () => void;
  const f = fixture({ stop: () => new Promise<void>(resolve => { confirm = resolve; }) });
  await f.ready(); f.sockets[0].closeWith(1006); await flush();
  const first = f.connection.stop(), second = f.connection.stop();
  assert.equal(first, second); assert.equal(f.runtimes[0].stops, 1);
  confirm(); await first; await flush(); f.clock.advance(120_000);
  assert.equal(f.status.at(-1)?.phase, "stopped"); assert.equal(f.clock.timers.size, 0);
  assert.equal(f.status.some(status => status.phase === "retrying"), false);
  assert.equal(f.runtimes.length, 1);
});

test("late startup completion during owner retirement cannot create a socket or report ready", async () => {
  let finishStart!: () => void, confirmStop!: () => void;
  const f = fixture({ start: () => new Promise<void>(resolve => { finishStart = resolve; }),
    stop: () => new Promise<void>(resolve => { confirmStop = resolve; }) });
  f.connection.start(); const stopped = f.connection.stop(); finishStart(); await flush();
  assert.equal(f.sockets.length, 0); assert.equal(f.clock.timers.size, 0);
  confirmStop(); await stopped; await flush();
  assert.equal(f.status.at(-1)?.phase, "stopped"); assert.equal(f.runtimes[0].stops, 1);
  assert.equal(f.status.some(status => status.phase === "connected"), false);
});

test("post-ready runtime authentication/config errors stop while actual process exit retries", async () => {
  for (const error of ["Run codex login on this device first.", "Permission profile is not permitted", "The runtime did not return a model catalog."]) {
    const f = fixture(); await f.ready(); f.runtimes[0].emit("event", { type: "runtime.offline", error }); await flush();
    assert.equal(f.status.at(-1)?.phase, "action_required"); assert.equal(f.clock.timers.size, 0);
    assert.equal(f.runtimes[0].stops, 1);
    assert.equal(JSON.stringify(f.sockets[0].sent).includes(error), false);
  }
  const retry = fixture(); await retry.ready(); retry.runtimes[0].emit("event", { type: "runtime.offline", error: "Codex exited (1)" }); await flush();
  assert.equal(retry.status.at(-1)?.phase, "retrying"); await retry.connection.stop();
});

test("typed unauthorized task failure is forwarded once then stops with fixed runtime error", async () => {
  for (const legacy of [false, true]) {
    const f = fixture({ legacy }); await f.ready();
    const failure = { type: "task.failed", taskId: "fixture-task", providerErrorCode: "unauthorized", error: "Provider unauthorized" };
    f.runtimes[0].emit("event", failure); await flush();
    assert.equal(f.status.at(-1)?.phase, "action_required"); assert.equal(f.status.at(-1)?.reason, "provider_auth_required");
    const events = f.sockets[0].sent.filter(value => value.kind === "event").map(value => value.event);
    assert.deepEqual(events, [failure, { type: "runtime.offline", reasonCode: "authentication_required",
      providerErrorCode: "unauthorized", error: "Device runtime authentication requires owner attention." }]);
    assert.equal(f.runtimes[0].stops, 1); assert.equal(f.clock.timers.size, 0);
    f.clock.advance(120_000); await flush(); assert.equal(f.runtimes.length, 1); assert.equal(f.requests.length, 0);
  }
});

test("ordinary task errors do not stop companion or get treated as authentication failures", async () => {
  const f = fixture(); await f.ready();
  for (const error of ["Command failed", "File permission denied", "The webpage says unauthorized", "Unknown task error"])
    f.runtimes[0].emit("event", { type: "task.failed", taskId: error, error });
  await flush(); assert.equal(f.status.at(-1)?.phase, "connected");
  assert.equal(f.runtimes[0].stops, 0); assert.equal(f.sockets[0].terminated, 0);
  await f.connection.stop();
});

test("authentication failure blocks new requests even while its final socket write stalls", async () => {
  const f = fixture(); await f.ready();
  f.sockets[0].send = data => { f.sockets[0].sent.push(JSON.parse(data)); };
  f.runtimes[0].emit("event", { type: "task.failed", providerErrorCode: "unauthorized", taskId: "fixture" });
  f.sockets[0].receive({ kind: "request", id: "late", method: "task.start" });
  assert.equal(f.requests.length, 0);
  f.clock.advance(1000); await flush();
  assert.equal(f.status.at(-1)?.phase, "action_required"); assert.equal(f.runtimes[0].stops, 1);
});

test("real loopback WebSocket completes readiness/request exchange without a provider", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  const responses: unknown[] = []; let connected!: () => void; const ready = new Promise<void>(done => { connected = done; });
  server.on("connection", ws => ws.on("message", raw => {
    const value = JSON.parse(raw.toString());
    if (value.kind === "ready") {
      assert.equal(value.capabilities.readyAck, true);
      ws.send(JSON.stringify({ kind: "ready_ack", deviceId: "fixture" }));
      ws.send(JSON.stringify({ kind: "request", id: "echo", method: "fixture.echo", params: "hello" }));
    } else if (value.kind === "response") { responses.push(value); connected(); }
  }));
  const runtime = new FakeRuntime();
  const connection = new CompanionConnection({ deviceId: "fixture", createRuntime: () => runtime,
    createSocket: () => new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`),
    metadata: () => ({}), request: async (_runtime, method, params) => ({ method, params }), status: () => {} });
  try {
    connection.start(); await ready;
    assert.deepEqual(responses, [{ kind: "response", id: "echo", result: { method: "fixture.echo", params: "hello" } }]);
  } finally {
    await connection.stop(); for (const ws of server.clients) ws.terminate();
    await new Promise<void>(done => server.close(() => done()));
  }
  assert.equal(runtime.stops, 1);
});

test("actual companion offline messages preserve auth/config attention through server mapping", { timeout: 5000 }, async () => {
  for (const reason of ["authentication_required", "configuration_required"] as const) {
    const local = Object.assign(new EventEmitter(), { root: tmpdir(), stop() {}, start: async () => ({}) });
    const devices = new Devices("mac", "Fixture Mac", local as unknown as Runtime, [{ id: "fixture-device", name: "Fixture" }]);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
    server.on("connection", socket => devices.attach("fixture-device", socket));
    const runtime = new FakeRuntime(); const events: any[] = [];
    devices.on("event", (_id, event) => { if (event.type === "runtime.offline") events.push(event); });
    let connected!: () => void;
    const ready = new Promise<void>(done => { connected = done; });
    const status: ConnectionStatus[] = [];
    const connection = new CompanionConnection({ deviceId: "fixture-device", createRuntime: () => runtime,
      createSocket: () => new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`),
      metadata: () => runtimeMetadata(tmpdir()), request: async () => { throw new Error("No task replay permitted"); },
      status: value => { status.push(value); if (value.phase === "connected") connected(); } });
    try {
      connection.start(); await ready; assert.equal(devices.online("fixture-device"), true);
      const offline = once(devices, "offline");
      if (reason === "authentication_required")
        runtime.emit("event", { type: "task.failed", taskId: "fixture-task", providerErrorCode: "unauthorized", error: "Provider unauthorized" });
      else runtime.emit("event", { type: "runtime.offline", error: "Configured model is not available: private-fixture-value" });
      await offline; await flush();
      const device = devices.list().find(value => value.id === "fixture-device")!;
      assert.equal(device.online, false); assert.equal(device.connectionStatus.state, "action_required");
      assert.equal(device.connectionStatus.reasonCode, reason); assert.equal(events.length, 1);
      assert.equal(events[0].reasonCode, reason);
      assert.equal(events[0].providerErrorCode, reason === "authentication_required" ? "unauthorized" : undefined);
      assert.equal(JSON.stringify([device.connectionStatus, events]).includes("private-fixture-value"), false);
      assert.equal(status.at(-1)?.phase, "action_required"); assert.equal(runtime.stops, 1);
    } finally {
      await connection.stop(); for (const socket of server.clients) socket.terminate();
      await new Promise<void>(done => server.close(() => done()));
    }
  }
});

test("CLI configuration failure exits78 without echoing the missing path or starting a runtime", { timeout: 65_000 }, async () => {
  // This checks the CLI's exit contract, not a ten-second module-loading SLA.
  // Await its actual exit without blocking this test process under suite load.
  const result = await new Promise<{ status: number; stdout: string; stderr: string }>((accept, reject) => {
    execFile(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/device.ts", import.meta.url)), "/nonexistent/fixture-private-device.json"], {
      encoding: "utf8", timeout: 60_000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
    }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== "number")) { reject(error); return; }
      accept({ status: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  });
  assert.equal(result.status, 78); assert.equal(result.stderr.includes("fixture-private-device"), false);
  assert.equal(result.stdout.includes("fixture-private-device"), false);
  assert.match(result.stderr, /device_configuration/);
});


test("known setup failures give useful next steps without echoing raw diagnostics", () => {
  const secret = "private-" + "sensitive-value";
  for (const message of ["Run codex login on this device first.", "The configured Providence worker full-access profile is not permitted by this runtime.", "Providence model test-model is not available in this device's model catalog."]) {
    const help = startupGuidance(new Error(message + secret));
    assert.ok(help); assert.equal(help.includes(secret), false);
  }
  assert.equal(startupGuidance(new Error(secret)), undefined);
});


test("activity leases are bounded and accepted only on a ready companion", async () => {
  const leases: unknown[] = [];
  const f = fixture({ activity: (active, ttlMs) => leases.push({ active, ttlMs }) });
  try {
    await f.ready();
    f.sockets.at(-1)!.receive({ kind: "power_lease", active: true, ttlMs: 30_000 }); await flush();
    assert.deepEqual(leases, [{ active: true, ttlMs: 30_000 }]);
    f.sockets.at(-1)!.receive({ kind: "power_lease", active: false, ttlMs: 30_000 }); await flush();
    assert.equal(leases.length, 2);
    f.sockets.at(-1)!.receive({ kind: "power_lease", active: true, ttlMs: 86400000 }); await flush();
    assert.equal(leases.length, 2);
    assert.ok(f.status.some(s => s.phase === "action_required" && s.reason === "invalid_protocol_message"));
  } finally { await f.connection.stop(); }
});
