import { readFileSync, watchFile, unwatchFile } from "node:fs";
import { KeepAwakeController } from "./keep-awake.js";
import { WebSocket } from "ws";
import { Runtime } from "./runtime.js";
import { runtimeRequest } from "./devices.js";
import { CompanionConnection } from "./companion-connection.js";
import {
  loadDeviceTranscription, parseDeviceConfig, prepareWorkspace, runtimeMetadata,
  workerUrl, workerAccessForProvidence, type PrivateTranscriptionConfig,
} from "./device-config.js";

// Exit contract for an optional external supervisor: 0=owner stop,
// 78=action required (never restart automatically), 75=unexpected process defect.
let connection: CompanionConnection<Runtime> | undefined;
let watchedConfig: string | undefined;
const awake = new KeepAwakeController(state => connection?.reportKeepAwake(state));
try {
  const file = process.argv[2];
  if (!file) throw new Error("Missing private device file");
  const config = parseDeviceConfig(readFileSync(file, "utf8"));
  const originalIdentity = JSON.stringify({ ...config, keepAwake: undefined });
  await awake.setEnabled(config.keepAwake === true);
  const url = workerUrl(config.url, process.env.PROVIDENCE_ALLOW_PLAINTEXT === "1");
  config.workspace = prepareWorkspace(config.workspace);
  url.searchParams.set("deviceId", config.deviceId);
  connection = new CompanionConnection({
  deviceId: config.deviceId,
  allowLegacyReady: process.env.PROVIDENCE_ALLOW_LEGACY_READY === "1",
  createRuntime: () => {
    let transcription: PrivateTranscriptionConfig | undefined;
    try { transcription = loadDeviceTranscription(config); }
    catch {
      console.error("Transcription unavailable: check this device's private provider configuration. File and shell work remain available.");
    }
    return new Runtime({ root: config.workspace, workerAccess: workerAccessForProvidence(config.workerAccess), workerModel: config.workerModel,
      workerReasoningEffort: config.workerReasoningEffort }, transcription);
  },
  createSocket: () => new WebSocket(url, {
    headers: { Authorization: `Bearer ${config.token}` },
    maxPayload: 1024 * 1024, handshakeTimeout: 15_000,
  }),
  metadata: runtime => runtimeMetadata(config.workspace, runtime.hasTranscription, runtime.transcriptionProvider, runtime.options.workerAccess, config.browserControl, awake.status),
  request: (runtime, method, params) => runtimeRequest(runtime, method, params),
  activity: (active, ttlMs) => { void awake.renewActivity(active, ttlMs); },
  status: status => {
    if (status.phase === "connected") {
      console.log(`Device ${config.deviceId} connected and acknowledged. Workspace: ${config.workspace}`);
      connection?.reportKeepAwake(awake.status);
    }
    else if (status.phase === "legacy_connected")
      console.log(`Device ${config.deviceId} connected in explicit legacy mode; readiness is unacknowledged. Workspace: ${config.workspace}`);
    else if (status.phase === "retrying")
      console.log(`Device offline (${status.reason}). Reconnecting in ${status.retryInMs! / 1000}s; interrupted work is not replayed.`);
    else if (status.phase === "action_required") {
      process.exitCode = 78;
      if (status.help) console.error(status.help);
      console.error(`Companion stopped (${status.reason}). Check this device's configuration, sign-in and registration before restarting. No sign-in, fallback or re-pairing was attempted.`);
      void shutdown(78);
    }
  },
  });
  watchedConfig = file;
  watchFile(file, { interval: 1000, persistent: false }, () => {
    try {
      const next = parseDeviceConfig(readFileSync(file, "utf8"));
      if (JSON.stringify({ ...next, keepAwake: undefined }) !== originalIdentity) return;
      void awake.setEnabled(next.keepAwake === true).catch(() => console.error("Keep-awake could not be updated. Check the local helper status."));
    } catch { console.error("Keep-awake preference could not be read. The existing setting was preserved."); }
  });
} catch {
  await awake.stop();
  process.exitCode = 78;
  console.error("Companion stopped (device_configuration). Check the private device file, endpoint and workspace. No credential or account change was attempted.");
}
let shuttingDown: Promise<void> | undefined;
const shutdown = (requestedCode: 0 | 75 | 78): Promise<void> => {
  if (shuttingDown) return shuttingDown;
  shuttingDown = (async () => {
    let code = requestedCode;
    if (watchedConfig) unwatchFile(watchedConfig);
    try { await connection?.stop(); }
    catch { code = 78; }
    finally { try { await awake.stop(); } catch { code = 78; } }
    process.exitCode = code;
    // Exit only this CLI after the bounded owned-child retirement settled.
    // An unconfirmed child is never force-killed or replaced by this process.
    process.stderr.write("", () => process.exit(code));
  })();
  return shuttingDown;
};
const stop = () => { void shutdown(0); };
const unexpected = () => {
  console.error("Companion stopped (unexpected_process_failure). No task was replayed.");
  void shutdown(75);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("uncaughtException", unexpected);
process.on("unhandledRejection", unexpected);
connection?.start();
