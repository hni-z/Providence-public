export interface Device {
  id: string;
  name: string;
  online: boolean;
  connectionState?: string;
  platform?: string;
  hostname?: string;
  workspace?: string;
  capabilities?: Record<string, boolean>;
}
export interface Chat {
  id: string;
  name: string;
  deviceId: string;
  online?: boolean;
}
export interface Artifact {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  revision: number;
  taskId: string;
}
export interface TaskProgress {
  kind: "waiting_input" | "tool" | "message" | "queued" | "result";
  text: string;
  updatedAt: string;
}
export interface ChildTaskUpdate {
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
  artifactCount?: number;
  artifactsTruncated?: boolean;
  afterTaskId?: string;
  hasLiveText: boolean;
  progress?: TaskProgress;
}
export interface Task {
  id: string;
  chatId: string;
  deviceId: string;
  status: string;
  prompt: string;
  text: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  workStatus?: string;
  childTaskIds?: string[];
  parentTaskId?: string;
  artifacts?: Artifact[];
  progress?: TaskProgress;
  childUpdates?: ChildTaskUpdate[];
  latestChildUpdateAt?: string;
  hasNewerChildUpdates?: boolean;
  childUpdateCount?: number;
  childUpdatesTruncated?: boolean;
}
export interface Question {
  id: string;
  header?: string;
  question: string;
  isSecret?: boolean;
  options?: { label: string; description?: string }[];
}
export interface Approval {
  id: string;
  taskId: string;
  deviceId: string;
  method: string;
  status: string;
  details: { questions?: Question[]; [key: string]: unknown };
}
export interface Snapshot {
  devices: Device[];
  chats: Chat[];
  tasks: Task[];
  approvals: Approval[];
}
export type Action = {
  id: string;
  label: string;
  tone?: "primary" | "danger";
  disabled?: boolean;
  onSelect: () => void;
  onRelease?: () => void;
  onCancel?: () => void;
};
export interface Panel {
  id: string;
  title: string;
  eyebrow?: string;
  lines: string[];
  actions: Action[];
}
export interface SpatialState {
  panels: Panel[];
  status: string;
  voice?: { action: Action; state: string; label: string };
}
export interface SpatialCapabilities {
  exitError?: string;
  arranging?: boolean;
  focused?: boolean;
  active: boolean;
  hands: number;
  controllers: number;
  keyboard: boolean;
  selections: number;
}
