#!/usr/bin/env node
// HTTP transport only. This helper never invokes Codex, a host tool, or a queued action.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const [command, jobId, argument] = process.argv.slice(2);
const usage = 'Usage: PROVIDENCE_VERIFY_CONFIG=/private/config.json node scripts/host-bridge-client.mjs list|read JOB_ID|claim JOB_ID CONSUMER_ID|start JOB_ID|complete JOB_ID RESULT_JSON|fail JOB_ID';
try {
  if (!['list','read','claim','start','complete','fail'].includes(command)) throw new Error(usage);
  const file = process.env.PROVIDENCE_VERIFY_CONFIG;
  if (!file) throw new Error('Set PROVIDENCE_VERIFY_CONFIG to the existing private Providence config path.');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof config.clientToken !== 'string' || config.clientToken.length < 32) throw new Error('Invalid private Providence configuration.');
  const origin = new URL(process.env.PROVIDENCE_BRIDGE_ORIGIN ?? 'https://providence.hani.so');
  const canonical = origin.origin === 'https://providence.hani.so';
  const loopback = ['127.0.0.1','localhost','[::1]'].includes(origin.hostname) && origin.protocol === 'http:';
  if ((!canonical && !loopback) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('Only the canonical Providence origin or an explicit loopback test origin is allowed.');
  if (command !== 'list' && (!jobId || !/^[A-Za-z0-9_-]{1,200}$/.test(jobId))) throw new Error('Provide the exact returned job ID.');
  const api = async (path, body) => {
    const response = await fetch(new URL('/v1/host-bridge/jobs' + path, origin), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${config.clientToken}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}. Inspect the job state; do not repeat the host action.`);
    return response.json();
  };
  if (command === 'list') {
    const result = await api('');
    process.stdout.write(JSON.stringify({ jobs: result.jobs.map(({id,probeId,action,status,createdAt}) => ({id,probeId,action,status,createdAt})) }, null, 2) + '\n');
  } else if (command === 'read') {
    process.stdout.write(JSON.stringify(await api('/' + jobId), null, 2) + '\n');
  } else {
    const directory = resolve(dirname(file), 'host-bridge-leases');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const leaseFile = resolve(directory, jobId + '.json');
    const save = value => {
      writeFileSync(leaseFile + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
      renameSync(leaseFile + '.tmp', leaseFile);
    };
    if (command === 'claim') {
      if (!argument || argument.length > 200) throw new Error('Provide a consumer ID for this actual Codex-hosted task.');
      if (existsSync(leaseFile)) throw new Error('A prior local claim record exists. Read the job; do not claim or execute it again.');
      const intent = { jobId, claimId: randomUUID(), consumerId: argument, stage: 'claim-uncertain' };
      writeFileSync(leaseFile, JSON.stringify(intent), { flag: 'wx', mode: 0o600 });
      const result = await api('/' + jobId + '/claim', { claimId: intent.claimId, consumerId: argument });
      if (result.job?.id !== jobId || !['htn-task-inventory', 'mac-chrome-typing-proof'].includes(result.job.action) || typeof result.leaseToken !== 'string')
        throw new Error('Unexpected claim response; do not execute any host action.');
      if (result.job.action === 'mac-chrome-typing-proof') {
        const request = result.job.browserRequest;
        if (!request || request.deviceId !== 'mac' || request.url !== 'https://www.google.com/' || request.field !== 'Search' || request.submit !== false || request.text !== 'Providence Mac control check ' + result.job.probeId)
          throw new Error('Unexpected browser proof scope; do not execute any host action.');
      }
      save({ ...intent, stage: 'claimed', action: result.job.action, probeId: result.job.probeId, leaseToken: result.leaseToken });
      process.stdout.write(JSON.stringify({ job: result.job, privateLeasePath: leaseFile }, null, 2) + '\n');
    } else {
      const lease = JSON.parse(readFileSync(leaseFile, 'utf8'));
      if (lease.jobId !== jobId || typeof lease.leaseToken !== 'string') throw new Error('No usable claim lease. Do not execute the host action.');
      const common = { probeId: lease.probeId, leaseToken: lease.leaseToken };
      if (command === 'start') {
        if (lease.stage !== 'claimed') throw new Error('Start was already attempted. Inspect state; do not repeat the host action.');
        save({ ...lease, stage: 'start-uncertain' });
        const result = await api('/' + jobId + '/start', common);
        save({ ...lease, stage: 'running' });
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else if (command === 'complete') {
        if (!argument || !['running','complete-uncertain','completed'].includes(lease.stage)) throw new Error('Provide the saved result file after one acknowledged start and one host action.');
        const resultData = JSON.parse(readFileSync(argument, 'utf8'));
        if (lease.completion && JSON.stringify(lease.completion.result) !== JSON.stringify(resultData)) throw new Error('Completion differs from the original result. Do not replace or repeat it.');
        const completion = lease.completion ?? { completionId: randomUUID(), result: resultData };
        save({ ...lease, stage: 'complete-uncertain', completion });
        const result = await api('/' + jobId + '/complete', { ...common, ...completion });
        save({ ...lease, stage: 'completed', completion });
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        const result = await api('/' + jobId + '/fail', { ...common, error: 'The host consumer could not perform this permitted fixed-scope job. No retry was attempted.' });
        save({ ...lease, stage: 'failed' });
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      }
    }
  }
} catch (error) {
  // No raw HTTP response, configuration excerpt, or claim lease is emitted.
  process.stderr.write((error instanceof SyntaxError ? 'Invalid local JSON input.' : error?.message ?? 'Host bridge operation failed.') + '\n');
  process.exitCode = 1;
}
