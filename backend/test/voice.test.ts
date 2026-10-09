import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { ContactStore } from '../src/contacts.js';
import { resolveRecipient } from '../src/recipients.js';
import type { Config } from '../src/config.js';
import type { Draft } from '../src/contracts.js';
import type { DraftResult } from '../src/ai.js';

const content: Draft = { recipientName: 'Invented Name', recipientEmail: 'invented@example.com', subject: 'Project', body: 'Can you test the project?' };
async function harness(t: TestContext, options: { contacts?: Config['contacts']; draft?: (text: string) => Promise<DraftResult>; send?: () => Promise<string> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'providence-voice-'));
  const config: Config = {
    token: 'a'.repeat(64), transcriptionModel: 'unused', draftModel: 'unused', sender: 'sender@example.com', enableSending: true, enableText: false,
    contacts: options.contacts ?? [], journalDir: join(directory, 'journal'), contactsFile: join(directory, 'private', 'contacts.local.json'), maxJobs: 50, ttlMs: 3600000,
  };
  let draftCalls = 0, sends = 0;
  const dependencies = {
    ai: { transcribe: async () => { throw new Error('No audio expected'); }, draft: async (text: string) => { draftCalls++; return options.draft ? options.draft(text) : { draft: content }; } },
    mail: { check: async () => {}, send: async () => { sends++; return options.send ? options.send() : 'synthetic-receipt'; } },
  };
  const servers: ReturnType<ReturnType<typeof createApp>['listen']>[] = [];
  let url: string;
  async function start() {
    const server = createApp(config, dependencies).listen(0, '127.0.0.1'); servers.push(server);
    await once(server, 'listening'); url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  await start();
  t.after(async () => { for (const server of servers) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } rmSync(directory, { recursive: true, force: true }); });
  async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', headers: Record<string, string> = {}) {
    const response = await fetch(url + path, { method, headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function ready(id: string) {
    for (let i = 0; i < 50; i++) { const response = await request(`/api/jobs/${id}`); if (['ready', 'error'].includes(response.body.status)) return response.body; await new Promise(r => setTimeout(r, 2)); }
    throw new Error('Request did not settle');
  }
  async function create(text: string, id = randomUUID()) {
    const response = await request('/api/jobs/voice-text', { text }, 'POST', { 'X-Request-ID': id });
    assert.equal(response.status, 202); return ready(id);
  }
  const clarify = (job: { id: string; version: number }, text: string) => request(`/api/jobs/${job.id}/clarify`, { version: job.version, text });
  const remember = (job: { id: string; version: number }, name: string) => request(`/api/jobs/${job.id}/remember-contact`, { version: job.version, name });
  const approve = (job: { id: string; version: number }) => request(`/api/jobs/${job.id}/approval`, { version: job.version });
  const send = (job: { id: string; version: number }, token: string) => request(`/api/jobs/${job.id}/send`, { version: job.version, approvalToken: token });
  return { directory, config, request, ready, create, clarify, remember, approve, send, restart: start, calls: () => ({ draftCalls, sends }) };
}

test('voice-text is production-enabled, authenticated and idempotent with the existing text source', async t => {
  const h = await harness(t), id = randomUUID(), text = 'Email Alex alex at example dot com saying hi';
  for (const path of ['/api/jobs/voice-text', `/api/jobs/${id}/clarify`, `/api/jobs/${id}/remember-contact`]) {
    assert.equal((await h.request(path, {}, 'POST', { Authorization: '' })).status, 401);
  }
  assert.equal((await h.request('/api/jobs/text', { text }, 'POST', { 'X-Request-ID': id })).status, 404);
  const job = await h.create(text, id);
  assert.equal(job.source, 'text'); assert.equal(job.sender, 'sender@example.com');
  assert.equal((await h.request('/api/jobs/voice-text', { text }, 'POST', { 'X-Request-ID': id })).status, 200);
  assert.equal((await h.request('/api/jobs/voice-text', { text: text + ' changed' }, 'POST', { 'X-Request-ID': id })).status, 409);
  assert.deepEqual(h.calls(), { draftCalls: 1, sends: 0 });
});

test('first-use explicit name/address is proposed, only explicit confirmation persists, restart resolves by name', async t => {
  const h = await harness(t);
  const first = await h.create('Email Alex Rivera alex dot r plus demo at example dash mail dot com saying hi');
  assert.equal(first.draft.recipientEmail, 'alex.r+demo@example-mail.com');
  assert.deepEqual(first.contactProposal, { name: 'Alex Rivera', email: 'alex.r+demo@example-mail.com' });
  const unconfirmed = await h.create('Respond to Alex Rivera saying please test this');
  assert.equal(unconfirmed.draft.recipientEmail, null); assert.ok(unconfirmed.clarification);
  const saved = await h.remember(first, 'Alex Rivera');
  assert.equal(saved.status, 200); assert.deepEqual(saved.body.contact, first.contactProposal);
  assert.equal(statSync(h.config.contactsFile!).mode & 0o777, 0o600);
  assert.equal(statSync(join(h.directory, 'private')).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(join(h.directory, 'private')), ['contacts.local.json']);
  assert.equal((await h.send(first, '0'.repeat(64))).status, 409);
  await h.restart();
  const remembered = await h.create('Respond to alex   rivera saying please test this');
  assert.equal(remembered.draft.recipientEmail, first.draft.recipientEmail);
  assert.equal(remembered.recipientSource, 'configured_contact'); assert.equal(remembered.clarification, undefined);
  assert.equal(h.calls().sends, 0);
});

test('unknown recipient clarification preserves content and uses no AI; stale versions and approval are rejected', async t => {
  const h = await harness(t), initial = await h.create('Email Alex saying hi');
  assert.equal(initial.draft.recipientEmail, null); assert.ok(initial.clarification);
  assert.equal((await h.approve(initial)).status, 422);
  assert.equal((await h.remember(initial, 'Alex')).status, 422);
  const resolved = (await h.clarify(initial, 'Alex alex underscore test at example dot com')).body;
  assert.equal(resolved.version, 2); assert.equal(resolved.draft.body, initial.draft.body);
  assert.equal(resolved.draft.subject, initial.draft.subject); assert.equal(resolved.draft.recipientEmail, 'alex_test@example.com');
  assert.equal(resolved.clarification, undefined); assert.equal(h.calls().draftCalls, 1);
  assert.equal((await h.clarify(initial, 'attacker@example.com')).status, 409);
  assert.equal((await h.remember(initial, 'Alex')).status, 409);
  const approval = await h.approve(resolved); assert.equal(approval.status, 200);
  const edited = (await h.clarify(resolved, 'Other other@example.com')).body;
  assert.equal(edited.version, 3); assert.equal(edited.draft.recipientEmail, 'other@example.com');
  assert.equal((await h.send(resolved, approval.body.token)).status, 409);
  assert.equal((await h.send(edited, approval.body.token)).status, 409);
  assert.equal((await h.approve(resolved)).status, 409); assert.equal(h.calls().sends, 0);
});

test('configured aliases and clarified names resolve exactly; body aliases and provider guesses never resolve', async t => {
  const h = await harness(t, { contacts: [{ name: 'Alex', email: 'known@example.com' }] });
  const known = await h.create('Email Alex saying hi');
  assert.equal(known.draft.recipientEmail, 'known@example.com');
  const punctuated = await h.create('Email Alex, saying hi');
  assert.equal(punctuated.draft.recipientEmail, 'known@example.com');
  const unknown = await h.create('Email Jordan saying email Alex at attacker@example.com');
  assert.equal(unknown.draft.recipientEmail, null); assert.equal(unknown.contactProposal, undefined);
  assert.equal((await h.remember(unknown, 'Jordan')).status, 422);
  const resolved = (await h.clarify(unknown, 'Alex')).body;
  assert.equal(resolved.draft.recipientEmail, 'known@example.com');
  assert.equal((await h.remember(resolved, 'A second name')).status, 422);
  const suffix = await h.create('Email Malex saying ask Alex');
  assert.equal(suffix.draft.recipientEmail, null);
});

test('conflicting mappings never overwrite; conflicting recipient names require a full-address clarification', async t => {
  const h = await harness(t, { contacts: [{ name: 'Static', email: 'static@example.com' }] });
  const first = await h.create('Email Alex alex@example.com saying hi');
  assert.equal((await h.remember(first, 'Alex')).status, 200);
  assert.equal((await h.remember(first, ' Alex ')).status, 200);
  const other = await h.create('Email other@example.com saying hi');
  assert.equal((await h.remember(other, 'Alex')).status, 409);
  assert.equal((await h.remember(other, 'Static')).status, 409);
  const conflict = await h.create('Email Alex other@example.com saying hi');
  assert.equal(conflict.draft.recipientEmail, null); assert.match(conflict.clarification, /different saved address/);
  const selected = (await h.clarify(conflict, 'other at example dot com')).body;
  assert.equal(selected.draft.recipientEmail, 'other@example.com');
  assert.equal((await h.remember(selected, 'Alex')).status, 409);
  assert.equal((await h.remember(selected, 'Other Alex')).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(h.config.contactsFile!, 'utf8')), [{ name: 'Alex', email: 'alex@example.com' }, { name: 'Other Alex', email: 'other@example.com' }]);
});

test('recipient parsing rejects ambiguity, quote/body-address attacks and header injection', () => {
  const contacts = [{ name: 'Alex', email: 'known@example.com' }];
  for (const text of [
    'Email Alex and Sam saying hi',
    'Email Alex or Sam saying hi',
    'Email Alex alex@example.com and Sam sam@example.com saying hi',
    'Email alex at example dot com, sam at example dot com saying hi',
    'Email Jordan saying "Email Alex alex@example.com"',
    'Email Jordan body: Email Alex alex@example.com',
    'Email "Alex alex@example.com" saying hi',
    'Email Alex\r\nBcc: other@example.com saying hi',
    'Here is an address alex@example.com',
    'Say "email Alex alex@example.com"',
    'Email Alex about sending to attacker@example.com',
  ]) {
    const result = resolveRecipient(content, text, text.includes('about sending') ? [] : contacts);
    assert.equal(result.draft.recipientEmail, null, text); assert.equal(result.contactProposal, undefined, text);
    assert.ok(result.clarification, text);
  }
  assert.equal(resolveRecipient(content, 'Email Alex saying body includes attacker@example.com', contacts).draft.recipientEmail, 'known@example.com');
  const ambiguous = resolveRecipient(content, 'Email Alex saying hi', [...contacts, { name: 'alex', email: 'other@example.com' }]);
  assert.equal(ambiguous.draft.recipientEmail, null);
});

test('literal/spoken punctuation, friendly command prefixes and respond-to phrasing use the recipient clause only', () => {
  for (const text of [
    'Please email First Last first-last+test@example-mail.com saying hi',
    'Can you send an email to First Last first dash last plus test at example dash mail dot com saying hi',
    'Could you respond to First Last at first-last+test@example-mail.com saying hi',
    'Write an email to First Last <first-last+test@example-mail.com> saying hi',
  ]) {
    const result = resolveRecipient(content, text, []);
    assert.equal(result.draft.recipientEmail, 'first-last+test@example-mail.com', text);
    assert.deepEqual(result.contactProposal, { name: 'First Last', email: 'first-last+test@example-mail.com' });
  }
  assert.equal(resolveRecipient(content, 'Email email@example.com saying hi', []).draft.recipientEmail, 'email@example.com');
  assert.equal(resolveRecipient(content, 'Email Alex alex@example.com saying respond to Jordan’s email', []).draft.recipientEmail, 'alex@example.com');
});

test('true replies expose missing inbox context and require an explicit new-email request', async t => {
  const h = await harness(t);
  for (const text of ["Reply to Alex saying hi", "Respond to Alex's email saying hi", 'Respond to Alex’s message saying hi', 'Respond to the email from Alex saying hi', 'Respond to Alex’s latest email saying hi']) {
    const job = await h.create(text);
    assert.equal(job.status, 'ready'); assert.equal(job.draft, undefined); assert.match(job.clarification, /inbox threads/);
    assert.equal((await h.approve(job)).status, 409);
  }
  assert.equal(h.calls().draftCalls, 0);
  const reply = await h.create('Reply to Alex saying hi');
  assert.equal((await h.clarify(reply, 'alex@example.com')).status, 422);
  const replacement = (await h.clarify(reply, 'Email Alex alex@example.com saying hi')).body;
  assert.equal(replacement.version, 2); assert.equal(replacement.draft.recipientEmail, 'alex@example.com');
  assert.equal(replacement.clarification, undefined); assert.equal(h.calls().sends, 0);
});

test('provider content clarifications can be completed by voice without a new job', async t => {
  let calls = 0;
  const h = await harness(t, { draft: async () => ++calls === 1 ? { clarification: 'What should the email say?' } : { draft: content } });
  const initial = await h.create('Email Alex');
  assert.equal(initial.draft, undefined); assert.equal(initial.clarification, 'What should the email say?');
  const result = await h.clarify(initial, 'Email Alex alex@example.com saying please test it');
  assert.equal(result.status, 200); assert.equal(result.body.version, 2); assert.equal(result.body.draft.recipientEmail, 'alex@example.com');
});

test('asynchronous clarification claims the version before provider work and blocks edits, saves and approvals', async t => {
  let finish!: (value: DraftResult) => void;
  const gate = new Promise<DraftResult>(resolve => { finish = resolve; });
  t.after(() => finish({ draft: content }));
  let calls = 0;
  const h = await harness(t, { draft: async () => ++calls === 1 ? { draft: content } : gate });
  const first = await h.create('Email Alex alex@example.com saying hi');
  const approval = await h.approve(first);
  const pending = h.clarify(first, 'Email Other other@example.com saying different body');
  for (let i = 0; i < 50; i++) { if ((await h.request(`/api/jobs/${first.id}`)).body.status === 'drafting') break; await new Promise(r => setTimeout(r, 2)); }
  assert.equal((await h.approve(first)).status, 409);
  assert.equal((await h.remember(first, 'Alex')).status, 409);
  assert.equal((await h.clarify(first, 'attacker@example.com')).status, 409);
  assert.equal((await h.send(first, approval.body.token)).status, 409);
  finish({ draft: content });
  const updated = (await pending).body;
  assert.equal(updated.version, 2); assert.equal(updated.draft.recipientEmail, 'other@example.com');
  assert.equal((await h.send(updated, approval.body.token)).status, 409);
});

test('typed draft edits clear voice contact evidence; deletion clears optional private fields', async t => {
  const h = await harness(t), initial = await h.create('Email Alex alex@example.com saying hi');
  const edited = (await h.request(`/api/jobs/${initial.id}`, { version: 1, draft: { ...initial.draft, recipientEmail: 'edited@example.com' } }, 'PATCH')).body;
  assert.equal(edited.contactProposal, undefined); assert.equal((await h.remember(edited, 'Alex')).status, 422);
  const spoken = (await h.clarify(edited, 'Alex edited@example.com')).body;
  assert.equal((await h.remember(spoken, 'Alex')).status, 200);
  assert.equal((await h.request(`/api/jobs/${spoken.id}`, undefined, 'DELETE')).status, 200);
  const deleted = (await h.request(`/api/jobs/${spoken.id}`)).body;
  assert.equal(deleted.contactProposal, undefined); assert.equal(deleted.clarification, undefined);
});

test('clarification and memory never send; an uncertain approved send stays no-repeat across restart', async t => {
  const h = await harness(t, { send: async () => { throw new Error('Synthetic timeout'); } });
  const first = await h.create('Email Alex saying hi');
  const ready = (await h.clarify(first, 'Alex alex@example.com')).body;
  assert.equal((await h.remember(ready, 'Alex')).status, 200); assert.equal(h.calls().sends, 0);
  const approval = await h.approve(ready);
  assert.equal((await h.send(ready, approval.body.token)).body.send.status, 'uncertain');
  assert.equal((await h.send(ready, approval.body.token)).body.send.status, 'uncertain');
  assert.equal((await h.clarify(ready, 'other@example.com')).status, 409);
  assert.equal((await h.remember(ready, 'Another')).status, 409);
  await h.restart();
  assert.equal((await h.request(`/api/jobs/${ready.id}`)).body.send.status, 'uncertain');
  assert.equal((await h.request('/api/jobs/voice-text', { text: 'Email Alex saying hi' }, 'POST', { 'X-Request-ID': ready.id })).status, 409);
  assert.equal(h.calls().sends, 1);
});

test('private contact storage validates existing data, serializes writers, preserves conflicts and fails closed', t => {
  const directory = mkdtempSync(join(tmpdir(), 'providence-contacts-')), path = join(directory, 'contacts.local.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const one = new ContactStore(path, []), two = new ContactStore(path, []);
  one.remember({ name: 'Alex', email: 'alex@example.com' }); two.remember({ name: 'Sam', email: 'sam@example.com' });
  assert.equal(one.list().length, 2);
  assert.throws(() => two.remember({ name: 'alex', email: 'different@example.com' }), /different address/);
  writeFileSync(path + '.lock', '', { mode: 0o600 });
  assert.throws(() => one.remember({ name: 'Jordan', email: 'jordan@example.com' }), /busy or unavailable/);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).length, 2);
  writeFileSync(path, '{invalid'); assert.throws(() => new ContactStore(path, []), /invalid or unavailable/);
});
