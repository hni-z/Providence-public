import { z } from "zod";
import type { Artifact } from "./store.js";
import { MAX_WORKFLOW_FACT_BUNDLE_BYTES, MAX_WORKFLOW_FACT_SOURCES, MAX_WORKFLOW_FACTS, WORKFLOW_FACT_BUNDLE_VERSION, parseWorkflowFactBundle, type WorkflowFactBundle, type WorkflowFactExpectedOrigin } from "./workflow-facts.js";

export const workflowRoles = ["research", "analysis", "presentation"] as const;
export const workflowRoleSchema = z.enum(workflowRoles);
export type WorkflowRole = z.infer<typeof workflowRoleSchema>;
const identity = z.string().min(1).max(200);
export const workflowManifestSchema = z.object({
  version: z.literal(1),
  bindings: z.array(z.object({ role: workflowRoleSchema, deviceId: identity, chatId: identity }).strict()).length(3),
}).strict().superRefine((manifest, context) => {
  for (const key of ["role", "deviceId", "chatId"] as const)
    if (new Set(manifest.bindings.map((binding) => binding[key])).size !== 3)
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Workflow requires three distinct ${key} values`, path: ["bindings"] });
}).transform((manifest) => ({
  version: manifest.version,
  bindings: workflowRoles.map((role) => manifest.bindings.find((binding) => binding.role === role)!),
}));
export type WorkflowManifest = z.infer<typeof workflowManifestSchema>;
export type WorkflowBinding = WorkflowManifest["bindings"][number];
type WorkflowDevice = { id: string; name: string; online: boolean; capabilities?: { files?: unknown; shell?: unknown; browser?: unknown; desktop?: unknown } };
type WorkflowChat = { id: string; deviceId: string };
type WorkflowTask = { id: string; requestId: string; chatId: string; deviceId: string; prompt: string; text: string; status: string; parentTaskId?: string; workflowRole?: WorkflowRole; sourceChatIds?: string[]; afterTaskId?: string };

export function freezeWorkflow(manifest: WorkflowManifest): WorkflowManifest {
  manifest.bindings.forEach(Object.freeze);
  Object.freeze(manifest.bindings);
  return Object.freeze(manifest);
}
export function workflowsEqual(left?: WorkflowManifest, right?: WorkflowManifest) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** This metadata check never grants app permission or establishes a fresh visible result. */
export function validateWorkflowBinding(binding: WorkflowBinding, chats: WorkflowChat[], devices: WorkflowDevice[]) {
  const chat = chats.find((value) => value.id === binding.chatId);
  if (!chat || chat.deviceId !== binding.deviceId)
    throw new Error(`Workflow ${binding.role} must use its exact registered conversation and computer.`);
  const device = devices.find((value) => value.id === binding.deviceId);
  if (!device?.online) throw new Error(`Workflow ${binding.role} computer is offline or unavailable. No alternate computer was selected.`);
  if (device.capabilities?.files !== true || device.capabilities?.shell !== true)
    throw new Error(`${device.name} must support file and shell work for the workflow.`);
  if (device.capabilities.browser !== true && device.capabilities.desktop !== true)
    throw new Error(`${device.name} has no available browser or desktop support for this visible workflow. App permission is still required separately.`);
}
export function validateWorkflow(manifest: WorkflowManifest, chats: WorkflowChat[], devices: WorkflowDevice[]) {
  for (const binding of manifest.bindings) validateWorkflowBinding(binding, chats, devices);
}

export function workflowChildGuard(manifest: WorkflowManifest, parentId: string, chat: WorkflowChat,
  input: { role?: WorkflowRole; requestId: string; text: string; afterTaskId?: string; sourceChatIds: string[]; executionTarget?: unknown },
  tasks: WorkflowTask[]) {
  if (!input.role) throw new Error("This workflow requires an explicit research, analysis or presentation role.");
  if (input.executionTarget) throw new Error("This workflow uses its three fixed computers; alternate execution targets are not allowed.");
  const binding = manifest.bindings.find((value) => value.role === input.role)!;
  if (chat.id !== binding.chatId || chat.deviceId !== binding.deviceId)
    throw new Error(`Workflow ${input.role} destination differs from its frozen assignment.`);
  const children = tasks.filter((task) => task.parentTaskId === parentId);
  const research = children.find((task) => task.workflowRole === "research");
  if (input.role === "research") {
    if (input.afterTaskId || input.sourceChatIds.length)
      throw new Error("Workflow research must start without dependencies or unrelated source conversations.");
  } else {
    const researchBinding = manifest.bindings.find((value) => value.role === "research")!;
    if (!research || research.chatId !== researchBinding.chatId || research.deviceId !== researchBinding.deviceId ||
        input.afterTaskId !== research.id)
      throw new Error(`Workflow ${input.role} must depend on this workflow's exact research task.`);
    if (input.sourceChatIds.length > 1 || input.sourceChatIds.some((id) => id !== researchBinding.chatId))
      throw new Error(`Workflow ${input.role} may receive context only from its research conversation.`);
    input.sourceChatIds = [researchBinding.chatId];
  }
  const prior = children.find((task) => task.workflowRole === input.role);
  if (prior) {
    if (prior.chatId !== chat.id || prior.deviceId !== chat.deviceId || prior.prompt !== input.text ||
        prior.afterTaskId !== input.afterTaskId || JSON.stringify(prior.sourceChatIds ?? []) !== JSON.stringify(input.sourceChatIds))
      throw new Error(`Workflow ${input.role} was already assigned with different input. Nothing was replayed.`);
    return { binding, existing: prior };
  }
  if (children.length >= 3) throw new Error("This workflow already has its three assigned tasks.");
  if (input.role !== "research" && research && !["queued", "running", "needs_input", "completed"].includes(research.status))
    throw new Error("Workflow research did not complete successfully; dependent work was not started.");
  return { binding, existing: undefined };
}

export function workflowWorkStatus(parent: { status: string; workflow: WorkflowManifest }, children: WorkflowTask[]) {
  for (const status of ["needs_input", "running", "queued", "interrupted", "failed", "cancelled"])
    if (children.some((child) => child.status === status)) return status;
  if (workflowRoles.some((role) => !children.some((child) => child.workflowRole === role)))
    return ["queued", "running", "needs_input"].includes(parent.status) ? "running" : "interrupted";
  return parent.status === "completed" ? "completed" : parent.status;
}

export type WorkflowStatus = {
  state: "waiting_research" | "running" | "needs_input" | "partial_failure" | "completed";
  reasonCode?: "required_role_not_started" | "parent_failed" | "role_failed";
  requiredRolesCompleted: number;
  artifactsPublished: number;
  outputsReady: boolean;
  effectVerification: "not_verified";
  roles: Array<WorkflowBinding & { taskId?: string; status: string }>;
  publishedArtifacts: Array<Pick<Artifact, "id" | "taskId" | "chatId" | "deviceId" | "name" | "mime" | "size" | "sha256" | "revision">>;
};

/** Reconcile the worker's declared publication state against the server's own artifact registry. */
export function workflowResearchArtifact(bundle: WorkflowFactBundle, artifacts: Record<string, Artifact>): Artifact | undefined {
  const { origin } = bundle, reference = origin.artifact;
  return Object.values(artifacts).find((artifact) =>
    artifact.taskId === origin.taskId && artifact.chatId === origin.chatId && artifact.deviceId === origin.deviceId &&
    Number.isSafeInteger(artifact.size) && artifact.size > 0 && typeof artifact.sha256 === "string" && /^[a-f0-9]{64}$/i.test(artifact.sha256) &&
    (reference.status === "not_published" ||
      (artifact.sha256.toLowerCase() === reference.sha256.toLowerCase() &&
        (reference.status === "published" ? artifact.id === reference.id : artifact.path === reference.path && artifact.size === reference.size))));
}

/** Task completion and published file metadata never imply an independently observed GUI effect. */
export function deriveWorkflowStatus(parent: { id: string; status: string; workflow: WorkflowManifest },
  children: WorkflowTask[], artifacts: Record<string, Artifact>): WorkflowStatus {
  const roles = parent.workflow.bindings.map((binding) => {
    const task = children.find((child) => child.parentTaskId === parent.id && child.workflowRole === binding.role &&
      child.chatId === binding.chatId && child.deviceId === binding.deviceId);
    return { ...binding, ...(task ? { taskId: task.id } : {}), status: task?.status ?? "not_started" };
  });
  const publishedArtifacts = Object.values(artifacts).filter((artifact) => roles.some((role) =>
    role.taskId === artifact.taskId && role.chatId === artifact.chatId && role.deviceId === artifact.deviceId))
    .map(({ id, taskId, chatId, deviceId, name, mime, size, sha256, revision }) => ({ id, taskId, chatId, deviceId, name, mime, size, sha256, revision }));
  const requiredRolesCompleted = roles.filter((role) => role.status === "completed").length;
  const research = children.find((child) => child.id === roles.find((role) => role.role === "research")?.taskId);
  const dependenciesMatch = !!research && !research.afterTaskId && !(research.sourceChatIds?.length) &&
    roles.filter((role) => role.role !== "research").every((role) => {
      const child = children.find((task) => task.id === role.taskId);
      return child?.afterTaskId === research.id && child.sourceChatIds?.length === 1 && child.sourceChatIds[0] === research.chatId;
    });
  let researchPublished = false;
  if (research && Buffer.byteLength(research.text, "utf8") <= MAX_WORKFLOW_FACT_BUNDLE_BYTES) {
    try {
      researchPublished = !!workflowResearchArtifact(parseWorkflowFactBundle(research.text, {
        taskId: research.id, chatId: research.chatId, deviceId: research.deviceId,
      }), artifacts);
    } catch { /* A completed turn without a valid exact-origin bundle cannot prove output readiness. */ }
  }
  const outputsReady = parent.status === "completed" && requiredRolesCompleted === 3 && dependenciesMatch && researchPublished &&
    roles.every((role) => publishedArtifacts.some((artifact) => artifact.taskId === role.taskId &&
      Number.isSafeInteger(artifact.size) && artifact.size > 0 && typeof artifact.sha256 === "string" && /^[a-f0-9]{64}$/i.test(artifact.sha256)));
  const failed = ["failed", "interrupted", "cancelled"];
  const state: WorkflowStatus["state"] = failed.includes(parent.status) || roles.some((role) => failed.includes(role.status)) ||
    (parent.status === "completed" && roles.some((role) => role.status === "not_started")) ? "partial_failure" :
    parent.status === "needs_input" || roles.some((role) => role.status === "needs_input") ? "needs_input" :
    requiredRolesCompleted === 3 && parent.status === "completed" ? "completed" :
    roles.find((role) => role.role === "research")?.status !== "completed" ? "waiting_research" : "running";
  const reasonCode: WorkflowStatus["reasonCode"] = failed.includes(parent.status) ? "parent_failed" :
    roles.some((role) => failed.includes(role.status)) ? "role_failed" :
    parent.status === "completed" && roles.some((role) => role.status === "not_started") ? "required_role_not_started" : undefined;
  return { state, ...(reasonCode ? { reasonCode } : {}), requiredRolesCompleted, artifactsPublished: publishedArtifacts.length, outputsReady, effectVerification: "not_verified", roles, publishedArtifacts };
}

export function workflowInstructions(manifest: WorkflowManifest) {
  return "\n\nThis request has a server-enforced three-computer workflow. These assignments are fixed for this request:\n" +
    JSON.stringify(manifest) +
    "\nUse providence_dispatch exactly once per role with its role field and assigned chatId. Start research first without source chats or a dependency. " +
    "Register analysis and presentation as independent siblings, both with afterTaskId set to that research task and sourceChatIds containing only its conversation. " +
    "Each worker must publish its actual output file as an artifact. Completed tasks and published files do not prove the files are open on screens. " +
    "Do not create conversations, change assignments, add roles, use phone tools, or substitute computers. Existing app approvals remain required. " +
    "Report the parent and actual child outcomes truthfully; a planning reply is not completed work.";
}

export function workflowResearchInstructions(origin: WorkflowFactExpectedOrigin) {
  return "\n\nRequired research handoff: your final response must be ONLY one complete JSON fact bundle, without Markdown fences or surrounding prose. " +
    `Maximum ${MAX_WORKFLOW_FACT_BUNDLE_BYTES} UTF-8 bytes, 1-${MAX_WORKFLOW_FACT_SOURCES} sources and 1-${MAX_WORKFLOW_FACTS} facts. Do not truncate or invent research to fit. ` +
    "Use the exact current task identity in origin: " + JSON.stringify(origin) + ". " +
    "The strict JSON fields are: " + JSON.stringify({ version: WORKFLOW_FACT_BUNDLE_VERSION, topic: "short topic", criteria: "comparison criteria", generatedAt: "ISO 8601 timestamp with offset",
      origin: { ...origin, artifact: { status: "not_published" } },
      sources: [{ id: "s1", url: "https://actual-source.example/path", title: "actual source title", retrievedAt: "ISO 8601 timestamp with offset" }],
      facts: [{ id: "f1", text: "source-grounded fact", sourceIds: ["s1"] }] }) +
    ". Use real retrieved sources, actual timestamps, unique source/fact IDs and sourceIds belonging to this bundle. " +
    "Publish the actual research brief file first. When providence_publish_artifact returns verified path, size and sha256 but no server artifact ID, use origin.artifact {status:'publication_unconfirmed',path:<actual relative path>,size:<actual positive byte count>,sha256:<actual 64-hex hash>}. " +
    "Use {status:'published',id:<actual server artifact ID>,sha256:<actual hash>} only when that server ID was actually acknowledged. Use {status:'not_published'} only to report unpublished output without invented references. " +
    "Do not copy the illustrative URL or fabricate publication. If research cannot be completed, report the blocker honestly; dependent tasks will not start without a valid bundle.";
}
