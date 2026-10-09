import { SpeechPlaybackError } from "./server-audio.js";

type VisibilitySource = EventTarget & { readonly visibilityState: string };

/** A visible page can arm voice only from its caller's explicit Start gesture.
 * Visibility restoration/pageshow never revive old captures or accepted-reply playback.
 */
export class VoicePageLifecycle {
  private armed = false;
  private away = false;
  private disposed = false;
  private readonly visibility = () => {
    if (this.document.visibilityState !== "visible") this.suspend();
  };
  private readonly hide = () => { this.away = true; this.suspend(); };
  private readonly show = () => { this.away = false; };

  constructor(
    private readonly document: VisibilitySource,
    private readonly window: EventTarget,
    private readonly onSuspend: () => void,
  ) {
    document.addEventListener("visibilitychange", this.visibility);
    window.addEventListener("pagehide", this.hide);
    window.addEventListener("pageshow", this.show);
  }
  get canStart() {
    return !this.disposed && !this.away && this.document.visibilityState === "visible";
  }
  get active() { return this.armed && this.canStart; }
  begin() {
    if (!this.canStart) return false;
    this.armed = true;
    return true;
  }
  stop() { this.armed = false; }
  private suspend() {
    this.stop();
    this.onSuspend();
  }
  dispose() {
    this.disposed = true;
    this.stop();
    this.document.removeEventListener("visibilitychange", this.visibility);
    this.window.removeEventListener("pagehide", this.hide);
    this.window.removeEventListener("pageshow", this.show);
  }
}

export interface BrowserUtterance {
  onstart: ((...args: any[]) => void) | null;
  onend: ((...args: any[]) => void) | null;
  onerror: ((...args: any[]) => void) | null;
}
export interface BrowserSpeechEnvironment {
  createUtterance(text: string): BrowserUtterance;
  speak(utterance: BrowserUtterance): void;
  cancel(): void;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}
function speechEnvironment(): BrowserSpeechEnvironment {
  return {
    createUtterance(text) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = navigator.language || "en-US";
      return utterance;
    },
    speak: utterance => window.speechSynthesis.speak(utterance as SpeechSynthesisUtterance),
    cancel: () => window.speechSynthesis.cancel(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
}

/** No task/provider call. Retries repeat browser playback only, from an explicit gesture. */
export function playBrowserSpeech(
  text: string,
  signal: AbortSignal,
  onPlaying?: () => void,
  environment: BrowserSpeechEnvironment = speechEnvironment(),
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Voice stopped", "AbortError")); return; }
    let done = false, owned = false;
    let timer: unknown;
    let utterance: BrowserUtterance | undefined;
    const finish = (error?: unknown) => {
      if (done) return;
      done = true;
      if (timer !== undefined) environment.clearTimer(timer);
      signal.removeEventListener("abort", stop);
      if (utterance) { utterance.onstart = null; utterance.onend = null; utterance.onerror = null; }
      // Cancel synchronously before settling; a late finally must not cancel a newer utterance.
      if (error && owned) { try { environment.cancel(); } catch {} }
      error ? reject(error) : resolve();
    };
    const stop = () => finish(new DOMException("Voice stopped", "AbortError"));
    const timeout = () => finish(new SpeechPlaybackError(
      "Browser voice playback timed out. Select Retry voice playback to try the text reply again.", true,
    ));
    try {
      utterance = environment.createUtterance(text);
      utterance.onstart = () => {
        if (done || signal.aborted) return;
        if (timer !== undefined) environment.clearTimer(timer);
        timer = environment.setTimer(timeout, 300000);
        try { onPlaying?.(); } catch (error) { finish(error); }
      };
      utterance.onend = () => finish();
      utterance.onerror = () => finish(new SpeechPlaybackError(
        "Your browser could not play this reply. Select Retry voice playback; the text remains available.", true,
      ));
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) { stop(); return; }
      timer = environment.setTimer(timeout, 10000);
      owned = true;
      environment.speak(utterance);
    } catch {
      finish(new SpeechPlaybackError("Your browser could not start voice playback. The text remains available.", true));
    }
  });
}
