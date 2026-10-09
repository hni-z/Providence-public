#!/usr/bin/env node
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

export const ORIGIN = 'https://providence.hani.so';
export const CONFIG_NAME = 'review-mac.device.json';

export function configPath(home = homedir()) {
  return join(home, 'Library', 'Application Support', 'Providence', CONFIG_NAME);
}
export function validateOrigin(input = ORIGIN) {
  let url;
  try { url = new URL(input); } catch { throw new Error('Coordinator origin must be https://providence.hani.so.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== ORIGIN)
    throw new Error('Coordinator origin is pinned to https://providence.hani.so with no credentials, path, query, or fragment.');
  return url;
}
export function validateWorkerUrl(value, origin = validateOrigin()) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Pairing response contained an invalid worker URL.'); }
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || url.pathname !== '/worker' || url.host !== origin.host)
    throw new Error('Pairing response did not return this coordinator’s wss:// origin and /worker path.');
  return url;
}
function assertAbsoluteWorkspace(value) {
  if (!isAbsolute(value) || parse(resolve(value)).root === resolve(value))
    throw new Error('Workspace must be an absolute, non-root local folder.');
  return resolve(value);
}
function assertAbsolutePrivateFile(value, label) {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute local path.`);
  return resolve(value);
}
export function assertNoSymlink(path, includeLeaf = true) {
  const stop = includeLeaf ? path : dirname(path);
  const root = parse(stop).root;
  let current = root;
  for (const part of stop.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symlinked private path: ${current}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}
export function ensurePrivateParent(file) {
  const parent = dirname(file);
  assertNoSymlink(file, false);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertNoSymlink(file, false);
  const info = statSync(parent);
  if (!info.isDirectory()) throw new Error('Private Providence path is not a directory.');
  chmodSync(parent, 0o700);
}
function validateSaved(value, expectedWorkspace) {
  if (!value || typeof value !== 'object') throw new Error('Existing enrollment is invalid. Refusing to replace it automatically.');
  const { deviceId, token, url, workspace, transcriptionEnvFile, browserControl, workerAccess, workerModel, workerReasoningEffort } = value;
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(deviceId) || typeof token !== 'string' || token.length < 32 || typeof url !== 'string' || typeof workspace !== 'string')
    throw new Error('Existing enrollment is invalid. Refusing to replace it automatically.');
  validateWorkerUrl(url);
  if (expectedWorkspace && resolve(workspace) !== expectedWorkspace)
    throw new Error('Existing enrollment uses another workspace. Refusing to replace it; use that workspace or remove enrollment deliberately.');
  if (transcriptionEnvFile !== undefined) validatePrivateEnvFile(transcriptionEnvFile);
  if (browserControl !== undefined && browserControl !== 'chrome') throw new Error('Existing enrollment has an invalid browser-control setting.');
  if (workerAccess !== undefined && !['workspace', 'full-access'].includes(workerAccess)) throw new Error('Existing enrollment has an invalid worker-access setting.');
  for (const [name, option, expression] of [['worker model', workerModel, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/], ['worker reasoning effort', workerReasoningEffort, /^[a-z][a-z0-9_-]{0,63}$/]])
    if (option !== undefined && (typeof option !== 'string' || !expression.test(option))) throw new Error(`Existing enrollment has an invalid ${name} setting.`);
  return { deviceId, token, url, workspace: assertAbsoluteWorkspace(workspace), ...(transcriptionEnvFile ? { transcriptionEnvFile } : {}), ...(browserControl ? { browserControl } : {}), ...(workerAccess ? { workerAccess } : {}), ...(workerModel ? { workerModel } : {}), ...(workerReasoningEffort ? { workerReasoningEffort } : {}) };
}
export function readEnrollment(file, expectedWorkspace) {
  assertNoSymlink(file);
  if (!existsSync(file)) return undefined;
  const stat = lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Existing enrollment is not a private regular file.');
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error('Existing enrollment is unreadable or invalid. Refusing to replace it automatically.'); }
  try {
    const saved = validateSaved(value, expectedWorkspace);
    assertCredentialOutsideWorkspace(saved.workspace, file);
    return saved;
  }
  catch (error) { if (error instanceof Error) throw error; throw new Error('Existing enrollment is invalid.'); }
}
export function assertCredentialOutsideWorkspace(workspace, file) {
  assertNoSymlink(workspace);
  const fromWorkspace = relative(workspace, file);
  if (fromWorkspace === '' || (!fromWorkspace.startsWith('../') && fromWorkspace !== '..' && !isAbsolute(fromWorkspace)))
    throw new Error('Choose a dedicated workspace that does not contain the private device enrollment.');
}
export function validatePrivateEnvFile(file) {
  const path = assertAbsolutePrivateFile(file, 'Transcription environment file');
  assertNoSymlink(path);
  if (!lstatSync(path).isFile()) throw new Error('Transcription environment file must be an existing regular file.');
  return path;
}
export function saveEnrollment(file, config) {
  ensurePrivateParent(file);
  assertNoSymlink(file);
  if (existsSync(file)) throw new Error('Enrollment already exists. Refusing to overwrite it.');
  const fd = openSync(file, 'wx', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8' }); chmodSync(file, 0o600); }
  finally { closeSync(fd); }
}

/** Runs at most one owned companion child at a time.  Only exit 75 is retried;
 * owner stop (0) and action-required (78) are final and preserve their code. */
export async function superviseCompanion(spawnChild, {
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  stopped = () => false,
  maxRetries = 3,
  delays = [1000, 2000, 4000],
} = {}) {
  let retries = 0;
  while (!stopped()) {
    const code = await new Promise((resolve, reject) => {
      const child = spawnChild();
      child.once('error', reject);
      child.once('exit', value => resolve(typeof value === 'number' ? value : 75));
    }).catch(() => 75);
    if (code !== 75 || retries >= maxRetries || stopped()) return code;
    const delay = Math.min(30_000, delays[Math.min(retries++, delays.length - 1)] ?? 30_000);
    await wait(delay);
  }
  return 0;
}

export async function exchange({ code, fetchImpl = fetch, origin = ORIGIN }) {
  const coordinator = validateOrigin(origin);
  let response;
  try {
    response = await fetchImpl(new URL('/pair/exchange', coordinator), {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ code }),
    });
  } catch { throw new Error('Pairing exchange could not reach the coordinator. No credential was saved.'); }
  if (response.status >= 300 && response.status < 400) throw new Error('Pairing exchange redirected; no credential was saved.');
  if (!response.ok) throw new Error('Pairing exchange failed. The code may be invalid, expired, or already used. Do not retry automatically.');
  let value;
  try { value = await response.json(); } catch { throw new Error('Pairing exchange returned invalid JSON.'); }
  if (!value || typeof value.deviceId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value.deviceId) || typeof value.token !== 'string' || value.token.length < 32 || typeof value.url !== 'string')
    throw new Error('Pairing exchange returned an invalid enrollment response.');
  validateWorkerUrl(value.url, coordinator);
  return { deviceId: value.deviceId, token: value.token, url: value.url };
}
export function readHiddenPairingCode(input = process.stdin, output = process.stderr) {
  if (!input.isTTY || typeof input.setRawMode !== 'function')
    return Promise.reject(new Error('Pairing requires a TTY so the one-use code is never echoed or passed in argv.'));
  return new Promise((resolveCode, reject) => {
    const wasRaw = input.isRaw === true;
    let code = '';
    const cleanUp = () => {
      input.off('data', onData); input.off('error', onError); input.off('end', onEnd);
      input.setRawMode(wasRaw); input.pause?.();
    };
    const fail = message => { cleanUp(); reject(new Error(message)); };
    const onError = () => fail('Unable to read the pairing code from this TTY.');
    const onEnd = () => fail('Pairing code input ended before submission.');
    const onData = raw => {
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      for (const character of text) {
        if (character === '\u0003') return fail('Pairing cancelled.');
        if (character === '\r' || character === '\n') { cleanUp(); output.write('\n'); return resolveCode(code.trim()); }
        if (character === '\u0008' || character === '\u007f') { code = code.slice(0, -1); continue; }
        if (character >= ' ' && character !== '\u007f') code += character;
      }
    };
    output.write('Enter one-use Providence pairing code: ');
    input.setRawMode(true); input.resume?.(); input.on('data', onData); input.once('error', onError); input.once('end', onEnd);
  });
}
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) throw new Error('Unknown argument.');
    const key = rest[i].slice(2);
    if (!['workspace', 'transcription-env', 'dry-run', 'verified-chrome'].includes(key)) throw new Error(`Unknown option --${key}.`);
    if (key === 'dry-run' || key === 'verified-chrome') values[key === 'verified-chrome' ? 'verifiedChrome' : 'dryRun'] = true;
    else { const value = rest[++i]; if (!value || value.startsWith('--')) throw new Error(`--${key} needs a value.`); values[key] = value; }
  }
  if (!['pair', 'start', 'status'].includes(command)) throw new Error('Usage: providence-mac.mjs pair|start|status [--workspace ABS_PATH] [--transcription-env ABS_PATH] [--dry-run]');
  if (values.dryRun && command !== 'start') throw new Error('--dry-run is available only with start.');
  if ((values['transcription-env'] || values.verifiedChrome) && command !== 'pair') throw new Error('--transcription-env and --verified-chrome are available only with pair.');
  return { command, values };
}
export async function main(argv = process.argv.slice(2), options = {}) {
  const { command, values } = parseArgs(argv);
  const file = options.configFile ?? configPath(options.home);
  const expectedWorkspace = values.workspace ? assertAbsoluteWorkspace(values.workspace) : undefined;
  const existing = readEnrollment(file, expectedWorkspace);
  if (command === 'status' || (command === 'start' && values.dryRun)) {
    console.log(existing ? `Enrollment: configured\nDevice: ${existing.deviceId}\nWorkspace: ${existing.workspace}\nCoordinator: ${ORIGIN}\nTranscription env: ${existing.transcriptionEnvFile ? 'configured' : 'not configured'}\nChrome control: ${existing.browserControl === 'chrome' ? 'verified opt-in' : 'not enabled'}` : 'Enrollment: not configured');
    return;
  }
  if (command === 'pair') {
    if (existing) {
      console.log(`Enrollment already configured for ${existing.workspace}; no pairing exchange was made.`);
      if (values.verifiedChrome !== (existing.browserControl === 'chrome')) console.log('Existing browser-control setting remains unchanged. Deliberately replace enrollment to change it.');
      return;
    }
    if (!expectedWorkspace) throw new Error('pair requires --workspace ABS_PATH.');
    assertCredentialOutsideWorkspace(expectedWorkspace, file);
    const transcriptionEnvFile = values['transcription-env'] ? validatePrivateEnvFile(values['transcription-env']) : undefined;
    ensurePrivateParent(file);
    assertNoSymlink(file);
    const code = options.readCode ? await options.readCode() : await readHiddenPairingCode();
    if (!code) throw new Error('Pairing code was empty.');
    const paired = await exchange({ code, fetchImpl: options.fetchImpl, origin: ORIGIN });
    saveEnrollment(file, { ...paired, workspace: expectedWorkspace, ...(transcriptionEnvFile ? { transcriptionEnvFile } : {}), ...(values.verifiedChrome ? { browserControl: 'chrome' } : {}) });
    console.log(`Enrollment saved for device ${paired.deviceId}. Start it separately with: node mac-setup/providence-mac.mjs start`);
    return;
  }
  if (!existing) throw new Error('No enrollment exists. Run pair first.');
  const coordinatorRoot = options.coordinatorRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'coordinator');
  const tsx = join(coordinatorRoot, 'node_modules', '.bin', 'tsx');
  if (!existsSync(tsx)) throw new Error('Coordinator dependencies are not installed. Run npm ci in coordinator first.');
  const code = await superviseCompanion(
    () => spawn(tsx, ['src/device.ts', file], { cwd: coordinatorRoot, stdio: 'inherit' }),
  );
  process.exitCode = code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 78; });
}
