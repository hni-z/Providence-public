const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const CONTROL = /\p{Cc}/u;
const ACTIONS = new Set(["general", "browser", "messaging", "email"]);
const KEYS = ["verification", "enabled", "deviceId", "chatId", "phoneId", "phoneName", "epoch", "allowedActions", "confirmedAt"];

function validID(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function validPhoneName(value) {
  const length = typeof value === "string" ? [...value].length : 0;
  return typeof value === "string" && length >= 1 && length <= 80 && value.trim().length > 0 && !CONTROL.test(value);
}

/**
 * Converts one operator-confirmed routing binding into the public routing
 * configuration. This does not prove a live phone, grant permission, or make
 * an action ready; the normal worker must preflight the actual phone before
 * every input.
 */
export function deriveMirroringBinding(documentBinding, deviceId, nowSeconds = Date.now() / 1000) {
  if (!documentBinding || typeof documentBinding !== "object" || Array.isArray(documentBinding) ||
      Object.keys(documentBinding).length !== KEYS.length || !KEYS.every(key => Object.hasOwn(documentBinding, key)) ||
      documentBinding.verification !== "owner_confirmed_pairing" || documentBinding.enabled !== true ||
      !validID(deviceId) || documentBinding.deviceId !== deviceId ||
      !["deviceId", "chatId", "phoneId", "epoch"].every(key => validID(documentBinding[key])) ||
      !validPhoneName(documentBinding.phoneName) || !Array.isArray(documentBinding.allowedActions) ||
      documentBinding.allowedActions.length < 1 || documentBinding.allowedActions.length > 4 ||
      !documentBinding.allowedActions.every(action => typeof action === "string" && ACTIONS.has(action)) ||
      new Set(documentBinding.allowedActions).size !== documentBinding.allowedActions.length ||
      typeof documentBinding.confirmedAt !== "number" || !Number.isFinite(documentBinding.confirmedAt) ||
      typeof nowSeconds !== "number" || !Number.isFinite(nowSeconds) || documentBinding.confirmedAt > nowSeconds + 5) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    transport: "apple-iphone-mirroring",
    appBundleId: "com.apple.ScreenContinuity",
    status: "configured",
    deviceId: documentBinding.deviceId,
    chatId: documentBinding.chatId,
    phoneId: documentBinding.phoneId,
    phoneName: documentBinding.phoneName,
    bindingEpoch: documentBinding.epoch,
    allowedActions: [...documentBinding.allowedActions],
    requiresLivePreflight: true,
    grantsPermission: false,
  };
}
