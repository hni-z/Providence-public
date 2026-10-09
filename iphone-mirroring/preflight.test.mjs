import assert from "node:assert/strict";
import test from "node:test";
import { validateReadiness } from "./preflight.mjs";

const now = 1_000;
const target = { deviceId: "demo-mac", chatId: "chat_123", phoneId: "demo-phone", phoneName: "Demo iPhone" };
const capability = () => ({
  schemaVersion: 1,
  transport: "apple-iphone-mirroring",
  appBundleId: "com.apple.ScreenContinuity",
  ...target,
  observedAt: 990,
  expiresAt: 1_010,
  sessionId: "mirror_123",
  supportedActions: ["general", "messaging"],
  configured: true,
  appPresent: true,
  phoneReachable: true,
  authenticated: true,
  identityVerified: true,
  controllable: true,
  effectVerified: true,
  executable: true,
});

function check(change, expected) {
  const input = { target: { ...target }, capability: capability(), action: "messaging", now };
  change(input);
  assert.deepEqual(validateReadiness(input), expected);
}

test("returns only a safe session id for fresh, exact evidence", () => {
  assert.deepEqual(validateReadiness({ target, capability: capability(), action: "messaging", now }),
    { ready: true, sessionId: "mirror_123" });
});

test("requires each observed readiness flag in order", () => {
  const cases = [
    ["configured", "notConfigured"], ["appPresent", "appMissing"],
    ["phoneReachable", "phoneUnavailable"], ["authenticated", "authenticationRequired"],
    ["identityVerified", "wrongTarget"], ["controllable", "controlUnavailable"],
    ["effectVerified", "acceptanceRequired"], ["executable", "controlUnavailable"],
  ];
  for (const [flag, code] of cases) check((input) => { input.capability[flag] = false; }, { ready: false, code });
  check((input) => { input.capability.configured = "true"; }, { ready: false, code: "notConfigured" });
});

test("rejects absent, malformed, and non-effective evidence", () => {
  assert.deepEqual(validateReadiness({ target, action: "messaging", now }), { ready: false, code: "notConfigured" });
  check((input) => { input.capability.schemaVersion = 2; }, { ready: false, code: "invalidEvidence" });
  check((input) => { input.capability.phoneMirroring = true; input.capability.sessionId = "bad id"; }, { ready: false, code: "invalidEvidence" });
  check((input) => { input.capability.supportedActions = ["messaging", "native-phone"]; }, { ready: false, code: "unsupportedAction" });
  check((input) => { input.target.phoneName = "Demo\nPhone"; }, { ready: false, code: "invalidEvidence" });
  check((input) => { input.target.phoneName = "   "; }, { ready: false, code: "invalidEvidence" });
  assert.deepEqual(validateReadiness({ target, capability: { iphoneMirroring: capability() }, action: "messaging", now }),
    { ready: false, code: "invalidEvidence" });
  assert.deepEqual(validateReadiness({ target, capability: true, action: "messaging", now }),
    { ready: false, code: "invalidEvidence" });
});

test("requires exact target identity", () => {
  for (const key of ["deviceId", "chatId", "phoneId", "phoneName"]) {
    check((input) => { input.capability[key] = `other-${key}`; }, { ready: false, code: "wrongTarget" });
  }
});

test("rejects stale, future, invalid, and overlong observation evidence", () => {
  check((input) => { input.capability.expiresAt = now; }, { ready: false, code: "staleEvidence" });
  check((input) => { input.capability.observedAt = now - 61; }, { ready: false, code: "staleEvidence" });
  check((input) => { input.capability.observedAt = now + 6; }, { ready: false, code: "staleEvidence" });
  check((input) => { input.capability.expiresAt = input.capability.observedAt + 61; }, { ready: false, code: "staleEvidence" });
  check((input) => { input.capability.observedAt = "990"; }, { ready: false, code: "staleEvidence" });
});

test("accepts the documented observation boundaries", () => {
  const evidence = capability();
  evidence.observedAt = now - 60;
  evidence.expiresAt = now;
  assert.deepEqual(validateReadiness({ target, capability: evidence, action: "messaging", now }),
    { ready: false, code: "staleEvidence" });

  evidence.observedAt = now + 5;
  evidence.expiresAt = now + 6;
  assert.deepEqual(validateReadiness({ target, capability: evidence, action: "messaging", now }),
    { ready: true, sessionId: "mirror_123" });
});

test("allows only declared supported actions", () => {
  check((input) => { input.action = "email"; }, { ready: false, code: "unsupportedAction" });
  check((input) => { input.action = "calls"; }, { ready: false, code: "unsupportedAction" });
  check((input) => { input.action = { kind: "messaging" }; }, { ready: false, code: "unsupportedAction" });
});

test("checks the expected session only after readiness and action validation", () => {
  const evidence = capability();
  assert.deepEqual(validateReadiness({ target, capability: evidence, action: "messaging", now, expectedSessionId: "old_session" }),
    { ready: false, code: "sessionChanged" });
  evidence.executable = false;
  assert.deepEqual(validateReadiness({ target, capability: evidence, action: "messaging", now, expectedSessionId: "old_session" }),
    { ready: false, code: "controlUnavailable" });
});

test("does not mutate target or supplied capability evidence", () => {
  const originalTarget = { ...target };
  const evidence = capability();
  const originalEvidence = structuredClone(evidence);
  validateReadiness({ target, capability: evidence, action: "messaging", now });
  assert.deepEqual(target, originalTarget);
  assert.deepEqual(evidence, originalEvidence);
});

test("does not execute capability metadata or inspect device state", () => {
  const evidence = capability();
  Object.defineProperty(evidence, "model", { get() { throw new Error("must not read metadata"); } });
  assert.deepEqual(validateReadiness({ target, capability: evidence, action: "messaging", now }),
    { ready: true, sessionId: "mirror_123" });
});
