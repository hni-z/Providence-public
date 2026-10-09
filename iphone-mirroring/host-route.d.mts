export type MirroringExecutionTarget = Readonly<{
  transport: "apple-iphone-mirroring";
  deviceId: string;
  chatId: string;
  phoneId: string;
  phoneName: string;
  leaseId: string;
  action: "general" | "browser" | "messaging" | "email";
}>;
export class HostRouteError extends Error { code: string; constructor(code: string); }
export function parseExecutionTarget(value: unknown): MirroringExecutionTarget | undefined;
export function executionTargetsEqual(left: unknown, right: unknown): boolean;
export function assertGUIAvailable(input: {
  deviceId: string; taskId?: string; executionTarget?: unknown; tasks: unknown[];
}): void;
export function authorizeMirroringDispatch(input: {
  executionTarget?: unknown; device: unknown; chat: unknown; capability?: unknown; binding?: unknown;
  tasks: unknown[]; taskId?: string; now?: number;
}): MirroringExecutionTarget | undefined;
