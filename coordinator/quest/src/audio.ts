const MAX_RECORDING_MS = 30_000;
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

interface Recording {
  recorder: MediaRecorder;
  chunks: Blob[];
  discarded: boolean;
  promise: Promise<Blob | null>;
  resolve: (blob: Blob | null) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Explicit press-to-talk only. No recognition provider or background upload. */
export class MicrophoneCapture {
  #stream?: MediaStream;
  #recording?: Recording;
  #pending?: Promise<void>;
  #generation = 0;
  #disposed = false;

  constructor(private readonly onState: (state: string) => void) {}

  available(): boolean {
    return !this.#disposed && globalThis.isSecureContext !== false && typeof navigator !== 'undefined'
      && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof MediaRecorder !== 'undefined';
  }

  get enabled(): boolean {
    return !!this.#stream?.getAudioTracks().some((track) => track.readyState === 'live');
  }

  get recording(): boolean { return this.#recording?.recorder.state === 'recording'; }

  /** Invoke directly from the Enable microphone button before immersive entry. */
  async enable(): Promise<void> {
    if (!this.available()) throw new Error('Microphone recording is unavailable in this browser. Use text input.');
    if (this.enabled || this.#pending) return this.#pending;
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      throw new Error('Select Enable microphone to request permission.');
    }
    const generation = this.#generation;
    this.onState('Waiting for microphone permission');
    const pending = (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Permission grants access, not recording. Immediately mute every acquired track.
        for (const track of stream.getTracks()) track.enabled = false;
        if (this.#disposed || generation !== this.#generation) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) {
          for (const track of stream.getTracks()) track.stop();
          throw new Error('No audio track');
        }
        this.#stream = stream;
        for (const track of stream.getAudioTracks()) {
          track.addEventListener('ended', () => {
            if (this.#stream !== stream) return;
            this.cancel();
            for (const remaining of stream.getTracks()) remaining.stop();
            this.#stream = undefined;
            this.onState('Microphone disconnected. Enable it again or use text input.');
          }, { once: true });
        }
        this.onState('Microphone ready');
      } catch (error) {
        if (this.#disposed || generation !== this.#generation) return;
        const denied = error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name);
        const message = denied ? 'Microphone permission denied. Use text input or change browser permission.'
          : 'Microphone unavailable. Check the microphone or use text input.';
        this.onState(message);
        throw new Error(message);
      }
    })();
    this.#pending = pending;
    try { await pending; }
    finally { if (this.#pending === pending) this.#pending = undefined; }
  }

  start(): void {
    if (this.#disposed || !this.enabled || !this.#stream) throw new Error('Enable the microphone before recording.');
    if (this.#recording) throw new Error('Finish the current recording first.');
    const stream = this.#stream;
    const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type));
    let recorder: MediaRecorder;
    try { recorder = new MediaRecorder(stream, { audioBitsPerSecond: 32_000, ...(mimeType ? { mimeType } : {}) }); }
    catch { throw new Error('This browser could not start audio recording. Use text input.'); }
    let resolve!: (blob: Blob | null) => void;
    const promise = new Promise<Blob | null>((done) => { resolve = done; });
    const recording: Recording = { recorder, chunks: [], discarded: false, promise, resolve };
    this.#recording = recording;
    recorder.addEventListener('dataavailable', (event) => {
      if (!recording.discarded && event.data.size) recording.chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      clearTimeout(recording.timer);
      if (this.#recording === recording) this.#mute();
      const blob = !recording.discarded && recording.chunks.length
        ? new Blob(recording.chunks, { type: recorder.mimeType || recording.chunks[0].type }) : null;
      recording.chunks.length = 0;
      recording.resolve(blob);
    }, { once: true });
    recorder.addEventListener('error', () => {
      if (this.#recording !== recording) return;
      this.cancel();
      this.onState('Recording failed. Use text input or try the microphone again.');
    }, { once: true });
    try {
      for (const track of stream.getAudioTracks()) track.enabled = true;
      recorder.start();
      recording.timer = setTimeout(() => {
        this.#halt(recording);
        this.onState('Recording limit reached');
      }, MAX_RECORDING_MS);
      this.onState('Recording');
    } catch {
      this.cancel();
      throw new Error('This browser could not start audio recording. Use text input.');
    }
  }

  #mute(): void {
    for (const track of this.#stream?.getTracks() ?? []) track.enabled = false;
  }

  #halt(recording: Recording): void {
    clearTimeout(recording.timer);
    if (this.#recording === recording) this.#mute();
    if (recording.recorder.state !== 'inactive') {
      try { recording.recorder.stop(); }
      catch { recording.discarded = true; recording.resolve(null); }
    }
  }

  /** Also retrieves a recording automatically halted at 30 seconds. No upload occurs. */
  async stop(): Promise<Blob | null> {
    const recording = this.#recording;
    if (!recording) return null;
    this.#halt(recording);
    const blob = await recording.promise;
    if (this.#recording !== recording || recording.discarded) return null;
    this.#recording = undefined;
    this.onState('Microphone ready');
    return blob;
  }

  cancel(): void {
    this.#mute();
    const recording = this.#recording;
    if (!recording) return;
    recording.discarded = true;
    recording.chunks.length = 0;
    this.#halt(recording);
    recording.resolve(null);
    this.#recording = undefined;
    this.onState('Recording discarded');
  }

  /** Release access without preventing a later explicit Enable microphone gesture. */
  disable(): void {
    this.#generation++;
    this.#pending = undefined;
    this.cancel();
    const stream = this.#stream;
    this.#stream = undefined;
    for (const track of stream?.getTracks() ?? []) track.stop();
    this.onState('Microphone off');
  }

  dispose(): void {
    this.#disposed = true;
    this.disable();
  }
}
