import { z } from "zod";
import { loadSpeechConfig, providerLabel, type VoiceConfiguration, type PrivateSpeechConfig } from "./voice-config.js";
import { requestElevenLabsSpeech } from "./elevenlabs.js";
import { SpeechError } from "./speech-error.js";
export { SpeechError } from "./speech-error.js";

export const MAX_SPEECH_CHARS = 4000;
export const MAX_SPEECH_AUDIO_BYTES = 4 * 1024 * 1024;
const speechInput = z.object({
  requestId: z.string().min(1).max(200),
  text: z.string().trim().min(1).max(MAX_SPEECH_CHARS),
}).strict();

/** Speech uses the private local credential; it never creates an agent conversation. */
export class Speech {
  #settings: PrivateSpeechConfig;
  #used = new Set<string>();
  #busy = false;
  constructor(config: VoiceConfiguration, private providerFetch: typeof fetch = fetch, privateSettings?: PrivateSpeechConfig) {
    if (privateSettings) { this.#settings = privateSettings; return; }
    try {
      this.#settings = loadSpeechConfig(config);
    } catch {
      // Keep public provider/model/voice metadata, with every credential source disabled.
      // Explicit output-file failure must not borrow input, alternate or ambient keys.
      this.#settings = loadSpeechConfig({
        ...config,
        speechEnvFile: undefined,
        transcriptionEnvFile: undefined,
        elevenLabsEnvFile: undefined,
      }, {});
      console.error("Speech unavailable: check the selected provider's private configuration. Text work remains available.");
    }
  }
  get provider() { return providerLabel(this.#settings.provider); }
  get voice() { return this.#settings.voice; }
  get configured() { return Boolean(this.#settings.apiKey && this.#settings.voice && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(this.#settings.voice)); }
  get unavailableReason(): "provider_not_configured" | "voice_id_required" | undefined {
    return !this.#settings.apiKey ? "provider_not_configured" : !this.configured ? "voice_id_required" : undefined;
  }
  async synthesize(input: unknown, signal?: AbortSignal): Promise<Buffer> {
    const parsed = speechInput.safeParse(input);
    if (!parsed.success) throw new SpeechError(400, `Provide a request ID and 1–${MAX_SPEECH_CHARS} characters of speech text.`);
    if (!this.configured) throw new SpeechError(503, this.unavailableReason === "voice_id_required"
      ? "Select an account-accessible ElevenLabs voice in private server configuration."
      : `${this.provider} voice is not configured.`);
    if (this.#used.has(parsed.data.requestId)) throw new SpeechError(409, "This speech request was already submitted. It was not replayed.");
    if (this.#busy) throw new SpeechError(409, "A voice reply is already being generated.");
    this.#used.add(parsed.data.requestId);
    // ceiling: only the 512 most recent identities stay single-use, so a replay older than
    // that is billable again. Raising it costs memory, not correctness.
    if (this.#used.size > 512) this.#used.delete(this.#used.values().next().value!);
    this.#busy = true;
    const timeout = AbortSignal.timeout(60_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      combinedSignal.throwIfAborted();
      const response = this.#settings.provider === "elevenlabs"
        ? await requestElevenLabsSpeech(parsed.data.text, this.#settings.apiKey!, this.#settings.voice!, this.#settings.model, combinedSignal, this.providerFetch)
        : await this.providerFetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#settings.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.#settings.model, voice: this.voice, input: parsed.data.text, response_format: "mp3" }),
        signal: combinedSignal,
        redirect: "error",
      });
      if (combinedSignal.aborted) { void response.body?.cancel().catch(() => {}); combinedSignal.throwIfAborted(); }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new SpeechError(response.status === 429 ? 429 : response.status === 402 ? 402 : 503,
          response.status === 401 || response.status === 403 ? `${this.provider} rejected the private credential or requested voice/model access.` :
          response.status === 402 ? `${this.provider} account credits or plan access are insufficient for this request.` :
          response.status === 429 ? `${this.provider} voice is rate limited. No automatic retry was made.` : `${this.provider} voice is unavailable. No automatic retry was made.`);
      }
      if (!response.body || !/^(audio\/(mpeg|mp3)|application\/octet-stream)(;|$)/i.test(response.headers.get("content-type") ?? "")) {
        await response.body?.cancel();
        throw new SpeechError(502, `${this.provider} voice returned an invalid audio response.`);
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (combinedSignal.aborted) { void reader.cancel().catch(() => {}); combinedSignal.throwIfAborted(); }
          if (done) break;
          size += value.byteLength;
          if (size > MAX_SPEECH_AUDIO_BYTES) {
            await reader.cancel();
            throw new SpeechError(502, `The voice reply exceeded its ${MAX_SPEECH_AUDIO_BYTES} byte audio limit.`);
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      combinedSignal.throwIfAborted();
      if (!size) throw new SpeechError(502, `${this.provider} voice returned an empty audio reply.`);
      return Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof SpeechError) throw error;
      throw new SpeechError(signal?.aborted ? 499 : timeout.aborted ? 504 : 502,
        signal?.aborted ? "Voice reply stopped." : "The voice connection failed or timed out. No automatic retry was made.");
    } finally { this.#busy = false; }
  }
}
