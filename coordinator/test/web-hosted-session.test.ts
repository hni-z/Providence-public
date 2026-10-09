import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { api, artifactBlob, exchangeClientCode, HOSTED_ACCOUNT_SESSION } from "../web/src/api.js";
import { loadVoiceConfig, transcribeVoice } from "../web/src/voice-api.js";
import { createLiveVoiceAdapter, type LiveTranscriptionCapability } from "../web/src/live-voice-client.js";

const fixtureBearer = "fixture-explicit-client-token";
function assertAuthentication(init: RequestInit | undefined, token: string) {
  assert.equal(init?.credentials, token === HOSTED_ACCOUNT_SESSION ? "same-origin" : "omit");
  assert.equal(init?.mode, "same-origin"); assert.equal(init?.redirect, "error");
  assert.equal(init?.referrerPolicy, "same-origin");
  assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token}`);
  assert.equal(new Headers(init?.headers).has("Cookie"), false, "The browser controls its own session cookie");
}

for (const token of [HOSTED_ACCOUNT_SESSION, fixtureBearer, HOSTED_ACCOUNT_SESSION + "-invalid"]) {
  test(`API and event polling use ${token === HOSTED_ACCOUNT_SESSION ? "hosted cookies" : "explicit bearer only"}: ${token}`, async t => {
    const paths: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      assertAuthentication(init, token); paths.push(String(input)); return Response.json({ ok: true });
    });
    await api(token, "/devices");
    await api(token, "/events?after=42");
    await api(token, "/activity", { active: true });
    assert.deepEqual(paths, ["/v1/devices", "/v1/events?after=42", "/v1/activity"]);
  });

  test(`artifact download retains encoded local path and intended auth: ${token}`, async t => {
    const id = "file/../https://outside.example/report";
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      assertAuthentication(init, token);
      assert.equal(input, `/v1/artifacts/${encodeURIComponent(id)}/content`);
      return new Response("fixture report");
    });
    assert.equal(await (await artifactBlob(token, id)).text(), "fixture report");
  });

  test(`voice config and transcription retain intended auth: ${token}`, async t => {
    const paths: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      assertAuthentication(init, token); paths.push(String(input));
      return String(input) === "/v1/voice"
        ? Response.json({ configured: true, provider: "OpenAI", voice: "marin", deviceId: "fixture", maxSpeechChars: 4000, maxAudioBytes: 524288 })
        : Response.json({ id: "fixture-job", status: "completed", text: "Fixture transcript" });
    });
    await loadVoiceConfig(token, new AbortController().signal);
    assert.equal(await transcribeVoice(token, "fixture", new Blob(["fixture recording"], { type: "audio/webm" }), new AbortController().signal), "Fixture transcript");
    assert.deepEqual(paths, ["/v1/voice", "/v1/transcriptions"]);
  });

  test(`live voice ticket uses fixed same-origin route with intended auth: ${token}`, async () => {
    const capability: LiveTranscriptionCapability = { available: true, transport: "websocket", ticketPath: "/v1/transcriptions/live-sessions",
      websocketPath: "/v1/transcriptions/live", model: "gpt-live-transcribe", sampleRate: 24000, channels: 1, encoding: "pcm16le",
      maxDurationMs: 25000, maxAudioBytes: 1200000, maxChunkBytes: 4800 };
    let calls = 0;
    const adapter = createLiveVoiceAdapter(token, capability, {
      origin: "https://fixture.example", requestId: () => "fixture-request",
      fetcher: async (input, init) => {
        calls++; assert.equal(String(input), "https://fixture.example/v1/transcriptions/live-sessions"); assertAuthentication(init, token);
        return new Response(null, { status: 401 });
      },
      connect: () => assert.fail("Rejected ticket cannot open a socket"),
    });
    await assert.rejects(adapter({ signal: new AbortController().signal, onPartial() {} }), /Live transcription stopped/);
    assert.equal(calls, 1);
  });
}

test("untrusted API paths cannot escape the fixed coordinator prefix or reach another origin", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({}); });
  for (const path of ["https://outside.example/path", "//outside.example/path", "/../auth/logout", "/%2e%2e/auth/logout", "/devices\\outside", "/devices#fragment", "/devices\n"])
    await assert.rejects(api(HOSTED_ACCOUNT_SESSION, path), /coordinator-relative API path/);
  assert.equal(calls, 0);
});

test("client-code exchange always omits existing account cookies", async t => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(input, "/client/exchange"); assert.equal(init?.credentials, "omit");
    assert.equal(init?.mode, "same-origin"); assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    return Response.json({ token: fixtureBearer, expiresAt: "2099-01-01T00:00:00Z" });
  });
  assert.equal((await exchangeClientCode("FIXTURE-CODE")).token, fixtureBearer);
});

test("hosted browser helpers authenticate the actual workspace with the owner cookie without granting it to explicit bearer calls", async t => {
  const directory = mkdtempSync(join(tmpdir(), "providence-hosted-browser-auth-"));
  const origin = "https://providence.fixture";
  const app = createHostedServer({ directory, origin, encryptionKey: randomBytes(32), validateApiKey: async () => assert.fail("No provider validation in this test") });
  const account = app.accounts.create("Hosted browser fixture");
  app.accounts.setKey(account.id, "sk-test-fixture-" + "synthetic".repeat(5));
  const cookie = `__Host-providence=${app.accounts.session(account.id)}`;
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const local = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const address = new URL(typeof input === "string" || input instanceof URL ? input : input.url, origin);
    assert.equal(address.origin, origin, "No external provider calls are allowed in this test");
    const headers = new Headers(init?.headers);
    // Simulate a browser's session cookie jar while retaining real HTTP/server auth.
    if (init?.credentials === "same-origin") headers.set("Cookie", cookie);
    return realFetch(local + address.pathname + address.search, { ...init, headers });
  });
  try {
    const devices = await api<{ devices: unknown[] }>(HOSTED_ACCOUNT_SESSION, "/devices");
    assert.ok(Array.isArray(devices.devices));
    const events = await api<{ events: unknown[] }>(HOSTED_ACCOUNT_SESSION, "/events?after=0");
    assert.ok(Array.isArray(events.events));
    await assert.rejects(api(fixtureBearer, "/devices"), error => error instanceof Error && "status" in error && error.status === 401);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
