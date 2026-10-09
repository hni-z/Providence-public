import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PANEL_POSES, PanelArrangement, clampPanelPose, posePosition, type LayoutRay, type LayoutVector, type PanelPose } from '../src/spatial-layout';

const origin = { x: 0, y: 0, z: 0 };
const neutral = { angle: 0, distance: 2.3, height: 0 };
const forward: LayoutRay = { origin, direction: { x: 0, y: 0, z: -1 } };
const invalid: LayoutRay = { origin, direction: { x: 0, y: 0, z: 0 } };
const radians = (degrees: number) => degrees * Math.PI / 180;
function close(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`); }
function closePose(actual: PanelPose, expected: PanelPose) {
  close(actual.angle, expected.angle); close(actual.distance, expected.distance); close(actual.height, expected.height);
}
function aimedAt(point: LayoutVector, start = origin): LayoutRay {
  return { origin: { ...start }, direction: { x: point.x - start.x, y: point.y - start.y, z: point.z - start.z } };
}
function shifted(x: number, y = 0, z = 0): LayoutRay { return { origin: { x, y, z }, direction: { x: 0, y: 0, z: -1 } }; }

test('defaults reproduce four panel positions and all returned state is independent', () => {
  const arrangement = new PanelArrangement<string>();
  assert.equal(DEFAULT_PANEL_POSES.length, 4);
  for (let index = 0; index < 4; index++) {
    closePose(arrangement.pose(index), { angle: radians((index - 1.5) * 31), distance: 2.3, height: 0 });
    const position = posePosition(arrangement.pose(index));
    close(Math.hypot(position.x, position.z), 2.3);
    assert.ok(position.z < 0);
  }
  const copy = arrangement.pose(0); copy.angle = 0; copy.distance = 999;
  closePose(arrangement.pose(0), DEFAULT_PANEL_POSES[0]);
  assert.ok(Object.isFrozen(DEFAULT_PANEL_POSES));
  assert.ok(DEFAULT_PANEL_POSES.every(Object.isFrozen));
  const input = [{ ...neutral }];
  const custom = new PanelArrangement(input);
  input[0].height = 100;
  closePose(custom.pose(0), neutral);
  assert.throws(() => custom.pose(-1), RangeError);
  assert.throws(() => custom.pose(1), RangeError);
  assert.throws(() => custom.pose(0.5), RangeError);
});

test('clamping enforces angular, radial, and height bounds without mutating input', () => {
  const excessive = { angle: 20, distance: 99, height: 6 };
  assert.deepEqual(clampPanelPose(excessive), { angle: radians(70), distance: 3.2, height: 0.45 });
  assert.deepEqual(excessive, { angle: 20, distance: 99, height: 6 });
  assert.deepEqual(clampPanelPose({ angle: -20, distance: -8, height: -6 }), { angle: radians(-70), distance: 1.8, height: -0.55 });
  assert.deepEqual(clampPanelPose({ angle: NaN, distance: Infinity, height: -Infinity }), neutral);
  assert.deepEqual(posePosition({ angle: NaN, distance: Infinity, height: -Infinity }), { x: 0, y: 0, z: -2.3 });
});

test('grabbing off-centre with a non-unit ray does not move the panel', () => {
  const arrangement = new PanelArrangement<string>();
  const before = arrangement.pose(1), center = posePosition(before);
  const hit = { x: center.x + 0.3, y: center.y + 0.35, z: center.z };
  const ray = aimedAt(hit, { x: 0.2, y: -0.1, z: 0.4 });
  assert.equal(arrangement.begin('left', 1, ray, hit), true);
  assert.equal(arrangement.update('left', ray), true);
  closePose(arrangement.pose(1), before);
  // Neither caller-owned ray nor hit point is retained by the capture.
  ray.direction.x = 999; hit.x = 999;
  assert.equal(arrangement.update('left', aimedAt({ x: center.x + 0.3, y: center.y + 0.35, z: center.z }, { x: 0.2, y: -0.1, z: 0.4 })), true);
  closePose(arrangement.pose(1), before);
});

test('cancel restores committed pose while release computes and commits its current ray', () => {
  const arrangement = new PanelArrangement<string>([neutral]);
  const center = posePosition(neutral);
  assert.equal(arrangement.begin('left', 0, forward, center), true);
  assert.equal(arrangement.update('left', shifted(0.5, 0.2)), true);
  assert.notDeepEqual(arrangement.pose(0), neutral);
  arrangement.cancel('left');
  closePose(arrangement.pose(0), neutral);
  assert.equal(arrangement.has('left'), false);
  assert.equal(arrangement.isDragging(0), false);
  assert.equal(arrangement.begin('left', 0, forward, center), true);
  arrangement.update('left', shifted(0.5, 0.2));
  assert.equal(arrangement.end('left', shifted(-0.4, -0.2)), true);
  const committed = { angle: Math.atan2(-0.4, 2.3), distance: Math.hypot(0.4, 2.3), height: -0.2 };
  closePose(arrangement.pose(0), committed);
  assert.equal(arrangement.has('left'), false);
  arrangement.cancelAll();
  closePose(arrangement.pose(0), committed);
  assert.equal(arrangement.end('left', forward), false);
});

test('a release with an invalid current ray discards the last valid preview', () => {
  const arrangement = new PanelArrangement<string>([neutral]);
  arrangement.begin('left', 0, forward, posePosition(neutral));
  arrangement.update('left', shifted(0.5));
  const preview = arrangement.pose(0);
  assert.equal(arrangement.update('left', invalid), false);
  closePose(arrangement.pose(0), preview);
  assert.equal(arrangement.end('left', invalid), false);
  closePose(arrangement.pose(0), neutral);
  assert.equal(arrangement.isDragging(0), false);
});

test('captures enforce exclusive panel and pointer ownership while other panels are independent', () => {
  const arrangement = new PanelArrangement<string>([neutral, neutral]);
  const center = posePosition(neutral);
  assert.equal(arrangement.begin('left', 0, forward, center), true);
  assert.equal(arrangement.begin('right', 0, forward, center), false);
  assert.equal(arrangement.begin('left', 1, forward, center), false);
  assert.equal(arrangement.begin('right', 1, forward, center), true);
  arrangement.update('left', shifted(-0.4)); arrangement.update('right', shifted(0.4));
  const rightPreview = arrangement.pose(1);
  arrangement.cancel('left');
  closePose(arrangement.pose(0), neutral);
  closePose(arrangement.pose(1), rightPreview);
  assert.equal(arrangement.has('right'), true);
  assert.equal(arrangement.isDragging(1), true);
  assert.equal(arrangement.end('right', shifted(0.4)), true);
  closePose(arrangement.pose(1), rightPreview);
});

test('invalid rays, hit points, indices, and overflowing grab distances never capture', () => {
  const arrangement = new PanelArrangement<string>([neutral]);
  const center = posePosition(neutral);
  const invalidRays: LayoutRay[] = [invalid, { origin: { x: NaN, y: 0, z: 0 }, direction: forward.direction }, { origin, direction: { x: 0, y: Infinity, z: -1 } }];
  for (const ray of invalidRays) assert.equal(arrangement.begin('left', 0, ray, center), false);
  assert.equal(arrangement.begin('left', 0, forward, { x: 0, y: NaN, z: -2.3 }), false);
  assert.equal(arrangement.begin('left', 0, forward, origin), false);
  assert.equal(arrangement.begin('left', 0, shifted(-Number.MAX_VALUE), { x: Number.MAX_VALUE, y: 0, z: 0 }), false);
  for (const index of [-1, 1, 0.5, NaN, Infinity]) assert.equal(arrangement.begin('left', index, forward, center), false);
  assert.equal(arrangement.has('left'), false);
  assert.equal(arrangement.update('absent', forward), false);
});

test('moving behind or far outside the workspace stays within all panel bounds', () => {
  const arrangement = new PanelArrangement<string>([neutral]);
  arrangement.begin('left', 0, forward, posePosition(neutral));
  for (const [ray, expected] of [
    [shifted(100, 100, 100), { angle: radians(70), distance: 3.2, height: 0.45 }],
    [shifted(-100, -100, 100), { angle: radians(-70), distance: 3.2, height: -0.55 }],
    [shifted(0, 0, 2.2), { angle: 0, distance: 1.8, height: 0 }],
    [shifted(Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE), { angle: radians(70), distance: 3.2, height: 0.45 }],
  ] as [LayoutRay, PanelPose][]) {
    assert.equal(arrangement.update('left', ray), true);
    closePose(arrangement.pose(0), expected);
    assert.ok(posePosition(arrangement.pose(0)).z < 0);
  }
});

test('finite extreme and subnormal directions normalize; overflowing updates do not commit', () => {
  const arrangement = new PanelArrangement<string>([neutral]);
  arrangement.begin('left', 0, { origin, direction: { x: 0, y: 0, z: -Number.MIN_VALUE } }, posePosition(neutral));
  assert.equal(arrangement.update('left', { origin, direction: { x: 0, y: 0, z: -Number.MAX_VALUE } }), true);
  closePose(arrangement.pose(0), neutral);
  arrangement.cancelAll();
  // This enormous but finite grab can overflow ray.at(distance) during a later update.
  assert.equal(arrangement.begin('left', 0, forward, { x: 0, y: 0, z: -Number.MAX_VALUE }), true);
  assert.equal(arrangement.end('left', { origin: { x: 0, y: 0, z: -Number.MAX_VALUE }, direction: { x: 0, y: 0, z: -1 } }), false);
  closePose(arrangement.pose(0), neutral);
});

test('reset restores copied defaults and clears every active drag and committed change', () => {
  const customDefaults = [{ ...neutral }, { angle: 0.2, distance: 2, height: 0.1 }];
  const arrangement = new PanelArrangement<string>(customDefaults);
  arrangement.begin('left', 0, forward, posePosition(neutral));
  arrangement.end('left', shifted(0.4));
  arrangement.begin('left', 0, aimedAt(posePosition(arrangement.pose(0))), posePosition(arrangement.pose(0)));
  arrangement.begin('right', 1, aimedAt(posePosition(arrangement.pose(1))), posePosition(arrangement.pose(1)));
  arrangement.update('right', shifted(-0.8));
  arrangement.reset();
  closePose(arrangement.pose(0), customDefaults[0]); closePose(arrangement.pose(1), customDefaults[1]);
  assert.equal(arrangement.has('left'), false); assert.equal(arrangement.has('right'), false);
  assert.equal(arrangement.isDragging(0), false); assert.equal(arrangement.isDragging(1), false);
  assert.equal(arrangement.end('left', shifted(0.8)), false);
});
