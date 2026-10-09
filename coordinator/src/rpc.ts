import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { ProviderRequestError } from "./approval-protocol.js";

export function codexBinary(): string {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex";
  return process.platform === "darwin" && existsSync(bundled)
    ? bundled
    : "codex";
}

/** Codex's supported newline-delimited stdio protocol. No credentials leave this process. */
export class CodexRpc extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private finishedChildren = new WeakSet<ChildProcessWithoutNullStreams>();
  private stopRequested = new WeakSet<ChildProcessWithoutNullStreams>();
  private stopping?: { child?: ChildProcessWithoutNullStreams; promise: Promise<void> };
  private next = 1;
  private serverRequests = new Map<string, object>();
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  public onRequest?: (
    method: string,
    params: any,
    id: string | number,
  ) => Promise<any>;
  async start() {
    const bin = codexBinary();
    if (/\.(cmd|bat)$/i.test(bin))
      throw new Error(
        "CODEX_BIN must point to codex.exe, not a Windows .cmd/.bat shim.",
      );
    const child = spawn(bin, ["app-server", "--stdio"], {
      stdio: "pipe",
      windowsHide: true,
    });
    this.watchChild(child);
    child.stderr.on("data", () => {}); // Never stream CLI diagnostics/credentials to remote clients.
    createInterface({ input: child.stdout }).on("line", (line) => this.receiveLine(line));
    await this.call("initialize", {
      clientInfo: { name: "providence", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized" });
  }
  private watchChild(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.on("error", (error) => {
      // A spawn failure has no process to wait for. Other errors are not exit proof.
      if (child.pid === undefined) this.finishedChildren.add(child);
      this.fail(error);
    });
    child.on("exit", (code, signal) => {
      this.finishedChildren.add(child);
      this.fail(new Error(`Codex exited (${code ?? signal})`));
    });
  }
  private receiveLine(line: string) {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
      if (typeof msg.method === "string" && (typeof msg.id === "string" || typeof msg.id === "number")) {
        const key = JSON.stringify([typeof msg.params?.threadId === "string" ? msg.params.threadId : null, msg.id]);
        if (this.serverRequests.has(key)) return;
        const request = {};
        this.serverRequests.set(key, request);
        Promise.resolve()
          .then(() => {
            if (this.serverRequests.get(key) !== request)
              throw new ProviderRequestError("request_cleared");
            if (!this.onRequest)
              throw new ProviderRequestError("unsupported_request");
            return this.onRequest(msg.method, msg.params, msg.id);
          })
          .then(
            (result) => {
              if (this.serverRequests.get(key) !== request) return;
              this.serverRequests.delete(key);
              try {
                this.send({ id: msg.id, result });
              } catch {}
            },
            (e) => {
              if (this.serverRequests.get(key) !== request) return;
              this.serverRequests.delete(key);
              try {
                this.send({
                  id: msg.id,
                  error: { code: e instanceof ProviderRequestError && e.code === "unsupported_request" ? -32601 : -32603,
                    message: e instanceof ProviderRequestError ? e.message : "Provider request could not be handled." },
                });
              } catch {}
            },
          );
      } else if (typeof msg.method === "string") {
        if (msg.method === "serverRequest/resolved" && typeof msg.params?.threadId === "string" &&
            ["string", "number"].includes(typeof msg.params?.requestId))
          this.serverRequests.delete(JSON.stringify([msg.params.threadId, msg.params.requestId]));
        this.emit("notification", msg.method, msg.params);
      }
      else if (this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.error
          ? p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
          : p.resolve(msg.result);
      }
  }
  call(method: string, params: any = {}, timeoutMs = 60000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.next++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  private send(msg: any) {
    if (!this.child?.stdin.writable) throw new Error("Codex is not connected");
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }
  private fail(error: Error) {
    this.serverRequests.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.emit("disconnected", error.message);
  }
  private hasExited(child: ChildProcessWithoutNullStreams): boolean {
    return this.finishedChildren.has(child) || child.exitCode != null || child.signalCode != null;
  }
  private requestStop(child?: ChildProcessWithoutNullStreams) {
    if (!child || this.hasExited(child) || this.stopRequested.has(child)) return;
    this.stopRequested.add(child);
    // Signal only this owned child, once. Failed signalling is not exit proof.
    try { child.kill("SIGTERM"); } catch { /* stopAndWait remains bounded. */ }
  }
  stop(): void {
    this.requestStop(this.child);
  }
  stopAndWait(timeoutMs = 5000): Promise<void> {
    const child = this.child;
    if (this.stopping && this.stopping.child === child) return this.stopping.promise;
    if (!child || this.hasExited(child)) {
      const promise = Promise.resolve();
      this.stopping = { child, promise };
      return promise;
    }
    const duration = Number.isFinite(timeoutMs) ? Math.min(30_000, Math.max(1, timeoutMs)) : 5000;
    const promise = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off("exit", exited);
        child.off("error", failedSpawn);
      };
      const exited = () => { this.finishedChildren.add(child); cleanup(); resolve(); };
      const failedSpawn = () => { if (child.pid === undefined) exited(); };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Codex child shutdown was not confirmed before the timeout."));
      }, duration);
      // Install observers before sending SIGTERM, including synchronous fake exits.
      child.once("exit", exited);
      child.on("error", failedSpawn);
    });
    this.stopping = { child, promise };
    this.requestStop(child);
    return promise;
  }
}
