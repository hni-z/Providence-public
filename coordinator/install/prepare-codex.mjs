#!/usr/bin/env node
// Resolve existing Codex first; install the locked official package privately if needed.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, copyFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const codexVersion = '0.157.1';
export function nativeCodexPath(directory, platform = process.platform, arch = process.arch) {
  const triples = {
    'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-musl', 'linux-x64': 'x86_64-unknown-linux-musl',
    'win32-arm64': 'aarch64-pc-windows-msvc', 'win32-x64': 'x86_64-pc-windows-msvc',
  };
  const triple = triples[`${platform}-${arch}`];
  if (!triple) throw new Error('Unsupported Codex platform.');
  return join(directory, 'node_modules', '@openai', `codex-${platform}-${arch}`, 'vendor', triple, 'bin', platform === 'win32' ? 'codex.exe' : 'codex');
}

function usable(binary) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary)) return false;
  const result = spawnSync(binary, ['--version'], { timeout: 15000, encoding: 'utf8', windowsHide: true, shell: false });
  if (result.status !== 0 || !/^codex(?:-cli)?\s+\d+\./im.test(result.stdout ?? '')) return false;
  // A CLI without app-server support cannot run Providence's companion.
  return spawnSync(binary, ['app-server', '--help'], { timeout: 15000, encoding: 'utf8', windowsHide: true, shell: false }).status === 0;
}

/** Public native app locations only; never inspect account/authentication files. */
export function appCodexCandidates({ env = process.env, platform = process.platform } = {}) {
  if (platform === 'darwin') return ['ChatGPT', 'Codex'].flatMap(app => [
    `/Applications/${app}.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`,
    `/Applications/${app}.app/Contents/Resources/codex`,
  ]);
  if (platform !== 'win32' || !env.LOCALAPPDATA) return [];
  const root = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    const versions = readdirSync(root).filter(name => /^[a-f0-9]{8,64}$/i.test(name)).map(name => {
      const directory = join(root, name), info = lstatSync(directory);
      return { directory, info };
    }).filter(({ info }) => info.isDirectory() && !info.isSymbolicLink())
      .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs || a.directory.localeCompare(b.directory)).slice(0, 32);
    return [join(root, 'codex.exe'), ...versions.map(({ directory }) => join(directory, 'codex.exe'))]
      .filter(file => { try { const info = lstatSync(file); return info.isFile() && !info.isSymbolicLink(); } catch { return false; } });
  } catch { return []; }
}

export function existingCodex({ env = process.env, platform = process.platform, check = usable } = {}) {
  if (env.CODEX_BIN) {
    if (!check(env.CODEX_BIN)) throw new Error('CODEX_BIN does not name a usable Codex executable. Correct it before retrying; Windows needs codex.exe, not a .cmd shim.');
    return env.CODEX_BIN;
  }
  for (const candidate of appCodexCandidates({ env, platform })) if (existsSync(candidate) && check(candidate)) return candidate;
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, platform === 'win32' ? 'codex.exe' : 'codex');
    if (existsSync(candidate) && check(candidate)) return candidate;
    if (platform === 'win32') {
      // The npm shim itself cannot be spawned with shell:false. Resolve its vendor binary.
      for (const packageRoot of [directory, join(directory, 'node_modules', '@openai', 'codex')]) {
        const native = nativeCodexPath(packageRoot, platform);
        if (existsSync(native) && check(native)) return native;
        const legacy = native.replace(/([\\/])bin([\\/])codex\.exe$/, '$1codex$2codex.exe');
        if (existsSync(legacy) && check(legacy)) return legacy;
      }
    }
  }
  return undefined;
}

export function prepareCodex(runtimeDirectory, npmCli, findExisting = existingCodex) {
  const existing = findExisting();
  if (existing) return existing;
  const target = join(runtimeDirectory, `codex-${codexVersion}-${process.platform}-${process.arch}`);
  const marker = join(target, '.providence-complete');
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink() || !existsSync(marker) || readFileSync(marker, 'utf8').trim() !== codexVersion || !usable(nativeCodexPath(target))) {
      throw new Error(`An incomplete or unrecognized private Codex installation exists at ${target}. It has been left untouched.`);
    }
    return nativeCodexPath(target);
  }
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(runtimeDirectory, '.codex-'));
  try {
    const packageRoot = join(dirname(fileURLToPath(import.meta.url)), 'codex');
    for (const name of ['package.json', 'package-lock.json']) copyFileSync(join(packageRoot, name), join(staging, name));
    console.error(`Installing private Codex ${codexVersion}. Existing Codex settings and sign-in stay in place.`);
    const result = spawnSync(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund', '--update-notifier=false', '--registry=https://registry.npmjs.org', '--cache', join(staging, '.npm-cache')], {
      cwd: staging, stdio: ['ignore', 2, 2], shell: false, timeout: 600000,
    });
    if (result.status !== 0 || !usable(nativeCodexPath(staging))) throw new Error('The pinned Codex package could not be installed or run on this system.');
    writeFileSync(join(staging, '.providence-complete'), codexVersion + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(staging, target);
    return nativeCodexPath(target);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [runtimeDirectory, npmCli] = process.argv.slice(2);
    if (!runtimeDirectory || !npmCli) throw new Error('Installer runtime arguments are missing.');
    console.log(prepareCodex(runtimeDirectory, npmCli));
  } catch (error) { console.error(error instanceof Error ? error.message : 'Codex setup failed.'); process.exitCode = 1; }
}
