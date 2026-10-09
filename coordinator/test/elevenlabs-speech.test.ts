import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Speech, SpeechError } from '../src/speech.js';
import { loadSpeechConfig } from '../src/voice-config.js';
import { configSchema } from '../src/config.js';
import { Coordinator } from '../src/coordinator.js';
import { createHttpServer } from '../src/server.js';
import { parseVoiceConfig, type VoiceConfig } from '../web/src/voice-config.js';

const loadElevenLabsKey = (file?: string, environment?: { ELEVENLABS_API_KEY?: string }) =>
  loadSpeechConfig({ speechProvider: 'elevenlabs', speechEnvFile: file }, environment).apiKey;
const hasServerTranscription = (config: unknown) => config === null ? false : parseVoiceConfig(config).transcriptionConfigured;

const secret = 'fixture-elevenlabs-private-credential';
function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'providence-elevenlabs-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'speech.env');
  writeFileSync(file, `ELEVENLABS_API_KEY=${secret}\n`, { mode: 0o600 });
  return { directory, file, config: { speechProvider: 'elevenlabs' as const, speechEnvFile: file, elevenLabsVoiceId: 'fixture_voice' } };
}
const status = (expected: number) => (error: unknown) => error instanceof SpeechError && error.status === expected && !error.message.includes(secret);
// Creating a symlink on Windows requires a privilege the test process may not hold.
const symlinked = (target: string, path: string) => {
  try { symlinkSync(target, path); return true; }
  catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
};

test('ElevenLabs uses only server credentials and the fixed MP3 contract; input and replay are bounded', async t => {
  const f = fixture(t); let calls = 0;
  const speech = new Speech(f.config, async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.elevenlabs.io/v1/text-to-speech/fixture_voice/stream?output_format=mp3_44100_128');
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'error');
    const headers = new Headers(options?.headers);
    assert.equal(headers.get('xi-api-key'), secret);
    assert.equal(headers.has('authorization'), false);
    assert.deepEqual(JSON.parse(String(options?.body)), { model_id: 'eleven_flash_v2_5', text: 'The task is complete.' });
    return new Response(new Uint8Array([73, 68, 51]), { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  assert.equal(speech.provider, 'ElevenLabs'); assert.equal(speech.configured, true);
  assert.equal(JSON.stringify(speech).includes(secret), false);
  for (const input of [{ requestId: 'blank', text: ' ' }, { requestId: 'long', text: 'x'.repeat(4001) }, { requestId: 'override', text: 'hi', voice: 'other' }])
    await assert.rejects(speech.synthesize(input), status(400));
  assert.equal(calls, 0);
  assert.deepEqual(await speech.synthesize({ requestId: 'reply', text: 'The task is complete.' }), Buffer.from('ID3'));
  await assert.rejects(speech.synthesize({ requestId: 'reply', text: 'The task is complete.' }), status(409));
  assert.equal(calls, 1);
});

test('speech keys come only from the explicitly selected source and local file errors are sanitized', t => {
  const f = fixture(t);
  assert.equal(loadElevenLabsKey(f.file, { ELEVENLABS_API_KEY: 'different-private-credential' }), secret);
  writeFileSync(f.file, 'OPENAI_API_KEY=unrelated-private-credential\n');
  assert.equal(loadElevenLabsKey(f.file, { ELEVENLABS_API_KEY: secret }), undefined);
  assert.equal(loadElevenLabsKey(undefined, { ELEVENLABS_API_KEY: secret }), secret);
  assert.equal(loadElevenLabsKey(undefined, { ELEVENLABS_API_KEY: 'bad key' }), undefined);
  assert.throws(() => loadElevenLabsKey('relative.env'), /absolute local path/);
  assert.throws(() => loadElevenLabsKey(join(f.directory, 'missing.env')), e => e instanceof Error && !e.message.includes(f.directory));
  const linked = join(f.directory, 'linked.env');
  if (symlinked(f.file, linked)) assert.throws(() => loadElevenLabsKey(linked), /Unable to read/);
});

test('ElevenLabs requires its own key and a configured voice without fallback to OpenAI', async t => {
  const f = fixture(t); let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error('must not call'); };
  for (const voice of [undefined, '../another-endpoint']) {
    const speech = new Speech({ ...f.config, elevenLabsVoiceId: voice }, fetcher);
    assert.equal(speech.configured, false);
    await assert.rejects(speech.synthesize({ requestId: 'missing', text: 'Hello' }), status(503));
  }
  writeFileSync(f.file, 'OPENAI_API_KEY=fixture-openai-credential\n');
  const missing = new Speech(f.config, fetcher);
  assert.equal(missing.configured, false);
  await assert.rejects(missing.synthesize({ requestId: 'missing', text: 'Hello' }), status(503));
  assert.equal(calls, 0);
});

test('ElevenLabs failures never leak provider bodies or replay uncertain requests', async t => {
  const f = fixture(t);
  for (const upstream of [401, 402, 403, 404, 422, 429, 503]) {
    let calls = 0;
    const speech = new Speech(f.config, async () => { calls++; return new Response(secret, { status: upstream }); });
    await assert.rejects(speech.synthesize({ requestId: 'failed', text: 'Hello' }), status(upstream === 429 ? 429 : upstream === 402 ? 402 : 503));
    await assert.rejects(speech.synthesize({ requestId: 'failed', text: 'Hello' }), status(409));
    assert.equal(calls, 1);
  }
});

test('empty, incorrect and oversized ElevenLabs audio responses are rejected', async t => {
  const f = fixture(t);
  for (const response of [new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    new Response(new Uint8Array(), { headers: { 'Content-Type': 'audio/mpeg' } }),
    new Response(new Uint8Array(4 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'audio/mpeg' } })]) {
    const speech = new Speech(f.config, async () => response);
    await assert.rejects(speech.synthesize({ requestId: 'invalid', text: 'Hello' }), status(502));
  }
});

test('stopping ElevenLabs aborts the only attempt; concurrent replies and late retries are blocked', async t => {
  const f = fixture(t); let calls = 0; let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const speech = new Speech(f.config, async (_url, options) => {
    calls++; started();
    return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error(secret)), { once: true }));
  });
  const alreadyStopped = new AbortController(); alreadyStopped.abort();
  await assert.rejects(speech.synthesize({ requestId: 'never-start', text: 'Hello' }, alreadyStopped.signal), status(499));
  assert.equal(calls, 0);
  const controller = new AbortController();
  const pending = speech.synthesize({ requestId: 'stopped', text: 'Hello' }, controller.signal);
  await ready;
  await assert.rejects(speech.synthesize({ requestId: 'concurrent', text: 'Hello' }), status(409));
  controller.abort();
  await assert.rejects(pending, status(499));
  await assert.rejects(speech.synthesize({ requestId: 'stopped', text: 'Hello' }), status(409));
  assert.equal(calls, 1);
});

test('a long voice session keeps synthesizing while recent identities stay single-use', async t => {
  const f = fixture(t); let calls = 0;
  const speech = new Speech(f.config, async () => { calls++; return new Response(new Uint8Array([73, 68, 51]), { headers: { 'Content-Type': 'audio/mpeg' } }); });
  for (let index = 0; index < 513; index++)
    assert.deepEqual(await speech.synthesize({ requestId: `reply-${index}`, text: 'Hello' }), Buffer.from('ID3'));
  assert.equal(calls, 513);
  await assert.rejects(speech.synthesize({ requestId: 'reply-512', text: 'Hello' }), status(409));
  assert.equal(calls, 513);
});

test('authenticated capabilities report output separately from transcription without exposing the key or creating work', async t => {
  const f = fixture(t);
  const config = configSchema.parse({ clientToken: 't'.repeat(64), localDeviceId: 'mac', localDeviceName: 'Mac', workspace: f.directory, ...f.config });
  const app = new Coordinator(config, f.directory);
  const server = createHttpServer(app, config.clientToken);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    assert.equal((await fetch(origin + '/v1/voice')).status, 401);
    const response = await fetch(origin + '/v1/voice', { headers: { Authorization: `Bearer ${config.clientToken}` } });
    const value = await response.json() as VoiceConfig;
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(value.provider, 'ElevenLabs'); assert.equal(value.configured, true);
    assert.equal(value.transcriptionConfigured, false);
    // Legacy input size remains 512 KiB; output advertises its separate 4 MiB ceiling.
    assert.equal(value.maxAudioBytes, 524288);
    assert.equal(value.maxSpeechAudioBytes, 4194304);
    assert.equal(value.maxSpeechChars, 4000);
    assert.equal(hasServerTranscription(value), false);
    assert.equal(JSON.stringify(value).includes(secret), false);
    assert.equal(JSON.stringify(value).includes(f.file), false);
    assert.equal(Object.keys(app.store.state.tasks).length, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('client never infers input availability from ElevenLabs output configuration', () => {
  const base = { provider: 'ElevenLabs', configured: true, deviceId: 'mac', voice: 'fixture', maxSpeechChars: 4000, maxAudioBytes: 524288 };
  assert.equal(hasServerTranscription(base), false);
  assert.equal(hasServerTranscription({ ...base, transcriptionConfigured: true }), true);
  assert.equal(hasServerTranscription({ ...base, provider: 'OpenAI' }), true);
  assert.equal(hasServerTranscription({ ...base, provider: 'OpenAI', transcriptionConfigured: false }), false);
  assert.equal(hasServerTranscription(null), false);
});
