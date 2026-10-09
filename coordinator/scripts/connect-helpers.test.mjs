import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { acquireCompanionLock, authorize, browserCommand, checkCodexLogin, codexBinary, existingConfig, hiddenQuestion, launchCompanion, loginStatus, openBrowser, ORIGIN, post, prepareWorkspace, privateConfig, runSetup, saveConfig, setupOptions, SetupError, verificationUrl } from './connect-helpers.mjs';

const setupToken = 's'.repeat(43), deviceCode = 'd'.repeat(43), fixtureKey = 'sk-test-fixture-' + 'x'.repeat(30);
const registered = { deviceId: 'device-fixture', token: 'a'.repeat(64), url: 'wss://providence.hani.so/worker' };
const initial = { deviceCode, userCode: 'TEST-CODE', verificationUrl: `${ORIGIN}/account?setup=TEST-CODE`, expiresAt: 60000, interval: 3 };
const approved = { status: 'approved', setupToken, keyConfigured: false, accountName: 'Fixture account' };
const tempHome = t => { const home = mkdtempSync(resolve(tmpdir(), 'providence-connect-test-')); t.after(() => rmSync(home, { recursive: true, force: true })); return home; };
const fail = async () => assert.fail('Unexpected operation');

function tty() {
  const input = new EventEmitter(), signals = new EventEmitter();
  let outputText = '';
  Object.assign(input, { isTTY: true, isRaw: false, paused: true, setRawMode(value) { this.isRaw = value; }, isPaused() { return this.paused; }, pause() { this.paused = true; }, resume() { this.paused = false; } });
  const output = { isTTY: true, write(text) { outputText += text; } };
  return { input, output, signals, text: () => outputText };
}

test('hidden key input never echoes characters and restores TTY', async () => {
  const io = tty(), result = hiddenQuestion('Key: ', io);
  assert.equal(io.input.isRaw, true);
  io.input.emit('data', Buffer.from(fixtureKey + '\r'));
  assert.equal(await result, fixtureKey);
  assert.equal(io.text(), 'Key: \n');
  assert.equal(io.input.isRaw, false);
  assert.equal(io.input.paused, true);
  assert.equal(io.signals.listenerCount('SIGINT'), 0);
});

test('hidden input supports editing without echo', async () => {
  const io = tty(), result = hiddenQuestion('Key: ', io);
  io.input.emit('data', Buffer.from('mistake\u0015' + fixtureKey + 'x\u007f\r'));
  assert.equal(await result, fixtureKey);
  assert.equal(io.text(), 'Key: \n');
});

for (const interruption of ['keyboard', 'SIGINT', 'SIGTERM', 'end', 'error']) test(`hidden input restores TTY on ${interruption}`, async () => {
  const io = tty(), result = hiddenQuestion('Key: ', io);
  io.input.emit('data', Buffer.from(fixtureKey));
  if (interruption === 'keyboard') io.input.emit('data', Buffer.from('\u0003'));
  else if (interruption === 'end' || interruption === 'error') io.input.emit(interruption);
  else io.signals.emit(interruption);
  await assert.rejects(result, SetupError);
  assert.equal(io.input.isRaw, false);
  assert.equal(io.text(), 'Key: \n');
  assert.equal(io.input.listenerCount('data'), 0);
});

test('non-TTY secret input is refused before reading', async () => {
  const io = tty(); io.input.isTTY = false;
  await assert.rejects(hiddenQuestion('Key: ', io), /interactive terminal/);
  assert.equal(io.text(), '');
});

test('browser launch permits only canonical HTTPS approval addresses and uses no shell', async () => {
  const url = verificationUrl('TEST-CODE');
  assert.deepEqual(browserCommand(url, 'darwin'), ['open', [url]]);
  assert.deepEqual(browserCommand(url, 'win32'), ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]);
  assert.deepEqual(browserCommand(url, 'linux'), ['xdg-open', [url]]);
  for (const bad of ['https://evil.test/account?setup=TEST-CODE', url + '&next=evil', url + '\n', 'javascript:alert(1)']) assert.throws(() => browserCommand(bad), SetupError);
  assert.equal(await openBrowser(url, { platform: 'darwin', execute: (binary, args, options, done) => { assert.equal(options.shell, false); assert.deepEqual(args, [url]); done(null); } }), true);
});

test('approval polling respects interval and never logs either secret', async () => {
  let now = 0, polls = 0; const log = [], times = [];
  const result = await authorize({ now: () => now, sleep: async ms => { now += ms; }, open: async url => { assert.equal(url, initial.verificationUrl); return true; }, log: line => log.push(line), request: async (path, body) => {
    if (path === '/setup/start') return { status: 200, data: initial };
    assert.equal(path, '/setup/poll'); assert.deepEqual(body, { deviceCode }); times.push(now);
    return ++polls === 1 ? { status: 202, data: { status: 'pending' } } : { status: 200, data: approved };
  } });
  assert.deepEqual(times, [3000, 6000]); assert.equal(result.setupToken, setupToken);
  assert.ok(!log.join('\n').includes(deviceCode)); assert.ok(!log.join('\n').includes(setupToken));
});

test('expired and denied approval cannot enroll or expose server errors', async () => {
  for (const status of [403, 410]) {
    let now = 0;
    await assert.rejects(authorize({ now: () => now, sleep: async ms => { now += ms; }, open: async () => true, log: () => {}, request: async path => path === '/setup/start' ? { status: 200, data: initial } : { status, data: { error: fixtureKey } } }), error => error instanceof SetupError && !error.message.includes(fixtureKey));
  }
});

test('hostile setup URL is rejected before browser launch', async () => {
  await assert.rejects(authorize({ now: () => 0, open: fail, request: async () => ({ status: 200, data: { ...initial, verificationUrl: 'https://evil.test/' } }) }), /invalid/);
});

test('post keeps token in Authorization, forbids redirects, and sanitizes thrown errors', async () => {
  const result = await post('/setup/api-key', { apiKey: fixtureKey }, { token: setupToken, fetcher: async (url, options) => {
    assert.equal(url, `${ORIGIN}/setup/api-key`); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${setupToken}`); assert.equal(JSON.parse(options.body).apiKey, fixtureKey);
    return { status: 200, json: async () => ({ ok: true }) };
  } });
  assert.equal(result.data.ok, true);
  await assert.rejects(post('/setup/api-key', {}, { fetcher: async () => { throw new Error(fixtureKey); } }), error => !error.message.includes(fixtureKey));
});

test('Codex selection matches runtime and checks only login status', async () => {
  assert.equal(codexBinary({ env: { CODEX_BIN: '/custom/codex' }, platform: 'darwin', exists: () => true }), '/custom/codex');
  assert.equal(codexBinary({ env: {}, platform: 'darwin', exists: () => true }), '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  assert.equal(await loginStatus({ binary: '/custom/codex', execute: (binary, args, options, done) => { assert.deepEqual(args, ['login', 'status']); assert.equal(options.shell, false); done(null, fixtureKey); } }), true);
  await assert.rejects(loginStatus({ binary: 'codex.cmd' }), /native codex.exe/);
});

test('missing CLI produces actionable sanitized message', async () => {
  await assert.rejects(loginStatus({ execute: (_b, _a, _o, done) => done(Object.assign(new Error(fixtureKey), { code: 'ENOENT' })) }), error => /Install it/.test(error.message) && !error.message.includes(fixtureKey));
});

test('existing Codex login is preserved and signed-out flow offers standard login then rechecks', async () => {
  await checkCodexLogin({ status: async () => true, ask: fail, login: fail });
  let checks = 0, launches = 0;
  await checkCodexLogin({ binary: '/fixture/codex', status: async () => ++checks > 1, ask: async () => 'yes', log: () => {}, login: async binary => { assert.equal(binary, '/fixture/codex'); launches++; return 0; } });
  assert.equal(checks, 2); assert.equal(launches, 1);
  await assert.rejects(checkCodexLogin({ status: async () => false, ask: async () => 'n', log: () => {}, login: fail }), /Run codex login/);
});

test('config directories and credentials are private and cannot be overwritten', t => {
  const home = tempHome(t), file = privateConfig(home), config = { ...registered, workspace: resolve(home, 'work'), workerAccess: 'workspace' };
  saveConfig(file, config);
  assert.deepEqual(existingConfig(file), config);
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(statSync(dirname(file)).mode & 0o777, 0o700); assert.equal(statSync(resolve(home, '.providence')).mode & 0o777, 0o700);
  }
  assert.throws(() => saveConfig(file, { ...config, token: 'b'.repeat(64) }), /already exists/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, registered.token);
});

test('config refuses symlink directories/files and preserves invalid existing files', t => {
  const home = tempHome(t), target = resolve(home, 'target'); mkdirSync(target);
  symlinkSync(target, resolve(home, '.providence'), 'dir');
  assert.throws(() => privateConfig(home), /real private directory/);
  const bad = resolve(home, 'bad.json'); writeFileSync(bad, fixtureKey);
  assert.throws(() => existingConfig(bad), error => !error.message.includes(fixtureKey));
  assert.equal(readFileSync(bad, 'utf8'), fixtureKey);
  const link = resolve(home, 'link.json'); symlinkSync(bad, link);
  assert.throws(() => existingConfig(link), /regular private file/);
});

test('workspace expands tilde and rejects root including linked root', t => {
  const home = tempHome(t);
  assert.equal(prepareWorkspace('~/work', home), realpathSync(resolve(home, 'work')));
  assert.throws(() => prepareWorkspace('/'), /filesystem root/);
  const link = resolve(home, 'root'); symlinkSync('/', link, 'dir');
  assert.throws(() => prepareWorkspace(link), /dedicated folder/);
});

function setupMocks(t, { answers, keyConfigured = false, args = [] } = {}) {
  answers ??= args.includes('--workspace') ? ['', '', 'yes', 'yes', 'yes'] : ['', 'yes', 'yes', 'yes'];
  const home = tempHome(t), requests = [], logs = [], saved = [], launches = [], prompts = [];
  return { requests, logs, saved, launches, prompts, options: { args, home, name: 'fixture-computer', checkLogin: async () => {}, ask: async prompt => { prompts.push(prompt); assert.ok(answers.length); return answers.shift(); }, log: line => logs.push(line), secret: async () => fixtureKey, configPath: () => resolve(home, 'device.json'), readConfig: () => null, workspaceFolder: () => resolve(home, 'work'), authorizeSetup: async () => ({ ...approved, keyConfigured }), request: async (path, body, options) => { requests.push({ path, body, options }); return { status: 200, data: path === '/setup/api-key' ? { ok: true } : registered }; }, writeConfig: (file, data) => saved.push({ file, data }), configureBackground: async () => ({ foreground: true, installed: false }), launch: async file => { launches.push(file); return 0; } } };
}

test('new setup defaults to full access after local consent and account confirmation', async t => {
  const state = setupMocks(t); await runSetup(state.options);
  assert.deepEqual(state.requests.map(r => r.path), ['/setup/api-key', '/setup/connect']);
  assert.equal(state.requests[0].options.token, setupToken); assert.equal(state.requests[1].body.workerAccess, 'full-access');
  assert.equal(state.saved.length, 1); assert.equal(state.launches.length, 1);
  assert.equal(state.saved[0].data.workerAccess, 'full-access');
  assert.ok(!JSON.stringify(state.saved).includes(fixtureKey)); assert.ok(!state.logs.join('\n').includes(fixtureKey));
  assert.ok(state.logs.some(line => line.includes('stored encrypted on its server')));
  assert.ok(state.logs.some(line => line.includes('connected and acknowledged')));
  assert.ok(state.logs.some(line => line.includes('without a prompt for each task')));
  assert.ok(state.logs.some(line => line.includes('starting folder does not limit access')));
});

test('explicit workspace setup keeps workspace scope and never asks for existing hosted key', async t => {
  const state = setupMocks(t, { args: ['--workspace'], keyConfigured: true }); state.options.secret = fail;
  await runSetup(state.options);
  assert.deepEqual(state.requests.map(r => r.path), ['/setup/connect']); assert.equal(state.requests[0].body.workerAccess, 'workspace');
  assert.equal(state.saved[0].data.workerAccess, 'workspace');
});

test('legacy full-access flag retains full access for a new installation', async t => {
  const state = setupMocks(t, { args: ['--full-access'], keyConfigured: true });
  await runSetup(state.options);
  assert.equal(state.requests[0].body.workerAccess, 'full-access');
  assert.equal(state.saved[0].data.workerAccess, 'full-access');
});

for (const answer of ['', 'no', 'unexpected']) test(`connection consent ${JSON.stringify(answer)} cancels before browser approval or registration`, async t => {
  const state = setupMocks(t, { answers: ['', answer] });
  Object.assign(state.options, { authorizeSetup: fail, secret: fail, request: fail, writeConfig: fail, launch: fail });
  await assert.rejects(runSetup(state.options), /cancelled before browser approval/);
});

test('conflicting access flags fail before checking local sign-in', async t => {
  const state = setupMocks(t, { args: ['--full-access', '--workspace'] });
  Object.assign(state.options, { checkLogin: fail, configPath: fail, authorizeSetup: fail, request: fail });
  await assert.rejects(runSetup(state.options), /not both/);
});

test('declining account identity prevents key upload and registration', async t => {
  const state = setupMocks(t, { answers: ['', 'yes', 'yes', 'no'] }); state.options.secret = fail;
  await assert.rejects(runSetup(state.options), /before API-key changes/);
  assert.equal(state.requests.length, 0); assert.equal(state.saved.length, 0);
});

for (const args of [[], ['--full-access']]) test(`existing workspace config resumes without permission changes with ${JSON.stringify(args)}`, async t => {
  const state = setupMocks(t, { args }); state.options.readConfig = () => ({ ...registered, workerAccess: 'workspace' });
  Object.assign(state.options, { ask: fail, authorizeSetup: fail, secret: fail, request: fail, writeConfig: fail });
  await runSetup(state.options); assert.equal(state.launches.length, 1);
});

test('configure-key does not require Codex, touch configs, or enroll a device', async t => {
  const state = setupMocks(t, { args: ['--configure-key'], answers: ['yes'], keyConfigured: true });
  Object.assign(state.options, { checkLogin: fail, configPath: fail, writeConfig: fail, launch: fail });
  await runSetup(state.options); assert.deepEqual(state.requests.map(r => r.path), ['/setup/api-key']);
});

test('unknown flags and malformed registration fail closed', async t => {
  const state = setupMocks(t); state.options.args = ['--api-key=' + fixtureKey];
  await assert.rejects(runSetup(state.options), error => !error.message.includes(fixtureKey));
  state.options.args = ['--full-access']; state.options.request = async () => ({ status: 200, data: { ok: true, ...registered, url: 'wss://evil.test/worker' } });
  await assert.rejects(runSetup(state.options), /could not be verified/); assert.equal(state.saved.length, 0);
});

test('companion uses absolute package-relative paths and forwards stop signals', async t => {
  const root = tempHome(t), coordinator = resolve(root, 'coordinator'), tsx = resolve(coordinator, 'node_modules/tsx/dist/cli.mjs'); mkdirSync(dirname(tsx), { recursive: true }); writeFileSync(tsx, '');
  const child = new EventEmitter(), signals = new EventEmitter(); let killed = 0;
  child.kill = signal => { assert.equal(signal, 'SIGTERM'); killed++; };
  const waiting = launchCompanion(resolve(root, 'device.json'), { coordinator, execPath: '/fixture/node', signals, spawner: (binary, args, options) => { assert.equal(binary, '/fixture/node'); assert.equal(args[0], tsx); assert.equal(args[1], resolve(coordinator, 'src/device.ts')); assert.equal(options.cwd, coordinator); assert.equal(options.shell, false); return child; } });
  signals.emit('SIGINT'); signals.emit('SIGTERM'); assert.equal(killed, 1); child.emit('exit', 0);
  assert.equal(await waiting, 0); assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('companion lock rejects live owners, records child, and releases only owned lock', t => {
  const home = tempHome(t), file = resolve(home, 'device.json');
  const lock = acquireCompanionLock(file); lock.attachChild(987654321);
  assert.deepEqual(JSON.parse(readFileSync(file + '.lock', 'utf8')), { pid: process.pid, childPid: 987654321 });
  assert.throws(() => acquireCompanionLock(file), /may already be running/);
  lock.release(); assert.equal(existsSync(file + '.lock'), false);
});

test('companion lock only recovers when both recorded processes are confirmed absent', t => {
  const home = tempHome(t), file = resolve(home, 'device.json');
  writeFileSync(file + '.lock', JSON.stringify({ pid: 432100, childPid: 432101 }), { mode: 0o600 });
  const probed = [];
  const lock = acquireCompanionLock(file, { probe: pid => { probed.push(pid); throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } });
  assert.deepEqual(probed, [432100, 432101]); lock.release();
  for (const record of [{ pid: 432100, childPid: null }, { pid: 432100, childPid: 432101 }, { pid: -1, childPid: -1 }]) {
    writeFileSync(file + '.lock', JSON.stringify(record), { mode: 0o600 });
    assert.throws(() => acquireCompanionLock(file, { probe: () => { throw Object.assign(new Error('unknown'), { code: 'EPERM' }); } }), /may already be running/);
    assert.equal(existsSync(file + '.lock'), true); rmSync(file + '.lock');
  }
});

test('uncertain registration retries the same authorized enrollment, never a new setup', async () => {
  let calls = 0; const requests = [], sleeps = [];
  const result = await post('/setup/connect', { name: 'fixture', workspace: '/fixture', workerAccess: 'workspace' }, { token: setupToken, sleep: async ms => sleeps.push(ms), fetcher: async (url, options) => {
    requests.push({ url, body: options.body, authorization: options.headers.Authorization });
    if (++calls < 3) throw new Error('lost acknowledgement');
    return { status: 200, json: async () => registered };
  } });
  assert.equal(result.data.deviceId, registered.deviceId); assert.deepEqual(sleeps, [3000, 3000]);
  assert.deepEqual(requests[0], requests[1]); assert.deepEqual(requests[1], requests[2]);
  let pollCalls = 0;
  await post('/setup/poll', { deviceCode }, { retryAfterMs: 12000, sleep: async ms => assert.equal(ms, 12000), fetcher: async () => {
    if (++pollCalls === 1) throw new Error('network');
    return { status: 202, json: async () => ({ status: 'pending' }) };
  } });
});

test('managed background startup never also launches a foreground companion', async t => {
  const state = setupMocks(t);
  state.options.configureBackground = async ({ configFile, coordinator, execPath, ask, log }) => {
    assert.equal(configFile, state.saved[0].file);
    assert.ok(coordinator.endsWith('/coordinator')); assert.equal(execPath, process.execPath);
    assert.equal(typeof ask, 'function'); assert.equal(typeof log, 'function');
    return { foreground: false, installed: true, running: true };
  };
  state.options.launch = fail;
  await runSetup(state.options);
  assert.equal(state.launches.length, 0); assert.ok(state.logs.some(line => line.includes('return to https://providence.hani.so/account')));
});

test('existing managed service preserves scope and avoids foreground duplication', async t => {
  const state = setupMocks(t);
  state.options.configureBackground = async () => ({ foreground: false, installed: true, running: true });
  Object.assign(state.options, { checkLogin: fail, ask: fail, authorizeSetup: fail, secret: fail, request: fail, writeConfig: fail, launch: fail });
  for (const workerAccess of ['workspace', 'full-access']) {
    state.options.readConfig = () => ({ ...registered, workerAccess });
    await runSetup(state.options);
    assert.ok(state.logs.some(line => line.includes(`existing ${workerAccess === 'full-access' ? 'full access' : 'workspace access'};`)));
  }
  assert.ok(state.logs.every(line => !line.includes('full-access access')));
});

test('an occupied foreground process lock is not mistaken for a confirmed running companion', async t => {
  const state = setupMocks(t);
  state.options.readConfig = () => ({ ...registered, workerAccess: 'workspace' });
  state.options.configureBackground = async ({ log }) => {
    log('An existing process lock needs inspection before starting another copy.');
    return { foreground: false, installed: false, running: null, state: 'unknown' };
  };
  Object.assign(state.options, { ask: fail, authorizeSetup: fail, secret: fail, request: fail, writeConfig: fail, launch: fail });
  await assert.rejects(runSetup(state.options), /startup is not confirmed/);
  assert.ok(state.logs.some(line => line.includes('process lock')));
});

for (const [answer, expected] of [['', true], ['yes', true], ['no', false], ['unexpected', false]]) test(`keep-awake choice ${JSON.stringify(answer)} stays local and saves ${expected}`, async t => {
  const state = setupMocks(t, { answers: ['', 'yes', answer, 'yes'] });
  await runSetup(state.options);
  assert.equal(state.saved[0].data.keepAwake, expected);
  assert.equal(Object.hasOwn(state.requests.find(request => request.path === '/setup/connect').body, 'keepAwake'), false);
  assert.ok(state.logs.some(line => line.includes('screen may still turn off or lock')));
  assert.ok(state.logs.some(line => line.includes('Closing the lid or manually sleeping')));
  assert.ok(state.logs.some(line => line.includes('during active use or tasks, then release that request when idle')));
});

for (const preference of [undefined, false, true]) test(`existing keep-awake ${preference} resumes without changing config or asking again`, async t => {
  const state = setupMocks(t);
  state.options.readConfig = () => ({ ...registered, workerAccess: 'workspace', ...(preference === undefined ? {} : { keepAwake: preference }) });
  Object.assign(state.options, { ask: fail, authorizeSetup: fail, secret: fail, request: fail, writeConfig: fail });
  await runSetup(state.options);
  assert.equal(state.launches.length, 1);
  assert.ok(state.logs.some(line => line.includes(preference === true ? 'prevent sleep during active use or tasks' : 'sleep normally')));
});

test('private config accepts only boolean keep-awake preferences and preserves legacy absence', t => {
  const home = tempHome(t), file = privateConfig(home), config = { ...registered, workspace: resolve(home, 'work'), workerAccess: 'workspace' };
  saveConfig(file, config);
  assert.equal(Object.hasOwn(existingConfig(file), 'keepAwake'), false);
  for (const keepAwake of [true, false]) {
    writeFileSync(file, JSON.stringify({ ...config, keepAwake }), { mode: 0o600 });
    assert.equal(existingConfig(file).keepAwake, keepAwake);
  }
  writeFileSync(file, JSON.stringify({ ...config, keepAwake: 'yes' }), { mode: 0o600 });
  assert.throws(() => existingConfig(file), /could not be verified/);
});

for (const [answer, expected] of [['', 'fixture-computer'], ['  Work laptop  ', 'Work laptop']]) test(`new computer name ${JSON.stringify(answer)} is sent only as its Providence enrollment label`, async t => {
  const state = setupMocks(t, { answers: [answer, 'yes', 'yes', 'yes'] });
  await runSetup(state.options);
  assert.equal(state.requests.find(request => request.path === '/setup/connect').body.name, expected);
  assert.equal(Object.hasOwn(state.saved[0].data, 'name'), false);
  assert.equal(state.options.name, 'fixture-computer');
});

test('invalid computer names are rejected before browser approval or enrollment', async t => {
  for (const answer of ['x'.repeat(81), 'Laptop\u0007hidden', 'Laptop\u0085hidden']) {
    const state = setupMocks(t, { answers: [answer] });
    state.options.authorizeSetup = fail;
    await assert.rejects(runSetup(state.options), /1–80 characters without control characters/);
    assert.equal(state.requests.length, 0); assert.equal(state.saved.length, 0);
  }
});

test('full-access default uses a working folder without asking another setup question', async t => {
  const state = setupMocks(t); let selected;
  state.options.workspaceFolder = (folder, home) => { selected = { folder, home }; return resolve(home, 'ProvidenceWorkspace'); };
  await runSetup(state.options);
  assert.deepEqual(selected, { folder: '', home: state.options.home });
  assert.equal(state.prompts.some(prompt => /folder/i.test(prompt)), false);
  assert.equal(state.saved[0].data.workspace, resolve(state.options.home, 'ProvidenceWorkspace'));
  assert.deepEqual(state.logs.filter(line => /^\[\d\/3\]/.test(line)), ['[1/3] Prepare this computer', '[2/3] Approve this computer in your browser', '[3/3] Start Providence']);
});

test('advanced folder override is explicit and never changes an existing enrollment', async t => {
  const state = setupMocks(t, { args: ['--workspace-folder', '~/My work'] }); let chosen;
  state.options.workspaceFolder = folder => { chosen = folder; return resolve(state.options.home, 'My work'); };
  await runSetup(state.options); assert.equal(chosen, '~/My work'); assert.equal(state.prompts.some(prompt => /folder/i.test(prompt)), false);
  const resume = setupMocks(t, { args: ['--workspace-folder', '/new/folder'] });
  resume.options.readConfig = () => ({ ...registered, workspace: '/saved/folder', workerAccess: 'workspace' });
  resume.options.configureBackground = async () => ({ foreground: false, installed: true, running: true });
  Object.assign(resume.options, { checkLogin: fail, ask: fail, workspaceFolder: fail, writeConfig: fail, authorizeSetup: fail });
  await runSetup(resume.options); assert.equal(resume.saved.length, 0);
  for (const args of [['--workspace-folder'], ['--workspace-folder', 'relative'], ['--workspace-folder', '/ok', '--workspace-folder', '/other'], ['--configure-key', '--workspace-folder', '/ok']])
    assert.throws(() => setupOptions(args), SetupError);
});

test('resuming a stopped helper checks only its saved Codex profile before startup', async t => {
  const state = setupMocks(t); const checks = [];
  state.options.readConfig = () => ({ ...registered, workerAccess: 'workspace' });
  state.options.checkLogin = async input => checks.push(input);
  state.options.configureBackground = async ({ beforeStart }) => {
    await beforeStart({ codexBinary: '/saved/codex', environment: { PATH: '/saved/bin', CODEX_HOME: '/saved/profile' } });
    return { foreground: false, installed: true, running: true };
  };
  Object.assign(state.options, { ask: fail, authorizeSetup: fail, request: fail, secret: fail, writeConfig: fail, launch: fail });
  await runSetup(state.options);
  assert.equal(checks.length, 1); assert.equal(checks[0].binary, '/saved/codex'); assert.equal(checks[0].env.CODEX_HOME, '/saved/profile');
});
