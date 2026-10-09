export const MAX_VOICE_RECORDING_BYTES = 512 * 1024;
export const MAX_VOICE_RECORDING_MS = 25_000;
export const MAX_VOICE_TRANSCRIPT_CHARS = 8000;
// Fixed 128 kbps MP3 fits 262 seconds in the 4 MiB reply cap, and speech runs about 17
// characters a second, so the server's 4000 character ceiling can outrun the audio cap.
export const MAX_VOICE_REPLY_CHARS = 3400;
export type VoiceOutcome = {
  id: string;
  contextKey: string;
  parentTaskId?: string;
  text: string;
  status: string;
  updatedAt: string;
};
export type AcceptedVoiceTask = { id: string; requestId: string; chatId: string };
export type VoiceCaptureToken = { generation: number; contextKey: string };
const finalStatuses = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** Playback belongs to the acknowledged task, never to chat timestamps or inferred prose.
 * This class neither records audio nor sends requests.
 */
export class VoiceSessionGuard {
  private generation = 0;
  private contextKey = "";
  private active = false;
  private transcriptClaimed = false;
  private recordingClaimed = false;
  private acceptedTask: AcceptedVoiceTask | undefined;
  private seen = new Set<string>();
  begin(
    contextKey: string,
    baseline: readonly VoiceOutcome[] = [],
  ): VoiceCaptureToken {
    this.reset(contextKey);
    this.active = true;
    this.ignoreOutcomes(contextKey, baseline);
    return { generation: this.generation, contextKey };
  }
  reset(contextKey = this.contextKey) {
    this.generation++;
    this.contextKey = contextKey;
    this.active = false;
    this.transcriptClaimed = false;
    this.recordingClaimed = false;
    this.acceptedTask = undefined;
    this.seen.clear();
  }
  isCurrent(token: VoiceCaptureToken, contextKey: string) {
    return (
      token.generation === this.generation &&
      token.contextKey === contextKey &&
      contextKey === this.contextKey &&
      this.active
    );
  }
  claimTranscript(
    token: VoiceCaptureToken,
    contextKey: string,
    text: string,
  ): string | undefined {
    if (!this.isCurrent(token, contextKey) || this.transcriptClaimed) return;
    const transcript = text.trim();
    if (!transcript)
      throw new Error("No speech was recognized. Nothing was sent.");
    if (transcript.length > MAX_VOICE_TRANSCRIPT_CHARS)
      throw new Error("The transcript is too long. Record a shorter request.");
    this.transcriptClaimed = true;
    return transcript;
  }
  /** Reserve the one batch upload before an asynchronous transcription call. */
  claimRecording(token: VoiceCaptureToken, contextKey: string): boolean {
    if (!this.isCurrent(token, contextKey) || this.recordingClaimed) return false;
    this.recordingClaimed = true;
    return true;
  }
  /** Only a confirmed pre-admission refusal permits another explicit upload. */
  releaseRefusedRecording(token: VoiceCaptureToken, contextKey: string): boolean {
    if (!this.isCurrent(token, contextKey) || !this.recordingClaimed || this.transcriptClaimed) return false;
    this.recordingClaimed = false;
    return true;
  }
  acceptTranscript(
    token: VoiceCaptureToken,
    contextKey: string,
    task: AcceptedVoiceTask,
  ) {
    if (!this.isCurrent(token, contextKey) || !this.transcriptClaimed)
      return false;
    if (
      !task || typeof task.id !== "string" || !task.id ||
      typeof task.requestId !== "string" || !task.requestId ||
      task.chatId !== contextKey
    )
      throw new Error("The accepted voice request did not identify this conversation's task.");
    if (this.acceptedTask)
      return this.acceptedTask.id === task.id && this.acceptedTask.requestId === task.requestId;
    this.acceptedTask = { id: task.id, requestId: task.requestId, chatId: task.chatId };
    return true;
  }
  ignoreOutcomes(contextKey: string, outcomes: readonly VoiceOutcome[]) {
    for (const outcome of outcomes) {
      if (
        outcome.contextKey === contextKey &&
        finalStatuses.has(outcome.status)
      )
        this.remember(outcome.id);
    }
  }
  private remember(id: string) {
    this.seen.add(id);
    if (this.seen.size > 1024)
      this.seen.delete(this.seen.values().next().value!);
  }
  allowsPlayback(contextKey: string, outcome: VoiceOutcome): boolean {
    return (
      contextKey === this.contextKey &&
      outcome.contextKey === contextKey &&
      !!this.acceptedTask &&
      (outcome.id === this.acceptedTask.id ||
        (contextKey === "master" && outcome.parentTaskId === this.acceptedTask.id))
    );
  }
  claimFreshOutcome(
    contextKey: string,
    outcomes: readonly VoiceOutcome[],
  ): VoiceOutcome | undefined {
    if (contextKey !== this.contextKey || !this.acceptedTask)
      return;
    const candidate = outcomes
      .filter(
        (outcome) =>
          this.allowsPlayback(contextKey, outcome) &&
          finalStatuses.has(outcome.status) &&
          outcome.text.trim() &&
          !this.seen.has(outcome.id),
      )
      .sort(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) ||
          left.id.localeCompare(right.id),
      )[0];
    if (!candidate) return;
    this.remember(candidate.id); // Reserve before any asynchronous speech request/playback.
    let text = candidate.text.trim().slice(0, MAX_VOICE_REPLY_CHARS);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    return { ...candidate, text };
  }
}

export type RecognitionResultLike = {
  isFinal: boolean;
  length: number;
  [index: number]: { transcript?: string };
};
export type RecognitionEventLike = {
  results: ArrayLike<RecognitionResultLike>;
};
export interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
export type RecognitionConstructor = new () => RecognitionLike;
export function recognitionConstructor(
  scope: unknown,
): RecognitionConstructor | undefined {
  if (!scope || typeof scope !== "object") return;
  const value = scope as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  const constructor = value.SpeechRecognition ?? value.webkitSpeechRecognition;
  return typeof constructor === "function"
    ? (constructor as RecognitionConstructor)
    : undefined;
}
export function browserTranscript(event: RecognitionEventLike): {
  finalText: string;
  interimText: string;
} {
  const finals: string[] = [],
    interim: string[] = [];
  for (let index = 0; index < Math.min(event.results.length, 100); index++) {
    const result = event.results[index];
    const text = result?.[0]?.transcript;
    if (typeof text !== "string") continue;
    (result.isFinal ? finals : interim).push(text);
  }
  const finalText = finals.join(" ").trim(),
    interimText = interim.join(" ").trim();
  if (
    finalText.length > MAX_VOICE_TRANSCRIPT_CHARS ||
    interimText.length > MAX_VOICE_TRANSCRIPT_CHARS
  )
    throw new Error("The transcript is too long. Record a shorter request.");
  return { finalText, interimText };
}
export function recordingMimeType(recorder: {
  isTypeSupported?: (type: string) => boolean;
}): string | undefined {
  return [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ].find((type) => recorder.isTypeSupported?.(type));
}
/** Created only when the initial upload was explicitly refused before admission. */
export class TranscriptionUploadRefused extends Error {}
export function transcriptionRefused(cause: unknown): boolean {
  return cause instanceof TranscriptionUploadRefused;
}
/** Only webm survives being concatenated from timesliced chunks; fragmented MP4 does not. */
export function recordingTimeslice(mimeType?: string): number | undefined {
  return mimeType?.startsWith("audio/webm") ? 250 : undefined;
}
export function recognitionErrorMessage(code?: string) {
  if (["not-allowed", "service-not-allowed"].includes(code ?? ""))
    return "Browser speech permission was denied. Voice stopped; use text or change browser permission.";
  if (code === "audio-capture")
    return "The browser could not access a microphone. Voice stopped.";
  if (code === "no-speech")
    return "No speech was recognized. Nothing was sent.";
  if (code === "network")
    return "The browser speech service could not connect. Nothing was retried.";
  if (code === "language-not-supported")
    return "The browser speech service does not support this language.";
  return "Browser recognition failed. Voice stopped and nothing was retried.";
}
export function voiceCaptureMethod(hasServerInput: boolean, allowBrowserRecognition: boolean) {
  return hasServerInput ? "recording" : allowBrowserRecognition ? "recognition" : undefined;
}
