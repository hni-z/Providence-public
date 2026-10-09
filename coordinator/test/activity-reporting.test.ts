import test from "node:test";
import assert from "node:assert/strict";
import { startActivityReporting } from "../web/src/activity.js";
import type { ActivityReport } from "../web/src/activity.js";

type Listener = (event: { isTrusted: boolean }) => void;
class Target {
  listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener); this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: Listener) { this.listeners.get(type)?.delete(listener); }
  emit(type: string, isTrusted = true) { for (const listener of this.listeners.get(type) ?? []) listener({ isTrusted }); }
  get listenerCount() { return [...this.listeners.values()].reduce((n, listeners) => n + listeners.size, 0); }
}

function fixture({ visible = true, focused = true, sendError = false } = {}) {
  let now = 0, nextId = 0;
  const timers = new Map<number, { callback: () => void; interval: number; next: number }>();
  const document = Object.assign(new Target(), { visibilityState: visible ? "visible" : "hidden", focused, hasFocus() { return this.focused; } });
  const window = new Target();
  const reports: { body: ActivityReport; keepalive: boolean; at: number }[] = [];
  const clock = {
    now: () => now,
    setInterval(callback: () => void, interval: number) { const id = ++nextId; timers.set(id, { callback, interval, next: now + interval }); return id; },
    clearInterval(handle: unknown) { timers.delete(handle as number); },
  };
  const cleanup = startActivityReporting({
    document, window, clock, createClientId: () => "fixture-tab-id",
    send: async (body, keepalive = false) => {
      reports.push({ body, keepalive, at: now });
      if (sendError) throw new Error("Synthetic transport failure");
    },
  });
  const advance = (milliseconds: number) => {
    const target = now + milliseconds;
    while (timers.size) {
      const timer = [...timers.values()].sort((a, b) => a.next - b.next)[0];
      if (timer.next > target) break;
      now = timer.next; timer.next += timer.interval; timer.callback();
    }
    now = target;
  };
  return { document, window, reports, advance, cleanup, timers };
}

test("visible focused mount renews every 15 seconds and becomes inactive after two idle minutes", () => {
  const f = fixture();
  try {
    assert.deepEqual(f.reports, [{ body: { clientId: "fixture-tab-id", active: true }, keepalive: false, at: 0 }]);
    f.advance(120_000);
    assert.deepEqual(f.reports.map(r => [r.at, r.body.active]), [
      [0, true], [15_000, true], [30_000, true], [45_000, true], [60_000, true],
      [75_000, true], [90_000, true], [105_000, true], [120_000, false],
    ]);
    f.advance(180_000);
    assert.equal(f.reports.length, 9, "An open idle tab must not keep renewing");
  } finally { f.cleanup(); }
});

test("trusted input extends activity but input bursts remain throttled", () => {
  const f = fixture();
  try {
    f.advance(119_000);
    const count = f.reports.length;
    for (let i = 0; i < 1000; i++) f.window.emit("pointermove");
    assert.equal(f.reports.length, count);
    f.advance(1000);
    assert.deepEqual(f.reports.at(-1)?.body, { clientId: "fixture-tab-id", active: true });
    f.advance(120_000);
    assert.equal(f.reports.at(-1)?.body.active, false);
  } finally { f.cleanup(); }
});

test("synthetic input, auto-scroll and passive data updates do not extend activity", () => {
  const f = fixture();
  try {
    f.advance(119_000);
    for (const event of ["pointerdown", "pointermove", "keydown", "wheel", "touchmove", "focus"]) f.window.emit(event, false);
    f.window.emit("scroll"); // Programmatic scrolling can be browser-trusted.
    f.window.emit("message");
    f.advance(1000);
    assert.equal(f.reports.at(-1)?.body.active, false);
  } finally { f.cleanup(); }
});

test("wheel and touch scroll intent count as genuine activity", () => {
  for (const event of ["wheel", "touchmove"]) {
    const f = fixture();
    try { f.advance(119_000); f.window.emit(event); f.advance(1000); assert.equal(f.reports.at(-1)?.body.active, true); }
    finally { f.cleanup(); }
  }
});

test("hidden tabs release with keepalive and visibility alone cannot revive expired activity", () => {
  const f = fixture();
  try {
    f.document.visibilityState = "hidden"; f.document.emit("visibilitychange");
    assert.equal(f.reports.at(-1)?.body.active, false); assert.equal(f.reports.at(-1)?.keepalive, true);
    const count = f.reports.length;
    f.advance(180_000); f.window.emit("pointerdown");
    assert.equal(f.reports.length, count);
    f.document.visibilityState = "visible"; f.document.emit("visibilitychange");
    assert.equal(f.reports.length, count);
  } finally { f.cleanup(); }
});

test("blur releases activity and only trusted focus can renew it", () => {
  const f = fixture();
  try {
    f.document.focused = false; f.window.emit("blur");
    assert.equal(f.reports.at(-1)?.body.active, false); assert.equal(f.reports.at(-1)?.keepalive, true);
    const count = f.reports.length;
    f.advance(30_000); f.window.emit("keydown");
    assert.equal(f.reports.length, count);
    f.document.focused = true; f.window.emit("focus", false);
    assert.equal(f.reports.length, count);
    f.window.emit("focus");
    assert.equal(f.reports.at(-1)?.body.active, true);
  } finally { f.cleanup(); }
});

test("mounting hidden or unfocused does not create activity", () => {
  for (const options of [{ visible: false }, { focused: false }]) {
    const f = fixture(options);
    try { f.advance(30_000); assert.equal(f.reports.length, 0); }
    finally { f.cleanup(); }
  }
});

test("pagehide releases and disposal removes every timer and listener", () => {
  const f = fixture();
  f.window.emit("pagehide");
  assert.equal(f.reports.at(-1)?.body.active, false); assert.equal(f.reports.at(-1)?.keepalive, true);
  const count = f.reports.length; f.advance(60_000);
  assert.equal(f.reports.length, count);
  f.cleanup();
  assert.equal(f.reports.at(-1)?.keepalive, true);
  assert.equal(f.timers.size, 0); assert.equal(f.window.listenerCount, 0); assert.equal(f.document.listenerCount, 0);
  const afterCleanup = f.reports.length;
  f.cleanup(); f.window.emit("focus"); f.advance(60_000);
  assert.equal(f.reports.length, afterCleanup);
});

test("reporting failures remain best effort without generating retry activity", async () => {
  const f = fixture({ sendError: true });
  f.advance(120_000); f.cleanup();
  await Promise.resolve();
  assert.equal(f.reports.at(-1)?.body.active, false);
});

test("separate reporter lifetimes get separate random client identifiers", () => {
  const document = Object.assign(new Target(), { visibilityState: "visible" });
  const window = new Target();
  const ids: string[] = [];
  const options = { document, window, clock: { now: () => 0, setInterval: () => 1, clearInterval() {} }, send: async (body: ActivityReport) => { if (body.active) ids.push(body.clientId); } };
  const a = startActivityReporting(options), b = startActivityReporting(options);
  a(); b();
  assert.equal(ids.length, 2); assert.notEqual(ids[0], ids[1]);
  for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/);
});
