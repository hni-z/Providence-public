import { sessionCredentials } from "./api.js";

export type LiveSession = { session: { id: string }; transport: { type: "webrtc"; sdp: string } };
export class LiveSessionError extends Error {
  constructor(readonly status: number, readonly errorCode?: string) {
    const messages: Record<string, string> = {
      ai_consent_required: "Allow OpenAI processing in Account before starting voice.",
      api_key_rejected: "The saved OpenAI API key was rejected. Update it from a terminal in Account settings.",
      model_access_denied: "This API key does not have access to live voice. Check model access in Account settings.",
      insufficient_quota: "Your OpenAI API credit or spending limit has been reached. Check API billing before starting voice again.",
      rate_limited: "OpenAI is temporarily limiting voice requests. Wait a moment before trying again.",
      upstream_timeout: "Voice setup timed out. Try again when your connection is stable.",
      upstream_unavailable: "The voice service is unavailable right now. Try again later or use text.",
    };
    const message = errorCode && Object.hasOwn(messages, errorCode) ? messages[errorCode]
      : status === 401 ? "Your Providence sign-in has expired. Sign in again to start voice."
      : status === 403 ? "Voice is not authorized on this page. Open Account and sign in again."
      : status === 409 ? "This voice session or conversation changed. End any other voice session, then try again."
      : status === 429 ? "Voice requests are temporarily limited. Wait a moment; if it continues, check your API billing."
      : "Live voice could not connect. Try again or use text.";
    super(message);
  }
  get accountHelp() { return this.status === 401 || this.status === 403 || this.status === 429 ||
    ["api_key_rejected", "model_access_denied", "insufficient_quota", "ai_consent_required"].includes(this.errorCode ?? ""); }
}
async function failureCode(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader(); if (!reader) return;
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > 4096) { await reader.cancel(); return; }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value?.errorCode === "string" && ["api_key_rejected", "model_access_denied", "insufficient_quota", "rate_limited", "upstream_timeout", "upstream_unavailable", "ai_consent_required"].includes(value.errorCode) ? value.errorCode : undefined;
  } catch { return; }
  finally { reader.releaseLock(); }
}
/** Session creation can include provider startup and sideband attachment. Never auto-retry it. */
export async function createLiveSession(token: string, sdp: string | undefined, chatId: string, signal: AbortSignal): Promise<LiveSession> {
  const response = await fetch('/v1/live-voice/sessions', {
    method: 'POST', credentials: sessionCredentials(token), mode: 'same-origin', redirect: 'error', cache: 'no-store',
    referrerPolicy: 'same-origin', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sdp, chatId }), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) throw new LiveSessionError(response.status, await failureCode(response));
  return response.json();
}
