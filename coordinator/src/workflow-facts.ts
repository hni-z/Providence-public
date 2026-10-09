import { z } from "zod";

/**
 * A deliberately small, transport-safe fact bundle for a multi-device workflow.
 * This module validates provenance-shaped data only. It neither fetches sources
 * nor establishes that a fact, artifact, or publication is true.
 */
export const WORKFLOW_FACT_BUNDLE_VERSION = 1;
export const MAX_WORKFLOW_FACT_SOURCES = 2;
export const MAX_WORKFLOW_FACTS = 6;
export const MAX_WORKFLOW_FACT_BUNDLE_BYTES = 2048;

const boundedString = (name: string, maximum: number) => z.string()
  .min(1, `${name} is required`)
  .max(maximum, `${name} must be at most ${maximum} characters`)
  .refine(value => value.trim().length > 0, `${name} must contain a non-whitespace character`)
  .refine(value => Buffer.byteLength(value, "utf8") <= maximum, `${name} must be at most ${maximum} UTF-8 bytes`);
const identifier = (name: string, maximum = 120) => boundedString(name, maximum);
const isoTimestamp = (name: string) => z.string().datetime({ offset: true, message: `${name} must be an ISO 8601 timestamp with an offset` });
const sourceUrl = z.string()
  .min(1, "source URL is required")
  .max(600, "source URL must be at most 600 characters")
  .refine(value => !/[\s\u0000-\u001F\u007F-\u009F]/u.test(value), "source URL must not contain whitespace or control characters")
  .refine(value => Buffer.byteLength(value, "utf8") <= 600, "source URL must be at most 600 UTF-8 bytes")
  .refine(value => {
    try {
      const parsed = new URL(value);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
    } catch { return false; }
  }, "source URL must be HTTP(S) and must not contain embedded credentials");
const relativeArtifactPath = boundedString("artifact path", 512)
  .refine(value => !/[\u0000-\u001F\u007F-\u009F]/u.test(value), "artifact path must not contain control characters")
  .refine(value => !/^(?:[/\\]|[A-Za-z]:)/.test(value), "artifact path must be relative")
  .refine(value => !/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(value), "artifact path must not contain traversal segments");

const sourceSchema = z.object({
  id: identifier("source id"),
  url: sourceUrl,
  title: boundedString("source title", 240),
  retrievedAt: isoTimestamp("source retrievedAt"),
}).strict();
const factSchema = z.object({
  id: identifier("fact id"),
  text: boundedString("fact text", 640),
  sourceIds: z.array(identifier("fact source id")).min(1, "each fact must cite at least one source").max(MAX_WORKFLOW_FACT_SOURCES),
}).strict();
const artifactSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("published"), id: identifier("artifact id", 200), sha256: z.string().regex(/^[a-fA-F0-9]{64}$/, "artifact sha256 must be a 64-character hexadecimal digest") }).strict(),
  // Local path/hash verification or a publication attempt; never a server-published or GUI-proof claim.
  z.object({ status: z.literal("publication_unconfirmed"), sha256: z.string().regex(/^[a-fA-F0-9]{64}$/, "artifact sha256 must be a 64-character hexadecimal digest"), size: z.number().int("artifact size must be an integer").positive("artifact size must be positive").max(524288, "artifact size must be at most 524288 bytes"), path: relativeArtifactPath }).strict(),
  z.object({ status: z.literal("not_published") }).strict(),
]);
const originSchema = z.object({
  taskId: identifier("origin taskId", 200),
  chatId: identifier("origin chatId", 200),
  deviceId: identifier("origin deviceId", 200),
  artifact: artifactSchema,
}).strict();

const bundleSchema = z.object({
  version: z.literal(WORKFLOW_FACT_BUNDLE_VERSION),
  topic: boundedString("topic", 240),
  criteria: boundedString("criteria", 480),
  generatedAt: isoTimestamp("generatedAt"),
  origin: originSchema,
  sources: z.array(sourceSchema).min(1, "at least one source is required").max(MAX_WORKFLOW_FACT_SOURCES),
  facts: z.array(factSchema).min(1, "at least one fact is required").max(MAX_WORKFLOW_FACTS),
}).strict().superRefine((bundle, context) => {
  const sourceIds = new Set<string>();
  bundle.sources.forEach((source, index) => {
    if (sourceIds.has(source.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sources", index, "id"], message: "source ids must be unique" });
    sourceIds.add(source.id);
  });
  const factIds = new Set<string>();
  bundle.facts.forEach((fact, index) => {
    if (factIds.has(fact.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["facts", index, "id"], message: "fact ids must be unique" });
    factIds.add(fact.id);
    const citedSourceIds = new Set<string>();
    fact.sourceIds.forEach((sourceId, sourceIndex) => {
      if (citedSourceIds.has(sourceId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["facts", index, "sourceIds", sourceIndex], message: "fact source ids must be unique" });
      citedSourceIds.add(sourceId);
      if (!sourceIds.has(sourceId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["facts", index, "sourceIds", sourceIndex], message: `fact source id ${sourceId} does not exist` });
    });
  });
});

export type WorkflowFactBundle = z.infer<typeof bundleSchema>;
export type WorkflowFactOrigin = WorkflowFactBundle["origin"];
export type WorkflowFactExpectedOrigin = Pick<WorkflowFactOrigin, "taskId" | "chatId" | "deviceId">;

function formatIssues(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join(".") || "bundle"}: ${issue.message}`).join("; ");
}

function byteChecked(bundle: WorkflowFactBundle): WorkflowFactBundle {
  const bytes = Buffer.byteLength(JSON.stringify(bundle), "utf8");
  if (bytes > MAX_WORKFLOW_FACT_BUNDLE_BYTES) {
    throw new Error(`Invalid workflow fact bundle: serialized bundle is ${bytes} UTF-8 bytes; maximum is ${MAX_WORKFLOW_FACT_BUNDLE_BYTES}`);
  }
  return bundle;
}

/** Parses JSON or an object without trimming, normalizing, fetching, or executing its contents. */
export function parseWorkflowFactBundle(input: unknown, expectedOrigin?: WorkflowFactExpectedOrigin): WorkflowFactBundle {
  let value = input;
  if (typeof input === "string") {
    try { value = JSON.parse(input); }
    catch { throw new Error("Invalid workflow fact bundle: serialized input is not valid JSON"); }
  }
  const parsed = bundleSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid workflow fact bundle: ${formatIssues(parsed.error)}`);
  const bundle = byteChecked(parsed.data);
  if (expectedOrigin && (bundle.origin.taskId !== expectedOrigin.taskId || bundle.origin.chatId !== expectedOrigin.chatId || bundle.origin.deviceId !== expectedOrigin.deviceId)) {
    throw new Error("Invalid workflow fact bundle: origin does not match the expected task, chat, and device");
  }
  return bundle;
}

/** Serializes a fully validated bundle. Validation never makes factual or publication claims. */
export function serializeWorkflowFactBundle(value: WorkflowFactBundle): string {
  return JSON.stringify(parseWorkflowFactBundle(value));
}
