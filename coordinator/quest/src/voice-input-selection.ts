/** Public authenticated metadata only. No action-target or browser identity input. */
export interface VoiceInputCapability {
  available: boolean;
  devices: readonly { id: string; name: string; online: boolean; configured: boolean; provider?: string }[];
  provider?: string;
}
export interface VoiceInputRoute {
  deviceId: string;
  transcriptionConfigured: boolean;
  transcriptionProvider?: string;
}
export interface VoiceInputSelection {
  hostId: string;
  ready: boolean;
  label: string;
  reason?: "unavailable" | "missing-host" | "offline" | "unconfigured" | "route-changed" | "provider-mismatch";
  provider?: string;
  browserFallbackAllowed: false;
}

/** The server's approved route is the only route. Captured identities cannot migrate. */
export function selectVoiceInput(
  capability: VoiceInputCapability | undefined,
  route: VoiceInputRoute | undefined,
  capturedHostId?: string,
): VoiceInputSelection {
  const approvedId = route?.deviceId ?? "";
  const hostId = capturedHostId || approvedId;
  const host = capability?.devices.find(device => device.id === hostId);
  const provider = host?.provider ?? (host ? "OpenAI" : undefined);
  const reason: VoiceInputSelection["reason"] = !route || !approvedId || !capability
    ? "unavailable"
    : capturedHostId && capturedHostId !== approvedId ? "route-changed"
    : !route.transcriptionConfigured ? "unconfigured"
    : !host ? "missing-host"
    : !host.online ? "offline"
    : !host.configured ? "unconfigured"
    : !capability.available ? "unavailable"
    : route.transcriptionProvider && provider !== route.transcriptionProvider ? "provider-mismatch"
    : undefined;
  return {
    hostId, ready: reason === undefined,
    label: reason ? "Cloud transcription unavailable" : "Cloud transcription ready",
    ...(reason ? { reason } : {}), ...(provider ? { provider } : {}),
    browserFallbackAllowed: false,
  };
}
