import test from "node:test";
import assert from "node:assert/strict";
import { parseAccountSession, parseAccountDevices } from "../web/src/account-data.js";

test("account snapshots require explicit authentication and key state, while older servers remain compatible", () => {
  assert.deepEqual(parseAccountSession({ authenticated: false, hosted: true }), { authenticated: false });
  assert.deepEqual(parseAccountSession({ authenticated: true, name: "Alex", keyConfigured: false, extra: "ignored" }), { authenticated: true, name: "Alex", keyConfigured: false });
  for (const value of [{}, null, [], { authenticated: "true" }, { authenticated: true }, { authenticated: true, name: "Alex" },
    { authenticated: true, name: "Alex", keyConfigured: true, accountDeletionAvailable: true }])
    assert.throws(() => parseAccountSession(value), /could not be read/);
});

test("malformed device data cannot be displayed as an empty account or crash capability rendering", () => {
  assert.deepEqual(parseAccountDevices({ devices: [] }), []);
  const device = { id: "fixture", name: "Computer", online: false };
  assert.deepEqual(parseAccountDevices({ devices: [device] }), [device]);
  for (const value of [{}, { devices: null }, { devices: [null] }, { devices: [{ ...device, name: null }] },
    { devices: [{ ...device, online: "yes" }] }, { devices: [{ ...device, keepAwake: { enabled: true } }] },
    { devices: [{ ...device, connectionStatus: { state: "invalid" } }] },
    { devices: [{ ...device, capabilityEvidence: { desktop: { status: "verified_scoped", scope: {} } } }] }])
    assert.throws(() => parseAccountDevices(value), /could not be checked/);
});
