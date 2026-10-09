import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, ProvidenceApi } from '../src/api';
import { MicrophoneCapture } from '../src/audio';

const originals = new Map<string, PropertyDescriptor | undefined>();
function replace(name: string, value: unknown): void {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('snapshot reads four actual API resources with a private bearer and no caching', async () => {
  const observed: { path: string; init: RequestInit }[] = [];
  const bodies: Record<string, unknown> = {
    '/v1/devices': { devices: [{ id: 'demoPC', online: true }] },
    '/v1/chats': { chats: [{ id: 'remote', deviceId: 'demoPC' }] },
    '/v1/tasks': { tasks: [{ id: 'parent', status: 'completed', workStatus: 'running', childTaskIds: ['child'] }] },
    '/v1/briefing': { approvals: [{ id: 'specific-decision', taskId: 'child' }] },
  };
  replace('fetch', async (path: string, init: RequestInit) => { observed.push({ path, init }); return json(bodies[path]); });
  const api = new ProvidenceApi('private-test-token');
  const result = await api.snapshot();
  assert.equal(result.devices[0].id, 'demoPC');
  assert.equal(result.tasks[0].workStatus, 'running');
  assert.deepEqual(result.tasks[0].childTaskIds, ['child']);
  assert.equal(result.approvals[0].taskId, 'child');
  assert.equal(observed.length, 4);
  for (const { init } of observed) {
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer private-test-token');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.mode, 'same-origin');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
  }
  assert.equal(JSON.stringify(api).includes('private-test-token'), false);
});

test('send preserves request identity and exact text; scoped decisions and cancellation use the selected IDs', async () => {
  const observed: { path: string; body: unknown }[] = [];
  replace('fetch', async (path: string, init: RequestInit) => {
    observed.push({ path, body: JSON.parse(String(init.body)) });
    return json({ id: 'task' }, 202);
  });
  const api = new ProvidenceApi('test-token');
  await api.send(' Preserve my wording. ', 'master', 'identity-1');
  await api.send('Continue', 'chat with space', 'identity-2');
  await api.decide('approval-2', { answers: { choice: { answers: ['Friendly'] } } });
  await api.cancel('child-2');
  assert.deepEqual(observed, [
    { path: '/v1/messages', body: { requestId: 'identity-1', text: ' Preserve my wording. ' } },
    { path: '/v1/chats/chat%20with%20space/messages', body: { requestId: 'identity-2', text: 'Continue' } },
    { path: '/v1/approvals/approval-2', body: { answers: { choice: { answers: ['Friendly'] } } } },
    { path: '/v1/tasks/child-2/cancel', body: {} },
  ]);
});

test('hosted account mode uses its HttpOnly cookie without a bearer or credential exchange', async () => {
  const observed: { path: string; init: RequestInit }[] = [];
  replace('fetch', async (path: string, init: RequestInit) => {
    observed.push({ path, init });
    return json({ id: 'task' }, 202);
  });
  const api = new ProvidenceApi('', true);
  await api.send('One exact request', 'master', 'account-request');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].path, '/v1/messages');
  assert.equal(observed[0].init.credentials, 'same-origin');
  assert.equal(observed[0].init.mode, 'same-origin');
  assert.equal(observed[0].init.redirect, 'error');
  assert.equal(new Headers(observed[0].init.headers).has('Authorization'), false);
  api.dispose();
  await assert.rejects(api.send('No stale request'), { name: 'AbortError' });
});

test('failed submissions never auto-retry or reflect sensitive response content', async () => {
  let calls = 0;
  replace('fetch', async () => { calls++; throw new Error('private-test-token network details'); });
  const api = new ProvidenceApi('private-test-token');
  await assert.rejects(api.send('a', 'master', 'retained-id'), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'connection_error');
    assert.equal(error.message.includes('private-test-token'), false);
    return true;
  });
  assert.equal(calls, 1);
  replace('fetch', async () => json({ error: 'token private-test-token login-code secret' }, 401));
  await assert.rejects(api.send('a', 'master', 'retained-id'), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.match(error.message, /Sign in again/);
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
});

for (const accountSession of [true, false]) {
  test(`Quest ${accountSession ? 'account-cookie' : 'explicit-bearer'} reads and writes preserve the same-origin request policy`, async () => {
    const observed: string[] = [];
    replace('fetch', async (path: string, init: RequestInit) => {
      observed.push(`${init.method} ${path}`);
      assert.equal(init.referrerPolicy, 'same-origin', 'WebKit POSTs must not inherit the page no-referrer policy');
      assert.equal(init.mode, 'same-origin');
      assert.equal(init.redirect, 'error');
      assert.equal(init.credentials, accountSession ? 'same-origin' : 'omit');
      const headers = new Headers(init.headers);
      assert.equal(headers.get('Authorization'), accountSession ? null : 'Bearer fixture-token');
      assert.equal(headers.has('Cookie'), false, 'Only the browser supplies its account cookie');
      return json({ id: 'fixture-task' });
    });
    const api = new ProvidenceApi(accountSession ? '' : 'fixture-token', accountSession);
    await api.task('fixture-task');
    await api.send('Exact fixture request', 'master', 'fixture-request');
    await api.cancel('fixture-task');
    assert.deepEqual(observed, ['GET /v1/tasks/fixture-task', 'POST /v1/messages', 'POST /v1/tasks/fixture-task/cancel']);
    api.dispose();
  });
}

test('one-use exchange has no bearer and returns a temporary session without persisting it', async () => {
  replace('fetch', async (path: string, init: RequestInit) => {
    assert.equal(path, '/client/exchange');
    assert.equal(new Headers(init.headers).has('Authorization'), false);
    assert.deepEqual(JSON.parse(String(init.body)), { code: 'one-use-test-code' });
    return json({ token: 'temporary-token', expiresAt: '2026-09-19T12:00:00Z' });
  });
  assert.deepEqual(await ProvidenceApi.exchange('one-use-test-code'), { token: 'temporary-token', expiresAt: '2026-09-19T12:00:00Z' });
});

test('artifacts are authenticated binary bytes with their server MIME type', async () => {
  replace('fetch', async (path: string, init: RequestInit) => {
    assert.equal(path, '/v1/artifacts/file%201/content');
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer token');
    return new Response(new Uint8Array([0, 255, 128, 10]), { headers: { 'Content-Type': 'application/octet-stream' } });
  });
  const { blob } = await new ProvidenceApi('token').artifact('file 1');
  assert.equal(blob.type, 'application/octet-stream');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([0, 255, 128, 10]));
});

test('retained task IDs can be fetched after leaving the latest task list', async () => {
  replace('fetch', async (path: string) => {
    assert.equal(path, '/v1/tasks/older-child');
    return json({ id: 'older-child', parentTaskId: 'older-parent', status: 'completed' });
  });
  assert.equal((await new ProvidenceApi('token').task('older-child')).parentTaskId, 'older-parent');
});

test('new snapshots cancel stale ones and dispose cancels remaining requests', async () => {
  const pending: { signal: AbortSignal; resolve: (value: Response) => void; path: string }[] = [];
  replace('fetch', (path: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init.signal!;
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    pending.push({ path, signal, resolve });
  }));
  const api = new ProvidenceApi('token');
  const first = api.snapshot();
  const firstResult = assert.rejects(first, { name: 'AbortError' });
  const second = api.snapshot();
  assert.ok(pending.slice(0, 4).every((item) => item.signal.aborted));
  for (const item of pending.slice(4)) {
    item.resolve(json({ [item.path === '/v1/briefing' ? 'approvals' : item.path.slice(4)]: [] }));
  }
  await firstResult;
  assert.deepEqual(await second, { devices: [], chats: [], tasks: [], approvals: [] });
  const final = api.snapshot();
  const finalResult = assert.rejects(final, { name: 'AbortError' });
  api.dispose();
  await finalResult;
  await assert.rejects(api.send('a'), { name: 'AbortError' });
});

class FakeTrack extends EventTarget {
  enabled = true;
  readyState = 'live';
  stops = 0;
  stop() { this.stops++; this.readyState = 'ended'; }
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
}
class FakeStream {
  track = new FakeTrack();
  getTracks() { return [this.track]; }
  getAudioTracks() { return [this.track]; }
}
class FakeRecorder extends EventTarget {
  static instances: FakeRecorder[] = [];
  static isTypeSupported(type: string) { return type === 'audio/webm;codecs=opus'; }
  state = 'inactive';
  mimeType: string;
  stops = 0;
  constructor(readonly stream: FakeStream, options?: { mimeType: string }) {
    super(); this.mimeType = options?.mimeType ?? 'audio/webm'; FakeRecorder.instances.push(this);
  }
  start() { this.state = 'recording'; }
  stop() {
    this.stops++; this.state = 'inactive';
    queueMicrotask(() => {
      const event = new Event('dataavailable');
      Object.defineProperty(event, 'data', { value: new Blob(['actual-recording-bytes'], { type: this.mimeType }) });
      this.dispatchEvent(event); this.dispatchEvent(new Event('stop'));
    });
  }
}
function microphone(getUserMedia: (constraints: MediaStreamConstraints) => Promise<unknown>) {
  FakeRecorder.instances = [];
  replace('navigator', { mediaDevices: { getUserMedia }, userActivation: { isActive: true } });
  replace('MediaRecorder', FakeRecorder);
  replace('isSecureContext', true);
}

test('permission denial is not retried and does not manufacture an enabled microphone', async () => {
  let requests = 0;
  microphone(async () => { requests++; throw new DOMException('private device information', 'NotAllowedError'); });
  const states: string[] = [];
  const capture = new MicrophoneCapture((state) => states.push(state));
  assert.equal(capture.available(), true);
  await assert.rejects(capture.enable(), /permission denied/);
  assert.equal(requests, 1);
  assert.equal(capture.enabled, false);
  assert.throws(() => capture.start(), /Enable the microphone/);
  assert.equal(states.join(' ').includes('private device'), false);
  capture.dispose();
});

test('permission acquires muted audio; press starts, release immediately mutes and returns binary audio', async () => {
  const stream = new FakeStream();
  microphone(async (constraints) => { assert.deepEqual(constraints, { audio: true }); return stream; });
  const capture = new MicrophoneCapture(() => {});
  await capture.enable();
  assert.equal(capture.enabled, true);
  assert.equal(stream.track.enabled, false);
  assert.equal(FakeRecorder.instances.length, 0);
  capture.start();
  assert.equal(capture.recording, true);
  assert.equal(stream.track.enabled, true);
  const audio = capture.stop();
  assert.equal(stream.track.enabled, false);
  assert.equal(await (await audio)?.text(), 'actual-recording-bytes');
  assert.equal(FakeRecorder.instances[0].mimeType, 'audio/webm;codecs=opus');
  assert.equal(await capture.stop(), null);
  capture.dispose();
  assert.equal(stream.track.stops, 1);
});

test('cancel discards captured bytes and dispose stops tracks while a recording completes', async () => {
  const stream = new FakeStream();
  microphone(async () => stream);
  const capture = new MicrophoneCapture(() => {});
  await capture.enable();
  capture.start();
  const stopping = capture.stop();
  capture.cancel();
  assert.equal(await stopping, null);
  assert.equal(stream.track.enabled, false);
  capture.start();
  capture.dispose();
  assert.equal(await capture.stop(), null);
  assert.equal(stream.track.stops, 1);
  assert.equal(capture.enabled, false);
});

test('late permission after disposal stops every acquired track without enabling capture', async () => {
  let grant!: (stream: FakeStream) => void;
  const stream = new FakeStream();
  microphone(() => new Promise((resolve) => { grant = resolve; }));
  const states: string[] = [];
  const capture = new MicrophoneCapture((state) => states.push(state));
  const enabling = capture.enable();
  capture.dispose();
  grant(stream);
  await enabling;
  assert.equal(stream.track.enabled, false);
  assert.equal(stream.track.stops, 1);
  assert.equal(capture.enabled, false);
  assert.equal(states.includes('Microphone ready'), false);
});

test('disable releases tracks and allows a later explicit enable without stale permission restoring access', async () => {
  const staleStream = new FakeStream();
  const freshStream = new FakeStream();
  let grant!: (stream: FakeStream) => void;
  let calls = 0;
  microphone(async () => {
    calls++;
    if (calls === 1) return new Promise((resolve) => { grant = resolve; });
    return freshStream;
  });
  const capture = new MicrophoneCapture(() => {});
  const first = capture.enable();
  capture.disable();
  await capture.enable();
  grant(staleStream);
  await first;
  assert.equal(staleStream.track.stops, 1);
  assert.equal(freshStream.track.stops, 0);
  assert.equal(capture.enabled, true);
  capture.disable();
  assert.equal(freshStream.track.stops, 1);
  assert.equal(capture.enabled, false);
  capture.dispose();
});

test('an old recorder error cannot cancel a subsequent recording', async () => {
  const stream = new FakeStream();
  microphone(async () => stream);
  const capture = new MicrophoneCapture(() => {});
  await capture.enable();
  capture.start();
  const oldRecorder = FakeRecorder.instances[0];
  capture.cancel();
  capture.start();
  oldRecorder.dispatchEvent(new Event('error'));
  assert.equal(capture.recording, true);
  assert.equal(stream.track.enabled, true);
  assert.equal(await (await capture.stop())?.text(), 'actual-recording-bytes');
  capture.dispose();
});

test('a track ending discards recording and requires microphone re-enablement', async () => {
  const stream = new FakeStream();
  microphone(async () => stream);
  const states: string[] = [];
  const capture = new MicrophoneCapture((state) => states.push(state));
  await capture.enable();
  capture.start();
  stream.track.end();
  assert.equal(stream.track.enabled, false);
  assert.equal(capture.enabled, false);
  assert.equal(await capture.stop(), null);
  assert.match(states.at(-1)!, /disconnected/);
  capture.dispose();
});

test('the 30-second limit mutes capture and retains the completed recording for explicit stop', async () => {
  const stream = new FakeStream();
  microphone(async () => stream);
  let limit!: () => void;
  replace('setTimeout', (callback: () => void, milliseconds: number) => { assert.equal(milliseconds, 30_000); limit = callback; return 99; });
  replace('clearTimeout', () => {});
  const states: string[] = [];
  const capture = new MicrophoneCapture((state) => states.push(state));
  await capture.enable();
  capture.start();
  limit();
  assert.equal(stream.track.enabled, false);
  assert.equal(capture.recording, false);
  assert.equal(states.at(-1), 'Recording limit reached');
  assert.equal(await (await capture.stop())?.text(), 'actual-recording-bytes');
  capture.dispose();
});


test('a stalled snapshot expires without retry and permits a later read', async t => {
  let deadline = new AbortController(); let requests = 0;
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { assert.equal(milliseconds, 10_000); return deadline.signal; });
  replace('fetch', async (_path: string, init: RequestInit) => {
    requests++;
    return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  });
  const api = new ProvidenceApi('fixture-token');
  const pending = api.snapshot(); deadline.abort();
  await assert.rejects(pending, error => error instanceof ApiError && /timed out/.test(error.message));
  assert.equal(requests, 4, 'each snapshot resource is read once, never retried automatically');
  deadline = new AbortController();
  replace('fetch', async (path: string) => json({ [path.endsWith('/briefing') ? 'approvals' : path.split('/').at(-1)!]: [] }));
  assert.deepEqual(await api.snapshot(), { devices: [], chats: [], tasks: [], approvals: [] });
  api.dispose();
});

test('a malformed snapshot row is not returned to rendering or mistaken for empty data', async () => {
  replace('fetch', async (path: string) => json({ [path.endsWith('/briefing') ? 'approvals' : path.split('/').at(-1)!]: path.endsWith('/devices') ? [null] : [] }));
  const api = new ProvidenceApi('fixture-token');
  await assert.rejects(api.snapshot(), error => error instanceof ApiError && error.code === 'invalid_response');
  api.dispose();
});
