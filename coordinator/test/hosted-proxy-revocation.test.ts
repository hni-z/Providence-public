import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createHostedServer } from '../src/hosted/server.js';

// A real loopback gateway/tenant request with a withheld body. No provider or device work.
test('revoking a session cuts off an already-authenticated HTTP body before it can dispatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'providence-proxy-revoke-'));
  const origin = 'https://providence.fixture';
  const app = createHostedServer({ directory, origin, encryptionKey: randomBytes(32) });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  let pending: ReturnType<typeof request> | undefined;
  try {
    const account = app.accounts.create('Synthetic account'); app.accounts.setKey(account.id, 'synthetic-fixture-key-only'); app.accounts.acceptAIConsent(account.id, '2026-10-02');
    const token = app.accounts.session(account.id);
    const workspace = await app.workspaces.get(account.id);
    let executions = 0;
    workspace.app.master.execute = async () => { executions++; return { turnId: 'synthetic-turn' }; };
    const receivedHeaders = once(workspace.server, 'request');
    const ended = new Promise<void>(resolve => {
      pending = request(base + '/v1/messages', { method: 'POST', headers: {
        Cookie: `__Host-providence=${token}`, Origin: origin, 'Content-Type': 'application/json',
      } }, response => { response.resume(); response.once('end', resolve); response.once('error', () => resolve()); });
      pending.once('error', () => resolve()); pending.once('close', resolve);
      pending.write('{"requestId":"revoked-slow-request","text":"Synthetic request');
    });
    await receivedHeaders;
    const logout = await fetch(base + '/auth/logout', { method: 'POST', headers: { Cookie: `__Host-providence=${token}`, Origin: origin }, body: '{}' });
    assert.equal(logout.status, 200); await logout.body?.cancel();
    pending!.end('"}');
    await ended;
    for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(executions, 0, 'a body completed after session revocation must not reach execution');
    assert.equal(workspace.app.store.findRequest('revoked-slow-request'), undefined);
  } finally { pending?.destroy(); await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
