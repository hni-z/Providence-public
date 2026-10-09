import { createHmac, randomBytes, randomInt } from "node:crypto";
import { resolve } from "node:path";
import { Accounts, digest } from "./accounts.js";
import { saveConfig } from "../config.js";
import type { Workspaces } from "./workspaces.js";

const alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const lifetime = 10 * 60_000;
export class SetupError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
type SetupRequest = {
  device_hash: string; user_code: string; expires: number; status: string;
  account: string | null; grant_hash: string | null; request_hash: string | null; key_hash: string | null;
};
const normalize = (value: unknown) => typeof value === "string" ? value.replace(/[\s-]/g, "").toUpperCase() : "";
const validSecret = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

/** A browser approves a short comparison code; credentials only reach its terminal's secret grant. */
export class TerminalSetup {
  constructor(private accounts: Accounts, private workspaces: Workspaces, private origin: string,
    private encryptionKey: Buffer, private validateKey: (key: string) => Promise<boolean>, private now = Date.now) {
    accounts.db.exec(`CREATE TABLE IF NOT EXISTS terminal_setups(
      device_hash TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL,
      status TEXT NOT NULL, account TEXT REFERENCES accounts(id), grant_hash TEXT UNIQUE,
      request_hash TEXT, key_hash TEXT
    )`);
  }
  private derive(label: string, value: string, encoding: "hex" | "base64url" = "base64url") {
    return createHmac("sha256", this.encryptionKey).update(`providence-setup:${label}:${value}`).digest(encoding);
  }
  start() {
    this.accounts.db.prepare("DELETE FROM terminal_setups WHERE expires<=?").run(this.now());
    const count = this.accounts.db.prepare("SELECT count(*) AS n FROM terminal_setups").get() as { n: number };
    if (count.n >= 500) throw new SetupError(429, "Setup is busy; try again later");
    const deviceCode = randomBytes(32).toString("base64url");
    let userCode = "";
    for (let attempt = 0; attempt < 10; attempt++) {
      userCode = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");
      if (!this.accounts.db.prepare("SELECT 1 FROM terminal_setups WHERE user_code=?").get(userCode)) break;
      userCode = "";
    }
    if (!userCode) throw new SetupError(503, "Could not start setup; try again");
    const expires = this.now() + lifetime;
    this.accounts.db.prepare("INSERT INTO terminal_setups(device_hash,user_code,expires,status) VALUES(?,?,?,'pending')").run(digest(deviceCode), userCode, expires);
    userCode = `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
    return { deviceCode, userCode, verificationUrl: `${this.origin}/account?setup=${userCode}`, expiresAt: new Date(expires).toISOString(), interval: 3 };
  }
  private byCode(code: unknown) {
    const normalized = normalize(code);
    if (!/^[A-Z0-9]{8}$/.test(normalized)) throw new SetupError(400, "Invalid setup code");
    return this.ensure(this.accounts.db.prepare("SELECT * FROM terminal_setups WHERE user_code=?").get(normalized) as SetupRequest | undefined);
  }
  private ensure(row: SetupRequest | undefined) {
    if (!row || row.expires <= this.now()) throw new SetupError(410, "Setup expired; run the command again");
    if (row.status === "denied") throw new SetupError(403, "Setup was declined");
    return row;
  }
  inspect(code: unknown, account: string) {
    const row = this.byCode(code);
    if (row.account && row.account !== account) throw new SetupError(403, "This setup belongs to another account");
    return { userCode: `${row.user_code.slice(0, 4)}-${row.user_code.slice(4)}`, status: row.status, expiresAt: new Date(row.expires).toISOString() };
  }
  approve(code: unknown, account: string) {
    const row = this.byCode(code);
    if (row.account && row.account !== account) throw new SetupError(403, "This setup was already claimed");
    if (row.status !== "pending" && row.status !== "approved") throw new SetupError(409, "This setup has already progressed");
    this.accounts.db.prepare("UPDATE terminal_setups SET status='approved',account=? WHERE device_hash=? AND status='pending'").run(account, row.device_hash);
    return { ok: true };
  }
  deny(code: unknown, account: string) {
    const row = this.byCode(code);
    if (row.account && row.account !== account) throw new SetupError(403, "This setup belongs to another account");
    if (!["pending", "approved"].includes(row.status)) throw new SetupError(409, "This setup has already progressed");
    this.accounts.db.prepare("UPDATE terminal_setups SET status='denied' WHERE device_hash=?").run(row.device_hash);
    return { ok: true };
  }
  poll(deviceCode: unknown) {
    if (!validSecret(deviceCode)) throw new SetupError(400, "Invalid terminal setup secret");
    const row = this.ensure(this.accounts.db.prepare("SELECT * FROM terminal_setups WHERE device_hash=?").get(digest(deviceCode)) as SetupRequest | undefined);
    if (row.status === "pending") return { status: "pending" as const };
    if (!row.account) throw new SetupError(403, "Setup has not been approved");
    const setupToken = this.derive("grant", deviceCode);
    this.accounts.db.prepare("UPDATE terminal_setups SET grant_hash=? WHERE device_hash=?").run(digest(setupToken), row.device_hash);
    const account = this.accounts.get(row.account)!;
    return { status: "approved" as const, setupToken, keyConfigured: !!account.key, accountName: account.name };
  }
  private grant(token: unknown) {
    if (!validSecret(token)) throw new SetupError(401, "Terminal setup authorization required");
    const row = this.ensure(this.accounts.db.prepare("SELECT * FROM terminal_setups WHERE grant_hash=?").get(digest(token)) as SetupRequest | undefined);
    if (!row.account || row.status === "pending") throw new SetupError(401, "Terminal setup authorization required");
    return row as SetupRequest & { account: string };
  }
  invalidateAccount(account: string) {
    this.accounts.db.prepare("UPDATE terminal_setups SET status='denied' WHERE account=?").run(account);
  }
  async setKey(token: unknown, value: unknown) {
    const row = this.grant(token);
    if (row.status !== "approved") throw new SetupError(409, "This setup can no longer change an API key");
    const key = typeof value === "string" ? value.trim() : "";
    if (!/^sk-[A-Za-z0-9_-]{20,1000}$/.test(key)) throw new SetupError(400, "Enter a valid OpenAI API key in the terminal");
    const fingerprint = this.derive("key-input", key, "hex");
    if (row.key_hash) {
      if (row.key_hash !== fingerprint) throw new SetupError(409, "This setup already saved a different key; start a new key setup");
      return { ok: true };
    }
    this.accounts.db.prepare("UPDATE terminal_setups SET status='configuring' WHERE device_hash=? AND status='approved'").run(row.device_hash);
    try {
      if (!await this.validateKey(key)) throw new SetupError(400, "OpenAI could not validate this key. Check its permissions and account.");
      this.ensure(this.accounts.db.prepare("SELECT * FROM terminal_setups WHERE device_hash=?").get(row.device_hash) as SetupRequest | undefined);
      await this.workspaces.reset(row.account);
      if (this.grant(token).status !== "configuring") throw new SetupError(409, "Setup authorization changed");
      this.accounts.setKey(row.account, key);
      this.accounts.db.prepare("UPDATE terminal_setups SET status='approved',key_hash=? WHERE device_hash=? AND status='configuring'").run(fingerprint, row.device_hash);
      return { ok: true };
    } catch (error) {
      this.accounts.db.prepare("UPDATE terminal_setups SET status='approved' WHERE device_hash=? AND status='configuring'").run(row.device_hash);
      if (error instanceof SetupError) throw error;
      throw new SetupError(409, "The key could not be updated. Finish active tasks and check the connection before trying again.");
    }
  }
  async connect(token: unknown, value: unknown) {
    let row = this.grant(token);
    if (!["approved", "connecting", "connected"].includes(row.status)) throw new SetupError(409, "Finish the current setup step first");
    const data = value as Record<string, unknown> | null;
    const name = typeof data?.name === "string" ? data.name.trim() : "";
    const workspace = typeof data?.workspace === "string" ? data.workspace : "";
    const workerAccess = data?.workerAccess;
    if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name) || !workspace || workspace.length > 4096 ||
        /[\x00-\x1f\x7f]/.test(workspace) || !["workspace", "full-access"].includes(String(workerAccess)))
      throw new SetupError(400, "Provide the computer name, workspace and chosen access mode");
    if (!this.accounts.get(row.account)?.key) throw new SetupError(409, "Configure the account's API key in the terminal first");
    const fingerprint = digest(JSON.stringify({ name, workspace, workerAccess }));
    if (row.request_hash && row.request_hash !== fingerprint) throw new SetupError(409, "Retry must use the original computer settings");
    if (row.status === "approved") this.accounts.db.prepare("UPDATE terminal_setups SET status='connecting',request_hash=? WHERE device_hash=? AND status='approved'").run(fingerprint, row.device_hash);
    const deviceId = "device-" + this.derive("device-id", row.device_hash, "hex").slice(0, 24);
    const deviceToken = this.derive("device-token", row.device_hash, "hex");
    const ready = await this.workspaces.get(row.account);
    row = this.grant(token);
    if (row.request_hash !== fingerprint || !["connecting", "connected"].includes(row.status)) throw new SetupError(409, "Setup settings changed");
    const prior = ready.app.config.devices.find(device => device.id === deviceId);
    const indexed = this.accounts.db.prepare("SELECT account FROM devices WHERE id=?").get(deviceId) as { account: string } | undefined;
    if ((indexed && indexed.account !== row.account) || (prior && prior.token !== deviceToken)) throw new SetupError(409, "Device identity conflict");
    if (row.status === "connected" && !prior) throw new SetupError(410, "This device was revoked; begin a new setup");
    if (!prior) {
      ready.app.config.devices.push({ id: deviceId, name, token: deviceToken });
      try { saveConfig(resolve(ready.app.directory, "config.json"), ready.app.config); }
      catch (error) { ready.app.config.devices = ready.app.config.devices.filter(device => device.id !== deviceId); throw error; }
      ready.app.devices.registered.push({ id: deviceId, name });
      ready.app.store.event({ type: "device.paired", deviceId, name });
    }
    this.accounts.db.prepare("INSERT OR IGNORE INTO devices(id,account) VALUES(?,?)").run(deviceId, row.account);
    this.accounts.db.prepare("UPDATE terminal_setups SET status='connected' WHERE device_hash=?").run(row.device_hash);
    return { deviceId, token: deviceToken, url: this.origin.replace(/^https:/, "wss:") + "/worker" };
  }
}
