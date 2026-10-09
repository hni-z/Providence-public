import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appCodexCandidates, nativeCodexPath, prepareCodex, existingCodex } from './prepare-codex.mjs';

test('native package resolution uses the official six platform targets', () => {
  for (const [platform, arch, triple] of [
    ['darwin','arm64','aarch64-apple-darwin'], ['darwin','x64','x86_64-apple-darwin'],
    ['linux','arm64','aarch64-unknown-linux-musl'], ['linux','x64','x86_64-unknown-linux-musl'],
    ['win32','arm64','aarch64-pc-windows-msvc'], ['win32','x64','x86_64-pc-windows-msvc'],
  ]) {
    assert.equal(nativeCodexPath('/private', platform, arch), join('/private','node_modules','@openai',`codex-${platform}-${arch}`,'vendor',triple,'bin',platform === 'win32' ? 'codex.exe' : 'codex'));
  }
  assert.throws(() => nativeCodexPath('/private', 'linux', 'arm'), /Unsupported/);
});

test('current app-native Codex locations precede older paths and private fallbacks', () => {
  assert.equal(appCodexCandidates({ platform: 'darwin', env: {} })[0], '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  const local = mkdtempSync(join(tmpdir(), 'providence-windows-codex-'));
  try {
    const bin = join(local, 'OpenAI', 'Codex', 'bin');
    const older = join(bin, '1111111111111111'), current = join(bin, 'faa963e871dd422c'), pathBin = join(local, 'path');
    for (const directory of [older, current, pathBin]) { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'codex.exe'), 'fixture'); }
    utimesSync(older, 100, 100); utimesSync(current, 200, 200);
    const env = { LOCALAPPDATA: local, PATH: pathBin };
    assert.deepEqual(appCodexCandidates({ env, platform: 'win32' }), [join(current, 'codex.exe'), join(older, 'codex.exe')]);
    const checked = [];
    assert.equal(existingCodex({ env, platform: 'win32', check: file => { checked.push(file); return true; } }), join(current, 'codex.exe'));
    assert.deepEqual(checked, [join(current, 'codex.exe')]);
    assert.equal(existingCodex({ env: { ...env, CODEX_BIN: '/explicit/codex.exe' }, platform: 'win32', check: () => true }), '/explicit/codex.exe');
    symlinkSync(pathBin, join(bin, 'eeeeeeeeeeeeeeee'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(appCodexCandidates({ env, platform: 'win32' }).some(file => file.includes('eeeeeeeeeeeeeeee')), false);
  } finally { rmSync(local, { recursive: true, force: true }); }
});

test('a user-specified invalid Codex fails instead of silently substituting another binary', () => {
  const original = process.env.CODEX_BIN;
  try { process.env.CODEX_BIN = '/missing-providence-test/codex'; assert.throws(existingCodex, /CODEX_BIN/); }
  finally { if (original === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = original; }
});

test('existing Codex is preferred without creating a private runtime', () => {
  const directory = mkdtempSync(join(tmpdir(), 'providence-codex-existing-'));
  try {
    assert.equal(prepareCodex(join(directory,'runtimes'), '/unused/npm-cli.js', () => '/existing/codex'), '/existing/codex');
    assert.equal(existsSync(join(directory,'runtimes')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a CLI without app-server support is not accepted as an existing runtime', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'providence-codex-incompatible-'));
  const original = process.env.CODEX_BIN;
  try {
    const binary = join(directory, 'codex');
    writeFileSync(binary, '#!/bin/sh\nif [ "$1" = --version ]; then echo codex-cli 0.1.0; else exit 2; fi\n', { mode: 0o700 });
    process.env.CODEX_BIN = binary;
    assert.throws(existingCodex, /usable Codex/);
  } finally {
    if (original === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = original;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('private package installation is locked, atomic, reusable, and does not overwrite unknown state', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'providence-codex-fixture-'));
  try {
    const npm = join(directory, 'fake-npm.mjs');
    const runtimeRoot = join(directory, 'runtimes');
    const target = nativeCodexPath(runtimeRoot).split('node_modules')[1];
    writeFileSync(npm, `import {mkdirSync,writeFileSync,readFileSync,realpathSync} from 'node:fs';import{dirname,join}from'node:path';
const args=process.argv.slice(2);const cache=args[args.indexOf('--cache')+1];if(!args.includes('ci')||!args.includes('--ignore-scripts')||!args.includes('--update-notifier=false')||!cache.endsWith('/.npm-cache')||realpathSync(dirname(cache))!==realpathSync(process.cwd()))process.exit(2);
const lock=JSON.parse(readFileSync('package-lock.json','utf8'));if(lock.packages['node_modules/@openai/codex'].version!=='0.157.1')process.exit(3);
const p=join(process.cwd(),'node_modules',${JSON.stringify(target)});mkdirSync(dirname(p),{recursive:true});writeFileSync(p,'#!/bin/sh\\necho codex-cli 0.157.1\\n',{mode:0o700});`);
    const binary = prepareCodex(runtimeRoot, npm, () => undefined);
    assert.equal(existsSync(binary), true);
    assert.equal(readdirSync(runtimeRoot).length, 1);
    assert.equal(prepareCodex(runtimeRoot, '/unused/npm-cli.js', () => undefined), binary);
    const installed = join(runtimeRoot, readdirSync(runtimeRoot)[0]);
    const marker = join(installed, '.providence-complete');
    writeFileSync(marker, 'unknown-version');
    assert.throws(() => prepareCodex(runtimeRoot, npm, () => undefined), /left untouched/);
    assert.equal(readFileSync(marker, 'utf8'), 'unknown-version');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a failed private package install leaves no activated or partial runtime', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'providence-codex-failure-'));
  try {
    const npm = join(directory, 'fake-npm.mjs');
    writeFileSync(npm, 'process.exit(17);');
    const runtimeRoot = join(directory, 'runtimes');
    assert.throws(() => prepareCodex(runtimeRoot, npm, () => undefined), /could not be installed/);
    assert.deepEqual(readdirSync(runtimeRoot), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
