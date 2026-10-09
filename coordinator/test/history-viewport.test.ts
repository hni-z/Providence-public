import test from "node:test";
import assert from "node:assert/strict";
import { HistoryViewport, captureHistoryAnchor, restoreHistoryAnchor, applyHistoryScrollIntent } from "../web/src/history-viewport.js";
const ids = (first: number, last: number) => Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => `task-${first + index}`);
const reading = { scrollTop: 100, scrollHeight: 1000, clientHeight: 300 };

test("empty-to-loaded and every context change land once at the last thirty available messages", () => {
  const history = new HistoryViewport();
  assert.equal(history.window("A", []).visibleCount, 0);
  assert.equal(history.takeScrollIntent().kind, "none");
  const initial = history.window("A", ids(1, 200));
  assert.deepEqual(initial.ids, ids(171, 200)); assert.equal(initial.availableCount, 200);
  assert.deepEqual(history.takeScrollIntent(), { kind: "bottom", behavior: "auto" });
  assert.equal(history.takeScrollIntent().kind, "none");
  history.pauseFollowing(); history.loadOlder({ scrollTop: 100, markers: [] });
  assert.equal(history.window("A", ids(1, 200)).visibleCount, 60);
  assert.deepEqual(history.window("B", ids(1, 40)).ids, ids(11, 40));
  assert.deepEqual(history.takeScrollIntent(), { kind: "bottom", behavior: "auto" });
});

test("a reader's window is frozen across appends, while bottom readers follow without growing the render budget", () => {
  const history = new HistoryViewport();
  history.window("A", ids(1, 200)); history.takeScrollIntent();
  assert.equal(history.observeScroll(reading), true);
  const paused = history.window("A", ids(1, 203));
  assert.deepEqual(paused.ids, ids(171, 200)); assert.equal(paused.newerCount, 3);
  history.layoutChanged(); assert.equal(history.takeScrollIntent().kind, "none");
  assert.equal(history.observeScroll({ ...reading, scrollTop: 700 }), true);
  const followed = history.window("A", ids(1, 203));
  assert.deepEqual(followed.ids, ids(174, 203)); assert.equal(followed.visibleCount, 30); assert.equal(followed.newerCount, 0);
  assert.deepEqual(history.takeScrollIntent(), { kind: "bottom", behavior: "auto" });
  history.window("A", ids(1, 204)); history.layoutChanged();
  assert.deepEqual(history.takeScrollIntent(), { kind: "bottom", behavior: "auto" });
});

test("load older preserves its visible anchor when an append happens in the same render", () => {
  const history = new HistoryViewport();
  history.window("A", ids(1, 200)); history.takeScrollIntent();
  const anchor = captureHistoryAnchor(reading, [
    { id: "turn-task-171", top: -20, bottom: 80 }, { id: "turn-task-172", top: 80, bottom: 180 },
  ]);
  assert.equal(history.loadOlder(anchor), true);
  const older = history.window("A", ids(1, 203));
  assert.deepEqual(older.ids, ids(141, 200)); assert.equal(older.newerCount, 3);
  const intent = history.takeScrollIntent(); assert.equal(intent.kind, "anchor");
  const after = { scrollTop: 100, scrollHeight: 4600, clientHeight: 300 };
  assert.equal(restoreHistoryAnchor(anchor, after, [{ id: "turn-task-171", top: 2980, bottom: 3080 }]), 3100,
    "restore the actual prepended offset, not the full height increase including appended messages");
  history.layoutChanged(); assert.equal(history.takeScrollIntent().kind, "none");
});

test("load older increments only available data, handles a missing marker and never claims server pagination", () => {
  const history = new HistoryViewport();
  history.window("A", ids(1, 35)); history.takeScrollIntent();
  const anchor = captureHistoryAnchor(reading, [{ id: "removed", top: -10, bottom: 90 }, { id: "surviving", top: 90, bottom: 190 }]);
  assert.equal(history.loadOlder(anchor), true);
  const full = history.window("A", ids(1, 35));
  assert.equal(full.visibleCount, 35); assert.equal(full.availableCount, 35); assert.equal(full.canLoadOlder, false);
  assert.equal(history.loadOlder(anchor), false);
  assert.equal(restoreHistoryAnchor(anchor, { ...reading, scrollHeight: 1500 }, [{ id: "surviving", top: 290, bottom: 390 }]), 300);
  assert.equal(restoreHistoryAnchor(anchor, { ...reading, scrollHeight: 3000 }, []), 100);
  assert.equal(restoreHistoryAnchor(anchor, { ...reading, scrollHeight: 250 }, []), 0);
});

test("explicit latest and hidden-pane return preserve pending intent and respect reduced motion", () => {
  const history = new HistoryViewport();
  history.window("A", ids(1, 100));
  assert.equal(history.takeScrollIntent(false).kind, "none");
  assert.deepEqual(history.takeScrollIntent(true), { kind: "bottom", behavior: "auto" });
  history.pauseFollowing(); history.window("A", ids(1, 102));
  history.jumpToLatest(true);
  assert.deepEqual(history.window("A", ids(1, 102)).ids, ids(73, 102));
  assert.deepEqual(history.takeScrollIntent(true, true), { kind: "bottom", behavior: "auto" });
  history.layoutChanged(); assert.equal(history.takeScrollIntent(false).kind, "none");
  assert.deepEqual(history.takeScrollIntent(true), { kind: "bottom", behavior: "auto" });
  history.pauseFollowing(); history.layoutChanged(); assert.equal(history.takeScrollIntent().kind, "none");
});

test("scroll application is explicit, automatic for anchors, and inert for a no-op intent", () => {
  const calls: unknown[] = [];
  const element = { scrollHeight: 500, clientHeight: 200, scrollTop: 50, scrollTo(value: unknown) { calls.push(value); },
    getBoundingClientRect() { return { top: 20 }; }, querySelectorAll() { return [{ id: "turn-a", getBoundingClientRect() { return { top: 80, bottom: 150 }; } }]; },
  } as unknown as HTMLElement;
  applyHistoryScrollIntent(element, { kind: "none" }); assert.equal(calls.length, 0);
  applyHistoryScrollIntent(element, { kind: "bottom", behavior: "auto" });
  applyHistoryScrollIntent(element, { kind: "anchor", anchor: { scrollTop: 20, markers: [{ id: "turn-a", top: 10 }] } });
  assert.deepEqual(calls, [{ top: 500, behavior: "auto" }, { top: 100, behavior: "auto" }]);
});
