export type MirroringAction = "general" | "browser" | "messaging" | "email";
export type MirroringCapability = {
  schemaVersion: 1;
  transport: "apple-iphone-mirroring";
  appBundleId: "com.apple.ScreenContinuity";
  deviceId: string;
  chatId: string;
  phoneId: string;
  phoneName: string;
  observedAt: number;
  expiresAt: number;
  sessionId: string;
  configured: true;
  appPresent: boolean;
  phoneReachable: boolean;
  authenticated: boolean;
  identityVerified: boolean;
  controllable: boolean;
  effectVerified: true;
  executable: boolean;
  supportedActions: MirroringAction[];
};

export type MirroringEvidenceTask = {
  id: string;
  deviceId: string;
  chatId: string;
  status: string;
  createdAt: string;
};

export function deriveMirroringCapability(input?: {
  selection?: unknown;
  acceptanceRecords?: unknown;
  observation?: unknown;
  tasks?: Readonly<Record<string, MirroringEvidenceTask>> | ReadonlyMap<string, MirroringEvidenceTask>;
  now?: number;
}): MirroringCapability | undefined;
