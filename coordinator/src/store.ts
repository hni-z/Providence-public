import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ExecutionTarget, ExecutionQuiescence } from "./iphone-mirroring-route.js";
import type { WorkflowManifest, WorkflowRole, WorkflowStatus } from "./workflow-manifest.js";
import { RequestNotAcceptedError } from "./iphone-mirroring-route.js";
import { executionTargetsEqual } from "../../iphone-mirroring/host-route.mjs";
import { admissionQueueWait, MAX_QUEUED_PER_CHAT, type AdmissionQueueWait } from "./admission-queue.js";
/** Raised when another live Providence process already owns this data directory. */
export class StoreLockError extends Error {
  override readonly name = "StoreLockError";
}
function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means the process exists but belongs to another user.
    return e?.code === "EPERM";
  }
}
export type Chat = {
  id: string;
  name: string;
  deviceId: string;
  threadId: string;
  workspace?: string;
  instructions?: string;
  imported?: boolean;
  providerState?: 'unstarted' | 'active';
  previousThreadIds?: string[];
  history: { role: string; text: string; taskId: string }[];
};
export type Task = {
  id: string;
  requestId: string;
  chatId: string;
  deviceId: string;
  status: string;
  prompt: string;
  text: string;
  sourceChatIds?: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
  artifacts?: Artifact[];
  parentTaskId?: string;
  workflow?: WorkflowManifest;
  workflowRole?: WorkflowRole;
  workflowRequestAliases?: string[];
  workflowStatus?: WorkflowStatus;
  afterTaskId?: string;
  childTaskIds?: string[];
  workStatus?: string;
  childUpdates?: ChildTaskUpdate[];
  latestChildUpdateAt?: string;
  hasNewerChildUpdates?: boolean;
  childUpdateCount?: number;
  childUpdatesTruncated?: boolean;
  progress?: TaskProgress;
  executionTarget?: ExecutionTarget;
  executionQuiescence?: ExecutionQuiescence;
  queueIfBusy?: boolean;
  admissionQueue?: AdmissionQueueWait;
};
export type TaskProgress = {
  kind: "waiting_input" | "tool" | "message" | "queued" | "result";
  text: string;
  updatedAt: string;
};
export type ChildTaskUpdate = {
  id: string;
  chatId: string;
  chatName: string;
  deviceId: string;
  deviceName: string;
  status: string;
  text: string;
  textTruncated?: boolean;
  updatedAt: string;
  artifacts?: Artifact[];
  afterTaskId?: string;
  artifactCount?: number;
  artifactsTruncated?: boolean;
  hasLiveText: boolean;
  progress: TaskProgress;
};
export type Artifact = {
  id: string;
  taskId: string;
  chatId: string;
  deviceId: string;
  path: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  revision: number;
  createdAt: string;
};
export type Approval = {
  id: string;
  taskId: string;
  deviceId: string;
  method: string;
  details: any;
  status: string;
  providerRequestId?: string | number;
  requestedPersistence?: "session" | "always" | null;
};
export type StoredEvent = {
  sequence: number;
  at: string;
  type: string;
  [key: string]: any;
};
/** ceiling: the longest reply text kept anywhere in the snapshot. Raise it when a view needs to show more than 12000 characters. */
export const MAX_STORED_TEXT = 30000;
/** ceiling: roughly the retained event bytes. Raise it when a client needs deeper history than the snapshot can afford to rewrite. */
const MAX_EVENT_BYTES = 2_000_000;
/** A torn state file must cost the previous snapshot at worst, never the ability to start. */
function readState(file: string): Store["state"] {
  let seen = false;
  for (const candidate of [file, file + ".bak"]) {
    if (!existsSync(candidate)) continue;
    seen = true;
    try {
      const state = JSON.parse(readFileSync(candidate, "utf8"));
      if (!state || typeof state !== "object" || Array.isArray(state) ||
          ["chats", "tasks", "approvals"].some((key) => !state[key] || typeof state[key] !== "object") ||
          !Array.isArray(state.events))
        throw new Error("state file does not describe a Providence snapshot");
      if (candidate !== file)
        console.error(`Providence recovered its state from ${candidate}; work recorded after that snapshot was lost.`);
      return state;
    } catch (e: any) {
      console.error(`Providence could not read ${candidate}: ${e.message}`);
    }
  }
  if (seen)
    console.error("Providence is starting with empty state: neither the state file nor its backup could be read.");
  return { chats: {}, tasks: {}, approvals: {}, events: [], sequence: 0 };
}
export class Store {
  private stopped = false;
  state: {
    chats: Record<string, Chat>;
    tasks: Record<string, Task>;
    approvals: Record<string, Approval>;
    events: StoredEvent[];
    sequence: number;
    masterThreadId?: string;
    masterToolVersion?: string;
    masterContextPending?: boolean;
    masterRuntimeHistory?: {
      threadId: string;
      replacedAt: string;
      reason: string;
    }[];
    artifacts?: Record<string, Artifact>;
    /** Content-free replay protection retained when Providence conversations are cleared. */
    clearedRequestHashes?: string[];
  };
  private readonly lockFile: string;
  private eventBytes = 0;
  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.lockFile = join(dirname(file), "state.lock");
    this.lock();
    this.state = readState(file);
    this.eventBytes = this.state.events.reduce((total, e) => total + JSON.stringify(e).length, 0);
    for (const task of Object.values(this.state.tasks))
      if (["queued", "running", "needs_input"].includes(task.status)) {
        task.status = "interrupted";
        task.error =
          "Coordinator restarted. Inspect the host before resubmitting.";
      }
    for (const p of Object.values(this.state.approvals))
      if (["pending", "resolving"].includes(p.status)) p.status = "expired";
    this.save();
  }
  private lock() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(this.lockFile, String(process.pid), { flag: "wx", mode: 0o600 });
        return;
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
        let owner = 0;
        try {
          owner = Number(readFileSync(this.lockFile, "utf8").trim());
        } catch {}
        if (Number.isInteger(owner) && owner > 0 && processAlive(owner))
          throw new StoreLockError(
            `Providence data directory ${dirname(this.file)} is already in use by process ${owner}. Stop it before starting another coordinator.`,
          );
        console.error(
          `Taking over the Providence state lock in ${dirname(this.file)}; its owner is no longer running.`,
        );
        rmSync(this.lockFile, { force: true });
      }
    }
    throw new StoreLockError(
      `Providence data directory ${dirname(this.file)} could not be locked.`,
    );
  }
  save() {
    // A retired coordinator may still receive an asynchronous completion. It
    // no longer owns this file and must not overwrite its replacement's state.
    if (this.stopped) return;
    // Per-process temporary name: a shared one lets a second writer delete the file this rename needs.
    const tmp = `${this.file}.${process.pid}.tmp`;
    const data = JSON.stringify(this.state, null, 2);
    for (let attempt = 0; ; attempt++) {
      let fd: number | undefined;
      try {
        fd = openSync(tmp, "w", 0o600);
        writeFileSync(fd, data);
        // The bytes must reach the disk before the previous snapshot is demoted to the backup.
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        if (existsSync(this.file)) renameSync(this.file, this.file + ".bak");
        renameSync(tmp, this.file);
        return;
      } catch (e) {
        if (fd !== undefined) try { closeSync(fd); } catch {}
        if (attempt) throw e;
        mkdirSync(dirname(this.file), { recursive: true });
      }
    }
  }
  /** Releases the data directory so another coordinator on this host can start. */
  stop() {
    this.stopped = true;
    try {
      if (readFileSync(this.lockFile, "utf8").trim() === String(process.pid))
        rmSync(this.lockFile, { force: true });
    } catch {}
  }
  addChat(name: string, deviceId: string, threadId: string) {
    const c: Chat = { id: randomUUID(), name, deviceId, threadId, history: [] };
    this.state.chats[c.id] = c;
    this.save();
    return c;
  }
  /** Caller must fence admission and stop all old writers before using a fresh Store instance. */
  clearChats() {
    const hashes = new Set(this.state.clearedRequestHashes ?? []);
    for (const task of Object.values(this.state.tasks))
      for (const requestId of [task.requestId, ...(task.workflowRequestAliases ?? [])])
        hashes.add(createHash("sha256").update(requestId).digest("hex"));
    this.state = { chats: {}, tasks: {}, approvals: {}, events: [], artifacts: {},
      sequence: this.state.sequence + 1, clearedRequestHashes: [...hashes] };
    this.eventBytes = 0;
    this.save();
    // Store.save rotates the previous snapshot. Rotate once more so recovery
    // cannot restore the just-cleared conversation history from state.json.bak.
    this.save();
  }
  findRequest(requestId: string) {
    return Object.values(this.state.tasks).find(
      (t) => t.requestId === requestId || (t.workflowRole && t.workflowRequestAliases?.includes(requestId)),
    );
  }
  createTask(
    requestId: string,
    chatId: string,
    deviceId: string,
    prompt: string,
    executionTarget?: ExecutionTarget,
    workflow?: WorkflowManifest,
    queueIfBusy = false,
  ) {
    if (this.state.clearedRequestHashes?.includes(createHash("sha256").update(requestId).digest("hex")))
      throw new Error("This request belongs to cleared chat history. Submit a new request instead of retrying it.");
    const prior = this.findRequest(requestId);
    if (prior) {
      if (prior.chatId !== chatId || prior.deviceId !== deviceId || prior.prompt !== prompt ||
          !executionTargetsEqual(prior.executionTarget, executionTarget) || JSON.stringify(prior.workflow) !== JSON.stringify(workflow) ||
          (prior.queueIfBusy === true) !== queueIfBusy)
        throw new Error("requestId was already used for different input");
      return { task: prior, created: false };
    }
    if (
      !queueIfBusy && Object.values(this.state.tasks).some(
        (t) =>
          t.chatId === chatId &&
          ["queued", "running", "needs_input"].includes(t.status),
      )
    )
      throw new RequestNotAcceptedError(requestId,
        new Error("Chat is busy. Wait for completion or cancel its current task."), "chatBusy");
    if (queueIfBusy && Object.values(this.state.tasks).filter((task) => task.chatId === chatId && task.status === "queued").length >= MAX_QUEUED_PER_CHAT)
      throw new RequestNotAcceptedError(requestId, new Error("This conversation's queue is full. Wait or cancel queued work before adding another request."), "queueFull");
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      requestId,
      chatId,
      deviceId,
      prompt,
      status: "queued",
      text: "",
      createdAt: now,
      updatedAt: now,
      ...(executionTarget ? { executionTarget } : {}),
      ...(workflow ? { workflow } : {}),
      ...(queueIfBusy ? { queueIfBusy: true } : {}),
    };
    if (queueIfBusy) task.admissionQueue = admissionQueueWait(task, Object.values(this.state.tasks));
    this.state.tasks[task.id] = task;
    this.save();
    return { task, created: true };
  }
  event(event: any): StoredEvent {
    const e = {
      ...event,
      sequence: ++this.state.sequence,
      at: new Date().toISOString(),
    };
    this.state.events.push(e);
    this.eventBytes += JSON.stringify(e).length;
    // A burst of large tool events would otherwise make every later snapshot a multi-megabyte write.
    while (this.state.events.length > 1000 || (this.eventBytes > MAX_EVENT_BYTES && this.state.events.length > 1))
      this.eventBytes -= JSON.stringify(this.state.events.shift()).length;
    this.save();
    return e;
  }
  update(id: string, patch: Partial<Task>) {
    const t = this.state.tasks[id];
    if (!t) throw new Error("Unknown task");
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return t;
  }
}
