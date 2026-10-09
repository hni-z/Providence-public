import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../backend/src/app.js';
import { validateDraftOutput } from '../backend/src/ai.js';
import type { Config } from '../backend/src/config.js';
import type { Draft } from '../backend/src/contracts.js';

const suite = process.env.PROVIDENCE_ACCEPTANCE_SUITE ?? 'all';
const regression = suite !== 'voice';
const voice = suite !== 'baseline';
const sample: Draft = { recipientName: 'Alex', recipientEmail: 'alex@example.com', subject: 'Prototype', body: 'I can help tomorrow.' };
const provider = (draft: Draft = sample) => ({ clarification: null, draft });
const cases = JSON.parse(readFileSync(new URL('./recipient-cases.json', import.meta.url), 'utf8'));

for (const c of cases) {
  if (!(c.gate === 'voice' ? voice : regression)) continue;
  test(`[${c.gate}] ${c.id} recipient evidence: ${c.text}`, () => {
    const parsed = validateDraftOutput(provider({ ...sample, recipientName: c.name, recipientEmail: c.candidate }), c.text, { contacts: c.contacts ?? [] });
    assert.equal(parsed.draft?.recipientEmail ?? null, c.expected);
  });
}

// Network firewall: the only real HTTP is our own loopback Express server.
// The actual OpenAI SDK/parser receives synthetic Responses JSON in memory.
// The real AppleMail transport is always replaced; configFromEnv is never called.
const nativeFetch = globalThis.fetch;
let output: unknown = provider();
let providerCalls = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === '127.0.0.1') return nativeFetch(input, init);
  if (url.origin === 'https://api.openai.com' && url.pathname === '/v1/responses') {
    providerCalls++;
    return new Response(JSON.stringify({ id: 'resp_synthetic', object: 'response', created_at: 0, status: 'completed', error: null,
      incomplete_details: null, output: [{ id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify(output), annotations: [] }] }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`Acceptance harness blocked external network: ${url.origin}`);
};

async function harness(t: TestContext, opts: { enableText?: boolean; uncertain?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-acceptance-state-'));
  // contactsFile is the requested safe configuration seam; no private path is used.
  const config: Config & { contactsFile: string } = {
    token: 'a'.repeat(64), apiKey: 'synthetic-not-a-provider-key', transcriptionModel: 'unused', draftModel: 'synthetic-model',
    sender: 'sender@example.com', enableSending: true, enableText: opts.enableText ?? true,
    contacts: [], contactsFile: join(dir, 'contacts.local.json'), journalDir: join(dir, 'journal'), maxJobs: 50, ttlMs: 3600000,
  };
  let sends = 0;
  const sent: Draft[] = [];
  const mail = { check: async () => {}, send: async (_sender: string, draft: Draft) => {
    sends++; sent.push(structuredClone(draft));
    if (opts.uncertain) throw new Error('Synthetic acknowledgement lost after submission');
    return 'synthetic-receipt';
  } };
  const servers: ReturnType<ReturnType<typeof createApp>['listen']>[] = [];
  let base = '';
  async function start() {
    const server = createApp({ ...config, contacts: [] }, { mail }).listen(0, '127.0.0.1');
    servers.push(server); await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  t.after(async () => {
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
    rmSync(dir, { recursive: true, force: true });
  });
  await start();
  async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  }
  async function ready(id: string) {
    for (let i = 0; i < 100; i++) {
      const r = await request(`/api/jobs/${id}`);
      assert.equal(r.status, 200);
      if (['ready', 'error'].includes(r.body.status)) return r.body;
      await new Promise(r => setTimeout(r, 5));
    }
    throw new Error('Synthetic job did not settle in 500ms');
  }
  async function create(text = 'Email Alex at alex@example.com saying I can help tomorrow.', endpoint = '/api/jobs/text', candidate = sample) {
    output = provider(candidate);
    const id = randomUUID();
    const r = await request(endpoint, 'POST', { text }, { 'X-Request-ID': id });
    assert.equal(r.status, 202, `${endpoint}: ${JSON.stringify(r.body)}`);
    return ready(id);
  }
  async function approve(job: any) { return request(`/api/jobs/${job.id}/approval`, 'POST', { version: job.version }); }
  async function send(job: any, approval: any) { return request(`/api/jobs/${job.id}/send`, 'POST', { version: approval.version, approvalToken: approval.token }); }
  return { request, ready, create, approve, send, restart: start, config, calls: () => sends, sent };
}

if (regression) {
  test('[regression] R01 replay keeps job ID; changed body conflicts; no email sends', async t => {
    const h = await harness(t); const job = await h.create();
    const calls = providerCalls;
    const r = await h.request('/api/jobs/text', 'POST', { text: job.transcript }, { 'X-Request-ID': job.id });
    assert.equal(r.status, 200); assert.equal(r.body.id, job.id); assert.equal(providerCalls, calls);
    assert.equal((await h.request('/api/jobs/text', 'POST', { text: 'Different request' }, { 'X-Request-ID': job.id })).status, 409);
    assert.equal(h.calls(), 0);
  });
  test('[regression] R02 stale approval and stale edit fail without sends', async t => {
    const h = await harness(t); const job = await h.create(); const approved = await h.approve(job);
    assert.equal(approved.status, 200);
    const r = await h.request(`/api/jobs/${job.id}`, 'PATCH', { version: job.version, draft: { ...job.draft, body: 'Changed body' } });
    assert.equal(r.status, 200); assert.equal(r.body.version, job.version + 1);
    assert.equal((await h.send(job, approved.body)).status, 409);
    assert.equal((await h.request(`/api/jobs/${job.id}`, 'PATCH', { version: job.version, draft: job.draft })).status, 409);
    assert.equal(h.calls(), 0);
  });
  for (const uncertain of [false, true]) test(`[regression] R03 ${uncertain ? 'uncertain' : 'submitted'} send cannot repeat across restart`, async t => {
    const h = await harness(t, { uncertain }); const job = await h.create(); const a = await h.approve(job);
    assert.equal(a.status, 200);
    const expected = uncertain ? 'uncertain' : 'submitted';
    assert.equal((await h.send(job, a.body)).body.send.status, expected);
    assert.equal((await h.send(job, a.body)).body.send.status, expected);
    assert.equal(h.calls(), 1); assert.deepEqual(h.sent, [job.draft]);
    await h.restart();
    assert.equal((await h.request(`/api/jobs/${job.id}`)).body.send.status, expected);
    assert.equal((await h.request('/api/jobs/text', 'POST', { text: job.transcript }, { 'X-Request-ID': job.id })).status, 409);
    const repeat = await h.send(job, a.body);
    assert.ok(repeat.status === 404 || repeat.status === 409 || repeat.body.send?.status === expected);
    assert.equal(h.calls(), 1);
  });
  test('[regression] R04 injected headers rejected before transport', async t => {
    const h = await harness(t); const job = await h.create();
    assert.equal((await h.request(`/api/jobs/${job.id}`, 'PATCH', { version: job.version,
      draft: { ...job.draft, recipientEmail: 'alex@example.com\r\nBcc: other@example.com' } })).status, 400);
    assert.equal(h.calls(), 0);
  });
}

if (voice) {
  test('[voice] V01 production voice-text works with development text disabled; idempotent/authenticated', async t => {
    const h = await harness(t, { enableText: false });
    const job = await h.create(undefined, '/api/jobs/voice-text');
    assert.equal(job.status, 'ready'); assert.equal(job.draft.recipientEmail, 'alex@example.com');
    assert.equal(job.send.status, 'not_sent'); assert.equal(job.savedToMailbox, false);
    const calls = providerCalls;
    assert.equal((await h.request('/api/jobs/voice-text', 'POST', { text: job.transcript }, { 'X-Request-ID': job.id })).status, 200);
    assert.equal(providerCalls, calls);
    assert.equal((await h.request('/api/jobs/voice-text', 'POST', { text: 'Changed' }, { 'X-Request-ID': job.id })).status, 409);
    assert.equal((await h.request('/api/jobs/text', 'POST', { text: 'hi' }, { 'X-Request-ID': randomUUID() })).status, 404);
    assert.equal((await h.request('/api/jobs/voice-text', 'POST', { text: 'hi' }, { Authorization: '' })).status, 401);
    assert.equal(h.calls(), 0);
  });
  test('[voice] V02 unknown name asks concise spoken clarification; clarification increments version', async t => {
    const h = await harness(t); const job = await h.create('Email Alex saying I can help tomorrow.', '/api/jobs/voice-text');
    assert.equal(job.draft.recipientEmail, null); assert.ok(job.clarification?.trim());
    assert.ok(job.clarification.length <= 300); assert.equal((await h.approve(job)).status, 422);
    const r = await h.request(`/api/jobs/${job.id}/clarify`, 'POST', { version: job.version, text: 'alex at example dot com' });
    assert.equal(r.status, 200); assert.equal(r.body.version, job.version + 1);
    assert.equal(r.body.draft.recipientEmail, 'alex@example.com');
    assert.equal(r.body.draft.body, job.draft.body);
    assert.equal(r.body.draft.subject, job.draft.subject);
    assert.equal((await h.request(`/api/jobs/${job.id}/clarify`, 'POST', { version: job.version, text: 'other@example.com' })).status, 409);
    assert.equal(h.calls(), 0);
  });
  test('[voice] V03 clarification invalidates the exact previous send approval', async t => {
    const h = await harness(t); const job = await h.create(); const a = await h.approve(job);
    output = provider({ ...sample, recipientEmail: 'other@example.com' });
    const r = await h.request(`/api/jobs/${job.id}/clarify`, 'POST', { version: job.version, text: 'Change the recipient to other at example dot com' });
    assert.equal(r.status, 200); assert.equal(r.body.version, job.version + 1);
    assert.equal(r.body.draft.recipientEmail, 'other@example.com');
    assert.equal((await h.send(job, a.body)).status, 409); assert.equal(h.calls(), 0);
  });
  test('[voice] V04 confirmed remember persists privately; later name-only resolves after restart', async t => {
    const h = await harness(t); const job = await h.create();
    assert.ok(!existsSync(h.config.contactsFile), 'Draft creation must not silently remember a contact');
    const unconfirmed = await h.create('Email Alex saying hi');
    assert.equal(unconfirmed.draft.recipientEmail, null, 'Unconfirmed proposed name must not resolve');
    const remembered = await h.request(`/api/jobs/${job.id}/remember-contact`, 'POST', { version: job.version, name: 'Alex' });
    assert.equal(remembered.status, 200);
    assert.deepEqual(remembered.body, { contact: { name: 'Alex', email: 'alex@example.com' } });
    assert.equal(statSync(h.config.contactsFile).mode & 0o777, 0o600);
    assert.equal(h.calls(), 0);
    await h.restart();
    const next = await h.create('Email Alex saying I can help tomorrow.', '/api/jobs/voice-text');
    assert.equal(next.draft.recipientEmail, 'alex@example.com'); assert.equal(next.send.status, 'not_sent');
  });
  test('[voice] V05 conflicting remembered name cannot overwrite; stale remember fails', async t => {
    const h = await harness(t); const job = await h.create();
    assert.equal((await h.request(`/api/jobs/${job.id}/remember-contact`, 'POST', { version: job.version, name: 'Alex' })).status, 200);
    const edited = await h.request(`/api/jobs/${job.id}`, 'PATCH', { version: job.version, draft: { ...job.draft, recipientEmail: 'other@example.com' } });
    assert.equal(edited.status, 200);
    assert.equal((await h.request(`/api/jobs/${job.id}/remember-contact`, 'POST', { version: job.version, name: 'Alex' })).status, 409);
    const namedConflict = await h.create('Email Alex at other@example.com saying I can help tomorrow.', '/api/jobs/voice-text', { ...sample, recipientEmail: 'other@example.com' });
    assert.equal(namedConflict.draft.recipientEmail, null);
    assert.ok(namedConflict.clarification?.trim(), 'Conflicting named address needs voice clarification');
    const conflicting = await h.create('Email other@example.com saying I can help tomorrow.', '/api/jobs/voice-text', { ...sample, recipientName: null, recipientEmail: 'other@example.com' });
    assert.equal(conflicting.draft.recipientEmail, 'other@example.com');
    assert.equal((await h.request(`/api/jobs/${conflicting.id}/remember-contact`, 'POST', { version: conflicting.version, name: 'Alex' })).status, 409);
    await h.restart();
    assert.equal((await h.create('Email Alex saying hi', '/api/jobs/voice-text')).draft.recipientEmail, 'alex@example.com');
    assert.equal(h.calls(), 0);
  });
  test('[voice] V06 no remember from unknown recipient; JSON cannot supply an unreviewed email', async t => {
    const h = await harness(t); const job = await h.create('Email Alex saying hi');
    const r = await h.request(`/api/jobs/${job.id}/remember-contact`, 'POST', { version: job.version, name: 'Alex' });
    assert.ok([409, 422].includes(r.status), `Expected unresolved-recipient rejection, got ${r.status}`);
    const explicit = await h.create();
    assert.equal((await h.request(`/api/jobs/${explicit.id}/remember-contact`, 'POST', { version: explicit.version, name: 'Alex', email: 'injected@example.com' })).status, 400);
    assert.equal(h.calls(), 0);
  });
  test('[voice] V07 genuine threaded reply without message context cannot be approved', async t => {
    const h = await harness(t);
    const job = await h.create('Reply to the latest email from Alex at alex@example.com in the same thread saying I can help tomorrow.', '/api/jobs/voice-text');
    // Deliberately overconfident provider fixture: application must retain the context boundary.
    assert.ok(job.clarification?.trim(), 'Ask for real message context or explicit consent to compose a new email');
    assert.notEqual((await h.approve(job)).status, 200);
    assert.equal(h.calls(), 0);
  });
  test('[voice] V08 clarification and remembering require auth and preserve no-send boundary', async t => {
    const h = await harness(t); const job = await h.create();
    for (const [suffix, body] of [
      ['clarify', { version: job.version, text: 'other at example dot com' }],
      ['remember-contact', { version: job.version, name: 'Alex' }],
    ] as const) {
      assert.equal((await h.request(`/api/jobs/${job.id}/${suffix}`, 'POST', body, { Authorization: '' })).status, 401);
    }
    assert.equal((await h.request(`/api/jobs/${job.id}`)).body.version, job.version);
    assert.equal(h.calls(), 0);
  });
  test('[voice] V09 no-draft clarification accepts a complete spoken request; cannot approve or remember beforehand', async t => {
    const h = await harness(t);
    const job = await h.create('Reply to the latest email from Alex in the same thread saying I can help tomorrow.', '/api/jobs/voice-text');
    assert.equal(job.status, 'ready'); assert.ok(job.clarification?.trim());
    assert.equal(job.draft ?? null, null); assert.equal(job.send.status, 'not_sent');
    assert.equal((await h.approve(job)).status, 409);
    assert.equal((await h.request(`/api/jobs/${job.id}/remember-contact`, 'POST', { version: job.version, name: 'Alex' })).status, 409);
    assert.equal((await h.send(job, { version: job.version, token: '0'.repeat(64) })).status, 409);
    assert.equal(h.calls(), 0); assert.ok(!existsSync(h.config.contactsFile));
    const text = 'Email Alex at alex@example.com saying I can help tomorrow.';
    const r = await h.request(`/api/jobs/${job.id}/clarify`, 'POST', { version: job.version, text });
    assert.equal(r.status, 200); assert.equal(r.body.id, job.id); assert.equal(r.body.version, job.version + 1);
    assert.equal(r.body.status, 'ready'); assert.equal(r.body.clarification ?? null, null);
    assert.equal(r.body.draft.recipientEmail, 'alex@example.com'); assert.equal(r.body.draft.body, sample.body);
    assert.equal(r.body.send.status, 'not_sent'); assert.equal(h.calls(), 0);
    assert.equal((await h.request(`/api/jobs/${job.id}/clarify`, 'POST', { version: job.version, text })).status, 409);
    assert.equal((await h.approve(r.body)).status, 200); assert.equal(h.calls(), 0);
  });
}
