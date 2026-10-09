import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Coordinator } from "../src/coordinator.js";
import { createHttpServer } from "../src/server.js";
import type { LiveTranscriptionFactory } from "../src/provider-live-transcription.js";

async function fixture(deferFinal = false) {
  const directory = mkdtempSync(join(tmpdir(), "providence-live-http-"));
  const config = { clientToken: "c".repeat(64), localDeviceId: "mac", localDeviceName: "Mac", workspace: directory, devices: [] };
  const app = new Coordinator(config, directory);
  let starts = 0, cancellations = 0, commits = 0;
  const audio: { sequence: number; data: string }[] = [];
  let releaseProvider: ((type?: "partial" | "final") => void) | undefined;
  let committed!: () => void;
  const commitReceived = new Promise<void>(resolve => { committed = resolve; });
  const factory: LiveTranscriptionFactory = (identity, emit) => {
    starts++;
    queueMicrotask(() => emit({ type: "ready", sessionId: identity.streamId }));
    return {
      append(sequence, data) {
        audio.push({ sequence, data });
        emit({ type: "partial", sessionId: identity.streamId, eventId: `event-${sequence}`, itemId: "item1", contentIndex: 0, delta: "fixture", text: "fixture" });
      },
      finish() {
        commits++; committed();
        releaseProvider = (type = "final") => emit({ type, sessionId: identity.streamId, eventId: "late-provider-event", itemId: "item1",
          ...(type === "partial" ? { contentIndex: 0, delta: "Private pending transcript." } : {}), text: "Private pending transcript." });
        if (!deferFinal) emit({ type: "final", sessionId: identity.streamId, eventId: "final1", itemId: "item1", text: "Actual fixture transcript." });
      },
      cancel() { cancellations++; },
    };
  };
  const server = createHttpServer(app, config.clientToken, { publicOrigin: "https://example.com", liveTranscriptionFactory: factory });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`, sockets: WebSocket[] = [];
  const post = (requestId: string, authorized = true, origin = "https://example.com") => fetch(`${base}/v1/transcriptions/live-sessions`, {
    method: "POST", headers: { Authorization: authorized ? `Bearer ${config.clientToken}` : "Bearer wrong", Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ requestId }),
  });
  const connect = (ticket: any, origin = "https://example.com") => {
    const socket = new WebSocket(base.replace("http:", "ws:") + ticket.websocketPath, ["providence-live-v1", `ticket.${ticket.ticket}`], { origin });
    sockets.push(socket);
    return socket;
  };
  return { app, server, base, config, post, connect, audio, commitReceived,
    releaseProvider: (type: "partial" | "final") => releaseProvider?.(type),
    counts: () => ({ starts, cancellations, commits }),
    cleanup: async () => { for (const socket of sockets) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); } };
}

test("live gateway authenticates tickets and streams genuine frames without creating a task", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post("capture", false)).status, 401);
    assert.equal((await f.post("capture", true, "https://wrong.example")).status, 403);
    const response = await f.post("capture"); assert.equal(response.status, 201);
    const ticket = await response.json() as any;
    assert.deepEqual(await (await f.post("capture")).json(), ticket);
    const socket = f.connect(ticket), ready = once(socket, "message");
    await once(socket, "open");
    assert.equal(socket.protocol, "providence-live-v1", "credential protocol is never echoed");
    assert.deepEqual(JSON.parse(String((await ready)[0])), { type: "ready", sessionId: ticket.sessionId });
    const messages: any[] = [];
    socket.on("message", bytes => messages.push(JSON.parse(bytes.toString())));
    const ack = new Promise<void>(resolve => socket.on("message", bytes => { if (JSON.parse(bytes.toString()).type === "ack") resolve(); }));
    socket.send(JSON.stringify({ type: "audio", seq: 0, audio: Buffer.alloc(4800).toString("base64") }));
    await ack;
    assert.equal(messages[0].type, "partial");
    assert.deepEqual(messages[1], { type: "ack", sessionId: ticket.sessionId, seq: 0 });
    assert.equal(f.counts().commits, 0);
    assert.equal(Object.keys(f.app.store.state.tasks).length, 0);
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "finish", lastSeq: 0 }));
    await closed;
    assert.equal(messages.at(-1).type, "final");
    assert.equal(messages.at(-1).text, "Actual fixture transcript.");
    assert.equal(f.counts().commits, 1);
    assert.equal(f.audio.length, 1);
    assert.equal(Object.keys(f.app.store.state.tasks).length, 0);
    assert.equal((await f.post("capture")).status, 409);
  } finally { await f.cleanup(); }
});

test("revoking the client after finish withholds every later provider partial or final", async () => {
  for (const lateType of ["partial", "final"] as const) {
    const f = await fixture(true);
    try {
      const ownerHeaders = { Authorization: `Bearer ${f.config.clientToken}`, Origin: "https://example.com", "Content-Type": "application/json" };
      const codeResponse = await fetch(f.base + "/v1/clients/pair", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Fixture client" }) });
      assert.equal(codeResponse.status, 201);
      const code = await codeResponse.json() as any;
      const client = await (await fetch(f.base + "/client/exchange", { method: "POST", headers: { Origin: "https://example.com", "Content-Type": "application/json" }, body: JSON.stringify({ code: code.code }) })).json() as any;
      const ticketResponse = await fetch(f.base + "/v1/transcriptions/live-sessions", { method: "POST",
        headers: { ...ownerHeaders, Authorization: `Bearer ${client.token}` }, body: JSON.stringify({ requestId: "revoked-after-finish" }) });
      assert.equal(ticketResponse.status, 201);
      const ticket = await ticketResponse.json() as any;
      const socket = f.connect(ticket), ready = once(socket, "message"); await once(socket, "open"); await ready;
      const ack = new Promise<void>(resolve => socket.on("message", bytes => { if (JSON.parse(bytes.toString()).type === "ack") resolve(); }));
      socket.send(JSON.stringify({ type: "audio", seq: 0, audio: Buffer.alloc(4800).toString("base64") })); await ack;
      socket.send(JSON.stringify({ type: "finish", lastSeq: 0 })); await f.commitReceived;
      const revoke = await fetch(f.base + `/v1/clients/${client.clientId}`, { method: "DELETE", headers: ownerHeaders });
      assert.equal(revoke.status, 200);
      const afterRevocation: any[] = []; socket.on("message", bytes => afterRevocation.push(JSON.parse(bytes.toString())));
      const closed = once(socket, "close"); f.releaseProvider(lateType); await closed;
      assert.equal(afterRevocation.length, 0, "no partial, final or diagnostic crosses a revoked session");
      assert.equal(f.counts().cancellations, 1);
      assert.equal(Object.keys(f.app.store.state.tasks).length, 0);
    } finally { await f.cleanup(); }
  }
});

test("ticket theft, stream reordering and cancellation close without provider commit or task dispatch", async () => {
  const f = await fixture();
  try {
    const ticket = await (await f.post("bad-origin")).json() as any;
    const wrong = f.connect(ticket, "https://wrong.example");
    await assert.rejects(once(wrong, "open"), /401/);
    assert.equal(f.counts().starts, 0);
    const socket = f.connect(ticket), ready = once(socket, "message");
    await once(socket, "open"); await ready;
    const error = once(socket, "message"), closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "audio", seq: 1, audio: Buffer.alloc(4800).toString("base64") }));
    assert.equal(JSON.parse(String((await error)[0])).code, "invalid_audio_stream");
    await closed;
    assert.equal(f.audio.length, 0); assert.equal(f.counts().commits, 0);
    const cancelTicket = await (await f.post("cancel")).json() as any;
    const cancelled = f.connect(cancelTicket), cancelReady = once(cancelled, "message");
    await once(cancelled, "open"); await cancelReady;
    const cancelClosed = once(cancelled, "close"); cancelled.send(JSON.stringify({ type: "cancel" })); await cancelClosed;
    assert.equal(f.counts().commits, 0);
    assert.equal(Object.keys(f.app.store.state.tasks).length, 0);
  } finally { await f.cleanup(); }
});
