import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, email } from './contracts.js';
import type { Contact } from './config.js';

export const contactName = z.string().trim().min(1).max(200)
  .refine(v => !/[\r\n\0@<>";,]/.test(v) && !/\b(?:and|or|cc|bcc|also)\b/i.test(v));
export const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
const contactSchema = z.object({ name: contactName, email }).strict();
const contactsSchema = z.array(contactSchema).max(100);

// Contacts are local private state. Synchronous, locked read/modify/rename keeps
// both overlapping HTTP requests and multiple local processes from losing saves.
export class ContactStore {
  constructor(private path: string, private configured: Contact[]) { this.list(); }
  private read(): Contact[] {
    try {
      if (!lstatSync(this.path).isFile()) throw new Error('Not a regular contact file');
      chmodSync(this.path, 0o600);
      return contactsSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new AppError(503, 'Private contact storage is invalid or unavailable. Ask the Mac operator to check it.');
    }
  }
  private combine(saved: Contact[]) {
    const all = [...contactsSchema.parse(this.configured), ...saved];
    const names = new Map<string, Contact>();
    for (const contact of all) {
      const key = nameKey(contact.name), previous = names.get(key);
      if (previous && previous.email.toLowerCase() !== contact.email.toLowerCase()) {
        throw new AppError(409, 'A contact name has conflicting addresses. Ask the Mac operator to resolve it.');
      }
      names.set(key, contact);
    }
    return [...names.values()];
  }
  list() { return this.combine(this.read()); }
  remember(value: Contact): Contact {
    const contact = contactSchema.parse(value);
    contact.name = contact.name.replace(/\s+/g, ' ');
    contact.email = contact.email.toLowerCase();
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    let lock: number;
    try { lock = openSync(`${this.path}.lock`, 'wx', 0o600); }
    catch { throw new AppError(503, 'Contact storage is busy or unavailable. Refresh before trying to remember this contact again.'); }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const saved = this.read();
      const existing = this.combine(saved).find(c => nameKey(c.name) === nameKey(contact.name));
      if (existing) {
        if (existing.email.toLowerCase() !== contact.email) throw new AppError(409, 'That name already has a different address. Say a distinct name; existing contacts are never overwritten.');
        return existing;
      }
      if (saved.length >= 100) throw new AppError(409, 'Contact memory is full. Ask the Mac operator to review saved contacts.');
      writeFileSync(temporary, JSON.stringify([...saved, contact]), { flag: 'wx', mode: 0o600, flush: true });
      renameSync(temporary, this.path);
      const descriptor = openSync(directory, 'r');
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      return contact;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'The contact could not be saved. Refresh before trying again.');
    } finally {
      try { unlinkSync(temporary); } catch { /* Already renamed or never created. */ }
      closeSync(lock);
      unlinkSync(`${this.path}.lock`);
    }
  }
}
