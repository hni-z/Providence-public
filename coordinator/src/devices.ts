import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { Runtime, type Event } from "./runtime.js";
import type { DeviceCapabilityEvidence } from "./capability-evidence.js";
import { disconnectedStatus, runtimeOfflineEvent, type ConnectionReason, type ConnectionStatus } from "./connection-status.js";
import {
  deviceMetadataSchema, keepAwakeStateSchema,
  runtimeMetadata,
  unavailableCapabilities,
  type DeviceMetadata,
} from "./device-config.js";
/** Only for a proven pre-dispatch failure, never a timeout or send callback. */
export class DeviceRequestNotSentError extends Error {}
export async function runtimeRequest(
  runtime: Runtime,
  method: string,
  p: any = {},
) {
  switch (method) {
    case "chat.create":
      return runtime.create({
        workspace: p.workspace,
        instructions: p.instructions,
      });
    case "chat.import":
      return runtime.importThread(p.threadId);
    case "session.list":
      return runtime.listNativeSessions(p);
    case "session.read":
      return runtime.readNativeSession(p);
    case "task.start":
      return runtime.execute(p.threadId, p.taskId, p.text, p.workspace);
    case "task.cancel":
      return runtime.cancel(p.threadId);
    case "approval.resolve":
      return runtime.resolveApproval(p.approvalId, p.decision, p.answers, p.response);
    case "artifact.read":
      return runtime.readArtifact(p.threadId, p.path);
    case "audio.transcribe":
      return runtime.transcribeAudio(p);
    default:
      throw new Error("Unsupported device operation");
  }
}
/** The coordinator sends this close reason when a device registration was revoked. */
const registrationEndedReason = "Device registration is no longer active";
/** Every other close is transient, so a companion retries unless it reads this reason. */
export function registrationEnded(reason: string) {
  return /no longer active/i.test(reason);
}
// ceiling: twenty attempts, refunded only after a minute of connected time, bound a
// companion that flaps between coordinator closes to twenty executor starts. Revisit
// if a venue network drops for longer than the eight minutes those attempts span.
export function reconnectBudget(limit = 20, stableMs = 60000) {
  let attempts = 0,
    stable: NodeJS.Timeout | undefined;
  return {
    /** A connection only earns attempts back once it has held for the stable window. */
    opened() {
      stable = setTimeout(() => (attempts = 0), stableMs);
      stable.unref();
    },
    closed() {
      clearTimeout(stable);
    },
    /** The delay before the next attempt, or undefined once the budget is spent. */
    next() {
      if (attempts >= limit) return undefined;
      return Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5));
    },
  };
}
export class Devices extends EventEmitter {
  private remotes = new Map<string, { ws: WebSocket; ready: boolean; readyReceived: boolean; powerActivity?: boolean }>();
  private connectionStatuses = new Map<string, ConnectionStatus>();
  private calls = new Map<
    string,
    {
      deviceId: string;
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private localOnline = false;
  private metadata = new Map<string, DeviceMetadata>();
  constructor(
    readonly localId: string,
    readonly localName: string,
    readonly local: Runtime,
    readonly registered: { id: string; name: string }[],
    private readonly capabilityEvidence?: (deviceId: string) => DeviceCapabilityEvidence,
    private readonly mirroringEvidence?: (deviceId: string) => unknown,
    private readonly mirroringBinding?: (deviceId: string) => unknown,
    private readonly localEnabled = true,
  ) {
    super();
    local.on("event", (e: Event) => {
      const event = e.type === "runtime.offline" ? runtimeOfflineEvent(e) : e;
      if (e.type === "runtime.offline") {
        this.localOnline = false;
        this.connectionStatuses.set(localId, disconnectedStatus(this.connectionStatuses.get(localId), runtimeOfflineEvent(e).reasonCode, new Date().toISOString()));
        this.emit("offline", localId, this.connectionStatuses.get(localId));
      }
      if (e.type === "runtime.online") {
        this.localOnline = true;
        this.emit("online", localId);
      }
      this.emit("event", localId, event);
    });
  }
  async start() {
    if (!this.localEnabled) return;
    this.connectionStatuses.set(this.localId, { state: "connecting", reasonCode: "connecting" });
    await this.local.start();
    this.localOnline = true;
    const now = new Date().toISOString();
    this.connectionStatuses.set(this.localId, { state: "online", reasonCode: "ready", connectedAt: now, lastSeenAt: now });
  }
  list() {
    const devices = [
      {
        id: this.localId,
        name: this.localName,
        local: true,
        online: this.localOnline,
        connectionState: this.localOnline ? "online" : "offline",
        ...runtimeMetadata(this.local.root, this.local.hasTranscription, this.local.transcriptionProvider, this.local.options?.workerAccess),
      },
      ...this.registered.map((d) => ({
        id: d.id,
        name: d.name,
        local: false,
        online: this.remotes.get(d.id)?.ready === true,
        connectionState:
          this.remotes.get(d.id)?.ready === true ? "online" : "offline",
        capabilities: { ...unavailableCapabilities },
        ...this.metadata.get(d.id),
      })),
    ];
    return devices.filter(device => this.localEnabled || device.id !== this.localId).map(device => {
      const evidence = this.capabilityEvidence?.(device.id);
      const iphoneMirroring = device.online ? this.mirroringEvidence?.(device.id) : undefined;
      const iphoneMirroringBinding = this.mirroringBinding?.(device.id);
      return {
        ...device,
        ...(device.keepAwake ? { keepAwake: { ...device.keepAwake,
          active: device.online && device.keepAwake.active,
          ...(!device.online && device.keepAwake.enabled ? { reason: "disconnected" as const } : {}),
        } } : {}),
        connectionStatus: { ...(this.connectionStatuses.get(device.id) ?? { state: "offline", reasonCode: "not_connected" }) },
        capabilities: {
          ...device.capabilities,
          ...(evidence ? {
            browser: evidence.browser.status === "verified_scoped",
            desktop: evidence.desktop.status === "verified_scoped",
          } : {}),
          ...(iphoneMirroring ? { iphoneMirroring } : {}),
          ...(iphoneMirroringBinding ? { iphoneMirroringBinding } : {}),
        },
        ...(evidence ? { declaredCapabilities: device.capabilities, capabilityEvidence: evidence } : {}),
      };
    });
  }
  requestKeepAwake(active: boolean) {
    for (const remote of this.remotes.values()) if (remote.ready && remote.powerActivity && remote.ws.readyState === WebSocket.OPEN) {
      remote.ws.send(JSON.stringify({ kind: "power_lease", active, ttlMs: 30_000 }), () => {});
    }
  }
  online(id: string) {
    return this.list().some((d) => d.id === id && d.online);
  }
  attach(id: string, ws: WebSocket) {
    if (!this.registered.some((d) => d.id === id)) {
      ws.close(1008, registrationEndedReason);
      return;
    }
    const previous = this.remotes.get(id);
    if (previous) {
      // A companion that reconnects after a network drop must win over its own stale entry,
      // which the heartbeat would otherwise hold for up to thirty seconds.
      this.drop(id, previous);
      previous.ws.terminate();
    }
    const remote = { ws, ready: false, readyReceived: false, powerActivity: false };
    this.remotes.set(id, remote);
    let closeReason: ConnectionReason = "connection_lost";
    this.connectionStatuses.set(id, { ...this.connectionStatuses.get(id), state: "connecting", reasonCode: "connecting", lastSeenAt: new Date().toISOString() });
    const observed = () => {
      if (this.remotes.get(id) !== remote) return;
      const previous = this.connectionStatuses.get(id)!;
      this.connectionStatuses.set(id, { ...previous, lastSeenAt: new Date().toISOString() });
    };
    const readyTimeout = setTimeout(() => {
      if (!remote.ready) {
        closeReason = "ready_timeout";
        ws.close(1013, "Device did not become ready");
      }
    }, 15000);
    let alive = true;
    const heartbeat = setInterval(() => {
      if (this.remotes.get(id) !== remote) return;
      if (!alive) {
        closeReason = "heartbeat_timeout";
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 15000);
    ws.on("pong", () => {
      if (this.remotes.get(id) !== remote) return;
      alive = true;
      observed();
    });
    ws.on("message", (raw) => {
      try {
      if (this.remotes.get(id) !== remote) return;
      observed();
      let m: any;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        closeReason = "protocol_error";
        ws.close(1008, "Invalid JSON");
        return;
      }
      if (!m || typeof m !== "object" || Array.isArray(m)) {
        closeReason = "protocol_error";
        ws.close(1008, "Invalid message");
        return;
      }
      if (m.kind === "ready") {
        if (remote.readyReceived) return;
        remote.readyReceived = true;
        remote.powerActivity = m.capabilities?.powerActivity === true;
        if (m.metadata !== undefined) {
          const metadata = deviceMetadataSchema.safeParse(m.metadata);
          if (!metadata.success) {
            closeReason = "protocol_error";
            ws.close(1008, "Invalid device metadata");
            return;
          }
          this.metadata.set(id, metadata.data);
        } else {
          // A legacy reconnect did not advertise a current provider credential.
          const previous = this.metadata.get(id);
          if (previous)
            this.metadata.set(id, {
              ...previous,
              capabilities: { ...previous.capabilities, transcription: false },
              transcriptionProvider: undefined,
            });
        }
        const markReady = () => {
          if (this.remotes.get(id) !== remote || ws.readyState !== WebSocket.OPEN) return;
          clearTimeout(readyTimeout);
          remote.ready = true;
          const now = new Date().toISOString();
          this.connectionStatuses.set(id, { state: "online", reasonCode: "ready", connectedAt: now, lastSeenAt: now });
          this.emit("online", id, this.connectionStatuses.get(id));
        };
        // Optional v1 capability: old companions remain compatible and ignore no new mandatory contract.
        // A successful write queues the ACK ahead of tasks. It does not prove a client-side receipt.
        // Until the write callback succeeds, new task dispatch remains blocked.
        if (m.capabilities?.readyAck === true) {
          ws.send(JSON.stringify({ kind: "ready_ack", deviceId: id }), error => {
            if (this.remotes.get(id) !== remote) return;
            if (error) {
              closeReason = "connection_lost";
              ws.terminate();
              return;
            }
            markReady();
          });
        } else markReady();
      } else if (m.kind === "power_state" && remote.ready) {
        const power = keepAwakeStateSchema.safeParse(m.keepAwake);
        if (!power.success) { closeReason = "protocol_error"; ws.close(1008, "Invalid power status"); return; }
        const previous = this.metadata.get(id);
        if (previous) {
          this.metadata.set(id, { ...previous, keepAwake: power.data });
          this.emit("metadata", id);
        }
      } else if (
        m.kind === "event" &&
        remote.ready &&
        m.event &&
        typeof m.event.type === "string"
      ) {
        const event = m.event.type === "runtime.offline" ? runtimeOfflineEvent(m.event) : m.event;
        if (m.event.type === "runtime.offline") {
          closeReason = event.reasonCode;
          remote.ready = false;
          this.connectionStatuses.set(id, disconnectedStatus(this.connectionStatuses.get(id), closeReason, new Date().toISOString()));
        }
        this.emit("event", id, event);
        if (m.event.type === "runtime.offline") {
          ws.close(1011, "Device runtime stopped");
        }
      } else if (m.kind === "response") {
        const p = this.calls.get(m.id);
        if (!p || p.deviceId !== id) return;
        this.calls.delete(m.id);
        clearTimeout(p.timer);
        m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
      }
      } catch {
        ws.close(1011, "Device message could not be handled");
      }
    });
    ws.on("error", () => {});
    ws.on("close", (code) => {
      clearTimeout(readyTimeout);
      clearInterval(heartbeat);
      if (this.remotes.get(id) !== remote) return;
      this.remotes.delete(id);
      // A peer may close with a policy code, but its free-text reason is not trusted metadata.
      if (code === 1008 && closeReason === "connection_lost") closeReason = "protocol_error";
      const previous = this.connectionStatuses.get(id);
      if (previous?.reasonCode === "disconnected_by_owner" || previous?.reasonCode === "coordinator_stopping") closeReason = previous.reasonCode;
      this.connectionStatuses.set(id, disconnectedStatus(previous, closeReason, new Date().toISOString()));
      for (const [key, p] of this.calls)
        if (p.deviceId === id) {
          clearTimeout(p.timer);
          p.reject(new Error("Device disconnected"));
          this.calls.delete(key);
        }
      this.emit("offline", id, this.connectionStatuses.get(id));
    });
  }
  private drop(id: string, remote: { ws: WebSocket; ready: boolean }, status?: ConnectionStatus) {
    if (this.remotes.get(id) !== remote) return;
    this.remotes.delete(id);
    for (const [key, p] of this.calls)
      if (p.deviceId === id) {
        clearTimeout(p.timer);
        p.reject(new Error("Device disconnected"));
        this.calls.delete(key);
      }
    this.emit("offline", id, status);
  }
  disconnect(id: string) {
    if (id === this.localId)
      throw new Error(
        "The local coordinator cannot be disconnected as a companion.",
      );
    const remote = this.remotes.get(id);
    if (remote) {
      remote.ready = false;
      this.connectionStatuses.set(id, disconnectedStatus(this.connectionStatuses.get(id), "disconnected_by_owner", new Date().toISOString()));
      // Fence pending calls and later frames before waiting for the peer's close.
      this.drop(id, remote, this.connectionStatuses.get(id));
      remote.ws.close(1008, registrationEndedReason);
      const terminate = setTimeout(() => {
        if (remote.ws.readyState !== WebSocket.CLOSED) remote.ws.terminate();
      }, 1000);
      terminate.unref();
      remote.ws.once("close", () => clearTimeout(terminate));
    }
  }
  async call(id: string, method: string, params: any = {}): Promise<any> {
    if (!this.online(id)) throw new DeviceRequestNotSentError(`Device ${id} is offline; the request was not sent`);
    if (id === this.localId) {
      if (!this.localEnabled) throw new Error("Hosted coordination cannot execute on the server");
      return runtimeRequest(this.local, method, params);
    }
    const remote = this.remotes.get(id)!;
    return new Promise((resolve, reject) => {
      const callId = randomUUID();
      const timer = setTimeout(() => {
        this.calls.delete(callId);
        reject(
          new Error("Device RPC timed out; inspect status before retrying."),
        );
      }, 65000);
      this.calls.set(callId, { deviceId: id, resolve, reject, timer });
      remote.ws.send(
        JSON.stringify({ kind: "request", id: callId, method, params }),
        (error) => {
          if (!error) return;
          const pending = this.calls.get(callId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.calls.delete(callId);
          pending.reject(new Error("Device request could not be sent."));
        },
      );
    });
  }
  stop() {
    for (const [id, pending] of this.calls) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Device disconnected"));
      this.calls.delete(id);
    }
    for (const [id, r] of this.remotes) {
      r.ready = false;
      const status = disconnectedStatus(this.connectionStatuses.get(id), "coordinator_stopping", new Date().toISOString());
      this.connectionStatuses.set(id, status);
      // Retire ownership before closing the transport. A delayed close/message
      // must never write the old coordinator's state after a replacement starts.
      this.drop(id, r, status);
      r.ws.close(1001, "Coordinator stopping");
    }
    this.local.stop();
  }
}
