#!/usr/bin/env node
// Per-user supervisor. The common companion lock also protects foreground runs.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireCompanionLock, launchCompanion } from '../scripts/connect-helpers.mjs';
import { logPath, readPrivateJson, statePath, writePrivateJson } from './background.mjs';

export async function runBackground(configFile, options = {}) {
  if (!readPrivateJson(configFile)) throw new Error('The private companion configuration is missing.');
  const supervisorLock = acquireCompanionLock(configFile + '.background');
  try {
    supervisorLock.attachChild(process.pid);
    return await runOwnedBackground(configFile, options);
  } finally { supervisorLock.release(); }
}

async function runOwnedBackground(configFile, { launch = launchCompanion, wait = delay, platform = process.platform, signals = process } = {}) {
  const logFile = logPath(configFile);
  if (existsSync(logFile)) {
    const logStat = lstatSync(logFile);
    if (logStat.isSymbolicLink() || !logStat.isFile() || (platform !== 'win32' && logStat.uid !== process.getuid())) throw new Error('The companion log must be a regular file owned by this user.');
  }
  if (existsSync(logFile) && statSync(logFile).size > 10 * 1024 * 1024) renameSync(logFile, logFile + '.previous');
  const descriptor = openSync(logFile, 'a', 0o600);
  if (platform !== 'win32') chmodSync(logFile, 0o600);
  const log = message => writeSync(descriptor, `${new Date().toISOString()} ${message}\n`);
  const nonce = randomBytes(16).toString('hex');
  const endpoint = platform === 'win32' ? `\\\\.\\pipe\\providence-${nonce}` : join(dirname(configFile), `.p-${nonce.slice(0, 16)}.sock`);
  const token = randomBytes(32).toString('hex');
  let stopping = false, phase = 'starting', exitStatus = 0;
  const state = () => writePrivateJson(statePath(configFile), { schemaVersion: 1, pid: process.pid, state: phase, ...(['running', 'starting', 'retrying'].includes(phase) ? { endpoint, token } : {}) });
  const onSignal = () => { stopping = true; };
  signals.on('SIGTERM', onSignal);
  signals.on('SIGINT', onSignal);
  const server = createServer(socket => {
    let text = '';
    socket.setTimeout(1500, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      text += chunk;
      if (text.length > 2048) { socket.destroy(); return; }
      if (!text.includes('\n')) return;
      try {
        const request = JSON.parse(text.split('\n')[0]);
        if (typeof request.token !== 'string' || request.token.length !== token.length || !timingSafeEqual(Buffer.from(request.token), Buffer.from(token))) { socket.destroy(); return; }
        if (request.command === 'status') socket.end(JSON.stringify({ running: true, state: phase }) + '\n');
        else if (request.command === 'stop') {
          socket.end('{"accepted":true}\n');
          stopping = true;
          setTimeout(() => signals.emit('SIGTERM'), 25).unref();
        } else socket.destroy();
      } catch { socket.destroy(); }
    });
  });
  try {
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(endpoint, accept); });
    if (platform !== 'win32') chmodSync(endpoint, 0o600);
    state();
    for (let failures = 0; !stopping;) {
      let result;
      try {
        const completion = launch(configFile, { signals, spawner: (binary, args, options) => spawn(binary, args, { ...options, stdio: ['ignore', descriptor, descriptor], windowsHide: true }) });
        phase = 'running'; state(); log('Companion process started. Account device status provides connection confirmation.');
        result = await completion;
      } catch {
        // Includes a live foreground lock. Do not repeatedly contend for it.
        phase = 'action-required'; log('Companion could not start. Check configuration, permissions, or an already running foreground companion.');
        break;
      }
      if (stopping || result === 0) { phase = 'stopped'; break; }
      if (result === 78) { phase = 'action-required'; log('Companion stopped because account, configuration, or permissions need attention. No automatic restart.'); break; }
      if (result !== 75 || failures >= 3) { phase = 'failed'; log('Companion stopped after a process error. Use the local manager to restart after investigating.'); break; }
      failures++;
      phase = 'retrying'; state(); log(`Retrying after a process failure (${failures}/3).`);
      await wait([1000, 5000, 15000][failures - 1]);
    }
    if (stopping) phase = 'stopped';
    state();
    // All automatic retry decisions live here. OS login launchers must not
    // restart action-required exits, revocations, or owner-initiated stops.
    exitStatus = 0;
  } finally {
    signals.off('SIGTERM', onSignal); signals.off('SIGINT', onSignal);
    await new Promise(accept => server.close(accept));
    if (platform !== 'win32' && existsSync(endpoint)) unlinkSync(endpoint);
    closeSync(descriptor);
  }
  return exitStatus;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('A companion config path is required.');
    process.exitCode = await runBackground(resolve(process.argv[2]));
  } catch {
    // No config contents or exception strings are written to OS logs.
    console.error('Providence background startup failed. Check the private helper configuration and log.');
    process.exitCode = 0;
  }
}
