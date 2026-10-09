import { z } from "zod";

export const workerModelSettings = {
  localWorkerModel: z.string().trim().min(1).max(200).optional(),
  localWorkerReasoningEffort: z.string().trim().min(1).max(80).optional(),
};

export type WorkerModelSettings = z.infer<z.ZodObject<typeof workerModelSettings>>;
export type WorkerModelRpc = { call(method: string, params?: unknown): Promise<unknown> };
export type VerifiedWorkerModel = Readonly<{ model: string; effort?: string }>;

type ListedModel = { id: string; model: string; supportedReasoningEfforts: readonly string[] };
type ModelPage = { models: ListedModel[]; nextCursor?: string };
const MAX_MODEL_LIST_PAGES = 20;

function parsePage(value: unknown): ModelPage {
  if (!value || typeof value !== "object") throw new Error("Model listing returned an invalid response.");
  const record = value as Record<string, unknown>;
  const rows = Array.isArray(record.data) ? record.data : undefined;
  if (!rows) throw new Error("Model listing returned no models.");
  const models: ListedModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const efforts = Array.isArray(item.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts.map(option => option && typeof option === "object" ? (option as Record<string, unknown>).reasoningEffort : undefined)
      : undefined;
    if (typeof item.id !== "string" || item.id.length === 0 || typeof item.model !== "string" || item.model.length === 0 || !efforts || !efforts.every(effort => typeof effort === "string" && effort.length > 0)) continue;
    models.push({ id: item.id, model: item.model, supportedReasoningEfforts: efforts as string[] });
  }
  const cursor = record.nextCursor ?? record.next_cursor;
  return { models, ...(typeof cursor === "string" && cursor.length > 0 ? { nextCursor: cursor } : {}) };
}

/**
 * Validates only an explicitly configured worker model. It never selects a
 * default, changes a provider setting, or infers a faster tier.
 */
export async function validateWorkerModel(
  rpc: WorkerModelRpc,
  model?: string,
  effort?: WorkerModelSettings["localWorkerReasoningEffort"],
): Promise<VerifiedWorkerModel | undefined> {
  if (!model && !effort) return undefined;
  if (!model) throw new Error("localWorkerReasoningEffort requires an explicit localWorkerModel.");

  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let pageNumber = 0; pageNumber < MAX_MODEL_LIST_PAGES; pageNumber++) {
    const page = parsePage(await rpc.call("model/list", cursor ? { cursor } : {}));
    const found = page.models.find(candidate => candidate.model === model || candidate.id === model);
    if (found) {
      if (effort && !found.supportedReasoningEfforts.includes(effort))
        throw new Error(`Model '${found.model}' does not support reasoning effort '${effort}'.`);
      return effort ? { model: found.model, effort } : { model: found.model };
    }
    if (!page.nextCursor) break;
    if (seenCursors.has(page.nextCursor)) throw new Error("Model listing repeated a page cursor.");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error(`Configured localWorkerModel '${model}' is unavailable.`);
}
