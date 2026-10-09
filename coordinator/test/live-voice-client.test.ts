import test from "node:test";
import assert from "node:assert/strict";
import { createLiveVoiceAdapter, parseLiveTranscriptionCapability, type LiveTranscriptionCapability } from "../web/src/live-voice-client.js";
const capability: LiveTranscriptionCapability = { available: true, transport: "websocket", ticketPath: "/v1/transcriptions/live-sessions",
  websocketPath: "/v1/transcriptions/live", model: "gpt-live-transcribe", sampleRate: 24000, channels: 1, encoding: "pcm16le",
  maxDurationMs: 25000, maxAudioBytes: 1200000, maxChunkBytes: 4800 };
class Socket extends EventTarget {
  readyState = 1; bufferedAmount = 0; sent: any[] = []; closes = 0;
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.closes++; this.readyState = 3; this.dispatchEvent(new Event("close")); }
  receive(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture() {
  const socket = new Socket(), abort = new AbortController(), partials: string[] = [];
  let requests = 0, connections = 0; const requestId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const adapter = createLiveVoiceAdapter("fixture-app-credential", capability, { origin: "https://fixture.example", requestId: () => requestId,
    fetcher: async (url, options) => {
      requests++; assert.equal(String(url), "https://fixture.example/v1/transcriptions/live-sessions");
      assert.equal(new Headers(options?.headers).get("authorization"), "Bearer fixture-app-credential");
      assert.deepEqual(JSON.parse(String(options?.body)), { requestId }); assert.equal(options?.redirect, "error");
      return Response.json({ sessionId: "session", requestId, ticket: "fixture_one_use_ticket_only", expiresAt: "2099-01-01T00:00:00Z", websocketPath: capability.websocketPath }, { status: 201 });
    },
    connect: (url, protocols) => {
      connections++; assert.equal(url, "wss://fixture.example/v1/transcriptions/live");
      assert.deepEqual(protocols, ["providence-live-v1", "ticket.fixture_one_use_ticket_only"]);
      assert.equal(url.includes("ticket"), false); return socket as unknown as WebSocket;
    } });
  const open = () => adapter({ signal: abort.signal, onPartial: text => partials.push(text) });
  return { socket, abort, partials, open, counts: () => ({ requests, connections }) };
}
test("live capability is opt-in and requires the exact supported audio/protocol limits", () => {
  assert.equal(parseLiveTranscriptionCapability(undefined), undefined);
  assert.deepEqual(parseLiveTranscriptionCapability(capability), capability);
  for (const changed of [{ model: "other" }, { sampleRate: 16000 }, { encoding: "mp3" }, { ticketPath: "https://other.example" }, { maxChunkBytes: 999999 }])
    assert.equal(parseLiveTranscriptionCapability({ ...capability, ...changed }), undefined);
  assert.equal(parseLiveTranscriptionCapability({ ...capability, available: false })?.available, false);
});
test("unavailable live capability makes zero ticket or socket calls", async () => {
  let attempts = 0;
  const adapter = createLiveVoiceAdapter("fixture", { ...capability, available: false }, {
    origin: "https://fixture.example", fetcher: async () => { attempts++; throw new Error("must not fetch"); },
    connect: () => { attempts++; throw new Error("must not connect"); },
  });
  await assert.rejects(adapter({ signal: new AbortController().signal, onPartial() {} }));
  assert.equal(attempts, 0);
});
test("session waits for ready, partials stay display-only, and exact final follows one acknowledged commit", async () => {
  const f = fixture(); let prepared = false;
  const preparing = f.open().then(value => { prepared = true; return value; }); await flush();
  assert.equal(prepared, false); assert.equal(f.socket.sent.length, 0);
  f.socket.receive({ type: "ready", sessionId: "session" }); const session = await preparing;
  const audio = session.write(new Uint8Array([0, 1]).buffer, 0); await flush();
  assert.deepEqual(f.socket.sent, [{ type: "audio", seq: 0, audio: "AAE=" }]);
  f.socket.receive({ type: "partial", sessionId: "session", eventId: "partial-1", itemId: "item-1", contentIndex: 0, delta: "hello", text: "hello" });
  assert.deepEqual(f.partials, ["hello"]); assert.equal(f.socket.sent.some(message => message.type === "finish"), false);
  f.socket.receive({ type: "partial", sessionId: "session", itemId: "item-1", contentIndex: 0, delta: " world", text: "hello world" });
  assert.deepEqual(f.partials, ["hello", "hello world"], "provider event IDs are optional; cumulative text never becomes a task");
  f.socket.receive({ type: "ack", sessionId: "session", seq: 0 }); await audio;
  const final = session.finish(0); assert.equal(session.finish(0), final);
  f.socket.receive({ type: "final", sessionId: "session", eventId: "final-1", itemId: "item-1", text: "hello world" });
  assert.equal(await final, "hello world"); assert.equal(f.socket.sent.filter(message => message.type === "finish").length, 1);
  assert.deepEqual(f.counts(), { requests: 1, connections: 1 });
});
test("wrong-session events fail closed and never reconnect or expose provider diagnostics", async () => {
  const f = fixture(); const pending = f.open(); await flush();
  f.socket.receive({ type: "error", sessionId: "other", code: "private-code", message: "private-provider-token" });
  await assert.rejects(pending, error => error instanceof Error && !error.message.includes("private"));
  assert.deepEqual(f.counts(), { requests: 1, connections: 1 }); assert.equal(f.socket.closes, 1);
});
test("cancel fences a late final and sends no replay or new session", async () => {
  const f = fixture(); const pending = f.open(); await flush(); f.socket.receive({ type: "ready", sessionId: "session" });
  const session = await pending; const chunk = session.write(new ArrayBuffer(2), 0); f.socket.receive({ type: "ack", sessionId: "session", seq: 0 }); await chunk;
  const final = session.finish(0); f.abort.abort();
  f.socket.receive({ type: "final", sessionId: "session", eventId: "late", itemId: "late", text: "Do not submit" });
  await assert.rejects(final, { name: "AbortError" }); assert.deepEqual(f.counts(), { requests: 1, connections: 1 });
  assert.equal(f.socket.sent.filter(message => message.type === "cancel").length, 1);
});
test("finish before audio acknowledgement is refused and invalid chunk sequence never reaches wire", async () => {
  const f = fixture(); const pending = f.open(); await flush(); f.socket.receive({ type: "ready", sessionId: "session" }); const session = await pending;
  await assert.rejects(session.write(new ArrayBuffer(2), 4)); assert.equal(f.socket.sent.length, 0);
  const write = session.write(new ArrayBuffer(2), 0); await assert.rejects(session.finish(0));
  assert.equal(f.socket.sent.some(message => message.type === "finish"), false);
  f.socket.receive({ type: "ack", sessionId: "session", seq: 0 }); await write; session.cancel();
});
test("eight chunk window preserves ordered ACK integrity and commits only after all acknowledgements", async () => {
  const f = fixture(); const preparing = f.open(); await flush(); f.socket.receive({ type: "ready", sessionId: "session" }); const session = await preparing;
  const writes = Array.from({ length: 8 }, (_, sequence) => session.write(new ArrayBuffer(4800), sequence));
  assert.equal(f.socket.sent.length, 8);
  await assert.rejects(session.write(new ArrayBuffer(4800), 8));
  await assert.rejects(session.finish(7));
  for (let seq = 0; seq < 8; seq++) f.socket.receive({ type: "ack", sessionId: "session", seq });
  await Promise.all(writes);
  const final = session.finish(7); f.socket.receive({ type: "final", sessionId: "session", itemId: "item", text: "Window complete" });
  assert.equal(await final, "Window complete"); assert.equal(f.socket.sent.filter(value => value.type === "finish").length, 1);
});
test("out-of-order ACK rejects the entire pending window without audio replay", async () => {
  const f = fixture(); const preparing = f.open(); await flush(); f.socket.receive({ type: "ready", sessionId: "session" }); const session = await preparing;
  const pending = Promise.allSettled([session.write(new ArrayBuffer(2), 0), session.write(new ArrayBuffer(2), 1)]);
  f.socket.receive({ type: "ack", sessionId: "session", seq: 1 });
  assert.ok((await pending).every(result => result.status === "rejected"));
  await assert.rejects(session.finish(1)); assert.deepEqual(f.counts(), { requests: 1, connections: 1 });
  assert.equal(f.socket.sent.length, 2);
});
