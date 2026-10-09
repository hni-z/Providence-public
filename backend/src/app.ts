import express, { type NextFunction, type Request, type Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { backendRoot, type Config } from './config.js';
import { AppError, draftSchema, noSend, type Job } from './contracts.js';
import { createAI, publicProviderError, type AI } from './ai.js';
import { AppleMail, type MailTransport } from './mail.js';
import { SendJournal } from './journal.js';
import { ContactStore, contactName } from './contacts.js';
import { parseRecipientInput, replyClarification, resolveRecipient } from './recipients.js';

const uuid = z.string().uuid();
const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
type Entry = { job: Job; fingerprint: string; expiresAt: number; explicitAddress?: string; approval?: { token: string; version: number; expiresAt: number } };
export function createApp(config: Config, dependencies: { ai?: AI; mail?: MailTransport; now?: () => number } = {}) {
  const ai = dependencies.ai ?? createAI(config);
  const mail = dependencies.mail ?? new AppleMail();
  const now = dependencies.now ?? Date.now;
  const journal = new SendJournal(config.journalDir);
  const contacts = new ContactStore(config.contactsFile ?? resolve(config.journalDir, 'contacts.local.json'), config.contacts);
  const entries = new Map<string, Entry>();
  let processing = 0;
  let requestsInFlight = 0;
  const buckets = new Map<string, { start: number; count: number }>();
  function limit(key: string, max: number) {
    let bucket = buckets.get(key);
    if (!bucket || now() - bucket.start >= 60_000) { bucket = { start: now(), count: 0 }; buckets.set(key, bucket); }
    if (++bucket.count > max) throw new AppError(429, 'Too many requests. Wait a minute before trying again.');
  }
  function cleanup() {
    for (const [id, entry] of entries) {
      if (entry.expiresAt < now() && ['ready', 'error', 'expired'].includes(entry.job.status) && entry.job.send.status !== 'submitting') entries.delete(id);
    }
  }
  function getEntry(rawID: string) {
    const id = uuid.parse(rawID);
    cleanup();
    const entry = entries.get(id);
    if (!entry) throw new AppError(404, 'Request expired or backend restarted. Check Mail before starting another email.');
    return entry;
  }
  function editable(entry: Entry, version: number, allowClarification = false) {
    if (entry.job.status !== 'ready' || (!entry.job.draft && !allowClarification)) throw new AppError(409, 'Draft is not ready.');
    if (entry.job.version !== version) throw new AppError(409, 'The draft changed. Refresh and review the latest version.');
    if (entry.job.send.status !== 'not_sent' || journal.get(entry.job.id)) throw new AppError(409, 'This email already has a send attempt. Check Mail; it cannot be sent again from this job.');
  }
  function applyRecipient(entry: Entry, draft: Job['draft'], text: string, allowBareName = false) {
    const result = resolveRecipient(draft!, text, contacts.list(), allowBareName);
    entry.job.draft = result.draft;
    entry.job.recipientSource = result.recipientSource;
    entry.job.clarification = result.clarification;
    entry.job.contactProposal = result.contactProposal;
    entry.explicitAddress = result.explicitAddress;
  }
  async function draftRequest(entry: Entry, text: string) {
    const job = entry.job;
    job.transcript = text;
    job.draft = undefined; job.contactProposal = undefined; job.error = undefined;
    job.recipientSource = 'needs_address'; entry.explicitAddress = undefined;
    job.clarification = undefined;
    // No inbox/message context API exists. A real thread request is a spoken
    // clarification, never a simulated reply or an implicit new email.
    if (parseRecipientInput(text).replyRequested) {
      job.clarification = replyClarification; job.status = 'ready'; return;
    }
    const result = await ai.draft(text);
    if (result.draft) applyRecipient(entry, draftSchema.parse(result.draft), text);
    else if (result.clarification) job.clarification = result.clarification.slice(0, 300);
    else throw new AppError(422, 'Please say a complete email request.');
    job.status = 'ready';
  }
  function register(id: string, source: 'audio' | 'text', content: Buffer | string): { job: Job; fresh: boolean } {
    cleanup();
    const fingerprint = digest(Buffer.concat([Buffer.from(source + ':'), Buffer.from(content)]));
    const old = entries.get(id);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new AppError(409, 'Request ID already belongs to different content.');
      return { job: old.job, fresh: false };
    }
    if (journal.get(id)) throw new AppError(409, 'This request already has a send attempt. Check its status and Mail; do not upload it as a new request.');
    if (entries.size >= config.maxJobs) throw new AppError(503, 'Demo job store is full. Wait for the one-hour retention window to expire or restart after checking pending sends.');
    if (processing >= 3) throw new AppError(429, 'Three requests are already processing. Wait for one to finish.');
    const job: Job = { id, source, status: 'queued', createdAt: new Date(now()).toISOString(), version: 1, sender: config.sender, send: noSend(), savedToMailbox: false };
    const entry: Entry = { job, fingerprint, expiresAt: now() + config.ttlMs };
    entries.set(id, entry);
    processing++;
    void (async () => {
      try {
        job.status = source === 'audio' ? 'transcribing' : 'drafting';
        const transcript = source === 'audio' ? await ai.transcribe(content as Buffer) : content as string;
        if (!transcript.trim() || transcript.length > 8000) throw new AppError(422, 'No usable speech was detected. Please record again.');
        job.status = 'drafting';
        await draftRequest(entry, transcript);
      } catch (error) { job.status = 'error'; job.error = publicProviderError(error); }
      finally { processing--; }
    })();
    return { job, fresh: true };
  }
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    next();
  });
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'providence' }));
  app.use('/api', (req, res, next) => {
    try {
      limit('all', 800);
      const candidate = req.headers.authorization ?? '';
      const expected = `Bearer ${config.token}`;
      if (Buffer.byteLength(candidate) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))) throw new AppError(401, 'Enter the demo session token from the Mac setup.');
      limit(req.method === 'GET' ? 'reads' : 'writes', req.method === 'GET' ? 600 : 30);
      if (requestsInFlight >= 8) throw new AppError(429, 'Too many concurrent requests.');
      requestsInFlight++;
      res.once('close', () => { requestsInFlight--; });
      next();
    } catch (error) { next(error); }
  });
  app.get('/api/config', (_req, res) => res.json({
    sender: config.sender, sendingEnabled: config.enableSending && !!config.sender,
    textTestEnabled: config.enableText, aiConfigured: !!config.apiKey,
    transport: 'apple-mail', retentionMinutes: config.ttlMs / 60000,
  }));
  app.post('/api/jobs/audio', express.raw({ type: ['audio/mp4', 'audio/x-m4a', 'audio/m4a'], limit: 5 * 1024 * 1024 }), (req, res) => {
    const id = uuid.parse(req.header('X-Request-ID'));
    if (!Buffer.isBuffer(req.body)) throw new AppError(415, 'Send raw .m4a bytes with Content-Type: audio/mp4.');
    if (req.body.length < 16) throw new AppError(400, 'The recording is empty. Record again.');
    if (req.body.toString('ascii', 4, 8) !== 'ftyp') throw new AppError(415, 'Expected an AAC .m4a recording.');
    const result = register(id, 'audio', req.body);
    res.status(result.fresh ? 202 : 200).json(result.job);
  });
  app.use('/api', express.json({ limit: '32kb' }));
  app.post(['/api/jobs/text', '/api/jobs/voice-text'], (req, res) => {
    if (req.path === '/api/jobs/text' && !config.enableText) throw new AppError(404, 'Typed development testing is disabled.');
    const id = uuid.parse(req.header('X-Request-ID'));
    const { text } = z.object({ text: z.string().trim().min(1).max(8000) }).strict().parse(req.body);
    const result = register(id, 'text', text);
    res.status(result.fresh ? 202 : 200).json(result.job);
  });
  app.get('/api/jobs', (_req, res) => { cleanup(); res.json([...entries.values()].map(e => e.job).reverse()); });
  app.get('/api/jobs/:id', (req, res) => {
    const id = uuid.parse(req.params.id);
    cleanup();
    const entry = entries.get(id);
    if (entry) return res.json(entry.job);
    const record = journal.get(id);
    if (record) return res.json({ id, status: 'expired', source: 'audio', version: 1, createdAt: record.updatedAt, sender: config.sender, send: record.state, savedToMailbox: false } satisfies Job);
    throw new AppError(404, 'Request expired or backend restarted. Check Mail before starting another email.');
  });
  app.patch('/api/jobs/:id', (req, res) => {
    const entry = getEntry(req.params.id);
    const body = z.object({ version: z.number().int().positive(), draft: draftSchema }).strict().parse(req.body);
    editable(entry, body.version);
    entry.job.draft = body.draft;
    entry.job.version++;
    entry.job.recipientSource = 'edited';
    entry.job.clarification = undefined; entry.job.contactProposal = undefined;
    entry.explicitAddress = undefined;
    entry.approval = undefined;
    res.json(entry.job);
  });
  app.post('/api/jobs/:id/clarify', async (req, res) => {
    const entry = getEntry(req.params.id);
    const { version, text } = z.object({ version: z.number().int().positive(), text: z.string().trim().min(1).max(8000) }).strict().parse(req.body);
    editable(entry, version, true);
    const input = parseRecipientInput(text);
    const recipientOnly = !!entry.job.draft && !input.hasBody && !input.replyRequested;
    if (!recipientOnly && !input.command) throw new AppError(422, 'Please say a complete request, such as email NAME saying MESSAGE.');
    if (!recipientOnly && processing >= 3) throw new AppError(429, 'Three requests are already processing. Wait for one to finish.');
    // Claim this version before any asynchronous provider work. Concurrent or
    // repeated clarification/approval requests cannot act on the previous draft.
    entry.approval = undefined; entry.job.version++;
    if (recipientOnly) {
      applyRecipient(entry, entry.job.draft, text, true);
      entry.job.transcript = text;
    } else {
      entry.job.status = 'drafting'; processing++;
      try { await draftRequest(entry, text); }
      catch (error) { entry.job.status = 'error'; entry.job.error = publicProviderError(error); }
      finally { processing--; }
    }
    res.json(entry.job);
  });
  app.post('/api/jobs/:id/remember-contact', (req, res) => {
    const entry = getEntry(req.params.id);
    const { version, name } = z.object({ version: z.number().int().positive(), name: contactName }).strict().parse(req.body);
    editable(entry, version);
    if (!entry.explicitAddress || entry.explicitAddress !== entry.job.draft!.recipientEmail || entry.job.clarification) {
      throw new AppError(422, 'First say and review an explicit recipient address for this draft.');
    }
    const contact = contacts.remember({ name, email: entry.explicitAddress });
    res.json({ contact });
  });
  app.delete('/api/jobs/:id', (req, res) => {
    const entry = getEntry(req.params.id);
    if (!['ready', 'error', 'expired'].includes(entry.job.status) || entry.job.send.status === 'submitting') throw new AppError(409, 'Wait for processing to finish before clearing this request.');
    entry.job.transcript = undefined; entry.job.draft = undefined; entry.job.error = undefined;
    entry.job.clarification = undefined; entry.job.contactProposal = undefined; entry.explicitAddress = undefined;
    entry.job.status = 'expired'; entry.approval = undefined;
    res.json({ ok: true });
  });
  app.post('/api/jobs/:id/approval', (req, res) => {
    if (!config.enableSending || !config.sender) throw new AppError(503, 'Sending is disabled. Configure MAIL_SENDER and ENABLE_SENDING on the Mac.');
    const entry = getEntry(req.params.id);
    const { version } = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    editable(entry, version);
    if (entry.job.clarification) throw new AppError(422, 'Answer the spoken clarification before reviewing this email.');
    if (!entry.job.draft!.recipientEmail) throw new AppError(422, 'Set and review an exact recipient email address first.');
    const token = randomBytes(32).toString('hex');
    entry.approval = { token: digest(token), version, expiresAt: now() + 60_000 };
    res.json({ token, version, expiresInSeconds: 60, draft: entry.job.draft, sender: config.sender });
  });
  app.post('/api/jobs/:id/send', async (req, res) => {
    if (!config.enableSending || !config.sender) throw new AppError(503, 'Sending is disabled on the Mac.');
    const entry = getEntry(req.params.id);
    const body = z.object({ version: z.number().int().positive(), approvalToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
    const recorded = journal.get(entry.job.id);
    // A repeated click or a network retry can observe the original outcome,
    // but must never invoke the external mail transport again.
    if (recorded) { entry.job.send = recorded.state; return res.json(entry.job); }
    editable(entry, body.version);
    const approval = entry.approval;
    if (!approval || approval.token !== digest(body.approvalToken) || approval.version !== body.version || approval.expiresAt < now()) throw new AppError(409, 'Send approval expired or changed. Review the email again.');
    if (!entry.job.draft!.recipientEmail) throw new AppError(422, 'Recipient address is required.');
    entry.approval = undefined;
    entry.job.send = { status: 'submitting', message: 'Checking Mail and submitting the reviewed email.' };
    try { await mail.check(config.sender); }
    catch (error) { entry.job.send = noSend(); throw error; }
    try { journal.reserve(entry.job.id, entry.fingerprint); }
    catch (error) { entry.job.send = noSend(); throw error; }
    try {
      const receipt = await mail.send(config.sender, entry.job.draft!);
      entry.job.send = journal.submitted(entry.job.id, receipt);
    } catch {
      // Timeout may mean Mail already sent it. Never retry this side effect.
      entry.job.send = journal.get(entry.job.id)!.state;
    }
    res.json(entry.job);
  });
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'Unknown API route.')));
  app.use(express.static(resolve(backendRoot, 'public'), { etag: false, lastModified: false }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) return res.status(error.status).json({ error: error.message });
    if (error instanceof z.ZodError || error instanceof SyntaxError) return res.status(400).json({ error: 'Invalid request. Check the required fields and request ID.' });
    if ((error as { type?: string })?.type === 'entity.too.large') return res.status(413).json({ error: 'Upload exceeds the 5 MB audio or 32 KB JSON limit.' });
    // Never serialize provider errors, bodies, tokens, or subprocess stderr.
    res.status(500).json({ error: 'Unexpected backend error. Check configuration and try again.' });
  });
  return app;
}
