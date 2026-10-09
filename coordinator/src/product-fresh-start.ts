import { createHash } from "node:crypto";

/** Pure planning only: callers must independently stop late events, seal admission,
 * persist the archive, and create provider contexts. No Store, filesystem, or provider is used here. */
export type RetainedChat = { chatId: string; deviceId: string; name: string; workspace: string };
export type ProductBinding = { chatId: string; deviceId: string };
export type ProductBindings = { watch: readonly ProductBinding[]; phone: ProductBinding; workflow: readonly ProductBinding[] };
export type FreshStartRules = { version: string; text: string; sha256: string };
export type QuiescenceReceipt = {
  nativeOperations: number; providerOperations: number; sttOperations: number; phoneOperations: number; hostBridgeOperations: number; unresolvedOutcomes: number;
  observedAt: string; operator: string;
};
export type ProductFreshStartInput = {
  stateBytes: string | Uint8Array; resetId: string; generationId: string; retainedChats: readonly RetainedChat[];
  bindings: ProductBindings; rules: FreshStartRules; masterToolVersion: string; quiescence: QuiescenceReceipt;
};
export type StagedChatCreate = RetainedChat & { instructions: string; providerState: "unstarted"; imported: false };
export type FreshStartPreview = {
  status: "ready" | "blocked" | "already_applied"; blockers: string[]; basisSha256: string; inputDigest: string;
  resetId: string; generationId: string; retainedChats: readonly RetainedChat[]; stagedChats: readonly StagedChatCreate[];
  masterToolVersion: string; bindings: ProductBindings; planDigest: string;
  resetEventAt: string; preservationAssertions: readonly string[]; oldSequence?: number; oldRequestIds?: readonly string[];
};
export type FreshStartReplacementReceipt = { chatId: string; deviceId: string; workspace: string; threadId: string };
export type FreshStartReplacements = { masterThreadId: string; chatReceipts: readonly FreshStartReplacementReceipt[] };
export type FreshStartMaterialization = {
  status: "materialized"; archiveBytes: Uint8Array; archiveSha256: string; nextStateBytes: Uint8Array; nextState: Record<string, unknown>;
  requestTombstones: readonly string[]; manifestDigest: string; rollbackCondition: string;
} | { status: "already_applied"; phase: "sealed" | "active"; basisSha256: string; inputDigest: string };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA = /^[a-fA-F0-9]{64}$/;
const KNOWN_ROOT = new Set(["chats", "tasks", "approvals", "events", "sequence", "masterThreadId", "masterToolVersion", "masterContextPending", "masterRuntimeHistory", "artifacts", "productFreshStart"]);

function bytes(value: string | Uint8Array): Uint8Array { return typeof value === "string" ? new TextEncoder().encode(value) : value.slice(); }
function text(value: Uint8Array): string { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
function sha(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}
function validId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function validMarker(value: unknown): value is Record<string, unknown> {
  const marker = object(value);
  return !!marker && validId(marker.resetId) && validId(marker.generationId) && SHA.test(String(marker.inputDigest)) &&
    (marker.phase === "sealed" || marker.phase === "active") &&
    Array.isArray(marker.requestTombstones) && marker.requestTombstones.every(validId) && new Set(marker.requestTombstones).size === marker.requestTombstones.length &&
    Array.isArray(marker.retiredProviderThreadIds) && marker.retiredProviderThreadIds.every(validId) && new Set(marker.retiredProviderThreadIds).size === marker.retiredProviderThreadIds.length;
}
function inputDigest(input: ProductFreshStartInput): string {
  return sha(canonical({ resetId: input.resetId, generationId: input.generationId, retainedChats: input.retainedChats, bindings: input.bindings, rules: input.rules, masterToolVersion: input.masterToolVersion }));
}
function parseState(input: ProductFreshStartInput, blockers: string[]): { state?: Record<string, unknown>; raw: Uint8Array } {
  const raw = bytes(input.stateBytes);
  try {
    const parsed = object(JSON.parse(text(raw)));
    if (!parsed) throw new Error();
    for (const key of Object.keys(parsed)) if (!KNOWN_ROOT.has(key)) blockers.push("state contains an unrecognized root section");
    return { state: parsed, raw };
  } catch { blockers.push("state bytes are not a valid product state JSON object"); return { raw }; }
}
function validateInput(input: ProductFreshStartInput, state: Record<string, unknown> | undefined, blockers: string[]) {
  if (!validId(input.resetId) || !validId(input.generationId) || input.resetId === input.generationId) blockers.push("resetId and generationId must be distinct valid IDs");
  if (input.retainedChats.length !== 3) blockers.push("exactly three retained chats are required");
  const chats = new Set<string>(), devices = new Set<string>();
  for (const chat of input.retainedChats) {
    if (!validId(chat.chatId) || !validId(chat.deviceId) || typeof chat.name !== "string" || !chat.name.trim() || typeof chat.workspace !== "string" || !chat.workspace.trim()) blockers.push("retained chat has invalid identity or workspace");
    if (chats.has(chat.chatId) || devices.has(chat.deviceId)) blockers.push("retained chats require unique chat and device IDs");
    chats.add(chat.chatId); devices.add(chat.deviceId);
  }
  const exactBinding = (binding: unknown): binding is ProductBinding => { const value = object(binding); return !!value && typeof value.chatId === "string" && typeof value.deviceId === "string" && chats.has(value.chatId) && devices.has(value.deviceId) && input.retainedChats.some(chat => chat.chatId === value.chatId && chat.deviceId === value.deviceId); };
  if (!Array.isArray(input.bindings.watch) || !input.bindings.watch.length || input.bindings.watch.some(binding => !exactBinding(binding))) blockers.push("Watch bindings must be nonempty exact retained chat/device pairs");
  if (!exactBinding(input.bindings.phone)) blockers.push("phone binding does not close over an exact retained chat/device pair");
  if (!Array.isArray(input.bindings.workflow) || input.bindings.workflow.length !== 3 || new Set(input.bindings.workflow.map(binding => `${binding.chatId}\u0000${binding.deviceId}`)).size !== 3 || input.bindings.workflow.some(binding => !exactBinding(binding)) || input.bindings.workflow.some(binding => !input.retainedChats.some(chat => chat.chatId === binding.chatId && chat.deviceId === binding.deviceId)) || new Set(input.bindings.workflow.map(binding => binding.chatId)).size !== 3) blockers.push("workflow bindings must be three unique exact retained chat/device pairs");
  if (typeof input.rules.version !== "string" || !input.rules.version.trim() || typeof input.rules.text !== "string" || !input.rules.text.trim() || !SHA.test(input.rules.sha256) || sha(input.rules.text) !== input.rules.sha256.toLowerCase()) blockers.push("rules version, text, or sha256 is invalid");
  if (!validId(input.masterToolVersion)) blockers.push("masterToolVersion is invalid");
  const q = input.quiescence;
  if (!q || !Object.values({ nativeOperations: q.nativeOperations, providerOperations: q.providerOperations, sttOperations: q.sttOperations, phoneOperations: q.phoneOperations, hostBridgeOperations: q.hostBridgeOperations, unresolvedOutcomes: q.unresolvedOutcomes }).every(value => value === 0) || typeof q.observedAt !== "string" || !Number.isFinite(Date.parse(q.observedAt)) || typeof q.operator !== "string" || !q.operator.trim()) blockers.push("operator quiescence receipt does not attest zero operations and outcomes");
  if (!state) return;
  const tasks = object(state.tasks), approvals = object(state.approvals), storedChats = object(state.chats);
  if (!tasks || !approvals || !storedChats || !Array.isArray(state.events) || !Number.isSafeInteger(state.sequence) || (state.sequence as number) < 0 || (state.sequence as number) >= Number.MAX_SAFE_INTEGER) blockers.push("state lacks appendable known product Store sections");
  const taskStatuses = new Set(["queued", "running", "needs_input", "completed", "failed", "interrupted", "cancelled"]), approvalStatuses = new Set(["pending", "resolving", "approved", "denied", "expired", "resolved"]);
  const taskRequestIds = (task: unknown): string[] | undefined => {
    const value = object(task);
    if (!value || !validId(value.requestId) || !taskStatuses.has(String(value.status))) return undefined;
    if (!value.workflowRole) return value.workflowRequestAliases === undefined ? [value.requestId] : undefined;
    if (value.workflowRequestAliases === undefined) return [value.requestId];
    if (!Array.isArray(value.workflowRequestAliases) || !value.workflowRequestAliases.every(validId) || new Set(value.workflowRequestAliases).size !== value.workflowRequestAliases.length) return undefined;
    return [value.requestId, ...value.workflowRequestAliases];
  };
  if (tasks && Object.values(tasks).some(task => !taskRequestIds(task))) blockers.push("state has malformed task identity, workflow aliases, or unknown task status");
  if (tasks && Object.values(tasks).some(task => { const value = object(task); return value && ["queued", "running", "needs_input"].includes(String(value.status)); })) blockers.push("state has queued, running, or needs_input tasks");
  if (approvals && Object.values(approvals).some(approval => { const value = object(approval); return !value || !approvalStatuses.has(String(value.status)); })) blockers.push("state has malformed approval or unknown approval status");
  if (approvals && Object.values(approvals).some(approval => { const value = object(approval); return value && ["pending", "resolving"].includes(String(value.status)); })) blockers.push("state has pending or resolving approvals");
  const allTaskRequestIds = tasks ? Object.values(tasks).flatMap(task => taskRequestIds(task) ?? []) : [];
  if (tasks && new Set(allTaskRequestIds).size !== allTaskRequestIds.length) blockers.push("state has duplicate task request identities");
  if (Array.isArray(state.events)) {
    let previous = -1;
    for (const event of state.events) {
      const value = object(event), sequence = value?.sequence;
      if (!value || !Number.isSafeInteger(sequence) || (sequence as number) < 1 || (sequence as number) <= previous || (sequence as number) > (state.sequence as number) || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))) { blockers.push("state has inconsistent event sequence or timestamp"); break; }
      previous = sequence as number;
    }
  }
  if (storedChats && input.retainedChats.some(chat => { const stored = object(storedChats[chat.chatId]); return !stored || stored.deviceId !== chat.deviceId || stored.name !== chat.name || (stored.workspace ?? undefined) !== chat.workspace; })) blockers.push("retained mapping does not match the product state");
  if (state.productFreshStart !== undefined && !object(state.productFreshStart)) blockers.push("state has malformed product fresh start marker");
  const marker = object(state.productFreshStart);
  if (marker) {
    if (!validId(marker.resetId) || !validId(marker.generationId) || !SHA.test(String(marker.inputDigest)) || (marker.phase !== "sealed" && marker.phase !== "active") || !Array.isArray(marker.requestTombstones) || !Array.isArray(marker.retiredProviderThreadIds)) blockers.push("state has malformed product fresh start marker");
    if (marker.resetId === input.resetId && marker.inputDigest !== inputDigest(input)) blockers.push("resetId conflicts with a different prior reset input");
    if (marker.resetId !== input.resetId && marker.phase === "sealed") blockers.push("a different sealed reset generation already exists");
    if (Array.isArray(marker.requestTombstones) && (!marker.requestTombstones.every(validId) || new Set(marker.requestTombstones).size !== marker.requestTombstones.length)) blockers.push("state has malformed or duplicate request tombstones");
    if (Array.isArray(marker.retiredProviderThreadIds) && (!marker.retiredProviderThreadIds.every(validId) || new Set(marker.retiredProviderThreadIds).size !== marker.retiredProviderThreadIds.length)) blockers.push("state has malformed or duplicate retired provider identities");
  }
}
function previewDigest(preview: Pick<FreshStartPreview, "status" | "blockers" | "basisSha256" | "inputDigest" | "resetId" | "generationId" | "retainedChats" | "stagedChats" | "bindings" | "masterToolVersion" | "oldSequence" | "resetEventAt">): string {
  return sha(canonical({ status: preview.status, blockers: preview.blockers, basisSha256: preview.basisSha256, inputDigest: preview.inputDigest, resetId: preview.resetId, generationId: preview.generationId, retainedChats: preview.retainedChats, stagedChats: preview.stagedChats, bindings: preview.bindings, masterToolVersion: preview.masterToolVersion, oldSequence: preview.oldSequence, resetEventAt: preview.resetEventAt }));
}

/** External quiescence is operator-supplied evidence; this pure helper cannot independently prove it. */
export function inspectProductFreshStart(input: ProductFreshStartInput): FreshStartPreview {
  const blockers: string[] = [], parsed = parseState(input, blockers), basisSha256 = sha(parsed.raw), digest = inputDigest(input);
  validateInput(input, parsed.state, blockers);
  const marker = parsed.state && object(parsed.state.productFreshStart);
  // A repeated operation may encounter newer work, but malformed state must not
  // be hidden behind an otherwise matching historical operation marker.
  const noWriteLookupBlockers = new Set(["state has queued, running, or needs_input tasks", "state has pending or resolving approvals", "operator quiescence receipt does not attest zero operations and outcomes", "retained mapping does not match the product state"]);
  const applied = validMarker(marker) && marker.resetId === input.resetId && marker.inputDigest === digest && blockers.every(blocker => noWriteLookupBlockers.has(blocker));
  const retainedChats = input.retainedChats.map(chat => ({ ...chat }));
  const bindings: ProductBindings = { watch: input.bindings.watch.map(binding => ({ ...binding })), phone: { ...input.bindings.phone }, workflow: input.bindings.workflow.map(binding => ({ ...binding })) };
  const stagedChats = retainedChats.map(chat => ({ ...chat, instructions: input.rules.text, providerState: "unstarted" as const, imported: false as const }));
  const status: FreshStartPreview["status"] = applied ? "already_applied" : blockers.length ? "blocked" : "ready";
  const base = { status, blockers, basisSha256, inputDigest: digest, resetId: input.resetId, generationId: input.generationId, retainedChats, stagedChats, bindings, masterToolVersion: input.masterToolVersion, resetEventAt: input.quiescence.observedAt, ...(parsed.state && Number.isSafeInteger(parsed.state.sequence) ? { oldSequence: parsed.state.sequence as number } : {}) };
  const aliases = (task: unknown): string[] => { const value = object(task); return value && value.workflowRole && Array.isArray(value.workflowRequestAliases) ? value.workflowRequestAliases.filter(validId) : []; };
  return { ...base, planDigest: previewDigest(base), preservationAssertions: ["No filesystem, credential, config, enrollment, provider, or live Store access occurred.", "Unknown root sections are rejected rather than preserved because they may carry old context or credentials.", "Artifact metadata is carried forward unchanged; artifact bytes remain external pointers.", "External quiescence is supplied evidence, not independently verified."], ...(parsed.state && Number.isSafeInteger(parsed.state.sequence) ? { oldRequestIds: Object.values(object(parsed.state.tasks) ?? {}).flatMap(task => [object(task)?.requestId, ...aliases(task)]).filter(validId) } : {}) };
}

export function materializeProductFreshStart(preview: FreshStartPreview, replacements: FreshStartReplacements, currentStateBytes?: string | Uint8Array): FreshStartMaterialization {
  if (preview.status === "already_applied") {
    if (currentStateBytes === undefined) throw new Error("Current state bytes are required to validate an applied reset");
    let marker: Record<string, unknown> | undefined;
    try { marker = object(object(JSON.parse(text(bytes(currentStateBytes))))?.productFreshStart); } catch { throw new Error("Current state bytes are invalid"); }
    if (!validMarker(marker) || marker.resetId !== preview.resetId || marker.generationId !== preview.generationId || marker.inputDigest !== preview.inputDigest) throw new Error("Applied reset marker no longer matches this preview");
    return { status: "already_applied", phase: marker.phase as "sealed" | "active", basisSha256: preview.basisSha256, inputDigest: preview.inputDigest };
  }
  if (preview.status !== "ready") throw new Error("Fresh start preview is not ready");
  if (currentStateBytes === undefined || sha(bytes(currentStateBytes)) !== preview.basisSha256) throw new Error("Fresh start basis changed; compare-and-swap assertion failed");
  if (preview.planDigest !== previewDigest(preview)) throw new Error("Fresh start preview was modified after inspection");
  let old: Record<string, unknown>;
  try { old = object(JSON.parse(text(bytes(currentStateBytes)))) ?? (() => { throw new Error(); })(); } catch { throw new Error("Current state bytes are invalid"); }
  const oldThreads = new Set<string>();
  for (const chat of Object.values(object(old.chats) ?? {})) { const value = object(chat); if (value && validId(value.threadId)) oldThreads.add(value.threadId); for (const previous of Array.isArray(value?.previousThreadIds) ? value!.previousThreadIds : []) if (validId(previous)) oldThreads.add(previous); }
  if (typeof old.masterThreadId === "string") oldThreads.add(old.masterThreadId);
  for (const entry of Array.isArray(old.masterRuntimeHistory) ? old.masterRuntimeHistory : []) { const value = object(entry); if (value && validId(value.threadId)) oldThreads.add(value.threadId); }
  const oldMarker = object(old.productFreshStart), retired = Array.isArray(oldMarker?.retiredProviderThreadIds) ? oldMarker!.retiredProviderThreadIds : [];
  if (!retired.every(validId) || new Set(retired).size !== retired.length) throw new Error("State has malformed retired provider identities");
  retired.forEach(id => oldThreads.add(id));
  const receipts = replacements.chatReceipts;
  const expectedReceipts = preview.retainedChats.map(chat => receipts.find(receipt => receipt.chatId === chat.chatId));
  const replacementThreads = [replacements.masterThreadId, ...expectedReceipts.map(receipt => receipt?.threadId)];
  if (!validId(replacements.masterThreadId) || receipts.length !== 3 || !replacementThreads.every(validId) || new Set(replacementThreads).size !== 4 || replacementThreads.some(id => oldThreads.has(id)) || expectedReceipts.some((receipt, index) => !receipt || receipt.deviceId !== preview.retainedChats[index].deviceId || receipt.workspace !== preview.retainedChats[index].workspace || !validId(receipt.threadId))) throw new Error("Replacement receipts must be new, unique, and exactly match retained chat/device/workspace");
  const archiveBytes = bytes(currentStateBytes), archiveSha256 = sha(archiveBytes);
  if (archiveSha256 !== preview.basisSha256) throw new Error("Fresh start archive basis was modified after inspection");
  const oldTasks = object(old.tasks) ?? {}, oldTombstones = Array.isArray(oldMarker?.requestTombstones) ? oldMarker!.requestTombstones : [];
  if (!oldTombstones.every(validId) || new Set(oldTombstones).size !== oldTombstones.length) throw new Error("State has malformed request tombstones");
  const taskRequestIds = Object.values(oldTasks).flatMap(task => {
    const value = object(task), aliases = value?.workflowRole && Array.isArray(value.workflowRequestAliases) ? value.workflowRequestAliases : [];
    return [value?.requestId, ...aliases];
  });
  if (!taskRequestIds.every(validId) || new Set(taskRequestIds).size !== taskRequestIds.length) throw new Error("State has malformed task request identities");
  const tombstones = [...new Set([...oldTombstones, ...taskRequestIds])];
  const nextChats: Record<string, unknown> = {};
  for (const chat of preview.stagedChats) { const receipt = receipts.find(value => value.chatId === chat.chatId)!; nextChats[chat.chatId] = { id: chat.chatId, name: chat.name, deviceId: chat.deviceId, workspace: chat.workspace, instructions: chat.instructions, threadId: receipt.threadId, history: [], previousThreadIds: [], imported: false, providerState: "unstarted" }; }
  const oldSequence = preview.oldSequence ?? 0, resetEvent = { sequence: oldSequence + 1, at: preview.resetEventAt, type: "product_fresh_start.sealed", resetId: preview.resetId, generationId: preview.generationId, basisSha256: preview.basisSha256, inputDigest: preview.inputDigest };
  const rollbackCondition = "Rollback is forbidden after any new-generation task, approval, provider turn, or external effect has been accepted; staging empty provider contexts alone is not execution. Caller must enforce this before archive restoration.";
  const next: Record<string, unknown> = { chats: nextChats, tasks: {}, approvals: {}, events: [resetEvent], sequence: oldSequence + 1, masterThreadId: replacements.masterThreadId, masterToolVersion: preview.masterToolVersion, masterContextPending: false, masterRuntimeHistory: [], ...(old.artifacts === undefined ? {} : { artifacts: old.artifacts }), productFreshStart: { phase: "sealed", sealed: true, resetId: preview.resetId, generationId: preview.generationId, inputDigest: preview.inputDigest, basisSha256: preview.basisSha256, archiveSha256, requestTombstones: tombstones, retiredProviderThreadIds: [...oldThreads], oldEventsArchived: true, rollbackCondition } };
  const nextStateBytes = new TextEncoder().encode(canonical(next)), manifestDigest = sha(canonical({ resetId: preview.resetId, generationId: preview.generationId, basisSha256: preview.basisSha256, archiveSha256, masterThreadId: replacements.masterThreadId, tombstones, chats: nextChats, sequence: oldSequence + 1 }));
  return { status: "materialized", archiveBytes, archiveSha256, nextStateBytes, nextState: next, requestTombstones: tombstones, manifestDigest, rollbackCondition };
}
