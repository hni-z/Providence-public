/** Exercise an EXISTING Providence connection without changing its setup.
 * Creates one diagnostic conversation and one unique file in its approved workspace.
 * Never pairs/revokes, changes credentials/checkouts, or starts/stops a server/companion.
 * Usage: npx tsx scripts/probe-existing-device.ts https://coordinator /private/config.json --device DemoPC --expected-host DemoPC
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const usage =
  "npx tsx scripts/probe-existing-device.ts https://coordinator /private/config.json --device <exact-id-or-name> [--expected-host DemoPC]";
const deviceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  online: z.boolean(),
  platform: z.string().optional(),
  hostname: z.string().optional(),
  workspace: z.string().optional(),
  capabilities: z.object({ files: z.boolean(), shell: z.boolean() }).optional(),
});
export type ExistingDevice = z.infer<typeof deviceSchema>;
export type ProbeOptions = {
  origin: string;
  privateConfig: string;
  selector: string;
  expectedHost?: string;
};
export type ExecutorProof = {
  nonce: string;
  hostname: string;
  platform: string;
  revision: number;
  verifiedVia?: string;
};

export function parseProbeOptions(args: string[]): ProbeOptions {
  if (args.length < 4) throw new Error(`Usage: ${usage}`);
  const [origin, privateConfig, ...flags] = args;
  let selector: string | undefined, expectedHost: string | undefined;
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i],
      value = flags[i + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${key}.`);
    if (key === "--device" && !selector) selector = value;
    else if (key === "--expected-host" && !expectedHost) expectedHost = value;
    else throw new Error(`Unknown or repeated option ${key}. Usage: ${usage}`);
  }
  if (!selector)
    throw new Error(
      "Provide --device with an exact existing device ID or name.",
    );
  const url = new URL(origin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use a plain HTTPS coordinator origin, or HTTP on loopback only. Do not include credentials in the URL.",
    );
  return { origin: url.origin, privateConfig, selector, expectedHost };
}

export function selectExistingDevice(
  input: unknown,
  selector: string,
  expectedHost?: string,
): ExistingDevice {
  const { devices } = z.object({ devices: z.array(deviceSchema) }).parse(input);
  const ids = devices.filter((device) => device.id === selector);
  const matches = ids.length
    ? ids
    : devices.filter((device) => device.name === selector);
  if (!matches.length)
    throw new Error(
      `No existing Providence device exactly matches "${selector}". Verify the active coordinator and device ID/name; this diagnostic does not pair devices. Codex Remote is a separate connection.`,
    );
  if (matches.length !== 1)
    throw new Error(
      `More than one existing device matches "${selector}". Use its exact unique device ID.`,
    );
  const device = matches[0];
  if (!device.online)
    throw new Error(
      `Existing device "${device.name}" (${device.id}) is offline. Restore its current companion connection; no setup was changed.`,
    );
  if (!device.hostname || !device.platform || !device.workspace)
    throw new Error(
      "The existing device has no complete runtime identity/workspace metadata. Inspect its current companion before executing a diagnostic.",
    );
  if (
    device.capabilities?.files !== true ||
    device.capabilities?.shell !== true
  )
    throw new Error(
      "The existing device does not advertise both files and shell execution.",
    );
  if (
    expectedHost &&
    device.hostname.toLowerCase() !== expectedHost.toLowerCase()
  )
    throw new Error(
      `Runtime hostname "${device.hostname}" does not match expected "${expectedHost}". No task was dispatched.`,
    );
  if (expectedHost?.toLowerCase() === "demopc" && device.platform !== "win32")
    throw new Error(
      `DemoPC requires runtime platform win32; received "${device.platform}". No task was dispatched.`,
    );
  return device;
}

export function verifyExecutorProof(
  bytes: Buffer,
  sha256: string,
  nonce: string,
  device: ExistingDevice,
  expectedHost: string | undefined,
  revision: number,
): ExecutorProof {
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    sha256,
    "Downloaded artifact hash differs from the verified artifact record.",
  );
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("The downloaded executor proof is not valid JSON.");
  }
  const proof = z
    .object({
      nonce: z.string(),
      hostname: z.string().min(1),
      platform: z.string().min(1),
      revision: z.number().int(),
      verifiedVia: z.string().optional(),
    })
    .parse(value);
  assert.equal(
    proof.nonce,
    nonce,
    "Executor output nonce does not match this diagnostic.",
  );
  assert.equal(
    proof.revision,
    revision,
    "Executor output has the wrong revision.",
  );
  assert.equal(
    proof.hostname.toLowerCase(),
    device.hostname?.toLowerCase(),
    "File-recorded hostname differs from the connected runtime identity.",
  );
  assert.equal(
    proof.platform,
    device.platform,
    "File-recorded platform differs from the connected runtime identity.",
  );
  if (expectedHost)
    assert.equal(
      proof.hostname.toLowerCase(),
      expectedHost.toLowerCase(),
      "File-recorded hostname differs from the expected device.",
    );
  if (expectedHost?.toLowerCase() === "demopc")
    assert.equal(proof.platform, "win32", "DemoPC proof must come from Windows.");
  if (revision === 2)
    assert.equal(
      proof.verifiedVia,
      "followup",
      "Second revision did not preserve the requested follow-up marker.",
    );
  return proof;
}

export async function probeExistingDevice(options: ProbeOptions) {
  let clientToken: string;
  try {
    const config = JSON.parse(
      readFileSync(options.privateConfig, "utf8").replace(/^\uFEFF/, ""),
    );
    clientToken = z.string().min(32).parse(config.clientToken);
  } catch {
    throw new Error(
      "Could not read a valid clientToken from the supplied private config. Credentials were not printed or changed.",
    );
  }
  const origin = new URL(options.origin);
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(new URL(path, origin), {
      method,
      headers: {
        Authorization: `Bearer ${clientToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await response.json()) as any;
    if (!response.ok)
      throw new Error(
        `${method} ${path}: HTTP ${response.status}; ${data.error ?? "request failed"}`,
      );
    return data;
  };
  // All identity/connection checks precede creating a conversation or dispatching work.
  const device = selectExistingDevice(
    await request("/v1/devices"),
    options.selector,
    options.expectedHost,
  );
  const runId = randomUUID();
  const nonce = randomUUID();
  const filename = `providence-existing-${runId}.json`;
  const root = fileURLToPath(new URL("..", import.meta.url));
  const directory = resolve(
    root,
    ".providence",
    `existing-device-proof-${runId}`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const evidence: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    origin: options.origin,
    scope:
      "Authenticated API diagnostic using an existing Providence registration. This does not prove a real browser client, desktop GUI control, or Codex Remote integration.",
    client: { hostname: hostname(), platform: process.platform },
    target: device,
    expectedHost: options.expectedHost,
    nonce,
    filename,
    setupUnchanged:
      "No pairing, revocation, credential writes, checkout changes or process/server startup/shutdown performed.",
  };
  const completedTask = async (id: string) => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const task = await request(`/v1/tasks/${encodeURIComponent(id)}`);
      if (task.status === "completed") return task;
      if (!["queued", "running"].includes(task.status))
        throw new Error(
          `Diagnostic task ${id} is ${task.status}. Inspect it before continuing; the diagnostic will not automatically approve, cancel, or resubmit it.`,
        );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      `Diagnostic task ${id} has not completed within three minutes. Inspect it before retrying; it was not cancelled or resubmitted.`,
    );
  };
  const downloadArtifact = async (id: string): Promise<Buffer> => {
    const response = await fetch(
      new URL(`/v1/artifacts/${encodeURIComponent(id)}/content`, origin),
      {
        headers: { Authorization: `Bearer ${clientToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new Error(`Artifact download failed: HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 512 * 1024)
      throw new Error("Diagnostic artifact exceeds the expected bounded size.");
    return bytes;
  };
  const sendOnceWithRetryCheck = async (chatId: string, prompt: string) => {
    const input = { requestId: randomUUID(), text: prompt };
    const task = await request(
      `/v1/chats/${encodeURIComponent(chatId)}/messages`,
      "POST",
      input,
    );
    const retried = await request(
      `/v1/chats/${encodeURIComponent(chatId)}/messages`,
      "POST",
      input,
    );
    assert.equal(
      retried.id,
      task.id,
      "Identical request ID did not return the same task.",
    );
    return task;
  };
  try {
    console.log(
      `API client: ${hostname()} (${process.platform}). Existing target: ${device.hostname} (${device.platform}), device ${device.id}.`,
    );
    const chat = await request("/v1/chats", "POST", {
      deviceId: device.id,
      name: `Existing-device diagnostic ${runId.slice(0, 8)}`,
    });
    evidence.chatId = chat.id;
    evidence.providerThreadId = chat.threadId;
    const initial = await sendOnceWithRetryCheck(
      chat.id,
      `This is a harmless diagnostic in your already approved workspace. Create ONLY a new file named ${filename}, using exclusive creation so an existing file is never overwritten. Its JSON must contain nonce ${JSON.stringify(nonce)}, revision 1, hostname and platform. Obtain hostname using Node's os.hostname() and platform using process.platform at execution time. Do not hard-code or infer either identity value. Read the actual file back to verify it. Do not change configuration, credentials, repository state, or any other file. Do not start or stop servers or companions.`,
    );
    evidence.initialTaskId = initial.id;
    await completedTask(initial.id);
    const first = await request(
      `/v1/tasks/${encodeURIComponent(initial.id)}/artifacts`,
      "POST",
      { path: filename },
    );
    const firstBytes = await downloadArtifact(first.id);
    assert.equal(first.deviceId, device.id);
    assert.equal(first.taskId, initial.id);
    assert.equal(first.path, filename);
    assert.equal(first.size, firstBytes.length);
    assert.ok(Number.isInteger(first.revision) && first.revision >= 1);
    const firstProof = verifyExecutorProof(
      firstBytes,
      first.sha256,
      nonce,
      device,
      options.expectedHost,
      1,
    );
    evidence.initialArtifact = first;
    evidence.initialProof = firstProof;
    writeFileSync(resolve(directory, "revision-1.json"), firstBytes, {
      mode: 0o600,
      flag: "wx",
    });
    console.log(
      "PASS: existing executor produced a fresh nonce and runtime identity; authenticated artifact bytes and hash verified.",
    );

    const followup = await sendOnceWithRetryCheck(
      chat.id,
      "Continue the previous diagnostic in this same conversation. Revise ONLY the JSON proof file you created in the previous task: preserve its filename and nonce, set revision to 2, add verifiedVia equal to followup, and refresh hostname with Node's os.hostname() and platform with process.platform at execution time. Read the revised file back. Do not change any other files, setup, credentials, repository state, or running processes.",
    );
    evidence.followupTaskId = followup.id;
    await completedTask(followup.id);
    const second = await request(
      `/v1/tasks/${encodeURIComponent(followup.id)}/artifacts`,
      "POST",
      { path: filename },
    );
    const secondBytes = await downloadArtifact(second.id);
    assert.equal(second.deviceId, device.id);
    assert.equal(second.taskId, followup.id);
    assert.equal(second.chatId, chat.id);
    assert.equal(second.path, filename);
    assert.equal(second.size, secondBytes.length);
    assert.ok(
      second.revision > first.revision,
      "Follow-up artifact did not advance the stored revision.",
    );
    assert.notEqual(second.id, first.id);
    assert.notEqual(second.sha256, first.sha256);
    const secondProof = verifyExecutorProof(
      secondBytes,
      second.sha256,
      nonce,
      device,
      options.expectedHost,
      2,
    );
    const originalAgain = await downloadArtifact(first.id);
    assert.deepEqual(
      originalAgain,
      firstBytes,
      "A later revision changed the first immutable artifact.",
    );
    assert.equal(
      createHash("sha256").update(originalAgain).digest("hex"),
      first.sha256,
    );
    const chats = await request("/v1/chats");
    const continued = chats.chats.find(
      (candidate: any) => candidate.id === chat.id,
    );
    assert.equal(
      continued?.threadId,
      chat.threadId,
      "The follow-up changed provider conversation identity.",
    );
    evidence.followupArtifact = second;
    evidence.followupProof = secondProof;
    evidence.identicalRequestIdsReusedTasks = true;
    evidence.priorArtifactBytesRemainUnchanged = true;
    evidence.sameProviderConversation = true;
    writeFileSync(resolve(directory, "revision-2.json"), secondBytes, {
      mode: 0o600,
      flag: "wx",
    });
    console.log(
      "PASS: follow-up revised the same file/conversation; previous artifact bytes remain immutable; retried requests reused their task IDs.",
    );
  } catch (error) {
    evidence.error =
      error instanceof Error ? error.message : "Unknown diagnostic failure";
    throw error;
  } finally {
    evidence.finishedAt = new Date().toISOString();
    const evidencePath = resolve(directory, "evidence.json");
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), {
      mode: 0o600,
    });
    console.log(`Non-secret evidence: ${evidencePath}`);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  if (process.argv.includes("--help")) console.log(usage);
  else {
    try {
      await probeExistingDevice(parseProbeOptions(process.argv.slice(2)));
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : "Diagnostic failed.",
      );
      process.exitCode = 1;
    }
  }
}
