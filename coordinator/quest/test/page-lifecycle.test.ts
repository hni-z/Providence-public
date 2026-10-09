import { test } from "node:test";
import assert from "node:assert/strict";
import { bindPageLifecycle, PollingLoop, type PollingClock } from "../src/page-lifecycle";

class FakeTarget {
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (!listener) return;
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener); this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (listener) this.listeners.get(type)?.delete(listener);
  }
  emit(type: "pagehide" | "pageshow", persisted: boolean): void {
    const event = new Event(type);
    Object.defineProperty(event, "persisted", { value: persisted });
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }
  get listenerCount(): number { return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0); }
}

class FakeClock implements PollingClock {
  next = 0;
  readonly timers = new Map<number, { callback: () => void; delayMs: number }>();
  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.next; this.timers.set(id, { callback, delayMs }); return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  fireNext(): () => void {
    const [id, timer] = [...this.timers][0] ?? [];
    assert.ok(timer, "Expected one scheduled timer");
    this.timers.delete(id); timer.callback(); return timer.callback;
  }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function pending() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("persisted hide/show suspends and resumes once per transition, including nested duplicates", () => {
  const target = new FakeTarget();
  const calls: string[] = [];
  const cleanup = bindPageLifecycle(target, {
    suspend: () => { calls.push("suspend"); target.emit("pagehide", true); },
    resume: () => { calls.push("resume"); target.emit("pageshow", true); },
    dispose: () => { calls.push("dispose"); target.emit("pagehide", false); },
  });
  target.emit("pageshow", false);
  target.emit("pageshow", true);
  assert.deepEqual(calls, []);
  target.emit("pagehide", true); target.emit("pagehide", true);
  target.emit("pageshow", false);
  assert.deepEqual(calls, ["suspend"]);
  target.emit("pageshow", true); target.emit("pageshow", true);
  assert.deepEqual(calls, ["suspend", "resume"]);
  target.emit("pagehide", true); target.emit("pageshow", true);
  assert.deepEqual(calls, ["suspend", "resume", "suspend", "resume"]);
  cleanup(); cleanup();
  assert.deepEqual(calls, ["suspend", "resume", "suspend", "resume", "dispose"]);
  assert.equal(target.listenerCount, 0);
});

test("nonpersisted pagehide finalizes once and can never resume", () => {
  const target = new FakeTarget();
  const calls: string[] = [];
  const cleanup = bindPageLifecycle(target, {
    suspend: () => calls.push("suspend"), resume: () => calls.push("resume"),
    dispose: () => { calls.push("dispose"); target.emit("pageshow", true); cleanup(); },
  });
  target.emit("pagehide", true);
  target.emit("pagehide", false); target.emit("pagehide", false);
  target.emit("pageshow", true); target.emit("pagehide", true);
  cleanup();
  assert.deepEqual(calls, ["suspend", "dispose"]);
  assert.equal(target.listenerCount, 0);
});

test("cleanup nested inside suspend detaches both handlers before final disposal", () => {
  const target = new FakeTarget();
  let suspended = 0, resumed = 0, disposed = 0;
  const cleanup = bindPageLifecycle(target, {
    suspend: () => { suspended++; cleanup(); target.emit("pageshow", true); },
    resume: () => { resumed++; },
    dispose: () => { disposed++; cleanup(); },
  });
  target.emit("pagehide", true);
  target.emit("pageshow", true);
  cleanup();
  assert.deepEqual([suspended, resumed, disposed], [1, 0, 1]);
  assert.equal(target.listenerCount, 0);
});

test("poll start is idempotent and schedules one serial read after the default delay", async () => {
  const clock = new FakeClock(), read = pending();
  let calls = 0;
  const loop = new PollingLoop(() => { calls++; return calls === 1 ? read.promise : Promise.resolve(); }, undefined, clock);
  loop.start(); loop.start();
  assert.equal(calls, 1);
  assert.equal(clock.timers.size, 0);
  read.resolve(); await flush();
  assert.equal(clock.timers.size, 1);
  assert.equal([...clock.timers.values()][0].delayMs, 1500);
  loop.start(); assert.equal(calls, 1);
  clock.fireNext(); await flush();
  assert.equal(calls, 2); assert.equal(clock.timers.size, 1);
  loop.stop(); loop.stop();
  assert.equal(clock.timers.size, 0);
});

test("stop during an in-flight read prevents its completion from scheduling anything", async () => {
  const clock = new FakeClock(), read = pending();
  let calls = 0;
  const loop = new PollingLoop(() => { calls++; return read.promise; }, 20, clock);
  loop.start(); loop.stop();
  read.resolve(); await flush();
  assert.equal(calls, 1); assert.equal(clock.timers.size, 0);
});

test("restart begins a fresh generation while an older read remains pending", async () => {
  const clock = new FakeClock(), oldRead = pending(), freshRead = pending();
  let calls = 0;
  const loop = new PollingLoop(() => { calls++; return calls === 1 ? oldRead.promise : freshRead.promise; }, 30, clock);
  loop.start(); loop.stop(); loop.start(); loop.start();
  assert.equal(calls, 2);
  oldRead.resolve(); await flush();
  assert.equal(clock.timers.size, 0);
  freshRead.resolve(); await flush();
  assert.equal(clock.timers.size, 1);
  loop.stop();
});

test("a cleared stale timer cannot run or replace the restarted loop's timer", async () => {
  const clock = new FakeClock();
  let calls = 0;
  const loop = new PollingLoop(async () => { calls++; }, 40, clock);
  loop.start(); await flush();
  const stale = [...clock.timers.values()][0].callback;
  loop.stop(); loop.start(); await flush();
  const freshId = [...clock.timers.keys()][0];
  stale(); await flush();
  assert.equal(calls, 2);
  assert.deepEqual([...clock.timers.keys()], [freshId]);
  loop.stop();
});

test("read rejection leaves one next poll and does not escape as an unhandled rejection", async () => {
  const clock = new FakeClock();
  let calls = 0;
  const loop = new PollingLoop(async () => { calls++; throw new Error("Mock read failure"); }, 50, clock);
  loop.start(); await flush();
  assert.equal(calls, 1); assert.equal(clock.timers.size, 1);
  clock.fireNext(); await flush();
  assert.equal(calls, 2); assert.equal(clock.timers.size, 1);
  loop.stop();
});

test("BFCache away/back retains accepted and pending UI objects without dispatching", async () => {
  const target = new FakeTarget(), clock = new FakeClock(), oldRead = pending(), resumedRead = pending();
  const accepted = { taskId: "accepted-task", chatId: "master" };
  const pendingSubmission = { requestId: "uncertain-request", chatId: "device-chat", text: "Original text" };
  const state = { accepted, pendingSubmission, visible: true };
  let reads = 0, dispatches = 0, disposed = 0;
  const dispatch = () => { dispatches++; };
  const loop = new PollingLoop(() => { reads++; return reads === 1 ? oldRead.promise : resumedRead.promise; }, 10, clock);
  const cleanup = bindPageLifecycle(target, {
    suspend: () => { state.visible = false; loop.stop(); },
    resume: () => { state.visible = true; loop.start(); },
    dispose: () => { disposed++; loop.stop(); },
  });
  // Dispatch remains explicitly separate from lifecycle handlers and read polling.
  void dispatch;
  loop.start(); target.emit("pagehide", true); target.emit("pageshow", true);
  assert.equal(reads, 2);
  assert.equal(state.accepted, accepted); assert.equal(state.pendingSubmission, pendingSubmission);
  assert.equal(state.pendingSubmission.text, "Original text");
  oldRead.resolve(); await flush();
  assert.equal(clock.timers.size, 0);
  resumedRead.resolve(); await flush();
  assert.equal(clock.timers.size, 1);
  cleanup(); target.emit("pageshow", true);
  assert.equal(disposed, 1); assert.equal(dispatches, 0);
  assert.equal(clock.timers.size, 0); assert.equal(target.listenerCount, 0);
});

test("final disposal during a read prevents late timer resurrection", async () => {
  const target = new FakeTarget(), clock = new FakeClock(), read = pending();
  let resumed = 0, disposed = 0;
  const loop = new PollingLoop(() => read.promise, 10, clock);
  const cleanup = bindPageLifecycle(target, {
    suspend: () => loop.stop(), resume: () => { resumed++; loop.start(); },
    dispose: () => { disposed++; loop.stop(); },
  });
  loop.start(); target.emit("pagehide", false); target.emit("pageshow", true);
  read.resolve(); await flush(); cleanup();
  assert.equal(disposed, 1); assert.equal(resumed, 0);
  assert.equal(clock.timers.size, 0); assert.equal(target.listenerCount, 0);
});
