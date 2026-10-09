/** A workspace's provider access ends permanently when its saved key is removed. */
export class ProviderAccess {
  private controller = new AbortController();
  constructor(private allowed: () => boolean, private upstream: typeof fetch = fetch) {}
  readonly fetch: typeof fetch = async (input, init) => {
    if (!this.allowed()) this.close();
    this.controller.signal.throwIfAborted();
    const signal = AbortSignal.any([
      this.controller.signal,
      ...(init?.signal ? [init.signal] : input instanceof Request ? [input.signal] : []),
    ]);
    signal.throwIfAborted();
    const response = await this.upstream(input, { ...init, signal, redirect: "error" });
    // A custom transport may resolve while revocation is occurring. Never return
    // that response or permit a later request from a cached speech/runtime object.
    if (!this.allowed()) this.close();
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {});
      signal.throwIfAborted();
    }
    return response;
  };
  close() { this.controller.abort(new Error("Providence provider access was removed")); }
}
