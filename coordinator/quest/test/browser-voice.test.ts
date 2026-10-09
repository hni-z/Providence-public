import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserDictation, BrowserSpeech } from '../src/browser-voice';

class FakeClock {
  now = 0;
  sequence = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  setTimeout = (callback: () => void, milliseconds: number) => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.now + milliseconds, callback });
    return id;
  };
  clearTimeout = (id: unknown) => { this.timers.delete(id as number); };
  advance(milliseconds: number) {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.timers].sort(([, a], [, b]) => a.at - b.at)[0];
      if (!next || next[1].at > target) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = target;
  }
}

type ResultsEvent = { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] };
class FakeRecognition {
  continuous = true;
  interimResults = false;
  onstart: (() => void) | null = null;
  onresult: ((event: ResultsEvent) => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  starts = 0;
  stops = 0;
  aborts = 0;
  start() { this.starts++; }
  stop() { this.stops++; }
  abort() { this.aborts++; }
}
function result(...values: [string, boolean][]): ResultsEvent {
  return { resultIndex: 0, results: values.map(([transcript, isFinal]) => ({ 0: { transcript }, isFinal })) };
}
function recognitionFixture(prefixed = false) {
  const clock = new FakeClock();
  const recognitions: FakeRecognition[] = [];
  const states: string[] = [], transcripts: string[] = [];
  class Recognition extends FakeRecognition { constructor() { super(); recognitions.push(this); } }
  const scope = { [prefixed ? 'webkitSpeechRecognition' : 'SpeechRecognition']: Recognition, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  const helper = new BrowserDictation(state => states.push(state), text => transcripts.push(text), scope);
  return { helper, scope, clock, recognitions, states, transcripts };
}

test('unsupported dictation is inert until an explicit start and reports a fixed fallback', () => {
  const states: string[] = [], transcripts: string[] = [];
  const helper = new BrowserDictation(state => states.push(state), text => transcripts.push(text), {});
  assert.equal(helper.available(), false);
  assert.equal(helper.active, false);
  assert.deepEqual(states, []);
  helper.start();
  assert.equal(states[0], 'Browser dictation is unavailable. Use text input.');
  assert.deepEqual(transcripts, []);
});

test('prefixed support constructs only on start, never emits interim text, and deduplicates indexed finals', () => {
  const f = recognitionFixture(true);
  assert.equal(f.helper.available(), true);
  assert.equal(f.recognitions.length, 0);
  f.helper.start();
  const recognition = f.recognitions[0];
  assert.equal(recognition.starts, 1);
  assert.equal(recognition.continuous, false);
  assert.equal(recognition.interimResults, true);
  recognition.onresult!(result(['open the', false]));
  recognition.onresult!(result(['open the file', true], ['on my', false]));
  recognition.onresult!(result(['open the file', true], ['on my computer', true]));
  recognition.onresult!(result(['open the file', true], ['on my computer', true]));
  assert.deepEqual(f.transcripts, []);
  const end = recognition.onend!;
  end(); end();
  assert.deepEqual(f.transcripts, ['open the file on my computer']);
  assert.equal(f.helper.active, false);
  assert.equal(f.clock.timers.size, 0);
});

test('stop runs once and accepts the final result only after end', () => {
  const f = recognitionFixture();
  f.helper.start();
  const recognition = f.recognitions[0];
  f.helper.stop(); f.helper.stop();
  assert.equal(recognition.stops, 1);
  assert.equal(f.helper.active, true);
  recognition.onresult!(result(['create a summary', true]));
  assert.deepEqual(f.transcripts, []);
  recognition.onend!();
  assert.deepEqual(f.transcripts, ['create a summary']);
  assert.equal(recognition.aborts, 0);
});

test('permission denial aborts without retry and never reflects arbitrary error strings', () => {
  const f = recognitionFixture();
  f.helper.start();
  const recognition = f.recognitions[0], end = recognition.onend!;
  recognition.onerror!({ error: 'not-allowed' });
  end(); f.clock.advance(60_000);
  assert.equal(f.helper.active, false);
  assert.equal(recognition.aborts, 1);
  assert.equal(f.recognitions.length, 1);
  assert.equal(recognition.starts, 1);
  assert.deepEqual(f.transcripts, []);
  assert.match(f.states.at(-1)!, /permission was denied/);
  f.helper.start();
  f.recognitions[1].onerror!({ error: 'private arbitrary provider error' });
  assert.equal(f.states.at(-1), 'Browser dictation failed. Use text input or try again.');
});

test('cancel and a new generation ignore saved late callbacks from the previous recognition', () => {
  const f = recognitionFixture();
  f.helper.start();
  const first = f.recognitions[0], oldResult = first.onresult!, oldEnd = first.onend!, oldError = first.onerror!;
  first.onresult!(result(['stale command', true]));
  f.helper.cancel();
  assert.equal(first.aborts, 1);
  f.helper.start();
  oldResult(result(['late private text', true])); oldError({ error: 'network' }); oldEnd();
  assert.equal(f.helper.active, true);
  const second = f.recognitions[1];
  second.onresult!(result(['current command', true])); second.onend!();
  assert.deepEqual(f.transcripts, ['current command']);
});

test('empty final results and explicit no-speech errors never deliver a transcript', () => {
  const f = recognitionFixture();
  f.helper.start();
  f.recognitions[0].onresult!(result(['interim only', false]));
  f.recognitions[0].onend!();
  assert.match(f.states.at(-1)!, /No speech was recognized/);
  f.helper.start();
  f.recognitions[1].onerror!({ error: 'no-speech' });
  assert.deepEqual(f.transcripts, []);
  assert.equal(f.helper.active, false);
});

test('25-second limit stops capture; a final result can complete within the bounded finish period', () => {
  const f = recognitionFixture();
  f.helper.start();
  const recognition = f.recognitions[0];
  f.clock.advance(24_999); assert.equal(recognition.stops, 0);
  f.clock.advance(1); assert.equal(recognition.stops, 1);
  assert.equal(f.helper.active, true);
  recognition.onresult!(result(['bounded request', true]));
  f.clock.advance(4_999); recognition.onend!();
  f.clock.advance(10_000);
  assert.deepEqual(f.transcripts, ['bounded request']);
  assert.equal(recognition.aborts, 0);
});

test('missing end after stop times out, aborts, and discards even a previously final result', () => {
  const f = recognitionFixture();
  f.helper.start();
  const recognition = f.recognitions[0], lateEnd = recognition.onend!;
  recognition.onresult!(result(['must not be delivered without end', true]));
  f.helper.stop(); f.clock.advance(5_000); lateEnd();
  assert.equal(f.helper.active, false);
  assert.equal(recognition.aborts, 1);
  assert.deepEqual(f.transcripts, []);
  assert.match(f.states.at(-1)!, /did not finish/);
  assert.equal(f.clock.timers.size, 0);
});

test('oversized final text is discarded instead of silently truncating the command', () => {
  const f = recognitionFixture();
  f.helper.start();
  const recognition = f.recognitions[0], lateEnd = recognition.onend!;
  recognition.onresult!(result(['x'.repeat(8_001), true])); lateEnd();
  assert.equal(recognition.aborts, 1);
  assert.equal(f.transcripts.length, 0);
  assert.match(f.states.at(-1)!, /too long/);
  f.helper.start();
  f.recognitions[1].onresult!(result(['x'.repeat(8_000), true])); f.recognitions[1].onend!();
  assert.equal(f.transcripts[0].length, 8_000);
});

test('dispose invalidates late callbacks and explicit starts after disposal remain inert', () => {
  const f = recognitionFixture();
  f.helper.start();
  const recognition = f.recognitions[0], end = recognition.onend!, onResult = recognition.onresult!;
  f.helper.dispose();
  const count = f.states.length;
  onResult(result(['late text', true])); end(); f.helper.start();
  assert.equal(f.helper.active, false);
  assert.equal(f.helper.available(), false);
  assert.equal(f.states.length, count);
  assert.equal(f.recognitions.length, 1);
  assert.deepEqual(f.transcripts, []);
});

test('logout cancellation from the ready-state callback prevents subsequent transcript delivery', () => {
  const f = recognitionFixture();
  const transcripts: string[] = [];
  let helper!: BrowserDictation;
  helper = new BrowserDictation(state => { if (state === 'Final transcript ready.') helper.cancel(); }, text => transcripts.push(text), f.scope);
  helper.start();
  f.recognitions[0].onresult!(result(['do not deliver after logout', true])); f.recognitions[0].onend!();
  assert.deepEqual(transcripts, []);
});

class FakeUtterance {
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  constructor(readonly text: string) {}
}
function speechFixture() {
  const clock = new FakeClock();
  const utterances: FakeUtterance[] = [], states: string[] = [];
  const synthesis = {
    speaking: false, pending: false, cancels: 0,
    speak(utterance: FakeUtterance) { utterances.push(utterance); this.pending = true; },
    cancel() { this.cancels++; this.speaking = false; this.pending = false; },
  };
  const scope = { SpeechSynthesisUtterance: FakeUtterance, speechSynthesis: synthesis, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  const helper = new BrowserSpeech(state => states.push(state), scope);
  return { helper, scope, clock, synthesis, utterances, states };
}

test('read-aloud has no constructor playback; an explicit click-equivalent call owns one utterance', () => {
  const f = speechFixture();
  assert.equal(f.helper.available(), true);
  assert.equal(f.utterances.length, 0); assert.equal(f.synthesis.cancels, 0);
  f.helper.speak(' The selected response. ');
  assert.equal(f.helper.active, true);
  assert.equal(f.utterances[0].text, 'The selected response.');
  f.synthesis.pending = false; f.synthesis.speaking = true; f.utterances[0].onstart!();
  f.synthesis.speaking = false; f.utterances[0].onend!();
  assert.equal(f.helper.active, false);
  assert.equal(f.clock.timers.size, 0);
  assert.equal(f.synthesis.cancels, 0);
});

test('read-aloud cancellation ignores late utterance callbacks and does not cancel unrelated playback', () => {
  const f = speechFixture();
  f.helper.cancel(); assert.equal(f.synthesis.cancels, 0);
  f.helper.speak('First response');
  const end = f.utterances[0].onend!, error = f.utterances[0].onerror!;
  f.helper.cancel();
  f.helper.speak('Second response');
  const states = f.states.length;
  end(); error({ error: 'network' });
  assert.equal(f.helper.active, true);
  assert.equal(f.states.length, states);
  f.helper.dispose();
  assert.equal(f.synthesis.cancels, 2);
  assert.equal(f.helper.active, false);
  f.helper.speak('No playback after disposal');
  assert.equal(f.utterances.length, 2);
});

test('unsupported, empty, oversized, or externally busy read-aloud never starts playback', () => {
  const states: string[] = [];
  const unsupported = new BrowserSpeech(state => states.push(state), {});
  unsupported.speak('response');
  assert.equal(unsupported.available(), false);
  assert.match(states[0], /unavailable/);
  const f = speechFixture();
  f.helper.speak(''); f.helper.speak('x'.repeat(4_001));
  assert.deepEqual(f.utterances, []);
  f.synthesis.speaking = true;
  f.helper.speak('external speech must remain untouched');
  assert.deepEqual(f.utterances, []);
  assert.equal(f.synthesis.cancels, 0);
});

test('read-aloud startup timeout cancels only its active utterance without retry', () => {
  const f = speechFixture();
  f.helper.speak('Never started');
  const lateStart = f.utterances[0].onstart!;
  f.clock.advance(10_000); lateStart();
  assert.equal(f.synthesis.cancels, 1);
  assert.equal(f.helper.active, false);
  assert.equal(f.utterances.length, 1);
  assert.equal(f.clock.timers.size, 0);
  assert.match(f.states.at(-1)!, /timed out/);
});

test('context invalidation during replacement cancellation cannot leave phantom read-aloud active', () => {
  for (const action of ['cancel', 'dispose'] as const) {
    const f = speechFixture();
    let helper!: BrowserSpeech;
    helper = new BrowserSpeech(state => { if (state === 'Read-aloud stopped.') helper[action](); }, f.scope);
    helper.speak('First response');
    helper.speak('Must not replace speech after context invalidation');
    assert.equal(helper.active, false);
    assert.equal(f.utterances.length, 1);
    assert.equal(f.clock.timers.size, 0);
  }
});
