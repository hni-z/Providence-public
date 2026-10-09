#!/usr/bin/env node
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, lstatSync, statSync, realpathSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const COORDINATOR = resolve(HERE, '..');
const MAX_METADATA = 65536;
const safe = value => {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('A background helper path or environment value is invalid.');
  return value;
};
const xml = value => safe(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const unit = value => '"' + safe(value).replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const vb = value => '"' + safe(value).replace(/"/g, '""') + '"';
const shell = value => "'" + safe(value).replace(/'/g, "'\\''") + "'";

export const metadataPath = file => file + '.background.json';
export const statePath = file => file + '.background-state.json';
export const logPath = file => join(dirname(file), 'companion.log');

export function readPrivateJson(file) {
  if (!existsSync(file)) return undefined;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_METADATA || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) throw new Error('A helper state file is not private to your account.');
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writePrivateJson(file, data) {
  const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try { renameSync(temporary, file); } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function resolveServiceCodex(binary, env = process.env, platform = process.platform) {
  safe(binary);
  const candidates = isAbsolute(binary) ? [binary] : (env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => resolve(directory, binary));
  const found = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  if (!found || (platform === 'win32' && !/\.exe$/i.test(found))) throw new Error('Background startup needs the native Codex executable selected by the installer.');
  return realpathSync(found);
}

export function serviceSpec({ configFile, coordinator = COORDINATOR, execPath = process.execPath, codexBinary, platform = process.platform, home = homedir(), env = process.env, uid = process.getuid?.() }) {
  for (const value of [configFile, coordinator, execPath, home, codexBinary]) safe(value);
  if (![configFile, coordinator, execPath, home, codexBinary].every(isAbsolute)) throw new Error('Background helper paths must be absolute.');
  const id = 'so.hani.providence.' + createHash('sha256').update(configFile).digest('hex').slice(0, 12);
  const runner = join(coordinator, 'install', 'background-runner.mjs');
  const pathPrefix = dirname(execPath) + delimiter;
  const configuredPath = safe(env.PATH || '/usr/bin:/bin');
  const environment = { CODEX_BIN: codexBinary, PATH: configuredPath.startsWith(pathPrefix) ? configuredPath : pathPrefix + configuredPath };
  if (env.CODEX_HOME) environment.CODEX_HOME = safe(env.CODEX_HOME);
  const common = { schemaVersion: 1, id, platform, configFile, coordinator, execPath, codexBinary, environment, runner };
  if (platform === 'darwin') {
    if (!Number.isInteger(uid) || uid < 1) throw new Error('Background startup must run as your regular user, not root.');
    const file = join(home, 'Library', 'LaunchAgents', id + '.plist');
    const strings = [execPath, runner, configFile].map(value => `<string>${xml(value)}</string>`).join('');
    const variables = Object.entries(environment).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('');
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${id}</string><key>ProgramArguments</key><array>${strings}</array><key>WorkingDirectory</key><string>${xml(coordinator)}</string><key>EnvironmentVariables</key><dict>${variables}</dict><key>RunAtLoad</key><true/><key>ProcessType</key><string>Interactive</string><key>LimitLoadToSessionType</key><string>Aqua</string></dict></plist>\n`;
    return { ...common, file, content, target: `gui/${uid}/${id}`, domain: `gui/${uid}` };
  }
  if (platform === 'linux') {
    if (uid === 0) throw new Error('Background startup must run as your regular user, not root.');
    const file = join(home, '.config', 'systemd', 'user', id + '.service');
    const variables = Object.entries(environment).map(([key, value]) => `Environment=${unit(key + '=' + value)}`).join('\n');
    return { ...common, file, unit: id + '.service', content: `[Unit]\nDescription=Providence companion for this user\n\n[Service]\nType=simple\nExecStart=${[execPath, runner, configFile].map(unit).join(' ')}\nWorkingDirectory=${unit(coordinator)}\n${variables}\nRestart=no\nUMask=0077\n\n[Install]\nWantedBy=default.target\n` };
  }
  if (platform === 'win32') {
    const appData = safe(env.APPDATA || join(home, 'AppData', 'Roaming'));
    const file = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', id + '.vbs');
    const variables = Object.entries(environment).map(([key, value]) => `helper.Environment("Process")(${vb(key)}) = ${vb(value)}`).join('\r\n');
    const command = [execPath, runner, configFile].map(value => '"' + value + '"').join(' ');
    return { ...common, file, content: `Set helper = CreateObject("WScript.Shell")\r\n${variables}\r\nhelper.CurrentDirectory = ${vb(coordinator)}\r\nhelper.Run ${vb(command)}, 0, False\r\n` };
  }
  throw new Error('Background startup is not supported on this platform.');
}

function execute(binary, args, allowedFailure = false) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: false });
  if (result.status !== 0 && !allowedFailure) throw new Error('The operating system could not configure the background helper.');
  return result.status === 0;
}

function supported(spec, run = execute) {
  if (spec.platform === 'linux') return run('systemctl', ['--user', 'show', '--property=Version', '--value'], true);
  if (spec.platform === 'win32') return existsSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'));
  return true;
}

function validateMetadata(value, configFile) {
  if (!value || value.schemaVersion !== 1 || value.configFile !== configFile || !['darwin', 'linux', 'win32'].includes(value.platform) || !/^so\.hani\.providence\.[a-f0-9]{12}$/.test(value.id)) throw new Error('Existing background configuration is unrecognized and was left untouched.');
  // Regenerate the service path and content from its bounded metadata. Never run
  // an arbitrary persisted command or use an arbitrary persisted service name.
  const expected = serviceSpec({ ...value, home: value.home, env: value.environment, uid: value.uid });
  if (expected.file !== value.file || expected.id !== value.id || expected.content !== value.content) throw new Error('Existing background configuration has an unexpected location or content.');
  return { ...value, ...expected };
}

export async function contactBackground(configFile, command = 'status', connect = createConnection) {
  const state = readPrivateJson(statePath(configFile));
  if (!state?.endpoint || typeof state.token !== 'string' || !/^[a-f0-9]{64}$/.test(state.token)) return undefined;
  const socketDirectory = dirname(configFile);
  if (process.platform === 'win32') {
    if (!/^\\\\\.\\pipe\\providence-[a-f0-9]{32}$/.test(state.endpoint)) throw new Error('Unrecognized background control endpoint.');
  } else if (dirname(state.endpoint) !== socketDirectory || !/^\.p-[a-f0-9]{16}\.sock$/.test(basename(state.endpoint))) throw new Error('Unrecognized background control endpoint.');
  return new Promise(accept => {
    let settled = false, buffer = '';
    const socket = connect(state.endpoint);
    const finish = result => { if (!settled) { settled = true; socket.destroy(); accept(result); } };
    socket.setTimeout(1200, () => finish(undefined));
    socket.on('error', () => finish(undefined));
    socket.on('connect', () => socket.write(JSON.stringify({ command, token: state.token }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 4096) return finish(undefined);
      if (buffer.includes('\n')) { try { finish(JSON.parse(buffer.split('\n')[0])); } catch { finish(undefined); } }
    });
    socket.on('end', () => finish(undefined));
  });
}

export async function backgroundStatus({ configFile, contact = contactBackground } = {}) {
  const raw = readPrivateJson(metadataPath(configFile));
  if (!raw) return { installed: false, running: false, state: 'not-installed' };
  const metadata = validateMetadata(raw, configFile);
  const response = await contact(configFile);
  const saved = readPrivateJson(statePath(configFile));
  const uncertain = !response && (existsSync(configFile + '.background.lock') || existsSync(configFile + '.lock') || ['starting', 'running', 'retrying'].includes(saved?.state));
  return { installed: true, running: response?.running === true ? true : uncertain ? null : false, state: response?.state || (uncertain ? 'unknown' : saved?.state || 'stopped'), metadata };
}

// Inspect executable identity only. A PID reused by another program is never a
// reason to signal that program. Win32_Process.Name is its executable image
// name; unlike ExecutablePath it does not require SeDebugPrivilege. A missing
// path is acceptable only for a positively different, non-Node image name.
// https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process
export function inspectWindowsProcesses({ pids, execPath }, { platform = process.platform, run = spawnSync, env = process.env } = {}) {
  if (platform !== 'win32' || !pids.length || !pids.every(pid => Number.isSafeInteger(pid) && pid > 0)) return undefined;
  const processName = win32.basename(execPath).toLowerCase();
  if (!/^[a-z0-9_-]{1,64}\.exe$/i.test(processName)) return undefined;
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); try { $ids=@(${pids.join(',')}); $items=@(); foreach($p in (Get-CimInstance -ClassName Win32_Process -Property ProcessId,Name,ExecutablePath -ErrorAction Stop)) { if([string]::IsNullOrWhiteSpace($p.Name)){throw 'unknown'}; if(($ids -contains $p.ProcessId) -or ($p.Name -eq '${processName}' -and $p.ProcessId -ne ${process.pid})) { $items+=@{pid=$p.ProcessId;imageName=$p.Name;executable=$p.ExecutablePath}; if($items.Count -gt 256){throw 'unknown'} } }; @{complete=$true;processes=$items}|ConvertTo-Json -Compress -Depth 3 } catch { exit 1 }`;
  try {
    const result = run(win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: MAX_METADATA });
    if (result.status !== 0) return undefined;
    const value = JSON.parse(result.stdout);
    if (value.complete !== true || !Array.isArray(value.processes) || value.processes.length > 256) return undefined;
    const seen = new Set();
    for (const item of value.processes) {
      if (!Number.isSafeInteger(item?.pid) || item.pid < 1 || seen.has(item.pid) || typeof item.imageName !== 'string' ||
          !item.imageName || item.imageName.length > 260 || /[\\/:\u0000-\u001f\u007f]/.test(item.imageName)) return undefined;
      const isNode = item.imageName.toLowerCase() === processName;
      if (!pids.includes(item.pid) && !isNode) return undefined;
      if (item.executable == null || item.executable === '') {
        if (isNode) return undefined;
      } else if (typeof item.executable !== 'string' || item.executable.length > 4096 || !win32.isAbsolute(item.executable) ||
                 /[\u0000-\u001f\u007f]/.test(item.executable)) return undefined;
      seen.add(item.pid);
    }
    return value.processes;
  } catch { return undefined; }
}

export async function recoverStaleWindowsBackground({ configFile, platform = process.platform, contact = contactBackground, inspect = inspectWindowsProcesses } = {}) {
  if (platform !== 'win32') return false;
  const files = [metadataPath(configFile), statePath(configFile), configFile + '.lock', configFile + '.background.lock'];
  try {
    const snapshots = files.map(file => {
      const value = readPrivateJson(file);
      return value === undefined ? { file } : { file, value, stat: lstatSync(file), bytes: readFileSync(file) };
    });
    const metadata = validateMetadata(snapshots[0].value, configFile);
    if (metadata.platform !== 'win32') return false;
    const manager = managerDefinition(metadata);
    const controls = [{ path: metadata.file, content: metadata.content }, manager].map(control => ({ ...control, present: existsSync(control.path) }));
    for (const { path, content } of controls) {
      if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || readFileSync(path, 'utf8') !== content)) return false;
    }
    const pids = new Set();
    const state = snapshots[1].value;
    if (state !== undefined) {
      if (state.schemaVersion !== 1 || !['starting', 'running', 'retrying', 'stopped', 'action-required', 'failed'].includes(state.state) ||
          !Number.isSafeInteger(state.pid) || state.pid < 1) return false;
      pids.add(state.pid);
    }
    for (const { value } of snapshots.slice(2)) {
      if (value === undefined) continue;
      // A missing child PID might hide a child launched just before a crash.
      if (!Number.isSafeInteger(value.pid) || value.pid < 1 || !Number.isSafeInteger(value.childPid) || value.childPid < 1) return false;
      pids.add(value.pid); pids.add(value.childPid);
    }
    if (!pids.size) return false;
    const normalized = path => win32.normalize(path.replace(/^\\\\\?\\/, '')).toLowerCase();
    const expected = new Set([normalized(metadata.execPath)]);
    try { expected.add(normalized(realpathSync(metadata.execPath))); } catch { return false; }
    const proof = async () => {
      if (await contact(configFile)) return false;
      const processes = await inspect({ pids: [...pids], execPath: metadata.execPath });
      if (!Array.isArray(processes)) return false;
      for (const item of processes) {
        if (typeof item.imageName !== 'string' || !item.imageName) return false;
        const isNode = item.imageName.toLowerCase() === win32.basename(metadata.execPath).toLowerCase();
        if (item.executable) { if (expected.has(normalized(item.executable))) return false; }
        else if (isNode || !pids.has(item.pid)) return false;
        // Another node.exe at a recorded PID is ambiguous even at another path.
        if (pids.has(item.pid) && isNode) return false;
      }
      return true;
    };
    const unchanged = () => controls.every(({ path, content, present }) => existsSync(path) === present &&
      (!present || (!lstatSync(path).isSymbolicLink() && lstatSync(path).isFile() && readFileSync(path, 'utf8') === content))) && snapshots.every(({ file, stat, bytes }) => {
      if (!stat) return !existsSync(file);
      const current = lstatSync(file);
      return !current.isSymbolicLink() && current.isFile() && current.ino === stat.ino && current.dev === stat.dev && current.size === stat.size &&
        current.mtimeMs === stat.mtimeMs && readFileSync(file).equals(bytes);
    });
    // Recheck both OS identity and the same private files before any mutation.
    if (!(await proof()) || !unchanged() || !(await proof()) || !unchanged()) return false;
    // Keep the supervisor lock until the old state and child lock are retired.
    // Any later launcher must still acquire both ordinary exclusive locks.
    writePrivateJson(statePath(configFile), { schemaVersion: 1, state: 'stopped' });
    for (const { file, stat } of snapshots.slice(2)) if (stat) unlinkSync(file);
    return true;
  } catch { return false; }
}

function ensureUnlinkedDirectory(directory) {
  if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) throw new Error('The startup directory must be a regular directory.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function managerDefinition(spec) {
  const manager = join(spec.coordinator, 'install', 'background.mjs');
  const path = join(dirname(spec.configFile), spec.platform === 'win32' ? 'manage.cmd' : 'manage');
  if (spec.platform === 'win32') {
    const batch = value => value.replace(/%/g, '%%');
    return { path, mode: 0o600, content: `@echo off\r\nsetlocal DisableDelayedExpansion\r\nrem Providence companion manager\r\n"${batch(spec.execPath)}" "${batch(manager)}" "%~1" "${batch(spec.configFile)}"\r\n` };
  }
  return { path, mode: 0o700, content: `#!/bin/sh\n# Providence companion manager\nexec ${shell(spec.execPath)} ${shell(manager)} "\${1:-status}" ${shell(spec.configFile)}\n` };
}

function saveSpec(spec) {
  ensureUnlinkedDirectory(dirname(spec.file));
  if (existsSync(spec.file)) throw new Error('A startup file already exists and was left untouched.');
  const manager = managerDefinition(spec);
  if (existsSync(manager.path) && (lstatSync(manager.path).isSymbolicLink() || !readFileSync(manager.path, 'utf8').includes('Providence companion manager'))) throw new Error('An unrecognized local manager exists and was left untouched.');
  writeFileSync(spec.file, spec.content, { mode: 0o600, flag: 'wx' });
  writePrivateJson(metadataPath(spec.configFile), spec);
  writeFileSync(manager.path, manager.content, { mode: manager.mode });
  if (spec.platform !== 'win32') chmodSync(manager.path, manager.mode);
}

function startNative(spec, run = execute) {
  if (!existsSync(spec.file) || lstatSync(spec.file).isSymbolicLink() || readFileSync(spec.file, 'utf8') !== spec.content) throw new Error('The startup file is missing or changed outside Providence.');
  if (spec.platform === 'darwin') {
    if (run('launchctl', ['print', spec.target], true)) run('launchctl', ['kickstart', spec.target]);
    else run('launchctl', ['bootstrap', spec.domain, spec.file]);
  } else if (spec.platform === 'linux') {
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', spec.unit]);
  } else run('wscript.exe', ['//B', '//Nologo', spec.file]);
}

async function stopNative(spec, contact = contactBackground, run = execute) {
  let nativeStopped = false;
  if (spec.platform === 'darwin') nativeStopped = run('launchctl', ['bootout', spec.target], true);
  else if (spec.platform === 'linux') nativeStopped = run('systemctl', ['--user', 'stop', spec.unit], true);
  const reply = await contact(spec.configFile, 'stop');
  return { nativeStopped, accepted: reply?.accepted === true };
}

export async function manageBackground(command, configFile, { run = execute, contact = contactBackground, wait = delay } = {}) {
  if (!['status', 'start', 'stop', 'disable', 'awake-on', 'awake-off'].includes(command)) throw new Error('Use status, start, stop, disable, awake-on, or awake-off.');
  if (command === 'awake-on' || command === 'awake-off') {
    const { existingConfig } = await import('../scripts/connect-helpers.mjs');
    const config = existingConfig(configFile);
    if (!config) throw new Error('Set up this computer before changing keep-awake.');
    const keepAwakeEnabled = command === 'awake-on';
    writePrivateJson(configFile, { ...config, keepAwake: keepAwakeEnabled });
    const current = await backgroundStatus({ configFile, contact });
    return { ...current, keepAwakeEnabled, preferenceSaved: true,
      message: 'Keep-awake preference saved. A running companion applies it shortly; the account page reports the actual sleep inhibitor.' };
  }
  const before = await backgroundStatus({ configFile, contact });
  if (command === 'status' || !before.installed) return before;
  const spec = before.metadata;
  if (command === 'start') {
    if (before.running === null) return { ...before, message: 'The existing helper could not be checked. No second copy was started.' };
    if (!before.running) startNative(spec, run);
  } else {
    const proof = await stopNative(spec, contact, run);
    let current, stopped = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      current = await backgroundStatus({ configFile, contact });
      const saved = readPrivateJson(statePath(configFile));
      const released = !existsSync(configFile + '.background.lock') && !existsSync(configFile + '.lock');
      const finished = ['stopped', 'action-required', 'failed'].includes(saved?.state);
      // An IPC timeout is not proof of exit. Keep both registration and startup
      // files until the runner released its own and its child's process locks.
      if (current.running !== true && released && (proof.nativeStopped || finished)) { stopped = true; break; }
      await wait(150);
    }
    if (!stopped) return { ...current, running: current.running === true ? true : null, state: current.running === true ? current.state : 'unknown', stopConfirmed: false, message: 'Stopping the helper was not confirmed. Its startup registration and controls were preserved; check status before retrying.' };
    if (command === 'disable') {
      if (existsSync(spec.file)) {
        if (lstatSync(spec.file).isSymbolicLink() || readFileSync(spec.file, 'utf8') !== spec.content) throw new Error('The startup file changed outside Providence and was left untouched.');
      }
      if (spec.platform === 'linux') run('systemctl', ['--user', 'disable', spec.unit]);
      if (existsSync(spec.file)) {
        unlinkSync(spec.file);
      }
      unlinkSync(metadataPath(configFile));
      if (spec.platform === 'linux') run('systemctl', ['--user', 'daemon-reload']);
      return { installed: false, running: false, state: 'not-installed', stopConfirmed: true };
    }
    return { ...current, running: false, state: 'stopped', stopConfirmed: true };
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const current = await backgroundStatus({ configFile, contact });
    if (command === 'start' ? current.running : !current.running) return current;
    await wait(150);
  }
  return backgroundStatus({ configFile, contact });
}

export async function configureBackground({
  configFile, coordinator = COORDINATOR, execPath = process.execPath, codexBinary = process.env.CODEX_BIN,
  home = homedir(), platform = process.platform, env = process.env, uid = process.getuid?.(), ask, log = console.log,
  status = backgroundStatus, manage = manageBackground, run = execute, available = supported, save = saveSpec, wait = delay,
  beforeStart = async () => {}, recover = recoverStaleWindowsBackground,
} = {}) {
  let spec, updating = false;
  let existing = await status({ configFile });
  let recovered = false;
  if (existing.installed && existing.running === null && platform === 'win32') {
    recovered = await recover({ configFile, platform });
    if (recovered) {
      existing = await status({ configFile });
      log('Windows confirmed the previous Providence processes are gone. Its stale local startup state was cleared; no process was stopped.');
    }
  }
  if (existing.installed) {
    if (existing.metadata && (resolve(existing.metadata.coordinator) !== resolve(coordinator) || resolve(existing.metadata.execPath) !== resolve(execPath))) {
      let previous, configuration, registration, manager;
      try {
        previous = validateMetadata(existing.metadata, configFile);
        if (previous.platform !== platform || previous.home !== home || previous.uid !== uid) throw new Error('The existing helper belongs to another user context.');
        if (!readPrivateJson(configFile)) throw new Error('The device configuration is missing.');
        configuration = readFileSync(configFile);
        registration = readFileSync(metadataPath(configFile));
        manager = managerDefinition(previous);
        if ((!existsSync(previous.file) && !recovered) || (existsSync(previous.file) && (lstatSync(previous.file).isSymbolicLink() || readFileSync(previous.file, 'utf8') !== previous.content)) ||
            (existsSync(manager.path) && (lstatSync(manager.path).isSymbolicLink() || readFileSync(manager.path, 'utf8') !== manager.content))) throw new Error('The existing startup controls changed.');
        // Preserve the actual previous Codex sign-in/profile, including the
        // absence of an override. A new terminal's environment cannot switch it.
        const savedEnvironment = { PATH: previous.environment.PATH, CODEX_HOME: previous.environment.CODEX_HOME, ...(env.APPDATA ? { APPDATA: env.APPDATA } : {}) };
        spec = { ...serviceSpec({ configFile, coordinator, execPath, codexBinary: resolveServiceCodex(previous.codexBinary, savedEnvironment, platform), platform, home, env: savedEnvironment, uid }), home, uid };
        if (spec.file !== previous.file || spec.id !== previous.id || !available(spec, run)) throw new Error('The new startup location is unavailable.');
        for (const file of [execPath, spec.runner]) if (!existsSync(file) || !statSync(file).isFile()) throw new Error('The downloaded runtime is incomplete.');
      } catch {
        log('The downloaded update could not be verified against this computer\'s existing setup. Its current background helper and controls were preserved.');
        return { ...existing, foreground: false, versionMismatch: true, updated: false };
      }
      log('A newer Providence companion is installed. Updating will stop current work on this computer before starting the new version.');
      let choice;
      do { choice = (await ask('Update Providence now? Current work on this computer will stop; your account, workspace and access settings stay. [y/N]: ')).trim(); } while (!/^(?:y(?:es)?|n(?:o)?)?$/i.test(choice));
      if (!/^y/i.test(choice)) {
        log('The earlier background helper was preserved. The newly downloaded release is not active; run the installer again when ready to update.');
        return { ...existing, foreground: false, versionMismatch: true, updated: false };
      }
      // Check the retained Codex profile only when an owner actually chooses to
      // restart. A declined update must not trigger another sign-in.
      await beforeStart({ codexBinary: spec.codexBinary, environment: spec.environment });
      try {
        if (!readFileSync(configFile).equals(configuration) || !readFileSync(metadataPath(configFile)).equals(registration)) throw new Error('The setup changed during confirmation.');
        const stopped = await manage('disable', configFile);
        if (stopped.stopConfirmed !== true || stopped.installed !== false || stopped.running !== false ||
            existsSync(previous.file) || existsSync(metadataPath(configFile)) || existsSync(configFile + '.lock') || existsSync(configFile + '.background.lock')) {
          log('The earlier helper\'s shutdown or removal could not be confirmed. No replacement was started; check its local controls before retrying.');
          return { ...stopped, foreground: false, versionMismatch: true, updated: false };
        }
        if (!readPrivateJson(configFile) || !readFileSync(configFile).equals(configuration) ||
            (existsSync(manager.path) && (lstatSync(manager.path).isSymbolicLink() || readFileSync(manager.path, 'utf8') !== manager.content))) throw new Error('The local setup changed while stopping.');
        updating = true;
      } catch {
        const current = await status({ configFile });
        log('The update stopped because the existing setup or shutdown could not be verified. No replacement was started; your device configuration was not changed.');
        return { ...current, foreground: false, versionMismatch: true, updated: false };
      }
    } else {
      if (existing.running === false) await beforeStart({ codexBinary: existing.metadata?.codexBinary, environment: existing.metadata?.environment });
      if (recovered && existing.running === false && !existsSync(existing.metadata.file)) save(existing.metadata);
      const result = existing.running !== false ? existing : await manage('start', configFile);
      log(result.running ? 'Providence is running in the background. You can close this terminal.' : 'Background startup needs attention. Check the local helper status and log before starting another copy.');
      return { ...result, foreground: false };
    }
  }
  if (!updating) {
    const lock = readPrivateJson(configFile + '.lock');
    for (const pid of [lock?.pid, lock?.childPid]) {
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      try {
        process.kill(pid, 0);
        log('An existing process lock is still in use. Its identity is not confirmed; check the original Providence terminal before starting another copy.');
        return { installed: false, running: null, foreground: false, state: 'unknown' };
      } catch (error) {
        if (error?.code !== 'ESRCH') throw new Error('The existing companion process could not be checked.');
      }
    }
    try {
      spec = { ...serviceSpec({ configFile, coordinator, execPath, codexBinary: resolveServiceCodex(codexBinary, env, platform), platform, home, env, uid }), home, uid };
      if (!available(spec, run)) throw new Error('User-login background services are unavailable.');
    } catch {
      log('Background startup is unavailable in this session. Providence can run in this terminal; keep it open while using this computer.');
      return { installed: false, running: false, foreground: true };
    }
    log('The background helper runs as your user after you sign in and keeps the access level you selected. Desktop control requires an active user session.');
    let choice;
    do { choice = (await ask('Run Providence in the background and start at login? [Y/n]: ')).trim(); } while (!/^(?:y(?:es)?|n(?:o)?)?$/i.test(choice));
    if (/^n/i.test(choice)) return { installed: false, running: false, foreground: true };
  }
  if (!updating) await beforeStart({ codexBinary: spec.codexBinary, environment: spec.environment });
  try {
    save(spec);
    startNative(spec, run);
  } catch {
    const now = await status({ configFile });
    log(updating ? 'The background update did not finish. Check the local helper status before retrying; your account and device settings were preserved.' : 'Background setup did not finish. Check the local helper status; Providence has not started a second foreground copy.');
    return { ...now, foreground: false, ...(updating ? { updated: false } : {}) };
  }
  let result;
  for (let attempt = 0; attempt < 20; attempt++) {
    result = await status({ configFile });
    if (result.running) break;
    await wait(150);
  }
  const manager = join(dirname(configFile), platform === 'win32' ? 'manage.cmd' : 'manage');
  log(result.running ? (updating ? 'Providence was updated and is running in the background. You can close this terminal.' : 'Providence is running in the background. You can close this terminal.') : 'The background helper was installed, but startup is not confirmed. Check its status and log.');
  log(`Local controls: ${manager} (status, start, stop, disable, awake-on, awake-off)`);
  log(`Private companion log: ${logPath(configFile)}`);
  return { ...result, foreground: false, ...(updating ? { updated: result.running === true } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command = 'status', file = join(homedir(), '.providence', 'companion', 'device.json')] = process.argv.slice(2);
    const result = await manageBackground(command || 'status', resolve(file));
    console.log(JSON.stringify({ installed: result.installed, running: result.running, state: result.state, ...(result.stopConfirmed !== undefined ? { stopConfirmed: result.stopConfirmed } : {}), ...(result.message ? { message: result.message } : {}) }));
    if (command === 'start' && !result.running) process.exitCode = 1;
    if (['stop', 'disable'].includes(command) && result.installed && result.stopConfirmed !== true) process.exitCode = 1;
  } catch { console.error('The local background helper could not complete this action. Check its private configuration and log.'); process.exitCode = 1; }
}
