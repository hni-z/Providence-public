export const HOST_PROOF_REQUEST =
  "Read current HTN task titles/statuses with the actual Codex app tools";
export const HOST_PROOF_STORAGE_KEY = "providence.host-bridge-proof";
export const COMPUTER_PROOF_STORAGE_KEY = "providence.computer-use-proof";
export type HostProofAction = "htn-task-inventory" | "mac-chrome-typing-proof";
export type HostBrowserRequest = {
  deviceId: "mac";
  url: "https://www.google.com/";
  field: "Search";
  text: string;
  submit: false;
};
export function computerProofRequest(probeId: string): HostBrowserRequest {
  return {
    deviceId: "mac",
    url: "https://www.google.com/",
    field: "Search",
    text: `Providence Mac control check ${probeId}`,
    submit: false,
  };
}
export function hostProofStorageKey(action: HostProofAction) {
  return action === "mac-chrome-typing-proof"
    ? COMPUTER_PROOF_STORAGE_KEY
    : HOST_PROOF_STORAGE_KEY;
}
export function hostProofActionForHash(
  hash: string,
): HostProofAction | undefined {
  return hash === "#host-bridge-proof"
    ? "htn-task-inventory"
    : hash === "#computer-use-proof"
      ? "mac-chrome-typing-proof"
      : undefined;
}
export type HostBridgeStatus =
  "queued" | "claimed" | "running" | "completed" | "failed" | "interrupted";
export type HostProofRecord = {
  requestId: string;
  probeId: string;
  action?: HostProofAction;
  jobId?: string;
  submitted?: boolean;
};
export type HostBridgeJob = {
  id: string;
  requestId: string;
  probeId: string;
  action: HostProofAction;
  browserRequest?: HostBrowserRequest;
  status: HostBridgeStatus;
  createdAt: string;
  updatedAt: string;
  consumerId?: string;
  error?: string;
  result?: {
    hostTaskId: string;
    toolNames: string[];
    observedAt: string;
    summary?: string;
  } & (
    | { tasks: { id: string; title: string; status: string }[] }
    | {
        browser: {
          deviceId: "mac";
          url: "https://www.google.com/";
          field: "Search";
          expectedText: string;
          observedText: string;
          submitted: false;
          evidence: "accessibility";
        };
      }
  );
};
export function makeHostProofRecord(
  randomId: () => string = () => crypto.randomUUID(),
  action: HostProofAction = "htn-task-inventory",
): HostProofRecord {
  return {
    ...(action === "mac-chrome-typing-proof" ? { action } : {}),
    requestId: randomId(),
    probeId: `PHW-0919-${randomId().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
  };
}
export function parseHostProofRecord(
  value: string | null,
  action: HostProofAction = "htn-task-inventory",
): HostProofRecord | undefined {
  if (!value) return;
  try {
    const parsed = JSON.parse(value);
    if (
      !parsed ||
      (parsed.action ?? "htn-task-inventory") !== action ||
      typeof parsed.requestId !== "string" ||
      !parsed.requestId ||
      typeof parsed.probeId !== "string" ||
      !/^PHW-0919-[A-Z0-9]+$/.test(parsed.probeId) ||
      (parsed.jobId !== undefined &&
        (typeof parsed.jobId !== "string" || !parsed.jobId)) ||
      (parsed.submitted !== undefined && typeof parsed.submitted !== "boolean")
    )
      return;
    return {
      requestId: parsed.requestId,
      probeId: parsed.probeId,
      ...(parsed.action ? { action: parsed.action } : {}),
      ...(parsed.jobId ? { jobId: parsed.jobId } : {}),
      ...(parsed.submitted !== undefined
        ? { submitted: parsed.submitted }
        : {}),
    };
  } catch {
    return;
  }
}
export function hostProofRequestBody(record: HostProofRecord) {
  return {
    requestId: record.requestId,
    probeId: record.probeId,
    ...(record.action === "mac-chrome-typing-proof"
      ? { action: record.action }
      : {}),
  };
}
export function hostProofTerminal(status: HostBridgeStatus) {
  return ["completed", "failed", "interrupted"].includes(status);
}
export function hostProofStatusText(status?: HostBridgeStatus) {
  return status
    ? (
        {
          queued: "Waiting for Codex host to claim",
          claimed: "Claimed by Codex host",
          running: "Codex host is running the job",
          completed: "Result reported by Codex host",
          failed: "Host job failed",
          interrupted: "Host job interrupted",
        } as const
      )[status]
    : "Ready to send one job";
}
export function validateHostProofJob(
  job: HostBridgeJob,
  record: HostProofRecord,
): HostBridgeJob {
  if (
    !job ||
    typeof job.id !== "string" ||
    !job.id ||
    job.requestId !== record.requestId ||
    job.probeId !== record.probeId ||
    (record.jobId && job.id !== record.jobId) ||
    job.action !== (record.action ?? "htn-task-inventory") ||
    ![
      "queued",
      "claimed",
      "running",
      "completed",
      "failed",
      "interrupted",
    ].includes(job.status)
  )
    throw new Error(
      "The host bridge response does not match this proof request.",
    );
  return job;
}
export function retainNewestHostProofJob(
  previous: HostBridgeJob | null,
  incoming: HostBridgeJob,
) {
  if (
    previous?.id === incoming.id &&
    ((hostProofTerminal(previous.status) &&
      !hostProofTerminal(incoming.status)) ||
      Date.parse(previous.updatedAt) > Date.parse(incoming.updatedAt))
  )
    return previous;
  return incoming;
}
