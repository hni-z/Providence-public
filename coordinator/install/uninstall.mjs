#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { manageBackground, metadataPath } from './background.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = '.providence-owned.json';
const STATE_NAMES = new Set(['device.json', 'device.json.lock', 'device.json.background.lock', 'device.json.background.json', 'device.json.background-state.json', 'companion.log', 'companion.log.previous', 'manage', 'manage.cmd', 'uninstall', 'uninstall.cmd', 'uninstall.ps1']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const powershellQuote = value => "'" + value.replace(/'/g, "''") + "'";

export function windowsUninstallEntry(execPath, module, helper) {
  if ([execPath, module, helper].some(value => /["\x00-\x1f\x7f]/.test(value))) throw new Error('Unsafe uninstall launcher path.');
  // The caller loads this entry as a scriptblock in system PowerShell, so no
  // active batch source needs to be read after cleanup removes its own files.
  return `param([switch]$Yes, [switch]$AllowOffline)\r\n# Providence companion uninstaller\r\n$ErrorActionPreference='Stop'\r\nif ($args.Count -ne 0) { throw 'Unexpected uninstall arguments.' }\r\n& ([scriptblock]::Create([IO.File]::ReadAllText(${powershellQuote(helper)}))) -NodePath ${powershellQuote(execPath)} -ModulePath ${powershellQuote(module)} -Yes:$Yes -AllowOffline:$AllowOffline\r\nexit $LASTEXITCODE\r\n`;
}

function layout(home) {
  if (!isAbsolute(home) || /[\x00-\x1f\x7f]/.test(home)) throw new Error('The user profile path is invalid.');
  const base = join(resolve(home), '.providence');
  return { home: resolve(home), base, installation: join(base, 'installation'), companion: join(base, 'companion') };
}
function safeRelative(value) {
  if (typeof value !== 'string' || !value || /[\\:\x00-\x1f\x7f]/.test(value) || isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe inventory path.');
  return value;
}
function target(root, path) { return join(root, ...safeRelative(path).split('/')); }
function privateDirectory(path, create = false) {
  if (!existsSync(path)) {
    if (!create) return;
    mkdirSync(path, { mode: 0o700 });
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && stat.uid !== process.getuid())) throw new Error('An owned directory is unsafe or belongs to another user.');
}
function checkedLayout(home, create = false) {
  const paths = layout(home);
  privateDirectory(paths.home);
  for (const path of [paths.base, paths.installation, paths.companion]) privateDirectory(path, create);
  return paths;
}
function regularJson(path, maxBytes = 32 * 1024 * 1024) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes || (process.platform !== 'win32' && stat.uid !== process.getuid())) throw new Error('An ownership or state file is unsafe.');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function markerText(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('An installation marker is unsafe.');
  return readFileSync(path, 'utf8').trim();
}
function registryAt(paths) {
  const file = join(paths.installation, REGISTRY);
  if (!existsSync(file)) throw new Error('No verified Providence ownership inventory exists. Nothing was removed. Run the current installer once to create its uninstall entry.');
  const registry = regularJson(file);
  if (registry.schemaVersion !== 1 || registry.product !== 'Providence companion' || registry.home !== paths.home || !Array.isArray(registry.trees) || !Array.isArray(registry.launchers)) throw new Error('The ownership inventory is unrecognized.');
  for (const tree of registry.trees) {
    if (!/^(releases\/[a-f0-9]{64}|runtimes\/node-v\d+\.\d+\.\d+-(darwin|linux|win)-(x64|arm64)|runtimes\/codex-\d+\.\d+\.\d+-(darwin|linux|win32)-(x64|arm64))$/.test(tree.root) || !Array.isArray(tree.files) || !Array.isArray(tree.directories)) throw new Error('An owned package location is unrecognized.');
    for (const item of tree.files) validateFile(item);
    tree.directories.forEach(safeRelative);
  }
  for (const item of registry.launchers) { validateFile(item); if (!STATE_NAMES.has(item.path)) throw new Error('An owned launcher is unrecognized.'); }
  return registry;
}
function validateFile(item) {
  safeRelative(item.path);
  if (item.kind === 'file' ? !/^[a-f0-9]{64}$/.test(item.sha256) : item.kind !== 'symlink' || typeof item.link !== 'string') throw new Error('Invalid owned file metadata.');
}
function fileRecord(root, name) {
  const path = target(root, name), stat = lstatSync(path);
  if (stat.isSymbolicLink()) return { path: name, kind: 'symlink', link: readlinkSync(path) };
  if (!stat.isFile()) throw new Error('An inventory entry is not a regular file.');
  return { path: name, kind: 'file', sha256: digest(readFileSync(path)) };
}
function inventory(root) {
  privateDirectory(root);
  const files = [], directories = [];
  const walk = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const entry = prefix ? prefix + '/' + name : name;
      safeRelative(entry);
      const stat = lstatSync(join(directory, name));
      if (stat.isDirectory() && !stat.isSymbolicLink()) { directories.push(entry); walk(join(directory, name), entry); }
      else files.push(fileRecord(root, entry));
    }
  };
  walk(root); return { files, directories };
}
function writeRegistry(paths, registry) {
  const temporary = join(paths.installation, REGISTRY + '.' + randomBytes(8).toString('hex'));
  writeFileSync(temporary, JSON.stringify(registry) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, join(paths.installation, REGISTRY));
}

/** Called by the verified installer before Codex login, pairing, or key prompts. */
export function registerUninstaller({ home = homedir(), releaseDirectory = resolve(HERE, '../..'), execPath = process.execPath } = {}) {
  const paths = checkedLayout(home, true);
  const version = relative(join(paths.installation, 'releases'), resolve(releaseDirectory));
  if (!/^[a-f0-9]{64}$/.test(version)) throw new Error('The installer must run from its verified versioned release.');
  const release = join(paths.installation, 'releases', version);
  if (!safeParents(paths.installation, 'releases/' + version + '/.owned-check')) throw new Error('The release location is unsafe.');
  privateDirectory(release);
  const manifest = regularJson(join(release, '.providence-manifest.json'), 65536);
  const archiveHash = markerText(join(release, '.providence-archive-sha256'));
  if (manifest.version !== version || ![manifest.archiveZipSha256, manifest.archiveTarGzSha256].includes(archiveHash)) throw new Error('The release ownership marker did not verify.');
  const registry = existsSync(join(paths.installation, REGISTRY)) ? registryAt(paths) : { schemaVersion: 1, product: 'Providence companion', home: paths.home, trees: [], launchers: [] };
  const candidates = ['releases/' + version];
  const nodeRoot = resolve(dirname(execPath), process.platform === 'win32' ? '.' : '..');
  const nodeRelative = relative(paths.installation, nodeRoot).split(sep).join('/');
  if (!/^runtimes\/node-v\d+\.\d+\.\d+-(darwin|linux|win)-(x64|arm64)$/.test(nodeRelative)) throw new Error('The private Node runtime location did not verify.');
  if (!safeParents(paths.installation, nodeRelative + '/.owned-check') || !/^[a-f0-9]{64}$/.test(markerText(join(nodeRoot, '.providence-archive-sha256')))) throw new Error('The private Node runtime marker did not verify.');
  candidates.push(nodeRelative);
  const runtimeRoot = join(paths.installation, 'runtimes');
  for (const name of readdirSync(runtimeRoot)) {
    const match = /^codex-(\d+\.\d+\.\d+)-(darwin|linux|win32)-(x64|arm64)$/.exec(name);
    if (!match) continue;
    const directory = join(runtimeRoot, name);
    privateDirectory(directory);
    const marker = join(directory, '.providence-complete');
    if (existsSync(marker) && markerText(marker) === match[1]) candidates.push('runtimes/' + name);
  }
  for (const root of candidates) if (!registry.trees.some(tree => tree.root === root)) registry.trees.push({ root, ...inventory(target(paths.installation, root)) });
  const entry = process.platform === 'win32' ? 'uninstall.ps1' : 'uninstall';
  const file = join(paths.companion, entry);
  const module = join(release, 'coordinator/install/uninstall.mjs');
  const content = process.platform === 'win32'
    ? windowsUninstallEntry(execPath, module, join(release, 'coordinator/install/uninstall-windows.ps1'))
    : `#!/bin/sh\n# Providence companion uninstaller\nexec ${quote(execPath)} ${quote(module)} "$@"\n`;
  if (existsSync(file)) {
    const prior = registry.launchers.find(item => item.path === entry);
    if (!prior || !matches(paths.companion, prior)) throw new Error('An unrecognized uninstall launcher was left untouched.');
  }
  // Commit ownership before creating or replacing an entry point.
  const launcher = { path: entry, kind: 'file', sha256: digest(content) };
  registry.launchers = [...registry.launchers.filter(item => item.path !== entry), launcher];
  writeRegistry(paths, registry);
  writeFileSync(file, content, { mode: process.platform === 'win32' ? 0o600 : 0o700 });
  return file;
}

function safeParents(root, entry) {
  privateDirectory(root);
  const parts = safeRelative(entry).split('/');
  for (let index = 1; index < parts.length; index++) {
    const parent = join(root, ...parts.slice(0, index));
    if (!existsSync(parent)) return false;
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  }
  return true;
}
function matches(root, item) {
  if (!safeParents(root, item.path)) return false;
  const file = target(root, item.path);
  if (!existsSync(file) && !isLink(file)) return false;
  const stat = lstatSync(file);
  return item.kind === 'symlink' ? stat.isSymbolicLink() && readlinkSync(file) === item.link
    : stat.isFile() && !stat.isSymbolicLink() && digest(readFileSync(file)) === item.sha256;
}
function isLink(path) { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } }
export function within(path, directory, platform = process.platform) {
  if (platform === 'win32') { path = win32.normalize(path).toLowerCase(); directory = win32.normalize(directory).toLowerCase(); }
  return path === directory || path.startsWith(directory + (platform === 'win32' ? '\\' : sep));
}
function ensureProtected(paths, registry, config, env) {
  const protectedPaths = [config?.workspace, config?.transcriptionEnvFile, config?.elevenLabsEnvFile, env.CODEX_HOME];
  const background = metadataPath(join(paths.companion, 'device.json'));
  if (existsSync(background)) protectedPaths.push(regularJson(background, 65536)?.environment?.CODEX_HOME);
  for (const value of protectedPaths) if (typeof value === 'string' && value) {
    const absolute = resolve(value);
    const actual = existsSync(absolute) ? realpathSync(absolute) : absolute;
    if (within(absolute, paths.companion) || within(actual, paths.companion) || within(paths.companion, absolute) || within(paths.companion, actual)) throw new Error('A workspace or existing Codex profile overlaps companion state. It was preserved; relocate it before uninstalling.');
    for (const tree of registry.trees) {
      const owned = target(paths.installation, tree.root);
      if (within(absolute, owned) || within(actual, owned) || within(owned, absolute) || within(owned, actual)) throw new Error('A workspace or existing Codex profile overlaps the installation. It was preserved; relocate it before uninstalling.');
    }
  }
}
export async function revokeOwnDevice(config, fetcher = fetch) {
  if (!config) return 'not-needed';
  if (config.url !== 'wss://providence.hani.so/worker' || !/^[A-Za-z0-9_-]{1,128}$/.test(config.deviceId ?? '') || !/^[a-f0-9]{64}$/.test(config.token ?? '')) return 'unconfirmed';
  try {
    const response = await fetcher('https://providence.hani.so/device/revoke', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(7000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` }, body: JSON.stringify({ deviceId: config.deviceId }) });
    const body = await response.json();
    return response.status === 200 && body?.revoked === true && body.deviceId === config.deviceId ? 'confirmed' : 'unconfirmed';
  } catch { return 'unconfirmed'; }
}
function processLocksReleased(paths, probe = process.kill) {
  for (const name of ['device.json.lock', 'device.json.background.lock']) {
    const file = join(paths.companion, name);
    if (!existsSync(file)) continue;
    let lock;
    try { lock = regularJson(file, 1024); } catch { return false; }
    for (const pid of [lock.pid, lock.childPid]) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      try { probe(pid, 0); return false; } catch (error) { if (error?.code !== 'ESRCH') return false; }
    }
  }
  return true;
}
function removalPlan(paths, registry) {
  const files = [], directories = [], preserved = [];
  for (const tree of registry.trees) {
    const root = target(paths.installation, tree.root);
    if (!existsSync(root)) continue;
    if (!safeParents(paths.installation, tree.root + '/.owned-check')) throw new Error('An owned package directory moved outside its installation.');
    privateDirectory(root);
    // npm writes new logs after the installer's first inventory. Only this
    // dedicated cache, already recorded inside a registered release, is mutable
    // application data. Unknown sibling directories are never adopted.
    const cache = 'coordinator/.npm-cache';
    const dynamicCache = /^releases\/[a-f0-9]{64}$/.test(tree.root) && tree.directories.includes(cache);
    const inCache = path => dynamicCache && (path === cache || path.startsWith(cache + '/'));
    if (dynamicCache && (existsSync(target(root, cache)) || isLink(target(root, cache)))) {
      if (!safeParents(root, cache + '/.owned-check')) throw new Error('The private npm cache has an unsafe directory. Nothing was removed.');
      const current = inventory(target(root, cache));
      if (current.files.some(item => item.kind !== 'file')) throw new Error('The private npm cache contains a link or unsafe file. Nothing was removed.');
      for (const item of current.files) files.push({ ...item, path: tree.root + '/' + cache + '/' + item.path, base: 'installation' });
      for (const path of current.directories) directories.push({ base: 'installation', path: tree.root + '/' + cache + '/' + path });
      directories.push({ base: 'installation', path: tree.root + '/' + cache });
    }
    for (const item of tree.files) {
      if (inCache(item.path)) continue;
      const full = { ...item, path: tree.root + '/' + item.path, base: 'installation' };
      if (matches(paths.installation, full)) files.push(full);
      else if (existsSync(target(paths.installation, full.path)) || isLink(target(paths.installation, full.path))) preserved.push(target(paths.installation, full.path));
    }
    for (const path of tree.directories) if (!inCache(path)) directories.push({ base: 'installation', path: tree.root + '/' + path });
    directories.push({ base: 'installation', path: tree.root });
  }
  for (const name of STATE_NAMES) {
    const file = join(paths.companion, name);
    if (!existsSync(file) && !isLink(file)) continue;
    if (isLink(file) || !lstatSync(file).isFile()) { preserved.push(file); continue; }
    if (name.startsWith('uninstall')) {
      const recorded = registry.launchers.find(item => item.path === name);
      if (!recorded || !matches(paths.companion, recorded)) { preserved.push(file); continue; }
    } else if (name.startsWith('manage') && !readFileSync(file, 'utf8').includes('Providence companion manager')) { preserved.push(file); continue; }
    files.push({ ...fileRecord(paths.companion, name), base: 'companion' });
  }
  files.push({ ...fileRecord(paths.installation, REGISTRY), base: 'installation' });
  directories.push({ base: 'installation', path: 'releases' }, { base: 'installation', path: 'runtimes' });
  return { schemaVersion: 1, home: paths.home, files, directories, preserved };
}
export function removeOwnedPlan(plan) {
  const paths = checkedLayout(plan.home), retained = [...plan.preserved];
  if (plan.schemaVersion !== 1) throw new Error('Invalid removal plan.');
  for (const item of plan.files) {
    if (!['installation', 'companion'].includes(item.base)) throw new Error('Invalid removal root.');
    const root = paths[item.base];
    if (!matches(root, item)) { retained.push(target(root, item.path)); continue; }
    try { unlinkSync(target(root, item.path)); } catch { retained.push(target(root, item.path)); }
  }
  for (const item of [...plan.directories].sort((a,b) => b.path.length - a.path.length)) {
    const root = paths[item.base];
    if (!root || !safeParents(root, item.path)) continue;
    const path = target(root, item.path);
    if (!existsSync(path) || isLink(path)) continue;
    try { rmdirSync(path); } catch { retained.push(path); }
  }
  for (const path of [paths.companion, paths.installation]) if (existsSync(path)) {
    if (path === paths.installation && readdirSync(path).every(name => name === '.uninstall-lock')) continue;
    try { rmdirSync(path); } catch { retained.push(path); }
  }
  return [...new Set(retained)];
}
async function confirmation(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Use an interactive terminal, or explicitly pass --yes to authorize uninstall.');
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await reader.question(prompt)).trim()); }
  finally { reader.close(); }
}
const confirm = () => confirmation('Uninstall Providence from this computer? Its connection, logs and private runtime will be removed; your Codex account and workspace stay. [y/N]: ');
const confirmOffline = () => confirmation('Remote revocation was not confirmed. Remove local files anyway and remove this computer from your Providence account when online? [y/N]: ');

export async function uninstall({ home = homedir(), yes = false, allowOffline = false, ask = confirm, askOffline = confirmOffline, fetcher = fetch, manage = manageBackground, probe = process.kill, wait = delay, platform = process.platform, env = process.env, prepareWindows = writeWindowsCleanupPlan } = {}) {
  const paths = checkedLayout(home), registry = registryAt(paths);
  const configFile = join(paths.companion, 'device.json');
  const config = existsSync(configFile) ? regularJson(configFile, 65536) : undefined;
  ensureProtected(paths, registry, config, env);
  if (!yes && !await ask()) return { removed: false, reason: 'cancelled', revocation: 'not-attempted' };
  if (existsSync(join(paths.installation, '.install-lock')) || existsSync(join(paths.installation, '.uninstall-lock'))) throw new Error('An install or uninstall is already active. Nothing was removed.');
  const lock = join(paths.installation, '.uninstall-lock');
  writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  let deferred = false;
  try {
    if (existsSync(join(paths.installation, '.install-lock'))) throw new Error('An installation started concurrently. Nothing was removed.');
    const revocation = await revokeOwnDevice(config, fetcher);
    if (revocation === 'unconfirmed' && !allowOffline && !await askOffline()) return { removed: false, reason: 'offline_not_confirmed', revocation };
    if (existsSync(metadataPath(configFile))) {
      let result;
      try { result = await manage('disable', configFile); } catch { return { removed: false, reason: 'stop_unconfirmed', revocation }; }
      if (result.installed || result.running !== false || result.stopConfirmed !== true) return { removed: false, reason: 'stop_unconfirmed', revocation };
    }
    for (let attempt = 0; attempt < 20 && !processLocksReleased(paths, probe); attempt++) await wait(250);
    if (!processLocksReleased(paths, probe)) return { removed: false, reason: 'stop_unconfirmed', revocation };
    const plan = removalPlan(paths, registry);
    if (platform === 'win32') {
      await prepareWindows({ ...plan, parentPid: process.pid, revocation });
      deferred = true;
      return { removed: false, reason: 'cleanup_prepared', revocation };
    }
    const preserved = removeOwnedPlan(plan);
    return { removed: true, reason: preserved.length ? 'removed_with_preserved_files' : 'removed', revocation, preserved };
  } finally {
    if (!deferred) {
      if (existsSync(lock)) unlinkSync(lock);
      for (const path of [paths.installation, paths.companion]) if (existsSync(path)) { try { rmdirSync(path); } catch {} }
    }
  }
}

export async function writeWindowsCleanupPlan(plan) {
  const paths = checkedLayout(plan.home);
  const text = JSON.stringify(plan);
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error('The removal plan is too large.');
  writeFileSync(join(paths.installation, '.uninstall-plan.json'), text, { mode: 0o600, flag: 'wx' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2).filter(Boolean);
    if (args.length === 1 && args[0] === '--register') console.log(`Uninstall entry saved: ${registerUninstaller()}`);
    else {
      if (args.some(arg => !['--yes', '--allow-offline', '--prepare-windows-plan'].includes(arg)) || new Set(args).size !== args.length) throw new Error('Use uninstall with no argument, or --yes and optionally --allow-offline for explicit noninteractive confirmation.');
      if ((process.platform === 'win32') !== args.includes('--prepare-windows-plan')) throw new Error('On Windows, use the saved uninstall.ps1 entry through system PowerShell so cleanup can finish before the command exits.');
      const result = await uninstall({ yes: args.includes('--yes'), allowOffline: args.includes('--allow-offline') });
      if (result.reason === 'cleanup_prepared') console.log('Local shutdown and removal plan confirmed. Finishing owned-file cleanup...');
      else if (result.reason === 'stop_unconfirmed') { console.error('Providence may still be running. Local files were preserved. Stop its foreground terminal or check its local manager, then retry uninstall.'); process.exitCode = 1; }
      else if (result.removed) { console.log('Providence-owned local files removed. Your workspace and existing Codex account were preserved.'); if (result.preserved?.length) console.log('Unrelated or modified files were left in place:\n' + result.preserved.join('\n')); }
      else console.log('Uninstall cancelled.');
      if (result.revocation === 'unconfirmed') console.log('Remote revocation was not confirmed. Remove this computer from your Providence account when online: https://providence.hani.so/account');
      else if (result.revocation === 'confirmed') console.log('This device registration was revoked on Providence. Other devices and account data were preserved.');
    }
  } catch { console.error('Uninstall could not finish safely. Check the local manager, ownership inventory, and file permissions; no credential or diagnostic contents are shown.'); process.exitCode = 1; }
}
