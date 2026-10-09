import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHostedServer } from '../src/hosted/server.js';
import { AccountDeletion } from '../src/hosted/account-deletion.js';
import { Accounts } from '../src/hosted/accounts.js';
import { Workspaces } from '../src/hosted/workspaces.js';
import { fixtureStepUp } from './fixtures/step-up.js';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'providence-account-delete-'));
  const origin = 'https://providence.fixture';
  const app = createHostedServer({ directory: root, origin, encryptionKey: randomBytes(32) });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const account = app.accounts.create('Owner to delete'), other = app.accounts.create('Preserved owner');
  app.accounts.setKey(account.id, 'synthetic-key-never-used'); app.accounts.setKey(other.id, 'synthetic-other-key');
  const token = app.accounts.session(account.id), client = app.accounts.session(account.id, 'client'), otherToken = app.accounts.session(other.id);
  const headers = { Cookie: `__Host-providence=${token}`, Origin: origin, 'Content-Type': 'application/json' };
  return { root, app, account, other, token, client, otherToken, headers, base,
    post: (body: unknown, extra: Record<string, string> = {}) => fetch(base + '/auth/account/delete', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }),
    cleanup: async () => { await app.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('account deletion requires a fresh passkey proof bound to this session, action and account', async () => {
  const f = await fixture();
  try {
    const state = await (await fetch(f.base + '/auth/session', { headers: f.headers })).json() as any;
    assert.equal(state.accountId, f.account.id); assert.equal(state.accountDeletionAvailable, true);
    assert.equal((await f.post({ stepUpToken: 'invalid' })).status, 428);
    const wrongAction = fixtureStepUp(f.app.accounts, f.token, 'add_passkey');
    assert.equal((await f.post({ stepUpToken: wrongAction })).status, 428);
    const wrongAccount = fixtureStepUp(f.app.accounts, f.token, 'delete_account', f.other.id);
    assert.equal((await f.post({ stepUpToken: wrongAccount })).status, 428);
    const otherSession = f.app.accounts.session(f.account.id);
    const wrongSession = fixtureStepUp(f.app.accounts, otherSession, 'delete_account', f.account.id);
    assert.equal((await f.post({ stepUpToken: wrongSession })).status, 428);
    const valid = fixtureStepUp(f.app.accounts, f.token, 'delete_account', f.account.id);
    assert.equal((await f.post({ stepUpToken: valid }, { Origin: 'https://untrusted.fixture' })).status, 403);
    assert.equal((await f.post({ stepUpToken: valid }, { Cookie: '', Authorization: `Bearer ${f.client}` })).status, 401);
    assert.ok(f.app.accounts.get(f.account.id)); assert.ok(f.app.accounts.authenticate(f.token));
  } finally { await f.cleanup(); }
});

test('deletion revokes every account credential and deletes only its hosted directory, preserving other accounts and remote file targets', async () => {
  const f = await fixture();
  try {
    const workspace = await f.app.workspaces.get(f.account.id), otherWorkspace = await f.app.workspaces.get(f.other.id);
    const remote = join(f.root, 'synthetic-computer-files'); mkdirSync(remote); writeFileSync(join(remote, 'source.txt'), 'Keep source and local Codex state');
    symlinkSync(remote, join(workspace.app.directory, 'linked-computer-files'));
    const ownFile = join(workspace.app.directory, 'artifacts', 'returned-copy'); writeFileSync(ownFile, 'Delete hosted result copy');
    const otherFile = join(otherWorkspace.app.directory, 'preserved.txt'); writeFileSync(otherFile, 'Keep other account');
    f.app.accounts.db.prepare('INSERT INTO devices VALUES(?,?)').run('synthetic-device', f.account.id);
    const setup = f.app.setup.start(); f.app.setup.approve(setup.userCode, f.account.id);
    const grant = f.app.setup.poll(setup.deviceCode); assert.equal(grant.status, 'approved');
    const proof = fixtureStepUp(f.app.accounts, f.token, 'delete_account', f.account.id);
    const response = await f.post({ stepUpToken: proof });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: true, accessRevoked: true, cleanupPending: false, externalApiKeyRevoked: false, localFilesDeleted: false });
    assert.ok(response.headers.getSetCookie().some(value => value.includes('Max-Age=0')));
    assert.equal(f.app.accounts.get(f.account.id), undefined);
    assert.equal(f.app.accounts.authenticate(f.token), undefined); assert.equal(f.app.accounts.authenticate(f.client), undefined);
    assert.equal(f.app.accounts.authenticate(f.otherToken)?.account, f.other.id);
    assert.equal(f.app.accounts.db.prepare('SELECT id FROM devices WHERE id=?').get('synthetic-device'), undefined);
    assert.equal(existsSync(workspace.app.directory), false); assert.equal(existsSync(ownFile), false);
    assert.equal(readFileSync(join(remote, 'source.txt'), 'utf8'), 'Keep source and local Codex state');
    assert.equal(readFileSync(otherFile, 'utf8'), 'Keep other account');
    assert.throws(() => f.app.setup.poll(setup.deviceCode), /expired/);
    assert.throws(() => f.app.accounts.session(f.account.id), /active account/);
    assert.throws(() => f.app.accounts.setKey(f.account.id, 'cannot-restore-deleted-key'), /active account/);
    assert.deepEqual(f.app.accounts.pendingDeletions(), []);
  } finally { await f.cleanup(); }
});

test('access is revoked synchronously while active work drains, and delayed admissions cannot start work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'providence-account-delete-active-'));
  const accounts = new Accounts(join(root, 'accounts.sqlite'), randomBytes(32));
  const owner = accounts.create('Synthetic owner'); accounts.setKey(owner.id, 'synthetic-key'); const raw = accounts.session(owner.id);
  let providerCalls = 0;
  const workspaces = new Workspaces(root, 'https://providence.fixture', accounts, undefined, async () => { providerCalls++; throw new Error('No external provider calls'); });
  let release!: () => void; const stopped = new Promise<void>(resolve => { release = resolve; });
  const deletion = new AccountDeletion(accounts, workspaces, async () => {});
  try {
    const workspace = await workspaces.get(owner.id);
    const original = workspace.app.master.stopAndWait.bind(workspace.app.master);
    workspace.app.master.stopAndWait = async () => { await stopped; await original(); };
    const proof = fixtureStepUp(accounts, raw, 'delete_account', owner.id);
    const deleting = deletion.delete(raw, proof);
    assert.equal(accounts.authenticate(raw), undefined); assert.equal(accounts.get(owner.id), undefined);
    await assert.rejects(workspace.app.message({ requestId: 'late-request', text: 'Must not run' }), /stopping/);
    assert.throws(() => workspaces.get(owner.id), /API key/);
    assert.equal(existsSync(workspace.app.directory), true, 'files stay until old writers stop');
    release(); assert.equal((await deleting).deleted, true); assert.equal(existsSync(workspace.app.directory), false); assert.equal(providerCalls, 0);
  } finally { release(); await deletion.close(); await workspaces.stop(); accounts.close(); rmSync(root, { recursive: true, force: true }); }
});

test('failed cleanup remains durably revoked and resumes after service restart without regaining authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'providence-account-delete-retry-')), key = randomBytes(32), file = join(root, 'accounts.sqlite');
  let accounts = new Accounts(file, key);
  const owner = accounts.create('Delete private name'); accounts.setKey(owner.id, 'synthetic-key'); const raw = accounts.session(owner.id);
  let fail = true, removals = 0;
  const workspaces = { disable: async () => {}, removeDeletedAccountData: async () => { removals++; if (fail) throw new Error('Synthetic storage failure'); } } as unknown as Workspaces;
  let deletion = new AccountDeletion(accounts, workspaces, async () => {});
  try {
    const result = await deletion.delete(raw, fixtureStepUp(accounts, raw, 'delete_account', owner.id));
    assert.equal(result.deleted, false); assert.equal(result.cleanupPending, true); assert.equal(result.accessRevoked, true);
    assert.equal(accounts.authenticate(raw), undefined); assert.equal(accounts.get(owner.id), undefined);
    const tombstone = accounts.db.prepare('SELECT name,key,created,deleting FROM accounts WHERE id=?').get(owner.id);
    assert.deepEqual({ ...tombstone }, { name: '', key: null, created: 0, deleting: 1 });
    await deletion.close(); accounts.close();
    accounts = new Accounts(file, key); deletion = new AccountDeletion(accounts, workspaces, async () => {});
    fail = false; await deletion.retryPending();
    assert.equal(removals, 2); assert.deepEqual(accounts.pendingDeletions(), []); assert.equal(accounts.authenticate(raw), undefined);
  } finally { await deletion.close(); accounts.close(); rmSync(root, { recursive: true, force: true }); }
});

test('account deletion cannot remove a directory while an unconfirmed old writer still owns its store lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'providence-account-delete-lock-'));
  const accounts = new Accounts(join(root, 'accounts.sqlite'), randomBytes(32));
  const owner = accounts.create('Synthetic locked account'); accounts.setKey(owner.id, 'synthetic-key'); const raw = accounts.session(owner.id);
  const workspaces = new Workspaces(root, 'https://providence.fixture', accounts);
  const deletion = new AccountDeletion(accounts, workspaces, async () => {});
  try {
    const directory = join(root, 'workspaces', owner.id); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'state.lock'), String(process.pid)); writeFileSync(join(directory, 'history.txt'), 'Old writer is still active');
    const result = await deletion.delete(raw, fixtureStepUp(accounts, raw, 'delete_account', owner.id));
    assert.equal(result.cleanupPending, true); assert.equal(accounts.authenticate(raw), undefined);
    assert.equal(readFileSync(join(directory, 'history.txt'), 'utf8'), 'Old writer is still active');
    rmSync(join(directory, 'state.lock')); await deletion.retryPending();
    assert.equal(existsSync(directory), false); assert.deepEqual(accounts.pendingDeletions(), []);
  } finally { await deletion.close(); await workspaces.stop(); accounts.close(); rmSync(root, { recursive: true, force: true }); }
});

test('synchronous shutdown errors and transient retry-journal errors stay pending without uncaught background failures', async t => {
  const accounts = new Accounts(':memory:', randomBytes(32));
  const owner = accounts.create('Synthetic retry owner'), raw = accounts.session(owner.id);
  let shutdownFails = true, removals = 0;
  const workspaces = { disable: () => { if (shutdownFails) throw new Error('Synthetic shutdown failure'); return Promise.resolve(); },
    removeDeletedAccountData: async () => { removals++; } } as unknown as Workspaces;
  const deletion = new AccountDeletion(accounts, workspaces, async () => {});
  try {
    const result = await deletion.delete(raw, fixtureStepUp(accounts, raw, 'delete_account', owner.id));
    assert.equal(result.cleanupPending, true); assert.equal(accounts.authenticate(raw), undefined);
    const original = accounts.pendingDeletions.bind(accounts);
    let reads = 0;
    t.mock.method(accounts, 'pendingDeletions', () => { if (!reads++) throw new Error('Synthetic journal unavailable'); return original(); });
    await assert.doesNotReject(deletion.retryPending()); assert.equal(removals, 0);
    shutdownFails = false; await deletion.retryPending();
    assert.equal(removals, 1); assert.deepEqual(original(), []);
  } finally { await deletion.close(); accounts.close(); }
});
