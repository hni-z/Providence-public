import type { Device } from "./types.js";

export type AccountState = { authenticated: boolean; name?: string; keyConfigured?: boolean; accountId?: string; accountDeletionAvailable?: boolean; aiConsentRequired?: boolean; aiConsentVersion?: string | null };
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const optionalText = (value: unknown) => value === undefined || typeof value === "string";

/** A malformed success must not masquerade as a signed-out or empty account. */
export function parseAccountSession(value: unknown): AccountState {
  if (!record(value) || typeof value.authenticated !== "boolean") throw new Error("Your account details could not be read. Refresh to try again.");
  if (!value.authenticated) return { authenticated: false };
  if (typeof value.name !== "string" || !value.name.trim() || typeof value.keyConfigured !== "boolean" ||
      (value.accountId !== undefined && (typeof value.accountId !== "string" || !/^[0-9a-f-]{36}$/.test(value.accountId))) ||
      (value.accountDeletionAvailable !== undefined && typeof value.accountDeletionAvailable !== "boolean") ||
      (value.aiConsentRequired !== undefined && typeof value.aiConsentRequired !== "boolean") ||
      (value.aiConsentVersion !== undefined && value.aiConsentVersion !== null && typeof value.aiConsentVersion !== "string") ||
      (value.accountDeletionAvailable === true && !value.accountId)) throw new Error("Your account details could not be read. Refresh to try again.");
  return { authenticated: true, name: value.name, keyConfigured: value.keyConfigured,
    ...(value.accountId === undefined ? {} : { accountId: value.accountId }),
    ...(value.accountDeletionAvailable === undefined ? {} : { accountDeletionAvailable: value.accountDeletionAvailable }),
    ...(value.aiConsentRequired === undefined ? {} : { aiConsentRequired: value.aiConsentRequired }),
    ...(value.aiConsentVersion === undefined ? {} : { aiConsentVersion: value.aiConsentVersion }) };
}
export function parseAccountDevices(value: unknown): Device[] {
  if (!record(value) || !Array.isArray(value.devices) || !value.devices.every((device: unknown) => {
    if (!record(device) || typeof device.id !== "string" || !device.id || typeof device.name !== "string" || !device.name ||
        typeof device.online !== "boolean" || !optionalText(device.platform) ||
        (device.workerAccess !== undefined && !["workspace", "full-access"].includes(device.workerAccess))) return false;
    if (device.connectionStatus !== undefined && (!record(device.connectionStatus) ||
        !["online", "connecting", "offline", "action_required"].includes(device.connectionStatus.state) || !optionalText(device.connectionStatus.reasonCode))) return false;
    if (device.keepAwake !== undefined && (!record(device.keepAwake) || typeof device.keepAwake.enabled !== "boolean" ||
        typeof device.keepAwake.active !== "boolean" || !optionalText(device.keepAwake.reason) || !optionalText(device.keepAwake.method))) return false;
    if (device.capabilityEvidence !== undefined) {
      if (!record(device.capabilityEvidence)) return false;
      for (const tool of ["browser", "desktop"]) {
        const evidence = device.capabilityEvidence[tool];
        if (evidence !== undefined && (!record(evidence) || !["verified_scoped", "not_verified"].includes(evidence.status) || !optionalText(evidence.scope))) return false;
      }
    }
    return true;
  })) throw new Error("Your computers could not be checked. Refresh to try again.");
  return value.devices as Device[];
}
