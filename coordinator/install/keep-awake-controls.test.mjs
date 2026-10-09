import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manageBackground } from './background.mjs';

test('local awake controls preserve pairing and access without invoking service restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'providence-awake-controls-'));
  const file = join(directory, 'device.json');
  const original = { deviceId: 'example', token: 'a'.repeat(64), url: 'wss://providence.hani.so/worker', workspace: directory, workerAccess: 'workspace', extraSetting: { retained: true } };
  writeFileSync(file, JSON.stringify(original), { mode: 0o600 });
  try {
    const adapters = { run: () => assert.fail('Keep-awake updates must not stop/start a service'), contact: async () => undefined };
    const on = await manageBackground('awake-on', file, adapters);
    assert.equal(on.preferenceSaved, true); assert.equal(on.keepAwakeEnabled, true);
    assert.deepEqual(JSON.parse(readFileSync(file)), { ...original, keepAwake: true });
    const off = await manageBackground('awake-off', file, adapters);
    assert.equal(off.preferenceSaved, true); assert.deepEqual(JSON.parse(readFileSync(file)), { ...original, keepAwake: false });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
