import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { SpatialWorkspace } from '../src/spatial';
import { PanelArrangement, posePosition } from '../src/spatial-layout';
import { SpatialPresses, SpatialTextWrap } from '../src/spatial-interactions';
import type { SpatialCapabilities } from '../src/types';

// Execute the actual class methods without constructing a WebGL renderer or DOM.
// Only browser/session/rendering adapters are fake; lifecycle state transitions,
// capability reporting, end handlers, layout rollback, and press cancellation are real.
class FakeSession extends EventTarget {
  inputSources: unknown[] = [];
  visibilityState = 'visible';
  endCalls = 0;
  result: () => Promise<void> = () => Promise.resolve();
  end() { this.endCalls++; return this.result(); }
  observedEnd() {
    const event = new Event('end');
    Object.defineProperty(event, 'session', { value: this });
    this.dispatchEvent(event);
  }
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function fixture(track = true) {
  const loops: ('paused' | 'running')[] = [], capabilities: SpatialCapabilities[] = [], actions: string[] = [];
  const session = new FakeSession();
  const layout = new PanelArrangement<string>(), presses = new SpatialPresses<string>();
  const renderer = {
    xr: { isPresenting: track, setSession: async (_session: unknown) => undefined },
    setAnimationLoop: (loop: unknown) => loops.push(loop === null ? 'paused' : 'running'),
    setClearColor() {},
  };
  // TypeScript private fields are initialized here as dependency adapters; all
  // methods under test and onSessionEnd are the real class implementation.
  const workspace: any = Object.create(SpatialWorkspace.prototype);
  Object.assign(workspace, {
    disposed: false, suspended: false, lifecycleEpoch: 0, arranging: false, requestPending: false,
    observedEnds: new WeakSet(), hovered: new Set(), views: [], pointers: [],
    renderer, layout, presses, workspace: new THREE.Group(), floor: new THREE.Group(), scene: new THREE.Scene(),
    previewLabel: { hidden: false }, exitRecovery: { hidden: true }, exitRecoveryMessage: { textContent: '' }, retryExit: { disabled: false, textContent: '' },
    capabilitySignature: '', selectionCount: 0, onCapabilities: (value: SpatialCapabilities) => capabilities.push(value),
    onSessionVisibility() {}, onSourcesChange() {}, resize() {}, render() {},
  });
  workspace.onSessionEnd = workspace.onSessionEnd.bind(workspace);
  if (track) workspace.trackSession(session);
  function finish(current = session) {
    renderer.xr.isPresenting = false;
    current.observedEnd();
  }
  return { workspace: workspace as SpatialWorkspace, raw: workspace, session, renderer, layout, presses, loops, capabilities, actions, finish };
}

test('rejected suspension preserves the real session and exposes deliberate recovery after resume', async () => {
  const f = fixture();
  f.session.result = () => Promise.reject(new Error('private native failure'));
  const original = f.layout.pose(0), center = posePosition(original);
  f.layout.begin('drag', 0, { origin: { x: 0, y: 0, z: 0 }, direction: center }, center);
  f.layout.update('drag', { origin: { x: 0.5, y: 0, z: 0 }, direction: center });
  assert.notDeepEqual(f.layout.pose(0), original);
  f.presses.begin('approval', 'approve', { id: 'approve', label: 'Approve', onSelect: () => f.actions.push('approve') });
  f.presses.begin('voice', 'voice', { id: 'voice', label: 'Talk', onSelect: () => f.actions.push('record'), onRelease: () => f.actions.push('send'), onCancel: () => f.actions.push('discard') });
  await assert.rejects(f.workspace.suspend(), /Retry Exit XR/);
  f.workspace.resume();
  await flush();
  f.presses.end('approval', 'approve'); f.presses.end('voice', 'voice');
  assert.deepEqual(f.actions, ['record', 'discard']);
  assert.deepEqual(f.layout.pose(0), original);
  assert.equal(f.layout.has('drag'), false);
  assert.equal(f.raw.session, f.session);
  assert.deepEqual(f.loops, ['paused']);
  assert.equal(f.raw.exitRecovery.hidden, false);
  assert.equal(f.raw.retryExit.disabled, false);
  assert.equal(f.raw.retryExit.textContent, 'Retry Exit XR');
  assert.equal(f.capabilities.at(-1)?.active, true);
  assert.equal(f.capabilities.at(-1)?.exitError, f.workspace.exitError);
  assert.ok(!f.workspace.exitError?.includes('private native failure'));
  assert.equal(f.session.endCalls, 1, 'Resume never retries exit or creates XR automatically');
});

test('explicit retry keeps session identity until a native end event, then restores 2D rendering', async () => {
  const f = fixture();
  f.session.result = () => Promise.reject(new Error('fake rejection'));
  await assert.rejects(f.workspace.suspend());
  f.workspace.resume();
  const end = deferred();
  f.session.result = () => end.promise;
  const retry = f.workspace.exit();
  assert.equal(f.session.endCalls, 2);
  assert.equal(f.raw.retryExit.disabled, true);
  end.resolve(); await retry;
  assert.equal(f.raw.session, f.session, 'A resolved request alone must not synthesize native end');
  assert.equal(f.raw.exitRecovery.hidden, false);
  f.finish();
  assert.equal(f.raw.session, undefined);
  assert.equal(f.workspace.exitError, undefined);
  assert.equal(f.raw.exitRecovery.hidden, true);
  assert.equal(f.capabilities.at(-1)?.active, false);
  assert.equal(f.loops.at(-1), 'running');
});

test('a delayed rejection after observed end cannot replace a newer session with old exit error', async () => {
  const f = fixture(), end = deferred();
  f.session.result = () => end.promise;
  const attempt = f.workspace.exit();
  f.finish();
  const newer = new FakeSession();
  f.raw.trackSession(newer);
  f.renderer.xr.isPresenting = true;
  f.raw.onSessionEnd({ session: f.session });
  end.reject(new Error('old failure'));
  await attempt;
  assert.equal(f.raw.session, newer);
  assert.equal(f.workspace.exitError, undefined);
  assert.equal(f.raw.exitRecovery.hidden, true);
});

test('pending end is shared across duplicate suspension and cannot restart a newly suspended renderer', async () => {
  const f = fixture(), end = deferred();
  f.session.result = () => end.promise;
  const first = f.workspace.suspend();
  f.workspace.resume();
  const second = f.workspace.suspend();
  assert.equal(first, second);
  assert.equal(f.session.endCalls, 1);
  f.finish(); end.resolve();
  await first; await flush();
  assert.equal(f.loops.at(-1), 'paused');
  f.workspace.resume();
  assert.equal(f.loops.at(-1), 'running');
  assert.equal(f.session.endCalls, 1);
});

test('observed native end permits immediate 2D resume before the end promise settles', async () => {
  const f = fixture(), end = deferred();
  f.session.result = () => end.promise;
  const pending = f.workspace.suspend();
  f.finish();
  assert.equal(f.raw.session, undefined);
  f.workspace.resume();
  assert.equal(f.loops.at(-1), 'running');
  const loopCount = f.loops.length;
  end.reject(new Error('late request rejection after actual end'));
  await pending; await flush();
  assert.equal(f.workspace.exitError, undefined);
  assert.equal(f.loops.length, loopCount);
});

async function withFakeXR(run: (request: () => Promise<FakeSession>) => Promise<void>, request: () => Promise<FakeSession>) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { isSecureContext: true } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { xr: { requestSession: request } } });
  try { await run(request); }
  finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else Reflect.deleteProperty(globalThis, 'navigator');
  }
}

test('XR renderer initialization failure never synthesizes end if the native exit request also fails', async () => {
  const f = fixture(false);
  f.renderer.xr.setSession = async () => { throw new Error('fake renderer initialization failure'); };
  f.session.result = () => Promise.reject(new Error('fake native exit failure'));
  await withFakeXR(async () => {
    await assert.rejects(f.workspace.enter(), /renderer initialization failure/);
  }, async () => f.session);
  assert.equal(f.raw.session, f.session);
  assert.equal(f.capabilities.at(-1)?.active, true);
  assert.match(f.workspace.exitError!, /Retry Exit XR/);
  assert.equal(f.raw.exitRecovery.hidden, false);
  f.finish();
  assert.equal(f.raw.session, undefined);
  assert.equal(f.workspace.exitError, undefined);
});

test('a stale requested session is tracked for failed-exit recovery but never attached to the renderer', async () => {
  const f = fixture(false);
  let resolveSession!: (session: FakeSession) => void, attachments = 0;
  const requested = new Promise<FakeSession>(resolve => { resolveSession = resolve; });
  f.renderer.xr.setSession = async () => { attachments++; };
  f.session.result = () => Promise.reject(new Error('fake stale exit failure'));
  await withFakeXR(async () => {
    const entering = f.workspace.enter();
    await f.workspace.suspend(); f.workspace.resume();
    resolveSession(f.session); await entering;
  }, () => requested);
  assert.equal(attachments, 0);
  assert.equal(f.raw.session, f.session);
  assert.match(f.workspace.exitError!, /Retry Exit XR/);
  assert.equal(f.raw.exitRecovery.hidden, false);
  f.finish();
  assert.equal(f.raw.session, undefined);
});

// The real refreshPanel against a counting 2D context. Only the canvas, texture
// and layout adapters are fake; wrapping, paging and the signature check are real.
function panelFixture(lines: string[]) {
  const measured: string[] = [];
  const context: any = new Proxy<Record<string, unknown>>({
    measureText: (text: string) => { measured.push(text); return { width: text.length * 12 }; },
  }, {
    get: (target, key) => key in target ? (target as any)[key] : () => undefined,
    set: () => true,
  });
  const view: any = {
    index: 0,
    panel: { id: 'result', title: 'Response & returned files', lines, actions: [] },
    context, texture: { needsUpdate: false }, hits: [], textPage: 0, actionPage: 0,
    signature: '', wrap: new SpatialTextWrap(),
  };
  const workspace: any = Object.create(SpatialWorkspace.prototype);
  Object.assign(workspace, {
    views: [view], hovered: new Set(), layout: new PanelArrangement<string>(),
    arranging: false, status: 'Connected', session: undefined, exitFailure: undefined,
  });
  return { workspace, view, measured };
}

test('an unchanged artifact preview is not re-measured on the next poll render', () => {
  const preview = 'Returned artifact contents. '.repeat(400);
  const f = panelFixture(['Work status: completed', preview]);
  f.workspace.refreshPanel(f.view);
  assert.ok(f.measured.length > preview.length / 2);
  const signature = f.view.signature;
  f.measured.length = 0;
  f.workspace.refreshPanel(f.view);
  assert.equal(f.view.signature, signature);
  assert.equal(f.measured.length, 0);
  // New output still wraps, and only the surviving line is reused.
  f.view.panel.lines = ['Work status: completed', preview, 'A newly appended output line.'];
  f.workspace.refreshPanel(f.view);
  assert.ok(f.measured.length > 0);
  assert.ok(f.measured.every(text => !text.startsWith('Returned artifact contents. R')));
  assert.notEqual(f.view.signature, signature);
});
