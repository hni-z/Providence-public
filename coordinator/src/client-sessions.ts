import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { z } from "zod";
const codeAlphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const maxCodeAttempts = 10;
const sessionSchema = z.object({
  id: z.string(),
  name: z.string(),
  hash: z.string().length(64),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export class ClientSessions {
  private codes = new Map<string, { name: string; expiresAt: number }>();
  private sessions: z.infer<typeof sessionSchema>[];
  constructor(
    readonly file: string,
    readonly now = Date.now,
    private readonly randomIndex: (max: number) => number = randomInt,
    private readonly lifetimeMs = 24 * 60 * 60 * 1000,
  ) {
    this.sessions = existsSync(file)
      ? z.array(sessionSchema).parse(JSON.parse(readFileSync(file, "utf8")))
      : [];
  }
  issue(name: string) {
    this.pruneCodes();
    if (this.codes.size >= 10) throw new Error("Too many pending client codes");
    for (let attempt = 0; attempt < maxCodeAttempts; attempt++) {
      const code = Array.from(
        { length: 12 },
        () => codeAlphabet[this.randomIndex(codeAlphabet.length)],
      ).join("");
      if (this.codes.has(code)) continue;
      const expiresAt = this.now() + 10 * 60 * 1000;
      this.codes.set(code, { name, expiresAt });
      return {
        code: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    }
    throw new Error("Unable to allocate a unique client code; try again");
  }
  exchange(value: string) {
    this.pruneCodes();
    const code = value.replace(/[\s-]/g, "").toUpperCase();
    const entry = this.codes.get(code);
    if (!entry) return this.rejectExchange();
    this.codes.delete(code);
    const token = randomBytes(32).toString("hex");
    const id = randomUUID();
    const expiresAt = new Date(this.now() + this.lifetimeMs).toISOString();
    this.sessions = this.sessions.filter(
      (s) => Date.parse(s.expiresAt) > this.now(),
    );
    if (this.sessions.length >= 100)
      throw new Error("Too many active client sessions");
    this.sessions.push({
      id,
      name: entry.name,
      hash: createHash("sha256").update(token).digest("hex"),
      createdAt: new Date(this.now()).toISOString(),
      expiresAt,
    });
    this.save();
    return { token, clientId: id, expiresAt };
  }
  rejectExchange(): never {
    throw new Error("Client code is invalid or expired");
  }
  private pruneCodes() {
    const now = this.now();
    for (const [code, entry] of this.codes)
      if (entry.expiresAt <= now) this.codes.delete(code);
  }
  accepts(authorization: unknown) {
    if (
      typeof authorization !== "string" ||
      !authorization.startsWith("Bearer ")
    )
      return false;
    const hash = createHash("sha256")
      .update(authorization.slice(7))
      .digest("hex");
    return this.sessions.some(
      (s) => s.hash === hash && Date.parse(s.expiresAt) > this.now(),
    );
  }
  list() {
    return this.sessions.map(({ hash, ...session }) => ({
      ...session,
      expired: Date.parse(session.expiresAt) <= this.now(),
    }));
  }
  revoke(id: string) {
    if (!this.sessions.some((s) => s.id === id))
      throw new Error("Unknown client session");
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.save();
    return { revoked: true };
  }
  private save() {
    writeFileSync(this.file + ".tmp", JSON.stringify(this.sessions, null, 2), {
      mode: 0o600,
    });
    renameSync(this.file + ".tmp", this.file);
  }
}
