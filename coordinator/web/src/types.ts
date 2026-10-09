export type Capability = {
  supported?: boolean;
  available?: boolean;
  status?: string;
  reason?: string;
};
export type CapabilityEvidence = {
  status: "verified_scoped" | "not_verified";
  requiresApproval: true;
  grantsPermission: false;
  taskId?: string;
  observedAt?: string;
  scope?: string;
};
export type Device = {
  id: string;
  name: string;
  online: boolean;
  workerAccess?: "workspace" | "full-access";
  keepAwake?: { enabled: boolean; active: boolean; method?: string; reason?: string };
  connectionState?: "online" | "offline";
  connectionStatus?: {
    state: "online" | "connecting" | "offline" | "action_required";
    reasonCode?: string;
    connectedAt?: string;
    lastSeenAt?: string;
    disconnectedAt?: string;
  };
  local?: boolean;
  workspace?: string;
  platform?: string;
  capabilities?: string[] | Record<string, boolean | string | Capability>;
  capabilityEvidence?: Partial<
    Record<"browser" | "desktop", CapabilityEvidence>
  >;
};
export type Chat = {
  id: string;
  name: string;
  deviceId: string;
  threadId: string;
  online: boolean;
  imported?: boolean;
  workspace?: string;
};
export type Artifact = {
  id: string;
  taskId: string;
  chatId?: string;
  deviceId?: string;
  name: string;
  path?: string;
  relativePath?: string;
  size: number;
  mimeType?: string;
  mime?: string;
  revision?: number;
  sha256?: string;
  createdAt?: string;
  verifiedAt?: string;
};
export type ChildUpdate = {
  id: string;
  chatId: string;
  chatName: string;
  deviceId: string;
  deviceName: string;
  status: string;
  text: string;
  updatedAt: string;
  artifacts?: Artifact[];
  afterTaskId?: string;
  hasLiveText: boolean;
  textTruncated?: boolean;
  artifactCount?: number;
  artifactsTruncated?: boolean;
  progress?: {
    kind: "waiting_input" | "tool" | "message" | "queued" | "result";
    text: string;
    updatedAt: string;
  };
};
export type Task = {
  id: string;
  requestId: string;
  chatId: string;
  deviceId: string;
  status: string;
  queueIfBusy?: boolean;
  admissionQueue?: { reason: "chat_busy" | "device_busy"; predecessorTaskId: string };
  prompt: string;
  text: string;
  error?: string;
  sourceChatIds?: string[];
  createdAt: string;
  updatedAt: string;
  artifacts?: Artifact[];
  parentTaskId?: string;
  afterTaskId?: string;
  childTaskIds?: string[];
  workStatus?: string;
  childUpdates?: ChildUpdate[];
  latestChildUpdateAt?: string;
  hasNewerChildUpdates?: boolean;
  childUpdateCount?: number;
  childUpdatesTruncated?: boolean;
};
export type Question = {
  id: string;
  header?: string;
  question: string;
  isSecret?: boolean;
  isOther?: boolean;
  options?: { label: string; description?: string }[];
};
export type Approval = {
  id: string;
  taskId: string;
  deviceId: string;
  method: string;
  details: {
    command?: string | string[];
    reason?: string;
    cwd?: string;
    questions?: Question[];
    [key: string]: unknown;
  };
  status: string;
};
export type Activity = {
  sequence: number;
  at: string;
  type: string;
  taskId?: string;
  deviceId?: string;
  chatId?: string;
  sourceChatIds?: string[];
  targetChatId?: string;
  item?: {
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
  [key: string]: unknown;
};
export type Briefing = {
  devices: Device[];
  tasks: Task[];
  approvals: Approval[];
};
export type Envelope = {
  requestId: string;
  text: string;
  chatId: string;
  sourceChatIds: string[];
  queueIfBusy?: boolean;
  expectedDeviceId?: string;
  voice?: boolean;
};
