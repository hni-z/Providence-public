import type { Chat, Device } from "./types.js";

export function deviceConnectionLabel(device: Device | undefined, fresh: boolean) {
  if (!fresh) return "Status unavailable";
  if (!device) return "Device unavailable";
  if (device.online) return "Connected";
  if (device.connectionStatus?.state === "connecting") return "Connecting";
  if (device.connectionStatus?.state === "action_required") return "Needs attention";
  return "Offline";
}

export function deviceConnectionDetail(device: Device | undefined, fresh: boolean): string | undefined {
  if (!fresh || !device || device.online) return undefined;
  if (device.connectionStatus?.reasonCode === "authentication_required")
    return "Sign in to Codex on this computer, then reconnect Providence.";
  if (device.connectionStatus?.reasonCode === "protocol_error")
    return "Check Providence on this computer before reconnecting.";
  if (device.connectionStatus?.reasonCode === "disconnected_by_owner")
    return "This computer was disconnected. Reconnect it when you are ready.";
  return undefined;
}

export function destinationIssue(selected: string, chats: Chat[], devices: Device[], connected: boolean): string | undefined {
  if (!connected) return "Connection unavailable. Your destination is kept; reconnect before sending.";
  if (selected === "master") return undefined;
  const chat = chats.find((value) => value.id === selected);
  if (!chat) return "This conversation is unavailable. Choose a conversation before sending.";
  const device = devices.find((value) => value.id === chat.deviceId);
  if (!device) return "This conversation’s computer is unavailable. Choose another conversation or restore this computer.";
  if (device.online) return undefined;
  if (device.connectionStatus?.state === "connecting") return `${device.name} is connecting. This conversation stays selected.`;
  if (device.connectionStatus?.state === "action_required") return `${device.name} needs attention. ${deviceConnectionDetail(device, true) ?? "Check this computer’s connection before sending."} This conversation stays selected.`;
  return `${device.name} is offline. Reconnect it to continue this conversation.`;
}

export type TranscriptionDevice = { id: string; name: string; online: boolean; configured: boolean; provider?: string; source?: "hosted" | "device" };
export type TranscriptionAvailability = { available: boolean; devices: TranscriptionDevice[] };

export function parseTranscriptionAvailability(value: unknown): TranscriptionAvailability {
  const input = (value as { transcription?: TranscriptionAvailability })?.transcription;
  if (!input || typeof input.available !== "boolean" || !Array.isArray(input.devices) ||
      input.devices.some((device) => !device || typeof device.id !== "string" || !device.id ||
        typeof device.name !== "string" || typeof device.online !== "boolean" || typeof device.configured !== "boolean" ||
        (device.source !== undefined && device.source !== "hosted" && device.source !== "device")))
    throw new Error("Voice input availability could not be confirmed.");
  return { available: input.available, devices: input.devices.map(({ id, name, online, configured, provider, source }) => ({
    id, name, online, configured, ...(typeof provider === "string" ? { provider } : {}),
    ...(source ? { source } : {}),
  })) };
}

/** Hosted input is advertised by the authenticated server, not registered as a computer. */
export function reconcileTranscriptionAvailability(availability: TranscriptionAvailability | null,
  devices: readonly Pick<Device, "id" | "online">[]): TranscriptionAvailability | null {
  return availability && {
    ...availability,
    devices: availability.devices.map(input => ({
      ...input, online: input.online && (input.source === "hosted" || devices.some(device => device.id === input.id && device.online)),
    })),
  };
}

/** The authenticated default is the only input route; action destinations cannot select it. */
export function configuredTranscriptionRoute(config: { deviceId: string; transcriptionConfigured: boolean } | null,
  availability: TranscriptionAvailability | null) {
  const deviceId = config?.deviceId ?? "";
  return {
    deviceId,
    ready: !!deviceId && config?.transcriptionConfigured === true && availability?.available === true &&
      availability.devices.some(device => device.id === deviceId && device.online && device.configured),
  };
}
