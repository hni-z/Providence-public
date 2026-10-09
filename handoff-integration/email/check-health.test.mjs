import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkHealth, validateCandidate } from './check-health.mjs';

let server;
let origin;
let behavior = 'healthy';

before(async () => {
  server = http.createServer((request, response) => {
    assert.equal(request.url, '/health');
    if (behavior === 'healthy') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, service: 'providence' }));
    } else if (behavior === 'wrong') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, service: 'different-service' }));
    } else if (behavior === 'redirect') {
      response.writeHead(302, { location: '/elsewhere' });
      response.end();
    } else if (behavior === 'slow') {
      setTimeout(() => response.end(JSON.stringify({ ok: true, service: 'providence' })), 300);
    } else if (behavior === 'slow-trickle') {
      response.writeHead(200, { 'content-type': 'application/json' });
      const interval = setInterval(() => response.write(' '), 20);
      response.on('close', () => clearInterval(interval));
    } else {
      response.writeHead(503);
      response.end('unavailable');
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server.close();
  await once(server, 'close');
});

test('candidate validation requires a clean HTTPS origin and rejects known non-email origins', () => {
  assert.equal(validateCandidate('https://email.example').href, 'https://email.example/health');
  assert.throws(() => validateCandidate('http://email.example'), /HTTPS/);
  assert.throws(() => validateCandidate('https://user:secret@email.example'), /credentials/);
  assert.throws(() => validateCandidate('https://email.example/path'), /origin/);
  assert.throws(() => validateCandidate('https://providence.hani.so'), /not the email backend/);
  assert.throws(() => validateCandidate('https://intervention-tip-oasis-scsi.trycloudflare.com'), /obsolete/);
});

test('CLI rejects credential-bearing input without echoing the credential', () => {
  const script = fileURLToPath(new URL('./check-health.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, 'https://user:private-value@email.example'], { encoding: 'utf8' });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /must not contain credentials/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /private-value/);
});

test('classifies only the exact expected response as reachable healthy', async () => {
  behavior = 'healthy';
  const result = await checkHealth(origin, { allowHttpLoopback: true });
  assert.deepEqual(result, {
    endpoint: `${origin}/health`,
    classification: 'reachable_healthy',
    reason: 'expected_health_contract',
    status: 200,
  });
});

test('classifies bad contract, status and redirects as reachable unhealthy without following', async () => {
  behavior = 'wrong';
  const wrong = await checkHealth(origin, { allowHttpLoopback: true });
  assert.equal(wrong.classification, 'reachable_unhealthy');
  assert.equal(wrong.reason, 'unexpected_health_contract');

  behavior = 'unavailable';
  const unavailable = await checkHealth(origin, { allowHttpLoopback: true });
  assert.equal(unavailable.classification, 'reachable_unhealthy');
  assert.equal(unavailable.reason, 'unexpected_status');
  assert.equal(unavailable.status, 503);

  behavior = 'redirect';
  const redirect = await checkHealth(origin, { allowHttpLoopback: true });
  assert.equal(redirect.classification, 'reachable_unhealthy');
  assert.equal(redirect.reason, 'redirect_rejected');
  assert.equal(redirect.status, 302);
});

test('classifies a bounded timeout as network failure', async () => {
  behavior = 'slow';
  const result = await checkHealth(origin, { allowHttpLoopback: true, timeoutMs: 100 });
  assert.equal(result.classification, 'network_failure');
  assert.equal(result.reason, 'timeout');
});

test('total deadline expires despite a response trickling frequent chunks', async () => {
  behavior = 'slow-trickle';
  const started = Date.now();
  const result = await checkHealth(origin, { allowHttpLoopback: true, timeoutMs: 100 });
  const elapsed = Date.now() - started;
  assert.equal(result.classification, 'network_failure');
  assert.equal(result.reason, 'timeout');
  assert.ok(elapsed >= 80, `deadline fired too early after ${elapsed}ms`);
  assert.ok(elapsed < 250, `deadline was not total wall-clock time: ${elapsed}ms`);
});

test('rejecting a streaming redirect closes its connection', async () => {
  let closed;
  const redirectServer = http.createServer((request, response) => {
    assert.equal(request.url, '/health');
    closed = once(response, 'close', { signal: AbortSignal.timeout(500) });
    response.writeHead(302, { location: '/elsewhere' });
    response.flushHeaders();
    const interval = setInterval(() => response.write(' '), 20);
    response.on('close', () => clearInterval(interval));
  }).listen(0, '127.0.0.1');
  await once(redirectServer, 'listening');
  try {
    const candidate = `http://127.0.0.1:${redirectServer.address().port}`;
    const result = await checkHealth(candidate, { allowHttpLoopback: true, timeoutMs: 100 });
    assert.equal(result.reason, 'redirect_rejected');
    await closed;
  } finally {
    redirectServer.closeAllConnections();
    await new Promise(resolve => redirectServer.close(resolve));
  }
});
