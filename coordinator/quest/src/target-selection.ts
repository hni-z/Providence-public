import type { Device, Snapshot } from "./types";

/** Only the authenticated Providence registry determines execution connectivity. */
export function deviceConnection(device: Device | undefined, fresh = true): string {
  if (!fresh) return "Providence status unavailable";
  if (!device) return "Disconnected computer";
  return device.online === true ? "Connected to Providence" : "Offline in Providence";
}

export function actionTarget(snapshot: Snapshot, chatId: string): string {
  if (chatId === "master") return "All computers · Providence chooses";
  const chat = snapshot.chats.find((candidate) => candidate.id === chatId);
  if (!chat) return "Unavailable conversation";
  const device = snapshot.devices.find((candidate) => candidate.id === chat.deviceId);
  return `${device?.name ?? "Disconnected computer"} · ${chat.name}`;
}

/** Keep an unavailable selection visible without changing its route or identity. */
export function targetOptions(snapshot: Snapshot, selectedChat: string, fresh = true) {
  const options = [
    { id: "master", label: "All computers · Providence chooses" },
    ...snapshot.chats.map((chat) => ({
      id: chat.id,
      label: `${actionTarget(snapshot, chat.id)} · ${deviceConnection(snapshot.devices.find((device) => device.id === chat.deviceId), fresh)}`,
    })),
  ];
  if (!options.some((option) => option.id === selectedChat)) {
    options.push({ id: selectedChat, label: "Unavailable conversation" });
  }
  return options;
}
