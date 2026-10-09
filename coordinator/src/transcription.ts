import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export const MAX_AUDIO_BYTES = 512 * 1024;
export const MAX_TRANSCRIPT_CHARS = 8000;
export const TRANSCRIPTION_TIMEOUT_MS = 60_000;
const MAX_BASE64_CHARS = Math.ceil(MAX_AUDIO_BYTES / 3) * 4;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const TRANSCRIPTION_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
export const audioMimeSchema = z.enum([
  "audio/webm",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
]);
export type AudioMimeType = z.infer<typeof audioMimeSchema>;
export type AudioInput = { base64: string; mimeType: AudioMimeType };
export type TranscriptionResult = { text: string };

const errors = {
  invalid_audio: [
    400,
    "Provide nonempty canonical base64 audio in a supported recording format.",
  ],
  audio_too_large: [413, "The audio recording exceeds the 512 KiB limit."],
  invalid_request: [
    400,
    "Provide a request ID, device ID and valid audio recording.",
  ],
  provider_not_configured: [
    503,
    "Transcription is not configured on the selected device.",
  ],
  provider_authentication: [
    503,
    "The selected device's transcription credential was rejected. Its owner must check the private provider configuration.",
  ],
  provider_rejected: [
    422,
    "The transcription provider rejected this request. Check the recording, model, account access and available credits.",
  ],
  provider_rate_limited: [
    429,
    "The transcription provider is rate limited. This request was not automatically retried.",
  ],
  provider_unavailable: [
    503,
    "The transcription provider is unavailable. This request was not automatically retried.",
  ],
  provider_network: [
    502,
    "The transcription connection failed. The provider outcome may be unknown; this request was not automatically retried.",
  ],
  provider_timeout: [
    504,
    "Transcription timed out after 60 seconds. The provider may have processed the audio; this request was not automatically retried.",
  ],
  invalid_response: [
    502,
    "The transcription provider returned an invalid response.",
  ],
  no_speech: [422, "No speech was recognized in the recording."],
  transcript_too_long: [
    422,
    "The transcript exceeds the 8000 character limit. Record a shorter message.",
  ],
  request_conflict: [
    409,
    "This transcription request ID was already used with different audio or a different device.",
  ],
  transcription_busy: [
    409,
    "This device is already transcribing a recording. Wait for its result before submitting another.",
  ],
  history_full: [
    409,
    "Transcription history is full. Existing request identities are retained to prevent duplicate provider calls.",
  ],
  unknown_job: [404, "Unknown transcription job."],
  invalid_state: [
    500,
    "Private transcription state could not be loaded. Preserve the file and inspect it before retrying.",
  ],
  state_write_failed: [
    500,
    "Transcription state could not be saved. Preserve the existing state; no automatic retry will be made.",
  ],
  worker_failed: [
    502,
    "The selected device could not finish transcription. No automatic retry was made.",
  ],
  restart_interrupted: [
    409,
    "The coordinator restarted while transcription was pending. The provider outcome may be unknown; no request was replayed.",
  ],
} as const;
export type TranscriptionErrorCode = keyof typeof errors;

/** Only fixed messages leave the provider/device boundary; never return raw errors. */
export class TranscriptionError extends Error {
  readonly status: number;
  constructor(readonly code: TranscriptionErrorCode) {
    super(errors[code][1]);
    this.name = "TranscriptionError";
    this.status = errors[code][0];
  }
}

export function validateAudio(input: unknown): {
  audio: AudioInput;
  bytes: Buffer;
} {
  if (!input || typeof input !== "object")
    throw new TranscriptionError("invalid_audio");
  const value = input as Record<string, unknown>;
  const mime = audioMimeSchema.safeParse(value.mimeType);
  if (!mime.success || typeof value.base64 !== "string" || !value.base64)
    throw new TranscriptionError("invalid_audio");
  if (value.base64.length > MAX_BASE64_CHARS)
    throw new TranscriptionError("audio_too_large");
  if (
    value.base64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value.base64,
    )
  )
    throw new TranscriptionError("invalid_audio");
  const bytes = Buffer.from(value.base64, "base64");
  if (bytes.length > MAX_AUDIO_BYTES)
    throw new TranscriptionError("audio_too_large");
  if (!bytes.length || bytes.toString("base64") !== value.base64)
    throw new TranscriptionError("invalid_audio");
  return { audio: { base64: value.base64, mimeType: mime.data }, bytes };
}

function transcript(value: unknown): TranscriptionResult {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as any).text !== "string"
  )
    throw new TranscriptionError("invalid_response");
  const text = (value as { text: string }).text.trim();
  if (text.length > MAX_TRANSCRIPT_CHARS)
    throw new TranscriptionError("transcript_too_long");
  if (!text) throw new TranscriptionError("no_speech");
  return { text };
}

async function providerJson(response: Response): Promise<unknown> {
  if (!response.body) throw new TranscriptionError("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new TranscriptionError("invalid_response");
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new TranscriptionError("invalid_response");
    }
  } finally {
    reader.releaseLock();
  }
}

/** Runs only on the device holding apiKey. One HTTPS attempt, no SDK retries.
 * Official contract: https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
 * The optional fetcher exists for isolated tests; the endpoint is never caller-configurable.
 */
export async function transcribeAudio(
  input: unknown,
  apiKey: string,
  model: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<TranscriptionResult> {
  const { audio, bytes } = validateAudio(input);
  if (
    typeof apiKey !== "string" ||
    apiKey.trim().length < 16 ||
    /\s/.test(apiKey.trim()) ||
    typeof model !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(model)
  )
    throw new TranscriptionError("provider_not_configured");
  const extension: Record<AudioMimeType, string> = {
    "audio/webm": "webm",
    "audio/mp4": "mp4",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
  };
  const form = new FormData();
  form.set(
    "file",
    new Blob([new Uint8Array(bytes)], { type: audio.mimeType }),
    `recording.${extension[audio.mimeType]}`,
  );
  form.set("model", model);
  form.set("response_format", "json");
  if (model === "gpt-4o-transcribe-diarize")
    form.set("chunking_strategy", "auto");
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    TRANSCRIPTION_TIMEOUT_MS,
  );
  try {
    const response = await fetcher(TRANSCRIPTION_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      body: form,
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if ([401, 403].includes(response.status))
        throw new TranscriptionError("provider_authentication");
      if (response.status === 429)
        throw new TranscriptionError("provider_rate_limited");
      if (response.status >= 500)
        throw new TranscriptionError("provider_unavailable");
      throw new TranscriptionError("provider_rejected");
    }
    const result = transcript(await providerJson(response));
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (controller.signal.aborted)
      throw new TranscriptionError("provider_timeout");
    if (error instanceof TranscriptionError) throw error;
    throw new TranscriptionError("provider_network");
  } finally {
    clearTimeout(timeout);
  }
}

const requestIdentity = z.object({
  requestId: z.string().trim().min(1).max(200),
  deviceId: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(200),
});
export type TranscriptionRequest = AudioInput & z.infer<typeof requestIdentity>;
const jobSchema = requestIdentity.extend({
  id: z.string().uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: audioMimeSchema,
  size: z.number().int().positive().max(MAX_AUDIO_BYTES),
  status: z.enum(["pending", "completed", "failed", "interrupted"]),
  text: z.string().max(MAX_TRANSCRIPT_CHARS),
  error: z.string().max(500).optional(),
  errorCode: z
    .custom<TranscriptionErrorCode>(
      (value) => typeof value === "string" && Object.hasOwn(errors, value),
    )
    .optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TranscriptionJob = z.infer<typeof jobSchema>;
const STORED_JOBS = 1000;
const stubbed = (job: TranscriptionJob) => job.errorCode === "history_full";

/** Single coordinator instance per file. Audio stays in memory only; no API key is accepted here.
 * Suggested authenticated routes: POST {requestId,deviceId,base64,mimeType} -> 202 job,
 * GET /:jobId -> job. Pending/failed/interrupted retries return the original record.
 * Evicted request IDs stay as text-free stubs so a replay still cannot re-bill; only the
 * 1000-entry store ceiling with no stub left to drop refuses a new recording.
 */
export class TranscriptionJobs {
  private jobs: TranscriptionJob[];
  private readonly maxJobs: number;
  constructor(
    private readonly options: {
      file: string;
      workerTranscribe: (
        deviceId: string,
        audio: AudioInput,
        requestId: string,
      ) => Promise<TranscriptionResult>;
      maxJobs?: number;
      onChange?: (job: TranscriptionJob) => void;
    },
  ) {
    this.maxJobs = options.maxJobs ?? 200;
    if (
      !Number.isInteger(this.maxJobs) ||
      this.maxJobs < 1 ||
      this.maxJobs > 1000
    )
      throw new TranscriptionError("invalid_state");
    try {
      this.jobs = existsSync(options.file)
        ? z
            .array(jobSchema)
            .max(1000)
            .parse(JSON.parse(readFileSync(options.file, "utf8")))
        : [];
      if (
        new Set(this.jobs.map((job) => job.requestId)).size !==
          this.jobs.length ||
        new Set(this.jobs.map((job) => job.id)).size !== this.jobs.length
      )
        throw new TranscriptionError("invalid_state");
    } catch {
      throw new TranscriptionError("invalid_state");
    }
    for (const job of this.jobs)
      if (job.status === "pending") {
        job.status = "interrupted";
        job.errorCode = "restart_interrupted";
        job.error = errors.restart_interrupted[1];
        job.updatedAt = new Date().toISOString();
      }
    this.save();
  }
  private save() {
    try {
      mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
      const temporary = this.options.file + ".tmp";
      writeFileSync(temporary, JSON.stringify(this.jobs, null, 2), {
        mode: 0o600,
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.options.file);
    } catch {
      throw new TranscriptionError("state_write_failed");
    }
  }
  private update(job: TranscriptionJob, patch: Partial<TranscriptionJob>) {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.save();
    // UI/event notification cannot turn a saved result into a failed provider job.
    try {
      this.options.onChange?.(structuredClone(job));
    } catch {}
  }
  get(id: string): TranscriptionJob {
    const job = this.jobs.find((item) => item.id === id);
    if (!job) throw new TranscriptionError("unknown_job");
    return structuredClone(job);
  }
  list(): TranscriptionJob[] {
    return structuredClone(this.jobs);
  }
  submit(input: unknown): TranscriptionJob {
    const identity = requestIdentity.safeParse(input);
    if (!identity.success) throw new TranscriptionError("invalid_request");
    const { audio, bytes } = validateAudio(input);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          identity.data.deviceId,
          audio.mimeType,
          createHash("sha256").update(bytes).digest("hex"),
        ]),
      )
      .digest("hex");
    const prior = this.jobs.find(
      (job) => job.requestId === identity.data.requestId,
    );
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new TranscriptionError("request_conflict");
      return structuredClone(prior);
    }
    // One recording at a time per device; another device's pending job never blocks this one.
    if (
      this.jobs.some(
        (job) =>
          job.status === "pending" && job.deviceId === identity.data.deviceId,
      )
    )
      throw new TranscriptionError("transcription_busy");
    this.makeRoom();
    const now = new Date().toISOString();
    const job: TranscriptionJob = {
      ...identity.data,
      id: randomUUID(),
      fingerprint,
      mimeType: audio.mimeType,
      size: bytes.length,
      status: "pending",
      text: "",
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.push(job);
    try {
      this.save();
    } catch (error) {
      // Reserve request identity before any device call or await.
      this.jobs.pop();
      throw error;
    }
    void this.run(job, audio);
    return structuredClone(job);
  }
  /** Identity outlives its transcript: the oldest finished job keeps its request ID and
   * fingerprint but drops its text, so a replayed ID still short-circuits without billing.
   * ceiling: the stored ceiling drops the oldest stub; a longer replay window needs a
   * separate identity index rather than a larger job file.
   */
  private makeRoom() {
    const full = this.jobs.filter(
      (job) => job.status !== "pending" && !stubbed(job),
    );
    // A negative end would make slice count from the end and evict live transcripts.
    const evicted = Math.max(0, full.length - this.maxJobs + 1);
    for (const job of full.slice(0, evicted))
      Object.assign(job, {
        text: "",
        errorCode: "history_full",
        error: errors.history_full[1],
        updatedAt: new Date().toISOString(),
      });
    if (this.jobs.length < STORED_JOBS) return;
    const oldest = this.jobs.findIndex(stubbed);
    if (oldest < 0) throw new TranscriptionError("history_full");
    this.jobs.splice(oldest, 1);
  }
  private async run(job: TranscriptionJob, audio: AudioInput) {
    let patch: Partial<TranscriptionJob>;
    try {
      const result = transcript(
        await this.options.workerTranscribe(job.deviceId, audio, job.requestId),
      );
      patch = { status: "completed", text: result.text };
    } catch (error) {
      const safe =
        error instanceof TranscriptionError
          ? error
          : new TranscriptionError("worker_failed");
      patch = { status: "failed", errorCode: safe.code, error: safe.message };
    }
    try {
      this.update(job, patch);
    } catch {
      // The reserved on-disk pending identity remains non-replayable after restart.
      Object.assign(job, {
        status: "interrupted",
        text: "",
        errorCode: "state_write_failed",
        error: errors.state_write_failed[1],
        updatedAt: new Date().toISOString(),
      });
    }
  }
}
