#!/usr/bin/env node

import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

const MAX_BODY_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 5000;
const COORDINATOR_HOST = 'providence.hani.so';
const OBSOLETE_EMAIL_HOST = 'intervention-tip-oasis-scsi.trycloudflare.com';

export function validateCandidate(raw, { allowHttpLoopback = false } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Provide one explicit candidate email HTTPS origin.');
  let url;
  try { url = new URL(raw); }
  catch { throw new Error('Candidate must be a valid absolute URL.'); }

  const loopbackHttp = allowHttpLoopback
    && url.protocol === 'http:'
    && ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) throw new Error('Candidate must use HTTPS.');
  if (url.username || url.password) throw new Error('Candidate must not contain credentials.');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('Candidate must be an origin with no path, query, or fragment.');
  if (url.hostname === COORDINATOR_HOST) throw new Error('The Providence coordinator is not the email backend.');
  if (url.hostname === OBSOLETE_EMAIL_HOST) throw new Error('The known obsolete email tunnel is not a recovery candidate.');
  return new URL('/health', url);
}

function readBounded(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    response.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('response_too_large'));
        response.destroy();
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    response.on('error', reject);
  });
}

export async function checkHealth(rawCandidate, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
    throw new Error('Timeout must be an integer from 100 through 30000 milliseconds.');
  }
  const endpoint = validateCandidate(rawCandidate, options);
  const transport = endpoint.protocol === 'https:' ? https : http;

  return new Promise(resolve => {
    let settled = false;
    let response;
    let deadline;
    const finish = result => {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        resolve({ endpoint: endpoint.href, ...result });
      }
    };
    const request = transport.get(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': 'providence-email-health-check/1' },
    }, async incoming => {
      response = incoming;
      try {
        const status = incoming.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          incoming.destroy();
          finish({ classification: 'reachable_unhealthy', reason: 'redirect_rejected', status });
          return;
        }
        const body = await readBounded(incoming);
        if (status !== 200) {
          finish({ classification: 'reachable_unhealthy', reason: 'unexpected_status', status });
          return;
        }
        let parsed;
        try { parsed = JSON.parse(body); }
        catch {
          finish({ classification: 'reachable_unhealthy', reason: 'invalid_json', status });
          return;
        }
        if (parsed?.ok === true && parsed?.service === 'providence') {
          finish({ classification: 'reachable_healthy', reason: 'expected_health_contract', status });
        } else {
          finish({ classification: 'reachable_unhealthy', reason: 'unexpected_health_contract', status });
        }
      } catch (error) {
        const reason = error instanceof Error && error.message === 'response_too_large'
          ? 'response_too_large'
          : 'response_read_failed';
        finish({ classification: 'reachable_unhealthy', reason, status: incoming.statusCode ?? 0 });
      }
    });
    request.on('error', error => {
      finish({
        classification: 'network_failure',
        reason: error?.code === 'HEALTH_TIMEOUT' ? 'timeout' : 'connection_failed',
      });
    });
    deadline = setTimeout(() => {
      finish({ classification: 'network_failure', reason: 'timeout' });
      const error = Object.assign(new Error('health timeout'), { code: 'HEALTH_TIMEOUT' });
      response?.destroy(error);
      request.destroy(error);
    }, timeoutMs);
  });
}

async function main(argv) {
  const candidate = argv[2];
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (argv.length === 5 && argv[3] === '--timeout-ms') timeoutMs = Number(argv[4]);
  else if (argv.length !== 3) throw new Error('Usage: node check-health.mjs https://email-origin.example [--timeout-ms 5000]');

  const result = await checkHealth(candidate, { timeoutMs });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.classification === 'reachable_healthy' ? 0
    : result.classification === 'reachable_unhealthy' ? 2 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch(error => {
    process.stderr.write(`health-check input error: ${error instanceof Error ? error.message : 'invalid input'}\n`);
    process.exitCode = 64;
  });
}
