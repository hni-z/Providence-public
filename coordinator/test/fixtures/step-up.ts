import type { Accounts } from "../../src/hosted/accounts.js";
/** Service-layer proof for tests of unrelated setup behavior. Real WebAuthn is tested in hosted-step-up.test.ts. */
export function fixtureStepUp(accounts: Accounts, raw: string, action: string, target?: string): string {
  const account = accounts.authenticate(raw)!.account;
  const id = `fixture-passkey-${account}`;
  if (!accounts.passkey(id)) accounts.addPasskey(account, { id, publicKey: new Uint8Array([0]), counter: 0 });
  return accounts.issueStepUp(raw, id, action, target).stepUpToken;
}
