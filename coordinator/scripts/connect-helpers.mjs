import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { appCodexCandidates } from '../install/prepare-codex.mjs';

export const ORIGIN = 'https://providence.hani.so';
const WORKER_URL = 'wss://providence.hani.so/worker';
const COORDINATOR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const USER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const API_KEY = /^sk-[A-Za-z0-9_-]{20,1000}$/;

export class SetupError extends Error {
  constructor(message, exitCode = 1) { super(message); this.name = 'SetupError'; this.exitCode = exitCode; }
}

export async function question(prompt, { input = stdin, output = stdout } = {}) {
  if (!input.isTTY || !output.isTTY) throw new SetupError('Open an interactive terminal to finish Providence setup.');
  const rl = createInterface({ input, output });
  let cancelled;
  const interruption = new Promise((_, reject) => { cancelled = () => reject(new SetupError('Setup cancelled.', 130)); });
  rl.once('SIGINT', cancelled);
  rl.once('close', cancelled);
  try { return await Promise.race([rl.question(prompt), interruption]); }
  catch { throw new SetupError('Setup cancelled.', 130); }
  finally { rl.close(); }
}

/** Never route key input through readline, shell arguments, or environment variables. */
export function hiddenQuestion(prompt, { input = stdin, output = stdout, signals = process } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function')
    return Promise.reject(new SetupError('API-key entry requires an interactive terminal with hidden input. Piped input is not accepted.'));
  return new Promise((accept, reject) => {
    let value = '', settled = false;
    const wasRaw = input.isRaw === true, wasPaused = input.isPaused() || input.readableFlowing !== true;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      input.off('data', data); input.off('end', ended); input.off('error', failed);
      signals.off('SIGINT', cancelled); signals.off('SIGTERM', cancelled);
      try { input.setRawMode(wasRaw); } catch { /* The stream may already be gone. */ }
      if (wasPaused) input.pause();
      output.write('\n');
      const result = value; value = '';
      if (error) reject(error); else accept(result.trim());
    };
    const cancelled = () => finish(new SetupError('Setup cancelled.', 130));
    const ended = () => finish(new SetupError('API-key entry ended before confirmation.'));
    const failed = () => finish(new SetupError('Could not read hidden input.'));
    const data = chunk => {
      const text = chunk.toString('utf8').replace(/\u001b\[(?:200|201)~/g, '');
      for (const char of text) {
        if (char === '\u0003' || char === '\u0004') { cancelled(); return; }
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char === '\u0015') value = '';
        else if (/^[A-Za-z0-9_-]$/.test(char)) {
          value += char;
          if (value.length > 1003) { finish(new SetupError('That API key is too long.')); return; }
        } else { finish(new SetupError('API keys must contain only letters, numbers, underscores and hyphens.')); return; }
      }
    };
    try {
      input.setRawMode(true);
      input.on('data', data); input.once('end', ended); input.once('error', failed);
      signals.once('SIGINT', cancelled); signals.once('SIGTERM', cancelled);
      output.write(prompt); input.resume();
    } catch { failed(); }
  });
}

export function codexBinary({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  return env.CODEX_BIN || appCodexCandidates({ env, platform }).find(exists) || 'codex';
}

export async function loginStatus({ env = process.env, binary = codexBinary({ env }), execute = execFile } = {}) {
  if (/\.(cmd|bat)$/i.test(binary)) throw new SetupError('Set CODEX_BIN to the native codex.exe, then run this installer again. Windows command shims are not supported.');
  return new Promise((accept, reject) => {
    execute(binary, ['login', 'status'], { env, timeout: 15000, maxBuffer: 16384, windowsHide: true, shell: false }, error => {
      // Suppress CLI output, including details of its authentication mode.
      if (!error) return accept(true);
      if (error.code === 'ENOENT') return reject(new SetupError('Codex CLI was not found. Install it from https://developers.openai.com/codex/cli/ and run codex login, then run this installer again.'));
      if (error.killed || error.signal || error.code === 'EACCES') return reject(new SetupError('The local Codex sign-in could not be checked. Run codex login status on this computer to check its installation.'));
      accept(false);
    });
  });
}

export function runLocalCodexLogin(binary, { spawner = spawn, signals = process, env = process.env } = {}) {
  const child = spawner(binary, ['login'], { env, stdio: 'inherit', shell: false });
  return childExit(child, signals, 'Codex sign-in could not start. Run codex login on this computer.');
}

export async function checkCodexLogin({ env = process.env, binary = codexBinary({ env }), status = loginStatus, ask = question, login = runLocalCodexLogin, log = console.log } = {}) {
  if (await status({ binary, env })) { log('Your existing Codex sign-in is ready.'); return; }
  log('Sign in to Codex on this computer using its official browser flow. Providence does not read or copy your Codex credentials.');
  log('Help: https://developers.openai.com/codex/auth/');
  if (!/^y(es)?$/i.test((await ask('Run codex login now? [y/N]: ')).trim())) throw new SetupError('Run codex login on this computer before connecting it to Providence.');
  const exitCode = await login(binary, { env });
  if (exitCode !== 0 || !await status({ binary, env })) throw new SetupError('Codex sign-in was not confirmed. Run codex login on this computer, then run the installer again.');
  log('Codex sign-in confirmed. Continue in this terminal.');
}

export function verificationUrl(code) {
  if (typeof code !== 'string' || !USER_CODE.test(code)) throw new SetupError('The server returned an invalid setup code.');
  return `${ORIGIN}/account?setup=${code}`;
}

export function browserCommand(url, platform = process.platform) {
  const code = typeof url === 'string' ? url.slice(`${ORIGIN}/account?setup=`.length) : '';
  if (url !== verificationUrl(code)) throw new SetupError('The browser sign-in address could not be verified.');
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

export async function openBrowser(url, { platform = process.platform, execute = execFile } = {}) {
  const [binary, args] = browserCommand(url, platform);
  return new Promise(accept => {
    execute(binary, args, { timeout: 10000, maxBuffer: 1024, windowsHide: true, shell: false }, error => accept(!error));
  });
}

export async function post(path, body, { token, fetcher = fetch, sleep = delay, retryAfterMs = 3000 } = {}) {
  // These endpoints preserve their grant or exact registration on repeat. Never
  // replay setup creation or a key change after an uncertain response.
  const attempts = ['/setup/poll', '/setup/connect'].includes(path) ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetcher(ORIGIN + path, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid response');
      return { status: response.status, data };
    } catch {
      if (attempt + 1 === attempts) throw new SetupError(path === '/setup/connect'
        ? 'Computer registration could not be confirmed. Check your Providence account for this computer before trying setup again.'
        : 'Could not reach Providence securely. Check your connection and run setup again.');
      await sleep(Math.max(3000, retryAfterMs));
    }
  }
}

export async function authorize({ request = post, open = openBrowser, log = console.log, sleep = delay, now = Date.now } = {}) {
  const initial = await request('/setup/start', {});
  const data = initial.data;
  const expiresAt = typeof data.expiresAt === 'number' ? data.expiresAt : Date.parse(data.expiresAt);
  if (initial.status !== 200 || typeof data.deviceCode !== 'string' || !SECRET.test(data.deviceCode) || !USER_CODE.test(data.userCode) ||
      data.verificationUrl !== verificationUrl(data.userCode) || !Number.isFinite(expiresAt) || expiresAt <= now() ||
      !Number.isInteger(data.interval) || data.interval < 1 || data.interval > 60)
    throw new SetupError('Providence returned an invalid or expired setup request. Run setup again.');
  log(`Approve this computer with your Providence passkey: ${data.verificationUrl}`);
  log(`Check that the browser shows this code: ${data.userCode}. Approve only the setup you just started.`);
  log('Your API key is entered here in the terminal after approval, never on that page.');
  if (!await open(data.verificationUrl)) log('The browser did not open. Open the address above on a device where you can use your passkey.');
  log('Waiting for browser approval. After approving, return to this terminal.');
  while (now() < expiresAt) {
    await sleep(data.interval * 1000);
    if (now() >= expiresAt) break;
    const result = await request('/setup/poll', { deviceCode: data.deviceCode }, { retryAfterMs: data.interval * 1000 });
    if (result.status === 202 && result.data.status === 'pending') continue;
    if (result.status === 200 && result.data.status === 'approved' && typeof result.data.setupToken === 'string' && SECRET.test(result.data.setupToken) &&
        typeof result.data.keyConfigured === 'boolean' && typeof result.data.accountName === 'string') return result.data;
    if ([400, 403].includes(result.status)) throw new SetupError('Setup was denied or cancelled. No computer was connected.');
    if (result.status === 410) break;
    throw new SetupError('Setup approval could not be verified. Run setup again.');
  }
  throw new SetupError('Setup approval expired. Run setup again to get a fresh request.');
}

function ensurePrivateDirectory(path) {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SetupError('Providence configuration must use a real private directory, not a link.');
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && stat.uid !== process.getuid())
    throw new SetupError('Providence configuration belongs to another user.');
  chmodSync(path, 0o700);
}

export function privateConfig(home = homedir()) {
  const base = resolve(home, '.providence'), directory = resolve(base, 'companion');
  ensurePrivateDirectory(base); ensurePrivateDirectory(directory);
  return resolve(directory, 'device.json');
}

export function existingConfig(file) {
  let descriptor;
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new SetupError('Providence device configuration must be a regular private file.');
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && stat.uid !== process.getuid())
      throw new SetupError('Providence device configuration belongs to another user.');
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > 65536)
      throw new SetupError('Providence device configuration changed while being checked.');
    const data = JSON.parse(readFileSync(descriptor, 'utf8').replace(/^\uFEFF/, ''));
    if (!data || typeof data.deviceId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(data.deviceId) ||
        typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token) || data.url !== WORKER_URL ||
        typeof data.workspace !== 'string' || !isAbsolute(data.workspace) || data.workspace === parse(data.workspace).root ||
        ![undefined, 'workspace', 'full-access'].includes(data.workerAccess) ||
        (data.keepAwake !== undefined && typeof data.keepAwake !== 'boolean')) throw new Error('Invalid configuration');
    fchmodSync(descriptor, 0o600);
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SetupError) throw error;
    throw new SetupError('The existing Providence configuration could not be verified. It was preserved; setup will not re-pair this computer.');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function saveConfig(file, config) {
  let descriptor;
  try {
    descriptor = openSync(file, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(config, null, 2) + '\n', 'utf8');
    fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) { try { unlinkSync(file); } catch {} }
    if (error.code === 'EEXIST') throw new SetupError('A Providence configuration already exists. It was preserved; run the installer again to resume it.');
    throw new SetupError('Could not save the device configuration. Revoke this computer in your Providence account before trying again.');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function prepareWorkspace(value, home = homedir()) {
  const expanded = value === '~' ? home : value.startsWith('~/') || value.startsWith('~\\') ? resolve(home, value.slice(2)) : value;
  const path = resolve(expanded || resolve(home, 'ProvidenceWorkspace'));
  if (path === parse(path).root) throw new SetupError('Choose a dedicated workspace folder, not a filesystem root.');
  mkdirSync(path, { recursive: true });
  const real = realpathSync(path);
  if (!lstatSync(real).isDirectory() || real === parse(real).root) throw new SetupError('The workspace must resolve to a dedicated folder.');
  return real;
}

function childExit(child, signals, errorMessage, finished = () => {}) {
  return new Promise((accept, reject) => {
    let stopping = false;
    const stop = () => { if (!stopping) { stopping = true; try { child.kill('SIGTERM'); } catch {} } };
    const cleanup = () => { signals.off('SIGINT', stop); signals.off('SIGTERM', stop); };
    signals.on('SIGINT', stop); signals.on('SIGTERM', stop);
    child.once('error', () => { cleanup(); if (child.pid === undefined) finished(); reject(new SetupError(errorMessage)); });
    child.once('exit', code => { cleanup(); finished(); accept(code ?? (stopping ? 0 : 1)); });
  });
}

export function acquireCompanionLock(file, { pid = process.pid, probe = process.kill } = {}) {
  const lock = file + '.lock';
  const occupied = () => new SetupError('A Providence companion may already be running for this device. Keep its terminal open or stop it there before running setup again. The lock was preserved.');
  const alive = candidate => {
    try { probe(candidate, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
  };
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { descriptor = openSync(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw new SetupError('Could not create the private companion process lock.');
      let check;
      try {
        const stat = lstatSync(lock);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 ||
            (process.platform !== 'win32' && stat.uid !== process.getuid())) throw occupied();
        check = openSync(lock, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(check);
        if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw occupied();
        const owner = JSON.parse(readFileSync(check, 'utf8'));
        // A crash before the child PID is recorded needs manual inspection: an
        // unrecorded child may still be running, so absence of its parent is not proof.
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !Number.isSafeInteger(owner.childPid) || owner.childPid < 1 ||
            alive(owner.pid) || alive(owner.childPid)) throw occupied();
        const current = lstatSync(lock);
        if (current.ino !== opened.ino || current.dev !== opened.dev) throw occupied();
        unlinkSync(lock);
      } catch { throw occupied(); }
      finally { if (check !== undefined) closeSync(check); }
    }
  }
  if (descriptor === undefined) throw occupied();
  const owned = fstatSync(descriptor);
  let released = false;
  const write = childPid => {
    const content = Buffer.from(JSON.stringify({ pid, childPid }) + '\n');
    writeSync(descriptor, content, 0, content.length, 0);
    ftruncateSync(descriptor, content.length);
    fsyncSync(descriptor);
  };
  const release = () => {
    if (released) return; released = true;
    try { const current = lstatSync(lock); if (current.ino === owned.ino && current.dev === owned.dev) unlinkSync(lock); }
    catch {} finally { closeSync(descriptor); }
  };
  try { write(null); }
  catch { release(); throw new SetupError('Could not save the private companion process lock.'); }
  return {
    attachChild(childPid) {
      if (!Number.isSafeInteger(childPid) || childPid < 1) return;
      write(childPid);
    },
    release,
  };
}

export function launchCompanion(file, { spawner = spawn, execPath = process.execPath, coordinator = COORDINATOR, signals = process, env = process.env } = {}) {
  const tsx = resolve(coordinator, 'node_modules/tsx/dist/cli.mjs');
  if (!existsSync(tsx)) throw new SetupError('Companion dependencies are missing. Run the Providence installer again.');
  const lock = acquireCompanionLock(file);
  let child;
  try {
    child = spawner(execPath, [tsx, resolve(coordinator, 'src/device.ts'), file], { env: { ...env, CODEX_BIN: codexBinary({ env }) }, cwd: coordinator, stdio: 'inherit', shell: false });
    lock.attachChild(child.pid);
  } catch { if (!child) lock.release(); throw new SetupError('The companion could not start. Check its process lock before trying again.'); }
  return childExit(child, signals, 'The companion could not start. Run the installer again to resume this computer.', lock.release);
}

export function permissionGuidance(platform = process.platform, log = console.log) {
  if (platform === 'darwin')
    log('For Mac app control, keep ChatGPT open, enable its Computer Use server and skill, and approve the Accessibility and Screen Recording permissions it requests.');
  else if (platform === 'win32')
    log('For Windows app control, keep ChatGPT open with its Computer Use server and skill enabled. Keep Windows signed in and unlocked and the target app visible.');
  else
    log('Linux and Raspberry Pi companions provide file and shell work. Desktop tasks need a separately configured compatible control tool.');
  log('Full access controls Codex file and command permissions; desktop and browser control also need their own available tools.');
  log('Check a harmless app action through Providence on this computer before relying on GUI control.');
}

async function backgroundSetup(options) {
  const { configureBackground } = await import('../install/background.mjs');
  return configureBackground(options);
}

export function setupOptions(args) {
  const options = { fullAccess: false, workspaceAccess: false, configureKey: false, help: false, folder: undefined };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--full-access') options.fullAccess = true;
    else if (arg === '--workspace') options.workspaceAccess = true;
    else if (arg === '--configure-key') options.configureKey = true;
    else if (arg === '--help') options.help = true;
    else if (arg === '--workspace-folder') {
      const folder = args[++index];
      if (options.folder !== undefined || typeof folder !== 'string' || !folder || folder.length > 4096 || /[\u0000-\u001f\u007f]/.test(folder) ||
          (!isAbsolute(folder) && folder !== '~' && !/^~[\\/]/.test(folder))) throw new SetupError('Use --workspace-folder with one absolute folder path or ~/folder.');
      options.folder = folder;
    } else throw new SetupError('Supported options: --full-access, --workspace, --workspace-folder PATH, --configure-key, --help. Never pass an API key as a command argument.');
  }
  if (options.fullAccess && options.workspaceAccess) throw new SetupError('Choose either full access or workspace access, not both.');
  if (options.configureKey && options.folder !== undefined) throw new SetupError('Folder selection is for computer setup; omit it when using --configure-key.');
  return options;
}

export async function runSetup({
  args = process.argv.slice(2), home = homedir(), name = hostname(), log = console.log,
  ask = question, secret = hiddenQuestion, request = post, authorizeSetup = authorize,
  checkLogin = checkCodexLogin, configPath = privateConfig, readConfig = existingConfig,
  writeConfig = saveConfig, workspaceFolder = prepareWorkspace, launch = launchCompanion,
  configureBackground = backgroundSetup, platform = process.platform,
} = {}) {
  const options = setupOptions(args);
  if (options.help) {
    log('Providence setup: connect.mjs [--workspace] [--workspace-folder PATH] or connect.mjs --configure-key');
    log('New computers use full access after one local connection confirmation. --full-access is also accepted; --workspace limits a new connection to its workspace.');
    log('Full-access setup uses ~/ProvidenceWorkspace automatically. --workspace-folder selects a different starting folder for a new computer.');
    log('Existing computers keep their saved access. Setup does not change their permissions.');
    log('New computer setup also asks whether to prevent sleep during active Providence use or tasks, releasing the request when idle; existing choices are preserved.');
    log('--configure-key changes the hosted API key through hidden terminal input without registering a computer.');
    return;
  }
  const configureKeyOnly = options.configureKey;
  const checkedLogins = new Set();
  const ensureLogin = async context => {
    const env = { ...process.env, ...context?.environment };
    if (context?.environment && !Object.hasOwn(context.environment, 'CODEX_HOME')) delete env.CODEX_HOME;
    const binary = context?.codexBinary || codexBinary({ env, platform });
    const identity = JSON.stringify([binary, env.CODEX_HOME ?? null]);
    if (checkedLogins.has(identity)) return;
    log('Checking this computer’s Codex sign-in…');
    await checkLogin({ binary, env, ask, log }); checkedLogins.add(identity);
  };
  const startCompanion = async (file, firstSetup = false) => {
    const background = await configureBackground({ configFile: file, coordinator: COORDINATOR, execPath: process.execPath,
      codexBinary: codexBinary({ platform }), beforeStart: ensureLogin, ask, log });
    if (!background.foreground) {
      if (background.running !== true) throw new SetupError('Providence startup is not confirmed. Check the local helper status before retrying; setup has preserved this computer’s connection.');
      if (firstSetup) permissionGuidance(platform, log);
      log(`Next: return to ${ORIGIN}/account and check that this computer shows Online. A running helper alone does not verify its connection or desktop control.`);
      return;
    }
    await ensureLogin();
    if (firstSetup) permissionGuidance(platform, log);
    log('Keep this terminal running and this computer awake. Wait for the companion to report connected and acknowledged.');
    process.exitCode = await launch(file);
  };
  let file, existing;
  if (!configureKeyOnly) {
    file = configPath(home); existing = readConfig(file);
    if (existing) {
      log('Resuming this computer’s saved Providence connection.');
      log(`This computer is already linked. Resuming its existing ${existing.workerAccess === 'full-access' ? 'full access' : 'workspace access'}; permissions and account are unchanged.`);
      log(existing.keepAwake === true ? 'Your saved choice allows Providence to prevent sleep during active use or tasks, then release the request when idle.' : 'Your saved choice allows this computer to sleep normally.');
      if (options.folder !== undefined) log('The saved working folder is kept. --workspace-folder only applies when first connecting a computer.');
      await startCompanion(file);
      return;
    }
    log('[1/3] Prepare this computer');
    await ensureLogin();
  }
  let workspace, workerAccess, keepAwake, deviceName = name;
  if (!configureKeyOnly) {
    deviceName = (await ask(`Name this computer [${name}]: `)).trim() || name;
    if (!deviceName || deviceName.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(deviceName))
      throw new SetupError('Choose a computer name of 1–80 characters without control characters.');
    workerAccess = options.workspaceAccess ? 'workspace' : 'full-access';
    const folder = options.folder ?? (workerAccess === 'workspace' ? (await ask(`Workspace folder [${resolve(home, 'ProvidenceWorkspace')}]: `)).trim() : '');
    workspace = workspaceFolder(folder, home);
    log(`Working folder: ${workspace}`);
    if (workerAccess === 'full-access')
      log('Providence uses full access: your approved account can run commands and change files across this computer through Codex, without a prompt for each task. The starting folder does not limit access. OS and application permissions still apply.');
    else log('You selected workspace access. Codex will limit work to the chosen workspace and may ask for additional approvals.');
    log('Codex sign-in enables the local runtime. Connecting this computer to Providence separately grants your Providence account remote access.');
    if (!/^y(es)?$/i.test((await ask(`Connect this computer with ${workerAccess === 'full-access' ? 'full' : 'workspace'} access? [y/N]: `)).trim()))
      throw new SetupError('Setup cancelled before browser approval, API-key changes or computer registration.');
    log('Providence can request that this computer stay awake during active use or tasks, then release that request when idle. The screen may still turn off or lock. Closing the lid or manually sleeping can still suspend it.');
    const awakeChoice = (await ask('Keep this computer awake during active Providence use or tasks? [Y/n]: ')).trim();
    keepAwake = awakeChoice === '' || /^y(es)?$/i.test(awakeChoice);
  }
  log(configureKeyOnly ? '[1/2] Approve the key update in your browser' : '[2/3] Approve this computer in your browser');
  const grant = await authorizeSetup({ request, log });
  const accountName = grant.accountName.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 200);
  log(`Approved Providence account: ${accountName}`);
  if (!/^y(es)?$/i.test((await ask('Is this your intended Providence account? [y/N]: ')).trim()))
    throw new SetupError('Setup cancelled before API-key changes or computer registration.');
  if (configureKeyOnly || !grant.keyConfigured) {
    if (configureKeyOnly) log('[2/2] Save your account’s API key');
    log('One OpenAI API key funds hosted coordination and voice for your account. Your computers keep their own Codex sign-in.');
    log('The key you enter next is sent over HTTPS to Providence and stored encrypted on its server. It is not kept only on this computer.');
    let key = await secret('OpenAI API key (hidden input): ');
    if (!API_KEY.test(key)) { key = ''; throw new SetupError('That does not look like an OpenAI API key. Run setup again; no computer was registered.'); }
    let result;
    try { result = await request('/setup/api-key', { apiKey: key }, { token: grant.setupToken }); }
    finally { key = ''; }
    if (result.status !== 200 || result.data.ok !== true) throw new SetupError('The hosted API key could not be saved. Run setup again; no computer was registered.');
    log('Hosted API key saved.');
  } else log('Your account already has its hosted API key. It was not copied to this computer.');
  if (configureKeyOnly) { log('API-key setup finished. Your device registrations are unchanged.'); return; }
  const registration = await request('/setup/connect', { workspace, name: deviceName, workerAccess }, { token: grant.setupToken });
  const result = registration.data;
  if (registration.status !== 200 || typeof result.deviceId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(result.deviceId) ||
      typeof result.token !== 'string' || !/^[a-f0-9]{64}$/.test(result.token) || result.url !== WORKER_URL)
    throw new SetupError('Computer registration could not be verified. Check your Providence account before trying again.');
  writeConfig(file, { deviceId: result.deviceId, token: result.token, url: result.url, workspace, workerAccess, keepAwake });
  log('[3/3] Start Providence');
  log('Computer registered. Choose how Providence should run on this computer.');
  await startCompanion(file, true);
}
