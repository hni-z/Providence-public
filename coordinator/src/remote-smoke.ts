import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { Coordinator } from "./coordinator.js";
import { createHttpServer } from "./server.js";
const directory = resolve(
  ".providence",
  `remote-smoke-${randomUUID().slice(0, 8)}`,
);
const localRoot = resolve(directory, "local"),
  remoteRoot = resolve(directory, "remote");
mkdirSync(localRoot, { recursive: true });
mkdirSync(remoteRoot, { recursive: true });
const clientToken = randomBytes(32).toString("hex"),
  workerToken = randomBytes(32).toString("hex");
const app = new Coordinator(
  {
    clientToken,
    localDeviceId: "local-test",
    localDeviceName: "Local test",
    workspace: localRoot,
    devices: [
      {
        id: "remote-test",
        name: "Second process on SAME Mac",
        token: workerToken,
      },
    ],
  },
  directory,
);
const server = createHttpServer(app, clientToken);
let worker: ReturnType<typeof spawn> | undefined;
async function waitUntil(check: () => boolean, timeout = 180000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 250));
  }
}
try {
  await app.start();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const configPath = resolve(directory, "device.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      deviceId: "remote-test",
      token: workerToken,
      url: `ws://127.0.0.1:${port}/worker`,
      workspace: remoteRoot,
    }),
    { mode: 0o600 },
  );
  worker = spawn(
    process.execPath,
    ["--import", "tsx", "src/device.ts", configPath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  worker.stderr?.on("data", (d) => process.stderr.write(d));
  await waitUntil(() => app.devices.online("remote-test"), 30000);
  console.log(
    "PASS: authenticated second companion connected over WebSocket (same Mac, not Windows)",
  );
  const source = await app.createChat("local-test", "Brief");
  source.history.push({
    role: "user",
    text: "The exact event title is Blue Lantern. Use it as the document title.",
    taskId: "fixture-context",
  });
  app.store.save();
  const destination = await app.createChat("remote-test", "Remote document");
  const task = await app.dispatch(destination.id, {
    requestId: randomUUID(),
    text: "Create result.txt in your workspace containing the exact event title from the supplied brief. Do not modify anything else. Read it back to verify.",
    sourceChatIds: [source.id],
  });
  await waitUntil(
    () => !["queued", "running"].includes(app.task(task.id).status),
  );
  assert.equal(
    app.task(task.id).status,
    "completed",
    app.task(task.id).error ?? "Task requested input",
  );
  assert.equal(
    readFileSync(resolve(remoteRoot, "result.txt"), "utf8").trim(),
    "Blue Lantern",
  );
  assert.ok(
    app.store.state.events.some(
      (e) => e.type === "context.transferred" && e.taskId === task.id,
    ),
  );
  console.log(
    "PASS: cross-chat context transferred; second companion wrote and verified real output",
  );
  worker.kill("SIGTERM");
  await waitUntil(() => !app.devices.online("remote-test"), 10000);
  await assert.rejects(
    app.dispatch(destination.id, {
      requestId: randomUUID(),
      text: "do not run while offline",
    }),
    /offline/,
  );
  console.log("PASS: disconnect is visible and offline dispatch rejected");
  console.log(`Evidence workspace: ${directory}`);
} finally {
  worker?.kill("SIGTERM");
  app.stop();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}
