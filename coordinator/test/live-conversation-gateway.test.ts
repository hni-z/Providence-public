import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHostedServer } from '../src/hosted/server.js';
import { LiveConversationManager } from '../src/hosted/live-conversation.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'providence-live-gateway-'));
  const origin = 'https://providence.fixture';
  const app = createHostedServer({ directory, origin, encryptionKey: randomBytes(32) });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const account = app.accounts.create('Synthetic live voice account');
  app.accounts.setKey(account.id, 'synthetic-not-a-provider-key'); app.accounts.acceptAIConsent(account.id, '2026-10-02');
  const token = app.accounts.session(account.id), client = app.accounts.session(account.id, 'client');
  const headers = { Cookie: `__Host-providence=${token}`, Origin: origin, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown, values: Record<string, string> = headers) => fetch(base + path, { method: 'POST', headers: values, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { app, base, account, token, client, headers, post, cleanup: async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('live gateway rejects anonymous, client-scoped, cross-origin and malformed writes before provider creation', async t => {
  let creations = 0;
  t.mock.method(LiveConversationManager.prototype, 'create', async () => { creations++; return { session: { id: 'fixture' }, transport: { type: 'webrtc' as const, sdp: 'answer' } }; });
  const f = await fixture();
  try {
    const body = { sdp: 'v=0\r\nsynthetic', chatId: 'master' };
    const path = '/v1/live-voice/sessions';
    assert.equal((await f.post(path, body, { Origin: f.headers.Origin, 'Content-Type': 'application/json' })).status, 401);
    assert.equal((await f.post(path, body, { ...f.headers, Cookie: '', Authorization: `Bearer ${f.client}` })).status, 401);
    assert.equal((await f.post(path, body, { ...f.headers, Origin: '' })).status, 403);
    assert.equal((await f.post(path, body, { ...f.headers, Origin: 'https://untrusted.fixture' })).status, 403);
    assert.equal((await f.post(path, { ...body, sdp: 'not-sdp' })).status, 400);
    assert.equal((await f.post(path, { ...body, account: 'different-account' })).status, 400);
    assert.equal(creations, 0);
    assert.equal((await f.post(path, body)).status, 201); assert.equal(creations, 1);
  } finally { await f.cleanup(); }
});

test('the live gateway passes only the authenticated account and session to control operations', async t => {
  const owners: unknown[] = [], ids: string[] = [];
  t.mock.method(LiveConversationManager.prototype, 'heartbeat', (owner: unknown, id: string) => { owners.push(owner); ids.push(id); return {}; });
  t.mock.method(LiveConversationManager.prototype, 'end', async (owner: unknown, id: string) => { owners.push(owner); ids.push(id); return {}; });
  const f = await fixture();
  try {
    for (const action of ['heartbeat', 'end']) {
      assert.equal((await f.post(`/v1/live-voice/sessions/exact-handle/${action}`, {})).status, 200);
      assert.equal((await f.post(`/v1/live-voice/sessions/exact-handle/${action}`, { account: 'other' })).status, 400);
    }
    assert.deepEqual(ids, ['exact-handle', 'exact-handle']);
    assert.deepEqual(owners, [{ account: f.account.id, raw: f.token }, { account: f.account.id, raw: f.token }]);
    f.app.accounts.logout(f.token);
    assert.equal((await f.post('/v1/live-voice/sessions/exact-handle/end', {})).status, 401);
    assert.equal(owners.length, 2);
  } finally { await f.cleanup(); }
});

test('revocation while the gateway awaits a request body is rechecked by the real manager', async () => {
  const f = await fixture();
  try {
    // Server listeners run in registration order: auth has been read and the
    // async route is waiting on its body when this listener revokes the session.
    f.app.server.once('request', () => f.app.accounts.logout(f.token));
    const response = await f.post('/v1/live-voice/sessions', { sdp: 'v=0\r\nsynthetic', chatId: 'master' });
    assert.equal(response.status, 401);
    assert.match((await response.json() as { error: string }).error, /Sign in/);
  } finally { await f.cleanup(); }
});
