import { startKeepAwake, type KeepAwakeHandle } from '../install/keep-awake.mjs';
import type { KeepAwakeState } from './device-config.js';

/** Local consent plus a short server activity lease; an idle background process holds no assertion. */
export class KeepAwakeController {
  private handle?: KeepAwakeHandle;
  private enabled = false;
  private activity = false;
  private stopped = false;
  private lease?: ReturnType<typeof setTimeout>;
  private pending: Promise<void> = Promise.resolve();
  constructor(private changed: (state: KeepAwakeState) => void = () => {},
    private start: typeof startKeepAwake = startKeepAwake) {}
  get status(): KeepAwakeState {
    return { enabled: this.enabled, ...(this.handle?.status ?? { active: false,
      reason: !this.enabled ? 'disabled' as const : !this.activity ? 'waiting_for_activity' as const : 'startup_unconfirmed' as const }) };
  }
  private canReplace() { return !this.handle || (!this.handle.status.active && this.handle.status.reason !== 'stop_unconfirmed'); }
  private apply() {
    const update = async () => {
      if (!this.enabled || !this.activity || this.stopped) {
        await this.handle?.stop();
        if (this.canReplace()) this.handle = undefined;
      } else if (this.canReplace()) {
        await this.handle?.stop();
        if (this.canReplace()) {
          try { this.handle = await this.start({ onChange: () => this.changed(this.status) }); }
          catch { this.handle = { status: { active: false, reason: 'helper_unavailable' }, stop: async () => {} }; }
          // Consent/activity may have changed while acquisition was pending.
          if (!this.enabled || !this.activity || this.stopped) {
            await this.handle.stop();
            if (this.canReplace()) this.handle = undefined;
          }
        }
      }
      this.changed(this.status);
    };
    this.pending = this.pending.then(update, update);
    return this.pending;
  }
  setEnabled(enabled: boolean) {
    if (this.stopped) return this.pending;
    this.enabled = enabled; return this.apply();
  }
  renewActivity(active: boolean, ttlMs = 30_000) {
    if (this.stopped) return this.pending;
    clearTimeout(this.lease);
    const wasActive = this.activity;
    this.activity = active && Number.isInteger(ttlMs) && ttlMs > 0 && ttlMs <= 60_000;
    if (this.activity) {
      this.lease = setTimeout(() => { this.activity = false; void this.apply(); }, ttlMs);
      this.lease.unref?.();
    }
    // Heartbeats maintain the lease; they do not endlessly retry a failed helper.
    if (wasActive === this.activity) return this.pending;
    return this.apply();
  }
  async stop() {
    this.enabled = false; this.activity = false; this.stopped = true; clearTimeout(this.lease);
    await this.pending.catch(() => {});
    await this.handle?.stop();
    this.changed(this.status);
  }
}
