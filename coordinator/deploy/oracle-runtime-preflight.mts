/** Isolated Oracle execution proof. Does not run a coordinator, change a gateway,
 * pair devices, or read/copy authentication/session files.
 * Usage: <node22> --import tsx deploy/oracle-runtime-preflight.mts <staged-coordinator> <private-ops-directory>
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [coordinatorInput, evidenceInput] = process.argv.slice(2);
if (!coordinatorInput || !evidenceInput) throw new Error("Provide the staged coordinator path and private preflight evidence directory.");
const allowed = realpathSync("/home/developer/htn");
function bounded(path: string) {
  const resolved = realpathSync(path);
  const rel = relative(allowed, resolved);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Preflight paths must remain under /home/developer/htn.");
  return resolved;
}
const coordinator = bounded(coordinatorInput), evidenceDirectory = bounded(evidenceInput);
assert.equal(process.platform, "linux");
assert.ok(Number(process.versions.node.split(".")[0]) >= 22);
const runId = randomUUID();
const workspace = resolve(allowed, "preflight-workspace", runId);
mkdirSync(workspace, { recursive: true, mode: 0o700 });
const proofFilename = `oracle-proof-${runId}.txt`;
const nonce = randomUUID();
const expectedBytes = Buffer.from(`Providence Oracle runtime proof ${nonce}\n`);
const taskId = randomUUID();
const events: string[] = [];
const artifacts: any[] = [];
const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(), coordinator, workspace, taskId,
  host: { hostname: hostname(), platform: process.platform, architecture: process.arch, node: process.version },
  scope: "One fresh workspace and standalone stdio Runtime. No persistent coordinator, device pairing, gateway cutover, or credential/session-file transfer.",
  accountValuesRedacted: true,
};
function existingCodexProcesses() {
  const result: { pid: number; startTicks: string }[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const uid = readFileSync(`/proc/${entry}/status`, "utf8").match(/^Uid:\s+(\d+)/m)?.[1];
      if (Number(uid) !== process.getuid?.()) continue;
      const args = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      if (!args.includes("codex") || !args.includes("app-server")) continue;
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      result.push({ pid: Number(entry), startTicks: fields[19] });
    } catch { /* A short-lived process may disappear during read-only inspection. */ }
  }
  return result;
}
const beforeProcesses = existingCodexProcesses();
evidence.existingAppServerProcessesBefore = beforeProcesses;
const { Runtime } = await import(pathToFileURL(resolve(coordinator, "src/runtime.ts")).href);
const runtime = new Runtime({ root: workspace });
let threadId: string | undefined;
let timer: NodeJS.Timeout | undefined;
let completed = false;
try {
  const account = await runtime.start();
  // Runtime.start uses supported account/read. Its return deliberately excludes identity values.
  evidence.accountType = account.type;
  assert.equal(account.type, "chatgpt", "This proof requires the existing Oracle ChatGPT login.");
  const models = await runtime.rpc.call("model/list", { limit: 100 });
  evidence.requestedModel = process.env.PROVIDENCE_MODEL ?? "device-configured default";
  evidence.requestedModelListed = process.env.PROVIDENCE_MODEL
    ? (models.data ?? []).some((model: any) => model.id === process.env.PROVIDENCE_MODEL || model.model === process.env.PROVIDENCE_MODEL)
    : undefined;
  const created = await runtime.create();
  threadId = created.threadId;
  evidence.providerThreadId = threadId;
  const terminal = new Promise<any>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Oracle preflight exceeded three minutes; inspect this fresh task before retrying.")), 180_000);
    runtime.on("event", (event: any) => {
      if (event.taskId !== taskId) return;
      events.push(event.type);
      if (event.type === "artifact.created") artifacts.push(event.artifact);
      if (event.type === "approval.requested") reject(new Error("Oracle requested a decision/approval; no approval was automatically granted."));
      if (event.type === "task.completed") resolve(event);
      if (["task.failed", "task.cancelled"].includes(event.type)) reject(new Error(`Oracle task ended as ${event.type}: ${event.error ?? "inspect runtime"}`));
    });
  });
  void terminal.catch(() => {}); // Keep early provider failures handled while turn/start is pending.
  await runtime.execute(threadId, taskId,
    `Create only the new file ${proofFilename} in this approved workspace, containing exactly this line followed by a newline:\nProvidence Oracle runtime proof ${nonce}\n\nUse exclusive creation if available. Read it back, then call providence_publish_artifact with this file's path. Do not access other projects, credentials, settings, services or networks, and do not change any other file.`);
  await terminal;
  completed = true;
  const bytes = readFileSync(resolve(workspace, proofFilename));
  assert.deepEqual(bytes, expectedBytes, "Independently read file bytes do not match the fresh proof nonce.");
  const artifact = artifacts.find((entry) => entry.path === proofFilename);
  assert.ok(artifact, "The runtime completed without its real dynamic artifact tool succeeding.");
  assert.equal(artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(Buffer.from(artifact.base64, "base64"), bytes);
  evidence.fileProof = { path: resolve(workspace, proofFilename), bytes: bytes.length, sha256: artifact.sha256, independentlyRead: true, dynamicArtifactToolVerified: true };
  evidence.result = "passed";
  console.log("PASS: Oracle's existing ChatGPT login executed a real file operation through Providence Runtime; file bytes and dynamic artifact tool independently verified.");
} catch (error) {
  evidence.result = "failed";
  evidence.error = error instanceof Error ? error.message : "Unknown preflight error";
  throw error;
} finally {
  clearTimeout(timer);
  if (!completed && threadId) { try { await runtime.cancel(threadId); } catch {} }
  runtime.stop();
  await new Promise((resolve) => setTimeout(resolve, 300));
  evidence.eventTypes = events;
  const preserved = beforeProcesses.map((entry) => {
    try {
      const stat = readFileSync(`/proc/${entry.pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === entry.startTicks;
      // A process that has merely exited is unreadable here, which is not evidence
      // that this preflight disturbed it; only a changed start time is.
    } catch { return "unknown"; }
  });
  evidence.existingAppServerProcessesPreserved =
    preserved.includes(false) ? false : preserved.includes("unknown") ? "unknown" : true;
  evidence.finishedAt = new Date().toISOString();
  const target = resolve(evidenceDirectory, `runtime-proof-${runId}.json`);
  try {
    writeFileSync(target, JSON.stringify(evidence, null, 2), { mode: 0o600, flag: "wx" });
    console.log(`Non-secret Oracle preflight evidence: ${target}`);
  } catch (writeError) {
    // Throwing from finally would replace the real preflight failure with this one.
    console.error(`Oracle preflight evidence was not written to ${target}: ${writeError instanceof Error ? writeError.message : "unknown write error"}`);
  }
}
