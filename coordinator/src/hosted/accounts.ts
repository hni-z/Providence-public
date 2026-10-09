import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import { chmodSync } from "node:fs";
import { StepUpError, stepUpIntent } from "./step-up.js";
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
export const AI_CONSENT_VERSION = "2026-10-02";
export class AIConsentError extends Error {
  readonly status = 428;
  readonly errorCode = "ai_consent_required";
  readonly aiConsentVersion = AI_CONSENT_VERSION;
  constructor() { super("Review and accept AI processing in your Providence account before starting AI work."); }
}
export type Account = { id: string; name: string; created: number; key: string | null; ai_consent_version?: string | null };
export class Accounts {
  readonly db: DatabaseSync;
  constructor(file: string, private encryptionKey: Buffer, readonly now = Date.now) {
    if (encryptionKey.length !== 32) throw new Error("A 32-byte account encryption key is required");
    this.db = new DatabaseSync(file);
    if (file !== ":memory:") chmodSync(file, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL,created INTEGER NOT NULL,key TEXT);
      CREATE TABLE IF NOT EXISTS passkeys(id TEXT PRIMARY KEY,account TEXT NOT NULL REFERENCES accounts(id),publicKey TEXT NOT NULL,counter INTEGER NOT NULL,transports TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,account TEXT NOT NULL REFERENCES accounts(id),scope TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges(hash TEXT PRIMARY KEY,value TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS codes(hash TEXT PRIMARY KEY,account TEXT NOT NULL REFERENCES accounts(id),kind TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,account TEXT NOT NULL REFERENCES accounts(id));
      CREATE TABLE IF NOT EXISTS step_up_grants(hash TEXT PRIMARY KEY,session_hash TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
        account TEXT NOT NULL REFERENCES accounts(id),credential_id TEXT NOT NULL REFERENCES passkeys(id) ON DELETE CASCADE,
        action TEXT NOT NULL,target TEXT NOT NULL,expires INTEGER NOT NULL);`);
    const columns = (table: string) => new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name));
    const sessions = columns("sessions");
    if (!sessions.has("id")) this.db.exec("ALTER TABLE sessions ADD COLUMN id TEXT");
    if (!sessions.has("created")) this.db.exec("ALTER TABLE sessions ADD COLUMN created INTEGER NOT NULL DEFAULT 0");
    if (!columns("passkeys").has("created")) this.db.exec("ALTER TABLE passkeys ADD COLUMN created INTEGER NOT NULL DEFAULT 0");
    if (!columns("accounts").has("revocation_epoch")) this.db.exec("ALTER TABLE accounts ADD COLUMN revocation_epoch INTEGER NOT NULL DEFAULT 0");
    if (!columns("accounts").has("deleting")) this.db.exec("ALTER TABLE accounts ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0");
    if (!columns("accounts").has("ai_consent_version")) this.db.exec("ALTER TABLE accounts ADD COLUMN ai_consent_version TEXT");
    const codes = columns("codes");
    if (!codes.has("epoch")) this.db.exec("ALTER TABLE codes ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0");
    if (!codes.has("issuer_hash")) this.db.exec("ALTER TABLE codes ADD COLUMN issuer_hash TEXT REFERENCES sessions(hash) ON DELETE CASCADE");
    for (const row of this.db.prepare("SELECT hash FROM sessions WHERE id IS NULL").all() as { hash: string }[])
      this.db.prepare("UPDATE sessions SET id=? WHERE hash=?").run(randomUUID(), row.hash);
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS session_public_id ON sessions(id)");
  }
  get(id: string) { return this.db.prepare("SELECT * FROM accounts WHERE id=? AND deleting=0").get(id) as Account | undefined; }
  hasAIConsent(account: string) { return this.get(account)?.ai_consent_version === AI_CONSENT_VERSION; }
  acceptAIConsent(account: string, version: unknown) {
    if (version !== AI_CONSENT_VERSION) throw new AIConsentError();
    const changed = this.db.prepare("UPDATE accounts SET ai_consent_version=? WHERE id=? AND deleting=0").run(AI_CONSENT_VERSION, account);
    if (changed.changes !== 1) throw new Error("Unknown active account");
    return { accepted: true as const, version: AI_CONSENT_VERSION };
  }
  create(name: string, id = randomUUID()) {
    this.db.prepare("INSERT INTO accounts(id,name,created) VALUES(?,?,?)").run(id, name, this.now());
    return this.get(id)!;
  }
  session(account: string, scope = "owner", duration = 7 * 86400_000, raw = token()) {
    if (!this.get(account)) throw new Error("Unknown active account");
    this.db.prepare("DELETE FROM sessions WHERE expires<=?").run(this.now());
    this.db.prepare("INSERT INTO sessions(hash,account,scope,expires,id,created) VALUES(?,?,?,?,?,?)").run(digest(raw), account, scope, this.now() + duration, randomUUID(), this.now());
    return raw;
  }
  authenticate(raw: unknown) {
    if (typeof raw !== "string" || raw.length < 32 || raw.length > 256) return;
    return this.db.prepare("SELECT sessions.account,scope,expires FROM sessions JOIN accounts ON accounts.id=sessions.account WHERE hash=? AND expires>? AND accounts.deleting=0").get(digest(raw), this.now()) as { account: string; scope: string; expires: number } | undefined;
  }
  logout(raw: string) { this.db.prepare("DELETE FROM sessions WHERE hash=?").run(digest(raw)); }
  security(account: string, raw: string) {
    return {
      sessions: (this.db.prepare("SELECT id,scope,created,expires,hash FROM sessions WHERE account=? AND expires>? ORDER BY created DESC,id").all(account, this.now()) as any[])
        .map(row => ({ id: row.id, scope: row.scope, createdAt: row.created ? new Date(row.created).toISOString() : null,
          expiresAt: new Date(row.expires).toISOString(), current: row.hash === digest(raw) })),
      passkeys: (this.db.prepare("SELECT id,created,transports FROM passkeys WHERE account=? ORDER BY created,id").all(account) as any[])
        .map(row => ({ id: row.id, createdAt: row.created ? new Date(row.created).toISOString() : null, transports: JSON.parse(row.transports) })),
    };
  }
  revokeSession(account: string, id: string) {
    return this.db.prepare("DELETE FROM sessions WHERE account=? AND id=? RETURNING hash").get(account, id) as { hash: string } | undefined;
  }
  revokeSessions(account: string, exceptRaw?: string) {
    return (this.db.prepare("DELETE FROM sessions WHERE account=? AND hash!=? RETURNING hash").all(account, exceptRaw ? digest(exceptRaw) : "") as { hash: string }[]).map(row => row.hash);
  }
  clearSensitiveIntents(account: string) {
    this.db.prepare("UPDATE accounts SET revocation_epoch=revocation_epoch+1 WHERE id=?").run(account);
    this.db.prepare("DELETE FROM step_up_grants WHERE account=?").run(account);
    this.db.prepare("DELETE FROM codes WHERE account=?").run(account);
    // Challenges are private JSON records; legacy records remain compatible.
    this.db.prepare("DELETE FROM challenges WHERE json_extract(value,'$.account')=?").run(account);
  }
  revocationEpoch(account: string): number {
    const row = this.db.prepare("SELECT revocation_epoch FROM accounts WHERE id=?").get(account) as { revocation_epoch: number } | undefined;
    if (!row) throw new Error("Unknown account");
    return row.revocation_epoch;
  }
  issueStepUp(raw: string, credentialId: string, action: unknown, target?: unknown) {
    const session = this.authenticate(raw), credential = this.passkey(credentialId), intent = stepUpIntent(action, target);
    if (session?.scope !== "owner" || credential?.account !== session.account) throw new StepUpError();
    const proof = token(), expires = this.now() + 300_000;
    this.db.prepare("DELETE FROM step_up_grants WHERE expires<=?").run(this.now());
    this.db.prepare("INSERT INTO step_up_grants VALUES(?,?,?,?,?,?,?)").run(digest(proof), digest(raw), session.account, credentialId, intent.action, intent.target, expires);
    return { stepUpToken: proof, expiresAt: new Date(expires).toISOString() };
  }
  consumeStepUp(raw: string, proof: unknown, action: unknown, target?: unknown) {
    const intent = stepUpIntent(action, target), session = this.authenticate(raw);
    if (session?.scope !== "owner" || typeof proof !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(proof)) throw new StepUpError();
    const row = this.db.prepare("DELETE FROM step_up_grants WHERE hash=? RETURNING *").get(digest(proof)) as any;
    if (!row || row.expires <= this.now() || row.session_hash !== digest(raw) || row.account !== session.account ||
        row.action !== intent.action || row.target !== intent.target || this.passkey(row.credential_id)?.account !== session.account) throw new StepUpError();
    return { credentialId: row.credential_id as string };
  }
  removePasskey(account: string, id: string, verifiedCredential: string) {
    if (id === verifiedCredential) throw new Error("Confirm removal with a different passkey");
    if (this.passkey(verifiedCredential)?.account !== account || this.passkey(id)?.account !== account) throw new Error("Unknown account passkey");
    const count = this.db.prepare("SELECT count(*) AS n FROM passkeys WHERE account=?").get(account) as { n: number };
    if (count.n < 2) throw new Error("Keep at least one passkey on the account");
    this.db.prepare("DELETE FROM passkeys WHERE account=? AND id=?").run(account, id);
  }
  challenge(value: unknown) {
    this.db.prepare("DELETE FROM challenges WHERE expires<=?").run(this.now());
    const count = this.db.prepare("SELECT count(*) AS n FROM challenges").get() as { n: number };
    if (count.n >= 1000) throw new Error("Sign-in is busy; try again shortly");
    const raw = token(); this.db.prepare("INSERT INTO challenges VALUES(?,?,?)").run(digest(raw), JSON.stringify(value), this.now() + 300_000); return raw;
  }
  consumeChallenge(raw: string): any {
    const row = this.db.prepare("DELETE FROM challenges WHERE hash=? RETURNING value,expires").get(digest(raw)) as { value: string; expires: number } | undefined;
    if (!row || row.expires <= this.now()) throw new Error("Sign-in expired; start again");
    return JSON.parse(row.value);
  }
  passkey(id: string) { return this.db.prepare("SELECT * FROM passkeys WHERE id=?").get(id) as { id: string; account: string; publicKey: string; counter: number; transports: string } | undefined; }
  addPasskey(account: string, credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] }) {
    if (!this.get(account)) throw new Error("Unknown active account");
    this.db.prepare("INSERT INTO passkeys(id,account,publicKey,counter,transports,created) VALUES(?,?,?,?,?,?)").run(credential.id, account, Buffer.from(credential.publicKey).toString("base64url"), credential.counter, JSON.stringify(credential.transports ?? []), this.now());
  }
  setKey(account: string, key: string) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(account));
    const encrypted = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
    const changed = this.db.prepare("UPDATE accounts SET key=? WHERE id=? AND deleting=0").run([iv, cipher.getAuthTag(), encrypted].map(b => b.toString("base64url")).join("."), account);
    if (changed.changes !== 1) throw new Error("Unknown active account");
  }
  /** Durable access fence before asynchronous account-file/provider cleanup. */
  beginDeletion(account: string): string[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db.prepare("UPDATE accounts SET deleting=1,key=NULL,name='',created=0,ai_consent_version=NULL,revocation_epoch=revocation_epoch+1 WHERE id=? AND deleting=0").run(account);
      if (changed.changes !== 1) throw new Error("Unknown active account");
      const hashes = this.revokeSessions(account);
      this.db.prepare("DELETE FROM codes WHERE account=?").run(account);
      this.db.prepare("DELETE FROM challenges WHERE json_extract(value,'$.account')=? OR json_extract(value,'$.userID')=?").run(account, account);
      this.db.prepare("DELETE FROM passkeys WHERE account=?").run(account);
      this.db.prepare("DELETE FROM devices WHERE account=?").run(account);
      for (const table of ["terminal_setups", "revoked_devices"])
        if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
          this.db.prepare(`DELETE FROM ${table} WHERE account=?`).run(account);
      this.db.exec("COMMIT"); return hashes;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  pendingDeletions(): string[] {
    return (this.db.prepare("SELECT id FROM accounts WHERE deleting=1").all() as { id: string }[]).map(row => row.id);
  }
  finishDeletion(account: string) {
    this.db.prepare("DELETE FROM accounts WHERE id=? AND deleting=1").run(account);
  }
  readKey(account: string) {
    const value = this.get(account)?.key; if (!value) throw new Error("Add your OpenAI API key in Account settings");
    const [iv, tag, encrypted] = value.split(".").map(v => Buffer.from(v, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv); decipher.setAAD(Buffer.from(account)); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }
  code(account: string, kind: string, raw: string, issuerRaw?: string) {
    this.db.prepare("DELETE FROM codes WHERE expires<=?").run(this.now());
    this.db.prepare("INSERT INTO codes(hash,account,kind,expires,epoch,issuer_hash) VALUES(?,?,?,?,?,?)")
      .run(digest(raw.replace(/[\s-]/g, "").toUpperCase()), account, kind, this.now() + 600_000, this.revocationEpoch(account), issuerRaw ? digest(issuerRaw) : null);
  }
  consumeCode(raw: string, kind: string) {
    return this.consumeCodeIntent(raw, kind).account;
  }
  consumeCodeIntent(raw: string, kind: string) {
    const row = this.db.prepare("DELETE FROM codes WHERE hash=? AND kind=? RETURNING account,expires,epoch,issuer_hash").get(digest(raw.replace(/[\s-]/g, "").toUpperCase()), kind) as { account: string; expires: number; epoch: number; issuer_hash: string | null } | undefined;
    if (!row || row.expires <= this.now() || !this.codeIntentActive(row)) throw new Error("Pairing code expired or invalid");
    return row;
  }
  codeIntentActive(intent: { account: string; epoch: number; issuer_hash: string | null }) {
    return this.revocationEpoch(intent.account) === intent.epoch && (!intent.issuer_hash || !!this.db.prepare("SELECT 1 FROM sessions WHERE hash=? AND account=? AND expires>?").get(intent.issuer_hash, intent.account, this.now()));
  }
  close() { this.db.close(); }
}
