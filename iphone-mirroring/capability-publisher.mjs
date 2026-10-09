const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const CONTROL = /\p{Cc}/u;
const ACTIONS = ["general", "browser", "messaging", "email"];
const TRUSTED_VERIFICATION = "independently_verified";
const TRUSTED_SOURCE = "normal_worker_native_cua";
const OBSERVATION_FLAGS = ["appPresent", "phoneReachable", "authenticated", "identityVerified", "controllable", "executable"];

function validId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function validPhoneName(value) {
  const length = typeof value === "string" ? [...value].length : 0;
  return typeof value === "string" && length >= 1 && length <= 80 &&
    value.trim().length > 0 && !CONTROL.test(value);
}

function validSelection(selection) {
  return selection && typeof selection === "object" && !Array.isArray(selection) &&
    ["deviceId", "chatId", "phoneId"].every((key) => validId(selection[key])) &&
    validPhoneName(selection.phoneName);
}

function validBoundedString(value, maximum = 200) {
  return typeof value === "string" && value.trim().length >= 1 && [...value].length <= maximum && !CONTROL.test(value);
}

function taskFor(tasks, id) {
  if (tasks instanceof Map) return tasks.get(id);
  return tasks && typeof tasks === "object" && !Array.isArray(tasks) ? tasks[id] : undefined;
}

function isoSeconds(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : undefined;
}

function validAcceptance(record, selection, tasks, now) {
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      record.verification !== TRUSTED_VERIFICATION || record.source !== TRUSTED_SOURCE ||
      !validId(record.taskId) || !["deviceId", "chatId", "phoneId"].every((key) => record[key] === selection[key]) ||
      !ACTIONS.includes(record.action) || !validBoundedString(record.scope, 600) ||
      typeof record.observedAt !== "number" || !Number.isFinite(record.observedAt) || record.observedAt > now ||
      record.phoneEffectObserved !== true || record.ownerConfirmedPhone !== true) return false;

  const toolCallIds = [record.preToolCallId, record.inputToolCallId, record.postToolCallId];
  if (!toolCallIds.every((value) => validBoundedString(value))) return false;
  if (new Set(toolCallIds).size !== toolCallIds.length) {
    // A real native call may contain an action followed by its returned fresh
    // observation. Retain that real ID and the operator-inspected operation
    // order rather than forcing extra calls or fabricating separate IDs.
    const steps = [record.preOperationIndex, record.inputOperationIndex, record.postOperationIndex];
    if (!steps.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1000)) return false;
    if (toolCallIds[0] === toolCallIds[2] && toolCallIds[0] !== toolCallIds[1]) return false;
    for (let index = 1; index < 3; index++) {
      if (toolCallIds[index] === toolCallIds[index - 1] && steps[index] <= steps[index - 1]) return false;
    }
  }
  const task = taskFor(tasks, record.taskId);
  const createdAt = task && typeof task === "object" ? isoSeconds(task.createdAt) : undefined;
  return !!task && task.id === record.taskId && task.deviceId === selection.deviceId &&
    task.chatId === selection.chatId && task.status === "completed" && createdAt !== undefined &&
    createdAt <= record.observedAt;
}

function validObservation(observation, selection, now) {
  if (!observation || typeof observation !== "object" || Array.isArray(observation) ||
      observation.verification !== TRUSTED_VERIFICATION || observation.source !== TRUSTED_SOURCE ||
      !["deviceId", "chatId", "phoneId", "phoneName"].every((key) => observation[key] === selection[key]) ||
      !validId(observation.sessionId) ||
      !["observedAt", "expiresAt"].every((key) => typeof observation[key] === "number" && Number.isFinite(observation[key])) ||
      observation.observedAt > now + 5 || observation.expiresAt <= now ||
      observation.expiresAt <= observation.observedAt || observation.expiresAt - observation.observedAt > 60 ||
      now - observation.observedAt > 60 ||
      !OBSERVATION_FLAGS.every((key) => typeof observation[key] === "boolean")) return false;
  return true;
}

/**
 * Derives effective coordinator capability evidence from a host-owned selection,
 * private independently verified acceptance records, and a trusted observation.
 * It performs no I/O and does not mint a timestamp, lease, or permission.
 */
export function deriveMirroringCapability({ selection, acceptanceRecords, observation, tasks, now = Date.now() / 1000 } = {}) {
  if (!validSelection(selection) || !Array.isArray(acceptanceRecords) ||
      typeof now !== "number" || !Number.isFinite(now) || !validObservation(observation, selection, now)) {
    return undefined;
  }
  const supportedActions = ACTIONS.filter((action) =>
    acceptanceRecords.some((record) => record?.action === action && record.observedAt <= observation.observedAt &&
      validAcceptance(record, selection, tasks, now)));
  if (supportedActions.length === 0) return undefined;
  return {
    schemaVersion: 1,
    transport: "apple-iphone-mirroring",
    appBundleId: "com.apple.ScreenContinuity",
    deviceId: selection.deviceId,
    chatId: selection.chatId,
    phoneId: selection.phoneId,
    phoneName: selection.phoneName,
    observedAt: observation.observedAt,
    expiresAt: observation.expiresAt,
    sessionId: observation.sessionId,
    configured: true,
    appPresent: observation.appPresent,
    phoneReachable: observation.phoneReachable,
    authenticated: observation.authenticated,
    identityVerified: observation.identityVerified,
    controllable: observation.controllable,
    effectVerified: true,
    executable: observation.executable,
    supportedActions,
  };
}
