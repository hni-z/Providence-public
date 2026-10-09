/**
 * Validates evidence that the caller has already collected for one paired iPhone.
 * This module is deliberately pure: it neither discovers a device nor grants a
 * capability. Pass the effective, top-level verified capability object here.
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const CONTROL = /\p{Cc}/u;
const ACTIONS = new Set(["general", "browser", "messaging", "email"]);
const FLAGS = [
  ["configured", "notConfigured"],
  ["appPresent", "appMissing"],
  ["phoneReachable", "phoneUnavailable"],
  ["authenticated", "authenticationRequired"],
  ["identityVerified", "wrongTarget"],
  ["controllable", "controlUnavailable"],
  ["effectVerified", "acceptanceRequired"],
  ["executable", "controlUnavailable"],
];

function invalidTarget(target) {
  return !target || typeof target !== "object" || Array.isArray(target) ||
    !["deviceId", "chatId", "phoneId"].every((key) =>
      typeof target[key] === "string" && SAFE_ID.test(target[key])) ||
    typeof target.phoneName !== "string" ||
    [...target.phoneName].length < 1 || [...target.phoneName].length > 80 ||
    target.phoneName.trim().length === 0 || CONTROL.test(target.phoneName);
}

function invalidCapability(capability) {
  return !capability || typeof capability !== "object" || Array.isArray(capability) ||
    capability.schemaVersion !== 1 ||
    capability.transport !== "apple-iphone-mirroring" ||
    capability.appBundleId !== "com.apple.ScreenContinuity" ||
    typeof capability.sessionId !== "string" || !SAFE_ID.test(capability.sessionId);
}

/**
 * @returns {{ready: true, sessionId: string} | {ready: false, code: string}}
 */
export function validateReadiness({ target, capability, action, now = Date.now() / 1000, expectedSessionId } = {}) {
  if (invalidTarget(target)) return { ready: false, code: "invalidEvidence" };
  if (capability == null) return { ready: false, code: "notConfigured" };
  if (invalidCapability(capability) || typeof now !== "number" || !Number.isFinite(now)) {
    return { ready: false, code: "invalidEvidence" };
  }

  if (!["observedAt", "expiresAt"].every((key) =>
    typeof capability[key] === "number" && Number.isFinite(capability[key])) ||
    capability.observedAt > now + 5 || capability.expiresAt <= now ||
    capability.expiresAt <= capability.observedAt ||
    capability.expiresAt - capability.observedAt > 60 || now - capability.observedAt > 60) {
    return { ready: false, code: "staleEvidence" };
  }

  if (["deviceId", "chatId", "phoneId", "phoneName"].some((key) => capability[key] !== target[key])) {
    return { ready: false, code: "wrongTarget" };
  }

  for (const [flag, code] of FLAGS) {
    if (capability[flag] !== true) return { ready: false, code };
  }

  if (!Array.isArray(capability.supportedActions) || capability.supportedActions.length === 0 ||
      !capability.supportedActions.every((item) => typeof item === "string" && ACTIONS.has(item)) ||
      typeof action !== "string" || !ACTIONS.has(action) || !capability.supportedActions.includes(action)) {
    return { ready: false, code: "unsupportedAction" };
  }

  if (expectedSessionId != null && expectedSessionId !== capability.sessionId) {
    return { ready: false, code: "sessionChanged" };
  }

  return { ready: true, sessionId: capability.sessionId };
}
