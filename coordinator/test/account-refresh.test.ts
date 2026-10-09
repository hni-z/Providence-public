import test from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_REFRESH_MS, accountRefreshIdentity, preserveAccountView, startAccountRefresh } from "../web/src/account-refresh.js";

class Target {
  visibilityState = "visible";
  listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(listener); }
  removeEventListener(type: string, listener: () => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string) { for (const listener of this.listeners.get(type) ?? []) listener(); }
  count() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture(refresh?: (signal: AbortSignal) => Promise<void>) {
  const document = new Target(), window = new Target();
  let authenticated = true, busy = false, calls = 0, disposed = false;
  const timers = new Set<() => void>();
  const control = startAccountRefresh({ document, window, authenticated: () => authenticated, busy: () => busy,
    refresh: async signal => { calls++; await refresh?.(signal); }, onDispose: () => { disposed = true; },
    clock: { setInterval(callback, ms) { assert.equal(ms, 12_000); timers.add(callback); return callback; }, clearInterval(handle) { timers.delete(handle as () => void); } },
  });
  return { document, window, control, tick: () => { for (const timer of timers) timer(); }, calls: () => calls, timers,
    setAuthenticated: (value: boolean) => { authenticated = value; }, setBusy: (value: boolean) => { busy = value; }, disposed: () => disposed };
}

test("visible authenticated accounts refresh every 12 seconds and when focus or visibility returns", async () => {
  assert.ok(ACCOUNT_REFRESH_MS >= 10_000 && ACCOUNT_REFRESH_MS <= 15_000);
  const f = fixture();
  f.tick(); await flush(); assert.equal(f.calls(), 1);
  f.window.emit("focus"); await flush(); assert.equal(f.calls(), 2);
  f.document.visibilityState = "hidden"; f.document.emit("visibilitychange"); f.tick(); await flush(); assert.equal(f.calls(), 2);
  f.document.visibilityState = "visible"; f.document.emit("visibilitychange"); await flush(); assert.equal(f.calls(), 3);
  f.control.dispose();
});

test("signed-out, hidden and interactive accounts do not poll", async () => {
  const f = fixture();
  f.setAuthenticated(false); f.tick(); f.window.emit("focus"); await flush(); assert.equal(f.calls(), 0);
  f.setAuthenticated(true); f.setBusy(true); f.tick(); f.window.emit("focus"); await flush(); assert.equal(f.calls(), 0);
  f.setBusy(false); f.document.visibilityState = "hidden"; f.tick(); await flush(); assert.equal(f.calls(), 0);
  f.document.visibilityState = "visible"; f.tick(); await flush(); assert.equal(f.calls(), 1);
  f.control.dispose();
});

test("focus and timer bursts cannot overlap a pending account load", async () => {
  let release!: () => void;
  const f = fixture(() => new Promise<void>(resolve => { release = resolve; }));
  f.tick(); await flush();
  for (let i = 0; i < 8; i++) { f.tick(); f.window.emit("focus"); f.document.emit("visibilitychange"); }
  await flush(); assert.equal(f.calls(), 1);
  release(); await flush(); f.tick(); await flush(); assert.equal(f.calls(), 2);
  release(); await flush(); f.control.dispose();
});

test("pagehide aborts pending work and tears down all refresh listeners and timers", async () => {
  let pendingSignal!: AbortSignal;
  const f = fixture(signal => new Promise<void>(resolve => { pendingSignal = signal; signal.addEventListener("abort", () => resolve(), { once: true }); }));
  f.tick(); await flush(); assert.equal(pendingSignal.aborted, false);
  f.window.emit("pagehide"); await flush();
  assert.equal(pendingSignal.aborted, true); assert.equal(f.disposed(), true);
  assert.equal(f.timers.size, 0); assert.equal(f.window.count(), 0); assert.equal(f.document.count(), 0);
  f.control.request(); f.tick(); f.window.emit("focus"); await flush(); assert.equal(f.calls(), 1);
});

test("a refresh queued immediately before editing or pagehide never starts", async () => {
  const f = fixture(); f.tick(); f.setBusy(true); await flush(); assert.equal(f.calls(), 0);
  f.setBusy(false); f.tick(); f.window.emit("pagehide"); await flush(); assert.equal(f.calls(), 0);
});

test("hidden transition cancels only the current read and normal refresh resumes later", async () => {
  const signals: AbortSignal[] = [];
  const f = fixture(signal => new Promise<void>(resolve => { signals.push(signal); signal.addEventListener("abort", () => resolve(), { once: true }); }));
  f.tick(); await flush(); f.document.visibilityState = "hidden"; f.document.emit("visibilitychange"); await flush();
  assert.equal(signals[0].aborted, true); assert.equal(f.disposed(), false);
  f.document.visibilityState = "visible"; f.document.emit("visibilitychange"); await flush(); assert.equal(f.calls(), 2);
  f.control.dispose(); await flush();
});

test("a failed read does not create retry loops or stop the next normal tick", async () => {
  const f = fixture(async () => { throw new Error("Network unavailable"); });
  f.tick(); await flush(); assert.equal(f.calls(), 1);
  await flush(); assert.equal(f.calls(), 1);
  f.tick(); await flush(); assert.equal(f.calls(), 2); f.control.dispose();
});

test("heartbeat timestamp and object-key order do not change the rendered account identity", () => {
  const baseline = { state: { authenticated: true, keyConfigured: false }, devices: [{ id: "laptop", online: false, connectionStatus: { state: "offline", lastSeenAt: "old" } }] };
  const heartbeat = { devices: [{ connectionStatus: { lastSeenAt: "new", state: "offline" }, online: false, id: "laptop" }], state: { keyConfigured: false, authenticated: true } };
  assert.equal(accountRefreshIdentity(baseline), accountRefreshIdentity(heartbeat));
  assert.notEqual(accountRefreshIdentity(baseline), accountRefreshIdentity({ ...baseline, state: { ...baseline.state, keyConfigured: true } }));
  assert.notEqual(accountRefreshIdentity(baseline), accountRefreshIdentity({ ...baseline, devices: [{ ...baseline.devices[0], online: true }] }));
  assert.notEqual(accountRefreshIdentity(baseline), accountRefreshIdentity({ ...baseline, devices: [...baseline.devices, { id: "second" }] }));
});

test("status refresh listens only to lifecycle signals and cannot synthesize user activity", async () => {
  const f = fixture();
  assert.deepEqual([...f.window.listeners.keys()].sort(), ["focus", "pagehide"]);
  assert.deepEqual([...f.document.listeners.keys()], ["visibilitychange"]);
  f.window.emit("pointerdown"); f.window.emit("keydown"); await flush(); assert.equal(f.calls(), 0);
  f.tick(); await flush(); assert.equal(f.calls(), 1); f.control.dispose();
});

test("editing, selected commands and selected page text defer automatic rendering", async t => {
  const { accountViewIsInteractive } = await import("../web/src/account-refresh.js");
  class Element { isContentEditable = false; }
  class Input extends Element { readOnly = false; selectionStart = 0; selectionEnd = 0; }
  class Textarea extends Input {}
  class Select extends Element {}
  const globals = { HTMLElement: Element, HTMLInputElement: Input, HTMLTextAreaElement: Textarea, HTMLSelectElement: Select };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => { for (const key of Object.keys(globals)) { const descriptor = previous[key]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  const outside = new Element(), input = new Input(), command = new Textarea(); command.readOnly = true;
  let selection = { isCollapsed: true, anchorNode: input };
  const root = { contains: (node: unknown) => node !== outside } as HTMLElement;
  const document = { activeElement: input as Element, getSelection: () => selection } as unknown as Document;
  const focus = (element: Element) => { Object.defineProperty(document, "activeElement", { configurable: true, value: element }); };
  assert.equal(accountViewIsInteractive(root, document), true);
  focus(command); assert.equal(accountViewIsInteractive(root, document), false);
  command.selectionEnd = 10; assert.equal(accountViewIsInteractive(root, document), true);
  focus(new Select()); assert.equal(accountViewIsInteractive(root, document), true);
  const editable = new Element(); editable.isContentEditable = true; focus(editable); assert.equal(accountViewIsInteractive(root, document), true);
  focus(outside); selection = { isCollapsed: false, anchorNode: input }; assert.equal(accountViewIsInteractive(root, document), true);
  selection = { isCollapsed: false, anchorNode: outside as Input }; assert.equal(accountViewIsInteractive(root, document), false);
});

test("a refreshed account never inherits the old account's pairing code or action status", t => {
  let focused: Element | undefined;
  class Element {
    tagName = "DIV";
    textContent = "";
    constructor(public id = "") {}
    getAttribute() { return null; }
    closest() { return null; }
    focus() { focused = this; }
  }
  class Input extends Element {
    selectionStart = 0; selectionEnd = 0; selectionDirection = "none";
    setSelectionRange(start: number, end: number, direction: string) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  }
  class Textarea extends Input {}
  class Details extends Element {
    open = false;
    summary = Object.assign(new Element(), { textContent: "Background startup and sleep" });
    querySelector() { return this.summary; }
  }
  const globals = { HTMLElement: Element, HTMLInputElement: Input, HTMLTextAreaElement: Textarea };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => { for (const key of Object.keys(globals)) { const descriptor = previous[key]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

  const view = () => ({ status: new Element("status"), code: new Element("watch-code"), command: new Textarea("install-command"), details: new Details("device-guide") });
  let current = view();
  current.status.textContent = "Account A's key was connected.";
  current.code.textContent = "ACCOUNT-A-CODE";
  current.details.open = true;
  current.command.selectionStart = 2; current.command.selectionEnd = 12; current.command.selectionDirection = "forward";
  const originalCommand = current.command;
  const document = { hasFocus: () => true, activeElement: originalCommand,
    getElementById: (id: string) => Object.values(current).find(element => element.id === id) ?? null } as unknown as Document;
  const root = { contains: (element: unknown) => Object.values(current).includes(element as Element),
    querySelectorAll: (selector: string) => selector === "details" ? [current.details] : [] } as unknown as HTMLElement;
  let restoredScroll: number[] = [];
  const window = { scrollX: 0, scrollY: 240, scrollTo: (x: number, y: number) => { restoredScroll = [x, y]; } } as unknown as Window;

  // Rendering the next snapshot replaces the DOM and deliberately creates empty
  // account-specific outputs, as happens if another tab changes the sign-in.
  preserveAccountView(root, () => { current = view(); }, document, window);
  assert.equal(current.status.textContent, "");
  assert.equal(current.code.textContent, "");
  assert.equal(current.details.open, true);
  assert.equal(focused, current.command);
  assert.deepEqual([current.command.selectionStart, current.command.selectionEnd, current.command.selectionDirection], [2, 12, "forward"]);
  assert.deepEqual(restoredScroll, [0, 240]);
});
