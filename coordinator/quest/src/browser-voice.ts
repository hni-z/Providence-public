/** Optional browser voice only. Speech recognition may use the browser's online service. */
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly [index: number]: { readonly transcript: string };
}
interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<RecognitionResult>;
}
interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface UtteranceLike {
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}
interface SynthesisLike {
  speaking?: boolean;
  pending?: boolean;
  speak(utterance: UtteranceLike): void;
  cancel(): void;
}
interface VoiceScope {
  SpeechRecognition?: new () => RecognitionLike;
  webkitSpeechRecognition?: new () => RecognitionLike;
  SpeechSynthesisUtterance?: new (text: string) => UtteranceLike;
  speechSynthesis?: SynthesisLike;
  setTimeout?: (callback: () => void, milliseconds: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}
interface Clock {
  set(callback: () => void, milliseconds: number): unknown;
  clear(timer: unknown): void;
}

const MAX_CAPTURE_MS = 25_000;
const FINISH_TIMEOUT_MS = 5_000;
const MAX_TRANSCRIPT_LENGTH = 8_000;
const MAX_SPEECH_LENGTH = 4_000;
const SPEECH_START_TIMEOUT_MS = 10_000;
const SPEECH_FINISH_TIMEOUT_MS = 300_000;
const NO_SPEECH = 'No speech was recognized. Try again or use text input.';

function defaultScope(): unknown { return typeof window === 'undefined' ? undefined : window; }
function voiceScope(scope: unknown): VoiceScope {
  return scope !== null && (typeof scope === 'object' || typeof scope === 'function') ? scope as VoiceScope : {};
}
function clockFor(scope: VoiceScope): Clock {
  if (typeof scope.setTimeout === 'function' && typeof scope.clearTimeout === 'function') {
    return { set: scope.setTimeout.bind(scope), clear: scope.clearTimeout.bind(scope) };
  }
  return { set: (callback, milliseconds) => setTimeout(callback, milliseconds), clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };
}
function recognitionError(code?: string): string {
  if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'NotAllowedError' || code === 'SecurityError') return 'Dictation permission was denied. Use text input or change the browser permission.';
  if (code === 'network' || code === 'NetworkError') return 'The browser dictation service could not connect. Use text input or try again later.';
  if (code === 'no-speech') return NO_SPEECH;
  if (code === 'audio-capture' || code === 'NotFoundError') return 'The microphone is unavailable for dictation. Use text input.';
  if (code === 'language-not-supported') return 'The browser does not support dictation in this language. Use text input.';
  if (code === 'aborted') return 'Dictation stopped without a transcript.';
  return 'Browser dictation failed. Use text input or try again.';
}
function errorName(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'name' in error && typeof error.name === 'string' ? error.name : undefined;
}

interface Capture {
  recognition: RecognitionLike;
  generation: number;
  finals: Map<number, string>;
  stopping: boolean;
  limitTimer?: unknown;
  finishTimer?: unknown;
}

/**
 * Explicit start/stop/cancel lifecycle. Nothing starts on construction and no
 * interim text is delivered. The caller owns the final transcript's UI and routing.
 */
export class BrowserDictation {
  private readonly scope: VoiceScope;
  private readonly clock: Clock;
  private capture?: Capture;
  private generation = 0;
  private disposed = false;

  constructor(private readonly onState: (state: string) => void, private readonly onTranscript: (text: string) => void, scope: unknown = defaultScope()) {
    this.scope = voiceScope(scope);
    this.clock = clockFor(this.scope);
  }

  available(): boolean { return !this.disposed && !!this.recognitionConstructor(); }
  /** Includes permission/startup and finalization, keeping the UI half-duplex. */
  get active(): boolean { return !!this.capture; }

  start(): void {
    if (this.disposed) return;
    if (this.capture) { this.onState('Dictation is already active. Stop or cancel it first.'); return; }
    const Constructor = this.recognitionConstructor();
    if (!Constructor) { this.onState('Browser dictation is unavailable. Use text input.'); return; }
    let recognition: RecognitionLike;
    try { recognition = new Constructor(); }
    catch { this.onState('Browser dictation is unavailable. Use text input.'); return; }
    const capture: Capture = { recognition, generation: ++this.generation, finals: new Map(), stopping: false };
    this.capture = capture;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onstart = () => {
      if (this.current(capture) && !capture.stopping) this.onState('Listening. Speak now.');
    };
    recognition.onresult = event => {
      if (!this.current(capture)) return;
      // Indices refer to the complete recognition result list, so repeat/interim
      // events replace an index instead of appending a duplicate phrase.
      if (event.results.length > 256) { this.fail(capture, 'Dictation was too long. Record a shorter request.'); return; }
      for (let index = Math.max(0, event.resultIndex); index < event.results.length; index++) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript;
        if (result?.isFinal && typeof transcript === 'string') capture.finals.set(index, transcript.trim());
      }
      if (this.finalText(capture).length > MAX_TRANSCRIPT_LENGTH) this.fail(capture, 'Dictation was too long. Record a shorter request.');
    };
    recognition.onerror = event => {
      if (this.current(capture)) this.fail(capture, recognitionError(event.error));
    };
    recognition.onend = () => {
      if (!this.current(capture)) return;
      const transcript = this.finalText(capture);
      this.release(capture, false);
      const deliveryGeneration = this.generation;
      this.onState(transcript ? 'Final transcript ready.' : NO_SPEECH);
      // A caller can synchronously cancel/logout from onState; do not then deliver.
      if (transcript && transcript.length <= MAX_TRANSCRIPT_LENGTH && !this.disposed && this.generation === deliveryGeneration) this.onTranscript(transcript);
    };
    capture.limitTimer = this.clock.set(() => {
      if (this.current(capture)) this.finish(capture, '25-second limit reached. Finishing dictation…');
    }, MAX_CAPTURE_MS);
    this.onState('Starting browser dictation…');
    if (!this.current(capture)) return;
    // Synchronous call preserves the explicit user gesture. No fallback/retry.
    try { recognition.start(); }
    catch (error) { if (this.current(capture)) this.fail(capture, recognitionError(errorName(error))); }
  }

  stop(): void {
    if (this.capture) this.finish(this.capture, 'Finishing dictation…');
  }

  cancel(): void {
    const capture = this.capture;
    if (capture) this.release(capture, true);
    else this.generation++;
    if (capture && !this.disposed) this.onState('Dictation cancelled.');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }

  private recognitionConstructor(): (new () => RecognitionLike) | undefined {
    if (typeof this.scope.SpeechRecognition === 'function') return this.scope.SpeechRecognition;
    if (typeof this.scope.webkitSpeechRecognition === 'function') return this.scope.webkitSpeechRecognition;
    return undefined;
  }
  private current(capture: Capture): boolean {
    return !this.disposed && this.capture === capture && capture.generation === this.generation;
  }
  private finalText(capture: Capture): string {
    return [...capture.finals].sort(([a], [b]) => a - b).map(([, value]) => value).filter(Boolean).join(' ').trim();
  }
  private finish(capture: Capture, state: string): void {
    if (!this.current(capture) || capture.stopping) return;
    capture.stopping = true;
    if (capture.limitTimer !== undefined) this.clock.clear(capture.limitTimer);
    capture.limitTimer = undefined;
    capture.finishTimer = this.clock.set(() => {
      if (this.current(capture)) this.fail(capture, 'Dictation did not finish. Try again or use text input.');
    }, FINISH_TIMEOUT_MS);
    this.onState(state);
    if (!this.current(capture)) return;
    try { capture.recognition.stop(); }
    catch (error) { if (this.current(capture)) this.fail(capture, recognitionError(errorName(error))); }
  }
  private fail(capture: Capture, message: string): void {
    this.release(capture, true);
    if (!this.disposed) this.onState(message);
  }
  private release(capture: Capture, abort: boolean): void {
    if (this.capture !== capture) return;
    this.capture = undefined;
    this.generation++;
    if (capture.limitTimer !== undefined) this.clock.clear(capture.limitTimer);
    if (capture.finishTimer !== undefined) this.clock.clear(capture.finishTimer);
    const recognition = capture.recognition;
    recognition.onstart = null; recognition.onresult = null; recognition.onerror = null; recognition.onend = null;
    capture.finals.clear();
    if (abort) { try { recognition.abort(); } catch { /* Already ended; never retry. */ } }
  }
}

interface Playback {
  utterance: UtteranceLike;
  generation: number;
  timer?: unknown;
}

/** Optional explicit read-aloud. It never inspects or automatically reads history. */
export class BrowserSpeech {
  private readonly scope: VoiceScope;
  private readonly clock: Clock;
  private playback?: Playback;
  private generation = 0;
  private disposed = false;

  constructor(private readonly onState: (state: string) => void, scope: unknown = defaultScope()) {
    this.scope = voiceScope(scope);
    this.clock = clockFor(this.scope);
  }
  available(): boolean {
    return !this.disposed && typeof this.scope.SpeechSynthesisUtterance === 'function' && typeof this.scope.speechSynthesis?.speak === 'function' && typeof this.scope.speechSynthesis?.cancel === 'function';
  }
  get active(): boolean { return !!this.playback; }

  speak(text: string): void {
    if (this.disposed) return;
    if (!this.available()) { this.onState('Browser read-aloud is unavailable. Use the text response.'); return; }
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value) { this.onState('Choose a response to read aloud.'); return; }
    if (value.length > MAX_SPEECH_LENGTH) { this.onState('This response is too long to read aloud. Choose up to 4,000 characters.'); return; }
    if (this.playback) {
      const replacementGeneration = this.generation + 1;
      this.cancel();
      // onState may invalidate the current context or start another playback.
      if (this.disposed || this.generation !== replacementGeneration || this.playback) return;
    }
    const synthesis = this.scope.speechSynthesis!;
    // Do not clear speech that this helper did not start.
    if (synthesis.speaking || synthesis.pending) { this.onState('Other speech is active. Stop it before reading this response.'); return; }
    let utterance: UtteranceLike;
    try { utterance = new this.scope.SpeechSynthesisUtterance!(value); }
    catch { this.onState('Browser read-aloud is unavailable. Use the text response.'); return; }
    const playback: Playback = { utterance, generation: ++this.generation };
    this.playback = playback;
    utterance.onstart = () => {
      if (!this.current(playback)) return;
      this.armTimeout(playback, SPEECH_FINISH_TIMEOUT_MS);
      this.onState('Reading response aloud.');
    };
    utterance.onend = () => {
      if (!this.current(playback)) return;
      this.release(playback, false);
      this.onState('Read-aloud finished.');
    };
    utterance.onerror = event => {
      if (!this.current(playback)) return;
      this.release(playback, true);
      this.onState(event.error === 'not-allowed' ? 'Speech playback was blocked. Use the text response.' : 'Speech playback failed. Use the text response.');
    };
    this.armTimeout(playback, SPEECH_START_TIMEOUT_MS);
    this.onState('Starting read-aloud…');
    if (!this.current(playback)) return;
    try { synthesis.speak(utterance); }
    catch { if (this.current(playback)) { this.release(playback, true); this.onState('Speech playback failed. Use the text response.'); } }
  }

  cancel(): void {
    const playback = this.playback;
    if (playback) this.release(playback, true);
    else this.generation++;
    if (playback && !this.disposed) this.onState('Read-aloud stopped.');
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }
  private current(playback: Playback): boolean {
    return !this.disposed && this.playback === playback && playback.generation === this.generation;
  }
  private armTimeout(playback: Playback, milliseconds: number): void {
    if (playback.timer !== undefined) this.clock.clear(playback.timer);
    playback.timer = this.clock.set(() => {
      if (!this.current(playback)) return;
      this.release(playback, true);
      this.onState('Speech playback timed out. Use the text response.');
    }, milliseconds);
  }
  private release(playback: Playback, cancel: boolean): void {
    if (this.playback !== playback) return;
    this.playback = undefined;
    this.generation++;
    if (playback.timer !== undefined) this.clock.clear(playback.timer);
    playback.utterance.onstart = null; playback.utterance.onend = null; playback.utterance.onerror = null;
    // Web Speech has no per-utterance cancel API. Only call its global cancel
    // while this helper owns an active utterance; callers enforce half-duplex.
    if (cancel) { try { this.scope.speechSynthesis?.cancel(); } catch { /* No retry or alternate playback. */ } }
  }
}
