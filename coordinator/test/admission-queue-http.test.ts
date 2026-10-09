import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { WebSocket } from "ws";
import { Coordinator } from "../src/coordinator.js";
import { createHttpServer } from "../src/server.js";

test("HTTP advertises the implemented queue and admits only explicit messages during a live capture", async () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-queue-http-"));
  const config = { clientToken: "c".repeat(64), localDeviceId: "mac", localDeviceName: "Mac", workspace: directory, devices: [] };
  const app = new Coordinator(config, directory), executed: string[] = [];
  app.master.create = async () => ({ threadId: "master-fixture", workspace: directory });
  app.master.execute = async (_thread, taskId) => { executed.push(taskId); return { turnId: `turn-${taskId}` }; };
  const server = createHttpServer(app, config.clientToken, { publicOrigin: "https://example.com",
    liveTranscriptionFactory: (identity, emit) => {
      queueMicrotask(() => emit({ type: "ready", sessionId: identity.streamId }));
      return {
        append() { emit({ type: "partial", sessionId: identity.streamId, itemId: "item1", contentIndex: 0, delta: "only text", text: "only text" }); },
        finish() { emit({ type: "final", sessionId: identity.streamId, itemId: "item1", text: "Only a transcript, never a task." }); },
        cancel() {},
      };
    },
  });
  let socket: WebSocket | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { Authorization: `Bearer ${config.clientToken}`, Origin: "https://example.com", "Content-Type": "application/json" };
    const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
    const voice = await (await fetch(base + "/v1/voice", { headers })).json() as any;
    assert.deepEqual(voice.admissionQueue, { version: 1, supported: true, requestField: "queueIfBusy", maxQueuedPerChat: 8, restartBehavior: "interrupt_no_replay" });
    assert.equal(voice.liveTranscription.available, true);
    assert.equal((await fetch(base + "/v1/voice")).status, 401);
    const firstResponse = await post("/v1/messages", { requestId: "first", text: "First typed request" });
    assert.equal(firstResponse.status, 202);
    const first = await firstResponse.json() as any; await setImmediate();
    assert.equal(executed.length, 1);
    assert.equal((await post("/v1/messages", { requestId: "legacy", text: "Busy legacy request" })).status, 409);
    assert.equal((await post("/v1/messages", { requestId: "bad-type", text: "Invalid queue", queueIfBusy: "true" })).status, 400);
    assert.equal(Object.keys(app.store.state.tasks).length, 1);

    const ticket = await (await post("/v1/transcriptions/live-sessions", { requestId: "capture" })).json() as any;
    socket = new WebSocket(base.replace("http:", "ws:") + ticket.websocketPath, ["providence-live-v1", `ticket.${ticket.ticket}`], { origin: "https://example.com" });
    const ready = once(socket, "message"); await once(socket, "open"); await ready;
    const ack = new Promise<void>(resolve => socket!.on("message", bytes => { if (JSON.parse(bytes.toString()).type === "ack") resolve(); }));
    socket.send(JSON.stringify({ type: "audio", seq: 0, audio: Buffer.alloc(4800).toString("base64") })); await ack;
    assert.equal(Object.keys(app.store.state.tasks).length, 1, "partial transcription never admits a task");
    const queuedResponse = await post("/v1/messages", { requestId: "second", text: "Second typed request", queueIfBusy: true });
    assert.equal(queuedResponse.status, 202);
    const queued = await queuedResponse.json() as any;
    assert.equal(queued.status, "queued"); assert.equal(queued.queueIfBusy, true);
    assert.deepEqual(queued.admissionQueue, { reason: "chat_busy", predecessorTaskId: first.id });
    assert.equal(executed.length, 1);
    const closed = once(socket, "close"); socket.send(JSON.stringify({ type: "finish", lastSeq: 0 })); await closed;
    assert.equal(Object.keys(app.store.state.tasks).length, 2, "final transcription still never admits a task");
    assert.equal(app.store.state.tasks[queued.id].status, "queued");
    app.event("coordinator", { type: "task.completed", taskId: first.id, text: "First complete" }); await setImmediate();
    assert.deepEqual(executed, [first.id, queued.id]);
    assert.equal(app.store.state.tasks[queued.id].status, "running");
  } finally {
    socket?.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await setImmediate();
    rmSync(directory, { recursive: true, force: true });
  }
});
