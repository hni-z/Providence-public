interface ArmedCompletion {
  requestId: string;
  chatId: string;
}

const identity = (value: string): boolean =>
  typeof value === "string" && value.trim().length > 0;

/**
 * In-memory eligibility only; no audio, storage, timers, or provider behavior.
 * Enabled by default but inert until the caller explicitly arms a newly accepted
 * request from the current deliberate primary-voice session. Never arm restored
 * history, pending-submission recovery, ordinary text, or manual transcription.
 *
 * One claim consumes the request before any asynchronous playback can start.
 * Invalidate before manual playback/retry and on stop, chat/logout, configuration
 * loss, or connection loss. Re-enabling cannot revive an old accepted request.
 */
export class CompletionSpeechGate {
  #enabled = true;
  #armed?: ArmedCompletion;
  // Retire accepted identities for this page lifetime, including muted sessions.
  // Request IDs are globally unique; changing chat cannot revive the same request.
  #seenRequests = new Set<string>();

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled === true;
    if (!this.#enabled) this.invalidate();
  }

  arm(requestId: string, chatId: string): void {
    if (this.#armed?.requestId === requestId && this.#armed.chatId === chatId) return;
    this.invalidate();
    if (!identity(requestId) || !identity(chatId) || this.#seenRequests.has(requestId)) return;
    this.#seenRequests.add(requestId);
    if (this.#enabled) this.#armed = { requestId, chatId };
  }

  /** Call immediately before playback/provider work, not after its promise resolves. */
  claim(requestId: string, chatId: string, replyId: string): boolean {
    if (!this.#enabled || !identity(replyId) || this.#armed?.requestId !== requestId
      || this.#armed.chatId !== chatId) return false;
    this.#armed = undefined;
    return true;
  }

  invalidate(): void {
    this.#armed = undefined;
  }
}
