import { validateReadiness } from "./preflight.mjs";

const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const CONTROL = /\p{Cc}/u;
const ACTIONS = new Set(["general", "browser", "messaging", "email"]);
const ACTIVE = new Set(["queued", "running", "needs_input"]);
const UNCERTAIN_TERMINAL = new Set(["interrupted", "failed", "cancelled"]);
const MAC_PLATFORMS = new Set(["darwin", "macos", "mac", "osx", "os x"]);
const TARGET_KEYS = ["transport", "deviceId", "chatId", "phoneId", "phoneName", "leaseId", "action"];

export class HostRouteError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function validId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function validPhoneName(value) {
  const length = typeof value === "string" ? [...value].length : 0;
  return typeof value === "string" && length >= 1 && length <= 80 &&
    value.trim().length > 0 && !CONTROL.test(value);
}

/** Returns an immutable-by-convention canonical binding; never probes a host. */
export function parseExecutionTarget(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Object.keys(value).length !== TARGET_KEYS.length ||
      !TARGET_KEYS.every((key) => Object.hasOwn(value, key)) ||
      value.transport !== "apple-iphone-mirroring" ||
      !["deviceId", "chatId", "phoneId", "leaseId"].every((key) => validId(value[key])) ||
      !validPhoneName(value.phoneName) || !ACTIONS.has(value.action)) {
    throw new HostRouteError("invalidExecutionTarget");
  }
  return {
    transport: "apple-iphone-mirroring",
    deviceId: value.deviceId,
    chatId: value.chatId,
    phoneId: value.phoneId,
    phoneName: value.phoneName,
    leaseId: value.leaseId,
    action: value.action,
  };
}

export function executionTargetsEqual(left, right) {
  const a = parseExecutionTarget(left);
  const b = parseExecutionTarget(right);
  if (a === undefined || b === undefined) return a === b;
  return TARGET_KEYS.every((key) => a[key] === b[key]);
}

function isMirroringTask(task) {
  if (task.executionTarget === undefined) return false;
  try {
    return parseExecutionTarget(task.executionTarget) !== undefined;
  } catch {
    // A malformed active declaration must not let a second GUI task overlap it.
    return true;
  }
}

function isReserved(task) {
  if (!task || typeof task !== "object") return false;
  if (ACTIVE.has(task.status)) return true;
  if (!UNCERTAIN_TERMINAL.has(task.status) || !isMirroringTask(task)) return false;
  // Coordinator terminal status does not prove the provider/native input stopped.
  // Only a host-owned reconciliation tied to this task and lease releases it.
  const proof = task.executionQuiescence;
  return !(proof?.verification === "independently_verified" && proof?.providerQuiescent === true &&
    proof?.taskId === task.id && validId(proof?.leaseId) && proof.leaseId === task.executionTarget?.leaseId);
}

/** Checks the persisted Providence reservation; callers must guard every start. */
export function assertGUIAvailable({ deviceId, taskId, executionTarget, tasks } = {}) {
  const target = parseExecutionTarget(executionTarget);
  if (!validId(deviceId) || !Array.isArray(tasks)) throw new HostRouteError("invalidEvidence");
  for (const task of tasks) {
    if (!isReserved(task) || task.id === taskId || task.deviceId !== deviceId) continue;
    if (target !== undefined || isMirroringTask(task)) {
      throw new HostRouteError("deviceBusy");
    }
  }
}

function fail(code) {
  throw new HostRouteError(code);
}

/**
 * Admission-only policy. The caller must invoke this while reserving the normal
 * task turn, then re-observe the worker UI before every input.
 */
export function authorizeMirroringDispatch({ executionTarget, device, chat, capability, binding, tasks, taskId, now } = {}) {
  const target = parseExecutionTarget(executionTarget);
  if (target === undefined) {
    assertGUIAvailable({ deviceId: device?.id, taskId, executionTarget: undefined, tasks });
    return undefined;
  }

  if (device?.id !== target.deviceId || chat?.id !== target.chatId || chat?.deviceId !== target.deviceId) {
    fail("wrongTarget");
  }
  if (device.online !== true || typeof device.platform !== "string" ||
      !MAC_PLATFORMS.has(device.platform.toLowerCase())) {
    fail("macUnavailable");
  }
  if (chat.online !== true) fail("chatUnavailable");

  assertGUIAvailable({ deviceId: target.deviceId, taskId, executionTarget: target, tasks });
  // A durable owner-confirmed route permits a normal-worker attempt. It never
  // asserts a connected phone or grants tool permission. Presence is authoritative:
  // invalid configuration cannot silently fall back to old readiness evidence.
  if (binding !== undefined) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
        binding.schemaVersion !== 1 || binding.transport !== "apple-iphone-mirroring" ||
        binding.appBundleId !== "com.apple.ScreenContinuity" || binding.status !== "configured" ||
        binding.requiresLivePreflight !== true || binding.grantsPermission !== false ||
        !validId(binding.bindingEpoch) || !Array.isArray(binding.allowedActions) ||
        binding.allowedActions.length < 1 || binding.allowedActions.length > 4 ||
        !binding.allowedActions.every(action => ACTIONS.has(action)) ||
        new Set(binding.allowedActions).size !== binding.allowedActions.length) fail("invalidEvidence");
    for (const key of ["deviceId", "chatId", "phoneId", "phoneName"]) {
      if (binding[key] !== target[key]) fail("wrongTarget");
    }
    if (binding.bindingEpoch !== target.leaseId) fail("sessionChanged");
    if (!binding.allowedActions.includes(target.action)) fail("unsupportedAction");
    return target;
  }
  const readiness = validateReadiness({
    target: { deviceId: target.deviceId, chatId: target.chatId, phoneId: target.phoneId, phoneName: target.phoneName },
    capability,
    action: target.action,
    now,
    expectedSessionId: target.leaseId,
  });
  if (!readiness.ready) fail(readiness.code);
  return target;
}
