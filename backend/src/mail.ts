import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, type Draft } from './contracts.js';

const exec = promisify(execFile);
const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
export interface MailTransport {
  check(sender: string): Promise<void>;
  send(sender: string, draft: Draft): Promise<string>;
}
export class AppleMail implements MailTransport {
  async check(sender: string) {
    if (process.platform !== 'darwin') throw new AppError(503, 'Sending requires the demo Mac with Apple Mail. Drafting works on this computer.');
    try {
      const { stdout } = await exec('/usr/bin/osascript', [join(scripts, 'mail-check.applescript'), sender], { timeout: 25_000, maxBuffer: 1024 });
      if (stdout.trim() !== 'ready') throw new Error('not ready');
    } catch {
      throw new AppError(503, 'Open Apple Mail, sign in to MAIL_SENDER, and allow Terminal/Node to control Mail in macOS Privacy & Security > Automation. Then run npm run mail-check.');
    }
  }
  async send(sender: string, draft: Draft) {
    if (process.platform !== 'darwin') throw new AppError(503, 'Apple Mail requires macOS.');
    const dir = await mkdtemp(join(tmpdir(), 'providence-mail-'));
    try {
      const payload = join(dir, 'message.json');
      await writeFile(payload, JSON.stringify({ sender, ...draft }), { mode: 0o600 });
      // Fixed script + file argument: recipient/body are never executable code or shell arguments.
      const { stdout } = await exec('/usr/bin/osascript', [join(scripts, 'mail-send.applescript'), payload], { timeout: 35_000, maxBuffer: 1024 });
      const receipt = stdout.trim();
      if (!/^submitted:\d+$/.test(receipt)) throw new Error('Unrecognized Mail result');
      return receipt;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
