import { z } from "zod";

export type ProviderRequestId = string | number;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const json: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string().max(16000),
  z.array(json).max(100), z.record(json),
]));
const boundedJson = json.refine(value => JSON.stringify(value).length <= 64000, "Structured response is too large");
const persistenceMode = z.enum(["session", "always"]);
export type ApprovalPersistenceMode = z.infer<typeof persistenceMode>;
const persistenceMetadata = z.object({ persist: persistenceMode }).strict();
const pathText = z.string().min(1).max(4096);
const specialPath = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root") }).strict(), z.object({ kind: z.literal("minimal") }).strict(),
  z.object({ kind: z.literal("tmpdir") }).strict(), z.object({ kind: z.literal("slash_tmp") }).strict(),
  z.object({ kind: z.literal("project_roots"), subpath: pathText.nullish().transform(value => value ?? null) }).strict(),
  z.object({ kind: z.literal("unknown"), path: pathText, subpath: pathText.nullish().transform(value => value ?? null) }).strict(),
]);
const filesystemPath = z.discriminatedUnion("type", [
  z.object({ type: z.literal("path"), path: pathText }).strict(),
  z.object({ type: z.literal("glob_pattern"), pattern: pathText }).strict(),
  z.object({ type: z.literal("special"), value: specialPath }).strict(),
]);
const entry = z.object({ path: filesystemPath, access: z.enum(["read", "write", "deny"]) }).strict();
const filesystem = z.object({
  read: z.array(pathText).max(100).nullish().default(null), write: z.array(pathText).max(100).nullish().default(null),
  entries: z.array(entry).max(100).nullish().transform(value => value ?? undefined),
  globScanMaxDepth: z.number().int().positive().max(1000).nullish().transform(value => value ?? undefined),
}).strict();
const network = z.object({ enabled: z.boolean().nullish().default(null) }).strict();
const grants = z.object({ network: network.optional(), fileSystem: filesystem.optional() }).strict();
// Installed app-server schemas differ in whether optional no-grant fields are emitted.
// Normalize omission/null conservatively, never to an enabled capability.
const requestedPermissions = z.object({ network: network.nullish().default(null), fileSystem: filesystem.nullish().default(null) }).strict();
export const approvalResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("elicitation"), action: z.enum(["accept", "decline", "cancel"]), content: boundedJson.optional(), _meta: persistenceMetadata.nullable().optional() }).strict(),
  z.object({ kind: z.literal("permissions"), permissions: grants, scope: z.enum(["turn", "session"]) }).strict(),
]);
export type ApprovalResponse = z.infer<typeof approvalResponseSchema>;

const label = { title: z.string().max(1000).optional(), description: z.string().max(8000).optional() };
const option = z.object({ const: z.string().max(8000), title: z.string().max(1000) }).strict();
const field = z.discriminatedUnion("type", [
  z.object({ type: z.literal("string"), ...label, minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional(), format: z.enum(["email", "uri", "date", "date-time"]).optional(), default: z.string().optional(), enum: z.array(z.string()).max(100).optional(), enumNames: z.array(z.string()).max(100).optional(), oneOf: z.array(option).max(100).optional() }).strict(),
  z.object({ type: z.literal("number"), ...label, minimum: z.number().finite().optional(), maximum: z.number().finite().optional(), default: z.number().finite().optional() }).strict(),
  z.object({ type: z.literal("integer"), ...label, minimum: z.number().finite().optional(), maximum: z.number().finite().optional(), default: z.number().int().optional() }).strict(),
  z.object({ type: z.literal("boolean"), ...label, default: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("array"), ...label, minItems: z.number().int().nonnegative().optional(), maxItems: z.number().int().nonnegative().optional(), default: z.array(z.string()).optional(), items: z.union([
    z.object({ type: z.literal("string"), enum: z.array(z.string()).max(100) }).strict(),
    z.object({ anyOf: z.array(option).max(100) }).strict(),
  ]) }).strict(),
]);
export const elicitationFormSchema = z.object({
  $schema: z.string().optional(), type: z.literal("object"), properties: z.record(field), required: z.array(z.string()).max(50).optional(),
}).strict().refine(schema => Object.keys(schema.properties).length <= 50 &&
  !Object.keys(schema.properties).some(key => ["__proto__", "prototype", "constructor"].includes(key)) &&
  (schema.required ?? []).every(key => Object.hasOwn(schema.properties, key)), "Unsupported form properties");

export class ProviderRequestError extends Error {
  constructor(readonly code: "unsupported_request" | "inactive_task" | "invalid_request" | "request_cleared") {
    super({ unsupported_request: "The provider requested an unsupported client operation.", inactive_task: "The provider request does not match an active task.", invalid_request: "The provider request does not match the supported approval contract.", request_cleared: "The provider has already cleared this request." }[code]);
    this.name = "ProviderRequestError";
  }
}
export function safeRequestMethod(method: unknown): string {
  return typeof method === "string" && /^[A-Za-z][A-Za-z0-9/_-]{0,119}$/.test(method) ? method : "unrecognized";
}

/** Mirrors OpenAI's approval_supports_persist_mode advertisement contract.
 * https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/tui/src/bottom_pane/mcp_server_elicitation.rs#L413
 * Keep only supported modes, never arbitrary provider metadata or a default selection.
 */
function advertisedPersistenceModes(meta: unknown): ApprovalPersistenceMode[] {
  if (!meta || typeof meta !== "object" || Array.isArray(meta) || !Object.hasOwn(meta, "persist")) return [];
  const advertised = (meta as { persist: unknown }).persist;
  return (["session", "always"] as const).filter(mode =>
    typeof advertised === "string" ? advertised === mode : Array.isArray(advertised) && advertised.includes(mode));
}

/** Preserve only known request fields, never infer approval from provider text or metadata. */
export function approvalDetails(method: string, params: any, providerRequestId: ProviderRequestId): any {
  const common = { threadId: params.threadId, turnId: params.turnId ?? null, providerRequestId };
  if (method === "item/permissions/requestApproval") {
    const permissions = requestedPermissions.safeParse(params.permissions);
    if (!permissions.success || typeof params.cwd !== "string" || typeof params.itemId !== "string") throw new ProviderRequestError("invalid_request");
    return { ...common, kind: "permissions", itemId: params.itemId, environmentId: params.environmentId ?? null,
      startedAtMs: params.startedAtMs, cwd: params.cwd, reason: typeof params.reason === "string" ? params.reason : null, permissions: permissions.data };
  }
  if (method === "mcpServer/elicitation/request") {
    if (typeof params.serverName !== "string" || typeof params.mode !== "string") throw new ProviderRequestError("invalid_request");
    const details: any = { ...common, kind: "elicitation", serverName: params.serverName, mode: params.mode,
      message: typeof params.message === "string" ? params.message : typeof params.description === "string" ? params.description : "The provider requested a decision." };
    if (params.mode === "form") {
      const schema = elicitationFormSchema.safeParse(params.requestedSchema);
      if (schema.success) {
        details.requestedSchema = schema.data;
        // Upstream exposes these choices for message-only approval forms.
        const modes = Object.keys(schema.data.properties).length === 0 ? advertisedPersistenceModes(params._meta) : [];
        if (modes.length) details.persistenceModes = modes;
      }
      else details.unsupportedReason = "This form uses a schema Providence cannot validate. Decline/cancel or use the provider's supported interface.";
    } else if (params.mode === "url") {
      try {
        const url = new URL(params.url);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || typeof params.elicitationId !== "string") throw new Error();
        details.url = params.url; details.elicitationId = params.elicitationId;
      } catch { details.unsupportedReason = "This URL flow does not have a supported HTTP(S) destination."; }
    } else details.unsupportedReason = "This extended form or verification flow requires the provider's supported interface. Providence has not enabled extended-form capability.";
    return details;
  }
  return { ...params, providerRequestId };
}

function validateForm(schemaInput: unknown, content: unknown) {
  const schema = elicitationFormSchema.parse(schemaInput);
  if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error("Accepted form requires an object of field values");
  const values = content as Record<string, unknown>;
  if (Object.keys(values).some(key => !Object.hasOwn(schema.properties, key))) throw new Error("Form contains an unrequested field");
  for (const key of schema.required ?? []) if (!Object.hasOwn(values, key)) throw new Error("A required form field is missing");
  for (const [key, value] of Object.entries(values)) {
    const specification = schema.properties[key];
    if (specification.type === "string") {
      if (typeof value !== "string" || value.length < (specification.minLength ?? 0) || value.length > (specification.maxLength ?? 16000)) throw new Error("A form string is outside its requested bounds");
      if (specification.enum && !specification.enum.includes(value)) throw new Error("Choose a requested form option");
      if (specification.oneOf && !specification.oneOf.some(option => option.const === value)) throw new Error("Choose a requested form option");
      if (specification.format === "email" && !z.string().email().safeParse(value).success) throw new Error("Provide a valid email address");
      if (specification.format === "uri") { try { new URL(value); } catch { throw new Error("Provide a valid absolute URI"); } }
      if (specification.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value)) throw new Error("Provide a valid date");
      if (specification.format === "date-time" && !z.string().datetime({ offset: true }).safeParse(value).success) throw new Error("Provide a valid date and time with timezone");
    } else if (specification.type === "number" || specification.type === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value) || (specification.type === "integer" && !Number.isInteger(value)) || value < (specification.minimum ?? -Infinity) || value > (specification.maximum ?? Infinity)) throw new Error("A form number is outside its requested bounds");
    } else if (specification.type === "boolean") {
      if (typeof value !== "boolean") throw new Error("A form field requires a boolean choice");
    } else {
      const choices = "enum" in specification.items ? specification.items.enum : specification.items.anyOf.map(option => option.const);
      if (!Array.isArray(value) || value.length < (specification.minItems ?? 0) || value.length > (specification.maxItems ?? 100) || new Set(value).size !== value.length || value.some(item => typeof item !== "string" || !choices.includes(item))) throw new Error("Choose the requested number of valid form options");
    }
  }
}

export function structuredApprovalResult(method: string, details: any, input: ApprovalResponse): unknown {
  const response = approvalResponseSchema.parse(input);
  if (method === "mcpServer/elicitation/request" && response.kind === "elicitation") {
    if (response._meta) {
      if (response.action !== "accept") throw new Error("Persistence can only be selected for an accepted request");
      if (details.mode !== "form" || details.unsupportedReason || !details.requestedSchema?.properties ||
          Object.keys(details.requestedSchema.properties).length !== 0 || !Array.isArray(details.persistenceModes) ||
          !details.persistenceModes.includes(response._meta.persist))
        throw new Error("The provider did not offer this persistence mode for this request");
    }
    if (response.action === "accept") {
      if (details.unsupportedReason) throw new Error("This provider flow cannot be accepted by Providence");
      if (details.mode === "form") {
        // Upstream message-only persistence choices return no form content.
        // A caller may send {} as our existing empty-form UI does, or null.
        if (!response._meta || response.content != null) validateForm(details.requestedSchema, response.content);
      }
      else if (details.mode !== "url" || (response.content !== undefined && response.content !== null)) throw new Error("URL confirmation must not supply form content");
    } else if (response.content !== undefined && response.content !== null) throw new Error("Declined or cancelled forms must not contain field values");
    return { action: response.action, content: response.action === "accept" && !response._meta ? response.content ?? null : null, _meta: response._meta ?? null };
  }
  if (method === "item/permissions/requestApproval" && response.kind === "permissions") {
    const requested = requestedPermissions.parse(details.permissions);
    const granted = response.permissions;
    if (granted.network?.enabled === true && requested.network?.enabled !== true) throw new Error("Network access was not requested");
    if (granted.fileSystem) {
      const want = requested.fileSystem, give = granted.fileSystem;
      if (!want) throw new Error("Filesystem access was not requested");
      for (const access of ["read", "write"] as const)
        if ((give[access] ?? []).some(path => !(want[access] ?? []).includes(path))) throw new Error("Filesystem grant adds an unrequested path or access level");
      for (const candidate of give.entries ?? [])
        if (!(want.entries ?? []).some(entry => JSON.stringify(entry) === JSON.stringify(candidate))) throw new Error("Filesystem grant adds an unrequested entry or access level");
      const grantsAccess = Boolean(give.read?.length || give.write?.length || give.entries?.some(entry => entry.access !== "deny"));
      if (grantsAccess && (want.entries ?? []).filter(entry => entry.access === "deny").some(entry => !(give.entries ?? []).some(candidate => JSON.stringify(candidate) === JSON.stringify(entry)))) throw new Error("Filesystem grant must preserve the requested exclusions");
      if (give.globScanMaxDepth !== undefined && (want.globScanMaxDepth === undefined || give.globScanMaxDepth > want.globScanMaxDepth)) throw new Error("Filesystem grant increases the requested scan depth");
      if (want.globScanMaxDepth !== undefined && give.globScanMaxDepth === undefined) give.globScanMaxDepth = want.globScanMaxDepth;
    }
    return { permissions: granted, scope: response.scope };
  }
  throw new Error("Response kind does not match this pending approval");
}

/** Validate before delivery as well as at the worker. A transport timeout is not a validation failure. */
export function approvalResult(method: string, details: any, decision?: string,
  answers?: Record<string, { answers: string[] }>, response?: ApprovalResponse): unknown {
  if ([decision, answers, response].filter(value => value !== undefined).length !== 1)
    throw new Error("Provide one response representation for this approval");
  if (response !== undefined) return structuredApprovalResult(method, details, response);
  if (["mcpServer/elicitation/request", "item/permissions/requestApproval"].includes(method))
    throw new Error("This approval requires its specific structured response");
  if (method === "item/tool/requestUserInput") {
    if (!answers) throw new Error("This request requires answers keyed by question ID");
    for (const q of details.questions ?? [])
      if (!answers[q.id]?.answers?.length) throw new Error(`Missing answer: ${q.id}`);
    return { answers };
  }
  if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method))
    throw new Error("Unsupported approval method");
  if (!["accept", "decline", "cancel"].includes(decision ?? ""))
    throw new Error("Choose accept, decline or cancel");
  if (method === "item/commandExecution/requestApproval" && details.availableDecisions != null &&
      (!Array.isArray(details.availableDecisions) || !details.availableDecisions.includes(decision)))
    throw new Error("This decision was not offered for this specific command approval");
  return { decision };
}
