#!/usr/bin/env node
import { lstatSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [deviceId, chatId] = process.argv.slice(2);
if (process.argv.length !== 4 || ![deviceId, chatId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value))) {
  console.error('Usage: node scripts/configure-coordinator-watch.mjs REGISTERED_DEVICE_ID REGISTERED_CHAT_ID');
  process.exit(1);
}
const target = resolve(dirname(fileURLToPath(import.meta.url)), '../WatchStarter/ProvidenceCoordinatorConfig.json');
for (const file of [target, `${target}.tmp`]) {
  try { if (lstatSync(file).isSymbolicLink()) throw new Error('Refusing a symlinked routing configuration.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const configuration = { baseURL: 'https://providence.hani.so', deviceId, chatId };
writeFileSync(`${target}.tmp`, JSON.stringify(configuration, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
renameSync(`${target}.tmp`, target);
console.log('Public Watch routing IDs saved. No credentials were written. Rebuild the Watch app, then pair it using a one-use client code.');
