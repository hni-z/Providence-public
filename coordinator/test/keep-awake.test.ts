import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { KeepAwakeController } from '../src/keep-awake.js';
import { deviceConfigSchema, runtimeMetadata, type KeepAwakeState } from '../src/device-config.js';
import type { KeepAwakeStatus, KeepAwakeHandle } from '../install/keep-awake.mjs';
import { Coordinator } from '../src/coordinator.js';
import { createHttpServer } from '../src/server.js';

function fakeLease() {
  let state: KeepAwakeStatus = { active: true, method: 'caffeinate-idle', reason: 'idle_sleep_inhibited' };
  let stops = 0;
  return { get stops() { return stops; }, set(stateNext: KeepAwakeStatus) { state = stateNext; },
    handle: { get status() { return state; }, async stop() { stops++; state = { active: false, reason: 'stopped' }; } } satisfies KeepAwakeHandle };
}

test('sleep protection is opt-in, single-owned, and released without restarting work', async () => {
  const lease = fakeLease(); let starts = 0;
  const changes: KeepAwakeState[] = [];
  const controller = new KeepAwakeController(s => changes.push(s), async () => { starts++; return lease.handle; });
  await controller.setEnabled(false); assert.equal(starts, 0);
  await controller.setEnabled(true); assert.equal(starts, 0, "An idle background companion must not prevent sleep");
  await controller.renewActivity(true);
  await controller.setEnabled(true); await controller.setEnabled(true); assert.equal(starts, 1);
  assert.equal(controller.status.active, true);
  await controller.setEnabled(false); assert.equal(controller.status.active, false); assert.equal(lease.stops, 1);
  await controller.stop(); assert.equal(changes.at(-1)?.enabled, false);
  await controller.renewActivity(true);
  await controller.setEnabled(true); assert.equal(starts, 1, 'Stopped controllers cannot reacquire an assertion');
});

test('turning off while acquisition is pending releases the eventual assertion', async () => {
  const lease = fakeLease(); let resolve!: (h: KeepAwakeHandle) => void;
  const pending = new Promise<KeepAwakeHandle>(r => { resolve = r; });
  const controller = new KeepAwakeController(() => {}, () => pending);
  await controller.renewActivity(true);
  const on = controller.setEnabled(true); await Promise.resolve();
  const off = controller.setEnabled(false); resolve(lease.handle);
  await Promise.all([on, off]); assert.equal(controller.status.enabled, false); assert.equal(controller.status.active, false); assert.equal(lease.stops, 1);
});

test('failed helpers are reported honestly without disabling device work or leaking errors', async () => {
  const controller = new KeepAwakeController(() => {}, async () => { throw new Error('private diagnostic'); });
  await controller.renewActivity(true);
  await controller.setEnabled(true);
  assert.deepEqual(controller.status, { enabled: true, active: false, reason: 'helper_unavailable' });
  await controller.stop();
});

test('an unconfirmed release retains its handle and cannot start a second inhibitor', async () => {
  let starts = 0;
  const handle: KeepAwakeHandle = { status: { active: false, reason: 'stop_unconfirmed' }, async stop() {} };
  const controller = new KeepAwakeController(() => {}, async () => { starts++; return handle; });
  await controller.renewActivity(true);
  await controller.setEnabled(true); await controller.setEnabled(false); await controller.setEnabled(true);
  assert.equal(starts, 1); assert.equal(controller.status.reason, 'stop_unconfirmed'); await controller.stop();
});

test('helper exit updates status but does not enter an automatic retry loop', async () => {
  const lease = fakeLease(); let report: ((status: KeepAwakeStatus) => void) | undefined; let changes = 0, starts = 0;
  const controller = new KeepAwakeController(() => { changes++; }, async options => { starts++; report = options?.onChange; return lease.handle; });
  await controller.renewActivity(true);
  await controller.setEnabled(true); const before = changes;
  lease.set({ active: false, reason: 'helper_exited' }); report!(lease.handle.status);
  assert.ok(changes > before); assert.equal(controller.status.active, false); assert.equal(starts, 1); await controller.stop();
});

test('keep-awake preference accepts booleans only and defaults to no assertion', () => {
  const config = { deviceId: 'example', token: 'a'.repeat(64), url: 'wss://providence.example/worker', workspace: '/home/developer/work' };
  assert.equal(deviceConfigSchema.parse(config).keepAwake, undefined);
  assert.equal(deviceConfigSchema.parse({ ...config, keepAwake: true }).keepAwake, true);
  assert.equal(deviceConfigSchema.safeParse({ ...config, keepAwake: 'true' }).success, false);
});

test('authenticated power reports update only their device and go inactive when disconnected', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'providence-power-'));
  const config = { clientToken: 'c'.repeat(64), localDeviceId: 'local', localDeviceName: 'Local', workspace: directory,
    devices: [{ id: 'remote', name: 'Remote', token: 'd'.repeat(64) }, { id: 'other', name: 'Other', token: 'e'.repeat(64) }] };
  const app = new Coordinator(config, directory), server = createHttpServer(app, config.clientToken);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/worker?deviceId=remote`, { headers: { Authorization: `Bearer ${config.devices[0].token}` } });
  try {
    await once(socket, 'open');
    const online = once(app.devices, 'online');
    socket.send(JSON.stringify({ kind: 'ready', capabilities: { readyAck: true }, metadata: runtimeMetadata(directory, false, undefined, 'workspace', undefined, { enabled: true, active: false, reason: 'startup_unconfirmed' }) }));
    await online;
    const updated = once(app.devices, 'metadata');
    socket.send(JSON.stringify({ kind: 'power_state', deviceId: 'other', keepAwake: { enabled: true, active: true, method: 'caffeinate-idle', reason: 'idle_sleep_inhibited' } }));
    await updated;
    assert.equal(app.devices.list().find(d => d.id === 'remote')?.keepAwake?.active, true);
    assert.equal(app.devices.list().find(d => d.id === 'other')?.keepAwake, undefined);
    const offline = once(app.devices, 'offline'); socket.close(); await offline;
    const last = app.devices.list().find(d => d.id === 'remote')?.keepAwake;
    assert.equal(last?.active, false); assert.equal(last?.reason, 'disconnected');
  } finally { socket.terminate(); app.stop(); await new Promise<void>(r => server.close(() => r())); rmSync(directory, { recursive: true, force: true }); }
});


test('expired activity leases release assertions while the background companion stays enabled', async () => {
  const lease = fakeLease(); const controller = new KeepAwakeController(() => {}, async () => lease.handle);
  await controller.setEnabled(true); await controller.renewActivity(true, 15);
  assert.equal(controller.status.active, true);
  await new Promise(r => setTimeout(r, 35));
  assert.deepEqual(controller.status, { enabled: true, active: false, reason: 'waiting_for_activity' });
  assert.equal(lease.stops, 1); await controller.stop();
});
