export type ActivityReport = { clientId: string; active: boolean };
type ActivityListener = (event: { isTrusted: boolean }) => void;
type ActivityTarget = {
  addEventListener(type: string, listener: ActivityListener, options?: { passive?: boolean }): void;
  removeEventListener(type: string, listener: ActivityListener): void;
};
export type ActivityClock = {
  now(): number;
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
};
export type ActivityReportingOptions = {
  send: (body: ActivityReport, keepalive?: boolean) => Promise<unknown>;
  document?: ActivityTarget & { readonly visibilityState: string; hasFocus?: () => boolean };
  window?: ActivityTarget;
  clock?: ActivityClock;
  createClientId?: () => string;
};

const RENEW_MS = 15_000;
const IDLE_MS = 120_000;

/** Reports bounded user activity, never task progress, polling, or permission. */
export function startActivityReporting(options: ActivityReportingOptions): () => void {
  const document = options.document ?? globalThis.document;
  const window = options.window ?? globalThis.window;
  const clock = options.clock ?? {
    now: () => Date.now(),
    setInterval: (callback: () => void, milliseconds: number) => globalThis.setInterval(callback, milliseconds),
    clearInterval: (handle: unknown) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
  };
  const clientId = (options.createClientId ?? (() => globalThis.crypto.randomUUID()))();
  let disposed = false;
  let focused = document.hasFocus?.() ?? true;
  let lastInputAt = document.visibilityState === "visible" ? clock.now() : -Infinity;
  let lastActiveAt = -Infinity;
  let reportedActive = false;
  const send = (active: boolean, keepalive = false) => {
    reportedActive = active;
    // Failed reports expire on the server; they never trigger retries or new activity.
    try { void options.send({ clientId, active }, keepalive).catch(() => {}); }
    catch { /* Activity reporting must not interrupt the client. */ }
  };
  const update = () => {
    if (disposed) return;
    const now = clock.now();
    const active = document.visibilityState === "visible" && focused && (document.hasFocus?.() ?? true) && now - lastInputAt < IDLE_MS;
    if (!active) {
      if (reportedActive) send(false);
    } else if (now - lastActiveAt >= RENEW_MS) {
      lastActiveAt = now;
      send(true);
    }
  };
  const input: ActivityListener = event => {
    if (disposed || !event.isTrusted || document.visibilityState !== "visible" || !focused || !(document.hasFocus?.() ?? true)) return;
    lastInputAt = clock.now();
    update();
  };
  const visibility: ActivityListener = () => {
    if (disposed) return;
    if (document.visibilityState !== "visible") send(false, true);
    else update(); // Becoming visible alone must not reset the idle timer.
  };
  const pagehide: ActivityListener = () => {
    if (disposed) return;
    lastInputAt = -Infinity;
    send(false, true);
  };
  const focus: ActivityListener = event => {
    if (disposed || !event.isTrusted) return;
    focused = true;
    input(event);
  };
  const blur: ActivityListener = () => {
    if (disposed) return;
    focused = false;
    send(false, true);
  };
  // A bare scroll event can result from programmatic chat auto-scroll. Observe
  // trusted input that causes scrolling instead, so passive updates stay idle.
  const inputEvents = ["pointerdown", "pointermove", "keydown", "wheel", "touchmove"];
  for (const event of inputEvents) window.addEventListener(event, input, { passive: true });
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pagehide", pagehide);
  window.addEventListener("focus", focus);
  window.addEventListener("blur", blur);
  const timer = clock.setInterval(update, RENEW_MS);
  update();
  return () => {
    if (disposed) return;
    disposed = true;
    clock.clearInterval(timer);
    for (const event of inputEvents) window.removeEventListener(event, input);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pagehide", pagehide);
    window.removeEventListener("focus", focus);
    window.removeEventListener("blur", blur);
    send(false, true);
  };
}
