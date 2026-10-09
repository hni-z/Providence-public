import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, type SendState } from './contracts.js';

type Record = { id: string; fingerprint: string; state: SendState; updatedAt: string };
export class SendJournal {
  constructor(private directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  get(id: string): Record | undefined {
    try { return JSON.parse(readFileSync(join(this.directory, `${id}.json`), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new AppError(503, 'Send journal could not be read. Sending is blocked until the Mac operator checks it.'); }
  }
  reserve(id: string, fingerprint: string) {
    if (readdirSync(this.directory).length >= 10000) throw new AppError(503, 'Send journal is full. Ask the Mac operator to archive it after checking Mail.');
    const record: Record = { id, fingerprint, updatedAt: new Date().toISOString(), state: { status: 'uncertain', message: 'A send attempt started. Check Mail Sent and Outbox before doing anything else; no automatic retry.' } };
    try { writeFileSync(join(this.directory, `${id}.json`), JSON.stringify(record), { flag: 'wx', mode: 0o600, flush: true }); }
    catch { throw new AppError(409, 'This request already has a send record or the journal is unavailable. Check Mail; do not resend automatically.'); }
  }
  submitted(id: string, receipt: string) {
    const record = this.get(id);
    if (!record) throw new Error('Missing send reservation');
    record.state = { status: 'submitted', receipt, message: 'Handed to Apple Mail for sending. Delivery is not confirmed; check Sent and Outbox.' };
    record.updatedAt = new Date().toISOString();
    const path = join(this.directory, `${id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(record), { mode: 0o600, flush: true });
    renameSync(`${path}.tmp`, path);
    return record.state;
  }
}
