import type { Accounts } from "./accounts.js";
import type { Workspaces } from "./workspaces.js";

export class AccountDeletionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** An account tombstone survives failure/restart until its owned data is removed. */
export class AccountDeletion {
  private jobs = new Map<string, Promise<boolean>>();
  private stopped = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private accounts: Accounts, private workspaces: Workspaces,
    private revoke: (account: string, hashes: string[]) => Promise<void>, retryMs = 60_000) {
    this.timer = setInterval(() => { void this.retryPending(); }, retryMs); this.timer.unref();
  }
  async delete(raw: string, stepUpToken: unknown) {
    const owner = this.accounts.authenticate(raw);
    if (this.stopped || owner?.scope !== "owner") throw new AccountDeletionError(401, "Sign in to delete your account.");
    this.accounts.consumeStepUp(raw, stepUpToken, "delete_account", owner.account);
    const hashes = this.accounts.beginDeletion(owner.account);
    // Stop admissions immediately; do not wait for voice/provider cleanup first.
    const attempt = (operation: () => Promise<void>) => {
      try { return operation(); } catch (error) { return Promise.reject(error); }
    };
    const stopped = attempt(() => this.workspaces.disable(owner.account));
    const revoked = attempt(() => this.revoke(owner.account, hashes));
    const deleted = await this.clean(owner.account, () => Promise.all([stopped, revoked]).then(() => {}));
    return { deleted, accessRevoked: true as const, cleanupPending: !deleted,
      externalApiKeyRevoked: false as const, localFilesDeleted: false as const };
  }
  private clean(account: string, prepare: () => Promise<void>): Promise<boolean> {
    const existing = this.jobs.get(account); if (existing) return existing;
    const job = (async () => {
      try {
        await prepare();
        await this.workspaces.removeDeletedAccountData(account);
        this.accounts.finishDeletion(account);
        return true;
      } catch { return false; } // Keep the durable tombstone and authority revoked.
    })().finally(() => { this.jobs.delete(account); });
    this.jobs.set(account, job); return job;
  }
  async retryPending() {
    if (this.stopped) return;
    try {
      await Promise.all(this.accounts.pendingDeletions().map(account => this.clean(account,
        () => Promise.all([this.workspaces.disable(account), this.revoke(account, [])]).then(() => {}))));
    } catch {
      // A transient journal read failure must not become an unhandled timer
      // rejection or restore access. The durable tombstones remain for retry.
    }
  }
  async close() {
    this.stopped = true; clearInterval(this.timer);
    await Promise.all([...this.jobs.values()]);
  }
}
