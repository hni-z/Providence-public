import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createHostedServer } from '../src/hosted/server.js';
import { AI_CONSENT_VERSION, Accounts } from '../src/hosted/accounts.js';
import { Workspaces } from '../src/hosted/workspaces.js';
import { LiveConversationManager } from '../src/hosted/live-conversation.js';
import { fixtureStepUp } from './fixtures/step-up.js';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'providence-ai-consent-')), origin = 'https://providence.fixture';
  writeFileSync(join(root, 'privacy.html'), '<html>Fixture privacy page</html>');
  const app = createHostedServer({ directory: root, origin, webRoot: root, encryptionKey: randomBytes(32) });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const account = app.accounts.create('Consent fixture'); app.accounts.setKey(account.id, 'synthetic-key-no-provider-use');
  const token = app.accounts.session(account.id);
  const headers = { Cookie: `__Host-providence=${token}`, Origin: origin, 'Content-Type': 'application/json' };
  const request = (path: string, body?: unknown, extra: Record<string, string> = {}) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
  });
  const paired = await request('/v1/clients/pair', { name: 'Consent Watch',
    stepUpToken: fixtureStepUp(app.accounts, token, 'pair_client', 'Consent Watch') });
  assert.equal(paired.status, 201);
  const code = (await paired.json() as { code: string }).code;
  const exchanged = await request('/client/exchange', { code }, { Cookie: '' });
  assert.equal(exchanged.status, 200);
  const client = (await exchanged.json() as { token: string }).token;
  return { root, origin, app, account, token, client, headers, base, request,
    cleanup: async () => { await app.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('existing account keys do not imply AI consent; owner and Watch submissions are blocked before admission', async () => {
  const f = await fixture();
  try {
    const state = await (await f.request('/auth/session')).json() as any;
    assert.equal(state.aiConsentRequired, true); assert.equal(state.aiConsentVersion, AI_CONSENT_VERSION);
    assert.equal(f.app.accounts.hasAIConsent(f.account.id), false);
    const identities: Record<string, string>[] = [{}, { Cookie: '', Authorization: `Bearer ${f.client}` }];
    for (const extra of identities)
      for (const path of ['/v1/messages', '/v1/chats', '/v1/chats/fixture/messages', '/v1/chats/fixture/messages/', '/v1//chats/fixture/messages', '/v1/chats//fixture//messages//',
        '/v1/approvals/fixture', '/v1/approvals//fixture/', '/v1/phone', '/v1/phone/fixture/resume/', '/v1/host-bridge/jobs',
        '/v1/host-bridge/jobs/fixture/claim', '/v1//host-bridge/jobs/fixture/start/', '/v1/tasks/fixture/artifacts/',
        '/v1/transcriptions', '/v1/transcriptions/live-sessions', '/v1/speech', '/v1/live-voice/sessions']) {
        const response = await f.request(path, { requestId: 'never-admitted', text: 'Private fixture' }, extra);
        assert.equal(response.status, 428, path);
        const error = await response.json() as any;
        assert.equal(error.errorCode, 'ai_consent_required'); assert.equal(error.aiConsentVersion, AI_CONSENT_VERSION);
      }
    assert.equal((await f.request('/auth/devices')).status, 200);
    assert.equal((await f.request('/auth/security')).status, 200);
    assert.equal((await f.request('/v1/tasks')).status, 200);
    const workspace = await f.app.workspaces.get(f.account.id);
    assert.equal(Object.keys(workspace.app.store.state.tasks).length, 0);
    const privacy = await fetch(f.base + '/privacy'); assert.equal(privacy.status, 200);
    assert.match(await privacy.text(), /Fixture privacy page/);
  } finally { await f.cleanup(); }
});

test('without consent a pending device approval cannot resume, while cancellation and reads remain available', async () => {
  const f = await fixture();
  try {
    const workspace = await f.app.workspaces.get(f.account.id);
    const chat = workspace.app.store.addChat('Existing fixture chat', 'fixture-device', 'fixture-thread');
    const task = workspace.app.store.createTask('old-fixture', chat.id, chat.deviceId, 'Existing work').task;
    workspace.app.store.update(task.id, { status: 'needs_input' });
    workspace.app.store.state.approvals.fixture = { id: 'fixture', taskId: task.id, deviceId: chat.deviceId,
      method: 'item/commandExecution/requestApproval', details: { availableDecisions: ['accept', 'cancel'] }, status: 'pending' };
    const calls: string[] = [];
    workspace.app.devices.call = async (_device, method) => { calls.push(method); return { resolved: true, interrupted: true }; };
    assert.equal((await f.request('/v1/approvals/fixture/', { decision: 'accept' })).status, 428);
    assert.deepEqual(calls, []);
    assert.equal((await f.request('/v1/tasks/' + task.id)).status, 200);
    assert.equal((await f.request(`/v1/tasks/${task.id}/cancel`, {})).status, 200);
    assert.deepEqual(calls, ['task.cancel']);
    assert.equal((await f.request('/v1/iphone-mirroring/jobs', {})).status, 404);
    assert.equal(workspace.app.phone.capability().executable, false);
    f.app.accounts.acceptAIConsent(f.account.id, AI_CONSENT_VERSION);
    assert.equal((await f.request('/v1/approvals/fixture/', { decision: 'accept' })).status, 200);
    assert.deepEqual(calls, ['task.cancel', 'approval.resolve'], 'the guarded route can resume a real device RPC once consent exists');
    const phone = await f.request('/v1/phone', { requestId: 'inert-phone-fixture', url: 'https://example.com/' });
    assert.equal(phone.status, 202);
    const job = await phone.json() as any; assert.equal(job.status, 'needs_input');
    const resumed = await f.request(`/v1/phone/${job.id}/resume`, {});
    assert.equal((await resumed.json() as any).status, 'needs_input');
    assert.deepEqual(calls, ['task.cancel', 'approval.resolve'], 'remoteOnly supplies no executable phone adapter');
  } finally { await f.cleanup(); }
});

test('consent requires explicit owner action, exact version, and same origin; it never changes another account', async () => {
  const f = await fixture();
  try {
    const body = { allow: true, version: AI_CONSENT_VERSION };
    assert.equal((await f.request('/auth/ai-consent', body, { Origin: '' })).status, 403);
    assert.equal((await f.request('/auth/ai-consent', body, { Origin: 'https://untrusted.fixture' })).status, 403);
    assert.equal((await f.request('/auth/ai-consent', body, { Cookie: '', Authorization: `Bearer ${f.client}` })).status, 401);
    assert.equal((await f.request('/auth/ai-consent', { allow: false, version: AI_CONSENT_VERSION })).status, 400);
    assert.equal((await f.request('/auth/ai-consent', { allow: true, version: 'old-version' })).status, 428);
    const other = f.app.accounts.create('Other account');
    assert.equal((await f.request('/auth/ai-consent', { ...body, accountId: other.id })).status, 400);
    const accepted = await f.request('/auth/ai-consent', body); assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { accepted: true, version: AI_CONSENT_VERSION });
    assert.equal(f.app.accounts.hasAIConsent(other.id), false);
    assert.equal((await (await f.request('/auth/session')).json() as any).aiConsentRequired, false);
    // After acceptance the request reaches normal route validation, without a provider call.
    assert.equal((await f.request('/v1/messages', { unsupported: 'invalid payload' })).status, 400);
    assert.equal((await f.request('/v1/messages', { unsupported: 'invalid payload' }, { Cookie: '', Authorization: `Bearer ${f.client}` })).status, 400);
    f.app.accounts.logout(f.token);
    assert.equal((await f.request('/auth/ai-consent', body)).status, 401);
  } finally { await f.cleanup(); }
});

test('internal hosted provider and live-session calls cannot bypass consent, and acceptance unblocks the same workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'providence-consent-provider-'));
  const accounts = new Accounts(join(root, 'accounts.sqlite'), randomBytes(32));
  const account = accounts.create('Internal fixture'); accounts.setKey(account.id, 'synthetic-key'); const raw = accounts.session(account.id);
  let providerCalls = 0;
  const workspaces = new Workspaces(root, 'https://providence.fixture', accounts, undefined, async () => {
    providerCalls++;
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Fixture response' }] }] });
  });
  const live = new LiveConversationManager(accounts, workspaces, { fetcher: async () => { throw new Error('Live provider must not be contacted'); } });
  try {
    const workspace = await workspaces.get(account.id);
    const thread = await workspace.app.master.create();
    const denied = once(workspace.app.master, 'event');
    await workspace.app.master.execute(thread.threadId, 'denied-fixture', 'No external processing'); await denied;
    await workspace.app.master.stopAndWait(); assert.equal(providerCalls, 0);
    await assert.rejects(live.create({ account: account.id, raw }, { sdp: 'v=0\r\n', chatId: 'master' }), (error: any) => error.errorCode === 'ai_consent_required');
    assert.equal(live.capability({ account: account.id, raw }).available, false);
    accounts.acceptAIConsent(account.id, AI_CONSENT_VERSION);
    await workspace.app.master.start();
    const completed = new Promise<void>((resolve, reject) => workspace.app.master.on('event', event => {
      if (event.type === 'task.completed' && event.taskId === 'allowed-fixture') resolve();
      if (event.type === 'task.failed' && event.taskId === 'allowed-fixture') reject(new Error(event.error));
    }));
    await workspace.app.master.execute(thread.threadId, 'allowed-fixture', 'Explicitly accepted processing'); await completed;
    assert.equal(providerCalls, 1); assert.equal(live.capability({ account: account.id, raw }).available, true);
  } finally { await live.close(); await workspaces.stop(); accounts.close(); rmSync(root, { recursive: true, force: true }); }
});
