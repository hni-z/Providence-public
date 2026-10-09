import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveSession, LiveSessionError } from '../web/src/live-conversation-client.js';

const session = { session: { id: 'live_fixture' }, transport: { type: 'webrtc', sdp: 'synthetic-answer' } };
test('live creation has a separate 30-second budget and exact account or private session credentials', async t => {
  const observed: { path: unknown; init?: RequestInit }[] = [], budgets: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (duration: number) => { budgets.push(duration); return new AbortController().signal; });
  t.mock.method(globalThis, 'fetch', async (path: unknown, init?: RequestInit) => {
    observed.push({ path, init }); return new Response(JSON.stringify(session), { headers: { 'Content-Type': 'application/json' } });
  });
  for (const token of ['providence-account-session', 'fixture-private'])
    assert.deepEqual(await createLiveSession(token, 'synthetic-offer', 'selected-chat', new AbortController().signal), session);
  assert.deepEqual(budgets, [30_000, 30_000]);
  assert.equal(observed.length, 2);
  for (const [index, request] of observed.entries()) {
    assert.equal(request.path, '/v1/live-voice/sessions');
    assert.equal(request.init?.mode, 'same-origin'); assert.equal(request.init?.redirect, 'error');
    assert.equal(request.init?.credentials, index === 0 ? 'same-origin' : 'omit');
    assert.deepEqual(JSON.parse(String(request.init?.body)), { sdp: 'synthetic-offer', chatId: 'selected-chat' });
  }
});
test('creation cancellation aborts the request with no retry and provider errors do not echo response content', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', (_path: unknown, init?: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
  });
  const controller = new AbortController();
  const waiting = createLiveSession('fixture-private', 'offer', 'master', controller.signal);
  controller.abort(); await assert.rejects(waiting, { name: 'AbortError' }); assert.equal(calls, 1);
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('private-provider-diagnostic', { status: 403 }); });
  await assert.rejects(createLiveSession('fixture-private', 'offer', 'master', new AbortController().signal), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /not authorized/); assert.doesNotMatch(error.message, /private-provider-diagnostic/); return true;
  });
  assert.equal(calls, 2);
});


test('safe voice error codes give actionable help without forwarding provider or proxy text', async t => {
  const cases = [
    { status: 503, code: 'api_key_rejected', match: /API key was rejected/ },
    { status: 503, code: 'model_access_denied', match: /access to live voice/ },
    { status: 429, code: 'insufficient_quota', match: /credit or spending limit/ },
    { status: 429, code: 'rate_limited', match: /temporarily limiting/ },
    { status: 504, code: 'upstream_timeout', match: /timed out/ },
    { status: 502, code: 'upstream_unavailable', match: /unavailable/ },
    { status: 401, code: undefined, match: /sign-in has expired/ },
    { status: 428, code: 'ai_consent_required', match: /Allow OpenAI processing/ },
  ];
  for (const entry of cases) {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ errorCode: entry.code, error: 'private-provider-diagnostic' }, { status: entry.status }); });
    await assert.rejects(createLiveSession('fixture-private', 'offer', 'master', new AbortController().signal), error => {
      assert.ok(error instanceof LiveSessionError); assert.equal(error.status, entry.status);
      assert.match(error.message, entry.match); assert.doesNotMatch(error.message, /private-provider-diagnostic/); return true;
    });
    assert.equal(calls, 1);
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(4097), { status: 502 }));
  await assert.rejects(createLiveSession('fixture-private', 'offer', 'master', new AbortController().signal), /could not connect/);
});
