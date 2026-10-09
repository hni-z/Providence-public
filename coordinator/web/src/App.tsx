import { validateWorkspaceResponse } from "./workspace-response";
import { startActivityReporting } from "./activity";
import { HOSTED_ACCOUNT_SESSION, sessionCredentials } from "./api";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleHelp,
  Command,
  File,
  FileText,
  FolderOpen,
  Globe,
  Laptop,
  Layers3,
  Link2,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Menu,
  MessageSquare,
  Monitor,
  AudioLines,
  UserRound,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Smartphone,
  Square,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import ApprovalCard, { approvalRequestLabel } from "./ApprovalCard";
import ThemeToggle from "./ThemeToggle";
import BrowserVoice from "./BrowserVoice";
import { createLiveVoiceAdapter } from "./live-voice-client";
import { WorkspaceScrollLanding, workspaceScrollBehavior } from "./workspace-scroll";
import { conversationWindow, restoredHistoryScroll } from "./conversation-window";
import AppNavigation from "./AppNavigation";
import LiveConversation from "./LiveConversation";
import type { LiveConversationHandle } from "./LiveConversation";
import { initialWorkspaceView, workspaceViewUrl } from "./voice-screen";
import type { WorkspaceView } from "./voice-screen";
import { shouldSubmitComposerKey } from "./mobile";
import { downloadBlob } from "./download";
import {
  loadVoiceConfig,
  loadTranscriptionAvailability,
  transcribeVoice,
  createVoiceSpeechPlayer,
  voiceConfigurationIdentity,
  noVoiceConfig,
  voiceConfigAfterLookup,
  voiceConfigAfterFailedLookup,
} from "./voice-api";
import { configuredTranscriptionRoute, reconcileTranscriptionAvailability, deviceConnectionDetail, deviceConnectionLabel, destinationIssue } from "./destination";
import type { TranscriptionAvailability } from "./destination";
import { findRequestDelivery, MessageNotSentError, requestMatchesTask, submitToDestination } from "./message-delivery";
import type { VoiceConfig } from "./voice-api";
import type { VoiceConfigState } from "./voice-api";
import type { SpeechReplyIdentity } from "./server-audio";
import {
  initialSelectedChat,
  selectedChatAfter,
  reachableApprovals,
  blockingApprovals,
  selectedVoiceOutcomes,
  taskDecisions,
} from "./navigation";
import HostBridgeProof from "./HostBridgeProof";
import { hostProofActionForHash } from "./hostProofState";
import {
  groupArtifacts,
  linkedWork,
  newestArtifact,
  queuedDependencyLabel,
  childUpdatesFor,
  historicalSuperagentReply,
} from "./presentation";
import {
  active,
  api,
  ApiError,
  artifactBlob,
  exchangeClientCode,
  fileSize,
  REQUEST_TIMEOUT_MS,
  statusLabel,
  timeLabel,
} from "./api";
import type {
  Activity,
  Approval,
  Artifact,
  Briefing,
  Chat,
  ChildUpdate,
  Device,
  Envelope,
  Task,
} from "./types";

const SESSION = "providence.session";
const SELECTED = "providence.chat";
const PENDING = "providence.pending";
const safeRead = (key: string) => {
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
};
const safeWrite = (key: string, value: string) => {
  try {
    value ? sessionStorage.setItem(key, value) : sessionStorage.removeItem(key);
  } catch {
    /* Storage can be unavailable in private browsers. */
  }
};
const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
const newId = () => crypto.randomUUID();

function MarkdownReference({
  href,
  children,
}: {
  href?: string;
  children: ReactNode;
}) {
  // Worker file paths refer to the worker's filesystem, not a browser route.
  // Only verified artifact cards may fetch files from this workspace.
  let webUrl: URL | undefined;
  try {
    const parsed = new URL(href ?? "");
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      webUrl = parsed;
    }
  } catch {
    // Relative paths and bare labels remain text.
  }
  return webUrl ? (
    <a href={webUrl.href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

export function TaskMarkdown({
  text,
  tasks,
  chatName,
  onOpen,
}: {
  text: string;
  tasks: Task[];
  chatName: (id: string) => string;
  onOpen: (task: Task) => void;
}) {
  return (
    <div className="markdown">
      <ReactMarkdown
        components={{
          a: ({ children, href }) => (
            <MarkdownReference href={href}>{children}</MarkdownReference>
          ),
          img: ({ src, alt }) => (
            <MarkdownReference href={src}>
              {alt || "Image reference"}
            </MarkdownReference>
          ),
          code: ({ children, className }) => {
            const reference =
              !className &&
              tasks.find((item) => item.id === String(children).trim());
            return reference ? (
              <button
                className="task-reference"
                onClick={() => onOpen(reference)}
                title={`Task ${reference.id}`}
              >
                <MessageSquare size={11} />
                {chatName(reference.chatId)}
                <ArrowRight size={11} />
              </button>
            ) : (
              <code className={className}>{children}</code>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={`mark ${small ? "mark-small" : ""}`} aria-hidden="true">
      <svg
        className="approved-providence-mark"
        viewBox="0 0 64 64"
        fill="none"
        style={{ stroke: "none" }}
      >
        <g fill="currentColor">
          <path d="M3 12 8.5 6.4 9 12Z" />
          <path d="M9.7 6.1 18.9 8.5 11.1 20.5Z" />
          <path d="m12.2 21 8.6-14 9.4 13.8Z" />
          <path d="m22 6.7 11.1-3.5-1.8 17.1Z" />
          <path d="m34.3 3 26.7 5.4-28.5 12Z" />
          <path d="m12.4 22.3 18.6-.2 10.7 16Z" />
          <path d="M21.9 28.9 42.3 39.4 21.9 61Z" />
        </g>
      </svg>
    </span>
  );
}
function DeviceIcon({ device, size = 17 }: { device?: Device; size?: number }) {
  return device?.platform === "win32" ? (
    <Monitor size={size} />
  ) : /phone/i.test(device?.name ?? "") ? (
    <Smartphone size={size} />
  ) : (
    <Laptop size={size} />
  );
}
export function DeviceCapabilities({ device }: { device: Device }) {
  return (
    <div className="capabilities">
      {[
        { key: "files", label: "Files", icon: <File size={15} /> },
        { key: "shell", label: "Shell", icon: <Command size={15} /> },
        { key: "browser", label: "Browser", icon: <Globe size={15} /> },
        {
          key: "desktop",
          label: "Desktop interaction",
          icon: <Monitor size={15} />,
        },
        {
          key: "phoneMirroring",
          label: "iPhone — via Mac",
          icon: <Smartphone size={15} />,
        },
      ].map((cap) => {
        const capabilities = device.capabilities;
        const available = Array.isArray(capabilities)
          ? capabilities.includes(cap.key)
          : capabilities?.[cap.key] === true ||
            (typeof capabilities?.[cap.key] === "object" &&
              (capabilities[cap.key] as { available?: boolean }).available);
        const scopedKind = cap.key === "browser" || cap.key === "desktop";
        const evidence = scopedKind
          ? device.capabilityEvidence?.[cap.key as "browser" | "desktop"]
          : undefined;
        const verified =
          evidence?.status === "verified_scoped" &&
          evidence.requiresApproval === true &&
          evidence.grantsPermission === false;
        return (
          <div
            key={cap.key}
            className={verified ? "has-capability-evidence" : undefined}
          >
            {cap.icon}
            <span>{cap.label}</span>
            <small>
              {verified
                ? "Observed with permission"
                : scopedKind
                  ? "Not verified"
                  : available
                    ? device.online
                      ? "Available"
                      : "Offline"
                    : cap.key === "phoneMirroring"
                      ? "Not verified"
                      : "Unavailable"}
            </small>
            {verified && evidence && (
              <div className="capability-evidence">
                <p>
                  {evidence.scope ??
                    "No specific operation scope was provided."}
                </p>
                {evidence.observedAt && (
                  <time dateTime={evidence.observedAt}>
                    Observed{" "}
                    {new Date(evidence.observedAt).toLocaleString([], {
                      timeZoneName: "short",
                    })}
                  </time>
                )}
                {evidence.taskId && (
                  <span className="capability-evidence-task">
                    Task <code>{evidence.taskId}</code>
                  </span>
                )}
                <p className="capability-approval-note">
                  App approval is required. This evidence does not grant
                  permission.
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Status({ status, label }: { status: string; label?: string }) {
  return (
    <span className={`status status-${status}`}>
      {status === "running" ? (
        <LoaderCircle size={12} className="spin" />
      ) : status === "completed" ? (
        <Square size={10} />
      ) : status === "needs_input" ? (
        <CircleHelp size={12} />
      ) : (
        <span className="status-dot" />
      )}
      {label ?? statusLabel(status)}
    </span>
  );
}
function Empty({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty-small">
      <span>{icon}</span>
      <h4>{title}</h4>
      <p>{children}</p>
    </div>
  );
}

export function HostedSignIn() {
  return <main className="login"><div className="login-top"><Mark /><span>PROVIDENCE</span><ThemeToggle /></div>
    <section className="login-content"><h1>Sign in to Providence</h1><p className="login-intro">Continue with your Providence passkey. API keys are entered privately in the setup terminal.</p>
      <a className="button primary" href="/account">Sign in with a passkey <ArrowRight size={16} /></a><p><a href="/privacy">Privacy and data use</a></p>
    </section></main>;
}
export function AIProcessingNotice() {
  return <section className="ai-processing-notice" role="status"><p>Before sending a message or using voice, review how OpenAI processes your data.</p><a className="button" href="/account#ai-processing">Review in Account</a></section>;
}
function Login({ onConnect }: { onConnect: (token: string) => void }) {
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function connect(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const normalizedCode = value.replace(/[\s-]/g, "");
    const isClientCode = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{12}$/i.test(normalizedCode);
    try {
      const credential = isClientCode
        ? (await exchangeClientCode(normalizedCode)).token
        : value.trim();
      await api(credential, "/devices");
      onConnect(credential);
    } catch (error) {
      setError(
        !isClientCode && error instanceof ApiError && error.status === 401
          ? "That access key was not recognized. Check the key for this coordinator."
          : messageOf(error),
      );
    } finally {
      setLoading(false);
    }
  }
  return (
    <main className="login">
      <div className="login-top">
        <Mark />
        <span>PROVIDENCE</span>
        <ThemeToggle />
      </div>
      <section className="login-content">
        <div className="eyebrow">PRIVATE WORKSPACE</div>
        <h1>
          Open your
          <br />
          workspace.
        </h1>
        <p className="login-intro">
          Continue work across your connected computers and project
          conversations.
        </p>
        <form onSubmit={connect}>
          <label htmlFor="access-key">Workspace access key</label>
          <p className="login-code-hint" id="access-key-hint">
            Use your access key or one-use client code.
          </p>
          <div className="key-field">
            <LockKeyhole size={17} />
            <input
              id="access-key"
              type="password"
              autoComplete="off"
              aria-describedby="access-key-hint"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Enter your key or one-use code"
              required
              autoFocus
            />
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button
            className="button primary login-button"
            disabled={!value.trim() || loading}
          >
            {loading ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <>
                Open workspace
                <ArrowRight size={17} />
              </>
            )}
          </button>
        </form>
        <p className="login-note">
          <ShieldCheck size={14} /> Your access key stays in this browser
          session.
        </p>
        <details className="setup-note">
          <summary>Connecting for the first time</summary>
          <p>
            Use the client access key from your coordinator’s private
            configuration. Open the coordinator’s HTTPS address on your other
            devices to use this same workspace.
          </p>
        </details>
      </section>
      <div className="login-footer">
        PROVIDENCE <span>Your connected workspace</span>
      </div>
      <div className="login-lines" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
    </main>
  );
}

function ArtifactCard({
  artifact,
  token,
  onError,
}: {
  artifact: Artifact;
  token: string;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    url?: string;
    text?: string;
  } | null>(null);
  useEffect(
    () => () => {
      if (preview?.url) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  async function open(download: boolean) {
    setBusy(true);
    try {
      const blob = await artifactBlob(token, artifact.id);
      if (download) {
        downloadBlob(blob, artifact.name);
      } else if (
        (artifact.mime ?? artifact.mimeType ?? "").startsWith("image/")
      ) {
        setPreview({ url: URL.createObjectURL(blob) });
      } else {
        setPreview({ text: (await blob.text()).slice(0, 100_000) });
      }
    } catch (error) {
      onError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }
  const canPreview =
    /^(text\/|image\/)|json|javascript|xml/.test(
      artifact.mime ?? artifact.mimeType ?? "",
    ) || /\.(md|txt|csv|json|html|css|js|ts|py)$/i.test(artifact.name);
  return (
    <>
      <div className="artifact-card">
        <div className="artifact-file">
          <FileText size={18} />
        </div>
        <div className="artifact-info">
          <button
            className="text-link"
            disabled={!canPreview || busy}
            onClick={() => void open(false)}
          >
            {artifact.name}
          </button>
          <small>
            {artifact.revision ? `Revision ${artifact.revision} · ` : ""}
            {fileSize(artifact.size)} · Verified snapshot
          </small>
        </div>
        <button
          className="icon-button"
          aria-label={`Download ${artifact.name}${artifact.revision ? ` revision ${artifact.revision}` : ""}`}
          title={`Download verified file${artifact.revision ? ` · revision ${artifact.revision}` : ""}`}
          disabled={busy}
          onClick={() => void open(true)}
        >
          {busy ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <ArrowDownToLine size={16} />
          )}
        </button>
      </div>
      {preview && (
        <Modal title={artifact.name} onClose={() => setPreview(null)} wide>
          {preview.url ? (
            <img
              className="artifact-preview-image"
              src={preview.url}
              alt={artifact.name}
            />
          ) : (
            <pre className="artifact-preview-text">{preview.text}</pre>
          )}
          <div className="modal-footer">
            <span className="small muted">
              Verified file snapshot
              {artifact.revision ? ` · revision ${artifact.revision}` : ""}
            </span>
            <button className="button" onClick={() => void open(true)}>
              <ArrowDownToLine size={15} />
              Download
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function RequestText({
  text,
  className,
  maxChars = 700,
}: {
  text: string;
  className?: string;
  maxChars?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const excerpt = text.split("\n").slice(0, 7).join("\n").slice(0, maxChars);
  const shortened = excerpt.length < text.length;
  return (
    <div className="request-text" data-collapsed={shortened && !expanded}>
      <p className={className}>
        {expanded || !shortened ? text : `${excerpt.trimEnd()}…`}
      </p>
      {shortened && (
        <button
          className="expand-request"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show full request"}
          <ChevronDown size={11} className={expanded ? "expanded" : ""} />
        </button>
      )}
    </div>
  );
}

function ArtifactStack({
  artifacts,
  allArtifacts,
  tasks,
  token,
  onError,
  onOpenTask,
}: {
  artifacts: Artifact[];
  allArtifacts: Artifact[];
  tasks: Task[];
  token: string;
  onError: (message: string) => void;
  onOpenTask: (task: Task) => void;
}) {
  if (!artifacts.length) return null;
  return (
    <div className="artifact-stack">
      {groupArtifacts(artifacts).map((revisions) => {
        const current = revisions[0];
        const newest = newestArtifact(current, allArtifacts);
        const newerTask =
          newest.id !== current.id &&
          (newest.revision ?? 0) > (current.revision ?? 0)
            ? tasks.find((task) => task.id === newest.taskId)
            : undefined;
        return (
          <div className="artifact-revisions" key={current.id}>
            <ArtifactCard artifact={current} token={token} onError={onError} />
            {newerTask && (
              <button
                className="newer-revision"
                onClick={() => onOpenTask(newerTask)}
              >
                <ArrowRight size={12} />
                Revision {newest.revision} is available in a later turn
              </button>
            )}
            {revisions.length > 1 && (
              <details className="older-revisions">
                <summary>
                  {revisions.length - 1} earlier{" "}
                  {revisions.length === 2 ? "revision" : "revisions"}
                  <ChevronDown size={11} />
                </summary>
                {revisions.slice(1).map((artifact) => (
                  <ArtifactCard
                    key={artifact.id}
                    artifact={artifact}
                    token={token}
                    onError={onError}
                  />
                ))}
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DependencyLink({
  task,
  tasks,
  chatName,
  onOpen,
}: {
  task: Pick<Task, "status" | "afterTaskId">;
  tasks: Task[];
  chatName: (id: string) => string;
  onOpen: (id: string) => Promise<void>;
}) {
  if (task.status !== "queued" || !task.afterTaskId) return null;
  const source = tasks.find((candidate) => candidate.id === task.afterTaskId);
  return (
    <button
      className="dependency-link"
      onClick={() => void onOpen(task.afterTaskId!)}
      title={`Source task ${task.afterTaskId}`}
    >
      <Link2 size={12} />
      <span>
        View source task{source ? `: ${chatName(source.chatId)}` : ""}
      </span>
      <ArrowRight size={12} />
    </button>
  );
}

function LinkedWork({
  tasks,
  allArtifacts,
  allTasks,
  token,
  chatName,
  deviceName,
  onInspect,
  onOpen,
  onError,
  onOpenDependency,
}: {
  tasks: Task[];
  allArtifacts: Artifact[];
  allTasks: Task[];
  token: string;
  chatName: (id: string) => string;
  deviceName: (id: string) => string;
  onInspect: (task: Task) => void;
  onOpen: (task: Task) => void;
  onError: (message: string) => void;
  onOpenDependency: (id: string) => Promise<void>;
}) {
  if (!tasks.length) return null;
  const waiting = tasks.filter((task) => task.status === "needs_input").length;
  const working = tasks.filter((task) =>
    ["running", "queued"].includes(task.status),
  ).length;
  const unsettled = tasks.filter((task) =>
    ["failed", "interrupted", "cancelled"].includes(task.status),
  ).length;
  return (
    <section className="linked-work" aria-label="Related work">
      <div className="linked-work-heading">
        <span>Related work</span>
        <small>
          {waiting
            ? `${waiting} ${waiting === 1 ? "request needs" : "requests need"} attention`
            : working
              ? `${working} in progress`
              : unsettled
                ? "Review task status"
                : "Agents finished"}
        </small>
      </div>
      {tasks.map((task) => (
        <div className="linked-work-card" key={task.id}>
          <div className="linked-work-top">
            <button
              onClick={() => onInspect(task)}
              className="linked-work-owner"
            >
              <Monitor size={14} />
              <span>
                {deviceName(task.deviceId)}
                <small>{chatName(task.chatId)}</small>
              </span>
            </button>
            <Status
              status={task.status}
              label={queuedDependencyLabel(task, allTasks, chatName)}
            />
          </div>
          <p className="linked-work-request">{task.prompt}</p>
          <DependencyLink
            task={task}
            tasks={allTasks}
            chatName={chatName}
            onOpen={onOpenDependency}
          />
          <ArtifactStack
            artifacts={task.artifacts ?? []}
            allArtifacts={allArtifacts}
            tasks={allTasks}
            token={token}
            onError={onError}
            onOpenTask={onOpen}
          />
          <button className="open-linked-work" onClick={() => onOpen(task)}>
            <span>
              {task.status === "needs_input"
                ? "Review request"
                : task.text
                  ? "Inspect result"
                  : "Open conversation"}
            </span>
            <ArrowRight size={13} />
          </button>
        </div>
      ))}
    </section>
  );
}

export function ChatHistoryInspection({
  chat,
  history,
  tasks,
  chatName,
  onOpenTask,
}: {
  chat: Chat;
  history: {
    messages: { role: string; text: string; taskId: string }[];
    scope: string;
  };
  tasks: Task[];
  chatName: (id: string) => string;
  onOpenTask: (task: Task) => void;
}) {
  return (
    <section
      className="inline-chat-history"
      aria-label={`Saved history for ${chat.name}`}
    >
      {history.messages.length ? (
        history.messages.map((message, index) => (
          <article key={`${message.taskId}-${index}`}>
            <strong>{message.role === "user" ? "You" : chat.name}</strong>
            <TaskMarkdown
              text={message.text}
              tasks={tasks}
              chatName={chatName}
              onOpen={onOpenTask}
            />
          </article>
        ))
      ) : (
        <p className="detail-note">No Providence-tracked messages yet.</p>
      )}
      <p className="detail-note">{history.scope}</p>
    </section>
  );
}

export function EarlierSuperagentReply({
  task,
  tasks,
  chatName,
  onOpen,
}: {
  task: Task;
  tasks: Task[];
  chatName: (id: string) => string;
  onOpen: (task: Task) => void;
}) {
  return (
    <details className="earlier-superagent-reply">
      <summary>
        <span>Earlier Providence reply</span>
        <time dateTime={task.updatedAt}>{timeLabel(task.updatedAt)}</time>
        <ChevronDown size={12} />
      </summary>
      <p className="historical-reply-note">
        A historical snapshot. The latest device update is shown above.
      </p>
      <TaskMarkdown
        text={task.text}
        tasks={tasks}
        chatName={chatName}
        onOpen={onOpen}
      />
    </details>
  );
}
export function LatestChildUpdates({
  updates,
  allTasks,
  allArtifacts,
  token,
  truncated = false,
  total,
  chatName,
  onOpen,
  onError,
}: {
  updates: ChildUpdate[];
  allTasks: Task[];
  allArtifacts: Artifact[];
  token: string;
  truncated?: boolean;
  total?: number;
  chatName: (id: string) => string;
  onOpen: (id: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  if (!updates.length) return null;
  return (
    <section
      className="latest-child-updates"
      aria-label="Latest delegated work"
    >
      {updates.map((update) => {
        const running = active(update.status);
        return (
          <article
            className="latest-child-card"
            key={update.id}
            data-task-id={update.id}
          >
            {!running && update.text && (
              <div className="latest-child-response">
                <span className="latest-update-kind">Agent response</span>
                {update.textTruncated && (
                  <span className="response-excerpt-label">
                    Response excerpt
                  </span>
                )}
                <TaskMarkdown
                  text={update.text}
                  tasks={allTasks}
                  chatName={chatName}
                  onOpen={(task) => void onOpen(task.id)}
                />
              </div>
            )}
            {!running && (
              <ArtifactStack
                artifacts={update.artifacts ?? []}
                allArtifacts={allArtifacts}
                tasks={allTasks}
                token={token}
                onError={onError}
                onOpenTask={(task) => void onOpen(task.id)}
              />
            )}
            <details className="inline-work">
              <summary>
                <Status
                  status={update.status}
                  label={queuedDependencyLabel(update, allTasks, chatName)}
                />
                <span>
                  {update.deviceName} · {update.chatName}
                </span>
                <time dateTime={update.updatedAt}>
                  {timeLabel(update.updatedAt)}
                </time>
                <ChevronDown size={12} />
              </summary>
              {running && update.text && (
                <div className="latest-child-response">
                  <span className="latest-update-kind">Progress update</span>
                  <TaskMarkdown
                    text={update.text}
                    tasks={allTasks}
                    chatName={chatName}
                    onOpen={(task) => void onOpen(task.id)}
                  />
                </div>
              )}
              {!update.text && (
                <p className="latest-child-pending">
                  {update.status === "needs_input"
                    ? "An input or permission request needs your response before this work can continue."
                    : update.status === "queued"
                      ? (queuedDependencyLabel(update, allTasks, chatName) ??
                        "Waiting to begin.")
                      : update.status === "running"
                        ? "Work is underway on this device."
                        : update.status === "completed"
                          ? "The agent finished without a text response."
                          : "Review the reported task status."}
                </p>
              )}
              {update.progress?.text &&
                update.progress.text !== update.text &&
                (update.progress.kind !== "result" ||
                  !update.text ||
                  update.status !== "completed") && (
                  <div className="child-progress">
                    <span>
                      {update.progress.kind === "tool"
                        ? "Tool update"
                        : update.progress.kind === "waiting_input"
                          ? "Response requested"
                          : "Latest update"}
                    </span>
                    <p>{update.progress.text}</p>
                    <time dateTime={update.progress.updatedAt}>
                      {timeLabel(update.progress.updatedAt)}
                    </time>
                  </div>
                )}
              <DependencyLink
                task={update}
                tasks={allTasks}
                chatName={chatName}
                onOpen={onOpen}
              />
              {running && (
                <ArtifactStack
                  artifacts={update.artifacts ?? []}
                  allArtifacts={allArtifacts}
                  tasks={allTasks}
                  token={token}
                  onError={onError}
                  onOpenTask={(task) => void onOpen(task.id)}
                />
              )}
              {update.artifactsTruncated && (
                <p className="child-updates-coverage">
                  Showing {update.artifacts?.length ?? 0} of{" "}
                  {update.artifactCount ?? "the"} files. Inspect work for all
                  recorded outputs.
                </p>
              )}
              <button
                className="open-latest-child"
                onClick={() => void onOpen(update.id)}
              >
                <span>
                  {update.status === "needs_input"
                    ? "Review request"
                    : "Inspect work"}
                </span>
                <ArrowRight size={13} />
              </button>
            </details>
          </article>
        );
      })}
      {truncated && (
        <p className="child-updates-coverage">
          Showing {updates.length}
          {total ? ` of ${total}` : ""} child updates. Inspect work for the
          recorded details.
        </p>
      )}
    </section>
  );
}

function Modal({
  title,
  onClose,
  wide,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const elements = ref.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
        );
        if (!elements?.length) return;
        const first = elements[0],
          last = elements[elements.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current)
        ) {
          last.focus();
          event.preventDefault();
        } else if (!event.shiftKey && document.activeElement === last) {
          first.focus();
          event.preventDefault();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      before?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

// A busy conversation refuses the key and the button, so the composer says so
// instead of inviting a message it will silently drop.
export const busyComposerNotice =
  "This conversation is working. Your next message can be sent when it finishes.";
export const composerPlaceholder = (
  busy: boolean,
  selected: string,
  chatName?: string,
) =>
  busy
    ? busyComposerNotice
    : selected === "master"
      ? "Tell Providence what to do…"
      : `Message ${chatName ?? "this conversation"}…`;
export function ComposerSend({
  busy,
  sending,
  disabled,
}: {
  busy: boolean;
  sending: boolean;
  disabled: boolean;
}) {
  return (
    <button
      type="submit"
      className="send-button"
      aria-label="Send message"
      title={busy ? busyComposerNotice : undefined}
      disabled={disabled || busy}
    >
      {sending ? (
        <LoaderCircle size={17} className="spin" />
      ) : (
        <ArrowUp size={19} />
      )}
    </button>
  );
}

export function InlineDecisions({
  approvals,
  tasks,
  deviceName,
  chatName,
  onResolve,
}: {
  approvals: Approval[];
  tasks: Task[];
  deviceName: (id: string) => string;
  chatName: (id: string) => string;
  onResolve: (id: string, body: unknown) => Promise<void>;
}) {
  return (
    <>
      {approvals.map((approval) => (
        <details
          className="inline-work inline-approval"
          key={approval.id}
          // A lone pending decision is the one thing the conversation waits on,
          // so it opens answered-ready; several would bury the transcript.
          open={approvals.length === 1 && approval.status === "pending"}
        >
          <summary>
            <CircleHelp size={14} />
            <span>
              {approvalRequestLabel(approval)} · {deviceName(approval.deviceId)} ·{" "}
              {chatName(
                tasks.find((task) => task.id === approval.taskId)?.chatId ??
                  "master",
              )}
            </span>
            <ChevronDown size={12} />
          </summary>
          <ApprovalCard
            approval={approval}
            task={tasks.find((task) => task.id === approval.taskId)}
            deviceName={deviceName(approval.deviceId)}
            onResolve={onResolve}
          />
        </details>
      ))}
    </>
  );
}

export default function App() {
  const [token, setToken] = useState(() => safeRead(SESSION));
  useEffect(() => {
    if (!token) return;
    return startActivityReporting({ send: (body, keepalive = false) => fetch("/v1/activity", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), credentials: sessionCredentials(token), mode: "same-origin", redirect: "error",
      cache: "no-store", keepalive, signal: AbortSignal.timeout(5000),
    }) });
  }, [token]);
  const [hosted, setHosted] = useState(false);
  const [aiConsentRequired, setAiConsentRequired] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/auth/session", { signal: controller.signal, credentials: "same-origin" }).then(r => r.ok ? r.json() : null).then(session => {
      if (!session?.hosted || controller.signal.aborted) return;
      setHosted(true);
      setAiConsentRequired(session.aiConsentRequired === true);
      if (!session.authenticated || !session.keyConfigured) { window.location.replace("/account"); return; }
      safeWrite(SESSION, "providence-account-session"); setToken("providence-account-session");
    }).catch(() => {}).finally(() => { if (!controller.signal.aborted) setAuthChecking(false); });
    return () => controller.abort();
  }, []);
  const [view, setView] = useState<WorkspaceView>(() => initialWorkspaceView(typeof window === "undefined" ? "" : window.location.search));
  const [voiceCaptureBusy, setVoiceCaptureBusy] = useState(false);
  const [liveSpeaking, setLiveSpeaking] = useState(false);
  const liveConversation = useRef<LiveConversationHandle>(null);
  const [signingOut, setSigningOut] = useState(false);
  const voiceView = view === "voice";
  function changeView(next: WorkspaceView) {
    window.history.replaceState(window.history.state, "", workspaceViewUrl(window.location.href, next));
    setView(next);

  }
  const [voiceState, setVoiceState] = useState<VoiceConfigState>(noVoiceConfig);
  const voiceConfig = voiceState.config;
  const [transcriptionAvailability, setTranscriptionAvailability] = useState<TranscriptionAvailability | null>(null);
  const [voiceConfigLoading, setVoiceConfigLoading] = useState(true);
  useEffect(() => {
    setVoiceState(noVoiceConfig);
    setTranscriptionAvailability(null);
    setVoiceConfigLoading(!!token);
    if (!token) return;
    let active = true,
      inFlight = false;
    let current: AbortController | undefined;
    const refreshConfig = async () => {
      if (!active || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      const controller = new AbortController();
      current = controller;
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const [output, input] = await Promise.allSettled([
          loadVoiceConfig(token, controller.signal),
          loadTranscriptionAvailability(token, controller.signal),
        ]);
        if (active && !controller.signal.aborted) {
          setVoiceState(previous => output.status === "fulfilled"
            ? voiceConfigAfterLookup(previous, output.value)
            : voiceConfigAfterFailedLookup(previous, output.reason instanceof ApiError && output.reason.status === 401));
          setTranscriptionAvailability(input.status === "fulfilled" ? input.value : null);
        }
      } catch (error) {
        if (active) {
          setVoiceState(previous => voiceConfigAfterFailedLookup(previous, error instanceof ApiError && error.status === 401));
          setTranscriptionAvailability(null);
        }
      } finally {
        clearTimeout(timeout);
        if (current === controller) current = undefined;
        inFlight = false;
        if (active) setVoiceConfigLoading(false);
      }
    };
    void refreshConfig();
    const timer = setInterval(() => void refreshConfig(), 15000);
    const resume = () => void refreshConfig();
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      active = false;
      current?.abort();
      clearInterval(timer);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [token]);
  const voiceConfigurationKey = voiceConfigurationIdentity(voiceConfig);
  const voiceQueueSupported = voiceConfig?.admissionQueue?.supported === true;
  const liveVoiceInput = useMemo(() => voiceConfig?.liveTranscription?.available
    ? createLiveVoiceAdapter(token, voiceConfig.liveTranscription) : undefined,
  [token, voiceConfigurationKey]);
  const transcriptionHost = voiceConfig?.deviceId ?? "";
  const transcribeRecording = useCallback(
    (blob: Blob, signal: AbortSignal) =>
      transcribeVoice(token, transcriptionHost, blob, signal),
    [token, transcriptionHost],
  );
  const speechPlayer = useMemo(
    () => createVoiceSpeechPlayer(token),
    [token, voiceConfigurationKey],
  );
  useEffect(() => () => speechPlayer.clear(), [speechPlayer]);
  const speakResponse = useCallback(
    (text: string, signal: AbortSignal, reply?: SpeechReplyIdentity) =>
      speechPlayer.play(
        reply
          ? `${reply.contextKey}:${reply.id}:${reply.updatedAt ?? ""}`
          : text,
        text,
        signal,
        reply?.onAudioState,
      ),
    [speechPlayer],
  );
  const [hostProofAction, setHostProofAction] = useState(() =>
    typeof window !== "undefined"
      ? hostProofActionForHash(window.location.hash)
      : undefined,
  );
  useEffect(() => {
    const update = () =>
      setHostProofAction(hostProofActionForHash(window.location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const [chats, setChats] = useState<Chat[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [events, setEvents] = useState<Activity[]>([]);
  const [selected, setSelected] = useState(() => initialSelectedChat());
  const [selectedTask, setSelectedTask] = useState("");
  const [selectedDevice, setSelectedDevice] = useState("");
  const [inspectedChatId, setInspectedChatId] = useState("");
  const [inspectedHistory, setInspectedHistory] = useState<{
    messages: { role: string; text: string; taskId: string }[];
    scope: string;
  } | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [draft, setDraft] = useState("");
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [showSources, setShowSources] = useState(false);
  const [showNewChat, setShowNewChat] = useState(false);
  const [showPair, setShowPair] = useState(false);
  const [revokeDevice, setRevokeDevice] = useState<Device | null>(null);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<"tasks" | "activity">("tasks");
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const submissionInFlight = useRef(false);
  const [pending, setPending] = useState<Envelope | null>(() => {
    try {
      return JSON.parse(safeRead(PENDING) || "null");
    } catch {
      return null;
    }
  });
  const [voiceReceipts, setVoiceReceipts] = useState<Array<{ task: { id: string; requestId: string; chatId: string }; transcript: string }>>([]);
  const voiceReceiptToken = useRef(token);
  voiceReceiptToken.current = token;
  useEffect(() => setVoiceReceipts([]), [token]);
  function rememberVoiceReceipt(request: Envelope, task: Task) {
    if (token !== voiceReceiptToken.current || !request.voice || !requestMatchesTask(request, task)) return;
    setVoiceReceipts(previous => previous.some(receipt => receipt.task.id === task.id) ? previous : [...previous,
      { task: { id: task.id, requestId: task.requestId, chatId: task.chatId }, transcript: request.text }]);
  }
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [outputPath, setOutputPath] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [focusTaskId, setFocusTaskId] = useState("");
  const eventSequence = useRef(0);
  const firstSync = useRef(true);
  const polling = useRef(false);
  const pollRound = useRef<{
    controller: AbortController;
    startedAt: number;
  } | null>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const shouldScroll = useRef(true);
  const scrollLanding = useRef(new WorkspaceScrollLanding());
  const [historyWindow, setHistoryWindow] = useState<{ chatId: string; oldestId?: string }>({ chatId: "" });
  const historyAnchor = useRef<{ chatId: string; height: number; top: number } | null>(null);
  const chat = chats.find((c) => c.id === selected);
  const device = devices.find((d) => d.id === chat?.deviceId);
  const targetIssue = destinationIssue(selected, chats, devices, connected);
  const currentTranscriptionAvailability = reconcileTranscriptionAvailability(transcriptionAvailability, devices);
  const transcriptionReady = configuredTranscriptionRoute(voiceConfig, currentTranscriptionAvailability).ready;
  const visibleTasks = tasks
    .filter((t) => t.chatId === selected)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const renderedHistory = conversationWindow(visibleTasks, historyWindow.chatId === selected ? historyWindow.oldestId : undefined, focusTaskId);
  const hasConversationHistory = visibleTasks.length > 0 || (inspectedChatId === selected && !!inspectedHistory?.messages.length);
  useLayoutEffect(() => {
    const first = renderedHistory.items[0]?.id;
    if (first && (historyWindow.chatId !== selected || historyWindow.oldestId !== first))
      setHistoryWindow({ chatId: selected, oldestId: first });
  }, [selected, renderedHistory.items[0]?.id]);
  const latestTask = visibleTasks.at(-1);
  const latestChildScrollKey = latestTask
    ? childUpdatesFor(latestTask, tasks, chats, devices)
        .map(
          (update) =>
            `${update.id}:${update.status}:${update.text.length}:${update.progress?.text.length ?? 0}`,
        )
        .join("|")
    : "";
  const busy = visibleTasks.some((t) => active(t.status));
  const voiceOutcomes = selectedVoiceOutcomes(selected, tasks);
  const workerTasks = tasks.filter((t) => t.chatId !== "master");
  const allArtifacts = tasks.flatMap((task) => [
    ...(task.artifacts ?? []),
    ...(task.childUpdates?.flatMap((update) => update.artifacts ?? []) ?? []),
  ]);
  const taskDetail = tasks.find((t) => t.id === selectedTask);
  const deviceDetail = devices.find((d) => d.id === selectedDevice);
  const inspectedChat = chats.find((chat) => chat.id === inspectedChatId);
  const chatDecisions = reachableApprovals(selected, tasks, approvals);
  const decisionPending = blockingApprovals(selected, tasks, approvals).length > 0;
  const pendingDecisions = taskDecisions(
    approvals,
    chatDecisions,
    taskDetail?.id,
  );
  const onlineCount = devices.filter((d) => d.online).length;
  const deviceName = (id: string) =>
    id === "coordinator"
      ? "Providence"
      : (devices.find((d) => d.id === id)?.name ?? "Disconnected computer");
  const chatName = (id: string) =>
    id === "master"
      ? "Providence"
      : (chats.find((c) => c.id === id)?.name ?? "Registered conversation");

  const refresh = useCallback(async () => {
    if (!token) return;
    if (polling.current) {
      // A round still in flight past its own request budget cannot settle on
      // its own, and every later tick would queue behind it.
      if (
        pollRound.current &&
        Date.now() - pollRound.current.startedAt > REQUEST_TIMEOUT_MS
      )
        pollRound.current.controller.abort();
      return;
    }
    polling.current = true;
    const round = {
      controller: new AbortController(),
      startedAt: Date.now(),
    };
    pollRound.current = round;
    try {
      const signal = round.controller.signal;
      const [briefing, allChats, allTasks, activity] = await Promise.all([
        api<Briefing>(token, "/briefing", undefined, undefined, signal),
        api<{ chats: Chat[] }>(token, "/chats", undefined, undefined, signal),
        api<{ tasks: Task[] }>(token, "/tasks", undefined, undefined, signal),
        api<{
          events: Activity[];
          latestSequence: number;
          oldestSequence?: number;
        }>(
          token,
          `/events?after=${eventSequence.current}`,
          undefined,
          undefined,
          signal,
        ),
      ]);
      validateWorkspaceResponse(briefing, allChats, allTasks, activity);
      setDevices(briefing.devices);
      setApprovals(briefing.approvals);
      setChats(allChats.chats);
      setTasks(allTasks.tasks);
      // Events the server has already dropped can never arrive, so the kept feed restarts instead of showing a hole.
      const gap =
        activity.oldestSequence !== undefined &&
        eventSequence.current < activity.oldestSequence - 1;
      if (gap && !activity.events.length) setEvents([]);
      if (activity.events.length)
        setEvents((previous) => {
          const byId = new Map(
            [...(gap ? [] : previous), ...activity.events].map((e) => [
              e.sequence,
              e,
            ]),
          );
          return [...byId.values()]
            .sort((a, b) => a.sequence - b.sequence)
            .slice(-100);
        });
      eventSequence.current = activity.latestSequence;
      setConnected(true);
    } catch (error) {
      setConnected(false);
      if (error instanceof ApiError && error.status === 401) {
        safeWrite(SESSION, "");
        setToken("");
        if (token === HOSTED_ACCOUNT_SESSION) window.location.replace("/account");
        else setError("Your access key is no longer valid.");
      } else if (firstSync.current) setError(messageOf(error));
    } finally {
      firstSync.current = false;
      setLoading(false);
      polling.current = false;
      if (pollRound.current === round) pollRound.current = null;
    }
    // Reading the first sync through a ref keeps one round per tick: a
    // dependency on the loading state rebuilds this and starts a second round.
  }, [token]);
  useEffect(() => {
    if (!token) return;
    firstSync.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 1500);
    const resume = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [token, refresh]);
  useLayoutEffect(() => {
    const element = conversation.current;
    const visible = !!element && element.clientHeight > 0;
    if (visible && element && historyAnchor.current?.chatId === selected) {
      const anchor = historyAnchor.current;
      historyAnchor.current = null;
      element.scrollTop = restoredHistoryScroll(anchor.height, anchor.top, element.scrollHeight);
      return;
    }
    const landing = scrollLanding.current.update(selected, visible, !loading && hasConversationHistory);
    if (landing) shouldScroll.current = true;
    if (visible && element && shouldScroll.current)
      element.scrollTo({
        top: hasConversationHistory ? element.scrollHeight : 0,
        // Polling and content growth follow immediately; smooth motion is only
        // for explicit user navigation, never a repeatedly restarted animation.
        behavior: "auto",
      });
  }, [
    visibleTasks.length,
    latestTask?.text,
    latestTask?.status,
    latestChildScrollKey,
    selected,
    voiceView,
    loading,
    token,
    inspectedChatId,
    inspectedHistory?.messages.length,
    historyWindow,
    hasConversationHistory,
  ]);
  useEffect(() => {
    const element = conversation.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (shouldScroll.current && element.clientHeight > 0)
        element.scrollTo({ top: hasConversationHistory ? element.scrollHeight : 0, behavior: "auto" });
    });
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [voiceView, selected, token, hasConversationHistory]);
  useEffect(() => {
    safeWrite(SELECTED, "");
    setSourceIds([]);
    setShowSources(false);
    shouldScroll.current = true;
  }, [selected]);
  useEffect(() => {
    if (!focusTaskId) return;
    shouldScroll.current = false;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(
          focusTaskId === "inspection"
            ? "inline-inspection"
            : `turn-${focusTaskId}`,
        )
        ?.scrollIntoView({ block: "start", behavior: workspaceScrollBehavior(false, window.matchMedia("(prefers-reduced-motion: reduce)").matches) });
      setFocusTaskId("");
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, focusTaskId]);
  useEffect(() => {
    if (!taskDetail || !token) {
      setArtifacts([]);
      return;
    }
    let cancelled = false;
    setArtifacts(taskDetail.artifacts ?? []);
    void api<{ artifacts: Artifact[] }>(
      token,
      `/tasks/${taskDetail.id}/artifacts`,
    )
      .then((result) => {
        if (!cancelled) setArtifacts(result.artifacts);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [taskDetail?.id, taskDetail?.updatedAt, token]);
  useEffect(() => {
    const confirmed = pending && tasks.find(task => requestMatchesTask(pending, task));
    if (pending && confirmed) {
      rememberVoiceReceipt(pending, confirmed);
      setDraft((current) => (current.trim() === pending.text ? "" : current));
      setPending(null);
      safeWrite(PENDING, "");
    }
  }, [tasks, pending]);
  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = "auto";
    textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 180)}px`;
  }, [draft]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        textarea.current?.focus();
      }
      if (event.key === "Escape") {
        setChatMenuOpen(false);
        setDetailsOpen(false);
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);

  useEffect(() => {
    if (!chatMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        !event.target.closest(".app-navigation, .navigation-toggle")
      )
        setChatMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [chatMenuOpen]);

  useEffect(() => {
    if (!inspectedChatId || !token) {
      setInspectedHistory(null);
      return;
    }
    let cancelled = false;
    setInspectedHistory(null);
    setHistoryError("");
    void api<{
      messages: { role: string; text: string; taskId: string }[];
      scope: string;
    }>(token, `/chats/${encodeURIComponent(inspectedChatId)}/context`)
      .then((value) => {
        if (!cancelled) setInspectedHistory(value);
      })
      .catch((error) => {
        if (!cancelled) setHistoryError(messageOf(error));
      });
    return () => {
      cancelled = true;
    };
  }, [inspectedChatId, token]);
  function inspectChat(id: string) {
    setInspectedChatId(id);
    setSelectedTask("");
    setSelectedDevice("");
    setDetailsOpen(true);
    setChatMenuOpen(false);
    setFocusTaskId("inspection");
  }
  function findChatInMenu(id: string) {
    selectChat(id);
  }
  function selectChat(id: string) {
    if (voiceCaptureBusy) return;
    setInspectedChatId("");
    setDetailsOpen(false);
    setDraft("");
    setSelected((current) =>
      selectedChatAfter(current, { kind: "user_selected_chat", chatId: id }),
    );
    setChatMenuOpen(false);

    setSelectedDevice("");
    setSelectedTask("");
  }
  function openResult(task: Task) {
    inspectTask(task);
  }
  async function openDependency(taskId: string) {
    try {
      const task =
        tasks.find((candidate) => candidate.id === taskId) ??
        (await api<Task>(token, `/tasks/${encodeURIComponent(taskId)}`));
      setTasks((previous) =>
        previous.some((candidate) => candidate.id === task.id)
          ? previous
          : [...previous, task],
      );
      openResult(task);
    } catch (error) {
      setError(messageOf(error));
    }
  }
  function inspectTask(task: Task) {
    setInspectedChatId("");
    setSelectedTask(task.id);
    setSelectedDevice("");
    setDetailsOpen(true);
    setDetailTab("tasks");
    setFocusTaskId("inspection");
  }
  async function send(envelope?: Envelope) {
    if (hosted && aiConsentRequired) { setError("Allow OpenAI processing in Account before sending messages or using voice."); return; }
    const request = envelope ?? {
      requestId: newId(),
      text: draft.trim(),
      chatId: selected,
      sourceChatIds: selected === "master" ? [] : sourceIds,
    };
    if (!request.text || submissionInFlight.current) return;
    if (pending) {
      setError("Check the unconfirmed delivery before sending another request.");
      return;
    }
    submissionInFlight.current = true;
    setSending(true);
    setError("");
    setPending(request);
    safeWrite(PENDING, JSON.stringify(request));
    try {
      const task = await submitToDestination(token, request, { connected, chats, devices, tasks, approvals, queueSupported: voiceQueueSupported });
      rememberVoiceReceipt(request, task);
      setTasks((previous) => [
        ...previous.filter((t) => t.id !== task.id),
        task,
      ]);
      setDraft("");
      setSourceIds([]);
      setPending(null);
      safeWrite(PENDING, "");
      shouldScroll.current = true;
      await refresh();
      return task;
    } catch (error) {
      setError(messageOf(error));
      if (error instanceof ApiError && error.errorCode === "ai_consent_required") setAiConsentRequired(true);
      if (error instanceof MessageNotSentError || (error instanceof ApiError && error.status < 500)) {
        setPending(null);
        safeWrite(PENDING, "");
      }
    } finally {
      submissionInFlight.current = false;
      setSending(false);
    }
  }
  async function checkDelivery() {
    if (!pending || submissionInFlight.current) return;
    submissionInFlight.current = true;
    setSending(true);
    try {
      const task = await findRequestDelivery(token, pending);
      if (task) {
        setTasks((previous) => [...previous.filter((value) => value.id !== task.id), task]);
        setError("");
      } else setError("Delivery is still unconfirmed. Nothing was sent again; check after reconnecting.");
      await refresh();
    } catch (error) {
      setError(messageOf(error));
    } finally {
      submissionInFlight.current = false;
      setSending(false);
    }
  }
  async function cancel(task: Task) {
    try {
      await api(token, `/tasks/${task.id}/cancel`, {});
      await refresh();
    } catch (error) {
      setError(messageOf(error));
    }
  }
  async function resolveApproval(id: string, body: unknown) {
    try {
      await api(token, `/approvals/${encodeURIComponent(id)}`, body);
    } finally {
      await refresh();
    }
  }
  async function publishOutput(event: FormEvent) {
    event.preventDefault();
    if (!taskDetail) return;
    setPublishing(true);
    try {
      await api(token, `/tasks/${taskDetail.id}/artifacts`, {
        path: outputPath.trim(),
      });
      const result = await api<{ artifacts: Artifact[] }>(
        token,
        `/tasks/${taskDetail.id}/artifacts`,
      );
      setArtifacts(result.artifacts);
      setOutputPath("");
      await refresh();
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setPublishing(false);
    }
  }
  async function logout() {
    if (signingOut) return;
    setSigningOut(true);
    setChatMenuOpen(false);
    liveConversation.current?.end();
    changeView("workspace");
    if (hosted) {
      try {
        const response = await fetch("/auth/logout", { method: "POST", credentials: "same-origin", mode: "same-origin", referrerPolicy: "same-origin", redirect: "error", signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error();
        safeWrite(SESSION, ""); safeWrite(PENDING, "");
        window.location.assign("/account");
      } catch {
        setError("Could not sign out. Check your connection and try again.");
        setSigningOut(false);
      }
      return;
    }
    safeWrite(SESSION, ""); safeWrite(PENDING, "");
    setToken(""); setTasks([]); setChats([]); setEvents([]);
    setPending(null); setConnected(false); eventSequence.current = 0;
    setSigningOut(false);
  }
  function openDeviceSetup() {
    if (isHostedDeviceSetup(token, hosted)) window.location.assign("/account#devices");
    else setShowPair(true);
  }
  const closeNewChat = useCallback(() => setShowNewChat(false), []);
  const closePair = useCallback(() => setShowPair(false), []);
  const closeRevoke = useCallback(() => setRevokeDevice(null), []);

  if (!token && authChecking) return <div className="loading-state"><Mark /><p>Opening Providence…</p></div>;
  if (!token && isHostedDeviceSetup(token, hosted)) return <HostedSignIn />;
  if (!token)
    return (
      <Login
        onConnect={(key) => {
          safeWrite(SESSION, key);
          setToken(key);
          setLoading(true);
          setError("");
        }}
      />
    );
  if (hostProofAction)
    return (
      <HostBridgeProof
        key={hostProofAction}
        action={hostProofAction}
        token={token}
        onBack={() => {
          window.location.hash = "";
          setHostProofAction(undefined);
        }}
        onLock={logout}
      />
    );
  return (
    <div className={`workspace single-chat-layout product-shell${voiceView ? " voice-active" : ""}`}>
      <AppNavigation open={chatMenuOpen} close={() => setChatMenuOpen(false)} selected={selected}
        chats={chats} select={selectChat} newChat={() => devices.length ? setShowNewChat(true) : openDeviceSetup()} devices={openDeviceSetup}
        activity={() => { setInspectedChatId(""); setSelectedTask(""); setSelectedDevice(""); setDetailsOpen(true); setFocusTaskId("inspection"); }}
        deviceName={deviceName} hosted={hosted} online={onlineCount} logout={() => void logout()} signingOut={signingOut} />
      <main className="main-panel" data-selected-chat={selected}>
        <header className="topbar product-topbar">
          <button className="icon-button navigation-toggle" aria-label="Open navigation" aria-controls="app-navigation" aria-expanded={chatMenuOpen} onClick={() => setChatMenuOpen(!chatMenuOpen)}><Menu size={22} /></button>
          <div className="chat-heading"><strong>{selected === "master" ? "Providence" : chat?.name ?? "Chat"}</strong><span>{selected === "master" ? "Your devices. One conversation." : deviceName(chat?.deviceId ?? "")}</span></div>
          <div className="product-header-actions">
            <button className="device-status" onClick={openDeviceSetup}><span className={`connection-dot ${onlineCount ? "online" : ""}`} />{onlineCount} {onlineCount === 1 ? "device" : "devices"} online</button>
            <ThemeToggle />
            {hosted && <a href="/account" className="icon-button header-account" aria-label="Account"><UserRound size={20} /></a>}
          </div>
        </header>
        {hosted && aiConsentRequired && <AIProcessingNotice />}
        {selected !== "master" && (
          <div className="conversation-heading">
            <div>
              <button
                className="text-link"
                onClick={() => selectChat("master")}
              >
                <ArrowLeft size={12} />
                Return to Providence
              </button>
              <h1>{chat?.name ?? "Chat"}</h1>
              <p>
                {deviceName(chat?.deviceId ?? "")} ·{" "}
                {deviceConnectionLabel(device, connected)}
              </p>
            </div>
            {chat && (
              <RenameChat
                chat={chat}
                token={token}
                onSaved={refresh}
                onError={setError}
              />
            )}
          </div>
        )}
        {!connected && !loading && (
          <div className="connection-banner" role="status">
            <RefreshCw size={14} />
            <span>
              Live updates are unavailable. Work may still be running.
              Reconnecting automatically.
            </span>
            <button onClick={() => void refresh()}>Retry now</button>
          </div>
        )}
        <div
          className="conversation-scroll"
          ref={conversation}
          onScroll={() => {
            const el = conversation.current;
            if (el)
              shouldScroll.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 130;
          }}
        >
          <div className="conversation-content">
            {loading && !visibleTasks.length ? (
              <div className="loading-state">
                <LoaderCircle className="spin" size={22} />
                <p>Opening your workspace…</p>
              </div>
            ) : !visibleTasks.length ? (
              <div className="welcome">
                <Mark />
                <h2>
                  {selected === "master"
                    ? "What can I take care of?"
                    : `A place for ${chat?.name ?? "your next project"}.`}
                </h2>
                <p>
                  {selected === "master"
                    ? "Send a message or start talking. Providence gets things done across your computers."
                    : "Work here keeps its own context. Continue a project, ask for a revision, or bring in context from another conversation."}
                </p>
                {hosted && !devices.length && <div className="welcome-connect"><Monitor size={22} /><div><strong>Connect your first computer</strong><span>One setup on each Mac or Windows PC, then you’re ready.</span></div><button className="button" onClick={openDeviceSetup}>Add a computer <ArrowRight size={15} /></button></div>}
                <div className="suggestions">
                  {(selected === "master"
                    ? [
                        {
                          icon: <Monitor size={16} />,
                          text: "What can my connected devices do?",
                        },
                        {
                          icon: <MessageSquare size={16} />,
                          text: "Give me a briefing on my recent work.",
                        },
                        {
                          icon: <Layers3 size={16} />,
                          text: "Help me start a new project.",
                        },
                      ]
                    : [
                        {
                          icon: <FolderOpen size={16} />,
                          text: "What is in this workspace?",
                        },
                        {
                          icon: <MessageSquare size={16} />,
                          text: "Help me plan the next steps for this project.",
                        },
                      ]
                  ).map((s) => (
                    <button
                      key={s.text}
                      onClick={() => {
                        setDraft(s.text);
                        textarea.current?.focus();
                      }}
                    >
                      {s.icon}
                      <span>{s.text}</span>
                      <ArrowUp size={14} />
                    </button>
                  ))}
                </div>
                <div className="welcome-footnote">
                  <span className="connection-dot online" />
                  {onlineCount} {onlineCount === 1 ? "device" : "devices"}{" "}
                  connected <span>·</span> {chats.length}{" "}
                  {chats.length === 1 ? "conversation" : "conversations"}
                </div>
              </div>
            ) : (
              <div className="message-list">
                {renderedHistory.olderCount > 0 && <div className="history-load-row">
                  <button type="button" className="button" onClick={() => {
                    const element = conversation.current;
                    if (element) historyAnchor.current = { chatId: selected, height: element.scrollHeight, top: element.scrollTop };
                    shouldScroll.current = false;
                    setHistoryWindow({ chatId: selected, oldestId: renderedHistory.previousId });
                  }}>Load older messages <span aria-hidden="true">↑</span></button>
                  <span>{renderedHistory.olderCount} earlier in this loaded history</span>
                </div>}
                {renderedHistory.items.map((task) => (
                  <article
                    className="turn"
                    key={task.id}
                    id={`turn-${task.id}`}
                  >
                    <div className="message user-message">
                      <div className="message-avatar"><UserRound size={16} /></div>
                      <div className="message-body">
                        <div className="message-meta">
                          <strong>You</strong>
                          <time>{timeLabel(task.createdAt)}</time>
                        </div>
                        <RequestText text={task.prompt} className="user-text" />
                        {!!task.sourceChatIds?.length && (
                          <div className="context-chips">
                            <Link2 size={12} />
                            <span>Context from</span>
                            {task.sourceChatIds.map((id) => (
                              <button key={id} onClick={() => inspectChat(id)}>
                                {chatName(id)}
                                <ChevronRight size={11} />
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="message assistant-message">
                      <Mark small />
                      <div className="message-body">
                        <div className="message-meta">
                          <strong>
                            {task.chatId === "master"
                              ? "Providence"
                              : chatName(task.chatId)}
                          </strong>
                          <span>
                            {task.deviceId === "coordinator"
                              ? ""
                              : deviceName(task.deviceId)}
                          </span>
                          <button
                            className="message-inspect"
                            aria-label={`Inspect task ${task.id.slice(0, 8)}`}
                            title="Task details"
                            onClick={() => inspectTask(task)}
                          >
                            <MoreHorizontal size={16} />
                          </button>
                        </div>
                        {task.chatId === "master" &&
                          childUpdatesFor(task, tasks, chats, devices).length >
                            0 && (
                            <LatestChildUpdates
                              updates={childUpdatesFor(
                                task,
                                tasks,
                                chats,
                                devices,
                              )}
                              allTasks={tasks}
                              allArtifacts={allArtifacts}
                              token={token}
                              truncated={task.childUpdatesTruncated}
                              total={task.childUpdateCount}
                              chatName={chatName}
                              onOpen={openDependency}
                              onError={setError}
                            />
                          )}
                        {task.text ? (
                          historicalSuperagentReply(task) ? (
                            <EarlierSuperagentReply
                              task={task}
                              tasks={tasks}
                              chatName={chatName}
                              onOpen={openResult}
                            />
                          ) : (
                            <TaskMarkdown
                              text={task.text}
                              tasks={tasks}
                              chatName={chatName}
                              onOpen={openResult}
                            />
                          )
                        ) : active(task.status) ? (
                          <div className="working-state">
                            <span className="thinking-pips">
                              <i />
                              <i />
                              <i />
                            </span>
                            {task.status === "needs_input"
                              ? "Waiting for your response"
                              : task.status === "queued"
                                ? (queuedDependencyLabel(
                                    task,
                                    tasks,
                                    chatName,
                                  ) ?? "Waiting to begin")
                                : task.chatId === "master"
                                  ? "Coordinating your request"
                                  : `Working on ${deviceName(task.deviceId)}`}
                          </div>
                        ) : (
                          <p className="muted">
                            {task.status === "cancelled"
                              ? "You stopped this task."
                              : task.error
                                ? ""
                                : "This turn ended without a response."}
                          </p>
                        )}
                        <DependencyLink
                          task={task}
                          tasks={tasks}
                          chatName={chatName}
                          onOpen={openDependency}
                        />
                        {task.error && (
                          <div className="task-error">{task.error}</div>
                        )}
                        <ArtifactStack
                          artifacts={task.artifacts ?? []}
                          allArtifacts={allArtifacts}
                          tasks={tasks}
                          token={token}
                          onError={setError}
                          onOpenTask={openResult}
                        />
                        {task.chatId === "master" &&
                          !childUpdatesFor(task, tasks, chats, devices)
                            .length && (
                            <LinkedWork
                              tasks={linkedWork(task, tasks)}
                              allArtifacts={allArtifacts}
                              allTasks={tasks}
                              token={token}
                              chatName={chatName}
                              deviceName={deviceName}
                              onInspect={inspectTask}
                              onOpen={openResult}
                              onOpenDependency={openDependency}
                              onError={setError}
                            />
                          )}

                        <div className="message-footer">
                          <button onClick={() => inspectTask(task)}>
                            <Status
                              status={task.status}
                              label={
                                task.chatId === "master" &&
                                task.status === "completed"
                                  ? "Reply ready"
                                  : queuedDependencyLabel(task, tasks, chatName)
                              }
                            />
                            <ChevronRight size={12} />
                          </button>
                          {task.chatId === "master" && task.workStatus && (
                            <span className="delegation-status">
                              {task.workStatus === "completed"
                                ? "Delegated agents finished"
                                : `Delegated work: ${statusLabel(task.workStatus).toLowerCase()}`}
                            </span>
                          )}
                          {active(task.status) && (
                            <button
                              className="stop-link"
                              onClick={() => void cancel(task)}
                            >
                              <Square size={10} />
                              Stop
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
            <InlineDecisions
              approvals={chatDecisions}
              tasks={tasks}
              deviceName={deviceName}
              chatName={chatName}
              onResolve={resolveApproval}
            />
            {detailsOpen && (
              <details
                className="inline-work inline-task-details"
                id="inline-inspection"
                open
                onToggle={(event) => {
                  if (!event.currentTarget.open) setDetailsOpen(false);
                }}
              >
                <summary>
                  {inspectedChat
                    ? `Chat history · ${inspectedChat.name}`
                    : deviceDetail
                      ? `Device details · ${deviceDetail.name}`
                      : taskDetail
                        ? `Work details · ${chatName(taskDetail.chatId)}`
                        : "Work history"}
                  <ChevronDown size={13} />
                </summary>{" "}
                <header className="details-header">
                  <h2>
                    {inspectedChat
                      ? "Chat history"
                      : deviceDetail
                        ? "Device details"
                        : taskDetail
                          ? "Task details"
                          : "Workspace activity"}
                  </h2>
                  <button
                    className="icon-button"
                    aria-label={
                      taskDetail || deviceDetail
                        ? "Back to activity"
                        : "Close details"
                    }
                    onClick={() => {
                      if (taskDetail || deviceDetail || inspectedChatId) {
                        setInspectedChatId("");
                        setSelectedTask("");
                        setSelectedDevice("");
                      } else setDetailsOpen(false);
                    }}
                  >
                    {taskDetail || deviceDetail ? (
                      <ArrowRight className="rotate" size={17} />
                    ) : (
                      <X size={17} />
                    )}
                  </button>
                </header>
                <div className="details-scroll">
                  {inspectedChat ? (
                    <>
                      <h3 className="detail-title">{inspectedChat.name}</h3>
                      <p className="detail-note">
                        {deviceName(inspectedChat.deviceId)} ·
                        Providence-tracked history
                      </p>
                      {historyError && (
                        <p className="error" role="alert">
                          {historyError}
                        </p>
                      )}
                      {!inspectedHistory && !historyError && (
                        <p className="detail-note">Loading saved context…</p>
                      )}
                      {inspectedHistory && (
                        <ChatHistoryInspection
                          chat={inspectedChat}
                          history={inspectedHistory}
                          tasks={tasks}
                          chatName={chatName}
                          onOpenTask={openResult}
                        />
                      )}
                      <button
                        className="button"
                        onClick={() => findChatInMenu(inspectedChat.id)}
                      >
                        Find this chat in Chats
                      </button>
                    </>
                  ) : deviceDetail ? (
                    <>
                      <div className="device-detail-icon">
                        <DeviceIcon device={deviceDetail} size={28} />
                      </div>
                      <h3 className="detail-title">{deviceDetail.name}</h3>
                      <span
                        className={`device-connection ${deviceDetail.online ? "" : "muted"}`}
                      >
                        <span
                          className={`connection-dot ${deviceDetail.online ? "online" : ""}`}
                        />
                        {deviceConnectionLabel(deviceDetail, connected)}
                      </span>
                      {deviceConnectionDetail(deviceDetail, connected) && (
                        <p>{deviceConnectionDetail(deviceDetail, connected)}</p>
                      )}
                      <dl className="detail-list">
                        <dt>Device ID</dt>
                        <dd className="mono">{deviceDetail.id}</dd>
                        {deviceDetail.platform && (
                          <>
                            <dt>Platform</dt>
                            <dd>
                              {deviceDetail.platform === "darwin"
                                ? "macOS"
                                : deviceDetail.platform === "win32"
                                  ? "Windows"
                                  : deviceDetail.platform}
                            </dd>
                          </>
                        )}
                        {deviceDetail.workspace && (
                          <>
                            <dt>Workspace</dt>
                            <dd className="mono">{deviceDetail.workspace}</dd>
                          </>
                        )}
                      </dl>
                      <h4 className="section-heading">CAPABILITIES</h4>
                      <DeviceCapabilities device={deviceDetail} />
                      <p className="detail-note">
                        Capabilities reflect this Providence connection. Other
                        apps on the device can have separate access.
                      </p>
                      {deviceDetail.local === false && (
                        <button
                          className="button revoke-device"
                          onClick={() => setRevokeDevice(deviceDetail)}
                        >
                          Remove device access
                        </button>
                      )}
                      <h4 className="section-heading">CONVERSATIONS</h4>
                      {chats
                        .filter((c) => c.deviceId === deviceDetail.id)
                        .map((c) => (
                          <button
                            className="detail-chat"
                            key={c.id}
                            onClick={() => {
                              inspectChat(c.id);
                            }}
                          >
                            <MessageSquare size={15} />
                            {c.name}
                            <ChevronRight size={14} />
                          </button>
                        ))}
                    </>
                  ) : taskDetail ? (
                    <>
                      <Status
                        status={taskDetail.status}
                        label={
                          taskDetail.chatId === "master" &&
                          taskDetail.status === "completed"
                            ? "Reply ready"
                            : queuedDependencyLabel(taskDetail, tasks, chatName)
                        }
                      />
                      <DependencyLink
                        task={taskDetail}
                        tasks={tasks}
                        chatName={chatName}
                        onOpen={openDependency}
                      />
                      <RequestText
                        text={taskDetail.prompt}
                        className="task-title"
                        maxChars={280}
                      />
                      {taskDetail.text && (
                        <TaskMarkdown
                          text={taskDetail.text}
                          tasks={tasks}
                          chatName={chatName}
                          onOpen={openResult}
                        />
                      )}
                      <dl className="detail-list">
                        <dt>Conversation</dt>
                        <dd>
                          <button
                            className="text-link"
                            onClick={() => inspectChat(taskDetail.chatId)}
                          >
                            {chatName(taskDetail.chatId)}
                          </button>
                        </dd>
                        <dt>Device</dt>
                        <dd>{deviceName(taskDetail.deviceId)}</dd>
                        <dt>Started</dt>
                        <dd>{timeLabel(taskDetail.createdAt)}</dd>
                        <dt>Last updated</dt>
                        <dd>{timeLabel(taskDetail.updatedAt)}</dd>
                        <dt>Task</dt>
                        <dd className="mono">{taskDetail.id.slice(0, 8)}</dd>
                      </dl>
                      {taskDetail.chatId !== "master" && (
                        <button
                          className="button full-width open-task-conversation"
                          onClick={() => inspectChat(taskDetail.chatId)}
                        >
                          <MessageSquare size={14} />
                          Inspect chat history
                          <ArrowRight size={14} />
                        </button>
                      )}
                      {taskDetail.chatId === "master" && (
                        <LinkedWork
                          tasks={linkedWork(taskDetail, tasks)}
                          allArtifacts={allArtifacts}
                          allTasks={tasks}
                          token={token}
                          chatName={chatName}
                          deviceName={deviceName}
                          onInspect={inspectTask}
                          onOpen={openResult}
                          onOpenDependency={openDependency}
                          onError={setError}
                        />
                      )}
                      {active(taskDetail.status) && (
                        <button
                          className="button full-width"
                          onClick={() => void cancel(taskDetail)}
                        >
                          <Square size={12} />
                          Stop this task
                        </button>
                      )}
                      {pendingDecisions.map((approval) => (
                        <ApprovalCard
                          key={approval.id}
                          approval={approval}
                          task={taskDetail}
                          deviceName={deviceName(approval.deviceId)}
                          onResolve={resolveApproval}
                        />
                      ))}
                      {!!taskDetail.sourceChatIds?.length && (
                        <>
                          <h4 className="section-heading">CONTEXT SOURCES</h4>
                          {taskDetail.sourceChatIds.map((id) => (
                            <button
                              className="context-source"
                              key={id}
                              onClick={() => inspectChat(id)}
                            >
                              <Link2 size={14} />
                              <span>
                                {chatName(id)}
                                <small>Providence-tracked turns</small>
                              </span>
                              <ChevronRight size={13} />
                            </button>
                          ))}
                        </>
                      )}
                      <h4 className="section-heading">
                        OUTPUTS <span>{artifacts.length}</span>
                      </h4>
                      <ArtifactStack
                        artifacts={artifacts}
                        allArtifacts={allArtifacts}
                        tasks={tasks}
                        token={token}
                        onError={setError}
                        onOpenTask={openResult}
                      />
                      {!artifacts.length && (
                        <p className="detail-note">
                          Verified files will appear here. A finished response
                          alone does not verify a file.
                        </p>
                      )}
                      {taskDetail.chatId !== "master" && (
                        <details className="add-output">
                          <summary>
                            <Plus size={13} />
                            Add an output file
                          </summary>
                          <form onSubmit={publishOutput}>
                            <label className="small" htmlFor="output-path">
                              Path in this task’s workspace
                            </label>
                            <input
                              className="input"
                              id="output-path"
                              placeholder="outputs/notes.md"
                              value={outputPath}
                              onChange={(e) => setOutputPath(e.target.value)}
                              required
                            />
                            <button
                              className="button"
                              disabled={publishing || !outputPath.trim()}
                            >
                              {publishing ? (
                                <LoaderCircle size={14} className="spin" />
                              ) : (
                                <FileText size={14} />
                              )}
                              Verify and attach
                            </button>
                          </form>
                        </details>
                      )}
                      {taskDetail.error && (
                        <div className="task-error">{taskDetail.error}</div>
                      )}
                      <h4 className="section-heading">ACTIVITY</h4>
                      <EventList
                        events={events.filter(
                          (e) => e.taskId === taskDetail.id,
                        )}
                        chatName={chatName}
                        deviceName={deviceName}
                      />
                    </>
                  ) : (
                    <>
                      <div className="workspace-summary">
                        <div>
                          <span>
                            {workerTasks.filter((t) => active(t.status)).length}
                          </span>
                          <small>In progress</small>
                        </div>
                        <div>
                          <span>{approvals.length}</span>
                          <small>Need you</small>
                        </div>
                        <div>
                          <span>{onlineCount}</span>
                          <small>Connected</small>
                        </div>
                      </div>
                      {approvals.length > 0 && (
                        <div className="needs-attention">
                          <div>
                            <CircleHelp size={15} />
                            <strong>Requests need your attention</strong>
                          </div>
                          {approvals.map((a) => (
                            <button
                              key={a.id}
                              onClick={() => {
                                const t = tasks.find((t) => t.id === a.taskId);
                                if (t) inspectTask(t);
                              }}
                            >
                              <span>
                                {tasks.find((t) => t.id === a.taskId)?.prompt ??
                                  approvalRequestLabel(a)}
                              </span>
                              <ChevronRight size={14} />
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="detail-tabs">
                        <button
                          className={detailTab === "tasks" ? "active" : ""}
                          onClick={() => setDetailTab("tasks")}
                        >
                          Tasks <span>{workerTasks.length}</span>
                        </button>
                        <button
                          className={detailTab === "activity" ? "active" : ""}
                          onClick={() => setDetailTab("activity")}
                        >
                          Activity
                        </button>
                      </div>
                      {detailTab === "tasks" ? (
                        workerTasks.length ? (
                          <div className="task-list">
                            {[...workerTasks].reverse().map((task) => (
                              <div className="task-card-row" key={task.id}>
                                <button
                                  className="task-card"
                                  onClick={() => inspectTask(task)}
                                >
                                  <div>
                                    <Status
                                      status={task.status}
                                      label={
                                        task.chatId === "master" &&
                                        task.status === "completed"
                                          ? "Reply ready"
                                          : queuedDependencyLabel(
                                              task,
                                              tasks,
                                              chatName,
                                            )
                                      }
                                    />
                                    <time>{timeLabel(task.updatedAt)}</time>
                                  </div>
                                  <h3>{task.prompt}</h3>
                                  <p>
                                    <DeviceIcon
                                      device={devices.find(
                                        (d) => d.id === task.deviceId,
                                      )}
                                      size={12}
                                    />
                                    {deviceName(task.deviceId)}
                                    <span>·</span>
                                    {chatName(task.chatId)}
                                  </p>
                                  {!!task.sourceChatIds?.length && (
                                    <small className="task-context">
                                      <Link2 size={11} />
                                      Context from {
                                        task.sourceChatIds.length
                                      }{" "}
                                      {task.sourceChatIds.length === 1
                                        ? "conversation"
                                        : "conversations"}
                                    </small>
                                  )}
                                </button>
                                <DependencyLink
                                  task={task}
                                  tasks={tasks}
                                  chatName={chatName}
                                  onOpen={openDependency}
                                />
                              </div>
                            ))}
                          </div>
                        ) : (
                          <Empty
                            icon={<CheckCheck size={22} />}
                            title="Room for your next move"
                          >
                            Delegated work, permission or input requests, and outputs appear here as
                            they happen.
                          </Empty>
                        )
                      ) : (
                        <EventList
                          events={events}
                          chatName={chatName}
                          deviceName={deviceName}
                        />
                      )}
                    </>
                  )}
                </div>
                <footer className="details-footer">
                  <ShieldCheck size={12} />
                  <span>Private, authenticated workspace</span>
                </footer>
              </details>
            )}
          </div>
        </div>
        <div className="composer-area">
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}{hosted && <a className="account-error-link" href="/account">Account settings</a>}</span>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {pending && (
            <div className="retry-banner" role="status">
              <span>
                {sending ? `Sending to ${chatName(pending.chatId)}…` : <>
                  Delivery to {chatName(pending.chatId)} is unconfirmed. Check
                  delivery looks for the existing task without sending again.
                  Dismissing clears only this tab’s saved request; it does not cancel any submitted task.
                </>}
              </span>
              {!sending && <><button onClick={() => void checkDelivery()}>
                <RefreshCw size={13} />
                Check delivery
              </button>
              <button
                onClick={() => {
                  setPending(null);
                  safeWrite(PENDING, "");
                }}
              >
                <X size={13} />
                Dismiss local retry
              </button></>}
            </div>
          )}
          <form
            className={`composer ${busy ? "composer-busy" : ""}`}
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            {showSources && selected !== "master" && (
              <div className="source-picker">
                <div>
                  <strong>Bring in context</strong>
                  <small>
                    Recent Providence-tracked turns, labelled by source.
                  </small>
                </div>
                {chats
                  .filter((c) => c.id !== selected)
                  .map((c) => (
                    <label key={c.id}>
                      <input
                        type="checkbox"
                        checked={sourceIds.includes(c.id)}
                        disabled={
                          !sourceIds.includes(c.id) && sourceIds.length >= 5
                        }
                        onChange={() =>
                          setSourceIds((previous) =>
                            previous.includes(c.id)
                              ? previous.filter((id) => id !== c.id)
                              : [...previous, c.id],
                          )
                        }
                      />
                      <span>
                        {c.name}
                        <small>{deviceName(c.deviceId)}</small>
                      </span>
                    </label>
                  ))}
                {chats.length < 2 && (
                  <p>Create another conversation to share its context here.</p>
                )}
              </div>
            )}
            {!!sourceIds.length && (
              <div className="composer-sources">
                {sourceIds.map((id) => (
                  <button
                    type="button"
                    key={id}
                    onClick={() =>
                      setSourceIds(sourceIds.filter((s) => s !== id))
                    }
                  >
                    <Link2 size={11} />
                    {chatName(id)}
                    <X size={11} />
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={textarea}
              aria-label="Message"
              aria-describedby="composer-destination"
              rows={1}
              placeholder={composerPlaceholder(busy, selected, chat?.name)}
              value={draft}
              maxLength={30000}
              enterKeyHint="enter"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  shouldSubmitComposerKey(
                    {
                      key: event.key,
                      shiftKey: event.shiftKey,
                      ctrlKey: event.ctrlKey,
                      metaKey: event.metaKey,
                      isComposing: event.nativeEvent.isComposing,
                    },
                    window.matchMedia("(pointer: coarse)").matches,
                  )
                ) {
                  event.preventDefault();
                  if (
                    !busy &&
                    !sending &&
                    connected &&
                    !pending &&
                    !targetIssue && !decisionPending
                  )
                    void send();
                }
              }}
            />
            <div className="composer-toolbar">
              <div className="composer-tools">
                <span
                  className="composer-target"
                  id="composer-destination"
                >
                  <span>
                    To{" "}
                    {selected === "master"
                      ? "Providence"
                      : (chat?.name ?? "Unavailable chat")}
                  </span>
                  {selected !== "master" && (
                    <small>
                      {deviceConnectionLabel(device, connected)}{" "}
                      · {deviceName(chat?.deviceId ?? "")}
                    </small>
                  )}
                </span>
                {selected !== "master" && (
                  <button
                    type="button"
                    className={`context-button ${showSources ? "toggled" : ""}`}
                    onClick={() => setShowSources(!showSources)}
                    title="Attach context from other conversations"
                  >
                    <Link2 size={14} />
                    <span>Context</span>
                    {sourceIds.length > 0 && <b>{sourceIds.length}</b>}
                  </button>
                )}
              </div>
              <div className="composer-send-actions">
              <button type="button" className={`chat-voice-toggle${voiceView || liveSpeaking ? " selected" : ""}`} aria-label={voiceView || liveSpeaking ? "End voice conversation" : "Start voice conversation"} aria-pressed={voiceView || liveSpeaking} title={voiceView || liveSpeaking ? "End voice" : "Talk to Providence"} disabled={!connected || signingOut} onClick={() => {
                if (liveSpeaking) liveConversation.current?.end();
                else if (voiceView) changeView("workspace");
                else if (hosted && aiConsentRequired) setError("Allow OpenAI processing in Account before starting voice.");
                else if (hosted) liveConversation.current?.start();
                else changeView("voice");
              }}><AudioLines size={21} /></button>
              <ComposerSend
                busy={busy}
                sending={sending}
                disabled={
                  !draft.trim() ||
                  sending ||
                  !connected ||
                  !!pending ||
                  !!targetIssue || decisionPending
                }
              />
              </div>
            </div>
          </form>
          {hosted && <LiveConversation ref={liveConversation} token={token} chatId={selected} connected={connected}
            onActive={setLiveSpeaking} onFallback={() => changeView("voice")} />}
          {voiceView && <div className="chat-voice-panel">
            <div className="chat-voice-heading"><span><AudioLines size={18} />Voice in this chat</span><button type="button" className="icon-button" aria-label="End voice" onClick={() => changeView("workspace")}><X size={18} /></button></div>
          <BrowserVoice
            presentation="compact"
            onCaptureBusyChange={setVoiceCaptureBusy}
            requests={tasks.map(task => ({ id: task.id, status: task.workStatus ?? task.status, error: task.error }))}
            contextKey={selected}
            configurationKey={`${voiceConfigurationKey}:${transcriptionHost}:${transcriptionReady}:${chat?.deviceId ?? selected}:${!targetIssue}`}
            connected={connected}
            disabled={
              !connected ||
              voiceConfigLoading ||
              (!transcriptionReady && !liveVoiceInput) ||
              sending ||
              !!pending ||
              ((!voiceQueueSupported) && (busy || decisionPending)) ||
              !!targetIssue
            }
            outcomes={voiceOutcomes}
            backgroundMode={voiceQueueSupported}
            acknowledgedJobs={voiceReceipts}
            uncertainRequest={pending?.voice && pending.chatId === selected ? pending : undefined}
            onTranscript={async (text) => {
              const requestId = newId();
              const chatId = selected;
              const accepted = await send({
                requestId,
                text,
                chatId,
                sourceChatIds: selected === "master" ? [] : [...sourceIds],
                ...(voiceQueueSupported ? { queueIfBusy: true } : {}),
                expectedDeviceId: selected === "master" ? "coordinator" : chat?.deviceId,
                voice: true,
              });
              if (!accepted || !accepted.id || accepted.requestId !== requestId || accepted.chatId !== chatId)
                throw new Error(
                  "Transcript submission was not confirmed. Check the message status before retrying.",
                );
              return { id: accepted.id, requestId: accepted.requestId, chatId: accepted.chatId };
            }}
            transcribe={
              transcriptionReady
                ? transcribeRecording
                : undefined
            }
            liveInput={liveVoiceInput}
            allowBrowserRecognition={false}
            allowBrowserSpeech={!!voiceConfig && !voiceConfig.speechConfigured}
            speak={voiceConfig?.speechConfigured && !voiceState.stale ? speakResponse : undefined}
            providerLabel={
              voiceConfig?.speechConfigured
                ? `${voiceConfig.provider} replies`
                : voiceConfig ? "Browser replies" : "Reply voice unavailable"
            }
          />
          </div>}
          <div className="composer-caption">
            <span>
              {targetIssue
                ? targetIssue
                : decisionPending
                  ? "This conversation has an unresolved input or permission request. Review its status before continuing."
                : busy
                ? "This conversation is working. You can stop it or wait to continue."
                  : "Runs on your connected devices."}
            </span>
            <span className="keyboard-hint">
              ↵ Send <span>·</span> ⇧ ↵ New line
            </span>
          </div>
        </div>
      </main>
      {showPair && <PairModal token={token} hosted={hosted} onClose={closePair} />}
      {revokeDevice && (
        <RevokeModal
          device={revokeDevice}
          token={token}
          onClose={closeRevoke}
          onRevoked={async () => {
            setRevokeDevice(null);
            setSelectedDevice("");
            await refresh();
          }}
        />
      )}
      {showNewChat && (
        <NewChatModal
          devices={devices}
          token={token}
          onClose={closeNewChat}
          onCreated={async (c) => {
            setShowNewChat(false);
            await refresh();
            selectChat(c.id);
          }}
        />
      )}
    </div>
  );
}

function NewChatModal({
  devices,
  token,
  onClose,
  onCreated,
}: {
  devices: Device[];
  token: string;
  onClose: () => void;
  onCreated: (chat: Chat) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [deviceId, setDeviceId] = useState(() => devices.filter(device => device.online).length === 1 ? devices.find(device => device.online)!.id : "");
  const [threadId, setThreadId] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [instructions, setInstructions] = useState("");
  const [isImport, setIsImport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!devices.some((device) => device.id === deviceId && device.online)) {
      setError("Choose a connected computer before creating the conversation.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const chat = await api<Chat>(token, "/chats", {
        name: name.trim(),
        deviceId,
        ...(workspace.trim() ? { workspace: workspace.trim() } : {}),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        ...(isImport && threadId.trim() ? { threadId: threadId.trim() } : {}),
      });
      await onCreated(chat);
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="New conversation" onClose={onClose}>
      <p className="modal-intro">
        A dedicated space for a project, with its own history and a computer to
        work on.
      </p>
      <form className="modal-form" onSubmit={create}>
        <label>
          Conversation name
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="A project, a plan, an idea…"
            maxLength={120}
            required
            autoFocus
          />
        </label>
        <label>
          Connected device
          <select
            className="input"
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            required
          >
            {!deviceId && <option value="">Choose a connected device</option>}
            {devices.map((d) => (
              <option key={d.id} value={d.id} disabled={!d.online}>
                {d.name}
                {!d.online ? ` · ${deviceConnectionLabel(d, true)}` : ""}
              </option>
            ))}
          </select>
        </label>
        <details className="conversation-options">
          <summary>Workspace and instructions</summary>
          <label>
            Workspace folder <span className="muted">(optional)</span>
            <input
              className="input"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder="Default device workspace"
            />
          </label>
          <label>
            Conversation instructions <span className="muted">(optional)</span>
            <textarea
              className="input"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Purpose, preferences, and how this project should work"
              rows={3}
            />
          </label>
          <p>
            Choose an existing folder within the device’s allowed workspace.
          </p>
        </details>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={isImport}
            onChange={(e) => setIsImport(e.target.checked)}
          />
          Register an existing Codex conversation
        </label>
        {isImport && (
          <div className="import-fields">
            <label>
              Codex thread ID
              <input
                className="input mono"
                value={threadId}
                onChange={(e) => setThreadId(e.target.value)}
                placeholder="Thread ID from this device"
                required
              />
            </label>
            <p>
              The conversation must belong to the device’s allowed workspace.
              Its existing Codex history stays with it; shared context includes
              only turns tracked by Providence.
            </p>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={
              busy ||
              !name.trim() ||
              !deviceId ||
              !devices.some((device) => device.id === deviceId && device.online) ||
              (isImport && !threadId.trim())
            }
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Plus size={15} />
            )}
            Create conversation
          </button>
        </div>
      </form>
    </Modal>
  );
}
function RenameChat({
  chat,
  token,
  onSaved,
  onError,
}: {
  chat: Chat;
  token: string;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(chat.name);
  const [busy, setBusy] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        className="icon-button"
        title="Rename conversation"
        aria-label="Rename conversation"
        onClick={() => {
          setName(chat.name);
          setOpen(true);
        }}
      >
        <Pencil size={15} />
      </button>
      {open && (
        <Modal title="Rename conversation" onClose={close}>
          <form
            className="modal-form"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              try {
                await api(
                  token,
                  `/chats/${chat.id}`,
                  { name: name.trim() },
                  "PATCH",
                );
                await onSaved();
                setOpen(false);
              } catch (error) {
                onError(messageOf(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Conversation name
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={120}
                autoFocus
              />
            </label>
            <div className="modal-footer">
              <button
                className="button primary"
                disabled={busy || !name.trim()}
              >
                Save name
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
export function ToolEventDetail({ event }: { event: Activity }) {
  const unsupportedRequest = event.type === "runtime.unsupported_request";
  if (!event.type.startsWith("tool.") && !unsupportedRequest) return null;
  const item = event.item;
  const output = typeof event.output === "string" ? event.output : "";
  const error = typeof event.error === "string" ? event.error : "";
  const cut = output.length > 12000 || error.length > 6000;
  if (!item && !output && !error) return null;
  return (
    <details className="tool-event-detail">
      <summary>
        {unsupportedRequest ? "View request diagnostic" : "View tool details"}
        <ChevronDown size={11} />
      </summary>
      {unsupportedRequest && typeof event.method === "string" && (
        <dl>
          <dt>Method</dt>
          <dd>{event.method.slice(0, 120)}</dd>
        </dl>
      )}
      {item && (
        <dl>
          {item.tool && (
            <>
              <dt>Tool</dt>
              <dd>
                {item.server ? `${item.server} / ` : ""}
                {item.tool}
              </dd>
            </>
          )}
          {item.command && (
            <>
              <dt>Command</dt>
              <dd>
                <pre>{item.command.slice(0, 12000)}</pre>
              </dd>
            </>
          )}
          {item.status && (
            <>
              <dt>Status</dt>
              <dd>{item.status}</dd>
            </>
          )}
          {typeof item.exitCode === "number" && (
            <>
              <dt>Exit code</dt>
              <dd>{item.exitCode}</dd>
            </>
          )}
        </dl>
      )}
      {output && (
        <>
          <h5>Output</h5>
          <pre>{output.slice(0, 12000)}</pre>
        </>
      )}
      {error && (
        <>
          <h5>Tool error</h5>
          <pre className="tool-event-error">{error.slice(0, 6000)}</pre>
        </>
      )}
      {(event.truncated || cut) && (
        <p className="tool-output-note">
          Only the available bounded output is shown.
        </p>
      )}
    </details>
  );
}

function EventList({
  events,
  chatName,
  deviceName,
}: {
  events: Activity[];
  chatName: (id: string) => string;
  deviceName: (id: string) => string;
}) {
  const relevant = events
    .filter((e) => !["text.delta", "runtime.ready"].includes(e.type))
    .slice(-35)
    .reverse();
  function describe(event: Activity) {
    if (event.type === "runtime.unsupported_request")
      return "Unsupported provider request";
    if (event.type === "tool.started") return "Tool started";
    if (event.type === "tool.output") return "Tool output received";
    if (event.type === "tool.completed")
      return event.item?.status === "failed" || !!event.error
        ? "Tool reported an error"
        : event.item?.status === "declined"
          ? "Tool request declined"
          : "Tool finished";
    if (event.type === "context.transferred")
      return `Context shared from ${(event.sourceChatIds ?? []).map(chatName).join(", ")}`;
    return (
      (
        {
          "device.online": "Device connected",
          "device.paired": "Device paired",
          "device.revoked": "Device access revoked",
          "device.offline": "Device disconnected",
          "chat.created": "Conversation created",
          "chat.renamed": "Conversation renamed",
          "task.started": "Task started",
          "task.completed": "Agent finished",
          "task.failed": "Task failed",
          "task.cancelled": "Task stopped",
          "approval.requested": "Input or permission requested",
          "approval.resolved": "Response received",
          "approval.expired": "Request expired",
          "artifact.created": "File verified and attached",
          "artifact.verified": "File verified and attached",
          "artifact.published": "File verified and attached",
        } as Record<string, string>
      )[event.type] ?? event.type.replaceAll(".", " ").replaceAll("_", " ")
    );
  }
  return relevant.length ? (
    <div className="event-list">
      {relevant.map((event) => (
        <div className="event-item" key={event.sequence}>
          <span className="event-icon">
            {event.type === "context.transferred" ? (
              <Link2 size={12} />
            ) : event.type.includes("completed") ? (
              <Circle size={8} />
            ) : event.type.startsWith("device") ? (
              <Monitor size={12} />
            ) : (
              <Circle size={8} />
            )}
          </span>
          <div>
            <p>{describe(event)}</p>
            <small>
              {event.deviceId ? deviceName(event.deviceId) : "Providence"}{" "}
              <span>·</span> {timeLabel(event.at)}
            </small>
            <ToolEventDetail event={event} />
          </div>
        </div>
      ))}
    </div>
  ) : (
    <Empty icon={<Layers3 size={21} />} title="A clear record">
      Execution and context-sharing events will appear here.
    </Empty>
  );
}

type DevicePairing = { code: string; expiresAt: string };
function isHostedDeviceSetup(token: string, hosted = false, hostname = typeof window === "undefined" ? "" : window.location.hostname) {
  return hosted || token === HOSTED_ACCOUNT_SESSION || ["providence.hani.so", "htn.hani.so"].includes(hostname);
}

export async function requestSelfHostedPairing(token: string, name: string, {
  fetcher = fetch,
  createPairing = () => api<DevicePairing>(token, "/devices/pair", { name }),
  openAccount = () => window.location.assign("/account"),
  hostname = typeof window === "undefined" ? "" : window.location.hostname,
}: { fetcher?: typeof fetch; createPairing?: () => Promise<DevicePairing>; openAccount?: () => void; hostname?: string } = {}): Promise<DevicePairing | null> {
  if (isHostedDeviceSetup(token, false, hostname)) { openAccount(); return null; }
  // A saved older token can render the workspace before account detection
  // settles. Confirm server mode before any legacy credential is created.
  const response = await fetcher("/auth/session", {
    headers: { Authorization: `Bearer ${token}` }, credentials: sessionCredentials(token),
    mode: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // The existing self-hosted coordinator serves its SPA at unknown non-API
  // paths, including /auth/session. Account servers return JSON here.
  const selfHostedPage = response.ok && /^text\/html(?:;|$)/i.test(response.headers.get("Content-Type") ?? "");
  if (response.ok && !selfHostedPage) {
    const session = await response.json();
    if (session?.hosted === true) { openAccount(); return null; }
    if (session?.hosted !== false) throw new Error("Device setup could not identify this server. Reload and try again.");
  } else if (!response.ok && response.status !== 404) throw new Error("Device setup could not confirm this workspace. Reload and try again.");
  return createPairing();
}

export function PairModal({ token, hosted = false, onClose }: { token: string; hosted?: boolean; onClose: () => void }) {
  if (isHostedDeviceSetup(token, hosted)) return (
    <Modal title="Connect a device" onClose={onClose}>
      <p className="modal-intro">
        Open Account and devices for the setup command. Run it on the computer
        you want to connect, then approve that computer with your Providence account.
      </p>
      <p>Setup guides you through Codex sign-in, your computer's name and access, and startup preferences.</p>
      <div className="modal-footer">
        <button className="button" onClick={onClose}>Cancel</button>
        <a className="button primary" href="/account">Open Account and devices <ArrowRight size={14} /></a>
      </div>
    </Modal>
  );
  return <SelfHostedPairModal token={token} onClose={onClose} />;
}

export function SelfHostedPairingInstructions({ origin }: { origin: string }) {
  return (
    <details className="pair-setup">
      <summary>Set up a companion for this server</summary>
      <p>
        Get the companion setup for this server from its owner. On the computer
        you want to connect, use the server address below and enter this one-use
        code when prompted. That computer keeps its own Codex sign-in.
      </p>
      <pre className="setup-command">{origin}</pre>
      <p>
        The public Providence installer connects to providence.hani.so. Use your
        server owner's instructions to connect to this private coordinator.
      </p>
    </details>
  );
}

function SelfHostedPairModal({ token, onClose }: { token: string; onClose: () => void }) {
  const [name, setName] = useState("");
  const [pairing, setPairing] = useState<DevicePairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  const expired = pairing
    ? now >= new Date(pairing.expiresAt).getTime()
    : false;
  async function pair(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await requestSelfHostedPairing(token, name.trim());
      if (result) setPairing(result);
      setNow(Date.now());
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Connect a device" onClose={onClose}>
      <p className="modal-intro">
        Add a computer to this workspace. Its companion connects privately and
        uses its own Codex sign-in.
      </p>
      {!pairing ? (
        <form className="modal-form" onSubmit={pair}>
          <label>
            Device name
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="For example, Office computer"
              maxLength={120}
              required
              autoFocus
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-footer">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button className="button primary" disabled={busy || !name.trim()}>
              {busy ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Link2 size={15} />
              )}
              Create pairing code
            </button>
          </div>
        </form>
      ) : (
        <div className="pairing-ready">
          <div className="pairing-device">
            <Monitor size={19} />
            <strong>{name}</strong>
            <span>{expired ? "Code expired" : "Ready to pair"}</span>
          </div>
          <p>
            Enter this one-use code in the Providence companion on your other
            computer.
          </p>
          <div
            className={`pair-code ${expired ? "expired" : ""}`}
            aria-label="Pairing code"
          >
            {pairing.code.match(/.{1,4}/g)?.join(" ")}
          </div>
          <div className="pair-expiry">
            {expired
              ? "Create a new code to continue."
              : `Expires at ${timeLabel(pairing.expiresAt)}. Keep this code private.`}
          </div>
          <SelfHostedPairingInstructions origin={window.location.protocol === "https:" ? window.location.origin : "https://YOUR_COORDINATOR"} />
          <div className="modal-footer">
            <button className="button" onClick={() => setPairing(null)}>
              Create another code
            </button>
            <button className="button primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
function RevokeModal({
  device,
  token,
  onClose,
  onRevoked,
}: {
  device: Device;
  token: string;
  onClose: () => void;
  onRevoked: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={`Remove ${device.name} access?`} onClose={onClose}>
      <p className="modal-intro">
        This immediately blocks new Providence work, invalidates this computer’s
        credential and asks its companion to stop. Check any work already sent on
        the computer. Its files, conversation history, your other computers and
        shared API key stay unchanged. A fresh setup can grant access again.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-footer">
        <button className="button" onClick={onClose}>
          Keep connected
        </button>
        <button
          className="button primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(token, `/devices/${encodeURIComponent(device.id)}`, undefined, "DELETE");
              await onRevoked();
            } catch (error) {
              setError(messageOf(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <LogOut size={15} />
          )}
          Remove access
        </button>
      </div>
    </Modal>
  );
}
