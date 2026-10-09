import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Clock3,
  FileText,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Send,
} from "lucide-react";
import { api } from "./api";
import {
  HOST_PROOF_REQUEST,
  computerProofRequest,
  hostProofStorageKey,
  hostProofRequestBody,
  hostProofStatusText,
  hostProofTerminal,
  makeHostProofRecord,
  parseHostProofRecord,
  retainNewestHostProofJob,
  validateHostProofJob,
} from "./hostProofState";
import type {
  HostBridgeJob,
  HostProofRecord,
  HostProofAction,
} from "./hostProofState";

function storedRecord(action: HostProofAction) {
  try {
    return parseHostProofRecord(
      sessionStorage.getItem(hostProofStorageKey(action)),
      action,
    );
  } catch {
    return;
  }
}
function saveRecord(record: HostProofRecord) {
  try {
    sessionStorage.setItem(
      hostProofStorageKey(record.action ?? "htn-task-inventory"),
      JSON.stringify(record),
    );
  } catch {}
}
function timestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString([], { timeZoneName: "short" });
}
export type HostBridgeProofViewProps = {
  record: HostProofRecord;
  job: HostBridgeJob | null;
  busy?: boolean;
  loading?: boolean;
  error?: string;
  onSend: () => void;
  onRefresh: () => void;
  onBack: () => void;
  onLock: () => void;
};
export function HostBridgeProofView({
  record,
  job,
  busy = false,
  loading = false,
  error = "",
  onSend,
  onRefresh,
  onBack,
  onLock,
}: HostBridgeProofViewProps) {
  const pendingDelivery = !!record.submitted && !record.jobId;
  const computerProof = record.action === "mac-chrome-typing-proof";
  const browserRequest =
    job?.browserRequest ?? computerProofRequest(record.probeId);
  return (
    <main className="host-proof">
      <header className="host-proof-header">
        <button className="button" onClick={onBack}>
          <ArrowLeft size={14} />
          Workspace
        </button>
        <span>PROVIDENCE</span>
        <button
          className="icon-button"
          aria-label="Lock workspace"
          title="Lock workspace"
          onClick={onLock}
        >
          <LockKeyhole size={16} />
        </button>
      </header>
      <section className="host-proof-content">
        <div className="eyebrow">
          {computerProof
            ? "ONE-JOB COMPUTER USE PROOF"
            : "ONE-JOB HOST BRIDGE PROOF"}
        </div>
        <h1>
          {computerProof
            ? "Request a Mac browser typing check"
            : "Request work from the Codex host"}
        </h1>
        <p className="host-proof-intro">
          {computerProof
            ? "This proof covers one manually claimed Mac browser action. TOTALMAIN must claim the job, type the fixed text without submitting the search, and return a fresh accessibility observation."
            : "This proof covers one manually claimed, read-only job. TOTALMAIN must claim the request and use its actual Codex app tools before a result can appear here."}
        </p>
        <div className="host-proof-request">
          <span className="host-proof-label">Fixed request</span>
          {computerProof ? (
            <>
              <p>
                Open Google on the Mac, type the exact text into Search without
                submitting it, then observe the field again.
              </p>
              <dl className="host-proof-identity">
                <dt>Device</dt>
                <dd>Mac</dd>
                <dt>URL</dt>
                <dd className="mono">{browserRequest.url}</dd>
                <dt>Field</dt>
                <dd>{browserRequest.field}</dd>
                <dt>Type exactly</dt>
                <dd className="mono">{browserRequest.text}</dd>
                <dt>Submit search</dt>
                <dd>No</dd>
              </dl>
            </>
          ) : (
            <p>{HOST_PROOF_REQUEST}</p>
          )}
        </div>
        <dl className="host-proof-identity">
          <dt>Probe</dt>
          <dd className="mono">{record.probeId}</dd>
          <dt>Request</dt>
          <dd className="mono">{record.requestId}</dd>
          <dt>Job</dt>
          <dd className="mono">
            {job?.id ??
              record.jobId ??
              (record.submitted
                ? "Awaiting server confirmation"
                : "Not submitted yet")}
          </dd>
        </dl>
        <div className="host-proof-state" role="status">
          {busy || loading || job?.status === "running" ? (
            <LoaderCircle size={18} className="spin" />
          ) : job?.status === "completed" ? (
            <FileText size={18} />
          ) : (
            <Clock3 size={18} />
          )}
          <div>
            <strong>
              {busy
                ? "Submitting this proof request"
                : record.jobId && !job
                  ? "Restoring the saved job"
                  : pendingDelivery
                    ? "Delivery has not been confirmed"
                    : hostProofStatusText(job?.status)}
            </strong>
            {job?.status === "queued" && (
              <p>The request is queued. No host execution has been reported.</p>
            )}
            {job?.status === "claimed" && (
              <p>
                The host has claimed this job; no result has been reported yet.
              </p>
            )}
            {job?.status === "running" && (
              <p>
                {computerProof
                  ? "Waiting for the host to return the freshly observed Search field."
                  : "Waiting for the host to return its observed task inventory."}
              </p>
            )}
            {pendingDelivery && (
              <p>
                Retry uses the same request and probe IDs. It does not create a
                new proof request.
              </p>
            )}
            {job?.updatedAt && (
              <small>Last job update: {timestamp(job.updatedAt)}</small>
            )}
          </div>
        </div>
        {error && (
          <p className="error host-proof-error" role="alert">
            {error}
          </p>
        )}
        {job?.error && (
          <p className="error host-proof-error" role="alert">
            {job.error}
          </p>
        )}
        <div className="host-proof-actions">
          {!record.jobId && !job && (
            <button
              className="button primary"
              disabled={busy || loading}
              onClick={onSend}
            >
              {busy ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Send size={15} />
              )}{" "}
              {pendingDelivery ? "Retry same request" : "Send proof request"}
            </button>
          )}
          {record.jobId && (
            <button
              className="button"
              disabled={loading || busy}
              onClick={onRefresh}
            >
              <RefreshCw size={14} />
              Refresh job status
            </button>
          )}
          <span>
            No host claim or execution is triggered merely by opening this page.
          </span>
        </div>
        {job?.result && (
          <section className="host-proof-result" aria-label="Codex host result">
            <div className="host-proof-result-title">
              <h2>Host result</h2>
              <span>Observed {timestamp(job.result.observedAt)}</span>
            </div>
            <dl className="host-proof-identity">
              <dt>Host task</dt>
              <dd className="mono">{job.result.hostTaskId}</dd>
              <dt>Reported tools</dt>
              <dd>
                <ul className="host-proof-tools">
                  {job.result.toolNames.map((name, index) => (
                    <li className="mono" key={`${name}-${index}`}>
                      {name}
                    </li>
                  ))}
                </ul>
              </dd>
            </dl>
            {job.result.summary && (
              <p className="host-proof-summary">{job.result.summary}</p>
            )}
            {"browser" in job.result ? (
              <div className="host-proof-browser-result">
                <dl className="host-proof-identity">
                  <dt>Device</dt>
                  <dd>{job.result.browser.deviceId}</dd>
                  <dt>URL</dt>
                  <dd className="mono">{job.result.browser.url}</dd>
                  <dt>Field</dt>
                  <dd>{job.result.browser.field}</dd>
                  <dt>Expected text</dt>
                  <dd>
                    <pre>{job.result.browser.expectedText}</pre>
                  </dd>
                  <dt>Observed text</dt>
                  <dd>
                    <pre>{job.result.browser.observedText}</pre>
                  </dd>
                  <dt>Search submitted</dt>
                  <dd>{job.result.browser.submitted ? "Yes" : "No"}</dd>
                  <dt>Evidence</dt>
                  <dd>{job.result.browser.evidence}</dd>
                </dl>
              </div>
            ) : (
              <div className="host-proof-table">
                <table>
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {job.result.tasks.map((task) => (
                      <tr key={task.id}>
                        <td>
                          <strong>{task.title}</strong>
                          <code>{task.id}</code>
                        </td>
                        <td>{task.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!job.result.tasks.length && (
                  <p>The host returned no matching tasks.</p>
                )}
              </div>
            )}
          </section>
        )}
        <footer className="host-proof-footer">
          <ArrowUpRight size={13} />
          <span>
            This page submits and reads one job. The host performs the requested
            tool action.
          </span>
        </footer>
      </section>
    </main>
  );
}
export default function HostBridgeProof({
  token,
  action = "htn-task-inventory",
  onBack,
  onLock,
}: {
  token: string;
  action?: HostProofAction;
  onBack: () => void;
  onLock: () => void;
}) {
  const [record, setRecord] = useState<HostProofRecord>(
    () => storedRecord(action) ?? makeHostProofRecord(undefined, action),
  );
  const [job, setJob] = useState<HostBridgeJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const polling = useRef(false);
  useEffect(() => saveRecord(record), [record]);
  const refresh = useCallback(async () => {
    if (!record.jobId || polling.current) return;
    polling.current = true;
    setLoading(true);
    try {
      const response = await api<{ job: HostBridgeJob }>(
        token,
        `/host-bridge/jobs/${encodeURIComponent(record.jobId)}`,
      );
      const next = validateHostProofJob(response.job, record);
      setJob((previous) => retainNewestHostProofJob(previous, next));
      setError("");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The job status could not be read.",
      );
    } finally {
      setLoading(false);
      polling.current = false;
    }
  }, [token, record]);
  useEffect(() => {
    if (!record.jobId) return;
    void refresh();
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const interval =
      job && hostProofTerminal(job.status)
        ? undefined
        : setInterval(tick, 1500);
    window.addEventListener("online", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      if (interval) clearInterval(interval);
      window.removeEventListener("online", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [record.jobId, refresh, job?.status]);
  async function send() {
    if (busy || record.jobId || job) return;
    const submitted = { ...record, submitted: true };
    saveRecord(submitted);
    setRecord(submitted);
    setBusy(true);
    setError("");
    try {
      const response = await api<{ job: HostBridgeJob }>(
        token,
        "/host-bridge/jobs",
        hostProofRequestBody(submitted),
      );
      const accepted = validateHostProofJob(response.job, submitted);
      setJob(accepted);
      const saved = { ...submitted, jobId: accepted.id };
      saveRecord(saved);
      setRecord(saved);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Delivery could not be confirmed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <HostBridgeProofView
      record={record}
      job={job}
      busy={busy}
      loading={loading}
      error={error}
      onSend={() => void send()}
      onRefresh={() => void refresh()}
      onBack={onBack}
      onLock={onLock}
    />
  );
}
