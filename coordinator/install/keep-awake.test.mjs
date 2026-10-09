import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as realSpawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startKeepAwake, ownsMacIdleAssertion } from './keep-awake.mjs';

class Helper extends EventEmitter {
  constructor({ acknowledgement, exitOnEnd = true, exitOnKill = true } = {}) {
    super(); this.pid = 987654; this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.kills = []; this.ended = 0;
    this.stdin.on('finish', () => { this.ended++; if (exitOnEnd) this.finish(); });
    this.kill = signal => { this.kills.push(signal); if (exitOnKill) this.finish(); return true; };
    queueMicrotask(() => { this.emit('spawn'); if (acknowledgement) this.stdout.write(acknowledgement + '\n'); });
  }
  finish() { if (this.closed) return; this.closed = true; this.emit('exit', 0, null); }
}
const adapters = { parentAlive: () => true, exists: () => true, startupTimeoutMs: 20, stopTimeoutMs: 5 };

test('macOS validates only its own idle-system assertion and binds it to the owner PID', async () => {
  let child, invocation; const states = [];
  const handle = await startKeepAwake({ ...adapters, platform: 'darwin', parentPid: 1234, onChange: state => states.push(state),
    spawn: (binary,args,options) => { invocation = { binary,args,options }; child = new Helper({ exitOnEnd: false }); return child; },
    execFile: (_binary,_args,_options,callback) => callback(null, ' pid987654(caffeinate): [0x123] 00:00:00 PreventUserIdleSystemSleep named: "caffeinate command-line tool"\n'),
  });
  assert.equal(handle.status.active, true);
  assert.deepEqual(invocation.args, ['-i','-w','1234']);
  assert.equal(invocation.binary, '/usr/bin/caffeinate');
  assert.equal(invocation.options.shell, false);
  await handle.stop(); await handle.stop();
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(handle.status.active, false); assert.equal(handle.status.reason, 'stopped');
  assert.deepEqual(states.map(state => state.reason), ['idle_sleep_inhibited','stopped']);
});

test('unrelated or display-only macOS assertions never establish readiness', async () => {
  assert.equal(ownsMacIdleAssertion('pid999(caffeinate): PreventUserIdleSystemSleep', 998), false);
  assert.equal(ownsMacIdleAssertion('pid998(caffeinate): PreventUserIdleDisplaySleep', 998), false);
  assert.equal(ownsMacIdleAssertion('pid998(other): PreventUserIdleSystemSleep', 998), false);
  let child;
  const handle = await startKeepAwake({ ...adapters, platform: 'darwin', startupTimeoutMs: 5,
    spawn: () => { child = new Helper({ exitOnEnd: false }); return child; },
    execFile: (_binary,_args,_options,callback) => callback(null, 'pid123(caffeinate): PreventUserIdleSystemSleep'),
  });
  assert.equal(handle.status.active, false); assert.equal(handle.status.reason, 'startup_unconfirmed');
  assert.equal(child.closed, true);
});

test('Windows waits for native-thread acknowledgment and releases through its stdin lifetime', async () => {
  let child, invocation;
  const handle = await startKeepAwake({ ...adapters, platform: 'win32',
    spawn: (binary,args,options) => { invocation = {binary,args,options}; child = new Helper({ acknowledgement: 'PROVIDENCE_KEEP_AWAKE_READY' }); return child; },
  });
  assert.equal(handle.status.method, 'windows-execution-state'); assert.equal(handle.status.active, true);
  assert.ok(invocation.binary.endsWith('powershell.exe'));
  assert.ok(invocation.args.includes('-NonInteractive')); assert.ok(invocation.args.includes('-Command'));
  assert.ok(!invocation.args.includes('-ExecutionPolicy')); assert.equal(invocation.options.windowsHide, true);
  const program = invocation.args.at(-1);
  assert.ok(program.includes('new Thread('));
  assert.ok(program.includes('SetThreadExecutionState(0x80000001u)'));
  assert.ok(program.includes('SetThreadExecutionState(0x80000000u)'));
  assert.ok(!program.includes('0x80000003')); assert.ok(!program.includes('0x00000040'));
  assert.ok(program.includes('Console.OpenStandardInput()'));
  await handle.stop(); assert.equal(child.ended, 1); assert.deepEqual(child.kills, []);
});

test('Linux requests idle only with noninteractive logind policy and releases on pipe EOF', async () => {
  let child, invocation;
  const handle = await startKeepAwake({ ...adapters, platform: 'linux',
    spawn: (binary,args,options) => { invocation = {binary,args,options}; child = new Helper({ acknowledgement: 'PROVIDENCE_KEEP_AWAKE_READY' }); return child; },
  });
  assert.equal(handle.status.method, 'logind-idle'); assert.equal(handle.status.active, true);
  assert.ok(invocation.args.includes('--what=idle'));
  assert.ok(invocation.args.includes('--no-ask-password'));
  assert.ok(!invocation.args.some(arg => /^--what=.*(?:sleep|shutdown|lid|power)/.test(arg)));
  assert.deepEqual(invocation.options.stdio, ['pipe','pipe','pipe']);
  await handle.stop(); assert.equal(child.ended, 1); assert.equal(child.closed, true);
});

test('denied or missing helpers remain inactive and expose fixed reason codes only', async () => {
  const missing = await startKeepAwake({ ...adapters, platform: 'linux', exists: () => false, spawn: () => assert.fail('not installed') });
  assert.deepEqual(missing.status, { active: false, reason: 'helper_unavailable' });
  let child;
  const denied = await startKeepAwake({ ...adapters, platform: 'win32', spawn: () => {
    child = new Helper({ acknowledgement: 'PROVIDENCE_KEEP_AWAKE_UNAVAILABLE' }); child.stderr.write('fixture-private-error'); return child;
  } });
  assert.equal(denied.status.active, false); assert.equal(denied.status.reason, 'assertion_unavailable');
  assert.equal(child.closed, true); assert.ok(!JSON.stringify(denied.status).includes('fixture-private-error'));
  const absent = await startKeepAwake({ ...adapters, platform: 'win32', spawn: () => { const process = new Helper(); process.pid = undefined; queueMicrotask(() => process.emit('error', new Error('fixture-private-error'))); return process; } });
  assert.equal(absent.status.reason, 'helper_unavailable');
});

test('unacknowledged helpers are cleaned up before startup reports inactive', async () => {
  let child;
  const handle = await startKeepAwake({ ...adapters, platform: 'linux', startupTimeoutMs: 5, spawn: () => { child = new Helper(); return child; } });
  assert.equal(handle.status.active, false); assert.equal(handle.status.reason, 'startup_unconfirmed');
  assert.equal(child.closed, true);
});

test('unexpected helper exit updates the live status without restarting a process', async () => {
  const changes = []; let child, spawns = 0;
  const handle = await startKeepAwake({ ...adapters, platform: 'linux', onChange: state => changes.push(state), spawn: () => { spawns++; child = new Helper({ acknowledgement: 'PROVIDENCE_KEEP_AWAKE_READY' }); return child; } });
  child.finish();
  assert.equal(handle.status.active, false); assert.equal(handle.status.reason, 'helper_exited');
  assert.equal(changes.at(-1).reason, 'helper_exited'); assert.equal(spawns, 1);
  const snapshot = handle.status; snapshot.active = true;
  assert.equal(handle.status.active, false);
});

test('stopping an unresponsive owned helper escalates only its signals and reports uncertainty', async () => {
  let child;
  const handle = await startKeepAwake({ ...adapters, platform: 'linux', stopTimeoutMs: 2, spawn: () => { child = new Helper({ acknowledgement: 'PROVIDENCE_KEEP_AWAKE_READY', exitOnEnd: false, exitOnKill: false }); return child; } });
  await handle.stop();
  assert.equal(handle.status.reason, 'stop_unconfirmed'); assert.equal(handle.status.active, true);
  assert.deepEqual(child.kills, ['SIGTERM','SIGKILL']);
  child.finish();
  assert.equal(handle.status.active, false); assert.equal(handle.status.reason, 'stopped');
});

test('unsupported platforms or an invalid owner never start an inhibitor', async () => {
  const unsupported = await startKeepAwake({ ...adapters, platform: 'freebsd', spawn: () => assert.fail('unsupported') });
  assert.equal(unsupported.status.reason, 'unsupported_platform');
  const invalid = await startKeepAwake({ ...adapters, platform: 'darwin', parentPid: 0, spawn: () => assert.fail('invalid owner') });
  assert.equal(invalid.status.reason, 'invalid_parent');
});

test('the real logind lease subprocess acknowledges then exits on parent-owned stdin EOF', async () => {
  // This is only the lease child: no systemd-inhibit or power assertion is used.
  const helper = fileURLToPath(new URL('./keep-awake.mjs', import.meta.url));
  const child = realSpawn(process.execPath, [helper, '--logind-lease', String(process.pid)], { stdio: ['pipe','pipe','pipe'], shell: false });
  try {
    const [data] = await once(child.stdout, 'data');
    assert.equal(data.toString().trim(), 'PROVIDENCE_KEEP_AWAKE_READY');
    const ended = once(child, 'exit'); child.stdin.end();
    const [code] = await ended; assert.equal(code, 0);
  } finally { if (child.exitCode === null) child.kill(); }
});

test('Windows assertion acquisition and reset stay within the same dedicated thread', () => {
  const script = readFileSync(new URL('./keep-awake.ps1', import.meta.url), 'utf8');
  const thread = script.slice(script.indexOf('Thread worker = new Thread('), script.indexOf('worker.IsBackground'));
  assert.ok(thread.indexOf('0x80000001u') < thread.indexOf('PROVIDENCE_KEEP_AWAKE_READY'));
  assert.ok(thread.indexOf('finally') < thread.indexOf('0x80000000u'));
  assert.ok(!/powercfg|SetSuspendState|ExecutionPolicy|ES_DISPLAY_REQUIRED|ES_AWAYMODE_REQUIRED/.test(script));
});
