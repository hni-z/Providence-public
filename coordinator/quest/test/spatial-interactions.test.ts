import assert from 'node:assert/strict';
import test from 'node:test';
import { SpatialPresses, SpatialTextWrap, wrapSpatialText } from '../src/spatial-interactions';

test('normal actions only fire on release over the captured target', () => {
  const presses = new SpatialPresses<string>();
  let approvals = 0;
  const action = { id: 'approval-1', label: 'Approve', onSelect: () => approvals++ };
  presses.begin('left', 'approval-1', action);
  assert.equal(approvals, 0);
  presses.end('left', 'approval-2');
  assert.equal(approvals, 0);
  presses.begin('left', 'approval-1', action);
  presses.end('left', 'approval-1');
  presses.end('left', 'approval-1');
  assert.equal(approvals, 1);
});

test('hold release uses original action even if target changes or input is lost', () => {
  const presses = new SpatialPresses<string>();
  const calls: string[] = [];
  presses.begin('hand', 'voice', { id: 'voice', label: 'Hold to talk', onSelect: () => calls.push('start'), onRelease: () => calls.push('stop') });
  presses.end('hand', 'unrelated');
  presses.cancelAll();
  assert.deepEqual(calls, ['start', 'stop']);
  presses.begin('hand', 'voice', { id: 'voice', label: 'Hold', onSelect: () => calls.push('start'), onRelease: () => calls.push('stop') });
  presses.cancelAll();
  assert.deepEqual(calls, ['start', 'stop', 'start', 'stop']);
});

test('disabled actions and cancellation never approve', () => {
  const presses = new SpatialPresses<string>();
  let calls = 0;
  presses.begin('right', 'approve', { id: 'approve', label: 'Approve', disabled: true, onSelect: () => calls++ });
  presses.end('right', 'approve');
  presses.begin('right', 'approve', { id: 'approve', label: 'Approve', onSelect: () => calls++ });
  presses.cancelAll();
  assert.equal(calls, 0);
});

test('tracking or visibility loss cancels a hold without submitting the recorded action', () => {
  const presses = new SpatialPresses<string>();
  const calls: string[] = [];
  const action = { id: 'voice', label: 'Talk', onSelect: () => calls.push('start'), onRelease: () => calls.push('submit'), onCancel: () => calls.push('discard') };
  presses.begin('left', 'voice', action);
  presses.begin('right', 'voice', action);
  presses.end('right', 'voice');
  assert.deepEqual(calls, ['start']);
  presses.cancelAll();
  assert.deepEqual(calls, ['start', 'discard']);
});

test('a mode switch clears pending approval and voice captures before either pointer releases', () => {
  const presses = new SpatialPresses<string>();
  const calls: string[] = [];
  presses.begin('left', 'approval', { id: 'approval', label: 'Approve', onSelect: () => calls.push('approve') });
  presses.begin('right', 'voice', { id: 'voice', label: 'Talk', onSelect: () => calls.push('start'), onRelease: () => calls.push('send'), onCancel: () => calls.push('discard') });
  presses.cancelAll();
  // Both releases may land on the old buttons after Arrange/Done or recenter.
  presses.end('left', 'approval');
  presses.end('right', 'voice');
  assert.deepEqual(calls, ['start', 'discard']);
  // A release after a header drag has no matching application press to invoke.
  presses.end('header-drag', 'approval');
  assert.deepEqual(calls, ['start', 'discard']);
});

test('long unbroken output wraps into readable lines without losing characters', () => {
  const output = 'https://example.test/' + 'abcdef0123456789'.repeat(80);
  const lines = wrapSpatialText(output, text => text.length, 40);
  assert.ok(lines.every(line => line.length <= 40));
  assert.equal(lines.join(''), output);
  assert.deepEqual(wrapSpatialText('first\n\nsecond', text => text.length, 40), ['first', '', 'second']);
});

test('a panel wrap measures unchanged text once and measures again when the width changes', () => {
  const measured: string[] = [];
  const context = { measureText: (text: string) => { measured.push(text); return { width: text.length }; } };
  const wrap = new SpatialTextWrap();
  const measure = (text: string) => context.measureText(text).width;
  const lines = ['A returned artifact line that has to be wrapped.', '', 'Second paragraph of the same artifact.'];
  const first = wrap.wrapAll(lines, measure, 20);
  assert.ok(measured.length > 0);
  measured.length = 0;
  assert.deepEqual(wrap.wrapAll(lines, measure, 20), first);
  assert.deepEqual(measured, []);
  const narrower = wrap.wrapAll(lines, measure, 12);
  assert.ok(measured.length > 0);
  assert.notDeepEqual(narrower, first);
  // The previous width is dropped, so the cache cannot grow with every render.
  measured.length = 0;
  assert.deepEqual(wrap.wrapAll(lines, measure, 20), first);
  assert.ok(measured.length > 0);
});
