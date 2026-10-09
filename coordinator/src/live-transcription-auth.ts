import { createHash, randomBytes, randomUUID } from "node:crypto";

export class LiveTranscriptionAccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export type LiveTranscriptionTicket = {
  sessionId: string; requestId: string; ticket: string; expiresAt: string;
};
type Entry = {
  value: LiveTranscriptionTicket; key: string; origin?: string;
  authorized: () => boolean; expires: number; retainUntil: number; consumed: boolean;
};
/** Short-lived single-use app tickets. No provider credentials, audio or text are stored. */
export class LiveTranscriptionTickets {
  private entries = new Map<string, Entry>();
  constructor(private readonly now = Date.now) {}
  private prune() {
    for (const [ticket, entry] of this.entries)
      if (entry.retainUntil <= this.now()) this.entries.delete(ticket);
  }
  issue(authorization: string, requestId: string, origin: string | undefined, authorized: () => boolean): LiveTranscriptionTicket {
    this.prune();
    if (!authorized()) throw new LiveTranscriptionAccessError(401, "Unauthorized");
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(requestId))
      throw new LiveTranscriptionAccessError(400, "Invalid live transcription request ID.");
    const key = createHash("sha256").update(authorization).update("\0").update(requestId).digest("hex");
    const prior = [...this.entries.values()].find(entry => entry.key === key);
    if (prior) {
      if (prior.origin !== origin || prior.consumed || prior.expires <= this.now())
        throw new LiveTranscriptionAccessError(409, "This live transcription request was already used or expired. It was not replayed.");
      return { ...prior.value };
    }
    if (this.entries.size >= 256 || [...this.entries.values()].filter(entry => !entry.consumed && entry.expires > this.now()).length >= 32)
      throw new LiveTranscriptionAccessError(429, "Too many live transcription requests. Try again later.");
    const expires = this.now() + 30_000;
    const value = { sessionId: randomUUID(), requestId, ticket: randomBytes(32).toString("base64url"), expiresAt: new Date(expires).toISOString() };
    this.entries.set(value.ticket, { value, key, origin, authorized, expires, retainUntil: this.now() + 5 * 60_000, consumed: false });
    return { ...value };
  }
  consume(ticket: unknown, origin: string | undefined): Omit<LiveTranscriptionTicket, "ticket" | "expiresAt"> {
    this.prune();
    const entry = typeof ticket === "string" ? this.entries.get(ticket) : undefined;
    if (!entry || entry.consumed || entry.expires <= this.now() || entry.origin !== origin || !entry.authorized())
      throw new LiveTranscriptionAccessError(401, "Live transcription access is invalid or expired.");
    entry.consumed = true;
    return { sessionId: entry.value.sessionId, requestId: entry.value.requestId };
  }
  isAuthorized(sessionId: string): boolean {
    const entry = [...this.entries.values()].find(value => value.value.sessionId === sessionId);
    return !!entry?.consumed && entry.authorized();
  }
  clear() { this.entries.clear(); }
}
