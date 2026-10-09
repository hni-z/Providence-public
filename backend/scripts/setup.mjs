import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const backend = fileURLToPath(new URL('../', import.meta.url));
const path = resolve(backend, '.env.local');
if (!existsSync(path)) {
  const example = readFileSync(resolve(backend, '.env.example'), 'utf8');
  writeFileSync(path, example.replace('DEMO_TOKEN=', `DEMO_TOKEN=${randomBytes(32).toString('hex')}`), { mode: 0o600, flag: 'wx' });
  console.log('Created backend/.env.local. Set OPENAI_API_KEY and MAIL_SENDER in your local editor. Secrets were not printed.');
} else console.log('Preserved existing backend/.env.local.');
const dir = resolve(backend, '../.providence');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const contacts = resolve(dir, 'contacts.local.json');
if (!existsSync(contacts)) writeFileSync(contacts, '[]\n', { flag: 'wx', mode: 0o600 });
console.log('Optional: add exact name/email aliases to .providence/contacts.local.json.');
