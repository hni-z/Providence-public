export interface PageLifecycleHandlers {
  suspend(): void;
  resume(): void;
  dispose(): void;
}

type LifecycleTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** Bind page transitions without discarding caller-owned accepted or pending state. */
export function bindPageLifecycle(
  target: LifecycleTarget,
  handlers: PageLifecycleHandlers,
): () => void {
  let state: "active" | "suspended" | "disposed" = "active";
  const cleanup = () => {
    if (state === "disposed") return;
    // Transition and detach first, so nested callbacks cannot dispose twice or resume.
    state = "disposed";
    target.removeEventListener("pagehide", hide);
    target.removeEventListener("pageshow", show);
    handlers.dispose();
  };
  const hide: EventListener = (event) => {
    if (state === "disposed") return;
    if ((event as PageTransitionEvent).persisted !== true) {
      cleanup();
    } else if (state === "active") {
      state = "suspended";
      handlers.suspend();
    }
  };
  const show: EventListener = (event) => {
    if (state !== "suspended" || (event as PageTransitionEvent).persisted !== true) return;
    state = "active";
    handlers.resume();
  };
  target.addEventListener("pagehide", hide);
  target.addEventListener("pageshow", show);
  return cleanup;
}

export interface PollingClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultClock: PollingClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * One serial polling generation. The callback owns its read/error/state semantics.
 * Stop prevents future scheduling; it cannot cancel an already-running promise.
 * Callers must invalidate/abort stale reads before they update application state.
 */
export class PollingLoop {
  #active = false;
  #generation = 0;
  #timer?: { handle: unknown };

  constructor(
    private readonly run: () => Promise<void>,
    private readonly delayMs = 1500,
    private readonly clock: PollingClock = defaultClock,
  ) {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError("Polling delay must be a nonnegative finite number.");
  }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    const generation = ++this.#generation;
    void this.#tick(generation);
  }

  stop(): void {
    this.#active = false;
    this.#generation++;
    const timer = this.#timer;
    this.#timer = undefined;
    if (timer) this.clock.clearTimeout(timer.handle);
  }

  async #tick(generation: number): Promise<void> {
    if (!this.#active || generation !== this.#generation) return;
    try {
      await this.run();
    } catch {
      // A failed read does not spawn another loop or an unhandled rejection.
      // The caller's run callback owns visible error reporting.
    }
    if (!this.#active || generation !== this.#generation) return;
    const timer = { handle: undefined as unknown };
    this.#timer = timer;
    timer.handle = this.clock.setTimeout(() => {
      if (this.#timer === timer) this.#timer = undefined;
      if (this.#active && generation === this.#generation) void this.#tick(generation);
    }, this.delayMs);
  }
}
