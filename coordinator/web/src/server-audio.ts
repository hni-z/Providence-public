/** Bounded, ephemeral reply audio. No permission request or network action occurs on construction. */
export const MAX_SPEECH_BYTES = 4 * 1024 * 1024;
export type SpeechAudioState = "preparing" | "playing";
export type SpeechReplyIdentity = {
  id: string;
  contextKey: string;
  updatedAt?: string;
  onAudioState?: (state: SpeechAudioState) => void;
};
export class SpeechPlaybackError extends Error {
  constructor(
    message: string,
    readonly canReplay: boolean,
  ) {
    super(message);
    this.name = "SpeechPlaybackError";
  }
}
const aborted = () => new DOMException("Voice stopped", "AbortError");
export async function readSpeechAudio(
  response: Response,
  signal?: AbortSignal,
): Promise<Blob> {
  signal?.throwIfAborted();
  const mime = response.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  const declared = response.headers.get("Content-Length");
  if (
    mime !== "audio/mpeg" ||
    (declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > MAX_SPEECH_BYTES))
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error("The speech service returned invalid or oversized audio.");
  }
  if (!response.body) {
    const blob = await response.blob();
    signal?.throwIfAborted();
    if (!blob.size || blob.size > MAX_SPEECH_BYTES)
      throw new Error(
        "The speech service returned invalid or oversized audio.",
      );
    return blob;
  }
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const part = await reader.read();
      signal?.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_SPEECH_BYTES) {
        await reader.cancel();
        throw new Error("The speech service returned oversized audio.");
      }
      chunks.push(new Uint8Array(part.value).buffer);
    }
    if (!size) throw new Error("The speech service returned empty audio.");
    return new Blob(chunks, { type: "audio/mpeg" });
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
export interface PlaybackAudio {
  onended: ((...args: any[]) => void) | null;
  onerror: ((...args: any[]) => void) | null;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
}
export interface SpeechPlaybackEnvironment {
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
  createAudio(url: string): PlaybackAudio;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}
function browserEnvironment(): SpeechPlaybackEnvironment {
  return {
    createUrl: (blob) => URL.createObjectURL(blob),
    revokeUrl: (url) => URL.revokeObjectURL(url),
    createAudio: (url) => new Audio(url),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
}
export async function playSpeechBlob(
  blob: Blob,
  signal: AbortSignal,
  onPlaying?: () => void,
  environment: SpeechPlaybackEnvironment = browserEnvironment(),
): Promise<void> {
  signal.throwIfAborted();
  const url = environment.createUrl(blob);
  let audio: PlaybackAudio | undefined;
  try {
    audio = environment.createAudio(url);
    const current = audio;
    await new Promise<void>((resolve, reject) => {
      let done = false,
        timer: unknown;
      const finish = (error?: unknown) => {
        if (done) return;
        done = true;
        if (timer !== undefined) environment.clearTimer(timer);
        signal.removeEventListener("abort", stop);
        current.onended = null;
        current.onerror = null;
        error ? reject(error) : resolve();
      };
      const stop = () => {
        current.pause();
        finish(aborted());
      };
      const timeout = () =>
        finish(
          new SpeechPlaybackError(
            "Audio playback timed out. Retry playback uses the downloaded audio.",
            true,
          ),
        );
      current.onended = () => finish();
      current.onerror = () =>
        finish(
          new SpeechPlaybackError(
            "Audio playback failed. Retry playback uses the downloaded audio.",
            true,
          ),
        );
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) {
        stop();
        return;
      }
      timer = environment.setTimer(timeout, 10000);
      try {
        void current.play().then(
          () => {
            if (done || signal.aborted) return;
            if (timer !== undefined) environment.clearTimer(timer);
            timer = environment.setTimer(timeout, 300000);
            try {
              onPlaying?.();
            } catch (error) {
              finish(error);
            }
          },
          () =>
            finish(
              new SpeechPlaybackError(
                "The browser blocked audio playback. Use Retry voice playback to play the downloaded reply.",
                true,
              ),
            ),
        );
      } catch {
        finish(
          new SpeechPlaybackError(
            "Audio playback failed. Retry playback uses the downloaded audio.",
            true,
          ),
        );
      }
    });
  } finally {
    audio?.pause();
    audio?.removeAttribute("src");
    environment.revokeUrl(url);
  }
}
type CachedReply = {
  text: string;
  requestId: string;
  attempted: boolean;
  blob?: Blob;
};
export class ServerSpeechPlayer {
  private readonly cache = new Map<string, CachedReply>();
  private playback?: { controller: AbortController; generation: number };
  private generation = 0;
  constructor(
    private readonly load: (
      text: string,
      requestId: string,
      signal: AbortSignal,
    ) => Promise<Blob>,
    private readonly environment?: SpeechPlaybackEnvironment,
    private readonly requestId: () => string = () => crypto.randomUUID(),
  ) {}
  get active() {
    return !!this.playback;
  }
  hasAudio(key: string, text: string) {
    const entry = this.cache.get(key);
    return !!entry?.blob && entry.text === text;
  }
  canPlay(key: string, text: string) {
    const entry = this.cache.get(key);
    return (
      !this.active &&
      (!entry || (entry.text === text && (!entry.attempted || !!entry.blob)))
    );
  }
  cancel() {
    this.playback?.controller.abort();
  }
  clear() {
    this.generation++;
    this.cancel();
    this.cache.clear();
  }
  async play(
    key: string,
    text: string,
    signal: AbortSignal,
    onState?: (state: SpeechAudioState) => void,
  ): Promise<void> {
    signal.throwIfAborted();
    if (!key || !text.trim() || text.length > 4000)
      throw new SpeechPlaybackError(
        "This reply cannot be prepared for voice playback.",
        false,
      );
    if (this.playback)
      throw new SpeechPlaybackError(
        "Another reply is already playing or being prepared.",
        false,
      );
    let entry = this.cache.get(key);
    if (entry && entry.text !== text)
      throw new SpeechPlaybackError(
        "The saved reply identity has changed. Read the current text response.",
        false,
      );
    if (entry?.attempted && !entry.blob)
      throw new SpeechPlaybackError(
        "The earlier speech request did not return usable audio. It was not sent again.",
        false,
      );
    if (!entry) {
      entry = { text, requestId: this.requestId(), attempted: false };
      this.cache.set(key, entry);
    }
    const playback = {
      controller: new AbortController(),
      generation: this.generation,
    };
    this.playback = playback;
    const cancel = () => playback.controller.abort();
    signal.addEventListener("abort", cancel, { once: true });
    const current = () => {
      if (
        signal.aborted ||
        playback.controller.signal.aborted ||
        playback.generation !== this.generation
      )
        throw aborted();
    };
    try {
      if (!entry.blob) {
        onState?.("preparing");
        current();
        entry.attempted = true;
        let blob: Blob;
        try {
          blob = await this.load(
            text,
            entry.requestId,
            playback.controller.signal,
          );
        } catch (error) {
          current();
          // A refused request was never synthesized, so this reply may take a fresh identity.
          // Only an explicit playback action spends it.
          const status = (error as { status?: unknown } | null)?.status;
          const refused =
            typeof status === "number" &&
            [400, 401, 402, 403, 409, 429].includes(status);
          if (refused) {
            entry.attempted = false;
            entry.requestId = this.requestId();
          }
          throw new SpeechPlaybackError(
            error instanceof Error
              ? error.message
              : "The speech request failed. It was not retried.",
            refused,
          );
        }
        current();
        if (
          blob.type !== "audio/mpeg" ||
          !blob.size ||
          blob.size > MAX_SPEECH_BYTES
        )
          throw new SpeechPlaybackError(
            "The speech service returned invalid audio. It was not requested again.",
            false,
          );
        entry.blob = blob;
        // Keep at most two downloaded replies (8 MiB); no recording or credential is stored here.
        const cached = [...this.cache.entries()].filter(
          ([, value]) => value.blob,
        );
        for (const [oldKey] of cached.slice(0, -2)) this.cache.delete(oldKey);
      }
      current();
      try {
        await playSpeechBlob(
          entry.blob,
          playback.controller.signal,
          () => {
            current();
            onState?.("playing");
          },
          this.environment,
        );
      } catch (error) {
        current();
        if (error instanceof SpeechPlaybackError) throw error;
        throw new SpeechPlaybackError(
          "Audio playback failed. Retry playback uses the downloaded audio.",
          true,
        );
      }
      current();
    } finally {
      signal.removeEventListener("abort", cancel);
      if (this.playback === playback) this.playback = undefined;
    }
  }
}
