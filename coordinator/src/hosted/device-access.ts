import { digest, type Accounts } from "./accounts.js";
import type { Workspaces } from "./workspaces.js";

export class DeviceAccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Revocation receipts contain hashes only, so a retry can confirm its own removal. */
export class DeviceAccess {
  constructor(private accounts: Accounts, private workspaces: Workspaces) {
    accounts.db.exec(`CREATE TABLE IF NOT EXISTS revoked_devices(
      id TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id),
      credential_hash TEXT NOT NULL, revoked_at INTEGER NOT NULL
    )`);
  }
  private validId(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
  }
  private active(id: string) {
    return this.accounts.db.prepare("SELECT account FROM devices WHERE id=?").get(id) as { account: string } | undefined;
  }
  private receipt(id: string) {
    return this.accounts.db.prepare("SELECT account,credential_hash FROM revoked_devices WHERE id=?").get(id) as { account: string; credential_hash: string } | undefined;
  }
  async owner(account: string, id: unknown) {
    if (!this.validId(id)) throw new DeviceAccessError(404, "Computer not found in this account");
    const active = this.active(id);
    if (!active || active.account !== account) {
      if (this.receipt(id)?.account === account) return { revoked: true, deviceId: id };
      throw new DeviceAccessError(404, "Computer not found in this account");
    }
    return this.remove(account, id);
  }
  async self(id: unknown, authorization: unknown) {
    if (!this.validId(id) || typeof authorization !== "string" || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization))
      throw new DeviceAccessError(401, "An active device credential is required");
    const token = authorization.slice(7), receipt = this.receipt(id);
    if (receipt?.credential_hash === digest(token)) return { revoked: true, deviceId: id };
    const active = this.active(id);
    if (!active) throw new DeviceAccessError(401, "An active device credential is required");
    return this.remove(active.account, id, token);
  }
  private async remove(account: string, id: string, token?: string) {
    let removedToken: string;
    try { removedToken = await this.workspaces.revokeDevice(account, id, token); }
    catch {
      const receipt = this.receipt(id);
      if (receipt?.account === account && (token === undefined || receipt.credential_hash === digest(token)))
        return { revoked: true, deviceId: id };
      throw new DeviceAccessError(token ? 401 : 409, token ? "Device removal could not be confirmed with this credential" : "Computer removal could not be saved; check its current status and try again");
    }
    // Config removal already fences tenant authentication. Updating the gateway
    // index and receipt together also rejects reconnects before tenant startup.
    this.accounts.db.exec("BEGIN IMMEDIATE");
    try {
      this.accounts.db.prepare("DELETE FROM devices WHERE id=? AND account=?").run(id, account);
      this.accounts.db.prepare("INSERT OR REPLACE INTO revoked_devices VALUES(?,?,?,?)").run(id, account, digest(removedToken), Date.now());
      this.accounts.db.exec("COMMIT");
    } catch (error) { this.accounts.db.exec("ROLLBACK"); throw error; }
    return { revoked: true, deviceId: id };
  }
}
