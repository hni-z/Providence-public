#!/usr/bin/env node
// Local rendering only: no SSH, DNS, credentials, installation or service operations.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = 'node deploy/render-gateway.mjs (--hostname <unused-dedicated-host> | --canonical) [--ssh-host providence-server-public] [--remote-port 18787] [--local-port 8787] [--upstream-port 18787] [--output /absolute/private/folder]';
if (process.argv.includes('--help')) { console.log(usage); process.exit(0); }
const args = process.argv.slice(2);
const values = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (key === '--canonical' && !values[key]) { values[key] = true; continue; }
  const value = args[++i];
  if (!['--hostname', '--ssh-host', '--remote-port', '--local-port', '--upstream-port', '--output'].includes(key) || !value || value.startsWith('--') || values[key])
    throw new Error(`Unknown, missing, or repeated option. ${usage}`);
  values[key] = value;
}
const canonical = values['--canonical'] === true;
const hostname = (values['--hostname'] ?? '').toLowerCase();
if (canonical === (hostname !== ''))
  throw new Error(`Render either one dedicated hostname or the canonical pair, which pins its own names. ${usage}`);
// The live canonical and legacy hosts already own :443 here; a second server block
// for either name collides with the deployment this renderer is meant to leave alone.
const protectedNames = ['hani.so', 'www.hani.so', 'providence.hani.so', 'htn.hani.so', 'hxn1.dev', 'www.hxn1.dev', 'valantir.app', 'www.valantir.app', 'empoweredinitiative.ca', 'www.empoweredinitiative.ca'];
if (!canonical) {
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname))
    throw new Error('Provide a dedicated DNS hostname without a scheme, path, port, or wildcard.');
  if (protectedNames.includes(hostname)) throw new Error('That hostname belongs to an existing protected site. Select an unused HTN hostname.');
}
const sshHost = values['--ssh-host'] ?? 'providence-server-public';
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(sshHost)) throw new Error('SSH host must be an existing simple alias in the Mac SSH config.');
const port = (value, fallback) => {
  const input = value ?? String(fallback);
  if (!/^\d{1,5}$/.test(input) || Number(input) < 1024 || Number(input) > 65535) throw new Error('Choose an unprivileged TCP port from 1024 through 65535.');
  return String(Number(input));
};
const remotePort = port(values['--remote-port'], 18787), localPort = port(values['--local-port'], 8787);
const upstreamPort = port(values['--upstream-port'], 18787);  // Oracle's loopback end of the reverse forward.
const directory = resolve(values['--output'] ?? fileURLToPath(new URL('../.providence/deployment', import.meta.url)));
const logDirectory = resolve(directory, 'logs');
mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
const xml = (input) => input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const substitutions = {
  HOSTNAME: hostname, REMOTE_PORT: remotePort, LOCAL_PORT: localPort, UPSTREAM_PORT: upstreamPort,
  SSH_HOST: xml(sshHost), SSH_CONFIG: xml(resolve(homedir(), '.ssh/config')),
  LOG_DIRECTORY: xml(logDirectory),
};
for (const [source, target] of canonical ? [
  ['nginx-canonical.conf.template', 'providence-canonical.conf'],
  ['nginx-htn-redirect.conf.template', 'providence-htn-redirect.conf'],
] : [
  ['nginx-http.conf.template', 'providence-htn.http.conf'],
  ['nginx-https.conf.template', 'providence-htn.https.conf'],
  ['mac-tunnel.plist.template', 'com.providence.htn-tunnel.plist'],
]) {
  const template = readFileSync(new URL(source, import.meta.url), 'utf8');
  const rendered = template.replace(/__([A-Z_]+)__/g, (_, key) => {
    if (!(key in substitutions)) throw new Error(`Unresolved template variable ${key}`);
    return substitutions[key];
  });
  // Refuse to replace reviewed files; use a new output directory for a new revision.
  writeFileSync(resolve(directory, target), rendered, { mode: 0o600, flag: 'wx' });
}
console.log(JSON.stringify({ mode: canonical ? 'canonical' : 'dedicated-hostname', hostname: hostname || null, sshHost,
  remoteBind: `127.0.0.1:${remotePort}`, macTarget: `127.0.0.1:${localPort}`, upstream: `127.0.0.1:${upstreamPort}`,
  directory, status: 'Rendered only. Nothing installed or started.' }, null, 2));
