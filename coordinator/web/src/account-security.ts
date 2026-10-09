export type AccountOperation = "add_passkey" | "approve_setup" | "pair_device" | "pair_client" | "remove_passkey" | "delete_account";

type SecurityDependencies = {
  request: (path: string, body?: unknown, method?: string) => Promise<any>;
  authenticate: (options: any) => Promise<unknown>;
};

export type AccountSecurity = {
  sessions: { id: string; scope: string; createdAt: string | null; expiresAt: string; current: boolean }[];
  passkeys: { id: string; createdAt: string | null; transports: string[] }[];
};

/** An unavailable inventory must not be mistaken for an account with no credentials. */
export function parseAccountSecurity(value: unknown): AccountSecurity {
  const date = (input: unknown) => typeof input === "string" && Number.isFinite(Date.parse(input));
  const created = (input: unknown) => input === null || date(input);
  const record = (input: unknown): input is Record<string, unknown> => !!input && typeof input === "object";
  if (!record(value) || !Array.isArray(value.sessions) || !Array.isArray(value.passkeys) ||
      !value.sessions.every(session => record(session) && typeof session.id === "string" && /^[0-9a-f-]{36}$/.test(session.id) &&
        typeof session.scope === "string" && created(session.createdAt) && date(session.expiresAt) && typeof session.current === "boolean") ||
      !value.passkeys.every(passkey => record(passkey) && typeof passkey.id === "string" && /^[A-Za-z0-9_-]{1,2048}$/.test(passkey.id) &&
        created(passkey.createdAt) && Array.isArray(passkey.transports) && passkey.transports.every(transport => typeof transport === "string")))
    throw new Error("Your account security details could not be checked. Refresh to try again.");
  return value as AccountSecurity;
}

/** Keep the single-use proof in this call, never in browser storage or a URL. */
export async function verifiedAccountRequest(
  dependencies: SecurityDependencies,
  operation: AccountOperation,
  path: string,
  body: Record<string, unknown>,
  target?: string,
  method?: string,
) {
  const options = await dependencies.request("/auth/step-up/options", { action: operation, ...(target === undefined ? {} : { target }) });
  const credential = await dependencies.authenticate(options);
  const proof = await dependencies.request("/auth/step-up/verify", { response: credential });
  if (typeof proof?.stepUpToken !== "string" || !proof.stepUpToken)
    throw new Error("Your identity could not be verified. Please try again.");
  // A failed or cancelled verification must never fall back to an unverified request.
  return dependencies.request(path, { ...body, stepUpToken: proof.stepUpToken }, method);
}
