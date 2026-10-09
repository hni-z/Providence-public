import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityLeases } from '../src/activity.js';

test('closing clients releases keep-awake after bounded grace; passive reads do not renew it', () => {
  let now = 0; const activity = new ActivityLeases(() => now);
  assert.equal(activity.wanted(), false);
  activity.touch('client-a', true); assert.equal(activity.wanted(), true);
  now = 10_000; activity.touch('client-a', false); assert.equal(activity.wanted(), true);
  for (let n = 0; n < 5; n++) { now += 4_000; activity.wanted(); }
  assert.equal(activity.wanted(), false);
});

test('crashed or unreachable clients expire without an explicit close', () => {
  let now = 100; const activity = new ActivityLeases(() => now);
  activity.touch('client-a', true); now += 30_001;
  assert.equal(activity.wanted(), false);
});

test('actual running work keeps devices awake after the UI closes; idle work releases', () => {
  let now = 0; const activity = new ActivityLeases(() => now);
  assert.equal(activity.wanted(true), true);
  now += 90_000; assert.equal(activity.wanted(true), true);
  now += 10_000; assert.equal(activity.wanted(false), true);
  now += 20_001; assert.equal(activity.wanted(false), false);
});

test('one tab closing cannot cancel another actively used tab', () => {
  let now = 0; const activity = new ActivityLeases(() => now);
  activity.touch('client-a', true); now = 10_000; activity.touch('client-b', true);
  activity.touch('client-a', false); now = 30_001;
  assert.equal(activity.wanted(), true); now = 40_001; assert.equal(activity.wanted(), false);
});
