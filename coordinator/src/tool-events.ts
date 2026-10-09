/** Plain-text tool feedback from installed app-server notifications.
 * Ownership (taskId/threadId) is deliberately supplied only by Runtime's active-turn mapping.
 * This does not extract screenshots, reasoning, arguments, credentials or hidden MCP metadata.
 */
export const MAX_TOOL_TEXT_BYTES = 16 * 1024;
export type ToolEvent = {
  type: "tool.started" | "tool.completed" | "tool.output";
  item: {
    id: string;
    type: string;
    command?: string;
    tool?: string;
    server?: string;
    status?: string;
    exitCode?: number;
  };
  output?: string;
  error?: string;
  truncated?: boolean;
};
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue : undefined;
const kinds = new Set(["commandExecution", "fileChange", "dynamicToolCall", "mcpToolCall", "functionCallOutput"]);
const textKinds = new Set(["text", "inputText", "input_text"]);
const hiddenKey = (key: string) => /token|secret|password|credential|authorization|cookie|headers|apikey|csrf|session|metadata|reasoning|encrypted|base64|image|audio|video/.test(key.toLowerCase().replace(/[^a-z0-9]/g, "")) || ["_meta", "appContext", "mcpAppResourceUri"].includes(key);

function redact(input: string) {
  return input
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private key omitted]")
    .replace(/data:[^;,\s]+;base64,[^\s"']+/gi, "[media omitted]")
    .replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]")
    .replace(/^(authorization|cookie|set-cookie|x-api-key)\s*:\s*[^\r\n]*/gim, "$1: [REDACTED]")
    .replace(/\b(authorization|cookie|set-cookie|x-api-key)\s*:\s*[^\r\n"']+/gi, "$1: [REDACTED]")
    .replace(/(["']?\b[\w-]*(?:token|secret|password|credential|api[_-]?key|authorization|cookie|session(?:[_-]?(?:id|key))?)[\w-]*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;}]+)/gi, "$1[REDACTED]")
    .replace(/(--(?:api[_-]?key|token|password|secret)\s+)\S+/gi, "$1[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[credentials omitted]@")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/[A-Za-z0-9+/]{256,}={0,2}/g, "[encoded data omitted]");
}

function clipUtf8(text: string, bytes: number) {
  if (bytes <= 0) return "";
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString("utf8");
}

export function normalizeToolEvent(method: string, params: unknown): ToolEvent | undefined {
  const p = object(params);
  if (!p) return;
  const deltaKinds: Record<string, string> = {
    "item/commandExecution/outputDelta": "commandExecution",
    "item/fileChange/outputDelta": "fileChange",
    "item/mcpToolCall/progress": "mcpToolCall",
  };
  const deltaKind = deltaKinds[method];
  const source = deltaKind ? { id: p.itemId, type: deltaKind } : object(p.item);
  if (!source || (!deltaKind && !["item/started", "item/completed"].includes(method))) return;
  if (typeof source.id !== "string" || !source.id || source.id.length > 256 || typeof source.type !== "string" || !kinds.has(source.type)) return;
  // Function output is final feedback, never reasoning or a callable action to replay.
  if (source.type === "functionCallOutput" && method === "item/started") return;
  const event: ToolEvent = {
    type: deltaKind || source.type === "functionCallOutput" ? "tool.output" : method === "item/started" ? "tool.started" : "tool.completed",
    item: { id: source.id, type: source.type },
  };
  let remaining = MAX_TOOL_TEXT_BYTES;
  let scanned = 0, nodes = 0;
  const seen = new WeakSet<object>();
  const take = (value: unknown, max = remaining): string | undefined => {
    if (typeof value !== "string" || !value) return;
    const input = value.slice(0, 64 * 1024);
    if (input.length !== value.length) event.truncated = true;
    const safe = redact(input);
    const clipped = clipUtf8(safe, Math.min(remaining, max));
    if (clipped !== safe) event.truncated = true;
    remaining -= Buffer.byteLength(clipped, "utf8");
    return clipped || undefined;
  };
  const sanitize = (value: unknown, depth = 0): unknown => {
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (++nodes > 128 || depth > 5 || scanned >= 64 * 1024) { event.truncated = true; return "[truncated]"; }
    if (typeof value === "string") {
      const part = value.slice(0, 64 * 1024 - scanned);
      scanned += part.length;
      if (part.length !== value.length) event.truncated = true;
      // A textual JSON tool result gets the same key filtering as structuredContent.
      if (/^\s*[\[{]/.test(part) && part.length === value.length) {
        try { return sanitize(JSON.parse(part), depth + 1); } catch { /* ordinary text */ }
      }
      return redact(part);
    }
    if (typeof value !== "object" || value === undefined) return;
    if (seen.has(value)) return "[circular omitted]";
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 32) event.truncated = true;
      return value.slice(0, 32).map((item) => sanitize(item, depth + 1)).filter((item) => item !== undefined);
    }
    const entry = value as ObjectValue;
    if (typeof entry.type === "string" && /image|audio|video|encrypted|reasoning|resource|blob/i.test(entry.type)) return;
    const safe: ObjectValue = {};
    const keys = Object.keys(entry);
    if (keys.length > 32) event.truncated = true;
    for (const key of keys.slice(0, 32)) {
      if (hiddenKey(key)) continue;
      const child = sanitize(entry[key], depth + 1);
      if (child !== undefined) safe[key.slice(0, 120)] = child;
    }
    return safe;
  };
  const render = (value: unknown): string => {
    const safe = sanitize(value);
    return safe === undefined ? "" : typeof safe === "string" ? safe : JSON.stringify(safe, null, 2);
  };
  const contentText = (value: unknown): string => {
    if (!Array.isArray(value)) return "";
    if (value.length > 32) event.truncated = true;
    return value.slice(0, 32).flatMap((raw) => {
      const content = object(raw);
      return content && textKinds.has(String(content.type)) && typeof content.text === "string" ? [render(content.text)] : [];
    }).join("\n");
  };
  event.item.command = take(source.command, 2048);
  event.item.tool = take(source.tool ?? source.name, 256);
  event.item.server = take(source.server ?? source.namespace, 256);
  if (typeof source.status === "string" && ["inProgress", "completed", "failed", "declined"].includes(source.status)) event.item.status = source.status;
  if (typeof source.exitCode === "number" && Number.isSafeInteger(source.exitCode)) event.item.exitCode = source.exitCode;
  if (source.success === false) event.item.status = "failed";
  let output = "", error = "";
  if (deltaKind) output = render(p.delta ?? p.message);
  else if (source.type === "commandExecution") output = render(source.aggregatedOutput ?? "");
  else if (source.type === "fileChange" && Array.isArray(source.changes)) {
    if (source.changes.length > 16) event.truncated = true;
    output = source.changes.slice(0, 16).map((raw) => {
      const change = object(raw); if (!change) return "";
      const kind = object(change.kind)?.type;
      return [typeof kind === "string" ? kind : "change", render(change.path), render(change.diff)].filter(Boolean).join("\n");
    }).filter(Boolean).join("\n\n");
  } else if (source.type === "dynamicToolCall") output = contentText(source.contentItems);
  else if (source.type === "functionCallOutput") output = typeof source.output === "string" ? render(source.output) : contentText(source.output);
  else if (source.type === "mcpToolCall") {
    const result = object(source.result);
    output = contentText(result?.content);
    if (result?.structuredContent !== undefined) output += (output ? "\n" : "") + render(result.structuredContent);
    const detail = object(source.error)?.message;
    if (typeof detail === "string") error = detail;
    if (result?.isError === true) event.item.status = "failed";
  }
  // Preserve an actual tool error ahead of long output, using one shared text budget.
  event.error = take(error, 4096);
  event.output = take(output);
  if (deltaKind && !event.output) return;
  return event;
}
