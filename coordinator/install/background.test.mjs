import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { backgroundStatus, configureBackground, contactBackground, inspectWindowsProcesses, manageBackground, metadataPath, readPrivateJson, recoverStaleWindowsBackground, resolveServiceCodex, serviceSpec, statePath, writePrivateJson } from './background.mjs';
import { runBackground } from './background-runner.mjs';

function fixture() {
  // Short paths also exercise Darwin's Unix-socket path length limits.
  const home = mkdtempSync(join(tmpdir(), 'pv-'));
  const configFile = join(home, 'device.json');
  writeFileSync(configFile, '{"deviceId":"fixture","workerAccess":"workspace"}', { mode: 0o600 });
  const codexBinary = join(home, 'codex');
  writeFileSync(codexBinary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  return { home, configFile, codexBinary, coordinator: join(home, 'release/coordinator'), execPath: process.execPath, platform: 'darwin', uid: 501, env: { PATH: '/usr/bin:/bin', CODEX_HOME: join(home, 'existing-codex-profile'), OPENAI_API_KEY: 'fixture-do-not-persist' } };
}

test('user-login service definitions preserve only selected paths and existing Codex home', () => {
  const f = fixture();
  try {
    for (const platform of ['darwin', 'linux', 'win32']) {
      const spec = serviceSpec({ ...f, platform });
      assert.equal(spec.environment.CODEX_HOME, f.env.CODEX_HOME);
      assert.equal(spec.environment.CODEX_BIN, f.codexBinary);
      assert.deepEqual(Object.keys(spec.environment).sort(), ['CODEX_BIN','CODEX_HOME','PATH']);
      assert.ok(!spec.content.includes('fixture-do-not-persist'));
      assert.ok(!spec.content.includes('SYSTEM'));
      assert.ok(!spec.content.includes('full-access'));
      assert.ok(!spec.content.includes('Restart=always'));
      assert.ok(spec.content.includes('background-runner.mjs'));
      if (platform === 'darwin') { assert.ok(spec.content.includes('Aqua')); assert.ok(!spec.content.includes('KeepAlive')); }
      if (platform === 'linux') { assert.ok(spec.file.includes('/.config/systemd/user/')); assert.ok(spec.content.includes('Restart=no')); }
      if (platform === 'win32') { assert.ok(spec.file.includes('/Startup/')); assert.ok(spec.content.includes('helper.Run')); }
    }
    assert.throws(() => serviceSpec({ ...f, uid: 0 }), /regular user/);
    assert.throws(() => serviceSpec({ ...f, configFile: '/bad\npath' }), /invalid/);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('service executable resolution accepts user-installed symlinks without changing them', { skip: process.platform === 'win32' }, () => {
  const f = fixture();
  try {
    const link = join(f.home, 'codex-link'); symlinkSync(f.codexBinary, link);
    assert.equal(resolveServiceCodex(link), realpathSync(f.codexBinary));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('declining background startup writes no service and allows foreground use', async () => {
  const f = fixture(); const logs = [];
  try {
    const result = await configureBackground({ ...f, ask: async () => 'n', log: value => logs.push(value), available: () => true, save: () => assert.fail('must not write'), run: () => assert.fail('must not call OS service tools') });
    assert.deepEqual(result, { installed: false, running: false, foreground: true });
    assert.equal(existsSync(metadataPath(f.configFile)), false);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('unavailable systemd user session falls back clearly without consent or OS changes', async () => {
  const f = fixture(); const logs = [];
  try {
    const result = await configureBackground({ ...f, platform: 'linux', available: () => false, ask: () => assert.fail('no unsupported offer'), log: value => logs.push(value) });
    assert.equal(result.foreground, true);
    assert.ok(logs.some(value => value.includes('keep it open')));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('healthy or uncertain existing helpers do not repeat sign-in or start another process', async () => {
  const f = fixture();
  try {
    for (const running of [true, null]) {
      const result = await configureBackground({ ...f,
        status: async () => ({ installed: true, running }),
        beforeStart: () => assert.fail('no new runtime needs authentication'),
        manage: () => assert.fail('no duplicate startup'), ask: () => assert.fail('no repeated setup'), log: () => {} });
      assert.equal(result.running, running);
    }
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('stopped existing helper checks its retained profile before restart', async () => {
  const f = fixture(); let checked = false;
  try {
    const spec = { ...serviceSpec(f), home: f.home, uid: f.uid };
    const result = await configureBackground({ ...f, status: async () => ({ installed: true, running: false, metadata: spec }),
      beforeStart: async context => { assert.equal(context.codexBinary, f.codexBinary); assert.equal(context.environment.CODEX_HOME, f.env.CODEX_HOME); checked = true; },
      manage: async command => { assert.equal(command, 'start'); assert.equal(checked, true); return { installed: true, running: true }; },
      ask: () => assert.fail('retain existing startup consent'), log: () => {} });
    assert.equal(result.running, true);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('cancelled sign-in cannot install a startup entry', async () => {
  const f = fixture();
  try {
    await assert.rejects(configureBackground({ ...f, available: () => true, ask: async () => 'yes', log: () => {},
      beforeStart: async () => { throw new Error('Sign-in cancelled'); }, save: () => assert.fail('must not install'), run: () => assert.fail('must not start') }), /Sign-in cancelled/);
    assert.equal(existsSync(metadataPath(f.configFile)), false);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('a live foreground lock prevents service installation or takeover', async () => {
  const f = fixture();
  try {
    writePrivateJson(f.configFile + '.lock', { pid: process.pid, childPid: process.pid });
    const result = await configureBackground({ ...f, ask: () => assert.fail('must not request takeover'), log: () => {}, run: () => assert.fail('no OS changes') });
    assert.equal(result.state, 'unknown');
    assert.equal(result.installed, false);
    assert.equal(result.running, null);
    assert.equal(result.foreground, false);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

function staleWindowsFixture(f) {
  const spec = { ...serviceSpec({ ...f, platform: 'win32' }), home: f.home, uid: f.uid };
  writePrivateJson(metadataPath(f.configFile), spec);
  writePrivateJson(statePath(f.configFile), { schemaVersion: 1, state: 'running', pid: 123 });
  writePrivateJson(f.configFile + '.lock', { pid: 123, childPid: 456 });
  writePrivateJson(f.configFile + '.background.lock', { pid: 123, childPid: 123 });
  return spec;
}

test('Windows process identity query is read-only and fails closed on inaccessible results', () => {
  const input = { pids: [123, 456], execPath: 'C:\\Providence\\node.exe' };
  let calls = 0;
  const run = (binary, args, options) => {
    calls++;
    assert.equal(binary, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.ok(args.includes('-NoProfile')); assert.match(args.at(-1), /Get-CimInstance -ClassName Win32_Process/);
    assert.match(args.at(-1), /-Property ProcessId,Name,ExecutablePath/);
    assert.doesNotMatch(args.at(-1), /Stop-Process|\.Kill\(|taskkill|Terminate/);
    return { status: 0, stdout: JSON.stringify({ complete: true, processes: [{ pid: 123, imageName: 'other.exe', executable: 'C:\\Windows\\other.exe' }] }) };
  };
  assert.equal(inspectWindowsProcesses(input, { platform: 'win32', env: {}, run })[0].pid, 123);
  assert.equal(calls, 1);
  for (const result of [{ status: 1 }, { status: 0, stdout: '{}' }, { status: 0, stdout: '{"complete":true,"processes":[{"pid":123,"executable":null}]}' }]) {
    assert.equal(inspectWindowsProcesses(input, { platform: 'win32', run: () => result }), undefined);
  }
});

test('OS image-name mismatch is sufficient without debug privileges but unnamed and Node identities are not', () => {
  const input = { pids: [123, 456], execPath: 'C:\\Providence\\node.exe' };
  for (const [imageName, executable, accepted] of [
    ['NVDisplay.Container.exe', null, true], ['NVDisplay.Container.exe', '', true],
    ['', null, false], [null, null, false], ['node.exe', null, false], ['NODE.EXE', '', false],
    ['node.exe', 'C:\\Providence\\node.exe', true],
  ]) {
    const actual = inspectWindowsProcesses(input, { platform: 'win32', run: () => ({ status: 0,
      stdout: JSON.stringify({ complete: true, processes: [{ pid: 123, imageName, executable }] }) }) });
    assert.equal(Array.isArray(actual), accepted, String(imageName));
  }
  assert.equal(inspectWindowsProcesses(input, { platform: 'win32', run: () => ({ status: 0,
    stdout: JSON.stringify({ complete: true, processes: [{ pid: 999, imageName: 'node.exe', executable: null }] }) }) }), undefined, 'an inaccessible orphan candidate blocks recovery');
});

test('confirmed stale Windows identities retire only owned locks and state without touching any process', async () => {
  const f = fixture();
  try {
    staleWindowsFixture(f);
    const configBefore = readFileSync(f.configFile), metadataBefore = readFileSync(metadataPath(f.configFile));
    let checks = 0;
    const repaired = await recoverStaleWindowsBackground({ configFile: f.configFile, platform: 'win32', contact: async () => undefined,
      inspect: ({ pids }) => { checks++; assert.deepEqual(pids, [123, 456]); return [{ pid: 123, imageName: 'NVDisplay.Container.exe', executable: null }]; } });
    assert.equal(repaired, true); assert.equal(checks, 2);
    assert.equal(existsSync(f.configFile + '.lock'), false);
    assert.equal(existsSync(f.configFile + '.background.lock'), false);
    assert.equal(readPrivateJson(statePath(f.configFile)).state, 'stopped');
    assert.deepEqual(readFileSync(f.configFile), configBefore);
    assert.deepEqual(readFileSync(metadataPath(f.configFile)), metadataBefore);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('same executable, orphaned Node, unknown identity, live IPC, and missing child identity stay fenced', async () => {
  for (const scenario of ['same', 'orphan', 'unreadable-node', 'unnamed', 'unknown', 'ipc', 'child', 'changed']) {
    const f = fixture();
    try {
      const spec = staleWindowsFixture(f);
      if (scenario === 'child') writePrivateJson(f.configFile + '.lock', { pid: 123, childPid: null });
      const files = [metadataPath(f.configFile), statePath(f.configFile), f.configFile + '.lock', f.configFile + '.background.lock'];
      const before = files.map(file => readFileSync(file)); let calls = 0;
      const repaired = await recoverStaleWindowsBackground({ configFile: f.configFile, platform: 'win32',
        contact: async () => scenario === 'ipc' ? { running: true } : undefined,
        inspect: () => {
          calls++;
          if (scenario === 'same') return [{ pid: 123, imageName: 'node', executable: spec.execPath }];
          if (scenario === 'orphan') return [{ pid: 999, imageName: 'node', executable: spec.execPath }];
          if (scenario === 'unreadable-node') return [{ pid: 123, imageName: 'node', executable: null }];
          if (scenario === 'unnamed') return [{ pid: 123, imageName: '', executable: null }];
          if (scenario === 'unknown') return undefined;
          if (scenario === 'changed' && calls === 2) writePrivateJson(f.configFile + '.lock', { pid: 777, childPid: 888 });
          return [];
        } });
      assert.equal(repaired, false, scenario);
      files.forEach((file, index) => { if (scenario !== 'changed' || !file.endsWith('device.json.lock')) assert.deepEqual(readFileSync(file), before[index], scenario); });
      if (scenario === 'changed') assert.equal(readPrivateJson(f.configFile + '.lock').pid, 777);
    } finally { rmSync(f.home, { recursive: true, force: true }); }
  }
});

test('state-only Windows recovery still checks for orphaned Node processes and preserves changed controls', async () => {
  for (const changed of [false, true]) {
    const f = fixture();
    try {
      const spec = staleWindowsFixture(f);
      unlinkSync(f.configFile + '.lock'); unlinkSync(f.configFile + '.background.lock');
      if (changed) writeFileSync(join(f.home, 'manage.cmd'), 'user-edited manager', { mode: 0o600 });
      let inspected = false;
      const repaired = await recoverStaleWindowsBackground({ configFile: f.configFile, platform: 'win32', contact: async () => undefined,
        inspect: ({ execPath }) => { inspected = true; assert.equal(execPath, spec.execPath); return []; } });
      assert.equal(repaired, !changed); assert.equal(inspected, !changed);
      if (changed) assert.equal(readFileSync(join(f.home, 'manage.cmd'), 'utf8'), 'user-edited manager');
    } finally { rmSync(f.home, { recursive: true, force: true }); }
  }
});

test('installer resumes only after confirmed stale Windows recovery and restores its missing owned launcher', async () => {
  const f = fixture();
  try {
    const spec = staleWindowsFixture(f); let recovered = false, saved = false, authenticated = false;
    const result = await configureBackground({ ...f, platform: 'win32',
      status: async () => ({ installed: true, running: recovered ? false : null, metadata: spec }),
      recover: async () => { recovered = true; return true; },
      beforeStart: async () => { authenticated = true; },
      save: actual => { assert.equal(authenticated, true); assert.deepEqual(actual, spec); saved = true; },
      manage: async command => { assert.equal(command, 'start'); assert.equal(saved, true); return { installed: true, running: true }; },
      ask: () => assert.fail('existing enrollment and startup consent are retained'), log: () => {} });
    assert.equal(result.running, true);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('default consent installs only a per-user launcher and reruns do not start a second copy', async () => {
  const f = fixture(); const commands = []; let questions = 0;
  try {
    const configBefore = readFileSync(f.configFile);
    const status = args => backgroundStatus({ ...args, contact: async () => ({ running: true, state: 'running' }) });
    const result = await configureBackground({ ...f, ask: async () => { questions++; return ''; }, log: () => {}, available: () => true, status, run: (binary,args) => { commands.push([binary,args]); return args[0] !== 'print'; }, wait: async () => {} });
    assert.equal(result.installed, true); assert.equal(result.running, true); assert.equal(result.foreground, false);
    assert.equal(questions, 1);
    assert.deepEqual(commands[1], ['launchctl', ['bootstrap', 'gui/501', serviceSpec(f).file]]);
    assert.deepEqual(readFileSync(f.configFile), configBefore);
    assert.equal(statSync(metadataPath(f.configFile)).mode & 0o777, 0o600);
    assert.ok(existsSync(join(f.home, 'manage')));
    const again = await configureBackground({ ...f, status, ask: () => assert.fail('consent already recorded'), log: () => {}, manage: () => assert.fail('already running'), run: () => assert.fail('already running') });
    assert.equal(again.foreground, false);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('Windows local manager quotes percent paths and disables delayed expansion', async () => {
  const f = fixture();
  try {
    const codexBinary = join(f.home, 'codex.exe'); writeFileSync(codexBinary, 'fixture', { mode: 0o700 });
    const status = args => backgroundStatus({ ...args, contact: async () => ({ running: true, state: 'running' }) });
    const result = await configureBackground({ ...f, platform: 'win32', codexBinary, execPath: join(f.home, 'Node%TEMP%!/node.exe'), status, ask: async () => '', log: () => {}, available: () => true, run: () => true, wait: async () => {} });
    assert.equal(result.installed, true);
    const manager = readFileSync(join(f.home, 'manage.cmd'), 'utf8');
    assert.ok(manager.includes('Node%%TEMP%%!'));
    assert.ok(manager.includes('setlocal DisableDelayedExpansion'));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('disable removes only its unchanged startup definition and preserves device credentials', async () => {
  const f = fixture(); const commands = [];
  try {
    const spec = { ...serviceSpec(f), home: f.home, uid: f.uid };
    mkdirSync(dirname(spec.file), { recursive: true }); writeFileSync(spec.file, spec.content, { mode: 0o600 });
    writePrivateJson(metadataPath(f.configFile), spec);
    const before = readFileSync(f.configFile);
    const result = await manageBackground('disable', f.configFile, { contact: async () => undefined, run: (binary,args) => { commands.push([binary,args]); return true; }, wait: async () => {} });
    assert.equal(result.installed, false);
    assert.equal(existsSync(spec.file), false);
    assert.deepEqual(readFileSync(f.configFile), before);
    assert.ok(commands.some(([,args]) => args[0] === 'bootout'));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('Windows disable preserves registration when IPC stop is uncertain or its child still owns a lock', async () => {
  for (const acknowledged of [false, true]) {
    const f = fixture();
    try {
      const spec = { ...serviceSpec({ ...f, platform: 'win32' }), home: f.home, uid: f.uid };
      mkdirSync(dirname(spec.file), { recursive: true }); writeFileSync(spec.file, spec.content, { mode: 0o600 });
      writePrivateJson(metadataPath(f.configFile), spec);
      writePrivateJson(statePath(f.configFile), { state: acknowledged ? 'stopped' : 'running', pid: process.pid });
      writePrivateJson(f.configFile + '.lock', { pid: process.pid, childPid: process.pid });
      writePrivateJson(f.configFile + '.background.lock', { pid: process.pid, childPid: process.pid });
      const registration = readFileSync(metadataPath(f.configFile));
      const config = readFileSync(f.configFile);
      const result = await manageBackground('disable', f.configFile, {
        contact: async (_file, command) => command === 'stop' && acknowledged ? { accepted: true } : undefined,
        run: () => assert.fail('Windows must use authenticated local control'), wait: async () => {},
      });
      assert.equal(result.installed, true); assert.equal(result.running, null);
      assert.equal(result.state, 'unknown'); assert.equal(result.stopConfirmed, false);
      assert.deepEqual(readFileSync(metadataPath(f.configFile)), registration);
      assert.equal(readFileSync(spec.file, 'utf8'), spec.content);
      assert.deepEqual(readFileSync(f.configFile), config);
    } finally { rmSync(f.home, { recursive: true, force: true }); }
  }
});

test('Windows disable waits for authenticated shutdown and both process-lock releases', async () => {
  const f = fixture(); let waits = 0;
  try {
    const spec = { ...serviceSpec({ ...f, platform: 'win32' }), home: f.home, uid: f.uid };
    mkdirSync(dirname(spec.file), { recursive: true }); writeFileSync(spec.file, spec.content, { mode: 0o600 });
    writePrivateJson(metadataPath(f.configFile), spec);
    writePrivateJson(statePath(f.configFile), { state: 'running', pid: process.pid });
    writePrivateJson(f.configFile + '.lock', { pid: process.pid, childPid: process.pid });
    writePrivateJson(f.configFile + '.background.lock', { pid: process.pid, childPid: process.pid });
    const result = await manageBackground('disable', f.configFile, {
      contact: async (_file, command) => command === 'stop' ? { accepted: true } : undefined,
      run: () => assert.fail('no Windows system process termination'),
      wait: async () => {
        waits++;
        assert.equal(existsSync(metadataPath(f.configFile)), true);
        assert.equal(existsSync(spec.file), true);
        writePrivateJson(statePath(f.configFile), { state: 'stopped', pid: process.pid });
        unlinkSync(f.configFile + '.lock'); unlinkSync(f.configFile + '.background.lock');
      },
    });
    assert.equal(waits, 1);
    assert.deepEqual(result, { installed: false, running: false, state: 'not-installed', stopConfirmed: true });
    assert.equal(existsSync(metadataPath(f.configFile)), false);
    assert.equal(existsSync(spec.file), false);
    assert.equal(existsSync(f.configFile), true);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

async function updateFixture(f, initiallyRunning = true) {
  let running = true;
  const commands = [], logs = [];
  const contact = async (_file, command) => {
    if (command === 'stop') { running = false; writePrivateJson(statePath(f.configFile), { state: 'stopped' }); return { accepted: true }; }
    return running ? { running: true, state: 'running' } : undefined;
  };
  const status = args => backgroundStatus({ ...args, contact });
  const run = (binary, args) => {
    commands.push([binary, args]);
    if (args[0] === 'print') return false;
    if (args[0] === 'bootout') { running = false; writePrivateJson(statePath(f.configFile), { state: 'stopped' }); }
    if (args[0] === 'bootstrap') running = true;
    return true;
  };
  await configureBackground({ ...f, ask: async () => '', available: () => true, status, run, log: () => {}, wait: async () => {} });
  running = initiallyRunning;
  if (!running) writePrivateJson(statePath(f.configFile), { state: 'stopped' });
  commands.length = 0;
  const older = readPrivateJson(metadataPath(f.configFile));
  const coordinator = join(f.home, 'newer-release/coordinator'), execPath = join(f.home, 'new-node/bin/node');
  mkdirSync(join(coordinator, 'install'), { recursive: true });
  writeFileSync(join(coordinator, 'install/background-runner.mjs'), '// verified package fixture', { mode: 0o600 });
  mkdirSync(dirname(execPath), { recursive: true }); writeFileSync(execPath, 'fixture runtime', { mode: 0o700 });
  const configure = overrides => configureBackground({ ...f, coordinator, execPath, env: { ...f.env, CODEX_HOME: join(f.home, 'different-profile') },
    status, run, available: () => true, log: value => logs.push(value), wait: async () => {},
    manage: (command, file) => manageBackground(command, file, { run, contact, wait: async () => {} }), ...overrides,
  });
  return { older, coordinator, execPath, commands, logs, configure };
}

test('declining an update defaults to preserving an older running or stopped helper', async () => {
  for (const running of [true, false]) {
    const f = fixture();
    try {
      const update = await updateFixture(f, running);
      const files = [f.configFile, metadataPath(f.configFile), update.older.file, join(f.home, 'manage')];
      const before = files.map(file => readFileSync(file)); let prompts = 0;
      const result = await update.configure({ ask: async prompt => { prompts++; assert.match(prompt, /Update Providence now.*\[y\/N\]/); return ''; }, manage: () => assert.fail('declined update must not stop work') });
      assert.equal(prompts, 1); assert.equal(result.updated, false); assert.equal(result.versionMismatch, true);
      assert.equal(result.running, running); assert.equal(result.foreground, false); assert.deepEqual(update.commands, []);
      files.forEach((file, index) => assert.deepEqual(readFileSync(file), before[index]));
      assert.ok(update.logs.some(value => value.includes('newly downloaded release is not active')));
    } finally { rmSync(f.home, { recursive: true, force: true }); }
  }
});

test('accepted update confirms old shutdown before switching source and Node while preserving identity and access', async () => {
  const f = fixture();
  try {
    writePrivateJson(f.configFile, { deviceId: 'fixture', token: 'a'.repeat(64), workerAccess: 'workspace', keepAwake: false, workspace: join(f.home, 'documents') });
    const update = await updateFixture(f);
    const before = readFileSync(f.configFile); let prompts = 0;
    const result = await update.configure({ ask: async prompt => { prompts++; assert.match(prompt, /Current work on this computer will stop/); return 'yes'; } });
    assert.equal(prompts, 1, 'Existing background consent must not be requested a second time');
    assert.equal(result.updated, true); assert.equal(result.running, true); assert.equal(result.foreground, false);
    const current = readPrivateJson(metadataPath(f.configFile));
    assert.equal(current.coordinator, update.coordinator); assert.equal(current.execPath, update.execPath);
    assert.equal(current.environment.CODEX_HOME, update.older.environment.CODEX_HOME);
    assert.equal(current.codexBinary, update.older.codexBinary);
    assert.deepEqual(readFileSync(f.configFile), before);
    assert.ok(readFileSync(join(f.home, 'manage'), 'utf8').includes(update.coordinator));
    const operations = update.commands.map(([,args]) => args[0]);
    assert.ok(operations.indexOf('bootout') < operations.indexOf('bootstrap'));
    assert.equal(operations.filter(operation => operation === 'bootstrap').length, 1);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('accepted update preserves the default Codex profile when no prior CODEX_HOME was set', async () => {
  const f = fixture(); delete f.env.CODEX_HOME;
  try {
    const update = await updateFixture(f);
    const result = await update.configure({ ask: async () => 'y' });
    assert.equal(result.updated, true);
    assert.equal(readPrivateJson(metadataPath(f.configFile)).environment.CODEX_HOME, undefined);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('unknown shutdown or leftover registration blocks an accepted update without replacing controls', async () => {
  for (const proof of [false, true]) {
    const f = fixture();
    try {
      const update = await updateFixture(f);
      const files = [f.configFile, metadataPath(f.configFile), update.older.file, join(f.home, 'manage')];
      const before = files.map(file => readFileSync(file));
      const result = await update.configure({ ask: async () => 'yes',
        manage: async () => ({ installed: !proof, running: proof ? false : null, stopConfirmed: proof, state: proof ? 'not-installed' : 'unknown' }),
        save: () => assert.fail('No new service may be installed without verified old registration removal'),
      });
      assert.equal(result.updated, false); assert.equal(result.foreground, false); assert.deepEqual(update.commands, []);
      files.forEach((file, index) => assert.deepEqual(readFileSync(file), before[index]));
    } finally { rmSync(f.home, { recursive: true, force: true }); }
  }
});

test('a configuration change during update confirmation is preserved and prevents interruption', async () => {
  const f = fixture();
  try {
    const update = await updateFixture(f);
    const newerConfig = { deviceId: 'fixture', workerAccess: 'workspace', keepAwake: true };
    const result = await update.configure({ ask: async () => { writePrivateJson(f.configFile, newerConfig); return 'yes'; }, manage: () => assert.fail('Changed configuration must be reviewed before stopping') });
    assert.equal(result.updated, false); assert.deepEqual(update.commands, []);
    assert.deepEqual(readPrivateJson(f.configFile), newerConfig);
    assert.deepEqual(readPrivateJson(metadataPath(f.configFile)), update.older);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('changed startup definitions are not overwritten or executed', async () => {
  const f = fixture();
  try {
    const spec = { ...serviceSpec(f), home: f.home, uid: f.uid };
    mkdirSync(dirname(spec.file), { recursive: true }); writeFileSync(spec.file, 'user change', { mode: 0o600 });
    writePrivateJson(metadataPath(f.configFile), spec);
    await assert.rejects(manageBackground('start', f.configFile, { contact: async () => undefined, run: () => assert.fail('must not execute changed file') }), /changed outside/);
    assert.equal(readFileSync(spec.file, 'utf8'), 'user change');
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('action-required exit 78 is recorded once without restart or permission changes', async () => {
  const f = fixture(); let launches = 0;
  try {
    const before = readFileSync(f.configFile);
    assert.equal(await runBackground(f.configFile, { launch: async () => { launches++; return 78; }, wait: () => assert.fail('must not restart'), signals: new EventEmitter() }), 0);
    assert.equal(launches, 1);
    const state = readPrivateJson(statePath(f.configFile));
    assert.equal(state.state, 'action-required'); assert.equal(state.token, undefined);
    assert.deepEqual(readFileSync(f.configFile), before);
    assert.equal(existsSync(f.configFile + '.background.lock'), false);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('unexpected process defects have only three retries', async () => {
  const f = fixture(); let launches = 0; const waits = [];
  try {
    await runBackground(f.configFile, { launch: async () => { launches++; return 75; }, wait: async value => waits.push(value), signals: new EventEmitter() });
    assert.equal(launches, 4);
    assert.deepEqual(waits, [1000,5000,15000]);
    assert.equal(readPrivateJson(statePath(f.configFile)).state, 'failed');
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('authenticated local stop ends the runner without PID-based killing or restarting', async () => {
  const f = fixture(); const signals = new EventEmitter(); let launches = 0;
  try {
    const completion = runBackground(f.configFile, { signals, launch: async () => { launches++; return new Promise(accept => signals.once('SIGTERM', () => accept(0))); } });
    for (let i = 0; i < 50 && !existsSync(statePath(f.configFile)); i++) await delay(10);
    assert.deepEqual(await contactBackground(f.configFile), { running: true, state: 'running' });
    const activeState = readFileSync(statePath(f.configFile));
    const activeLog = readFileSync(join(f.home, 'companion.log'));
    await assert.rejects(runBackground(f.configFile, { signals: new EventEmitter(), launch: () => assert.fail('duplicate supervisor') }));
    assert.deepEqual(readFileSync(statePath(f.configFile)), activeState);
    assert.deepEqual(readFileSync(join(f.home, 'companion.log')), activeLog);
    assert.deepEqual(await contactBackground(f.configFile), { running: true, state: 'running' });
    assert.deepEqual(await contactBackground(f.configFile, 'stop'), { accepted: true });
    await completion;
    assert.equal(launches, 1);
    assert.equal(readPrivateJson(statePath(f.configFile)).state, 'stopped');
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('an existing log symlink is rejected before any log content or state changes', { skip: process.platform === 'win32' }, async () => {
  const f = fixture();
  try {
    const other = join(f.home, 'other-file'); writeFileSync(other, 'preserve');
    symlinkSync(other, join(f.home, 'companion.log'));
    await assert.rejects(runBackground(f.configFile, { launch: () => assert.fail('unsafe log must stop startup') }), /regular file owned/);
    assert.equal(readFileSync(other, 'utf8'), 'preserve');
    assert.equal(existsSync(statePath(f.configFile)), false);
    assert.equal(existsSync(f.configFile + '.background.lock'), false);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('local control rejects requests without its private token', async () => {
  const f = fixture(); const signals = new EventEmitter();
  try {
    const completion = runBackground(f.configFile, { signals, launch: async () => new Promise(accept => signals.once('SIGTERM', () => accept(0))) });
    for (let i = 0; i < 50 && !existsSync(statePath(f.configFile)); i++) await delay(10);
    const state = readPrivateJson(statePath(f.configFile));
    const unauthenticated = await new Promise((accept, reject) => {
      const socket = createConnection(state.endpoint); let output = '';
      socket.on('connect', () => socket.write('{"command":"stop","token":"wrong"}\n'));
      socket.on('data', chunk => { output += chunk; }); socket.on('end', () => accept(output)); socket.on('error', reject);
    });
    assert.equal(unauthenticated, '');
    assert.equal((await contactBackground(f.configFile)).running, true);
    await contactBackground(f.configFile, 'stop'); await completion;
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});
