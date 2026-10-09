/** Ephemeral activity, not analytics. No heartbeat or task demand survives its deadline/restart. */
export class ActivityLeases {
  private clients = new Map<string, number>();
  private graceUntil = 0;
  constructor(private now = Date.now) {}
  touch(client: string, active: boolean) {
    this.prune();
    if (!active) { this.clients.delete(client); return; }
    if (!this.clients.has(client) && this.clients.size >= 100) throw new Error('Too many active clients');
    this.clients.set(client, this.now() + 30_000);
    this.graceUntil = this.now() + 30_000;
  }
  wanted(runningWork = false) {
    this.prune();
    if (runningWork) this.graceUntil = this.now() + 30_000;
    return runningWork || this.clients.size > 0 || this.now() < this.graceUntil;
  }
  private prune() {
    for (const [id, until] of this.clients) if (until <= this.now()) this.clients.delete(id);
  }
}
