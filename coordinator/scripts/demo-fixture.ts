/**
 * A local coordinator wired to a scripted fake runtime, so the demonstration
 * sequence can be rehearsed and recorded in a browser without Codex, without a
 * second computer and without touching any real workspace. Everything except
 * the model is real: the HTTP server, the worker WebSocket, the artifact
 * verification and the store all run their production code paths.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { configSchema } from "../src/config.js";
import { Coordinator } from "../src/coordinator.js";
import { runtimeRequest } from "../src/devices.js";
import { runtimeMetadata } from "../src/device-config.js";
import { Runtime } from "../src/runtime.js";
import { createHttpServer } from "../src/server.js";

const BRIEF_REPLY_MS = 1500;
const GENERIC_REPLY_MS = 1000;
const DELTA_MS = 200;
const DECISION_DELAY_MS = 500;
const WRITE_FILE_MS = 700;
const COMPANION_RECONNECT_MS = 1000;

const LOCAL_DEVICE_ID = "mac";
const REMOTE_DEVICE_ID = "demoPC";

function refuse(line: string): never {
  console.error(line);
  process.exit(1);
}

/** The refusal that keeps this fixture away from a real Providence data directory. */
function checkDataDir() {
  const configured = process.env.PROVIDENCE_DATA_DIR;
  if (!configured || !existsSync(configured)) return;
  const temp = realpathSync(tmpdir());
  const target = realpathSync(configured);
  if (!target.startsWith(temp))
    refuse(
      `PROVIDENCE_DATA_DIR points at ${target}, which is not under ${temp}. The demo fixture only runs against temporary directories.`,
    );
}

function flags(argv: string[]) {
  let dropCompanionAfter: number | undefined;
  let hangTasksOnce = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--hang-tasks-once") hangTasksOnce = true;
    else if (argv[i] === "--drop-companion-after") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0)
        refuse("--drop-companion-after needs a whole number of milliseconds.");
      dropCompanionAfter = value;
    } else refuse(`Unknown option ${argv[i]}`);
  }
  return { dropCompanionAfter, hangTasksOnce };
}

const invitation = (tone: string) =>
  tone === "Formal"
    ? "You are cordially invited to join us at Cedar Table on Saturday at 6:30 PM.\n\nThe evening is held in recognition of our student volunteers, whose work made this season possible. Please reply with your attendance so that we may confirm the seating.\n\nInvitation tone: Formal.\n"
    : "You are invited to Cedar Table this Saturday at 6:30 PM, and we would love to see you there.\n\nIt is a thank-you dinner for our student volunteers, so come as you are and bring someone along. Send a quick note back if you can make it.\n\nInvitation tone: Friendly.\n";

const shortInvitation =
  "You are invited to Cedar Table this Saturday at 6:30 PM. It is a thank-you dinner for our student volunteers, so reply if you can come.\n";

const brief =
  "Noted: the event is at Cedar Table, Saturday at 6:30 PM, for student volunteers. I will use those facts when you ask for anything based on this brief.";

/**
 * Replaces one runtime's Codex transport with a script. The runtime itself is
 * untouched, so decisions, artifact verification and turn accounting behave
 * exactly as they do against a real provider.
 */
function scriptRuntime(runtime: Runtime, label: string, master = false) {
  const rpc = runtime.rpc;
  const cwds = new Map<string, string>();
  const delivered = new Set<string>();
  const cancelled = new Set<string>();
  let threads = 0;
  let turns = 0;
  const profile = runtime.profile;
  const resolved = {
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    serviceTier: profile.serviceTier,
  };
  const notify = (threadId: string, method: string, params: Record<string, unknown>) =>
    rpc.emit("notification", method, { ...params, threadId });

  async function say(threadId: string, turnId: string, text: string) {
    const itemId = randomUUID();
    const pieces = text.match(/[\s\S]{1,60}/g) ?? [text];
    for (const delta of pieces) {
      notify(threadId, "item/agentMessage/delta", { turnId, itemId, delta });
      await delay(DELTA_MS);
    }
    notify(threadId, "item/completed", {
      turnId,
      item: { id: itemId, type: "agentMessage", text },
    });
  }

  async function callTool(threadId: string, turnId: string, tool: string, args: unknown) {
    const result = await rpc.onRequest!(
      "item/tool/call",
      { threadId, turnId, tool, arguments: args, callId: randomUUID() },
      randomUUID(),
    );
    const text = result?.contentItems?.[0]?.text;
    if (!result?.success) throw new Error(String(text ?? "Tool call failed"));
    return typeof text === "string" ? text : "";
  }

  async function script(threadId: string, turnId: string, prompt: string) {
    if (master) {
      await delay(GENERIC_REPLY_MS);
      await say(
        threadId,
        turnId,
        "I can see the registered devices and chats. Ask me to direct work on one of them.",
      );
      return;
    }
    const cwd = cwds.get(threadId)!;
    if (/shorten|two sentences/i.test(prompt) && delivered.has(threadId)) {
      await say(threadId, turnId, "Cutting the invitation down to two sentences.");
      await delay(WRITE_FILE_MS);
      writeFileSync(join(cwd, "invitation.txt"), shortInvitation);
      await callTool(threadId, turnId, "providence_publish_artifact", { path: "invitation.txt" });
      await say(threadId, turnId, "invitation.txt is now two sentences and the revision is published.");
      return;
    }
    if (/invitation/i.test(prompt) && !delivered.has(threadId)) {
      await say(
        threadId,
        turnId,
        "Reading the brief for the venue, the time and the audience. One choice is needed before I write the file.",
      );
      await delay(DECISION_DELAY_MS);
      const answer = await callTool(threadId, turnId, "providence_request_decision", {
        question: "Which tone should the invitation take?",
        options: ["Friendly", "Formal"],
      });
      const choice = JSON.parse(answer)?.answers?.choice?.answers?.[0];
      const tone = choice === "Formal" ? "Formal" : "Friendly";
      await delay(WRITE_FILE_MS);
      writeFileSync(join(cwd, "invitation.txt"), invitation(tone));
      await callTool(threadId, turnId, "providence_publish_artifact", { path: "invitation.txt" });
      delivered.add(threadId);
      await say(
        threadId,
        turnId,
        `invitation.txt is written in the ${tone.toLowerCase()} tone and published.`,
      );
      return;
    }
    if (/brief|remember/i.test(prompt)) {
      await delay(BRIEF_REPLY_MS);
      await say(threadId, turnId, brief);
      return;
    }
    await delay(GENERIC_REPLY_MS);
    await say(threadId, turnId, "Done. Tell me what to work on next in this conversation.");
  }

  async function runTurn(threadId: string, turnId: string, prompt: string) {
    notify(threadId, "turn/started", { turnId, turn: { id: turnId } });
    let error: string | undefined;
    try {
      await script(threadId, turnId, prompt);
    } catch (e: any) {
      error = e.message;
    }
    const status = cancelled.has(turnId) ? "interrupted" : error ? "failed" : "completed";
    cancelled.delete(turnId);
    notify(threadId, "turn/completed", {
      turnId,
      turn: { id: turnId, status, ...(error ? { error: { message: error } } : {}) },
    });
  }

  rpc.start = async () => {};
  rpc.call = async (method: string, params: any = {}) => {
    switch (method) {
      case "account/read":
        return { account: { type: "fixture" } };
      case "model/list":
        return {
          data: [
            {
              model: profile.model,
              supportedReasoningEfforts: [{ reasoningEffort: profile.reasoningEffort }],
              serviceTiers: [{ id: profile.serviceTier }],
            },
          ],
          nextCursor: null,
        };
      case "thread/start": {
        const threadId = `${label}-thread-${++threads}`;
        cwds.set(threadId, params.cwd);
        return { thread: { id: threadId, cwd: params.cwd }, ...resolved };
      }
      case "thread/read": {
        const cwd = cwds.get(params.threadId);
        if (!cwd) throw new Error(`thread not loaded: ${params.threadId}`);
        return { thread: { id: params.threadId, cwd } };
      }
      case "thread/resume":
        return { thread: { id: params.threadId }, ...resolved };
      case "turn/start": {
        const turnId = `${label}-turn-${++turns}`;
        const prompt = params.input?.[0]?.text ?? "";
        setTimeout(() => void runTurn(params.threadId, turnId, prompt), 0);
        return { turn: { id: turnId } };
      }
      case "turn/interrupt":
        cancelled.add(params.turnId);
        return { interrupted: true };
      default:
        throw new Error(`The demo fixture has no script for ${method}`);
    }
  };
}

/** The remote companion, built the way src/device.ts builds the real one. */
function companion(url: string, token: string, runtime: Runtime, workspace: string) {
  let socket: WebSocket | undefined;
  let stopping = false;
  let retry: NodeJS.Timeout | undefined;
  let announce!: () => void;
  const ready = new Promise<void>((resolve) => (announce = resolve));
  const forward = (event: unknown) => {
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ kind: "event", event }));
  };
  runtime.on("event", forward);
  function connect() {
    if (stopping) return;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    socket = ws;
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          kind: "ready",
          metadata: runtimeMetadata(
            workspace,
            runtime.hasTranscription,
            runtime.transcriptionProvider,
          ),
        }),
      );
      announce();
    });
    ws.on("message", async (raw) => {
      let m: any;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.kind !== "request" || typeof m.id !== "string") return;
      try {
        const result = await runtimeRequest(runtime, m.method, m.params);
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ kind: "response", id: m.id, result }));
      } catch (e: any) {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ kind: "response", id: m.id, error: e.message }));
      }
    });
    ws.on("error", () => {});
  }
  connect();
  return {
    ready,
    /**
     * ceiling: the reconnect keeps the same runtime, so the scripted threads
     * survive the drop. A real companion starts a fresh executor and re-imports
     * each thread on its next task.
     */
    redial(afterMs: number) {
      socket?.close();
      retry = setTimeout(connect, afterMs);
    },
    stop() {
      stopping = true;
      clearTimeout(retry);
      runtime.off("event", forward);
      socket?.close();
      socket?.terminate();
      runtime.stop();
    },
  };
}

checkDataDir();
const { dropCompanionAfter, hangTasksOnce } = flags(process.argv.slice(2));
const webRoot = fileURLToPath(new URL("../web/dist", import.meta.url));
const questRoot = fileURLToPath(new URL("../quest/dist", import.meta.url));
if (!existsSync(join(webRoot, "index.html")))
  refuse("Build the web client first: npm run build:web");

const dataDir = mkdtempSync(join(tmpdir(), "providence-demo-"));
const localWorkspace = mkdtempSync(join(tmpdir(), "providence-demo-mac-"));
const remoteWorkspace = mkdtempSync(join(tmpdir(), "providence-demo-demoPC-"));
const temporary = [dataDir, localWorkspace, remoteWorkspace];
const deviceToken = randomBytes(32).toString("hex");
const config = configSchema.parse({
  clientToken: randomBytes(32).toString("hex"),
  localDeviceId: LOCAL_DEVICE_ID,
  localDeviceName: "MacBook",
  workspace: localWorkspace,
  devices: [{ id: REMOTE_DEVICE_ID, name: "DemoPC", token: deviceToken }],
});
// A fixture must never inherit a real deployment's browser origin; the loopback
// development exception admits the browser on its own.
delete process.env.PROVIDENCE_PUBLIC_ORIGIN;
delete process.env.PROVIDENCE_ALLOWED_ORIGINS;

const app = new Coordinator(config, dataDir);
scriptRuntime(app.master, "master", true);
scriptRuntime(app.devices.local, LOCAL_DEVICE_ID);
const server = createHttpServer(app, config.clientToken, {
  webRoot,
  questRoot,
  allowedOrigins: [],
});
if (hangTasksOnce) {
  const [handler] = server.listeners("request") as ((
    req: IncomingMessage,
    res: ServerResponse,
  ) => void)[];
  server.removeListener("request", handler);
  let armed = true;
  server.on("request", (req, res) => {
    // Never answering is what a dropped tunnel looks like to the browser, and it
    // needs no change to the server itself.
    if (armed && req.method === "GET" && (req.url ?? "").startsWith("/v1/tasks")) {
      armed = false;
      return;
    }
    handler(req, res);
  });
}

await app.start();
await new Promise<void>((r) => server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", r));
const { port } = server.address() as { port: number };
const remoteRuntime = new Runtime({ root: remoteWorkspace });
scriptRuntime(remoteRuntime, REMOTE_DEVICE_ID);
await remoteRuntime.start();
const remote = companion(
  `ws://127.0.0.1:${port}/worker?deviceId=${REMOTE_DEVICE_ID}`,
  deviceToken,
  remoteRuntime,
  remoteWorkspace,
);
await remote.ready;
// The printed block must not promise a device the coordinator has not registered yet.
while (!app.devices.online(REMOTE_DEVICE_ID)) await delay(25);
if (dropCompanionAfter !== undefined)
  setTimeout(() => remote.redial(COMPANION_RECONNECT_MS), dropCompanionAfter);

console.log("Providence demo fixture");
console.log(`  Open:          http://127.0.0.1:${port}`);
console.log(`  Workspace key: ${config.clientToken}`);
console.log(`  Data dir:      ${dataDir}`);
console.log(`  Devices:       ${LOCAL_DEVICE_ID} (local), ${REMOTE_DEVICE_ID} (companion)`);

process.on("SIGINT", () => {
  remote.stop();
  app.stop();
  server.close();
  // The companion's close still records a device event, so the directories go
  // after that last write rather than before it.
  setTimeout(() => {
    for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  }, 500);
});
