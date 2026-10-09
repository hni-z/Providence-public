#!/usr/bin/env node
/**
 * Read-only deployment check using Node built-ins. Run after building this checkout:
 *   node scripts/verify-live.mjs https://providence.hani.so
 * Optional authenticated capability check (no default credential path):
 *   PROVIDENCE_VERIFY_CONFIG=/private/existing-config.json node scripts/verify-live.mjs https://providence.hani.so
 * The optional JSON must contain clientToken. Tokens, config paths, response bodies,
 * audio and provider errors are never printed. There are no writes or POST requests.
 * Success verifies deployed bytes and HTTP configuration, not physical Quest support.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const KNOWN_MIMES = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav'];
const MAX_AUDIO_BYTES = 524_288;
const PROVIDERS = ['OpenAI', 'ElevenLabs'];
let privateToken = '';

class VerificationFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
function fail(code) { throw new VerificationFailure(code); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function label(value) { return typeof value === 'string' && value.trim().length > 0 && value.length <= 256; }

function canonicalOrigin(argument) {
  let parsed;
  try { parsed = new URL(argument); } catch { fail('invalid_https_origin'); }
  if (typeof argument !== 'string' || !/^https:\/\/[^/?#@\s]+\/?$/i.test(argument)
    || parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname
    || parsed.pathname !== '/' || parsed.search || parsed.hash) fail('invalid_https_origin');
  return parsed.origin;
}

function modulePaths(html) {
  return [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1]).filter((path) => /^\/quest\/assets\/[A-Za-z0-9._-]+\.js$/.test(path));
}

function selfPolicy(header, feature) {
  const entries = (header ?? '').split(',').map((part) => part.trim())
    .filter((part) => new RegExp(`^${feature}\\s*=`, 'i').test(part));
  return entries.length === 1 && new RegExp(`^${feature}\\s*=\\s*\\(\\s*self\\s*\\)$`, 'i').test(entries[0]);
}

async function bytes(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) fail('response_too_large');
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) { await reader.cancel(); fail('response_too_large'); }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

function get(origin, path, authenticated = false) {
  return fetch(`${origin}${path}`, {
    method: 'GET', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    headers: authenticated ? { Authorization: `Bearer ${privateToken}`, Origin: origin, Accept: 'application/json' } : {},
  });
}

function capability(value) {
  const data = object(value) && object(value.transcription) ? value.transcription : undefined;
  if (!data || typeof data.available !== 'boolean' || !PROVIDERS.includes(data.provider)
    || !Number.isSafeInteger(data.maxAudioBytes) || data.maxAudioBytes < 1 || data.maxAudioBytes > MAX_AUDIO_BYTES
    || !Array.isArray(data.mimeTypes) || !data.mimeTypes.length || !data.mimeTypes.every((mime) => KNOWN_MIMES.includes(mime))
    || !Array.isArray(data.devices)) fail('invalid_transcription_schema');
  const ids = new Set();
  const devices = data.devices.map((device) => {
    if (!object(device) || !label(device.id) || !label(device.name) || typeof device.online !== 'boolean'
      || typeof device.configured !== 'boolean' || (device.provider !== undefined && !PROVIDERS.includes(device.provider)) || ids.has(device.id)) fail('invalid_transcription_schema');
    ids.add(device.id);
    return { id: device.id, name: device.name, online: device.online, configured: device.configured,
      ...(device.configured ? { provider: device.provider ?? 'OpenAI' } : {}) };
  });
  return { available: data.available, devices, maxAudioBytes: data.maxAudioBytes, mimeTypes: data.mimeTypes, provider: data.provider };
}

async function verify() {
  if (process.argv.length !== 3) fail('usage_requires_one_https_origin');
  const origin = canonicalOrigin(process.argv[2]);
  const index = { status: null, contentTypeOk: false, noStore: false, microphoneSelf: false, xrSpatialTrackingSelf: false };
  const asset = { expectedPath: null, remotePath: null, status: null, contentTypeOk: false, pathMatch: false, localSha256: null, remoteSha256: null, bytesMatch: false };
  const result = { ok: false, origin, index, asset, checks: { publicAssets: false } };

  try {
    const localHtml = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
    const expectedPaths = modulePaths(localHtml);
    if (expectedPaths.length !== 1) fail('local_quest_bundle_missing_or_ambiguous');
    asset.expectedPath = expectedPaths[0];
    const localAsset = await readFile(new URL(`../dist/${asset.expectedPath.slice('/quest/'.length)}`, import.meta.url));
    asset.localSha256 = sha256(localAsset);

    const response = await get(origin, '/quest/');
    index.status = response.status;
    index.contentTypeOk = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'text/html';
    index.noStore = /(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? '');
    index.microphoneSelf = selfPolicy(response.headers.get('permissions-policy'), 'microphone');
    index.xrSpatialTrackingSelf = selfPolicy(response.headers.get('permissions-policy'), 'xr-spatial-tracking');
    if (response.status === 200 && index.contentTypeOk) {
      const remotePaths = modulePaths((await bytes(response, 1_048_576)).toString('utf8'));
      if (remotePaths.length !== 1) fail('remote_quest_bundle_missing_or_ambiguous');
      asset.remotePath = remotePaths[0];
      asset.pathMatch = asset.expectedPath === asset.remotePath;
      const script = await get(origin, asset.remotePath);
      asset.status = script.status;
      asset.contentTypeOk = ['text/javascript', 'application/javascript'].includes(script.headers.get('content-type')?.split(';')[0].trim().toLowerCase());
      if (script.status === 200) {
        asset.remoteSha256 = sha256(await bytes(script, 8_388_608));
        asset.bytesMatch = asset.localSha256 === asset.remoteSha256;
      } else await script.body?.cancel();
    } else await response.body?.cancel();
    result.checks.publicAssets = index.status === 200 && index.contentTypeOk && index.noStore
      && index.microphoneSelf && index.xrSpatialTrackingSelf && asset.status === 200
      && asset.contentTypeOk && asset.pathMatch && asset.bytesMatch;
    if (!result.checks.publicAssets) result.error = 'deployment_mismatch_or_missing_headers';
  } catch (error) {
    result.error = error instanceof VerificationFailure ? error.code : 'public_asset_read_or_network_failed';
  }

  if (process.env.PROVIDENCE_VERIFY_CONFIG !== undefined) {
    result.transcription = { status: null };
    result.checks.transcriptionSchema = false;
    try {
      if (!process.env.PROVIDENCE_VERIFY_CONFIG) fail('private_config_unreadable_or_invalid');
      let config;
      try { config = JSON.parse(await readFile(process.env.PROVIDENCE_VERIFY_CONFIG, 'utf8')); }
      catch { fail('private_config_unreadable_or_invalid'); }
      if (!object(config) || typeof config.clientToken !== 'string' || !config.clientToken || config.clientToken.length > 4096) fail('private_config_unreadable_or_invalid');
      privateToken = config.clientToken;
      const response = await get(origin, '/v1/transcriptions', true);
      result.transcription.status = response.status;
      if (response.status !== 200) { await response.body?.cancel(); fail('transcription_http_failed'); }
      let value;
      try { value = JSON.parse((await bytes(response, 131_072)).toString('utf8')); }
      catch { fail('invalid_transcription_schema'); }
      result.transcription = { status: response.status, ...capability(value) };
      result.checks.transcriptionSchema = true;
    } catch (error) {
      result.transcriptionError = error instanceof VerificationFailure ? error.code : 'transcription_network_failed';
    }
  }
  result.ok = result.checks.publicAssets && result.checks.transcriptionSchema !== false;
  return result;
}

let result;
try { result = await verify(); }
catch (error) { result = { ok: false, error: error instanceof VerificationFailure ? error.code : 'verification_failed' }; }
let output = JSON.stringify(result);
// Defense in depth if a misconfigured server returns the credential in a name field.
if (privateToken) output = output.split(privateToken).join('[redacted]');
process.stdout.write(`${output}\n`);
process.exitCode = result.ok ? 0 : 1;
