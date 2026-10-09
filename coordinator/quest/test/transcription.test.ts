import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, MAX_TRANSCRIPTION_BYTES, prepareTranscription, ProvidenceApi, type TranscriptionCapability, type TranscriptionRequest } from '../src/api';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
function capabilities(overrides: Partial<TranscriptionCapability> = {}) {
  return { transcription: {
    available: true,
    devices: [{ id: 'mock-worker', name: 'MOCK worker', online: true, configured: true }],
    mimeTypes: ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav'],
    maxAudioBytes: MAX_TRANSCRIPTION_BYTES, provider: 'OpenAI', ...overrides,
  } };
}
function job(input: Partial<{ id: string; requestId: string; deviceId: string; status: string; text: string }> = {}) {
  return { id: 'mock-transcription', requestId: 'mock-request', deviceId: 'mock-worker', status: 'completed', text: 'MOCK transcript only', ...input };
}
const request: TranscriptionRequest = { requestId: 'mock-request', deviceId: 'mock-worker', base64: 'AAECA/8=', mimeType: 'audio/webm' };

test('capabilities retain the coordinator default and each actual worker provider separately', async () => {
  for (const provider of ['OpenAI', 'ElevenLabs'] as const) {
    globalThis.fetch = async () => json(capabilities({ provider, devices: [
      { id: 'openai-worker', name: 'OpenAI worker', online: true, configured: true, provider: 'OpenAI' },
      { id: 'elevenlabs-worker', name: 'ElevenLabs worker', online: true, configured: true, provider: 'ElevenLabs' },
      { id: 'legacy-worker', name: 'Legacy worker', online: true, configured: true },
      { id: 'unconfigured-worker', name: 'Unconfigured worker', online: true, configured: false },
    ] }));
    const result = await new ProvidenceApi('token').transcriptionCapabilities();
    assert.equal(result.provider, provider);
    assert.deepEqual(result.devices.map(({ id, provider }) => ({ id, provider })), [
      { id: 'openai-worker', provider: 'OpenAI' },
      { id: 'elevenlabs-worker', provider: 'ElevenLabs' },
      { id: 'legacy-worker', provider: 'OpenAI' },
      { id: 'unconfigured-worker', provider: undefined },
    ]);
  }
});

test('preparing audio normalizes recorder MIME parameters and preserves exact bytes and request identity', async () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 255]);
  const prepared = await prepareTranscription(new Blob([bytes], { type: 'Audio/WebM;codecs=opus' }), 'mock-worker', 'chosen-request-id');
  assert.deepEqual(prepared, { requestId: 'chosen-request-id', deviceId: 'mock-worker', base64: 'AAECA/8=', mimeType: 'audio/webm' });
  assert.deepEqual(new Uint8Array(Buffer.from(prepared.base64, 'base64')), bytes);
});

test('preparing audio rejects empty, unsupported and oversized blobs but accepts exactly 512 KiB', async () => {
  await assert.rejects(prepareTranscription(new Blob([], { type: 'audio/webm' }), 'worker'), (error: unknown) => error instanceof ApiError && error.code === 'invalid_audio');
  await assert.rejects(prepareTranscription(new Blob(['audio'], { type: 'text/plain' }), 'worker'), (error: unknown) => error instanceof ApiError && error.status === 415);
  await assert.rejects(prepareTranscription(new Blob(['audio']), 'worker'), (error: unknown) => error instanceof ApiError && error.status === 415);
  await assert.rejects(prepareTranscription(new Blob([new Uint8Array(MAX_TRANSCRIPTION_BYTES + 1)], { type: 'audio/webm' }), 'worker'), (error: unknown) => error instanceof ApiError && error.status === 413);
  const exact = await prepareTranscription(new Blob([new Uint8Array(MAX_TRANSCRIPTION_BYTES)], { type: 'audio/wav' }), 'worker');
  assert.equal(Buffer.from(exact.base64, 'base64').byteLength, MAX_TRANSCRIPTION_BYTES);
  assert.match(exact.requestId, /^[0-9a-f-]{36}$/);
});

test('unavailable capabilities return safely and block every upload', async () => {
  const methods: string[] = [];
  globalThis.fetch = async (_path, init) => { methods.push(init!.method!); return json(capabilities({ available: false })); };
  const api = new ProvidenceApi('test-private-token');
  assert.equal((await api.transcriptionCapabilities()).available, false);
  await assert.rejects(api.transcribe(request), (error: unknown) => error instanceof ApiError && error.code === 'transcription_unavailable');
  assert.deepEqual(methods, ['GET', 'GET']);
});

test('missing or malformed capability routes fail closed without posting audio', async () => {
  const malformed: unknown[] = [
    {}, { transcription: null }, capabilities({ available: 'true' as unknown as boolean }),
    capabilities({ maxAudioBytes: 0 }), capabilities({ maxAudioBytes: MAX_TRANSCRIPTION_BYTES + 1 }),
    capabilities({ mimeTypes: [] }), capabilities({ mimeTypes: ['audio/made-up'] }),
    capabilities({ devices: [{ id: 'mock-worker', name: 'MOCK', online: true, configured: 'yes' as unknown as boolean }] }),
    capabilities({ devices: [
      { id: 'mock-worker', name: 'MOCK A', online: true, configured: true },
      { id: 'mock-worker', name: 'MOCK B', online: false, configured: true },
    ] }),
    { transcription: { ...capabilities().transcription, provider: 'Unknown' } },
    { transcription: { ...capabilities().transcription, devices: [{ id: 'mock-worker', name: 'MOCK', online: true, configured: true, provider: 'Unknown' }] } },
    { transcription: { ...capabilities().transcription, devices: [{ id: 'mock-worker', name: 'MOCK', online: true, configured: true, provider: null }] } },
  ];
  const api = new ProvidenceApi('test-private-token');
  for (const body of malformed) {
    const methods: string[] = [];
    globalThis.fetch = async (_path, init) => { methods.push(init!.method!); return json(body); };
    await assert.rejects(api.transcribe(request), (error: unknown) => error instanceof ApiError && error.code === 'invalid_response');
    assert.deepEqual(methods, ['GET']);
  }
  const methods: string[] = [];
  globalThis.fetch = async (_path, init) => { methods.push(init!.method!); return json({ error: 'private server details test-private-token' }, 404); };
  await assert.rejects(api.transcribe(request), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 404);
    assert.equal(error.message.includes('test-private-token'), false);
    return true;
  });
  assert.deepEqual(methods, ['GET']);
});

test('fresh capability checks block offline, unconfigured, missing workers, unsupported MIME and smaller service limits', async () => {
  const rejected = [
    capabilities({ devices: [{ id: 'mock-worker', name: 'MOCK', online: false, configured: true }] }),
    capabilities({ devices: [{ id: 'mock-worker', name: 'MOCK', online: true, configured: false }] }),
    capabilities({ devices: [] }),
    capabilities({ mimeTypes: ['audio/mp4'] }),
    capabilities({ maxAudioBytes: 4 }),
  ];
  const api = new ProvidenceApi('token');
  for (const capability of rejected) {
    const methods: string[] = [];
    globalThis.fetch = async (_path, init) => { methods.push(init!.method!); return json(capability); };
    await assert.rejects(api.transcribe(request), ApiError);
    assert.deepEqual(methods, ['GET']);
  }
});

for (const provider of ['OpenAI', 'ElevenLabs'] as const) test(`${provider} transcription POST preserves the exact authenticated request`, async () => {
  const calls: { path: string; method: string; body?: string }[] = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), method: init!.method!, ...(init!.body === undefined ? {} : { body: String(init!.body) }) });
    assert.equal(new Headers(init!.headers).get('Authorization'), 'Bearer private-test-token');
    assert.equal(init!.cache, 'no-store');
    assert.equal(init!.credentials, 'omit');
    assert.equal(init!.mode, 'same-origin');
    assert.equal(init!.redirect, 'error');
    if (init!.method === 'GET') return json(capabilities({ provider,
      devices: [{ id: 'mock-worker', name: 'MOCK worker', online: true, configured: true, provider }],
    }));
    assert.equal(new Headers(init!.headers).get('Content-Type'), 'application/json');
    return json(job(), 202);
  };
  const result = await new ProvidenceApi('private-test-token').transcribe(request);
  assert.equal(result.text, 'MOCK transcript only');
  assert.deepEqual(calls, [
    { path: '/v1/transcriptions', method: 'GET' },
    { path: '/v1/transcriptions', method: 'POST', body: JSON.stringify(request) },
  ]);
});

test('network failures do not auto-retry; manual retry rechecks capabilities and preserves body identity', async () => {
  const calls: string[] = [], bodies: string[] = [];
  globalThis.fetch = async (_path, init) => {
    calls.push(init!.method!);
    if (init!.method === 'GET') return json(capabilities());
    bodies.push(String(init!.body));
    if (bodies.length === 1) throw new Error('mock network failure with private-token');
    return json(job(), 202);
  };
  const api = new ProvidenceApi('private-token');
  await assert.rejects(api.transcribe(request), (error: unknown) => error instanceof ApiError && error.code === 'connection_error' && !error.message.includes('private-token'));
  assert.deepEqual(calls, ['GET', 'POST']);
  await api.transcribe(request);
  assert.deepEqual(calls, ['GET', 'POST', 'GET', 'POST']);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[1]).requestId, 'mock-request');
});

test('capability revocation prevents a manual retry from re-uploading', async () => {
  let gets = 0, posts = 0;
  globalThis.fetch = async (_path, init) => {
    if (init!.method === 'GET') return json(capabilities({ available: ++gets === 1 }));
    posts++; throw new Error('mock response lost');
  };
  const api = new ProvidenceApi('token');
  await assert.rejects(api.transcribe(request));
  await assert.rejects(api.transcribe(request), (error: unknown) => error instanceof ApiError && error.code === 'transcription_unavailable');
  assert.equal(gets, 2);
  assert.equal(posts, 1);
});

test('caller-created invalid or oversized requests are rejected before any upload', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json(capabilities()); };
  const api = new ProvidenceApi('token');
  const invalid = [
    { ...request, base64: '' }, { ...request, base64: 'not base64' },
    { ...request, mimeType: 'audio/webm;codecs=opus' }, { ...request, requestId: '' },
    { ...request, base64: Buffer.alloc(MAX_TRANSCRIPTION_BYTES + 1).toString('base64') },
  ];
  for (const input of invalid) await assert.rejects(api.transcribe(input), ApiError);
  assert.equal(calls, 0);
});

test('request fields are captured before capability await so mutation cannot change checked identity or worker', async () => {
  let grant!: (response: Response) => void;
  const mutable = { ...request };
  globalThis.fetch = async (_path, init) => {
    if (init!.method === 'GET') return new Promise<Response>((resolve) => { grant = resolve; });
    assert.deepEqual(JSON.parse(String(init!.body)), request);
    return json(job(), 202);
  };
  const result = new ProvidenceApi('token').transcribe(mutable);
  mutable.deviceId = 'other-worker'; mutable.requestId = 'different-request'; mutable.base64 = 'Zm9v';
  grant(json(capabilities()));
  assert.equal((await result).deviceId, 'mock-worker');
});

test('authenticated job polling validates matching IDs and permits terminal provider failures without another upload', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (path, init) => {
    calls.push(`${init!.method} ${path}`);
    assert.equal(new Headers(init!.headers).get('Authorization'), 'Bearer token');
    assert.equal(init!.cache, 'no-store');
    return json({ ...job({ id: 'job with space', status: 'failed', text: '' }), error: 'Mock provider unavailable', errorCode: 'unconfigured' });
  };
  const result = await new ProvidenceApi('token').transcriptionJob('job with space');
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'unconfigured');
  assert.deepEqual(calls, ['GET /v1/transcriptions/job%20with%20space']);
});

test('malformed, oversized or mismatched jobs are rejected instead of becoming transcripts', async () => {
  const api = new ProvidenceApi('token');
  for (const response of [
    {}, job({ status: 'running' }), { ...job(), status: ['completed'] },
    job({ text: 'a'.repeat(8001) }), { ...job(), text: undefined },
    { ...job(), requestId: '' }, { ...job(), error: { message: 'bad shape' } },
    job({ id: 'unrelated-job' }),
  ]) {
    globalThis.fetch = async () => json(response);
    await assert.rejects(api.transcriptionJob('mock-transcription'), (error: unknown) => error instanceof ApiError && error.code === 'invalid_response');
  }
  globalThis.fetch = async (_path, init) => json(init!.method === 'GET' ? capabilities() : job({ requestId: 'other-request' }), init!.method === 'GET' ? 200 : 202);
  await assert.rejects(api.transcribe(request), (error: unknown) => error instanceof ApiError && error.code === 'invalid_response');
  globalThis.fetch = async () => json(job({ text: 'a'.repeat(8000) }));
  assert.equal((await api.transcriptionJob('mock-transcription')).text.length, 8000);
});

test('aborting during capability lookup prevents the POST', async () => {
  const controller = new AbortController();
  const methods: string[] = [];
  globalThis.fetch = async (_path, init) => {
    methods.push(init!.method!);
    controller.abort();
    return json(capabilities());
  };
  await assert.rejects(new ProvidenceApi('token').transcribe(request, controller.signal), { name: 'AbortError' });
  assert.deepEqual(methods, ['GET']);
});
