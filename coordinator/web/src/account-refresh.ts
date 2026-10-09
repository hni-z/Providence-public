export const ACCOUNT_REFRESH_MS = 12_000;
type Events = {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};
export type AccountRefreshOptions = {
  refresh(signal: AbortSignal): Promise<void>;
  authenticated(): boolean;
  busy(): boolean;
  document?: Events & { readonly visibilityState: string };
  window?: Events;
  clock?: { setInterval(callback: () => void, milliseconds: number): unknown; clearInterval(handle: unknown): void };
  onDispose?(): void;
};

/** Read-only refresh scheduling. It does not report or synthesize user activity. */
export function startAccountRefresh(options: AccountRefreshOptions) {
  const document = options.document ?? globalThis.document;
  const window = options.window ?? globalThis.window;
  const clock = options.clock ?? {
    setInterval: (callback: () => void, milliseconds: number) => globalThis.setInterval(callback, milliseconds),
    clearInterval: (handle: unknown) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
  };
  let disposed = false, pending: AbortController | undefined;
  const request = () => {
    if (disposed || pending || document.visibilityState !== "visible" || !options.authenticated() || options.busy()) return;
    const controller = new AbortController(); pending = controller;
    void Promise.resolve().then(() => {
      if (!disposed && !controller.signal.aborted && document.visibilityState === "visible" && options.authenticated() && !options.busy())
        return options.refresh(controller.signal);
    }).catch(() => {
      // Keep the last view on transient errors; the next normal tick can retry.
    }).finally(() => { if (pending === controller) pending = undefined; });
  };
  const visibility = () => {
    if (document.visibilityState !== "visible") pending?.abort();
    else request();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; pending?.abort();
    clock.clearInterval(timer);
    window.removeEventListener("focus", request);
    window.removeEventListener("pagehide", dispose);
    document.removeEventListener("visibilitychange", visibility);
    options.onDispose?.();
  };
  const timer = clock.setInterval(request, ACCOUNT_REFRESH_MS);
  window.addEventListener("focus", request);
  window.addEventListener("pagehide", dispose);
  document.addEventListener("visibilitychange", visibility);
  return { request, dispose };
}

/** The connection heartbeat changes continuously without changing the account UI. */
export function accountRefreshIdentity(value: unknown): string {
  const stable = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === "object") return Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== "lastSeenAt").sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]),
    );
    return input;
  };
  return JSON.stringify(stable(value));
}

export function accountViewIsInteractive(root: HTMLElement, document: Document): boolean {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && root.contains(focused)) {
    if (focused.isContentEditable) return true;
    if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
      if (!focused.readOnly || focused.selectionStart !== focused.selectionEnd) return true;
    }
    if (focused instanceof HTMLSelectElement) return true;
  }
  const selection = document.getSelection();
  return !!selection && !selection.isCollapsed && !!selection.anchorNode && root.contains(selection.anchorNode);
}

/** Retain reading position; account-scoped outputs are not carried across refreshes. */
export function preserveAccountView(root: HTMLElement, render: () => void, document: Document = globalThis.document, window: Window = globalThis.window, outputIds: string[] = []) {
  const detailKey = (detail: HTMLDetailsElement, index: number) => {
    const computer = detail.closest("[data-device-id]")?.getAttribute("data-device-id");
    const summary = detail.querySelector("summary")?.textContent ?? "";
    return computer ? `device:${computer}:${summary}` : detail.id || summary || `detail:${index}`;
  };
  const details = new Map(Array.from(root.querySelectorAll("details"), (detail, index) => [detailKey(detail, index), detail.open]));
  const focused = document.hasFocus() && document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : undefined;
  const focusId = focused?.id;
  const focusDevice = focused?.getAttribute("data-remove-device");
  const focusDetail = focused?.tagName === "SUMMARY" ? focused.closest("details") : undefined;
  const focusDetailKey = focusDetail ? detailKey(focusDetail, Array.from(root.querySelectorAll("details")).indexOf(focusDetail)) : undefined;
  const selection = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
    ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection } : undefined;
  const outputs = outputIds.map(id => [id, document.getElementById(id)?.textContent] as const);
  const scroll = { x: window.scrollX, y: window.scrollY };
  render();
  root.querySelectorAll("details").forEach((detail, index) => { const open = details.get(detailKey(detail, index)); if (open !== undefined) detail.open = open; });
  for (const [id, text] of outputs) { const element = document.getElementById(id); if (element && text) element.textContent = text; }
  if (focusId || focusDevice || focusDetailKey) {
    const next = focusId ? document.getElementById(focusId) : focusDevice
      ? Array.from(root.querySelectorAll<HTMLButtonElement>("[data-remove-device]")).find(button => button.getAttribute("data-remove-device") === focusDevice)
      : Array.from(root.querySelectorAll("details")).find((detail, index) => detailKey(detail, index) === focusDetailKey)?.querySelector("summary");
    next?.focus({ preventScroll: true });
    if (selection && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement))
      next.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
  }
  window.scrollTo(scroll.x, scroll.y);
}
