/**
 * MOCK ONLY: isolated browser-interaction fixture, with no coordinator connection,
 * real credentials, device execution, persistence, microphone upload or providers.
 *
 * Run from coordinator/quest after `npm run build`:
 *   npx tsx test/browser-fixture.ts
 * Open http://127.0.0.1:5184/quest/ in Chrome. Both the openly test-only owner key
 * and reusable mock exchange code are `quest-fixture` (not a real login code).
 *
 * GET /test/state reports exact mock submissions/decisions and request counters.
 * POST /test/decision (Bearer quest-fixture, optional {id}) adds an unrelated
 * decision so a browser can verify an existing form retains its draft answer.
 * Restart this process to reset all fixture state. Ctrl-C stops the server.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Approval, Artifact, Chat, Device, Task } from '../src/types';

const HOST = '127.0.0.1';
const PORT = 5184;
const ORIGIN = `http://${HOST}:${PORT}`;
const MOCK_KEY = 'quest-fixture';
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const initialTime = new Date().toISOString();
const artifactBytes = Buffer.from('MOCK QUEST FIXTURE\nThis file is a local test artifact. No computer action was executed.\n', 'utf8');
const artifact: Artifact = {
  id: 'mock-artifact-1', taskId: 'mock-worker-completed', name: 'MOCK-result.txt',
  mime: 'text/plain', size: artifactBytes.byteLength,
  sha256: createHash('sha256').update(artifactBytes).digest('hex'), revision: 1,
};
const devices: Device[] = [
  { id: 'mock-mac', name: 'MOCK MacBook', online: true, platform: 'darwin', hostname: 'MOCK-MAC', connectionState: 'online', capabilities: { files: true } },
  { id: 'mock-windows', name: 'MOCK DemoPC', online: true, platform: 'win32', hostname: 'MOCK-DemoPC', connectionState: 'online', capabilities: { files: true } },
];
const chats: Chat[] = [{ id: 'mock-worker-chat', name: 'MOCK file worker', deviceId: 'mock-windows', online: true }];
const tasks: Task[] = [
  { id: 'mock-master-needs-input', chatId: 'master', deviceId: 'coordinator', status: 'needs_input', prompt: 'MOCK: choose a presentation tone for the test result', text: 'MOCK decision pending. The linked test file is ready.', createdAt: initialTime, updatedAt: initialTime, childTaskIds: ['mock-worker-completed'], workStatus: 'completed' },
  { id: 'mock-worker-completed', chatId: 'mock-worker-chat', deviceId: 'mock-windows', status: 'completed', prompt: 'MOCK: prepare a fixture result file', text: 'MOCK completed worker response. This is fixture data, not physical device execution.', createdAt: initialTime, updatedAt: initialTime, parentTaskId: 'mock-master-needs-input', artifacts: [artifact] },
];
const approvals: Approval[] = [{
  id: 'mock-approval-tone', taskId: 'mock-master-needs-input', deviceId: 'coordinator',
  method: 'item/tool/requestUserInput', status: 'pending',
  details: { questions: [{ id: 'choice', question: 'MOCK: which tone should this test result use?', options: [
    { label: 'Friendly', description: 'MOCK approachable test tone' },
    { label: 'Formal', description: 'MOCK formal test tone' },
  ] }] },
}];
const calls: Record<string, number> = {};
const submissions: { endpoint: string; requestId: string; text: string; taskId: string }[] = [];
const decisions: { id: string; body: Record<string, unknown> }[] = [];
const cancellations: string[] = [];
const downloads: string[] = [];
const requests = new Map<string, { text: string; task: Task }>();
let addedDecisions = 0;

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Providence-Fixture': 'MOCK ONLY' });
  res.end(JSON.stringify(value));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 65_536) throw new Error('MOCK request body is too large');
    chunks.push(bytes);
  }
  const value = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}

const server = createServer(async (req, res) => {
  try {
    // Deliberately loopback-only, with exact-origin browser writes and no CORS.
    if (req.headers.host !== `${HOST}:${PORT}`) return send(res, 403, { error: 'Use the exact MOCK fixture URL' });
    if (req.headers.origin && req.headers.origin !== ORIGIN) return send(res, 403, { error: 'Origin rejected by MOCK fixture' });
    const url = new URL(req.url ?? '/', ORIGIN);
    const path = url.pathname;
    const route = `${req.method} ${path}`;
    calls[route] = (calls[route] ?? 0) + 1;

    if (req.method === 'GET' && path === '/test/state') return send(res, 200, {
      mock: true, calls, submissions, decisions, cancellations, downloads, tasks, approvals,
      artifact: { id: artifact.id, size: artifact.size, sha256: artifact.sha256 },
    });

    if (req.method === 'POST' && path === '/client/exchange') {
      const input = await body(req);
      if (input.code !== MOCK_KEY) return send(res, 401, { error: 'Wrong MOCK fixture code' });
      return send(res, 200, { token: MOCK_KEY, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    }

    if (path.startsWith('/v1/') || path === '/test/decision') {
      if (req.headers.authorization !== `Bearer ${MOCK_KEY}`) return send(res, 401, { error: 'MOCK authorization required' });
    }

    if (req.method === 'POST' && path === '/test/decision') {
      const input = await body(req);
      const id = typeof input.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(input.id) ? input.id : `mock-unrelated-${++addedDecisions}`;
      if (approvals.some((approval) => approval.id === id)) return send(res, 409, { error: 'MOCK decision already exists' });
      const taskId = `${id}-task`, time = new Date().toISOString();
      tasks.push({ id: taskId, chatId: 'mock-worker-chat', deviceId: 'mock-windows', status: 'needs_input', prompt: 'MOCK unrelated decision used to test draft preservation', text: '', createdAt: time, updatedAt: time });
      const approval: Approval = { id, taskId, deviceId: 'mock-windows', status: 'pending', method: 'item/tool/requestUserInput', details: { questions: [{ id: 'note', question: 'MOCK unrelated question: enter any test note.' }] } };
      approvals.push(approval);
      return send(res, 201, approval);
    }

    if (req.method === 'GET' && path === '/v1/transcriptions') return send(res, 200, { transcription: { available: false, devices: devices.map(d => ({ id: d.id, name: d.name, online: d.online, configured: false })), mimeTypes: ['audio/webm','audio/mp4','audio/ogg','audio/wav'], maxAudioBytes: 524288, provider: 'OpenAI' } });
    if (req.method === 'GET' && path === '/v1/devices') return send(res, 200, { devices });
    if (req.method === 'GET' && path === '/v1/chats') return send(res, 200, { chats });
    if (req.method === 'GET' && path === '/v1/tasks') return send(res, 200, { tasks });
    if (req.method === 'GET' && path === '/v1/briefing') return send(res, 200, { devices, tasks, approvals: approvals.filter((approval) => approval.status === 'pending') });

    const content = /^\/v1\/artifacts\/([^/]+)\/content$/.exec(path);
    if (req.method === 'GET' && content) {
      if (content[1] !== artifact.id) return send(res, 404, { error: 'Unknown MOCK artifact' });
      downloads.push(artifact.id);
      res.writeHead(200, { 'Content-Type': artifact.mime, 'Content-Length': artifactBytes.byteLength, 'Content-Disposition': 'attachment; filename="MOCK-result.txt"', 'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox; default-src 'none'", 'X-Providence-Fixture': 'MOCK ONLY' });
      res.end(artifactBytes);
      return;
    }

    const taskRoute = /^\/v1\/tasks\/([^/]+)(\/cancel)?$/.exec(path);
    if (taskRoute) {
      const task = tasks.find((candidate) => candidate.id === decodeURIComponent(taskRoute[1]));
      if (!task) return send(res, 404, { error: 'Unknown MOCK task' });
      if (req.method === 'GET' && !taskRoute[2]) return send(res, 200, task);
      if (req.method === 'POST' && taskRoute[2]) {
        cancellations.push(task.id); task.status = 'cancelled'; task.updatedAt = new Date().toISOString();
        for (const approval of approvals) if (approval.taskId === task.id && approval.status === 'pending') approval.status = 'expired';
        return send(res, 200, { interrupted: true });
      }
    }

    const approvalRoute = /^\/v1\/approvals\/([^/]+)$/.exec(path);
    if (req.method === 'POST' && approvalRoute) {
      const approval = approvals.find((candidate) => candidate.id === decodeURIComponent(approvalRoute[1]));
      if (!approval || approval.status !== 'pending') return send(res, 409, { error: 'MOCK decision is no longer pending' });
      const input = await body(req);
      const answers = input.answers as Record<string, { answers?: unknown }> | undefined;
      for (const question of approval.details.questions ?? []) {
        const values = answers?.[question.id]?.answers;
        if (!Array.isArray(values) || !values.length || values.some((answer) => typeof answer !== 'string' || !answer.trim())) return send(res, 400, { error: 'Answer the exact MOCK question ID' });
        if (question.options?.length && values.some((answer) => !question.options!.some((option) => option.label === answer))) return send(res, 400, { error: 'Choose a supplied MOCK option' });
      }
      decisions.push({ id: approval.id, body: input }); approval.status = 'resolved';
      const task = tasks.find((candidate) => candidate.id === approval.taskId)!;
      task.status = 'completed'; task.text = 'MOCK decision recorded for this exact task. No computer action executed.'; task.updatedAt = new Date().toISOString();
      return send(res, 200, { resolved: true });
    }

    const chatMessage = /^\/v1\/chats\/([^/]+)\/messages$/.exec(path);
    if (req.method === 'POST' && (path === '/v1/messages' || chatMessage)) {
      const chatId = chatMessage ? decodeURIComponent(chatMessage[1]) : 'master';
      if (chatId !== 'master' && !chats.some((chat) => chat.id === chatId)) return send(res, 404, { error: 'Unknown MOCK chat' });
      const input = await body(req);
      if (typeof input.requestId !== 'string' || !input.requestId || typeof input.text !== 'string' || !input.text.trim()) return send(res, 400, { error: 'requestId and text are required' });
      const key = `${path}:${input.requestId}`, existing = requests.get(key);
      if (existing) return send(res, existing.text === input.text ? 202 : 409, existing.text === input.text ? existing.task : { error: 'MOCK request ID conflicts with previous text' });
      const time = new Date().toISOString();
      const task: Task & { requestId: string } = { id: `mock-echo-${submissions.length + 1}`, requestId: input.requestId, chatId, deviceId: chatId === 'master' ? 'coordinator' : 'mock-windows', status: 'completed', prompt: input.text, text: `MOCK ECHO ONLY: ${input.text}`, createdAt: time, updatedAt: time };
      tasks.push(task); requests.set(key, { text: input.text, task });
      submissions.push({ endpoint: path, requestId: input.requestId, text: input.text, taskId: task.id });
      return send(res, 202, task);
    }

    if (req.method === 'GET' && (path === '/quest' || path === '/quest/' || path.startsWith('/quest/assets/'))) {
      const relative = path.startsWith('/quest/assets/') ? decodeURIComponent(path.slice('/quest/'.length)) : 'index.html';
      const file = resolve(dist, relative);
      if (!file.startsWith(resolve(dist) + sep)) return send(res, 404, { error: 'MOCK asset not found' });
      const bytes = await readFile(file);
      const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
      res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Providence-Fixture': 'MOCK ONLY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
      res.end(extname(file) === '.html' ? bytes.toString('utf8').replace('<title>', '<title>MOCK FIXTURE · ') : bytes);
      return;
    }
    return send(res, 404, { error: 'Unknown MOCK fixture route' });
  } catch {
    if (!res.headersSent) send(res, 400, { error: 'MOCK request invalid or built asset unavailable. Run npm run build first.' });
    else res.end();
  }
});

server.requestTimeout = 10_000;
server.headersTimeout = 5_000;
server.listen(PORT, HOST, () => {
  console.log(`MOCK ONLY Quest fixture: ${ORIGIN}/quest/`);
  console.log('Test-only sign-in code / owner key: quest-fixture. No real service or device execution.');
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => process.exit(0)));
