import type { KeepAwakeState } from "./device-config.js";
import { runtimeOfflineEvent } from "./connection-status.js";

/** One owned runtime/socket generation. Reconnection never repeats a task request. */
export interface CompanionRuntime {
  start(): Promise<unknown>;
  stopAndWait(timeoutMs?: number): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}
export interface CompanionSocket {
  readyState: number;
  send(data: string, callback?: (error?: Error) => void): void;
  ping(data?: string): void;
  terminate(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}
export interface ConnectionClock {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(timer: unknown): void;
}
export type ConnectionStatus = {
  phase: "starting" | "connecting" | "awaiting_ack" | "connected" | "legacy_connected" | "retiring" | "retrying" | "action_required" | "stopped";
  reason?: string;
  retryInMs?: number;
  help?: string;
};
const systemClock: ConnectionClock = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Runtime currently exposes startup errors as Error messages, not typed codes.
 * Match only known transient categories. Never print the original diagnostics.
 */
export function startupFailure(error: unknown): "transient" | "action_required" {
  const message = error instanceof Error ? error.message : "";
  const code = error && typeof error === "object" ? String((error as { code?: unknown }).code ?? "") : "";
  if (/login|sign.in|unauthorized|authenticat|credential|permission|not permitted|not supported|not advertised|not available|model catalog|no fallback|must be|invalid|ENOENT|EACCES/i.test(message)
      || ["ENOENT", "EACCES", "EPERM"].includes(code)) return "action_required";
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENOTFOUND", "ENETUNREACH"].includes(code)
      || /Codex timeout:|Codex exited \(|Codex is not connected|network|connection (?:reset|refused|closed)|timed? ?out/i.test(message)) return "transient";
  return "action_required";
}

/** Fixed, nonsecret instructions for known setup failures; never echo provider diagnostics. */
export function startupGuidance(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : "";
  if (/Run codex login|unauthorized|authenticat|credential/i.test(message))
    return "Sign in to Codex on this computer, then run the Providence setup command again. Your existing device pairing will be reused.";
  if (/full-access profile is not permitted|did not confirm.*permissions/i.test(message))
    return "This Codex runtime does not permit the requested full access. Review its permission settings locally; Providence cannot grant that access itself.";
  if (/model catalog|Providence (?:model|reasoning effort|service tier)|configured Providence model/i.test(message))
    return "Your Codex runtime or account does not support Providence's configured model profile. Check Codex updates and model availability on this computer before reconnecting.";
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === "ENOENT" || code === "EACCES")
    return "The configured Codex executable could not start. Run the Providence installer again to check this computer's installation.";
  return undefined;
}

function unauthorized(event: any): boolean {
  return event?.providerErrorCode === "unauthorized" ||
    (typeof event?.error === "string" && /^(?:401 Unauthorized(?:[.: ]|$)|Your authentication token (?:has expired|is no longer valid)(?:[.: ]|$))/.test(event.error));
}

type Attempt<R extends CompanionRuntime> = {
  runtime: R;
  socket?: CompanionSocket;
  ready: boolean;
  starting: boolean;
  awaitingPong: boolean;
  stable: boolean;
  retiring: boolean;
  retirement?: Promise<void>;
  terminalReason?: string;
  timers: Set<unknown>;
  handlers: Array<[string, (...args: any[]) => void]>;
  event: (...args: any[]) => void;
};

export class CompanionConnection<R extends CompanionRuntime> {
  private current?: Attempt<R>;
  private retry?: unknown;
  private stopped = true;
  private shutdownFailed = false;
  private stopping?: Promise<void>;
  private failures = 0;
  private readonly clock: ConnectionClock;
  constructor(private readonly options: {
    deviceId: string;
    createRuntime: () => R;
    createSocket: () => CompanionSocket;
    metadata: (runtime: R) => unknown;
    request: (runtime: R, method: string, params: unknown) => Promise<unknown>;
    status: (status: ConnectionStatus) => void;
    activity?: (active: boolean, ttlMs: number) => void;
    clock?: ConnectionClock;
    allowLegacyReady?: boolean;
    heartbeatMs?: number;
    pongTimeoutMs?: number;
    ackTimeoutMs?: number;
    stableMs?: number;
    startupTimeoutMs?: number;
  }) { this.clock = options.clock ?? systemClock; }

  start(): void {
    if (!this.stopped || this.current || this.stopping || this.shutdownFailed) return;
    this.stopped = false;
    this.failures = 0;
    void this.begin();
  }
  reportKeepAwake(state: KeepAwakeState): void {
    const attempt = this.current;
    if (attempt?.ready && this.owns(attempt)) this.send(attempt, { kind: "power_state", keepAwake: state });
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    if (this.retry !== undefined) this.clock.clearTimeout(this.retry);
    this.retry = undefined;
    const retirement = this.current ? this.dispose(this.current) : Promise.resolve();
    this.stopping = retirement.then(() => {
      if (this.shutdownFailed) throw new Error("Runtime shutdown was not confirmed.");
      this.report({ phase: "stopped" });
    });
    return this.stopping;
  }
  private report(status: ConnectionStatus) { this.options.status(status); }
  private owns(attempt: Attempt<R>) { return !this.stopped && this.current === attempt && !attempt.retiring; }
  private later(attempt: Attempt<R>, callback: () => void, ms: number) {
    const timer = this.clock.setTimeout(() => {
      attempt.timers.delete(timer);
      if (this.owns(attempt)) callback();
    }, ms);
    attempt.timers.add(timer);
    return timer;
  }
  private clear(attempt: Attempt<R>, timer: unknown) {
    this.clock.clearTimeout(timer);
    attempt.timers.delete(timer);
  }
  private dispose(attempt: Attempt<R>): Promise<void> {
    if (attempt.retirement) return attempt.retirement;
    attempt.retiring = true;
    for (const timer of attempt.timers) this.clock.clearTimeout(timer);
    attempt.timers.clear();
    attempt.runtime.off("event", attempt.event);
    if (attempt.socket) {
      // Retain the inert error listener until the socket dies: ws can emit an
      // asynchronous error after termination. All other handlers are detached.
      for (const [event, handler] of attempt.handlers)
        if (event !== "error") attempt.socket.off(event, handler);
      try { attempt.socket.terminate(); } catch { /* Own socket only. */ }
    }
    let shutdown: Promise<void>;
    try { shutdown = attempt.runtime.stopAndWait(); }
    catch { shutdown = Promise.reject(new Error("Runtime shutdown was not confirmed.")); }
    attempt.retirement = shutdown.then(() => {
      if (this.current === attempt) this.current = undefined;
    }, () => {
      this.shutdownFailed = true;
      this.stopped = true;
      this.report({ phase: "action_required", reason: "runtime_shutdown_unconfirmed" });
      throw new Error("Runtime shutdown was not confirmed.");
    });
    return attempt.retirement;
  }
  private finish(attempt: Attempt<R> | undefined, reason: string, terminal: boolean, help?: string) {
    if (this.stopped || (attempt && !this.owns(attempt))) return;
    if (attempt?.terminalReason) { reason = attempt.terminalReason; terminal = true; }
    this.report({ phase: "retiring", reason });
    const retirement = attempt ? this.dispose(attempt) : Promise.resolve();
    void retirement.then(() => {
      if (this.stopped) return;
      this.afterRetirement(reason, terminal, help);
    }, () => { /* dispose reports a fixed terminal failure; never retry. */ });
  }
  private afterRetirement(reason: string, terminal: boolean, help?: string) {
    if (terminal) {
      this.stopped = true;
      this.report({ phase: "action_required", reason, ...(help ? { help } : {}) });
      return;
    }
    if (this.retry !== undefined) return;
    const retryInMs = Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5));
    this.report({ phase: "retrying", reason, retryInMs });
    this.retry = this.clock.setTimeout(() => {
      this.retry = undefined;
      if (!this.stopped) void this.begin();
    }, retryInMs);
  }
  private async begin() {
    if (this.stopped || this.current || this.shutdownFailed) return;
    this.report({ phase: "starting" });
    let runtime: R;
    try { runtime = this.options.createRuntime(); }
    catch (error) { this.finish(undefined, "runtime_configuration", startupFailure(error) !== "transient", startupGuidance(error)); return; }
    const attempt: Attempt<R> = { runtime, ready: false, starting: true, awaitingPong: false, stable: false, retiring: false,
      timers: new Set(), handlers: [], event: () => {} };
    this.current = attempt;
    attempt.event = (event: any) => {
      if (!this.owns(attempt) || attempt.terminalReason) return;
      if (event?.type === "task.failed" && unauthorized(event)) {
        this.runtimeUnavailable(attempt, "provider_auth_required", true, event);
        return;
      }
      if (event?.type === "runtime.offline") {
        const terminal = startupFailure(new Error(typeof event.error === "string" ? event.error : "")) !== "transient";
        if (!attempt.starting || terminal) {
          const auth = unauthorized(event) || (typeof event.error === "string" && /login|sign.in|unauthorized|authenticat|credential|access token/i.test(event.error));
          this.runtimeUnavailable(attempt, auth ? "provider_auth_required" : terminal ? "runtime_action_required" : "runtime_exited", terminal || auth);
        }
        return;
      }
      if (attempt.ready) this.send(attempt, { kind: "event", event });
    };
    runtime.on("event", attempt.event);
    const startup = this.later(attempt, () => this.finish(attempt, "runtime_start_timeout", false), this.options.startupTimeoutMs ?? 65_000);
    try { await runtime.start(); }
    catch (error) {
      if (this.owns(attempt)) this.finish(attempt, "runtime_start_failed", startupFailure(error) !== "transient", startupGuidance(error));
      return;
    }
    if (!this.owns(attempt)) return;
    attempt.starting = false;
    this.clear(attempt, startup);
    this.report({ phase: "connecting" });
    try {
      const socket = this.options.createSocket();
      attempt.socket = socket;
      const on = (event: string, handler: (...args: any[]) => void) => {
        attempt.handlers.push([event, handler]); socket.on(event, handler);
      };
      on("error", () => {
        // ws guarantees close after error. Do not race an HTTP/protocol close
        // classification by scheduling a retry from the raw error first.
      });
      on("unexpected-response", (_request, response) => {
        response.resume();
        const status = response.statusCode;
        const transient = [408, 425, 429].includes(status) || (status >= 500 && status <= 599);
        this.finish(attempt, status === 401 || status === 403 ? "credential_rejected" : "handshake_rejected", !transient);
      });
      on("close", (code: number) => this.finish(attempt, code === 1008 ? "registration_or_protocol_rejected" : "connection_closed",
        ![1000, 1001, 1006, 1011, 1012, 1013].includes(code)));
      on("pong", () => {
        if (this.owns(attempt) && attempt.awaitingPong) {
          attempt.awaitingPong = false;
          if (attempt.stable) this.failures = 0;
        }
      });
      on("message", (raw) => { void this.message(attempt, raw); });
      on("open", () => {
        if (!this.owns(attempt)) return;
        this.clear(attempt, opening);
        this.report({ phase: "awaiting_ack" });
        try { this.send(attempt, { kind: "ready", capabilities: { readyAck: true, powerActivity: true }, metadata: this.options.metadata(runtime) }); }
        catch { this.finish(attempt, "runtime_metadata_invalid", true); return; }
        if (!this.owns(attempt)) return;
        if (this.options.allowLegacyReady) this.ready(attempt, true);
        else this.later(attempt, () => {
          if (!attempt.ready) this.finish(attempt, "ready_timeout", false);
        }, this.options.ackTimeoutMs ?? 15_000);
      });
      const opening = this.later(attempt, () => this.finish(attempt, "connection_timeout", false), 15_000);
    } catch { this.finish(attempt, "socket_setup_failed", true); }
  }
  private runtimeUnavailable(attempt: Attempt<R>, reason: string, terminal: boolean, failedTask?: unknown) {
    if (terminal) attempt.terminalReason = reason;
    if (attempt.ready && attempt.socket?.readyState === 1) {
      if (failedTask) this.send(attempt, { kind: "event", event: failedTask });
      // Give the owned transport a bounded chance to report interruption before
      // retirement. Never accept another task once an action-required error appears.
      this.later(attempt, () => this.finish(attempt, reason, terminal), 1000);
      this.send(attempt, { kind: "event", event: runtimeOfflineEvent({
        reasonCode: reason === "provider_auth_required" ? "authentication_required" : terminal ? "configuration_required" : "runtime_stopped",
        ...(reason === "provider_auth_required" ? { providerErrorCode: "unauthorized" } : {}),
      }) },
      () => this.finish(attempt, reason, terminal));
    } else this.finish(attempt, reason, terminal);
  }
  private send(attempt: Attempt<R>, value: unknown, completed?: () => void) {
    if (!this.owns(attempt) || attempt.socket?.readyState !== 1) return;
    try {
      attempt.socket.send(JSON.stringify(value), error => {
        if (error && this.owns(attempt)) this.finish(attempt, "socket_write_failed", false);
        else if (this.owns(attempt)) completed?.();
      });
    } catch { this.finish(attempt, "socket_write_failed", false); }
  }
  private ready(attempt: Attempt<R>, legacy = false) {
    if (!this.owns(attempt) || attempt.ready) return;
    attempt.ready = true;
    this.report({ phase: legacy ? "legacy_connected" : "connected" });
    this.later(attempt, () => {
      attempt.stable = true;
      if (!attempt.awaitingPong) this.failures = 0;
    }, this.options.stableMs ?? 60_000);
    const heartbeat = () => {
      if (!this.owns(attempt)) return;
      attempt.awaitingPong = true;
      try { attempt.socket!.ping(); }
      catch { this.finish(attempt, "heartbeat_write_failed", false); return; }
      this.later(attempt, () => {
        if (attempt.awaitingPong) this.finish(attempt, "heartbeat_timeout", false);
        else this.later(attempt, heartbeat, this.options.heartbeatMs ?? 15_000);
      }, this.options.pongTimeoutMs ?? 15_000);
    };
    this.later(attempt, heartbeat, this.options.heartbeatMs ?? 15_000);
  }
  private async message(attempt: Attempt<R>, raw: { toString(): string }) {
    if (!this.owns(attempt) || attempt.terminalReason) return;
    let value: any;
    try { value = JSON.parse(raw.toString()); }
    catch { this.finish(attempt, "invalid_protocol_message", true); return; }
    if (value?.kind === "power_lease" && attempt.ready) {
      if (typeof value.active !== "boolean" || !Number.isInteger(value.ttlMs) || value.ttlMs < 1 || value.ttlMs > 60_000) {
        this.finish(attempt, "invalid_protocol_message", true); return;
      }
      this.options.activity?.(value.active, value.ttlMs); return;
    }
    if (value?.kind === "ready_ack") {
      if (value.deviceId !== this.options.deviceId) this.finish(attempt, "ready_ack_mismatch", true);
      else this.ready(attempt);
      return;
    }
    if (!attempt.ready || value?.kind !== "request" || typeof value.id !== "string" || typeof value.method !== "string") {
      this.finish(attempt, "invalid_protocol_message", true); return;
    }
    try {
      const result = await this.options.request(attempt.runtime, value.method, value.params);
      this.send(attempt, { kind: "response", id: value.id, result });
    } catch (error) {
      // Preserve explicit runtime operation errors for the existing RPC caller;
      // never include arbitrary thrown objects or add them to lifecycle logs.
      this.send(attempt, { kind: "response", id: value.id,
        error: error instanceof Error ? error.message : "Device operation failed." });
    }
  }
}
