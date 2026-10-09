#!/usr/bin/env node
// Copy only source/test files into a disposable sandbox. Never load .env or private config.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let suite = 'all', root = dirname(here), offline = false, invalid = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--suite' && args[i + 1]) suite = args[++i];
  else if (args[i] === '--source' && args[i + 1]) root = resolve(args[++i]);
  else if (args[i] === '--offline') offline = true;
  else invalid = true;
}
if (!['baseline', 'voice', 'all'].includes(suite) || invalid) {
  console.error('Usage: node voice-demo-validation/run.mjs [--suite baseline|voice|all] [--source /path/to/product/worktree] [--offline]');
  process.exit(2);
}
const sandbox = mkdtempSync(join(tmpdir(), 'providence-acceptance-'));
const report = { suite, sourceRoot: root, sourceCommit: '', startedAt: new Date().toISOString(), sandbox, evidence: 'offline synthetic only', sources: {}, checks: [] };
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|HOME|TMPDIR|TMP|TEMP|LANG|LC_.*|DEVELOPER_DIR|SDKROOT|SYSTEMROOT)$/.test(key)));
env.PROVIDENCE_ACCEPTANCE_SUITE = suite;
// No account settings, NODE_OPTIONS, provider keys or application tokens inherited.
function command(label, bin, argv, cwd = sandbox) {
  console.log(`\n${label}`);
  const result = spawnSync(bin, argv, { cwd, env, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024, timeout: 300_000 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? '\n' + result.error.message : ''}`;
  const log = join(sandbox, `${report.checks.length.toString().padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-')}.log`);
  writeFileSync(log, output);
  const item = { label, command: [bin, ...argv], cwd, exitCode: result.status ?? 1, log };
  report.checks.push(item);
  console.log(output.trim().split('\n').slice(-35).join('\n'));
  console.log(`exit=${item.exitCode}; full log: ${log}`);
  return item.exitCode === 0;
}
function copy(relative) {
  const source = join(relative.startsWith('voice-demo-validation/') ? dirname(here) : root, relative), target = join(sandbox, relative);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  function hash(path, rel) {
    for (const e of readdirSync(path, { withFileTypes: true })) {
      if (e.isDirectory()) hash(join(path, e.name), `${rel}/${e.name}`);
      else report.sources[`${rel}/${e.name}`] = createHash('sha256').update(readFileSync(join(path, e.name))).digest('hex');
    }
  }
  if (readdirSync(dirname(source), { withFileTypes: true }).find(e => e.name === relative.split('/').at(-1))?.isDirectory()) hash(source, relative);
  else report.sources[relative] = createHash('sha256').update(readFileSync(source)).digest('hex');
}
report.sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
report.sourceDirtyState = spawnSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).stdout.trim();
console.log(`Offline acceptance: ${suite}; source ${report.sourceCommit}; evidence ${sandbox}`);
for (const path of ['backend/src', 'backend/test', 'backend/package.json', 'backend/package-lock.json', 'backend/tsconfig.json',
  'voice-demo-validation/package.json', 'voice-demo-validation/backend.acceptance.test.ts', 'voice-demo-validation/recipient-cases.json']) copy(path);
const installed = command('Install locked dependencies (scripts disabled)', 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', ...(offline ? ['--offline'] : [])], join(sandbox, 'backend'));
if (installed) {
  writeFileSync(join(sandbox, 'backend/tsconfig.acceptance.json'), JSON.stringify({ extends: './tsconfig.json', include: ['src/**/*.ts', '../voice-demo-validation/**/*.ts'] }));
  command('Acceptance harness typecheck', join(sandbox, 'backend/node_modules/.bin/tsc'), ['--project', 'tsconfig.acceptance.json'], join(sandbox, 'backend'));
  if (suite !== 'voice') {
    command('Backend typecheck', 'npm', ['run', 'check'], join(sandbox, 'backend'));
    command('Existing backend regressions', 'npm', ['test'], join(sandbox, 'backend'));
  }
  command('Independent backend acceptance', join(sandbox, 'backend/node_modules/.bin/tsx'),
    ['--test', '--test-reporter=tap', 'voice-demo-validation/backend.acceptance.test.ts']);
}
if (suite !== 'voice') {
  for (const path of ['watch-coordinator-adapter/Package.swift', 'watch-coordinator-adapter/Sources', 'watch-coordinator-adapter/Tests',
    'WatchStarter/AssistantModels.swift', 'WatchStarter/MacControlModels.swift', 'tests/contracts', 'tests/mac-control',
    'voice-demo-validation/swift/main.swift', 'voice-demo-validation/swift/compatibility.swift']) copy(path);
  const packagePath = join(sandbox, 'watch-coordinator-adapter');
  const scratch = join(sandbox, 'swift-build');
  const built = command('Existing Swift adapter regressions', 'swift', ['test', '--package-path', packagePath, '--scratch-path', scratch]);
  if (built) {
    const bin = spawnSync('swift', ['build', '--package-path', packagePath, '--scratch-path', scratch, '--show-bin-path'], { env, encoding: 'utf8' }).stdout.trim();
    const objects = readdirSync(join(bin, 'WatchCoordinatorAdapter.build')).filter(f => f.endsWith('.swift.o')).map(f => join(bin, 'WatchCoordinatorAdapter.build', f));
    for (const [label, entry] of [['Existing Mac contracts', 'tests/mac-control/main.swift'], ['Independent Mac acceptance', 'voice-demo-validation/swift/main.swift']]) {
      const exe = join(sandbox, label.replaceAll(' ', '-'));
      if (command(`Compile ${label}`, 'swiftc', ['-parse-as-library', '-I', join(bin, 'Modules'), 'WatchStarter/MacControlModels.swift', entry, ...objects, '-o', exe])) command(label, exe, []);
    }
  }
  for (const [label, model, entry] of [
    ['Existing email decode contracts', 'WatchStarter/AssistantModels.swift', 'tests/contracts/main.swift'],
    ['Additive Job fields current decoder', 'WatchStarter/AssistantModels.swift', 'voice-demo-validation/swift/compatibility.swift'],
    ['Additive Job fields build 2 decoder', 'build2/AssistantModels.swift', 'voice-demo-validation/swift/compatibility.swift'],
  ]) {
    if (model.startsWith('build2/')) {
      const historical = readFileSync(join(here, 'fixtures/build2-AssistantModels.swift'), 'utf8');
      mkdirSync(join(sandbox, 'build2'));
      writeFileSync(join(sandbox, model), historical);
      report.sources['fixtures/build2-AssistantModels.swift'] = createHash('sha256').update(historical).digest('hex');
    }
    // Swift top-level statements must be in a file named main.swift.
    const target = join(sandbox, label.replaceAll(' ', '-'));
    mkdirSync(target);
    cpSync(join(sandbox, entry), join(target, 'main.swift'));
    if (command(`Compile ${label}`, 'swiftc', [model, join(target, 'main.swift'), '-o', join(target, 'run')])) command(label, join(target, 'run'), []);
  }
  if (existsSync(join(root, 'WatchStarter/VoiceContracts.swift')) && existsSync(join(root, 'tests/voice-first-watch/main.swift'))) {
    for (const path of ['WatchStarter/VoiceContracts.swift', 'tests/voice-first-watch/main.swift', 'voice-demo-validation/swift/voice-routing.swift', 'voice-demo-validation/swift/no-draft-clarification.swift', 'voice-demo-validation/swift/target-guard.swift']) copy(path);
    for (const [label, entry] of [['Watch owner pure voice contracts', 'tests/voice-first-watch/main.swift'], ['Independent Watch intent cases', 'voice-demo-validation/swift/voice-routing.swift'], ['Independent no-draft clarification', 'voice-demo-validation/swift/no-draft-clarification.swift'], ['Independent non-Mac target guard', 'voice-demo-validation/swift/target-guard.swift']]) {
      const exe = join(sandbox, label.replaceAll(' ', '-'));
      if (command(`Compile ${label}`, 'swiftc', ['-parse-as-library', '-strict-concurrency=complete', 'WatchStarter/AssistantModels.swift', 'WatchStarter/VoiceContracts.swift', entry, '-o', exe])) command(label, exe, []);
    }
  } else if (suite === 'all') {
    report.checks.push({ label: 'Watch voice contracts available', exitCode: 1, error: 'VoiceContracts.swift or Watch voice tests absent; integrate Watch feature then rerun all' });
    console.log('FAIL: Watch voice contract module/tests absent; native route gates remain unverified.');
  }
}
report.finishedAt = new Date().toISOString();
writeFileSync(join(sandbox, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\nEvidence report: ${join(sandbox, 'report.json')}`);
console.log('Native dictation, actual app lifecycle, provider quality, deployment and physical hardware remain unverified.');
process.exitCode = report.checks.some(c => c.exitCode !== 0) ? 1 : 0;
