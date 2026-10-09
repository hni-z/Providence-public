import test from "node:test";
import assert from "node:assert/strict";
import { VoicePageLifecycle, playBrowserSpeech, type BrowserSpeechEnvironment, type BrowserUtterance } from "../web/src/voice-lifecycle.js";
import { VoiceSessionGuard, type VoiceOutcome } from "../web/src/browser-voice.js";
import { SpeechPlaybackError } from "../web/src/server-audio.js";

class Page extends EventTarget {
  visibilityState = "visible";
  visibility(value: string) { this.visibilityState = value; this.dispatchEvent(new Event("visibilitychange")); }
}
const outcome = (id: string, time: number): VoiceOutcome => ({
  id, contextKey: "master", status: "completed", text: "Accepted task reply", updatedAt: new Date(time).toISOString(),
});

test("hiding invalidates actual voice tokens, aborts pending input/output and cannot resume on show", () => {
  const document = new Page(), window = new EventTarget(), guard = new VoiceSessionGuard();
  const input = new AbortController(), output = new AbortController();
  const acceptedTasks = [{ id: "already-accepted", status: "running" }];
  let captureStopped = 0, submitted = 0;
  const page = new VoicePageLifecycle(document, window, () => {
    guard.reset(); input.abort(); output.abort(); captureStopped++;
  });
  assert.equal(page.active, false);
  assert.equal(page.begin(), true);
  const token = guard.begin("master");
  const lateTranscript = () => {
    if (page.active && guard.claimTranscript(token, "master", "late audio")) submitted++;
  };
  document.visibility("hidden");
  assert.equal(input.signal.aborted, true);
  assert.equal(output.signal.aborted, true);
  assert.equal(captureStopped, 1);
  assert.equal(page.begin(), false);
  lateTranscript();
  document.visibility("visible");
  window.dispatchEvent(new Event("pageshow"));
  assert.equal(page.canStart, true);
  assert.equal(page.active, false);
  lateTranscript();
  assert.equal(submitted, 0);
  assert.deepEqual(acceptedTasks, [{ id: "already-accepted", status: "running" }]);
  assert.equal(page.begin(), true); // Explicit Start, never visibility restoration.
  const next = guard.begin("master");
  assert.equal(guard.claimTranscript(next, "master", "new gesture request"), "new gesture request");
  assert.equal(guard.claimTranscript(next, "master", "duplicate callback"), undefined);
  page.dispose();
});

test("pagehide suspends even while visibility reports visible; pageshow never replays accepted history", () => {
  const document = new Page(), window = new EventTarget(), guard = new VoiceSessionGuard();
  const page = new VoicePageLifecycle(document, window, () => guard.reset());
  page.begin();
  const token = guard.begin("master");
  guard.claimTranscript(token, "master", "request");
  guard.acceptTranscript(token, "master", { id: "finished-away", requestId: "old-request", chatId: "master" });
  window.dispatchEvent(new Event("pagehide"));
  assert.equal(page.canStart, false);
  assert.equal(page.active, false);
  assert.equal(guard.claimFreshOutcome("master", [outcome("finished-away", 2000)]), undefined);
  window.dispatchEvent(new Event("pageshow"));
  assert.equal(page.active, false);
  assert.equal(guard.claimFreshOutcome("master", [outcome("finished-away", 2000)]), undefined);
  page.begin();
  const next = guard.begin("master", [outcome("finished-away", 2000)]);
  guard.claimTranscript(next, "master", "new request");
  guard.acceptTranscript(next, "master", { id: "new-task", requestId: "new-request", chatId: "master" });
  assert.equal(guard.claimFreshOutcome("master", [outcome("finished-away", 2000)]), undefined);
  assert.equal(guard.claimFreshOutcome("master", [outcome("new-task", 4000)])?.id, "new-task");
  page.dispose();
});

test("visibility itself gates late work before its event; dispose detaches listeners permanently", () => {
  const document = new Page(), window = new EventTarget();
  let stops = 0;
  const page = new VoicePageLifecycle(document, window, () => stops++);
  page.begin();
  document.visibilityState = "hidden";
  assert.equal(page.active, false);
  assert.equal(page.canStart, false);
  page.dispose();
  document.visibility("visible");
  window.dispatchEvent(new Event("pageshow"));
  window.dispatchEvent(new Event("pagehide"));
  assert.equal(stops, 0);
  assert.equal(page.begin(), false);
});

test("an initial pageshow event does not orphan a capture started while page resources finish loading", () => {
  const document = new Page(), window = new EventTarget();
  let stops = 0;
  const page = new VoicePageLifecycle(document, window, () => stops++);
  page.begin();
  window.dispatchEvent(new Event("pageshow"));
  assert.equal(page.active, true);
  assert.equal(stops, 0);
  page.dispose();
});

function synthesis() {
  const utterances: (BrowserUtterance & { text: string })[] = [];
  const timers = new Map<number, { callback: () => void; milliseconds: number }>();
  let nextTimer = 0, speaks = 0, cancels = 0;
  const environment: BrowserSpeechEnvironment = {
    createUtterance(text) {
      const utterance = { text, onstart: null, onend: null, onerror: null };
      utterances.push(utterance); return utterance;
    },
    speak() { speaks++; },
    cancel() { cancels++; },
    setTimer(callback, milliseconds) { const id = ++nextTimer; timers.set(id, { callback, milliseconds }); return id; },
    clearTimer(timer) { timers.delete(timer as number); },
  };
  const fire = (milliseconds: number) => {
    const match = [...timers.values()].find(timer => timer.milliseconds === milliseconds);
    assert.ok(match); match.callback();
  };
  return { environment, utterances, timers, fire, speaks: () => speaks, cancels: () => cancels };
}

test("a silent browser speech engine times out at startup and permits only explicit playback retry", async () => {
  const f = synthesis(), signal = new AbortController().signal;
  let playing = 0;
  const first = playBrowserSpeech("Already accepted task reply", signal, () => playing++, f.environment);
  const rejected = assert.rejects(first, error => error instanceof SpeechPlaybackError && error.canReplay);
  const staleStart = f.utterances[0].onstart!, staleEnd = f.utterances[0].onend!;
  f.fire(10000);
  await rejected;
  assert.equal(f.speaks(), 1);
  assert.equal(f.cancels(), 1);
  assert.equal(f.timers.size, 0);
  staleStart(); staleEnd();
  assert.equal(playing, 0);
  assert.equal(f.speaks(), 1); // No timer/callback retries playback.
  const retry = playBrowserSpeech("Already accepted task reply", signal, () => playing++, f.environment);
  assert.equal(f.speaks(), 2); // speak() occurs synchronously within this explicit call/gesture.
  f.utterances[1].onstart!();
  f.utterances[1].onend!();
  await retry;
  assert.equal(playing, 1);
  assert.equal(f.cancels(), 1);
  assert.equal(f.timers.size, 0);
});

test("started browser speech has a bounded completion timer and cannot announce completion after timeout", async () => {
  const f = synthesis();
  const pending = playBrowserSpeech("Reply", new AbortController().signal, undefined, f.environment);
  const rejected = assert.rejects(pending, error => error instanceof SpeechPlaybackError && error.canReplay);
  f.utterances[0].onstart!();
  assert.equal([...f.timers.values()].some(timer => timer.milliseconds === 10000), false);
  const lateEnd = f.utterances[0].onend!;
  f.fire(300000);
  await rejected;
  lateEnd();
  assert.equal(f.cancels(), 1);
  assert.equal(f.speaks(), 1);
  assert.equal(f.timers.size, 0);
});

test("Stop or context change synchronously cancels browser speech and ignores old callbacks without cancelling a newer reply", async () => {
  const f = synthesis(), old = new AbortController();
  let oldPlaying = 0;
  const pending = playBrowserSpeech("Old context reply", old.signal, () => oldPlaying++, f.environment);
  const rejected = assert.rejects(pending, error => error instanceof DOMException && error.name === "AbortError");
  const staleStart = f.utterances[0].onstart!, staleEnd = f.utterances[0].onend!;
  old.abort();
  assert.equal(f.cancels(), 1);
  assert.equal(f.timers.size, 0);
  const next = playBrowserSpeech("New explicit reply", new AbortController().signal, undefined, f.environment);
  staleStart(); staleEnd();
  await rejected;
  assert.equal(oldPlaying, 0);
  assert.equal(f.cancels(), 1);
  f.utterances[1].onstart!();
  f.utterances[1].onend!();
  await next;
  assert.equal(f.cancels(), 1);
});

test("hidden-page suspension aborts active fallback playback, and returning alone creates no new utterance", async () => {
  const document = new Page(), window = new EventTarget(), controller = new AbortController(), f = synthesis();
  const page = new VoicePageLifecycle(document, window, () => controller.abort());
  page.begin();
  const playback = playBrowserSpeech("Reply", controller.signal, undefined, f.environment);
  const rejected = assert.rejects(playback, error => error instanceof DOMException && error.name === "AbortError");
  document.visibility("hidden");
  await rejected;
  document.visibility("visible");
  window.dispatchEvent(new Event("pageshow"));
  assert.equal(page.active, false);
  assert.equal(f.speaks(), 1);
  assert.equal(f.cancels(), 1);
  page.dispose();
});

test("pre-aborted playback cannot touch the speech engine", async () => {
  const controller = new AbortController(), f = synthesis();
  controller.abort();
  await assert.rejects(playBrowserSpeech("Reply", controller.signal, undefined, f.environment), error => error instanceof DOMException && error.name === "AbortError");
  assert.equal(f.utterances.length, 0);
  assert.equal(f.speaks(), 0);
  assert.equal(f.cancels(), 0);
  assert.equal(f.timers.size, 0);
});
