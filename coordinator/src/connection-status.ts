/** Coordinator-observed transport state, never proof of app permissions or account access. */
export type ConnectionReason = "not_connected" | "connecting" | "ready" | "connection_lost" |
  "heartbeat_timeout" | "ready_timeout" | "runtime_stopped" | "authentication_required" | "configuration_required" |
  "protocol_error" | "disconnected_by_owner" | "coordinator_stopping";
export type ConnectionStatus = {
  state: "online" | "connecting" | "offline" | "action_required";
  reasonCode: ConnectionReason;
  connectedAt?: string;
  lastSeenAt?: string;
  disconnectedAt?: string;
};

export type RuntimeOfflineReason = "runtime_stopped" | "authentication_required" | "configuration_required";
export function runtimeConnectionReason(error: unknown, hints?: unknown): RuntimeOfflineReason {
  // Never expose or persist an arbitrary provider diagnostic through connection metadata.
  const event = hints && typeof hints === "object" && !Array.isArray(hints) ? hints as Record<string, unknown> : {};
  if (event.providerErrorCode === "unauthorized") return "authentication_required";
  if (event.reasonCode === "authentication_required" || event.reasonCode === "configuration_required" || event.reasonCode === "runtime_stopped")
    return event.reasonCode;
  return typeof error === "string" && /unauthorized|authentication[_ ]required|access token could not be refreshed|sign in again|not logged in/i.test(error)
    ? "authentication_required" : "runtime_stopped";
}

export function runtimeOfflineEvent(input: unknown) {
  const event = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const reasonCode = runtimeConnectionReason(event.error, event);
  const error = reasonCode === "authentication_required" ? "Device runtime authentication requires owner attention."
    : reasonCode === "configuration_required" ? "Device runtime configuration requires owner attention."
    : "Device runtime stopped; interrupted work is not replayed.";
  return { type: "runtime.offline", reasonCode, error,
    ...(event.providerErrorCode === "unauthorized" ? { providerErrorCode: "unauthorized" as const } : {}) };
}

export function disconnectedStatus(previous: ConnectionStatus | undefined, reasonCode: ConnectionReason, now: string): ConnectionStatus {
  return {
    ...previous,
    state: ["authentication_required", "configuration_required", "protocol_error", "disconnected_by_owner"].includes(reasonCode) ? "action_required" : "offline",
    reasonCode,
    disconnectedAt: now,
  };
}
