import type { Approval, Chat, Device, Snapshot, Task } from './types';
import { parseVoiceConfig, type VoiceConfig, type VoiceProvider } from '../../web/src/voice-config.js';
import { readSpeechAudio } from '../../web/src/server-audio.js';

export type { VoiceConfig, VoiceProvider } from '../../web/src/voice-config.js';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface TranscriptionCapability {
  available: boolean;
  devices: { id: string; name: string; online: boolean; configured: boolean; provider?: VoiceProvider }[];
  mimeTypes: string[];
  maxAudioBytes: number;
  provider: VoiceProvider;
}

export interface TranscriptionRequest {
  requestId: string;
  deviceId: string;
  base64: string;
  mimeType: string;
}

export interface TranscriptionJob {
  id: string;
  requestId: string;
  deviceId: string;
  status: 'pending' | 'completed' | 'failed' | 'interrupted';
  text: string;
  error?: string;
  errorCode?: string;
}

export const MAX_TRANSCRIPTION_BYTES = 524_288;
export const TRANSCRIPTION_MIME_TYPES = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav'] as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

function supportedAudio(mimeType: unknown): mimeType is string {
  return typeof mimeType === 'string' && (TRANSCRIPTION_MIME_TYPES as readonly string[]).includes(mimeType);
}

function voiceProvider(value: unknown): value is VoiceProvider {
  return value === 'OpenAI' || value === 'ElevenLabs';
}

function audioSize(size: number, limit = MAX_TRANSCRIPTION_BYTES): void {
  if (!Number.isSafeInteger(size) || size < 1) throw new ApiError('Record some audio before requesting transcription.', 400, 'invalid_audio');
  if (size > Math.min(limit, MAX_TRANSCRIPTION_BYTES)) throw new ApiError('This recording is too large to transcribe. Record a shorter request.', 413, 'audio_too_large');
}

/** Convert only an explicitly captured recording; the returned audio stays in caller memory. */
export async function prepareTranscription(blob: Blob, deviceId: string, requestId: string = crypto.randomUUID()): Promise<TranscriptionRequest> {
  if (!identifier(deviceId) || !identifier(requestId)) throw new ApiError('Choose a transcription device and request identity.', 400, 'invalid_audio');
  audioSize(blob.size);
  const mimeType = blob.type.split(';', 1)[0].trim().toLowerCase();
  if (!supportedAudio(mimeType)) throw new ApiError('This recording format is not supported for transcription.', 415, 'unsupported_audio');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  audioSize(bytes.byteLength);
  let binary = '';
  // Chunk conversion avoids spreading a full recording onto the JavaScript stack.
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return { requestId, deviceId, base64: btoa(binary), mimeType };
}

function transcriptionCapability(value: unknown): TranscriptionCapability {
  const invalid = () => new ApiError('Transcription capabilities are unavailable or unreadable. Use text input.', 200, 'invalid_response');
  if (!record(value) || !record(value.transcription)) throw invalid();
  const capability = value.transcription;
  if (typeof capability.available !== 'boolean' || !voiceProvider(capability.provider)
    || !Number.isSafeInteger(capability.maxAudioBytes) || (capability.maxAudioBytes as number) < 1 || (capability.maxAudioBytes as number) > MAX_TRANSCRIPTION_BYTES
    || !Array.isArray(capability.mimeTypes) || !capability.mimeTypes.length || !capability.mimeTypes.every(supportedAudio)
    || !Array.isArray(capability.devices)) throw invalid();
  const devices: TranscriptionCapability['devices'] = [];
  for (const device of capability.devices) {
    if (!record(device) || !identifier(device.id) || !identifier(device.name) || typeof device.online !== 'boolean' || typeof device.configured !== 'boolean'
      || (device.provider !== undefined && !voiceProvider(device.provider))
      || devices.some((previous) => previous.id === device.id)) throw invalid();
    // Older configured workers used OpenAI. The coordinator default does not describe
    // those workers and must never relabel their recording destination.
    const provider = device.provider ?? (device.configured ? 'OpenAI' : undefined);
    devices.push({ id: device.id, name: device.name, online: device.online, configured: device.configured,
      ...(provider === undefined ? {} : { provider }) });
  }
  return { available: capability.available, devices, mimeTypes: [...capability.mimeTypes], maxAudioBytes: capability.maxAudioBytes as number, provider: capability.provider };
}

function transcriptionRequest(value: TranscriptionRequest): { body: TranscriptionRequest; size: number } {
  if (!record(value) || !identifier(value.requestId) || !identifier(value.deviceId) || typeof value.base64 !== 'string') throw new ApiError('The transcription request is invalid.', 400, 'invalid_audio');
  if (!supportedAudio(value.mimeType)) throw new ApiError('This recording format is not supported for transcription.', 415, 'unsupported_audio');
  // Validate caller-created requests too, and bound their decoded bytes before any upload.
  if (value.base64.length > Math.ceil(MAX_TRANSCRIPTION_BYTES / 3) * 4) throw new ApiError('This recording is too large to transcribe. Record a shorter request.', 413, 'audio_too_large');
  if (value.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.base64)) throw new ApiError('The recording bytes are invalid.', 400, 'invalid_audio');
  const size = value.base64.length / 4 * 3 - (value.base64.endsWith('==') ? 2 : value.base64.endsWith('=') ? 1 : 0);
  audioSize(size);
  return { body: { requestId: value.requestId, deviceId: value.deviceId, base64: value.base64, mimeType: value.mimeType }, size };
}

function transcriptionJob(value: unknown): TranscriptionJob {
  if (!record(value) || !identifier(value.id) || !identifier(value.requestId) || !identifier(value.deviceId)
    || typeof value.status !== 'string' || !['pending', 'completed', 'failed', 'interrupted'].includes(value.status)
    || typeof value.text !== 'string' || value.text.length > 8000
    || (value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 8000))
    || (value.errorCode !== undefined && (typeof value.errorCode !== 'string' || value.errorCode.length > 256))) {
    throw new ApiError('The coordinator returned an invalid transcription job. Refresh before retrying.', 200, 'invalid_response');
  }
  return {
    id: value.id, requestId: value.requestId, deviceId: value.deviceId,
    status: value.status as TranscriptionJob['status'], text: value.text,
    ...(value.error === undefined ? {} : { error: value.error as string }),
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode as string }),
  };
}

const aborted = () => new DOMException('Request cancelled', 'AbortError');

function responseError(status: number): ApiError {
  const message = status === 401 ? 'Your session has expired. Sign in again.'
    : status === 403 ? 'This browser origin is not authorized.'
    : status === 409 ? 'The request conflicts with current state. Refresh before continuing.'
    : status === 428 ? 'Allow OpenAI processing in Account before sending messages or using voice.'
    : status === 429 ? 'Too many attempts. Wait before trying again.'
    : status === 400 ? 'The request was not accepted. Check the supplied information.'
    : status === 404 ? 'This service or item is not available.'
    : 'The coordinator could not complete the request.';
  // Never reflect proxy HTML, backend error strings, tokens or login codes into the UI.
  return new ApiError(message, status, 'http_error');
}

async function request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  if (signal?.aborted) throw aborted();
  try {
    const response = await fetch(path, {
      ...init, signal, cache: 'no-store', credentials: init.credentials ?? 'omit', mode: 'same-origin', redirect: 'error',
      // Preserve the same-origin POST identity in WebKit even when the page uses no-referrer.
      referrerPolicy: 'same-origin',
    });
    if (signal?.aborted) throw aborted();
    if (!response.ok) throw responseError(response.status);
    return response;
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw aborted();
    if (error instanceof ApiError) throw error;
    throw new ApiError('Connection failed. Refresh task state before retrying a submission.', 0, 'connection_error');
  }
}

async function json<T>(response: Response): Promise<T> {
  try { return await response.json() as T; }
  catch { throw new ApiError('The coordinator returned an unreadable response.', response.status, 'invalid_response'); }
}

function list<T>(body: unknown, key: string): T[] {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
  if (!Array.isArray(value) || !value.every(row => row !== null && typeof row === 'object' && !Array.isArray(row)))
    throw new ApiError('The coordinator returned incomplete workspace data.', 200, 'invalid_response');
  return value as T[];
}

/** Same-origin client. Credentials remain in memory; the caller owns any session storage. */
export class ProvidenceApi {
  #token: string;
  #disposed = false;
  #requests = new Set<AbortController>();
  #snapshot?: AbortController;

  constructor(token: string, readonly accountSession = false) { this.#token = token; }

  static async exchange(code: string, signal?: AbortSignal): Promise<{ token: string; expiresAt: string }> {
    const response = await request('/client/exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    }, signal);
    const body = await json<{ token: string; expiresAt: string }>(response);
    if (!body || typeof body.token !== 'string' || !body.token || typeof body.expiresAt !== 'string') {
      throw new ApiError('The coordinator returned an invalid session.', 200, 'invalid_response');
    }
    if (signal?.aborted) throw aborted();
    return body;
  }

  async #run<T>(path: string, method: string, body: unknown, signal: AbortSignal | undefined,
    read: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#disposed || signal?.aborted) throw aborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    this.#requests.add(controller);
    try {
      const response = await request(path, {
        method,
        credentials: this.accountSession ? 'same-origin' : 'omit',
        headers: { ...(this.accountSession ? {} : { Authorization: `Bearer ${this.#token}` }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, controller.signal);
      const result = await read(response, controller.signal);
      if (controller.signal.aborted) throw aborted();
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw aborted();
      if (error instanceof ApiError) throw error;
      throw new ApiError('Connection failed. Refresh task state before retrying a submission.', 0, 'connection_error');
    } finally {
      signal?.removeEventListener('abort', abort);
      this.#requests.delete(controller);
    }
  }

  async snapshot(signal?: AbortSignal): Promise<Snapshot> {
    this.#snapshot?.abort();
    const current = new AbortController();
    this.#snapshot = current;
    const abort = () => current.abort();
    const deadline = AbortSignal.timeout(10_000);
    deadline.addEventListener('abort', abort, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) current.abort();
    try {
      const [devices, chats, tasks, briefing] = await Promise.all([
        this.#run('/v1/devices', 'GET', undefined, current.signal, json),
        this.#run('/v1/chats', 'GET', undefined, current.signal, json),
        this.#run('/v1/tasks', 'GET', undefined, current.signal, json),
        this.#run('/v1/briefing', 'GET', undefined, current.signal, json),
      ]);
      if (current.signal.aborted) throw aborted();
      return { devices: list<Device>(devices, 'devices'), chats: list<Chat>(chats, 'chats'), tasks: list<Task>(tasks, 'tasks'), approvals: list<Approval>(briefing, 'approvals') };
    } catch (error) {
      if (deadline.aborted && !signal?.aborted) throw new ApiError('Connection timed out. Reconnect before sending a request.', 0, 'connection_error');
      throw error;
    } finally {
      deadline.removeEventListener('abort', abort);
      current.abort();
      signal?.removeEventListener('abort', abort);
      if (this.#snapshot === current) this.#snapshot = undefined;
    }
  }

  async send(text: string, chatId = 'master', requestId: string = crypto.randomUUID(), signal?: AbortSignal): Promise<Task> {
    const path = chatId === 'master' ? '/v1/messages' : `/v1/chats/${encodeURIComponent(chatId)}/messages`;
    return this.#run(path, 'POST', { requestId, text }, signal, json<Task>);
  }

  async task(id: string, signal?: AbortSignal): Promise<Task> {
    return this.#run(`/v1/tasks/${encodeURIComponent(id)}`, 'GET', undefined, signal, json<Task>);
  }

  async decide(id: string, body: { decision?: string; answers?: Record<string, { answers: string[] }> }, signal?: AbortSignal): Promise<void> {
    await this.#run(`/v1/approvals/${encodeURIComponent(id)}`, 'POST', body, signal, json);
  }

  async cancel(id: string, signal?: AbortSignal): Promise<void> {
    await this.#run(`/v1/tasks/${encodeURIComponent(id)}/cancel`, 'POST', {}, signal, json);
  }

  async artifact(id: string, signal?: AbortSignal): Promise<{ blob: Blob }> {
    const blob = await this.#run(`/v1/artifacts/${encodeURIComponent(id)}/content`, 'GET', undefined, signal, (response) => response.blob());
    return { blob };
  }

  async transcriptionCapabilities(signal?: AbortSignal): Promise<TranscriptionCapability> {
    return this.#run('/v1/transcriptions', 'GET', undefined, signal, async (response) => transcriptionCapability(await json(response)));
  }

  async voiceConfig(signal?: AbortSignal): Promise<VoiceConfig> {
    return this.#run('/v1/voice', 'GET', undefined, signal, async (response) => {
      const value = await json(response);
      try { return parseVoiceConfig(value); }
      catch { throw new ApiError('Voice configuration is unavailable or unreadable. Use text controls.', response.status, 'invalid_response'); }
    });
  }

  /** The caller owns playback and reuses this identity only for an intentional retry. */
  async speech(text: string, requestId: string, signal?: AbortSignal): Promise<Blob> {
    if (!identifier(requestId) || typeof text !== 'string' || !text.trim() || text.length > 4000) {
      throw new ApiError('Choose a request identity and between 1 and 4000 characters to read aloud.', 400, 'invalid_speech');
    }
    return this.#run('/v1/speech', 'POST', { requestId, text }, signal, async (response, currentSignal) => {
      try { return await readSpeechAudio(response, currentSignal); }
      catch (error) {
        if (currentSignal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw aborted();
        throw new ApiError('The coordinator returned invalid or oversized speech audio.', response.status, 'invalid_response');
      }
    });
  }

  /** Caller supplies the same request on an intentional retry; no POST is retried here. */
  async transcribe(input: TranscriptionRequest, signal?: AbortSignal): Promise<TranscriptionJob> {
    // Snapshot primitive fields before awaiting capabilities so callers cannot change the
    // checked worker, recording or request identity during the capability request.
    const { body, size } = transcriptionRequest(input);
    const capability = await this.transcriptionCapabilities(signal);
    if (!capability.available) throw new ApiError('Transcription is not configured yet. Use text input.', 503, 'transcription_unavailable');
    const device = capability.devices.find((candidate) => candidate.id === body.deviceId);
    if (!device?.online || !device.configured) throw new ApiError('The selected transcription device is unavailable. Choose an online configured device.', 409, 'transcription_device_unavailable');
    if (!capability.mimeTypes.includes(body.mimeType)) throw new ApiError('The transcription service does not support this recording format.', 415, 'unsupported_audio');
    audioSize(size, capability.maxAudioBytes);
    return this.#run('/v1/transcriptions', 'POST', body, signal, async (response) => {
      const job = transcriptionJob(await json(response));
      if (job.requestId !== body.requestId || job.deviceId !== body.deviceId) throw new ApiError('The transcription response does not match this recording request.', 200, 'invalid_response');
      return job;
    });
  }

  async transcriptionJob(id: string, signal?: AbortSignal): Promise<TranscriptionJob> {
    return this.#run(`/v1/transcriptions/${encodeURIComponent(id)}`, 'GET', undefined, signal, async (response) => {
      const job = transcriptionJob(await json(response));
      if (job.id !== id) throw new ApiError('The transcription response does not match this job.', 200, 'invalid_response');
      return job;
    });
  }

  /** Call on sign out to prevent late responses from repopulating the workspace. */
  dispose(): void {
    this.#disposed = true;
    this.#token = '';
    this.#snapshot?.abort();
    for (const controller of this.#requests) controller.abort();
    this.#requests.clear();
  }
}
