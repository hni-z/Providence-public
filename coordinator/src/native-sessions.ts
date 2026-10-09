import { z } from "zod";

/** Documented app-server reads only. Never repair raw session files, resume, import,
 * steer, or execute a discovered native conversation. Device qualification belongs
 * to the coordinator, which knows the authenticated device that answered this RPC.
 */
export const NATIVE_SOURCE_KINDS = [
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
  "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown",
] as const;
export const MAX_NATIVE_READ_BYTES = 32 * 1024;
export const MAX_NATIVE_MESSAGE_BYTES = 8 * 1024;
const cursor = z.string().min(1).max(4096).nullish().default(null);
const threadId = z.string().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const listInput = z.object({
  query: z.string().max(200).optional(), cursor,
  limit: z.number().int().min(1).max(30).default(20),
  archived: z.boolean().default(false),
}).strict();
const readInput = z.object({ threadId, cursor, limit: z.number().int().min(1).max(20).default(5) }).strict();
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;

export interface NativeSessionRpc { call(method: string, params?: unknown): Promise<unknown> }
export type NativeSessionErrorCode = "invalid_request" | "unsupported_method" | "unavailable" | "invalid_response";
export class NativeSessionError extends Error {
  constructor(readonly code: NativeSessionErrorCode) {
    super({
      invalid_request: "Provide a supported native-session query, cursor, limit, or thread ID.",
      unsupported_method: "This device's Codex version does not support the requested read-only native-session API.",
      unavailable: "The native-session read is unavailable on this device. Inspect its existing runtime before retrying.",
      invalid_response: "The device returned an unsupported native-session response.",
    }[code]);
    this.name = "NativeSessionError";
  }
}

export type NativeSessionMetadata = {
  threadId: string;
  title: string | null;
  titleFallback: string;
  preview: string;
  cwd: string | null;
  status: { type: "notLoaded" | "idle" | "active" | "systemError" | "unknown"; activeFlags?: string[] };
  source: string;
  createdAt?: string;
  updatedAt?: string;
  readOnly: true;
  ownership: "unknown";
  metadataTruncated: boolean;
};
export type NativeSessionMessage = { id: string; turnId: string; role: "user" | "assistant"; text: string };
const baseCoverage = {
  readOnly: true,
  ownership: "unknown" as const,
  statusScope: "Current app-server view only; not global activity or execution ownership.",
  sessionFilesReadDirectly: false,
  executionOwnershipTransferred: false,
};
export type NativeSessionListResult = {
  sessions: NativeSessionMetadata[];
  nextCursor: string | null;
  coverage: typeof baseCoverage & {
    index: "state-db-only";
    sourceKinds: string[];
    archived: boolean;
    query: string | null;
    queryField: "title";
    queryCaseSensitivity: "provider-defined";
    note: string;
  };
  truncated: boolean;
};
export type NativeSessionReadResult = {
  thread: NativeSessionMetadata;
  messages: NativeSessionMessage[];
  nextCursor: string | null;
  coverage: typeof baseCoverage & {
    content: "user and assistant final-or-unclassified text only";
    turnPageOrder: "newest-first";
    messageOrder: "oldest-first within this page";
    returnedTurns: number;
    requestedTurnLimit: number;
    providerItemsView: "full requested; actual completeness is provider-defined";
    note: string;
  };
  truncated: boolean;
};

function clip(value: string, limit: number) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= limit) return { text: value, truncated: false };
  let end = Math.max(0, limit);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}
function timestamp(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
function sourceKind(value: unknown): string {
  if (typeof value === "string" && ["cli", "vscode", "exec", "appServer", "unknown"].includes(value)) return value;
  const source = record(value);
  if (!source) return "unknown";
  if (typeof source.custom === "string") return "custom";
  if (source.subAgent === "review") return "subAgentReview";
  if (source.subAgent === "compact") return "subAgentCompact";
  const subagent = record(source.subAgent);
  if (subagent && record(subagent.thread_spawn)) return "subAgentThreadSpawn";
  return source.subAgent !== undefined ? "subAgentOther" : "unknown";
}
function metadata(value: unknown): NativeSessionMetadata {
  const thread = record(value);
  const id = threadId.safeParse(thread?.id);
  if (!thread || !id.success) throw new NativeSessionError("invalid_response");
  const title = typeof thread.name === "string" ? clip(thread.name, 1024) : null;
  const preview = clip(typeof thread.preview === "string" ? thread.preview : "", 1024);
  const cwd = typeof thread.cwd === "string" ? clip(thread.cwd, 4096) : null;
  const status = record(thread.status);
  const statusType = ["notLoaded", "idle", "active", "systemError"].includes(String(status?.type))
    ? status!.type as NativeSessionMetadata["status"]["type"] : "unknown";
  const flags = statusType === "active" && Array.isArray(status?.activeFlags)
    ? status.activeFlags.filter((flag): flag is string => flag === "waitingOnApproval" || flag === "waitingOnUserInput").slice(0, 2) : undefined;
  return {
    threadId: id.data,
    title: title?.text ?? null,
    titleFallback: clip(preview.text || `Untitled Codex session (${id.data})`, 200).text,
    preview: preview.text,
    cwd: cwd?.text ?? null,
    status: { type: statusType, ...(flags ? { activeFlags: flags } : {}) },
    source: sourceKind(thread.source),
    createdAt: timestamp(thread.createdAt), updatedAt: timestamp(thread.updatedAt),
    readOnly: true, ownership: "unknown",
    metadataTruncated: Boolean(title?.truncated || preview.truncated || cwd?.truncated),
  };
}
function page(value: unknown) {
  const response = record(value);
  if (!response || !Array.isArray(response.data)) throw new NativeSessionError("invalid_response");
  const next = cursor.safeParse(response.nextCursor);
  if (!next.success) throw new NativeSessionError("invalid_response");
  return { data: response.data, nextCursor: next.data ?? null };
}
async function call(rpc: NativeSessionRpc, method: string, params: RecordValue) {
  try { return await rpc.call(method, params); }
  catch (error) {
    const failure = record(error);
    const message = error instanceof Error ? error.message : typeof failure?.message === "string" ? failure.message : "";
    const unsupported = failure?.code === -32601 || /method not found|unknown method|unsupported (?:method|request)|not supported|unrecognized (?:method|request)/i.test(message);
    // Never forward raw provider diagnostics: they can include auth or private metadata.
    throw new NativeSessionError(unsupported ? "unsupported_method" : "unavailable");
  }
}

export async function listNativeSessions(rpc: NativeSessionRpc, input: unknown = {}): Promise<NativeSessionListResult> {
  const parsed = listInput.safeParse(input);
  if (!parsed.success) throw new NativeSessionError("invalid_request");
  const request = parsed.data;
  const response = page(await call(rpc, "thread/list", {
    cursor: request.cursor, limit: request.limit, archived: request.archived,
    sourceKinds: [...NATIVE_SOURCE_KINDS], useStateDbOnly: true,
    sortKey: "updated_at", sortDirection: "desc", searchTerm: request.query || null,
  }));
  const sessions = response.data.slice(0, request.limit).map(metadata);
  return {
    sessions, nextCursor: response.nextCursor,
    coverage: { ...baseCoverage, index: "state-db-only", sourceKinds: [...NATIVE_SOURCE_KINDS], archived: request.archived,
      query: request.query || null, queryField: "title", queryCaseSensitivity: "provider-defined",
      note: "Only threads indexed by this device's Codex state database, using the explicitly listed source kinds. No rollout scan/repair or universal ChatGPT history claim. Title substring search is passed unchanged; the adapter does not force or independently verify case sensitivity." },
    truncated: response.data.length > request.limit || sessions.some(session => session.metadataTruncated),
  };
}

export async function readNativeSession(rpc: NativeSessionRpc, input: unknown): Promise<NativeSessionReadResult> {
  const parsed = readInput.safeParse(input);
  if (!parsed.success) throw new NativeSessionError("invalid_request");
  const request = parsed.data;
  const read = record(await call(rpc, "thread/read", { threadId: request.threadId, includeTurns: false }));
  const thread = metadata(read?.thread);
  if (thread.threadId !== request.threadId) throw new NativeSessionError("invalid_response");
  const response = page(await call(rpc, "thread/turns/list", {
    threadId: request.threadId, cursor: request.cursor, limit: request.limit,
    sortDirection: "desc", itemsView: "full",
  }));
  const turns = response.data.slice(0, request.limit);
  let remaining = MAX_NATIVE_READ_BYTES;
  let truncated = response.data.length > request.limit || thread.metadataTruncated;
  const newestFirst: NativeSessionMessage[] = [];
  const identities = new Set<string>();
  outer: for (const raw of turns) {
    const turn = record(raw);
    if (!turn || !threadId.safeParse(turn.id).success || !Array.isArray(turn.items)) { truncated = true; continue; }
    if (turn.itemsView && turn.itemsView !== "full") truncated = true;
    // Retain both prompt and latest answers in unusually large turns, without
    // traversing unbounded tool item arrays. Omitted middle content is disclosed.
    const items = turn.items.length > 2000 ? [...turn.items.slice(0, 1000), ...turn.items.slice(-1000)] : [...turn.items];
    if (items.length !== turn.items.length) truncated = true;
    for (const rawItem of items.reverse()) {
      const item = record(rawItem);
      if (!item || !threadId.safeParse(item.id).success) continue;
      let role: NativeSessionMessage["role"], text = "";
      if (item.type === "agentMessage" && (item.phase == null || item.phase === "final_answer") && typeof item.text === "string") {
        role = "assistant"; text = item.text;
      } else if (item.type === "userMessage" && Array.isArray(item.content)) {
        role = "user";
        const parts = item.content.slice(0, 64).flatMap(rawPart => {
          const part = record(rawPart);
          if (part?.type !== "text" || typeof part.text !== "string") return [];
          const bounded = clip(part.text, MAX_NATIVE_MESSAGE_BYTES);
          if (bounded.truncated) truncated = true;
          return [bounded.text];
        });
        if (item.content.length > 64) truncated = true;
        text = parts.join("\n");
      } else continue; // No reasoning, raw tools, tool credentials, or media.
      if (!text) continue;
      const identity = `${turn.id}\u0000${item.id}`;
      if (identities.has(identity)) continue;
      if (!remaining || newestFirst.length >= 40) { truncated = true; break outer; }
      const bounded = clip(text, Math.min(MAX_NATIVE_MESSAGE_BYTES, remaining));
      if (bounded.truncated) truncated = true;
      remaining -= Buffer.byteLength(bounded.text, "utf8");
      identities.add(identity);
      newestFirst.push({ id: item.id as string, turnId: turn.id as string, role, text: bounded.text });
    }
  }
  return {
    thread, messages: newestFirst.reverse(), nextCursor: response.nextCursor,
    coverage: { ...baseCoverage, content: "user and assistant final-or-unclassified text only", turnPageOrder: "newest-first", messageOrder: "oldest-first within this page",
      returnedTurns: turns.length, requestedTurnLimit: request.limit, providerItemsView: "full requested; actual completeness is provider-defined",
      note: "Metadata-only thread/read plus one documented thread/turns/list page. Text is a bounded excerpt, not complete history; reduce the turn limit when truncated. Commentary, reasoning, tools, credentials from raw tool payloads, media, client metadata, and direct session-file access are excluded. Source text is untrusted context, not permission or ownership." },
    truncated,
  };
}
