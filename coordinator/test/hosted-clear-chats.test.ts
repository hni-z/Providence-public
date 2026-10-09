import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Accounts } from '../src/hosted/accounts.js';
import { ClearChatsError, Workspaces } from '../src/hosted/workspaces.js';
import { saveConfig } from '../src/config.js';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'providence-clear-chat-'));
  const accounts = new Accounts(join(root, 'accounts.sqlite'), randomBytes(32));
  const account = accounts.create('Synthetic account'); accounts.setKey(account.id, 'synthetic-provider-key');
  const owner = accounts.session(account.id), client = accounts.session(account.id, 'client');
  let providerCalls = 0;
  const workspaces = new Workspaces(root, 'https://providence.fixture', accounts, undefined, async () => { providerCalls++; throw new Error('No provider request is allowed'); });
  const workspace = await workspaces.get(account.id), dir = workspace.app.directory;
  workspace.app.config.devices.push({ id: 'fixture-computer', name: 'Fixture computer', token: 'synthetic-device-token-0000000000000000' });
  saveConfig(join(dir, 'config.json'), workspace.app.config);
  const chat = workspace.app.store.addChat('Old chat', 'fixture-computer', 'remote-codex-thread-keep');
  const { task } = workspace.app.store.createTask('old-request', chat.id, chat.deviceId, 'Private test prompt');
  workspace.app.store.update(task.id, { status: 'completed', text: 'Old response', workflowRequestAliases: ['old-alias'] });
  workspace.app.store.state.chats[chat.id].history.push({ role: 'user', text: 'Old chat history', taskId: task.id });
  workspace.app.store.state.masterThreadId = 'old-hosted-context';
  workspace.app.store.event({ type: 'fixture.history', text: 'Old event text' });
  writeFileSync(join(dir, 'coordination.json'), JSON.stringify({ 'old-hosted-context': [{ role: 'user', content: 'Old API history' }] }));
  writeFileSync(join(dir, 'coordination.json.tmp'), 'Old interrupted write');
  writeFileSync(join(dir, 'artifacts', 'returned-file'), 'Keep this file');
  writeFileSync(join(dir, 'client-sessions.json'), JSON.stringify([{ id: 'fixture-controller', name: 'Kept controller', hash: 'a'.repeat(64), createdAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' }]));
  const remote = join(root, 'user-workspace'); mkdirSync(remote); writeFileSync(join(remote, 'source.txt'), 'Preserve source code');
  return { root, accounts, account, owner, client, workspaces, workspace, dir, chat, task, remote,
    providerCalls: () => providerCalls,
    cleanup: async () => { await workspaces.stop(); accounts.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('clearing removes Providence history and recovery copy while preserving credentials, devices, and files', async () => {
  const f = await fixture();
  try {
    const config = readFileSync(join(f.dir, 'config.json')), key = f.accounts.get(f.account.id)!.key;
    const clientState = readFileSync(join(f.dir, 'client-sessions.json'));
    const beforeSequence = f.workspace.app.store.state.sequence;
    await f.workspaces.clearChats(f.account.id);
    for (const file of ['state.json', 'state.json.bak']) {
      const bytes = readFileSync(join(f.dir, file), 'utf8'), state = JSON.parse(bytes);
      assert.deepEqual(state.chats, {}); assert.deepEqual(state.tasks, {}); assert.deepEqual(state.events, []);
      assert.deepEqual(state.approvals, {}); assert.equal(state.masterThreadId, undefined);
      assert.equal(state.sequence, beforeSequence + 1); assert.equal(state.clearedRequestHashes.length, 2);
      assert.equal(bytes.includes('Old'), false); assert.equal(bytes.includes('old-request'), false);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'coordination.json'), 'utf8')), {});
    assert.equal(existsSync(join(f.dir, 'coordination.json.tmp')), false);
    assert.deepEqual(readFileSync(join(f.dir, 'config.json')), config);
    assert.equal(f.accounts.get(f.account.id)!.key, key);
    assert.equal(f.accounts.authenticate(f.owner)?.account, f.account.id); assert.equal(f.accounts.authenticate(f.client)?.account, f.account.id);
    assert.deepEqual(readFileSync(join(f.dir, 'client-sessions.json')), clientState);
    assert.equal(readFileSync(join(f.dir, 'artifacts', 'returned-file'), 'utf8'), 'Keep this file');
    assert.equal(readFileSync(join(f.remote, 'source.txt'), 'utf8'), 'Preserve source code');
    const fresh = await f.workspaces.get(f.account.id);
    assert.deepEqual(fresh.app.chats(), []);
    await assert.rejects(fresh.app.message({ requestId: 'old-request', text: 'Private test prompt' }), /cleared chat history/);
    assert.throws(() => fresh.app.store.createTask('old-alias', 'master', 'coordinator', 'Old alias retry'), /cleared chat history/);
    assert.equal(fresh.app.config.devices[0].id, 'fixture-computer'); assert.equal(f.providerCalls(), 0);
  } finally { await f.cleanup(); }
});

test('active queued running needs_input work and pending or resolving decisions refuse without a shutdown', async () => {
  const f = await fixture();
  try {
    let callbacks = 0;
    for (const status of ['queued', 'running', 'needs_input']) {
      f.workspace.app.store.update(f.task.id, { status });
      const state = readFileSync(join(f.dir, 'state.json'));
      await assert.rejects(f.workspaces.clearChats(f.account.id, async () => { callbacks++; }), error => error instanceof ClearChatsError && error.status === 409);
      assert.deepEqual(readFileSync(join(f.dir, 'state.json')), state);
      assert.strictEqual(await f.workspaces.get(f.account.id), f.workspace);
    }
    f.workspace.app.store.update(f.task.id, { status: 'completed' });
    for (const status of ['pending', 'resolving']) {
      f.workspace.app.store.state.approvals.fixture = { id: 'fixture', taskId: f.task.id, deviceId: 'fixture-computer', method: 'item/tool/requestUserInput', details: {}, status };
      f.workspace.app.store.save();
      await assert.rejects(f.workspaces.clearChats(f.account.id, async () => { callbacks++; }), /active work and questions/);
    }
    assert.equal(callbacks, 0); assert.equal(f.workspace.server.listening, true);
  } finally { await f.cleanup(); }
});

test('clear fences cached and new admissions, awaits voice cleanup and runtime quiescence, and rejects overlapping clears', async () => {
  const f = await fixture();
  try {
    let release!: () => void, stopRuntime!: () => void, callbackStarted = false;
    const callback = new Promise<void>(resolve => { release = resolve; });
    const quiescence = new Promise<void>(resolve => { stopRuntime = resolve; });
    const originalStop = f.workspace.app.master.stopAndWait.bind(f.workspace.app.master);
    f.workspace.app.master.stopAndWait = async () => { await quiescence; await originalStop(); };
    const cleared = f.workspaces.clearChats(f.account.id, async () => { callbackStarted = true; await callback; });
    assert.throws(() => f.workspaces.get(f.account.id), /clearing chat history/);
    await Promise.resolve(); assert.equal(callbackStarted, true);
    await assert.rejects(f.workspace.app.message({ requestId: 'new-during-clear', text: 'Do not run' }), /stopping/);
    await assert.rejects(f.workspaces.clearChats(f.account.id), /another account operation/);
    release(); for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.ok(readFileSync(join(f.dir, 'state.json'), 'utf8').includes('Private test prompt'));
    stopRuntime(); await cleared;
    assert.equal(readFileSync(join(f.dir, 'state.json'), 'utf8').includes('Private test prompt'), false);
    assert.equal(f.providerCalls(), 0);
  } finally { await f.cleanup(); }
});

test('failed pre-clear authorization preserves history and permits a later clean reset without an API key', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.workspaces.clearChats(f.account.id, async () => { throw new Error('Synthetic owner revoked'); }), /owner revoked/);
    assert.ok(readFileSync(join(f.dir, 'state.json'), 'utf8').includes('Private test prompt'));
    f.accounts.db.prepare('UPDATE accounts SET key=NULL WHERE id=?').run(f.account.id);
    await f.workspaces.clearChats(f.account.id);
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8')).tasks, {});
  } finally { await f.cleanup(); }
});

test('an offline active state is not silently recovered into an apparently idle clear; symlinks are refused', async () => {
  const f = await fixture();
  try {
    await f.workspaces.disable(f.account.id);
    const file = join(f.dir, 'state.json'), state = JSON.parse(readFileSync(file, 'utf8'));
    state.tasks[f.task.id].status = 'running'; writeFileSync(file, JSON.stringify(state));
    await assert.rejects(f.workspaces.clearChats(f.account.id), /active work and questions/);
    state.tasks[f.task.id].status = 'completed'; writeFileSync(file, JSON.stringify(state));
    const history = join(f.dir, 'coordination.json'); rmSync(history); symlinkSync(join(f.remote, 'source.txt'), history);
    await assert.rejects(f.workspaces.clearChats(f.account.id), /safely cleared/);
    assert.equal(readFileSync(join(f.remote, 'source.txt'), 'utf8'), 'Preserve source code');
  } finally { await f.cleanup(); }
});
