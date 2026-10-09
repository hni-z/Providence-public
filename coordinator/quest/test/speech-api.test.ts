import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, ProvidenceApi } from '../src/api';
import { MAX_SPEECH_BYTES } from '../../web/src/server-audio.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function config(provider: 'OpenAI' | 'ElevenLabs' = 'OpenAI') {
  return { provider, configured: true, speechConfigured: true, transcriptionConfigured: true,
    transcriptionProvider: provider, voice: provider === 'OpenAI' ? 'cedar' : 'mock-voice',
    deviceId: 'mock-mac', maxSpeechChars: 4000, maxAudioBytes: 524288 };
}

function audio(bytes: Uint8Array = new Uint8Array([73, 68, 51, 0])): Response {
  return new Response(new Uint8Array(bytes).buffer, { headers: { 'Content-Type': 'audio/mpeg' } });
}

function assertTransport(init?: RequestInit): void {
  assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer private-test-token');
  assert.equal(init?.cache, 'no-store');
  assert.equal(init?.credentials, 'omit');
  assert.equal(init?.mode, 'same-origin');
  assert.equal(init?.redirect, 'error');
  assert.ok(init?.signal instanceof AbortSignal);
}

test('voice configuration GET keeps independent speech and transcription providers and capabilities', async () => {
  for (const provider of ['OpenAI', 'ElevenLabs'] as const) {
    globalThis.fetch = async (path, init) => {
      assert.equal(path, '/v1/voice');
      assert.equal(init?.method, 'GET');
      assert.equal(init?.body, undefined);
      assertTransport(init);
      return json({ ...config(provider), configured: false, speechConfigured: false,
        transcriptionProvider: provider === 'OpenAI' ? 'ElevenLabs' : 'OpenAI', voice: null,
        reason: 'voice_id_required' });
    };
    const result = await new ProvidenceApi('private-test-token').voiceConfig();
    assert.equal(result.provider, provider);
    assert.equal(result.speechConfigured, false);
    assert.equal(result.transcriptionConfigured, true);
    assert.equal(result.transcriptionProvider, provider === 'OpenAI' ? 'ElevenLabs' : 'OpenAI');
    assert.equal(result.voice, null);
    assert.equal(result.reason, 'voice_id_required');
  }
});

test('voice configuration accepts legacy OpenAI metadata and rejects malformed metadata safely', async () => {
  const api = new ProvidenceApi('private-test-token');
  globalThis.fetch = async () => json({ provider: 'OpenAI', configured: true,
    deviceId: 'mock-mac', voice: 'cedar', maxSpeechChars: 4000, maxAudioBytes: 524288 });
  const legacy = await api.voiceConfig();
  assert.equal(legacy.provider, 'OpenAI');
  assert.equal(legacy.speechConfigured, true);
  for (const value of [null, {}, { ...config(), provider: 'Unknown' }, { ...config(), speechConfigured: 'yes' }]) {
    globalThis.fetch = async () => json(value);
    await assert.rejects(api.voiceConfig(), (error: unknown) => error instanceof ApiError && error.code === 'invalid_response');
  }
  globalThis.fetch = async () => new Response('<html>private-test-token</html>', { headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(api.voiceConfig(), (error: unknown) => error instanceof ApiError && error.code === 'invalid_response' && !error.message.includes('private-test-token'));
});

test('speech sends only text and caller request identity and returns bounded MPEG bytes', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (path, init) => {
    assertTransport(init);
    assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json');
    calls.push(`${init?.method} ${path}`);
    assert.deepEqual(JSON.parse(String(init?.body)), { requestId: 'mock-request', text: ' Exact text. ' });
    return audio();
  };
  const result = await new ProvidenceApi('private-test-token').speech(' Exact text. ', 'mock-request');
  assert.equal(result.type, 'audio/mpeg');
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), new Uint8Array([73, 68, 51, 0]));
  assert.deepEqual(calls, ['POST /v1/speech']);
});

test('invalid speech text and identities are rejected before any provider request', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return audio(); };
  const api = new ProvidenceApi('private-test-token');
  for (const [text, requestId] of [['', 'id'], ['   ', 'id'], ['a'.repeat(4001), 'id'], ['hello', ''], ['hello', 'id'.repeat(129)]]) {
    await assert.rejects(api.speech(text, requestId), (error: unknown) => error instanceof ApiError && error.code === 'invalid_speech');
  }
  assert.equal(calls, 0);
  await api.speech('a'.repeat(4000), 'mock-request');
  assert.equal(calls, 1);
});

test('invalid MIME, empty audio and oversized audio fail without reflecting server response bodies', async () => {
  const api = new ProvidenceApi('private-test-token');
  for (const response of [
    new Response('private-test-token', { headers: { 'Content-Type': 'text/html' } }),
    new Response('', { headers: { 'Content-Type': 'audio/mpeg' } }),
    new Response(new Uint8Array(MAX_SPEECH_BYTES + 1), { headers: { 'Content-Type': 'audio/mpeg' } }),
    new Response('small', { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(MAX_SPEECH_BYTES + 1) } }),
  ]) {
    globalThis.fetch = async () => response;
    await assert.rejects(api.speech('hello', 'mock-request'), (error: unknown) => error instanceof ApiError && error.code === 'invalid_response' && !error.message.includes('private-test-token'));
  }
});

test('speech never auto-retries a lost response and an explicit retry preserves exact identity', async () => {
  const bodies: string[] = [];
  globalThis.fetch = async (_path, init) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1) throw new Error('mock network failure private-test-token');
    return audio();
  };
  const api = new ProvidenceApi('private-test-token');
  await assert.rejects(api.speech('hello', 'retry-id'), (error: unknown) => error instanceof ApiError && error.code === 'connection_error' && !error.message.includes('private-test-token'));
  assert.equal(bodies.length, 1);
  await api.speech('hello', 'retry-id');
  assert.deepEqual(bodies, [JSON.stringify({ requestId: 'retry-id', text: 'hello' }), JSON.stringify({ requestId: 'retry-id', text: 'hello' })]);
});

test('pre-aborted requests and disposed clients never request speech or configuration', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return audio(); };
  const api = new ProvidenceApi('private-test-token');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.speech('hello', 'mock-request', controller.signal), { name: 'AbortError' });
  await assert.rejects(api.voiceConfig(controller.signal), { name: 'AbortError' });
  api.dispose();
  await assert.rejects(api.speech('hello', 'mock-request'), { name: 'AbortError' });
  await assert.rejects(api.voiceConfig(), { name: 'AbortError' });
  assert.equal(calls, 0);
});

for (const mode of ['caller abort', 'sign out'] as const) test(`${mode} aborts speech while the response body is still arriving`, async () => {
  const api = new ProvidenceApi('private-test-token');
  const controller = new AbortController();
  let cancelled = false;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(new Uint8Array([73, 68, 51])); },
    pull() { started(); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'audio/mpeg' } });
  const pending = api.speech('hello', 'mock-request', controller.signal);
  await reading;
  if (mode === 'caller abort') controller.abort(); else api.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});
