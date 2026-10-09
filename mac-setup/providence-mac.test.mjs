import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, lstatSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { CONFIG_NAME, ORIGIN, configPath, ensurePrivateParent, exchange, main, readEnrollment, readHiddenPairingCode, saveEnrollment, superviseCompanion, validateOrigin, validateWorkerUrl } from './providence-mac.mjs';

function fixture() {
  const root = mkdtempSync(join(process.cwd(), '.providence-mac-test-'));
  const home = join(root, 'home'); mkdirSync(home);
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  return { root, home, workspace, file: configPath(home), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const paired = { deviceId: 'device-test', token: 't'.repeat(64), url: 'wss://providence.hani.so/worker' };

test('CLI entry point runs from a path with spaces instead of silently exiting', () => {
  const f = fixture();
  try {
    const directory = join(f.root, 'Application Support'); mkdirSync(directory);
    const script = join(directory, 'providence-mac.mjs');
    copyFileSync(new URL('./providence-mac.mjs', import.meta.url), script);
    // Argument validation precedes enrollment reads or child creation.
    const result = spawnSync(process.execPath, [script, 'invalid-command'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 78);
    assert.match(result.stderr, /Usage: providence-mac\.mjs/);
    assert.equal(result.stdout, '');
  } finally { f.cleanup(); }
});

test('origin and worker URLs are pinned and credential-free', () => {
  assert.equal(validateOrigin().href, `${ORIGIN}/`);
  for (const value of ['http://providence.hani.so', 'https://user@providence.hani.so', 'https://evil.example', `${ORIGIN}/other`]) assert.throws(() => validateOrigin(value));
  assert.equal(validateWorkerUrl(paired.url).href, paired.url);
  for (const value of ['wss://evil.example/worker', 'wss://providence.hani.so/not-worker', 'wss://user@providence.hani.so/worker', 'wss://providence.hani.so/worker?token=x']) assert.throws(() => validateWorkerUrl(value));
});
test('exchange refuses redirects and malformed responses without exposing the code', async () => {
  await assert.rejects(() => exchange({ code: 'SECRET-CODE', fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://evil.example' } }) }), error => !error.message.includes('SECRET-CODE'));
  await assert.rejects(() => exchange({ code: 'SECRET-CODE', fetchImpl: async () => new Response(JSON.stringify({ ...paired, url: 'wss://evil.example/worker' }), { status: 200 }) }));
  await assert.rejects(() => exchange({ code: 'SECRET-CODE', fetchImpl: async () => { throw new Error('network SECRET-CODE'); } }), error => !error.message.includes('SECRET-CODE'));
});
test('hidden TTY input never writes typed pairing characters', async () => {
  class FakeTTY extends EventEmitter { isTTY = true; isRaw = false; resume() {} pause() {} setRawMode(value) { this.isRaw = value; } }
  const input = new FakeTTY(); let shown = '';
  const code = readHiddenPairingCode(input, { write: value => { shown += value; } });
  input.emit('data', Buffer.from('SECRET-CODE\n'));
  assert.equal(await code, 'SECRET-CODE'); assert.equal(shown.includes('SECRET-CODE'), false); assert.equal(input.isRaw, false);
});
test('pair saves one private enrollment and reuses it without a second exchange', async () => {
  const f = fixture();
  try {
    let calls = 0;
    await main(['pair', '--workspace', f.workspace], { home: f.home, readCode: async () => 'one-use', fetchImpl: async () => { calls++; return new Response(JSON.stringify(paired), { status: 200 }); } });
    assert.equal(calls, 1); assert.equal(lstatSync(f.file).mode & 0o077, 0);
    assert.deepEqual(readEnrollment(f.file, f.workspace), { ...paired, workspace: f.workspace });
    await main(['pair', '--workspace', f.workspace], { home: f.home, readCode: async () => { throw new Error('must not ask'); }, fetchImpl: async () => { throw new Error('must not exchange'); } });
    assert.equal(calls, 1);
  } finally { f.cleanup(); }
});
test('existing conflicting or symlinked enrollment is refused', () => {
  const f = fixture();
  try {
    saveEnrollment(f.file, { ...paired, workspace: f.workspace });
    assert.throws(() => readEnrollment(f.file, join(f.root, 'other')), /another workspace/);
    rmSync(f.file); symlinkSync('/tmp', f.file);
    assert.throws(() => readEnrollment(f.file), /symlink/);
  } finally { f.cleanup(); }
});
test('malformed credentials and dangling private parents fail without echoing secrets', () => {
  const f = fixture();
  try {
    ensurePrivateParent(f.file); writeFileSync(f.file, '{"token":"SECRET-CODE"'); chmodSync(f.file, 0o600);
    assert.throws(() => readEnrollment(f.file), error => !error.message.includes('SECRET-CODE'));
    rmSync(f.file); rmSync(join(f.home, 'Library'), { recursive: true }); symlinkSync(join(f.root, 'missing'), join(f.home, 'Library'));
    assert.throws(() => ensurePrivateParent(f.file), /symlink/);
  } finally { f.cleanup(); }
});
test('verified Chrome opt-in persists only during first pairing', async () => {
  const f = fixture();
  try {
    await main(['pair', '--workspace', f.workspace, '--verified-chrome'], { home: f.home, readCode: async () => 'one-use', fetchImpl: async () => new Response(JSON.stringify(paired), { status: 200 }) });
    assert.equal(readEnrollment(f.file, f.workspace).browserControl, 'chrome');
  } finally { f.cleanup(); }
});
test('existing approved worker profile settings survive enrollment validation', () => {
  const f = fixture();
  try {
    saveEnrollment(f.file, { ...paired, workspace: f.workspace, workerAccess: 'full-access', workerModel: 'gpt-5.6-sol', workerReasoningEffort: 'low' });
    assert.deepEqual(readEnrollment(f.file, f.workspace), { ...paired, workspace: f.workspace, workerAccess: 'full-access', workerModel: 'gpt-5.6-sol', workerReasoningEffort: 'low' });
  } finally { f.cleanup(); }
});
test('private config name is stable outside the workspace', () => {
  const f = fixture();
  try { assert.equal(f.file.endsWith(`/Providence/${CONFIG_NAME}`), true); assert.equal(f.file.includes(f.workspace), false); }
  finally { f.cleanup(); }
});
test('pair refuses a workspace containing the credential before asking for a code', async () => {
  const f = fixture();
  try {
    await assert.rejects(() => main(['pair', '--workspace', f.home], {
      home: f.home,
      readCode: async () => { throw new Error('pairing code must not be requested'); },
    }), /dedicated workspace/);
  } finally { f.cleanup(); }
});
test('supervisor preserves owner-stop and action-required exits without replacement children', async () => {
  for (const code of [0, 78]) {
    let children = 0;
    const result = await superviseCompanion(() => {
      children++; const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', code)); return child;
    }, { wait: async () => { throw new Error('must not back off'); } });
    assert.equal(result, code); assert.equal(children, 1);
  }
});
test('supervisor retries only unexpected exit 75, is bounded, and observes stop during backoff', async () => {
  let children = 0; const waits = [];
  const result = await superviseCompanion(() => {
    children++; const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 75)); return child;
  }, { maxRetries: 3, wait: async ms => { waits.push(ms); } });
  assert.equal(result, 75); assert.equal(children, 4); assert.deepEqual(waits, [1000, 2000, 4000]);
  let stopped = false; children = 0;
  const stoppedResult = await superviseCompanion(() => {
    children++; const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 75)); return child;
  }, { stopped: () => stopped, wait: async () => { stopped = true; } });
  assert.equal(stoppedResult, 0); assert.equal(children, 1);
});
