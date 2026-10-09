import test from "node:test";
import assert from "node:assert/strict";
import { TaskTiming } from "../src/task-timing.js";

function fakeClock() {
  let value = 0;
  return { now: () => value, advance: (milliseconds: number) => { value += milliseconds; } };
}

test("records cold-start milestones as monotonic elapsed time without request content", () => {
  const clock = fakeClock();
  const timing = new TaskTiming({ now: clock.now });
  clock.advance(10); timing.workerReady("cold");
  clock.advance(5); timing.turnAcknowledged();
  clock.advance(8); timing.providerNotification();
  clock.advance(2); timing.textReceived();
  clock.advance(5);
  assert.deepEqual(timing.finish(), {
    observedWallMs: 30, workerStartMode: "cold", workerReadyMs: 10,
    turnAcknowledgedMs: 15, firstProviderNotificationMs: 23, firstTextMs: 25,
    toolElapsedMs: 0, toolCount: 0, approvalWaitMs: 0,
    approvalsRequested: 0, approvalsResolved: 0, approvalsExpired: 0,
    incomplete: false,
    modelInferenceMs: null,
  });
});

test("records warm resume and unions concurrent tool and approval waits", () => {
  const clock = fakeClock();
  const timing = new TaskTiming({ now: clock.now });
  clock.advance(2); timing.workerReady("warm");
  timing.toolStarted("one");
  clock.advance(5); timing.toolStarted("two");
  timing.approvalRequested("a");
  clock.advance(5); timing.toolCompleted("one");
  timing.approvalRequested("b");
  clock.advance(5); timing.toolCompleted("two");
  timing.approvalResolved("a");
  clock.advance(5); timing.approvalExpired("b");
  const snapshot = timing.finish();
  assert.equal(snapshot.observedWallMs, 22);
  assert.equal(snapshot.workerStartMode, "warm");
  assert.equal(snapshot.workerReadyMs, 2);
  assert.equal(snapshot.toolElapsedMs, 15);
  assert.equal(snapshot.toolCount, 2);
  assert.equal(snapshot.approvalWaitMs, 15);
  assert.equal(snapshot.approvalsRequested, 2);
  assert.equal(snapshot.approvalsResolved, 1);
  assert.equal(snapshot.approvalsExpired, 1);
  assert.equal(snapshot.incomplete, false);
  assert.equal(snapshot.modelInferenceMs, null);
});

test("terminal timing closes in-flight intervals once and ignores later content-bearing marks", () => {
  const clock = fakeClock();
  const timing = new TaskTiming({ now: clock.now });
  timing.toolStarted("tool");
  timing.approvalRequested("approval");
  clock.advance(7);
  const first = timing.finish();
  clock.advance(30);
  timing.textReceived();
  timing.toolCompleted("tool");
  timing.approvalResolved("approval");
  const second = timing.finish();
  assert.deepEqual(second, first);
  assert.equal(first.toolElapsedMs, 7);
  assert.equal(first.approvalWaitMs, 7);
  assert.equal(first.firstTextMs, null);
});

test("caps active correlation IDs and marks the partial timing as incomplete", () => {
  const clock = fakeClock();
  const timing = new TaskTiming({ now: clock.now });
  for (let index = 0; index < 257; index++) timing.toolStarted(`tool-${index}`);
  clock.advance(4);
  const snapshot = timing.finish();
  assert.equal(snapshot.toolCount, 256);
  assert.equal(snapshot.toolElapsedMs, 4);
  assert.equal(snapshot.incomplete, true);
});

test("an unknown tool completion makes the timing conservatively incomplete", () => {
  const clock = fakeClock();
  const timing = new TaskTiming({ now: clock.now });
  timing.toolCompleted("unknown-tool");
  assert.equal(timing.finish().incomplete, true);
});
