import { z } from "zod";
import { HostRouteError, type MirroringExecutionTarget } from "../../iphone-mirroring/host-route.mjs";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export const executionTargetSchema = z.object({
  transport: z.literal("apple-iphone-mirroring"),
  deviceId: id, chatId: id, phoneId: id, leaseId: id,
  phoneName: z.string().min(1).refine(value => [...value].length <= 80 && value.trim().length > 0 && !/\p{Cc}/u.test(value)),
  action: z.enum(["general", "browser", "messaging", "email"]),
}).strict();
export type ExecutionTarget = MirroringExecutionTarget;
export type ExecutionQuiescence = {
  verification: "independently_verified"; providerQuiescent: true; taskId: string; leaseId: string;
};
/** Issued only before a new request is persisted or crosses the worker boundary. */
export class RequestNotAcceptedError extends Error {
  constructor(readonly requestId: string, cause: Error, readonly reasonCode?: string) { super(cause.message); }
}

const messages: Record<string, string> = {
  deviceBusy: "The Mac has active or unresolved work. Check that request before using iPhone Mirroring.",
  invalidExecutionTarget: "The iPhone request has an invalid target. Review its configured phone and Mac.",
  invalidEvidence: "The iPhone route could not be verified. Check its configuration on the Mac.",
  wrongTarget: "The iPhone or Mac binding changed. Nothing was sent to another device.",
  macUnavailable: "The selected Mac is unavailable. Reconnect it before controlling the iPhone.",
  chatUnavailable: "The selected Mac conversation is unavailable. Restore its existing connection.",
  notConfigured: "Configure the selected iPhone and Mac for iPhone Mirroring.",
  appMissing: "iPhone Mirroring is not available on the selected Mac.",
  phoneUnavailable: "The selected iPhone is unavailable. Check iPhone Mirroring on the Mac.",
  authenticationRequired: "Finish iPhone Mirroring authentication on the Mac.",
  controlUnavailable: "Phone control is not verified. Complete the harmless Mirroring check on the Mac.",
  acceptanceRequired: "This phone action has not been verified on the Mac yet.",
  staleEvidence: "The phone readiness check expired. Recheck iPhone Mirroring on the Mac.",
  sessionChanged: "The iPhone route changed. Check the original request before continuing.",
  unsupportedAction: "That action is not available through iPhone Mirroring.",
};
export function mirroringMessage(error: unknown): Error {
  return error instanceof HostRouteError
    ? new Error(messages[error.code] ?? "iPhone Mirroring is unavailable. Check the selected Mac.")
    : error instanceof Error ? error : new Error("iPhone Mirroring could not be verified.");
}

/** Derived only from validated typed input, never a prompt's claimed routing. */
export function mirroringWorkerPrefix(target: ExecutionTarget): string {
  return "Providence admitted this exact iPhone Mirroring route and reserved its Mac for this task: " +
    JSON.stringify(target) + "\nUse only the ordinary worker's actual native computer-use tool with Apple's " +
    "com.apple.ScreenContinuity app. Read the tool's current documentation and observe the same selected " +
    "physical phone/account immediately before each input, including after a decision wait. If identity, " +
    "authentication, tool access or phone continuity cannot be verified, stop with a concrete setup step. " +
    "Never substitute a desktop app, Mac browser, another phone or another account. " +
    "The route epoch is configuration only: it does not prove a connected phone, confer permission, " +
    "or guarantee that this action works. Complete live preflight through the normal worker first. " +
    "The initial getApp call must stand alone as required by the tool. After observing a target, " +
    "a deterministic action and its fresh post-action observation may share one tool call; preserve " +
    "their real order and do not invent separate tool-call IDs. Never batch a later action whose " +
    "target depends on an unseen result. Preserve all provider app-use decisions and their offered scopes. " +
    "No calls, camera/microphone, biometric or account/security changes. For messages, use the explicitly authorized " +
    "sender, recipient and content without a separate Providence confirmation. Preserve any mandatory native tool action-time requirement. " +
    "A decision acknowledgement is not proof of sending; verify the actual phone effect. " +
    "Do not retry an unknown outcome. The selected Mac owner must retain the GUI slot against manual or external automation.\n\n";
}
