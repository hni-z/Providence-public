import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseEnv } from 'node:util';
import { email } from './contracts.js';

export const backendRoot = fileURLToPath(new URL('../', import.meta.url));
export const repoRoot = resolve(backendRoot, '..');
export function loadEnvironment() {
  for (const path of [resolve(backendRoot, '.env.local'), resolve(repoRoot, '.env.local')]) {
    try {
      const values = parseEnv(readFileSync(path, 'utf8'));
      for (const [key, value] of Object.entries(values)) if (!process.env[key] && value) process.env[key] = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export type Contact = { name: string; email: string };
export type Config = {
  token: string; apiKey?: string; transcriptionModel: string; draftModel: string;
  sender: string | null; enableSending: boolean; enableText: boolean;
  contacts: Contact[]; contactsFile?: string; journalDir: string; maxJobs: number; ttlMs: number;
};
export function configFromEnv(): Config {
  const token = process.env.DEMO_TOKEN ?? '';
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('Run npm run setup: DEMO_TOKEN must be 32 random bytes encoded as 64 hex characters.');
  let contacts: Contact[] = [];
  const contactFile = resolve(repoRoot, '.providence/contacts.local.json');
  try {
    contacts = z.array(z.object({ name: z.string().trim().min(1).max(200), email })).max(100).parse(JSON.parse(readFileSync(contactFile, 'utf8')));
    const names = contacts.map(c => c.name.toLowerCase());
    if (new Set(names).size !== names.length) throw new Error('Duplicate contact aliases');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid contacts.local.json; use unique names and valid email addresses.');
  }
  const sender = process.env.MAIL_SENDER ? email.parse(process.env.MAIL_SENDER) : null;
  return {
    token, apiKey: process.env.OPENAI_API_KEY,
    transcriptionModel: process.env.TRANSCRIPTION_MODEL || 'gpt-transcribe',
    draftModel: process.env.DRAFT_MODEL || 'gpt-4.1-mini',
    sender, enableSending: process.env.ENABLE_SENDING === 'true',
    enableText: process.env.ENABLE_TEXT_TEST === 'true', contacts,
    contactsFile: resolve(repoRoot, '.providence/remembered-contacts.local.json'),
    journalDir: resolve(repoRoot, '.providence/send-journal'), maxJobs: 50, ttlMs: 60 * 60 * 1000,
  };
}
