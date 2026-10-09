export type MirroringAction = "general" | "browser" | "messaging" | "email";
export type MirroringBinding = {
  schemaVersion: 1;
  transport: "apple-iphone-mirroring";
  appBundleId: "com.apple.ScreenContinuity";
  status: "configured";
  deviceId: string;
  chatId: string;
  phoneId: string;
  phoneName: string;
  bindingEpoch: string;
  allowedActions: MirroringAction[];
  requiresLivePreflight: true;
  grantsPermission: false;
};

export function deriveMirroringBinding(documentBinding: unknown, deviceId: string, nowSeconds?: number): MirroringBinding | undefined;
