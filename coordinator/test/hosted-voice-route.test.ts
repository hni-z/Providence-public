import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Accounts } from "../src/hosted/accounts.js";
import { Workspaces } from "../src/hosted/workspaces.js";
import { createHostedServer } from "../src/hosted/server.js";
import { parseVoiceConfig } from "../web/src/voice-config.js";
import { configuredTranscriptionRoute, parseTranscriptionAvailability, reconcileTranscriptionAvailability } from "../web/src/destination.js";

test("hosted account voice stays ready without transcription on any registered computer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-hosted-voice-route-"));
  const accounts = new Accounts(join(directory, "accounts.sqlite"), randomBytes(32));
  const account = accounts.create("Synthetic voice account");
  accounts.setKey(account.id, "synthetic-fixture-key-not-a-provider-credential");
  let providerCalls = 0;
  const provider: typeof fetch = async () => { providerCalls++; throw new Error("Readiness must not call a provider"); };
  const workspaces = new Workspaces(directory, "https://providence.example", accounts, undefined, provider);
  try {
    const workspace = await workspaces.get(account.id);
    workspace.app.devices.registered.push({ id: "fixture-computer", name: "Computer without transcription" });
    const get = async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${workspace.port}/v1/${path}`, {
        headers: { Authorization: `Bearer ${workspace.token}` }, signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200); return response.json();
    };
    const [voice, input, registered] = await Promise.all([get("voice"), get("transcriptions"), get("devices")]);
    const config = parseVoiceConfig(voice);
    const availability = parseTranscriptionAvailability(input);
    const devices = (registered as { devices: { id: string; online: boolean }[] }).devices;
    assert.equal(config.deviceId, "providence-voice");
    assert.equal(config.transcriptionConfigured, true);
    assert.ok(!devices.some(device => device.id === config.deviceId), "hosted voice is not an enrolled computer");
    assert.equal(availability.devices.find(device => device.id === "fixture-computer")?.configured, false);
    assert.deepEqual(availability.devices.find(device => device.id === config.deviceId), {
      id: "providence-voice", name: "Providence voice", online: true, configured: true, provider: "OpenAI", source: "hosted",
    });
    for (const currentDevices of [[], devices, devices.map(device => ({ ...device, online: false }))]) {
      const reconciled = reconcileTranscriptionAvailability(availability, currentDevices);
      assert.deepEqual(configuredTranscriptionRoute(config, reconciled), { deviceId: "providence-voice", ready: true });
    }
    assert.equal(providerCalls, 0);
  } finally { await workspaces.stop(); accounts.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("hosted input metadata never promotes missing, unconfigured or offline real-device inputs", () => {
  const input = { available: true, devices: [
    { id: "hosted-input", name: "Hosted", online: true, configured: true, source: "hosted" as const },
    { id: "computer", name: "Computer", online: true, configured: true, source: "device" as const },
    { id: "legacy", name: "Legacy", online: true, configured: true },
  ] };
  const availability = parseTranscriptionAvailability({ transcription: input });
  for (const devices of [[], [{ id: "computer", online: false }, { id: "legacy", online: false }]]) {
    const current = reconcileTranscriptionAvailability(availability, devices);
    for (const deviceId of ["computer", "legacy", "missing"])
      assert.equal(configuredTranscriptionRoute({ deviceId, transcriptionConfigured: true }, current).ready, false);
    assert.equal(configuredTranscriptionRoute({ deviceId: "hosted-input", transcriptionConfigured: false }, current).ready, false);
  }
  const unavailable = { ...availability, devices: availability.devices.map(device => ({ ...device, online: false })) };
  assert.equal(configuredTranscriptionRoute({ deviceId: "hosted-input", transcriptionConfigured: true }, reconcileTranscriptionAvailability(unavailable, [])).ready, false);
  assert.equal(reconcileTranscriptionAvailability(null, []), null);
  assert.throws(() => parseTranscriptionAvailability({ transcription: { ...input, devices: [{ ...input.devices[0], source: "unrecognized" }] } }), /could not be confirmed/);
});

test("missing account key and expired account session remain distinct voice failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-hosted-voice-auth-"));
  const app = createHostedServer({ directory, origin: "https://providence.example", encryptionKey: randomBytes(32) });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const account = app.accounts.create("Synthetic account without a key");
    const token = app.accounts.session(account.id);
    for (const path of ["/v1/voice", "/v1/transcriptions"]) {
      const missing = await fetch(base + path, { headers: { Cookie: `__Host-providence=${token}` }, signal: AbortSignal.timeout(5000) });
      assert.equal(missing.status, 409); assert.match((await missing.json() as { error: string }).error, /API key/);
    }
    app.accounts.logout(token);
    for (const path of ["/v1/voice", "/v1/transcriptions"]) {
      const expired = await fetch(base + path, { headers: { Cookie: `__Host-providence=${token}` }, signal: AbortSignal.timeout(5000) });
      assert.equal(expired.status, 401); assert.match((await expired.json() as { error: string }).error, /Sign in/);
    }
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
