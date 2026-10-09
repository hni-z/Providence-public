export type StepUpAction = "add_passkey" | "approve_setup" | "pair_device" | "pair_client" | "remove_passkey" | "delete_account";
export class StepUpError extends Error {
  readonly status = 428;
  readonly errorCode = "step_up_required";
  constructor() { super("Confirm this action with an existing passkey, then try again."); }
}
export function stepUpIntent(action: unknown, target?: unknown): { action: StepUpAction; target: string } {
  if (action === "add_passkey" && (target === undefined || target === "")) return { action, target: "" };
  if (typeof target !== "string") throw new Error("Invalid sensitive action target");
  if (action === "approve_setup") {
    const code = target.replace(/[\s-]/g, "").toUpperCase();
    if (/^[A-Z0-9]{8}$/.test(code)) return { action, target: code };
  }
  if (action === "pair_device" || action === "pair_client") {
    const name = target.trim();
    if (name && name.length <= 120 && !/[\x00-\x1f\x7f]/.test(name)) return { action, target: name };
  }
  if (action === "remove_passkey" && /^[A-Za-z0-9_-]{1,2048}$/.test(target)) return { action, target };
  if (action === "delete_account" && /^[0-9a-f-]{36}$/.test(target)) return { action, target };
  throw new Error("Invalid sensitive action");
}
