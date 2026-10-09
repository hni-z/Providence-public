/** Real same-computer HTTPS/WSS probe. This is not a physical Windows test.
 * Run: npx tsx scripts/probe-wss.ts https://coordinator /private/config.json
 * Reads credentials privately; prints only non-secret validation evidence.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const [publicOrigin, privateConfig] = process.argv.slice(2);
if (!publicOrigin || !privateConfig)
  throw new Error(
    "Usage: npx tsx scripts/probe-wss.ts https://coordinator /private/config.json",
  );
const origin = new URL(publicOrigin);
if (
  origin.protocol !== "https:" ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash
)
  throw new Error("Provide a plain HTTPS coordinator origin.");
const { clientToken } = JSON.parse(readFileSync(privateConfig, "utf8"));
assert.equal(typeof clientToken, "string");
const root = fileURLToPath(new URL("..", import.meta.url));
const runId = randomUUID().slice(0, 8);
const directory = resolve(root, ".providence", `wss-probe-${runId}`);
const workspace = resolve(directory, "workspace");
mkdirSync(workspace, { recursive: true, mode: 0o700 });
const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  origin: origin.origin,
  validationScope:
    "Real public HTTPS/WSS; companion and client both on the same physical Mac. Not DemoPC execution.",
  executorHostname: hostname(),
  executorPlatform: process.platform,
  workspace,
};
let worker: ChildProcess | undefined;
let workerEnded = false;
let registration: { deviceId: string; token: string; url: string } | undefined;
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  auth = true,
) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {
      ...(auth ? { Authorization: `Bearer ${clientToken}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const result = (await response.json()) as any;
  if (!response.ok)
    throw new Error(
      `${method} ${path}: HTTP ${response.status}; ${result.error ?? "request failed"}`,
    );
  return result;
}
async function until<T>(
  read: () => Promise<T | undefined | false>,
  timeoutMs = 180_000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Timed out waiting for the expected verified state.");
}
async function assertRevokedDeviceCannotReconnect() {
  const url = new URL(registration!.url);
  url.searchParams.set("deviceId", registration!.deviceId);
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${registration!.token}` },
      handshakeTimeout: 15_000,
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("Revocation proof timed out."));
    }, 20_000);
    ws.on("error", () => {});
    ws.on("open", () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error("Revoked device was incorrectly admitted."));
    });
    ws.on("unexpected-response", (_req, response) => {
      response.resume();
      clearTimeout(timer);
      ws.terminate();
      if (response.statusCode === 401) resolve();
      else
        reject(
          new Error(
            `Expected HTTP 401 after revocation, got ${response.statusCode}.`,
          ),
        );
    });
  });
}

try {
  const unauthenticated = await fetch(new URL("/v1/devices", origin));
  assert.equal(unauthenticated.status, 401);
  evidence.anonymousRequestsRejected = true;
  const pairing = await request("/v1/devices/pair", "POST", {
    name: `WSS proof ${runId} (same Mac)`,
  });
  registration = await request(
    "/pair/exchange",
    "POST",
    { code: pairing.code, name: hostname() },
    false,
  );
  assert.equal(new URL(registration!.url).protocol, "wss:");
  assert.equal(new URL(registration!.url).host, origin.host);
  evidence.deviceId = registration!.deviceId;
  const replay = await fetch(new URL("/pair/exchange", origin), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: pairing.code }),
  });
  assert.equal(replay.status, 400);
  evidence.pairingCodeSingleUse = true;
  const config = resolve(directory, "device.json");
  writeFileSync(config, JSON.stringify({ ...registration, workspace }), {
    mode: 0o600,
  });
  worker = spawn(
    process.execPath,
    ["--import", "tsx", "src/device.ts", config],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  worker.on("exit", () => {
    workerEnded = true;
  });
  worker.on("error", () => {
    workerEnded = true;
  });
  const device = await until(async () => {
    if (workerEnded)
      throw new Error("Companion exited before registration became online.");
    const response = await request("/v1/devices");
    assert.equal(JSON.stringify(response).includes(registration!.token), false);
    return response.devices.find(
      (d: any) => d.id === registration!.deviceId && d.online,
    );
  }, 45_000);
  assert.equal(device.hostname, hostname());
  assert.equal(device.platform, process.platform);
  assert.equal(device.capabilities.files, true);
  assert.equal(device.capabilities.desktop, false);
  evidence.readyMetadata = device;
  console.log(
    "PASS: authenticated companion connected through public WSS with actual Mac metadata (not Windows).",
  );

  const chat = await request("/v1/chats", "POST", {
    deviceId: registration!.deviceId,
    name: `Public WSS proof ${runId}`,
  });
  evidence.chatId = chat.id;
  const marker = `Providence public WSS proof ${runId}`;
  const prompt = {
    requestId: randomUUID(),
    text: `Create wss-proof.txt in your approved workspace containing exactly this one line followed by a newline: ${marker}\nRead the file back. Do not change any other file.`,
  };
  const task = await request(`/v1/chats/${chat.id}/messages`, "POST", prompt);
  evidence.taskId = task.id;
  const retry = await request(`/v1/chats/${chat.id}/messages`, "POST", prompt);
  assert.equal(retry.id, task.id);
  evidence.requestRetryReusedTask = true;
  const finished = await until(async () => {
    const current = await request(`/v1/tasks/${task.id}`);
    return ["queued", "running"].includes(current.status) ? false : current;
  });
  assert.equal(
    finished.status,
    "completed",
    `Task ended as ${finished.status}: ${finished.error ?? "inspect task"}`,
  );
  const bytes = readFileSync(resolve(workspace, "wss-proof.txt"));
  assert.equal(bytes.toString("utf8"), `${marker}\n`);
  const artifact = await request(`/v1/tasks/${task.id}/artifacts`, "POST", {
    path: "wss-proof.txt",
  });
  const download = await fetch(
    new URL(`/v1/artifacts/${artifact.id}/content`, origin),
    {
      headers: { Authorization: `Bearer ${clientToken}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert.equal(download.status, 200);
  const delivered = Buffer.from(await download.arrayBuffer());
  assert.deepEqual(delivered, bytes);
  assert.equal(
    artifact.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  evidence.artifact = artifact;
  evidence.fileIndependentlyRead = true;
  evidence.httpsDownloadMatchesLocalBytes = true;
  console.log(
    "PASS: real task output independently read; artifact returned through WSS and downloaded over HTTPS with matching bytes/hash.",
  );
} catch (error) {
  evidence.error =
    error instanceof Error ? error.message : "Unknown probe failure";
  throw error;
} finally {
  try {
    if (registration) {
      await request(`/v1/devices/${registration.deviceId}`, "DELETE");
      await until(
        async () =>
          !(await request("/v1/devices")).devices.some(
            (d: any) => d.id === registration!.deviceId,
          ),
        15_000,
      );
      await assertRevokedDeviceCannotReconnect();
      evidence.enrollmentRevoked = true;
      evidence.revokedCredentialRejected = true;
      console.log(
        "PASS: enrollment revoked, device removed, and its old WSS credential rejected with HTTP 401.",
      );
    }
  } finally {
    worker?.kill("SIGTERM");
    evidence.finishedAt = new Date().toISOString();
    const evidencePath = resolve(directory, "evidence.json");
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), {
      mode: 0o600,
    });
    console.log(`Non-secret validation evidence: ${evidencePath}`);
  }
}
