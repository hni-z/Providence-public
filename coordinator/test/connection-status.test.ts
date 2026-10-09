import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import type { Runtime } from "../src/runtime.js";
import { Devices } from "../src/devices.js";
import { runtimeMetadata } from "../src/device-config.js";
import { WebSocket } from "ws";
import { disconnectedStatus, runtimeOfflineEvent } from "../src/connection-status.js";

class Socket extends EventEmitter {
  sent: any[] = [];
  closed: [number, string][] = [];
  pings = 0;
  readyState: number = WebSocket.OPEN;
  send(value: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(value)); callback?.(); }
  ping() { this.pings++; }
  close(code = 1000, reason = "") { this.closed.push([code, reason]); this.readyState = WebSocket.CLOSED; this.emit("close", code, Buffer.from(reason)); }
  terminate() { this.close(1006, ""); }
}
const ready = (ack = true) => JSON.stringify({ kind: "ready", metadata: runtimeMetadata(tmpdir()), ...(ack ? { capabilities: { readyAck: true } } : {}) });
function fixture() {
  const local = Object.assign(new EventEmitter(), { root: tmpdir(), start: async () => ({}), stop: () => {} });
  const devices = new Devices("mac", "Mac", local as Runtime, [{ id: "demoPC", name: "DemoPC" }]);
  const socket = new Socket();
  devices.attach("demoPC", socket as unknown as WebSocket);
  return { devices, socket, status: () => devices.list().find(d => d.id === "demoPC")!.connectionStatus,
    finish: () => { devices.stop(); socket.terminate(); } };
}

test("optional ready ACK follows validated readiness and precedes newly routed work; legacy ready still works", async () => {
  for (const ack of [true, false]) {
    const f = fixture();
    try {
      assert.equal(f.status().state, "connecting");
      assert.equal(f.devices.online("demoPC"), false);
      let pending: Promise<unknown> | undefined;
      f.devices.once("online", () => { pending = f.devices.call("demoPC", "task.start", { taskId: "explicit-task" }); });
      f.socket.emit("message", ready(ack));
      assert.equal(f.devices.online("demoPC"), true);
      assert.equal(f.status().state, "online");
      assert.equal(f.status().reasonCode, "ready");
      assert.ok(f.status().connectedAt && f.status().lastSeenAt);
      assert.equal(f.socket.sent[0].kind, ack ? "ready_ack" : "request");
      if (ack) assert.deepEqual(f.socket.sent[0], { kind: "ready_ack", deviceId: "demoPC" });
      const request = f.socket.sent.find(value => value.kind === "request");
      f.socket.emit("message", JSON.stringify({ kind: "response", id: request.id, result: { turnId: "turn" } }));
      await pending;
    } finally { f.finish(); }
  }
});

test("invalid metadata is not acknowledged, and duplicate/stale sockets cannot replace current status", () => {
  const f = fixture();
  try {
    f.socket.emit("message", JSON.stringify({ kind: "ready", capabilities: { readyAck: true }, metadata: {} }));
    assert.equal(f.socket.sent.length, 0);
    assert.equal(f.status().state, "action_required");
    assert.equal(f.status().reasonCode, "protocol_error");
    const replacement = new Socket();
    f.devices.attach("demoPC", replacement as unknown as WebSocket);
    replacement.emit("message", ready());
    const duplicate = new Socket();
    f.devices.attach("demoPC", duplicate as unknown as WebSocket);
    assert.equal(f.devices.online("demoPC"), false, "replacement waits for its own ready ACK");
    duplicate.emit("message", ready());
    assert.equal(duplicate.sent[0].kind, "ready_ack");
    const prior = f.status();
    replacement.emit("message", JSON.stringify({ kind: "event", event: { type: "runtime.offline" } }));
    f.socket.emit("message", JSON.stringify({ kind: "event", event: { type: "runtime.offline", error: "unauthorized secret-token" } }));
    assert.deepEqual(f.status(), prior);
    assert.equal(f.devices.online("demoPC"), true);
  } finally { f.finish(); }
});

test("failed or delayed ACK writes never emit a stale online event or dispatch work", async () => {
  for (const synchronousError of [true, false]) {
    const f = fixture();
    try {
      let online = 0;
      let complete: ((error?: Error) => void) | undefined;
      f.devices.on("online", () => online++);
      f.socket.send = (value, callback) => {
        f.socket.sent.push(JSON.parse(value));
        if (synchronousError) callback?.(new Error("write failed"));
        else complete = callback;
      };
      f.socket.emit("message", ready());
      assert.equal(f.devices.online("demoPC"), false);
      assert.equal(online, 0);
      await assert.rejects(f.devices.call("demoPC", "task.start"), /offline/);
      if (!synchronousError) {
        f.socket.emit("message", ready());
        assert.equal(f.socket.sent.length, 1, "duplicate readiness cannot write another ACK");
        f.socket.close();
        complete?.();
        assert.equal(online, 0, "a late successful write cannot revive a closed connection");
      }
      assert.equal(f.socket.sent.some(value => value.kind === "request"), false);
    } finally { f.finish(); }
  }
});

test("server heartbeat expiry and readiness timeout expose bounded reasons without replay", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const f = fixture();
  try {
    f.socket.emit("message", ready());
    const firstSeen = f.status().lastSeenAt;
    t.mock.timers.tick(15000);
    assert.equal(f.socket.pings, 1);
    t.mock.timers.tick(3000);
    f.socket.emit("pong");
    assert.notEqual(f.status().lastSeenAt, firstSeen);
    t.mock.timers.tick(12000);
    assert.equal(f.devices.online("demoPC"), true);
    t.mock.timers.tick(15000);
    assert.equal(f.devices.online("demoPC"), false);
    assert.equal(f.status().reasonCode, "heartbeat_timeout");
    assert.equal(f.socket.sent.filter(v => v.kind === "request").length, 0);
    const unready = new Socket();
    f.devices.attach("demoPC", unready as unknown as WebSocket);
    t.mock.timers.tick(15000);
    assert.equal(f.status().reasonCode, "ready_timeout");
    assert.equal(unready.closed[0][0], 1013);
    assert.equal(f.devices.online("demoPC"), false);
  } finally { f.finish(); }
});

test("runtime authentication and owner disconnect are distinct from transport loss and do not leak errors", () => {
  const f = fixture();
  try {
    f.socket.emit("message", ready());
    f.socket.emit("message", JSON.stringify({ kind: "event", event: { type: "runtime.offline", error: "Your access token could not be refreshed. secret-value" } }));
    assert.equal(f.status().state, "action_required");
    assert.equal(f.status().reasonCode, "authentication_required");
    assert.equal(JSON.stringify(f.status()).includes("secret-value"), false);
    const replacement = new Socket();
    f.devices.attach("demoPC", replacement as unknown as WebSocket);
    replacement.emit("message", ready());
    assert.equal(f.status().reasonCode, "ready");
    f.devices.disconnect("demoPC");
    assert.equal(f.status().reasonCode, "disconnected_by_owner");
    assert.equal(f.status().state, "action_required");
  } finally { f.finish(); }
});

test("offline reason metadata accepts only known codes and never carries raw provider fields", () => {
  for (const input of [
    { reasonCode: "configuration_required", error: "private-error" },
    { reasonCode: "authentication_required", error: "private-error" },
    { providerErrorCode: "unauthorized", reasonCode: "ready", error: "private-error" },
  ]) {
    const event = runtimeOfflineEvent({ ...input, hiddenToken: "private-token", _meta: { secret: "private-meta" } });
    assert.equal(disconnectedStatus(undefined, event.reasonCode, "2026-09-20T00:00:00Z").state, "action_required");
    assert.equal(JSON.stringify(event).includes("private"), false);
  }
  const unknown = runtimeOfflineEvent({ reasonCode: "online", providerErrorCode: { unauthorized: true }, error: "private-error" });
  assert.equal(unknown.reasonCode, "runtime_stopped"); assert.equal(unknown.providerErrorCode, undefined);
  assert.equal(disconnectedStatus(undefined, unknown.reasonCode, "2026-09-20T00:00:00Z").state, "offline");
});
