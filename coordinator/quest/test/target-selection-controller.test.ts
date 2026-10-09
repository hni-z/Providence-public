import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { ApiError, ProvidenceApi } from '../src/api';
import { requestReadiness, submissionForSend, type PendingSubmission } from '../src/controller-state';
import type { Snapshot, Task } from '../src/types';

// Software-only controller regression. Execute main.ts's actual selection,
// refresh, readiness and dispatch functions plus the real ProvidenceApi adapter.
// Render/media callbacks are spies; fetch is replaced for every test and accepts
// only the explicit fake endpoints below. No browser, live service or device runs.
const source = ts.createSourceFile('main.ts', readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const names = new Set(['selectChat', 'chooseDevice', 'dataReady', 'canSend', 'chatName', 'refresh', 'withAction', 'dispatchText', 'sendMessage', 'retryPendingSubmission']);
const functions = source.statements.filter(statement => ts.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text));
assert.equal(functions.length, names.size, 'Harness must extract every current target-selection controller function');
const actualFunctions = functions.map(statement => statement.getText(source)).join('\n');

const FAKE_GRANT = 'fixture-browser-session-grant-only';
const PENDING_KEY = 'providence.quest.pending';
const MAC = { deviceId: 'fixture-demo-mac', chatId: 'fixture-demo-mac-chat', name: 'MOCK Demo MacBook', platform: 'darwin' };
const TARGETS = [
  { deviceId: 'fixture-review-mac', chatId: 'fixture-review-existing-chat', name: 'MOCK Review MacBook', platform: 'darwin' },
  { deviceId: 'fixture-demoPC', chatId: 'fixture-demoPC-existing-chat', name: 'MOCK DemoPC', platform: 'win32' },
] as const;
type Target = (typeof TARGETS)[number];

function snapshotFor(target: Target, online = true, includeChat = true): Snapshot {
  return {
    devices: [MAC, ...TARGETS].map(device => ({ id: device.deviceId, name: device.name, platform: device.platform, online: device.deviceId === target.deviceId ? online : true })),
    chats: [MAC, ...TARGETS].filter(device => includeChat || device.deviceId !== target.deviceId).map(device => ({ id: device.chatId, name: `${device.name} existing conversation`, deviceId: device.deviceId, online: true })),
    tasks: [], approvals: [],
  };
}

const previousFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
afterEach(() => {
  if (previousFetch) Object.defineProperty(globalThis, 'fetch', previousFetch);
  else Reflect.deleteProperty(globalThis, 'fetch');
});

interface ObservedRequest { path: string; method: string; bearer: string | null; body?: { requestId: string; text: string } }
interface HarnessController {
  selectChat(id: string): void;
  chooseDevice(id: string): void;
  refresh(): Promise<void>;
  dispatchText(text: string, chat: string): Promise<Task | undefined>;
  sendMessage(): Promise<void>;
  retryPendingSubmission(): Promise<void>;
  canSend(): boolean;
  setDraft(text: string): void;
  inspect(): { snapshot: Snapshot; selectedChat: string; selectedDevice: string; selectedTask: string; pendingSend?: PendingSubmission; api: ProvidenceApi; busy: boolean; draft: string; syncedAt: string; failures: unknown[] };
}

function controller(target: Target, pending?: PendingSubmission) {
  let server = snapshotFor(target);
  const requests: ObservedRequest[] = [];
  const storage = new Map<string, string>();
  if (pending) storage.set(PENDING_KEY, JSON.stringify(pending));
  const client = new ProvidenceApi(FAKE_GRANT);
  const counters = { renders: 0, voiceResets: 0, idAllocations: 0, completionChecks: 0 };
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async (input: string, init: RequestInit = {}) => {
    const path = String(input), method = init.method ?? 'GET', bearer = new Headers(init.headers).get('Authorization');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, bearer, ...(body ? { body } : {}) });
    assert.equal(bearer, `Bearer ${FAKE_GRANT}`, 'The same browser grant authenticates every catalog read and exact-chat write');
    assert.equal(init.mode, 'same-origin');
    assert.equal(init.cache, 'no-store');
    if (method === 'GET' && path === '/v1/devices') return response({ devices: server.devices });
    if (method === 'GET' && path === '/v1/chats') return response({ chats: server.chats });
    if (method === 'GET' && path === '/v1/tasks') return response({ tasks: server.tasks });
    if (method === 'GET' && path === '/v1/briefing') return response({ approvals: server.approvals });
    const taskRoute = /^\/v1\/tasks\/([^/]+)$/.exec(path);
    if (method === 'GET' && taskRoute) {
      const task = server.tasks.find(task => task.id === decodeURIComponent(taskRoute[1]));
      return response(task ?? {}, task ? 200 : 404);
    }
    const targetRoute = `/v1/chats/${encodeURIComponent(target.chatId)}/messages`;
    if (method === 'POST' && path === targetRoute) {
      const cached = server.tasks.find(task => task.chatId === target.chatId && 'requestId' in task && task.requestId === body.requestId);
      if (cached) return response(cached, 202);
      if (!requestReadiness(server, target.chatId).ready) return response({}, 409);
      const task = {
        id: `fixture-accepted-${requests.filter(request => request.method === 'POST').length}`,
        requestId: body.requestId, chatId: target.chatId, deviceId: target.deviceId,
        status: 'completed', prompt: body.text, text: 'MOCK acknowledgement only; no execution.',
        createdAt: '2026-09-20T06:00:00Z', updatedAt: '2026-09-20T06:00:00Z',
      };
      server.tasks.push(task);
      return response(task, 202);
    }
    throw new Error(`Unexpected fake endpoint ${method} ${path}`);
  } });
  const body = `
    let snapshot = initialSnapshot, api = client;
    let selectedChat = 'master', selectedDevice = '', selectedTask = '', pendingSend = initialPending;
    let generation = 1, alive = true, busy = false, syncedAt = '2026-09-20T06:00:00Z';
    let voiceRequest, spokenReplyId = '';
    const sessionStorage = {setItem(key,value){storage.set(key,value);},removeItem(key){storage.delete(key);}};
    const crypto = {randomUUID(){counters.idAllocations++; return 'fixture-new-request-' + counters.idAllocations;}};
    const elements = new Map();
    const $ = id => { if(!elements.has(id)) elements.set(id,{value:''}); return elements.get(id); };
    const microphone = {recording:false};
    const failures = [], notices = [];
    function resetVoice(){counters.voiceResets++;}
    function renderWorkspace(){counters.renders++;}
    function renderVoice(){} function renderSpatial(){} function discardAudio(){}
    function voiceBusy(){return false;}
    function maybeSpeakCompletion(){counters.completionChecks++;}
    function fail(error){failures.push(error);}
    function notice(message){notices.push(message);}
    function authClear(){throw new Error('Unexpected auth reset in target-selection fixture');}
    ${actualFunctions}
    return {
      selectChat,chooseDevice,refresh,dispatchText,sendMessage,retryPendingSubmission,canSend,
      setDraft(text){$('message').value=text;},
      inspect(){return {snapshot,selectedChat,selectedDevice,selectedTask,pendingSend,api,busy,draft:$('message').value,syncedAt,failures};}
    };
  `;
  const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const ui = new Function('initialSnapshot', 'client', 'initialPending', 'storage', 'counters', 'ApiError', 'requestReadiness', 'submissionForSend', compiled)(
    structuredClone(server), client, pending, storage, counters, ApiError, requestReadiness, submissionForSend,
  ) as HarnessController;
  return {
    ui, client, storage, requests, counters,
    server(value: Snapshot) { server = value; },
    cacheAccepted(pending: PendingSubmission) {
      const task = { id: 'fixture-cached-accepted-task', requestId: pending.requestId, chatId: pending.chatId, deviceId: target.deviceId,
        status: 'completed', prompt: pending.text, text: 'MOCK cached acknowledgement; no new execution.', createdAt: '2026-09-20T05:00:00Z', updatedAt: '2026-09-20T05:01:00Z' };
      server.tasks.push(task);
      return task;
    },
    posts: () => requests.filter(request => request.method === 'POST'),
    select() { ui.chooseDevice(target.deviceId); ui.selectChat(target.chatId); },
  };
}

for (const target of TARGETS) {
  test(`actual controller retains ${target.name} selection while offline and sends only its exact chat after restoration`, async () => {
    const h = controller(target);
    h.select();
    assert.equal(h.ui.inspect().selectedChat, target.chatId);
    assert.equal(h.ui.inspect().selectedDevice, target.deviceId);
    assert.equal(h.ui.canSend(), true);
    h.ui.setDraft('Check the selected workspace.');
    h.server(snapshotFor(target, false)); await h.ui.refresh();
    assert.equal(h.ui.inspect().snapshot.devices.find(device => device.id === MAC.deviceId)?.online, true);
    assert.equal(h.ui.inspect().selectedChat, target.chatId);
    assert.equal(h.ui.inspect().selectedDevice, target.deviceId);
    assert.equal(h.ui.canSend(), false);
    await h.ui.sendMessage();
    assert.equal(await h.ui.dispatchText('Directly guarded offline request', target.chatId), undefined);
    assert.equal(h.posts().length, 0);
    assert.equal(h.counters.idAllocations, 0);
    assert.equal(h.ui.inspect().draft, 'Check the selected workspace.');
    h.server(snapshotFor(target, true)); await h.ui.refresh();
    assert.equal(h.ui.inspect().selectedChat, target.chatId);
    assert.equal(h.ui.inspect().selectedDevice, target.deviceId);
    assert.equal(h.ui.canSend(), true);
    assert.equal(h.posts().length, 0, 'An online transition never auto-dispatches');
    await h.ui.sendMessage();
    assert.equal(h.posts().length, 1);
    assert.deepEqual(h.posts()[0], {
      path: `/v1/chats/${encodeURIComponent(target.chatId)}/messages`, method: 'POST', bearer: `Bearer ${FAKE_GRANT}`,
      body: { requestId: 'fixture-new-request-1', text: 'Check the selected workspace.' },
    });
    await h.ui.sendMessage();
    assert.equal(h.posts().length, 1, 'Consumed composer cannot submit again without new user text');
    assert.equal(h.ui.inspect().api, h.client);
    assert.equal(h.ui.inspect().pendingSend, undefined);
    assert.equal(h.ui.inspect().draft, '');
    assert.deepEqual(h.ui.inspect().failures, []);
    h.client.dispose();
  });

  test(`actual refresh preserves ${target.name} pending identity through offline and online before deliberate exact retry`, async () => {
    const pending = Object.freeze({ requestId: `fixture-pending-${target.deviceId}`, chatId: target.chatId, text: '  Keep this exact pending request.\n' });
    const h = controller(target, pending), stored = JSON.stringify(pending);
    h.select();
    for (const online of [false, true, false, true]) {
      h.server(snapshotFor(target, online)); await h.ui.refresh();
      assert.equal(h.ui.inspect().selectedChat, target.chatId);
      assert.equal(h.ui.inspect().selectedDevice, target.deviceId);
      assert.equal(h.ui.inspect().pendingSend, pending);
      assert.equal(h.storage.get(PENDING_KEY), stored);
      assert.equal(h.ui.inspect().api, h.client);
      assert.equal(h.posts().length, 0);
    }
    await h.ui.retryPendingSubmission();
    assert.equal(h.posts().length, 1);
    assert.deepEqual(h.posts()[0].body, { requestId: pending.requestId, text: pending.text });
    assert.equal(h.posts()[0].path, `/v1/chats/${encodeURIComponent(target.chatId)}/messages`);
    assert.equal(h.posts()[0].bearer, `Bearer ${FAKE_GRANT}`);
    assert.equal(h.counters.idAllocations, 0, 'Exact retry reuses the original request identity');
    assert.equal(h.ui.inspect().pendingSend, undefined);
    assert.equal(h.storage.has(PENDING_KEY), false);
    await h.ui.retryPendingSubmission();
    assert.equal(h.posts().length, 1);
    assert.deepEqual(h.ui.inspect().failures, []);
    h.client.dispose();
  });
}

test('a missing selected chat cannot redirect either composer or direct dispatch to Superagent or the online Mac', async () => {
  const target = TARGETS[0], h = controller(target);
  h.select(); h.ui.setDraft('Continue in the selected conversation.');
  h.server(snapshotFor(target, true, false)); await h.ui.refresh();
  assert.equal(h.ui.inspect().selectedChat, target.chatId);
  assert.equal(h.ui.inspect().selectedDevice, target.deviceId);
  assert.deepEqual(requestReadiness(h.ui.inspect().snapshot, target.chatId), { ready: false, reason: 'missing-chat' });
  await h.ui.sendMessage(); await h.ui.dispatchText('Never fall back', target.chatId);
  assert.equal(h.posts().length, 0);
  assert.equal(h.ui.inspect().draft, 'Continue in the selected conversation.');
  assert.equal(h.ui.inspect().pendingSend, undefined);
  assert.equal(h.ui.inspect().api, h.client);
  assert.deepEqual(h.ui.inspect().failures, []);
  h.client.dispose();
});

test('inspecting the online Mac does not change the explicitly selected DemoPC conversation or pending identity', async () => {
  const target = TARGETS[1], pending = Object.freeze({ requestId: 'fixture-original-demoPC-request', chatId: target.chatId, text: 'Original DemoPC text' });
  const h = controller(target, pending);
  h.select(); h.ui.chooseDevice(MAC.deviceId);
  h.server(snapshotFor(target, false)); await h.ui.refresh();
  assert.equal(h.ui.inspect().selectedDevice, MAC.deviceId);
  assert.equal(h.ui.inspect().selectedChat, target.chatId);
  assert.equal(h.ui.inspect().pendingSend, pending);
  assert.equal(h.storage.get(PENDING_KEY), JSON.stringify(pending));
  assert.equal(h.posts().length, 0);
  assert.equal(h.ui.inspect().api, h.client);
  h.client.dispose();
});

test('deliberate offline recovery resolves only the cached accepted request on its original chat and ID', async () => {
  const target = TARGETS[1], pending = Object.freeze({ requestId: 'fixture-accepted-before-offline', chatId: target.chatId, text: '  Original accepted text.\n' });
  const h = controller(target, pending);
  h.select(); h.server(snapshotFor(target, false));
  const accepted = h.cacheAccepted(pending);
  await h.ui.refresh();
  assert.equal(h.ui.inspect().selectedChat, target.chatId);
  assert.equal(h.ui.inspect().pendingSend, pending);
  assert.equal(h.posts().length, 0, 'Offline refresh does not attempt identity recovery automatically');
  assert.equal(h.ui.canSend(), false, 'Fresh composer sends remain disabled');
  await h.ui.retryPendingSubmission();
  assert.equal(h.posts().length, 1);
  assert.deepEqual(h.posts()[0], {
    path: `/v1/chats/${encodeURIComponent(target.chatId)}/messages`, method: 'POST', bearer: `Bearer ${FAKE_GRANT}`,
    body: { requestId: pending.requestId, text: pending.text },
  });
  assert.equal(h.ui.inspect().selectedTask, accepted.id);
  assert.equal(h.ui.inspect().snapshot.tasks.length, 1, 'Cached acknowledgement creates no second fake task');
  assert.equal(h.ui.inspect().pendingSend, undefined);
  assert.equal(h.counters.idAllocations, 0);
  assert.equal(h.ui.inspect().api, h.client);
  assert.deepEqual(h.ui.inspect().failures, []);
  h.client.dispose();
});
