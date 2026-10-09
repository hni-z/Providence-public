import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveSessionError } from '../web/src/live-conversation-client.js';
import { liveComponent, liveStream } from './fixtures/live-conversation-component.js';
async function connect(f: ReturnType<typeof liveComponent>, id = 'live_fixture') {
  f.render(); f.ref.current.start(); const stream = liveStream(); f.media.at(-1)!.resolve(stream); await f.settle();
  f.creates.at(-1)!.result.resolve({ session: { id }, transport: { type: 'webrtc', sdp: 'synthetic-answer' } }); await f.settle();
  const peer = f.peers.at(-1)!;
  assert.equal(stream.track.enabled, false, 'no audio before session.started');
  peer.channel.message({ type: 'session.started', session: { id: 'provider_session_different_from_gateway_handle' } }); await f.settle();
  assert.equal(f.phase, 'live'); assert.equal(stream.track.enabled, true); return { stream, peer };
}
test('StrictMode stays inert; repeated start opens one permission request and denial permits explicit retry', async () => {
  const f = liveComponent(); try {
    f.render(); f.strictReplay(); assert.equal(f.media.length, 0); assert.equal(f.creates.length, 0);
    f.ref.current.start(); f.ref.current.start(); assert.equal(f.media.length, 1);
    f.media[0].reject(new DOMException('No', 'NotAllowedError')); await f.settle();
    assert.equal(f.phase, 'error'); assert.match(f.text, /Allow microphone access/);
    f.ref.current.start(); assert.equal(f.media.length, 2); assert.equal(f.phase, 'starting');
  } finally { f.dispose(); }
});
test('late permission after cancellation cannot replace or stop a newer call', async () => {
  const f = liveComponent(); try {
    f.render(); f.ref.current.start(); f.ref.current.end(); const newer = await connect(f, 'live_new');
    const stale = liveStream(); f.media[0].resolve(stale); await f.settle();
    assert.ok(stale.track.stopped > 0); assert.equal(newer.stream.track.stopped, 0); assert.equal(f.phase, 'live'); assert.equal(f.peers.length, 1);
  } finally { f.dispose(); }
});
test('startup deadline includes unanswered permission and closes late tracks without creating a session', async () => {
  const f = liveComponent(); try {
    f.render(); f.ref.current.start(); f.clock.tick(45_000); await f.settle();
    assert.equal(f.phase, 'error'); assert.equal(f.active.at(-1), false);
    const stale = liveStream(); f.media[0].resolve(stale); await f.settle();
    assert.ok(stale.track.stopped > 0); assert.equal(f.peers.length, 0); assert.equal(f.creates.length, 0);
  } finally { f.dispose(); }
});
test('missing session.started expires startup and ends the exact server session', async () => {
  const f = liveComponent(); try {
    f.render(); f.ref.current.start(); const stream = liveStream(); f.media[0].resolve(stream); await f.settle();
    f.creates[0].result.resolve({ session: { id: 'live_wait' }, transport: { type: 'webrtc', sdp: 'answer' } }); await f.settle();
    f.clock.tick(45_000); await f.settle();
    assert.equal(f.phase, 'error'); assert.ok(stream.track.stopped > 0); assert.equal(f.peers[0].closed, 1);
    assert.equal(f.ends.length, 1); assert.match(f.ends[0].path, /live_wait\/end$/);
  } finally { f.dispose(); }
});
test('ending stops capture immediately and drains session.closed before releasing WebRTC', async () => {
  const f = liveComponent(); try {
    const { stream, peer } = await connect(f); f.ref.current.end(); assert.equal(f.phase, 'ending');
    assert.ok(stream.track.stopped > 0); assert.equal(stream.track.enabled, false); assert.equal(peer.closed, 0);
    assert.deepEqual(peer.channel.sent, [{ type: 'session.close' }]); f.ref.current.start(); assert.equal(f.media.length, 1);
    f.clock.tick(2999); assert.equal(peer.closed, 0); peer.channel.message({ type: 'session.closed', reason: 'close_requested' }); await f.settle();
    assert.equal(f.phase, 'closed'); assert.equal(peer.closed, 1); assert.equal(f.active.at(-1), false);
    f.clock.tick(1); assert.equal(f.phase, 'closed'); assert.equal(f.ends.length, 1);
  } finally { f.dispose(); }
});
test('close timeout or channel loss reports incomplete finalization and releases media', async () => {
  for (const mode of ['timeout', 'channel']) { const f = liveComponent(); try {
    const { stream, peer } = await connect(f); f.ref.current.end();
    if (mode === 'timeout') f.clock.tick(3000); else peer.channel.close(); await f.settle();
    assert.equal(f.phase, 'error'); assert.match(f.text, /finalization was not confirmed/); assert.ok(stream.track.stopped > 0);
    assert.equal(peer.closed, 1); assert.equal(f.ends.length, 1); f.ref.current.start(); assert.equal(f.media.length, 2);
  } finally { f.dispose(); } }
});
test('chat or token change retires the old connection using its original authorization', async () => {
  const f = liveComponent(); try {
    const { stream, peer } = await connect(f, 'live_old'); const oldMessage = peer.channel.onmessage!;
    f.update({ chatId: 'other', token: 'fixture-new-token' }); assert.equal(f.phase, 'closed'); assert.ok(stream.track.stopped > 0); assert.equal(peer.closed, 1);
    assert.equal(new Headers(f.ends[0].init.headers).get('Authorization'), 'Bearer fixture-old-token'); await connect(f, 'live_new');
    oldMessage({ data: JSON.stringify({ type: 'session.closed' }) }); await f.settle(); assert.equal(f.phase, 'live');
  } finally { f.dispose(); }
});
test('late create response after route change ends only its allocated old session', async () => {
  const f = liveComponent(); try {
    f.render(); f.ref.current.start(); const stream = liveStream(); f.media[0].resolve(stream); await f.settle();
    f.update({ chatId: 'other', token: 'fixture-new-token' }); await connect(f, 'live_new');
    f.creates[0].result.resolve({ session: { id: 'live_late' }, transport: { type: 'webrtc', sdp: 'answer' } }); await f.settle();
    assert.equal(f.phase, 'live'); assert.ok(stream.track.stopped > 0);
    const cleanup = f.ends.find(item => item.path.includes('live_late'))!;
    assert.equal(new Headers(cleanup.init.headers).get('Authorization'), 'Bearer fixture-old-token');
  } finally { f.dispose(); }
});
test('hidden, offline, disconnected and unmounted states release media and never restart automatically', async () => {
  for (const mode of ['hidden', 'offline', 'disconnected', 'unmount']) { const f = liveComponent(); try {
    const { stream, peer } = await connect(f);
    if (mode === 'hidden') { f.document.visibilityState = 'hidden'; f.document.dispatchEvent(new Event('visibilitychange')); }
    if (mode === 'offline') f.window.dispatchEvent(new Event('offline'));
    if (mode === 'disconnected') f.update({ connected: false }); if (mode === 'unmount') f.dispose();
    assert.ok(stream.track.stopped > 0); assert.equal(peer.closed, 1); f.document.visibilityState = 'visible';
    f.document.dispatchEvent(new Event('visibilitychange')); f.window.dispatchEvent(new Event('online'));
    f.clock.tick(50_000); await f.settle(); assert.equal(f.media.length, 1);
  } finally { f.dispose(); } }
});
test('mute controls real tracks and heartbeat authorization loss stops capture until explicit retry', async () => {
  const f = liveComponent(); try {
    const { stream } = await connect(f); f.button('Mute').onClick(); assert.equal(stream.track.enabled, false);
    f.button('Unmute').onClick(); assert.equal(stream.track.enabled, true); f.failHeartbeats(); f.clock.tick(10_000); await f.settle();
    assert.equal(f.phase, 'error'); assert.ok(stream.track.stopped > 0); assert.equal(f.active.at(-1), false);
    f.clock.tick(50_000); await f.settle(); assert.equal(f.media.length, 1);
  } finally { f.dispose(); }
});


test('API credit failure stops microphone and preserves actionable billing help without automatic retry', async () => {
  const f = liveComponent(); try {
    f.render(); f.ref.current.start(); const stream = liveStream(); f.media[0].resolve(stream); await f.settle();
    f.creates[0].result.reject(new LiveSessionError(429, 'insufficient_quota')); await f.settle();
    assert.equal(f.phase, 'error'); assert.ok(stream.track.stopped > 0);
    assert.match(f.text, /credit or spending limit/); assert.match(f.text, /Account & API billing/);
    f.clock.tick(60_000); await f.settle(); assert.equal(f.creates.length, 1); assert.equal(f.media.length, 1);
  } finally { f.dispose(); }
});
