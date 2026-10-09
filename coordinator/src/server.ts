import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { ActivityLeases } from "./activity.js";
import { workflowManifestSchema } from "./workflow-manifest.js";
import { readFileSync, existsSync } from "node:fs";
import nodePath, { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Pairing } from "./pairing.js";
import { ClientSessions } from "./client-sessions.js";
import { loadRelease } from "./release.js";
import { approvalResponseSchema } from "./approval-protocol.js";
import { HostBridgeJobs, HostBridgeError } from "./host-bridge.js";
import {
  TranscriptionJobs,
  TranscriptionError,
  MAX_AUDIO_BYTES,
  audioMimeSchema,
} from "./transcription.js";
import { Coordinator } from "./coordinator.js";
import { loadConfig, dataDir, tokenMatches } from "./config.js";
import { Speech, SpeechError, MAX_SPEECH_CHARS, MAX_SPEECH_AUDIO_BYTES } from "./speech.js";
import { providerLabel } from "./voice-config.js";
import { executionTargetSchema, RequestNotAcceptedError } from "./iphone-mirroring-route.js";
import { LiveTranscriptionAccessError, LiveTranscriptionTickets } from "./live-transcription-auth.js";
import { admissionQueueCapabilities } from "./admission-queue.js";
import { LIVE_TRANSCRIPTION_MODEL, liveTranscriptionFactory, loadLiveTranscriptionCredentials,
  type LiveTranscriptionFactory, type LiveTranscriptionConnection } from "./provider-live-transcription.js";
const liveAudioLimits = { sampleRate: 24000, channels: 1, encoding: "pcm16le", maxDurationMs: 25000, maxAudioBytes: 1_200_000, maxChunkBytes: 4800 } as const;
const liveClientFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("audio"), seq: z.number().int().min(0).max(599), audio: z.string().min(4).max(6400) }).strict(),
  z.object({ type: z.literal("finish"), lastSeq: z.number().int().min(-1).max(599) }).strict(),
  z.object({ type: z.literal("cancel") }).strict(),
]);
const message = z.object({
  requestId: z.string().min(1).max(200),
  text: z.string().trim().min(1).max(30000),
  executionTarget: executionTargetSchema.optional(),
  workflow: workflowManifestSchema.optional(),
  queueIfBusy: z.boolean().optional(),
});
export async function readBody(req: IncomingMessage, maxBytes = 128000) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes)
      throw new Error(
        `Request body exceeds ${Math.floor(maxBytes / 1024)} KiB`,
      );
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
/** Resolves a request path inside a build's assets directory, or null when it
 * escapes. The path module is a parameter so either platform can be checked. */
export function assetFile(root: string, pathname: string, path = nodePath) {
  const file = path.resolve(root, "." + pathname);
  return file.startsWith(path.resolve(root, "assets") + path.sep) ? file : null;
}
/** A configured origin may carry a trailing slash or a default port; browsers
 * send neither, so compare on the canonical form. */
function normalizeOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}
const isLoopback = (address: string) =>
  address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127.");
export function createHttpServer(
  app: Coordinator,
  token: string,
  options: {
    publicOrigin?: string;
    webRoot?: string;
    questRoot?: string;
    allowedOrigins?: string[];
    liveTranscriptionFactory?: LiveTranscriptionFactory;
    hostedVoice?: { speech: Speech; transcribe: (input: unknown) => Promise<any> };
    clientLifetimeMs?: number;
    activity?: ActivityLeases;
  } = {},
) {
  const configuredOrigin =
    options.publicOrigin ?? process.env.PROVIDENCE_PUBLIC_ORIGIN;
  const publicOrigin = configuredOrigin
    ? normalizeOrigin(configuredOrigin.trim())
    : configuredOrigin;
  const allowedOrigins = new Set(
    [
      publicOrigin,
      ...(options.allowedOrigins ??
        (process.env.PROVIDENCE_ALLOWED_ORIGINS ?? "")
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)),
    ]
      .filter((value): value is string => Boolean(value))
      .map(normalizeOrigin),
  );
  const webRoot =
    options.webRoot ?? fileURLToPath(new URL("../web/dist", import.meta.url));
  const questRoot =
    options.questRoot ??
    fileURLToPath(new URL("../quest/dist", import.meta.url));
  const pairing = new Pairing(app, publicOrigin);
  const clients = new ClientSessions(
    resolve(app.directory, "client-sessions.json"), Date.now, undefined, options.clientLifetimeMs,
  );
  const hostBridge = new HostBridgeJobs({
    file: resolve(app.directory, "host-bridge.json"),
  });
  const transcriptions = new TranscriptionJobs({
    file: resolve(app.directory, "transcriptions.json"),
    workerTranscribe: async (deviceId, audio) => {
      if (options.hostedVoice && deviceId === "providence-voice") return options.hostedVoice.transcribe(audio);
      const device = app.devices.list().find((d) => d.id === deviceId);
      if (!device?.online || !device.capabilities?.transcription)
        throw new TranscriptionError("provider_not_configured");
      return app.devices.call(deviceId, "audio.transcribe", audio);
    },
    // Identity only: the transcript reaches its own requester through the job route, so it
    // is never broadcast to every authenticated client or persisted a second time.
    onChange: ({ id, requestId, deviceId, status, errorCode }) =>
      app.store.event({
        type: "transcription.updated",
        job: {
          id,
          requestId,
          deviceId,
          status,
          ...(errorCode ? { errorCode } : {}),
        },
      }),
  });
  const failedPairings = new Map<string, { count: number; until: number }>();
  const speech = options.hostedVoice?.speech ?? new Speech(app.config);
  const transcriptionDevices = () => [
    ...(options.hostedVoice ? [{ id: "providence-voice", name: "Providence voice", online: true, capabilities: { transcription: true }, transcriptionProvider: "OpenAI", source: "hosted" as const }] : []),
    ...app.devices.list().map(device => ({ ...device, source: "device" as const })),
  ];
  const liveTickets = new LiveTranscriptionTickets();
  const liveCredentials = process.env.PROVIDENCE_LIVE_TRANSCRIPTION === "1" ? loadLiveTranscriptionCredentials(app.config) : undefined;
  const connectLive = options.liveTranscriptionFactory ?? (liveCredentials
    ? liveTranscriptionFactory(liveCredentials.apiKey, "wss://api.openai.com/v1/realtime?intent=transcription") : undefined);
  const liveConnections = new Map<string, () => void>();
  const release={...loadRelease(),startedAt:new Date().toISOString()};
  // Build provenance and asset hashes are public; the host runtime version is not.
  const publicRelease = Object.fromEntries(
    Object.entries(release).filter(([field]) => field !== "nodeVersion"),
  );
  const activity = options.activity ?? new ActivityLeases();
  const renewPower = () => app.devices.requestKeepAwake(activity.wanted(app.hasActiveWork()));
  const activityTimer = setInterval(renewPower, 10_000);
  activityTimer.unref();
  app.devices.on("online", renewPower);
  const server = createServer(async (req, res) => {
    const send = (code: number, value: any) => {
      res.writeHead(code, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return send(400, { error: "Invalid request URL" });
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (req.method === "GET" && url.pathname === "/version") return send(200,publicRelease);
    if (req.method === "GET" && url.pathname === "/health")
      return send(200, {
        status: app.storeDegraded ? "degraded" : "ok",
        service: "providence",
        storeDegraded: app.storeDegraded,
      });
    const origin = req.headers.origin;
    const host = req.headers.host ?? "";
    // The Host header comes from the client, so the same-origin development
    // exception also needs a loopback socket and an otherwise empty allowlist.
    const sameOriginDev =
      allowedOrigins.size === 0 &&
      isLoopback(req.socket.localAddress ?? "") &&
      /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
    if (
      origin &&
      !allowedOrigins.has(origin) &&
      !(sameOriginDev && origin === `http://${host}`)
    )
      return send(403, { error: "Browser origin is not allowed" });
    if (req.method === "GET" && url.pathname === "/bootstrap/windows.ps1") {
      try {
        const script = readFileSync(
          fileURLToPath(
            new URL("../scripts/start-windows.ps1", import.meta.url),
          ),
        );
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(script);
      } catch {
        send(404, { error: "Windows setup script unavailable" });
      }
      return;
    }
    if (
      req.method === "POST" &&
      ["/pair/exchange", "/client/exchange"].includes(url.pathname)
    ) {
      const address = req.socket.remoteAddress ?? "unknown";
      const rateKey = `${url.pathname}:${address}`;
      for (const [key, rate] of failedPairings)
        if (rate.until <= Date.now()) failedPairings.delete(key);
      const rate = failedPairings.get(rateKey);
      const limited = Boolean(rate && rate.until > Date.now() && rate.count >= 20);
      try {
        let code: string;
        try {
          ({ code } = z
            .object({ code: z.string().min(1).max(50) })
            .parse(await readBody(req)));
        } catch (error) {
          if (url.pathname === "/client/exchange") clients.rejectExchange();
          throw error;
        }
        const result =
          url.pathname === "/client/exchange"
            ? clients.exchange(code)
            : pairing.exchange(code);
        return send(200, result);
      } catch (e: any) {
        // Re-read after the awaited body: concurrent failures must all count.
        const latest = failedPairings.get(rateKey);
        if (!latest || latest.until <= Date.now())
          failedPairings.set(rateKey, { count: 1, until: Date.now() + 60000 });
        else latest.count++;
        // Only failures are refused while the address is limited. Everyone
        // behind a tunnel shares one address, so a live code must still redeem.
        if (limited)
          return send(429, {
            error: "Too many pairing attempts; try again later",
          });
        return send(400, { error: e.message });
      }
    }
    if (
      req.method === "GET" &&
      !url.pathname.startsWith("/v1/") &&
      url.pathname !== "/worker"
    ) {
      const quest =
        url.pathname === "/meta" || url.pathname === "/meta/" || url.pathname === "/quest" || url.pathname.startsWith("/quest/");
      const root = quest ? questRoot : webRoot;
      const pathname = quest
        ? url.pathname.startsWith("/meta") ? "/" : url.pathname.slice("/quest".length)
        : url.pathname;
      const asset =
        pathname.startsWith("/assets/") || pathname === "/favicon.svg";
      const file = !asset
        ? resolve(root, url.pathname === "/privacy" || url.pathname === "/privacy/" ? "privacy.html" : "index.html")
        : pathname === "/favicon.svg"
          ? resolve(root, "favicon.svg")
          : assetFile(root, pathname);
      if (!file || !existsSync(file))
        return send(404, {
          error: quest
            ? "Build the Quest client with npm --prefix quest run build"
            : "Build the Providence web client with npm run build:web",
        });
      const mime = asset
        ? ({
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".woff2": "font/woff2",
          }[extname(file)] ?? "application/octet-stream")
        : "text/html";
      try {
        const bytes = readFileSync(file);
        res.writeHead(200, {
          "Content-Type": mime,
          "Cache-Control": asset
            ? "public, max-age=31536000, immutable"
            : "no-store",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          ...(quest
            ? {
                "Permissions-Policy":
                  "microphone=(self), xr-spatial-tracking=(self)",
              }
            : {}),
        });
        res.end(bytes);
      } catch {
        send(404, { error: "Web asset unavailable" });
      }
      return;
    }
    const owner = tokenMatches(req.headers.authorization, `Bearer ${token}`);
    if (!owner && !clients.accepts(req.headers.authorization))
      return send(401, { error: "Unauthorized" });
    try {
      const parts = url.pathname.split("/").filter(Boolean);
      if (req.method === "POST" && url.pathname === "/v1/activity") {
        const body = z.object({ clientId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/), active: z.boolean() }).strict().parse(await readBody(req, 1024));
        activity.touch(body.clientId, body.active); renewPower(); return send(200, { ok: true });
      }
      // A client session is a trusted browser or Watch controller grant.
      // Credential management remains exclusive to the workspace owner.
      const credentialRoute =
        (req.method === "POST" &&
          ["/v1/devices/pair", "/v1/clients/pair"].includes(url.pathname)) ||
        (req.method === "DELETE" &&
          parts[0] === "v1" &&
          ["devices", "clients"].includes(parts[1]) &&
          parts.length === 3) ||
        (req.method === "GET" && url.pathname === "/v1/clients");
      if (credentialRoute && !owner)
        return send(403, {
          error: "Device and client credentials require workspace-owner authentication",
        });
      if (req.method === "GET" && url.pathname === "/v1/voice") {
        const local = app.devices.list().find(device => device.id === app.config.localDeviceId);
        return send(200, { provider: speech.provider, configured: speech.configured,
          speechConfigured: speech.configured,
          transcriptionConfigured: !!options.hostedVoice || (local?.online === true && local.capabilities?.transcription === true),
          transcriptionProvider: local?.transcriptionProvider ?? providerLabel(app.config.transcriptionProvider ?? "openai"),
          ...(speech.unavailableReason ? { reason: speech.unavailableReason } : {}),
          deviceId: options.hostedVoice ? "providence-voice" : app.config.localDeviceId, voice: speech.voice ?? null,
          admissionQueue: admissionQueueCapabilities(),
          liveTranscription: { available: !!connectLive, transport: "websocket", ticketPath: "/v1/transcriptions/live-sessions",
            websocketPath: "/v1/transcriptions/live", model: LIVE_TRANSCRIPTION_MODEL, ...liveAudioLimits },
          maxSpeechChars: MAX_SPEECH_CHARS, maxAudioBytes: MAX_AUDIO_BYTES,
          maxSpeechAudioBytes: MAX_SPEECH_AUDIO_BYTES });
      }
      if (req.method === "POST" && url.pathname === "/v1/transcriptions/live-sessions") {
        if (!connectLive) return send(503, { error: "Live transcription is unavailable.", errorCode: "live_transcription_unavailable" });
        if (liveConnections.size >= 4) return send(429, { error: "Live transcription is busy. Try again later." });
        const body = z.object({ requestId: z.string().min(1).max(200) }).strict().parse(await readBody(req, 1024));
        const authorization = req.headers.authorization!;
        const ticket = liveTickets.issue(authorization, body.requestId, req.headers.origin,
          () => tokenMatches(authorization, `Bearer ${token}`) || clients.accepts(authorization));
        return send(201, { ...ticket, websocketPath: "/v1/transcriptions/live" });
      }
      if (req.method === "POST" && url.pathname === "/v1/speech") {
        const body = await readBody(req, 20000);
        const controller = new AbortController();
        const stopped = () => { if (!res.writableEnded) controller.abort(); };
        res.once("close", stopped);
        try {
          const audio = await speech.synthesize(body, controller.signal);
          if (!res.destroyed) {
            res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "Content-Length": audio.length });
            res.end(audio);
          }
        } finally { res.off("close", stopped); }
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/host-bridge")
        return send(200, {
          mode: "manual-single-job",
          action: "htn-task-inventory",
          actions: ["htn-task-inventory", "mac-chrome-typing-proof"],
          readiness: "manual-consumer-required",
          arbitraryTasks: false,
          description: "A user-authorized task inside Codex must claim one fixed-scope job. Queue acceptance is not execution.",
        });
      if (url.pathname === "/v1/host-bridge/jobs") {
        if (req.method === "GET") return send(200, { jobs: hostBridge.list() });
        if (req.method === "POST")
          return send(202, { job: hostBridge.create(await readBody(req)) });
      }
      if (parts[0] === "v1" && parts[1] === "host-bridge" && parts[2] === "jobs") {
        const jobId = parts[3];
        if (req.method === "GET" && parts.length === 4)
          return send(200, { job: hostBridge.get(jobId) });
        if (req.method === "POST" && parts.length === 5 && ["claim", "start", "complete", "fail"].includes(parts[4])) {
          if (!owner)
            return send(403, { error: "Host consumer operations require workspace-owner authentication" });
          const body = await readBody(req);
          if (parts[4] === "claim") return send(200, hostBridge.claim(jobId, body));
          if (parts[4] === "start") return send(200, { job: hostBridge.start(jobId, body) });
          if (parts[4] === "complete") return send(200, { job: hostBridge.complete(jobId, body) });
          return send(200, { job: hostBridge.fail(jobId, body) });
        }
      }
      if(req.method==='GET' && url.pathname==='/v1/version') return send(200,publicRelease);
      if (req.method === "GET" && url.pathname === "/v1/transcriptions") {
        const devices = transcriptionDevices()
          .map((d) => ({
            id: d.id,
            name: d.name,
            online: d.online,
            configured: d.capabilities?.transcription === true,
            source: d.source,
            ...(d.capabilities?.transcription ? { provider: d.transcriptionProvider ?? "OpenAI" } : {}),
          }));
        return send(200, {
          transcription: {
            available: devices.some((d) => d.online && d.configured),
            devices,
            mimeTypes: audioMimeSchema.options,
            maxAudioBytes: MAX_AUDIO_BYTES,
            provider: providerLabel(app.config.transcriptionProvider ?? "openai"),
          },
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/transcriptions") {
        let body: any;
        try {
          body = await readBody(req, 720000);
        } catch (error: any) {
          if (error.message?.startsWith("Request body exceeds"))
            throw new TranscriptionError("audio_too_large");
          throw error;
        }
        if (body && typeof body.mimeType === "string")
          body.mimeType = body.mimeType.split(";")[0].trim().toLowerCase();
        const device = transcriptionDevices().find((d) => d.id === body?.deviceId);
        const prior = transcriptions
          .list()
          .some((job) => job.requestId === body?.requestId);
        if (!prior && (!device?.online || !device.capabilities?.transcription))
          throw new TranscriptionError("provider_not_configured");
        return send(202, transcriptions.submit(body));
      }
      if (
        req.method === "GET" &&
        parts[0] === "v1" &&
        parts[1] === "transcriptions" &&
        parts.length === 3
      )
        return send(200, transcriptions.get(parts[2]));
      if (req.method === "POST" && url.pathname === "/v1/clients/pair") {
        const p = z
          .object({ name: z.string().trim().min(1).max(120) })
          .parse(await readBody(req));
        return send(201, clients.issue(p.name));
      }
      if (req.method === "GET" && url.pathname === "/v1/clients")
        return send(200, { clients: clients.list() });
      if (
        req.method === "DELETE" &&
        parts[0] === "v1" &&
        parts[1] === "clients" &&
        parts.length === 3
      )
        return send(200, clients.revoke(parts[2]));
      if (req.method === "GET" && url.pathname === "/v1/phone")
        return send(200, {
          capability: app.phone.capability(),
          jobs: app.phone.list(),
        });
      if (req.method === "POST" && url.pathname === "/v1/phone")
        return send(202, app.phone.enqueue(await readBody(req)));
      if (
        req.method === "POST" &&
        parts[0] === "v1" &&
        parts[1] === "phone" &&
        parts.length === 4
      ) {
        if (parts[3] === "resume")
          return send(200, await app.phone.resume(parts[2]));
        if (parts[3] === "cancel") return send(200, app.phone.cancel(parts[2]));
      }
      if (req.method === "GET" && url.pathname === "/v1/tasks")
        return send(200, { tasks: app.tasks() });
      if (req.method === "POST" && url.pathname === "/v1/devices/pair") {
        const p = z
          .object({ name: z.string().trim().min(1).max(120) })
          .parse(await readBody(req));
        return send(201, pairing.issue(p.name));
      }
      if (
        req.method === "DELETE" &&
        parts[0] === "v1" &&
        parts[1] === "devices" &&
        parts.length === 3
      )
        return send(200, pairing.revoke(parts[2]));
      if (
        req.method === "PATCH" &&
        parts[0] === "v1" &&
        parts[1] === "chats" &&
        parts.length === 3
      ) {
        return send(200, app.updateChat(parts[2], await readBody(req)));
      }
      if (
        parts[0] === "v1" &&
        parts[1] === "tasks" &&
        parts[3] === "artifacts" &&
        parts.length === 4
      ) {
        if (req.method === "GET")
          return send(200, { artifacts: app.task(parts[2]).artifacts ?? [] });
        if (req.method === "POST") {
          const p = z
            .object({ path: z.string().min(1).max(4096) })
            .parse(await readBody(req));
          return send(201, await app.publishArtifact(parts[2], p.path));
        }
      }
      if (
        req.method === "GET" &&
        parts[0] === "v1" &&
        parts[1] === "artifacts" &&
        parts[3] === "content" &&
        parts.length === 4
      ) {
        const { artifact, bytes } = app.artifacts.content(parts[2]);
        res.writeHead(200, {
          "Content-Type": artifact.mime,
          "Content-Length": bytes.length,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
          "Cache-Control": "no-store",
          "Content-Security-Policy": "sandbox; default-src 'none'",
        });
        res.end(bytes);
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/devices")
        return send(200, { devices: app.devices.list() });
      if (req.method === "GET" && url.pathname === "/v1/chats")
        return send(200, { chats: app.chats() });
      if (req.method === "GET" && url.pathname === "/v1/briefing")
        return send(200, app.briefing());
      if (req.method === "GET" && url.pathname === "/v1/events") {
        const after = z.coerce
          .number()
          .int()
          .min(0)
          .parse(url.searchParams.get("after") ?? 0);
        const events = app.store.state.events;
        return send(200, {
          // Newest first-200 only: a cold client asking from zero must not be handed the whole ring.
          events: events.filter((e) => e.sequence > after).slice(-200),
          latestSequence: app.store.state.sequence,
          // Below this the ring has already dropped what the client missed, so its history has a hole.
          oldestSequence: events[0]?.sequence ?? app.store.state.sequence + 1,
        });
      }
      if (
        req.method === "GET" &&
        parts[0] === "v1" &&
        parts[1] === "tasks" &&
        parts.length === 3
      )
        return send(200, app.task(parts[2]));
      if (
        req.method === "GET" &&
        parts[0] === "v1" &&
        parts[1] === "chats" &&
        parts[3] === "context" &&
        parts.length === 4
      )
        return send(200, app.context(parts[2]));
      if (req.method === "POST" && url.pathname === "/v1/messages")
        return send(202, await app.message(message.parse(await readBody(req))));
      if (req.method === "POST" && url.pathname === "/v1/chats") {
        const p = z
          .object({
            deviceId: z.string().min(1),
            name: z.string().trim().min(1).max(120),
            threadId: z.string().min(1).optional(),
            workspace: z.string().max(4096).optional(),
            instructions: z.string().max(12000).optional(),
          })
          .parse(await readBody(req));
        return send(
          201,
          await app.createChat(p.deviceId, p.name, p.threadId, {
            workspace: p.workspace,
            instructions: p.instructions,
          }),
        );
      }
      if (
        req.method === "POST" &&
        parts[0] === "v1" &&
        parts[1] === "chats" &&
        parts[3] === "messages" &&
        parts.length === 4
      ) {
        const input = await readBody(req);
        if (input && typeof input === "object" && "workflow" in input)
          throw new Error("A workflow manifest must use /v1/messages, not a direct conversation route.");
        return send(202, await app.dispatch(parts[2], input));
      }
      if (
        req.method === "POST" &&
        parts[0] === "v1" &&
        parts[1] === "tasks" &&
        parts[3] === "cancel" &&
        parts.length === 4
      )
        return send(200, await app.cancel(parts[2]));
      if (
        req.method === "POST" &&
        parts[0] === "v1" &&
        parts[1] === "approvals" &&
        parts.length === 3
      ) {
        const p = z
          .object({
            decision: z.enum(["accept", "decline", "cancel"]).optional(),
            answers: z
              .record(z.object({ answers: z.array(z.string()).min(1) }))
              .optional(),
            response: approvalResponseSchema.optional(),
          })
          .strict()
          .refine(
            (p) => [p.decision, p.answers, p.response].filter((v) => v !== undefined).length === 1,
            "Provide exactly one decision, answers, or typed response",
          )
          .parse(await readBody(req));
        return send(200, await app.approval(parts[2], p.decision, p.answers, p.response));
      }
      send(404, { error: "Not found" });
    } catch (e: any) {
      if (res.destroyed || res.writableEnded) return;
      if (e instanceof RequestNotAcceptedError)
        return send(409, { error: e.message, requestId: e.requestId,
          requestStatus: "not_accepted", errorCode: e.reasonCode });
      if (e instanceof HostBridgeError)
        return send(e.status, { error: e.message, errorCode: e.code });
      if (e instanceof SpeechError) return send(e.status, { error: e.message });
      if (e instanceof TranscriptionError)
        return send(e.status, { error: e.message, errorCode: e.code });
      if (e instanceof LiveTranscriptionAccessError) return send(e.status, { error: e.message });
      send(e instanceof z.ZodError || e instanceof SyntaxError ? 400 : 409, {
        error: e.message,
      });
    }
  });
  const ws = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const liveWs = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024,
    handleProtocols: protocols => protocols.has("providence-live-v1") ? "providence-live-v1" : false });
  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (url.pathname === "/v1/transcriptions/live") {
      const origin = req.headers.origin;
      const host = req.headers.host ?? "";
      const localOrigin = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) && origin === `http://${host}`;
      const protocols = (req.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim());
      let ticket: { sessionId: string; requestId: string };
      try {
        if (!connectLive || url.search || liveConnections.size >= 4 ||
            (origin && !allowedOrigins.has(origin) && !localOrigin) || protocols.length !== 2 ||
            !protocols.includes("providence-live-v1")) throw new Error();
        ticket = liveTickets.consume(protocols.find(value => value.startsWith("ticket."))?.slice(7), origin);
      } catch {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
      }
      liveWs.handleUpgrade(req, socket, head, client => {
        let connection: LiveTranscriptionConnection | undefined, ended = false, audioBytes = 0, nextSeq = 0;
        const finish = () => {
          if (ended) return;
          ended = true;
          clearTimeout(lifetime);
          try { connection?.cancel(); } catch { /* Cleanup must still close this client. */ }
          liveConnections.delete(ticket.sessionId);
          try { client.close(); } catch {}
        };
        const sendLive = (event: unknown) => {
          if (ended || !liveTickets.isAuthorized(ticket.sessionId) || client.readyState !== 1 || client.bufferedAmount > 64 * 1024) { finish(); return; }
          client.send(JSON.stringify(event), error => { if (error) finish(); });
        };
        const rejectFrame = () => {
          sendLive({ type: "error", sessionId: ticket.sessionId, code: "invalid_audio_stream",
            message: "Live audio could not be accepted. Nothing was submitted or retried." });
          finish();
        };
        const lifetime = setTimeout(() => {
          sendLive({ type: "error", sessionId: ticket.sessionId, code: "session_timeout", message: "Live transcription timed out. Nothing was submitted." });
          finish();
        }, 60_000);
        liveConnections.set(ticket.sessionId, finish);
        client.on("close", finish);
        client.on("error", finish);
        client.on("message", (bytes, binary) => {
          if (ended) return;
          try {
            if (!liveTickets.isAuthorized(ticket.sessionId)) throw new Error();
            if (binary || !connection) throw new Error();
            const frame = liveClientFrame.parse(JSON.parse(bytes.toString()));
            if (frame.type === "cancel") return finish();
            if (frame.type === "finish") { if (frame.lastSeq !== nextSeq - 1) throw new Error(); connection.finish(frame.lastSeq); return; }
            const audio = Buffer.from(frame.audio, "base64");
            if (frame.seq !== nextSeq || audio.length < 2 || audio.length % 2 || audio.length > liveAudioLimits.maxChunkBytes ||
                audio.toString("base64") !== frame.audio || audioBytes + audio.length > liveAudioLimits.maxAudioBytes) throw new Error();
            connection.append(frame.seq, frame.audio);
            audioBytes += audio.length; nextSeq++;
            sendLive({ type: "ack", sessionId: ticket.sessionId, seq: frame.seq });
          } catch { rejectFrame(); }
        });
        try {
          connection = connectLive!({ requestId: ticket.requestId, streamId: ticket.sessionId, deviceId: app.config.localDeviceId }, event => {
            sendLive(event);
            if (event.type === "final" || event.type === "error") finish();
          });
          if (ended) connection.cancel();
        } catch { rejectFrame(); }
      });
      return;
    }
    const id = url.searchParams.get("deviceId");
    const device = app.config.devices.find((d) => d.id === id);
    if (
      url.pathname !== "/worker" ||
      !device ||
      !tokenMatches(req.headers.authorization, `Bearer ${device.token}`) ||
      req.headers.origin
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    ws.handleUpgrade(req, socket, head, (client) =>
      app.devices.attach(device.id, client),
    );
  });
  server.on("close", () => {
    clearInterval(activityTimer); app.devices.off("online", renewPower); app.devices.requestKeepAwake(false);
    for (const finish of liveConnections.values()) finish();
    liveTickets.clear(); liveWs.close(); ws.close();
  });
  server.on("listening", () => {
    const bound = server.address();
    const address = typeof bound === "object" && bound ? bound.address : "";
    console.log(
      `Allowed browser origins: ${[...allowedOrigins].join(", ") || "none configured"}`,
    );
    // Without an allowlist a remotely reachable bind refuses every browser write.
    if (allowedOrigins.size === 0 && !isLoopback(address))
      console.error(
        "No browser origin is allowed and the server is not bound to loopback. Set PROVIDENCE_PUBLIC_ORIGIN or every browser write will be refused.",
      );
  });
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const app = new Coordinator(config, dataDir);
  const shutdown = () => {
    app.stop();
    server.close();
    setTimeout(() => process.exit(0), 1000).unref();
  };
  const server = createHttpServer(app, config.clientToken);
  server.on("error", (error) => {
    console.error(error.message);
    app.stop();
    process.exitCode = 1;
  });
  try {
    await app.start();
    server.listen(
      Number(process.env.PORT ?? 8787),
      process.env.HOST ?? "127.0.0.1",
      () =>
        console.log(
          `Providence ready at http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 8787}. Client token: local .providence/config.json (not logged).`,
        ),
    );
  } catch (e: any) {
    console.error(e.message);
    app.stop();
    process.exitCode = 1;
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  let lastFailure = 0;
  // One unexpected failure must not end a running demo; a repeat means the process is no longer sound.
  const survive = (kind: string) => (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error(`Unhandled ${kind}: ${message}`);
    const at = Date.now();
    if (at - lastFailure < 10000) {
      console.error("A second unhandled failure within ten seconds. Shutting down.");
      process.exitCode = 1;
      shutdown();
      return;
    }
    lastFailure = at;
  };
  process.on("uncaughtException", survive("exception"));
  process.on("unhandledRejection", survive("rejection"));
}
