// Temporary idle-sleep protection. No persistent power, display, or lock settings.
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const READY = 'PROVIDENCE_KEEP_AWAKE_READY';
const DENIED = 'PROVIDENCE_KEEP_AWAKE_UNAVAILABLE';

function parentExists(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Only accept the assertion belonging to the owned caffeinate child. */
export function ownsMacIdleAssertion(output, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof output !== 'string') return false;
  return new RegExp(`^\\s*pid\\s*${pid}\\(caffeinate\\):[^\\n]*\\bPreventUserIdleSystemSleep\\b`, 'm').test(output);
}

export async function startKeepAwake({
  platform = process.platform, parentPid = process.pid, onChange,
  // Adapters keep fixture tests from changing the host's power behavior.
  spawn = nodeSpawn, execFile = nodeExecFile, exists = existsSync,
  parentAlive = parentExists, wait = delay, startupTimeoutMs = 5000, stopTimeoutMs = 1500,
} = {}) {
  let state = { active: false };
  const change = next => {
    if (state.active === next.active && state.method === next.method && state.reason === next.reason) return;
    state = { ...next };
    try { onChange?.({ ...state }); } catch { /* Reporting cannot hold a sleep assertion open. */ }
  };
  const failure = reason => {
    change({ active: false, reason });
    return { get status() { return { ...state }; }, async stop() {} };
  };
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || !parentAlive(parentPid)) return failure('invalid_parent');
  let binary, args, method;
  if (platform === 'darwin') {
    // -i prevents idle system sleep; no -d, -u, or -s assertions are requested.
    binary = '/usr/bin/caffeinate'; args = ['-i', '-w', String(parentPid)]; method = 'caffeinate-idle';
  } else if (platform === 'win32') {
    binary = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // A fixed in-repository command avoids modifying PowerShell execution policy.
    // No credentials or user-provided script text occur in these arguments.
    let program;
    try { program = readFileSync(join(HERE, 'keep-awake.ps1'), 'utf8'); } catch { return failure('helper_unavailable'); }
    args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', program]; method = 'windows-execution-state';
  } else if (platform === 'linux') {
    binary = ['/usr/bin/systemd-inhibit', '/bin/systemd-inhibit'].find(exists);
    if (!binary) return failure('helper_unavailable');
    // Inhibit automatic idle handling only. Never inhibit explicit sleep,
    // shutdown, power buttons, or the lid switch, and never prompt for elevation.
    args = ['--what=idle', '--mode=block', '--who=Providence', '--why=Providence companion is available', '--no-ask-password', '--', process.execPath, fileURLToPath(import.meta.url), '--logind-lease', String(parentPid)];
    method = 'logind-idle';
  } else return failure('unsupported_platform');
  if (!exists(binary)) return failure('helper_unavailable');

  let child;
  try { child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true }); }
  catch { return failure('helper_unavailable'); }
  let closed = false, stopping = false, activated = false, startupResult, releasePromise;
  let settleStartup;
  const acknowledged = new Promise(accept => { settleStartup = value => { if (startupResult === undefined) { startupResult = value; accept(value); } }; });
  let resolveExit;
  const exited = new Promise(accept => { resolveExit = accept; });
  child.once('error', () => {
    // An error signalling an already-started child is not proof it exited.
    if (Number.isSafeInteger(child.pid) && child.pid > 0) {
      settleStartup('helper_unavailable');
      if (activated && stopping) change({ active: state.active, method, reason: 'stop_unconfirmed' });
      return;
    }
    closed = true; resolveExit(); settleStartup('helper_unavailable');
  });
  child.once('exit', () => {
    closed = true; resolveExit(); settleStartup('assertion_unavailable');
    if (activated) change({ active: false, method, reason: stopping ? 'stopped' : 'helper_exited' });
  });
  // Drain, but never persist or forward, arbitrary utility errors.
  child.stderr?.on('error', () => {});
  child.stderr?.resume();
  child.stdin?.on('error', () => {});
  child.stdout?.on('error', () => settleStartup('startup_unconfirmed'));
  let output = '';
  child.stdout?.on('data', chunk => {
    output += chunk.toString('utf8');
    if (output.length > 8192) { settleStartup('startup_unconfirmed'); output = ''; return; }
    while (output.includes('\n')) {
      const newline = output.indexOf('\n');
      const line = output.slice(0, newline).replace(/\r$/, ''); output = output.slice(newline + 1);
      if (line === READY) settleStartup('ready');
      if (line === DENIED) settleStartup('assertion_unavailable');
    }
  });

  const awaitExit = async () => {
    if (closed) return true;
    let timer;
    const result = await Promise.race([exited.then(() => true), new Promise(accept => { timer = setTimeout(() => accept(false), stopTimeoutMs); })]);
    clearTimeout(timer); return result;
  };
  const release = async () => {
    if (closed) return true;
    stopping = true;
    // Closing the writer releases Windows/Linux leases even if the owner exits.
    try { child.stdin?.end(); } catch {}
    if (platform === 'darwin') { try { child.kill('SIGTERM'); } catch {} }
    if (await awaitExit()) return true;
    try { child.kill('SIGTERM'); } catch {}
    if (await awaitExit()) return true;
    try { child.kill('SIGKILL'); } catch {}
    return awaitExit();
  };
  const stop = async () => {
    if (!releasePromise) releasePromise = release().then(released => {
      change({ active: released ? false : state.active, method, reason: released ? 'stopped' : 'stop_unconfirmed' });
    });
    await releasePromise;
  };

  let result;
  if (platform === 'darwin') {
    const deadline = Date.now() + startupTimeoutMs;
    while (!closed && Date.now() < deadline) {
      const assertions = await new Promise(accept => {
        execFile('/usr/bin/pmset', ['-g', 'assertions'], { timeout: 1000, maxBuffer: 256 * 1024, encoding: 'utf8', windowsHide: true }, (error, stdout) => accept(error ? '' : stdout));
      });
      if (!closed && ownsMacIdleAssertion(assertions, child.pid)) { result = 'ready'; break; }
      if (!closed) await wait(100);
    }
    result ??= startupResult || 'startup_unconfirmed';
  } else {
    let timer;
    result = await Promise.race([acknowledged, new Promise(accept => { timer = setTimeout(() => accept('startup_unconfirmed'), startupTimeoutMs); })]);
    clearTimeout(timer);
  }
  if (result !== 'ready' || closed) {
    const released = await release();
    change({ active: false, method, reason: released ? (result === 'ready' ? 'helper_exited' : result) : 'stop_unconfirmed' });
  } else {
    activated = true;
    change({ active: true, method, reason: 'idle_sleep_inhibited' });
  }
  return { get status() { return { ...state }; }, stop };
}

// systemd-inhibit acquires its lock before executing this small lease process.
// The parent-owned stdin pipe, not a persistent setting, defines its lifetime.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--logind-lease') {
  const pid = Number(process.argv[3]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !parentExists(pid) || process.stdin.isTTY) process.exit(2);
  process.stdin.once('end', () => process.exit(0));
  process.stdin.once('error', () => process.exit(0));
  process.stdout.once('error', () => process.exit(0));
  process.stdin.on('data', () => process.exit(0));
  process.stdin.resume();
  // Also bound the lease to the nominated owner if it differs from the pipe owner.
  setInterval(() => { if (!parentExists(pid)) process.exit(0); }, 1000).unref();
  process.stdout.write(READY + '\n');
}
