import { mkdirSync, existsSync, writeFileSync, readFileSync, lstatSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Coordinator } from "../coordinator.js";
import { createHttpServer } from "../server.js";
import { loadConfig, saveConfig, tokenMatches } from "../config.js";
import { Pairing } from "../pairing.js";
import { Speech } from "../speech.js";
import { transcribeAudio } from "../transcription.js";
import { ActivityLeases } from "../activity.js";
import { ClientSessions } from "../client-sessions.js";
import { ApiRuntime } from "./api-runtime.js";
import { ProviderAccess } from "./provider-access.js";
import { AIConsentError, type Accounts } from "./accounts.js";
import { Store } from "../store.js";

export class ClearChatsError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "ClearChatsError"; }
}

function requireIdleChatState(state: Store["state"]) {
  if (Object.values(state.tasks).some(task => ["queued", "running", "needs_input"].includes(task.status)) ||
      Object.values(state.approvals).some(approval => ["pending", "resolving"].includes(approval.status)))
    throw new ClearChatsError(409, "Finish or cancel active work and questions before clearing chats.");
}

function requireRegularFile(file: string) {
  try { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not_regular"); }
  catch (error: any) { if (error?.code !== "ENOENT") throw new ClearChatsError(409, "Chat history could not be safely cleared. No files were removed."); }
}

export class Workspaces {
  private running = new Map<string, Promise<{ app: Coordinator; server: ReturnType<typeof createHttpServer>; port: number; token: string; activity: ActivityLeases }>>();
  private providers = new Map<string, ProviderAccess>();
  private apps = new Map<string, Coordinator>();
  private stopping = new Map<string, Promise<void>>();
  private clearing = new Map<string, Promise<void>>();
  constructor(private root: string, private origin: string, private accounts: Accounts,
    private model = "gpt-6-sol", private providerFetch: typeof fetch = fetch) {}
  async noteActivity(account: string, client: string, active: boolean) {
    const pending = this.running.get(account);
    if (!pending) return; // Looking at setup does not start a runtime or require a key.
    const current = await pending;
    current.activity.touch(client, active);
    current.app.devices.requestKeepAwake(current.activity.wanted(current.app.hasActiveWork()));
  }
  async inspectDevices(account: string) {
    if (!this.accounts.get(account) || !/^[0-9a-f-]{36}$/.test(account)) throw new Error("Unknown account");
    const loaded = this.running.get(account);
    if (loaded) return (await loaded).app.devices.list();
    const file = resolve(this.root, "workspaces", account, "config.json");
    if (!existsSync(file)) return [];
    const data = JSON.parse(readFileSync(file, "utf8"));
    return (Array.isArray(data.devices) ? data.devices : []).map((device: any) => ({
      id: device.id, name: device.name, online: false,
      connectionStatus: { state: "offline", reasonCode: "not_connected" },
    }));
  }
  async revokeDevice(account: string, deviceId: string, expectedToken?: string) {
    if (!this.accounts.get(account) || !/^[0-9a-f-]{36}$/.test(account)) throw new Error("Unknown account");
    const loaded = this.running.get(account);
    const current = loaded ? await loaded : undefined;
    const file = resolve(this.root, "workspaces", account, "config.json");
    const config = current?.app.config ?? loadConfig(file);
    const device = config.devices.find(value => value.id === deviceId);
    if (!device || (expectedToken !== undefined && !tokenMatches(expectedToken, device.token)))
      throw new Error("Device credential is not active");
    if (current) new Pairing(current.app, this.origin).revoke(deviceId);
    else {
      config.devices = config.devices.filter(value => value.id !== deviceId);
      saveConfig(file, config);
    }
    return device.token;
  }
  async revokeClient(account: string, clientId: string) {
    if (!this.accounts.get(account) || !/^[0-9a-f-]{36}$/.test(account) || !/^[0-9a-f-]{36}$/.test(clientId)) throw new Error("Unknown account controller");
    const current = await this.running.get(account)?.catch(() => undefined);
    if (current?.server.listening) {
      try {
        const response = await fetch(`http://127.0.0.1:${current.port}/v1/clients/${clientId}`, { method: "DELETE",
          headers: { Authorization: `Bearer ${current.token}`, Origin: this.origin }, redirect: "error", signal: AbortSignal.timeout(5000) });
        await response.body?.cancel();
        if (response.ok) return;
      } catch { /* A concurrently closing workspace is cleaned from its private file below. */ }
    }
    const file = resolve(this.root, "workspaces", account, "client-sessions.json");
    if (!existsSync(file)) return;
    const clients = new ClientSessions(file);
    if (clients.list().some(client => client.id === clientId)) clients.revoke(clientId);
  }
  get(account: string) {
    if (this.clearing.has(account)) throw new ClearChatsError(409, "Providence is clearing chat history. Try again shortly.");
    if (!this.accounts.get(account)?.key) throw new Error("Configure your OpenAI API key first");
    if (this.stopping.has(account)) throw new Error("Providence is finishing the previous connection; try again shortly");
    if (!this.running.has(account)) {
      if (this.running.size >= 32) throw new Error("The hosted service is at capacity; try again later");
      const starting = this.start(account).catch(error => {
        if (this.running.get(account) === starting) this.running.delete(account);
        throw error;
      });
      this.running.set(account, starting);
    }
    return this.running.get(account)!;
  }
  private async start(account: string) {
    if (!/^[0-9a-f-]{36}$/.test(account)) throw new Error("Invalid workspace identity");
    const dir = resolve(this.root, "workspaces", account); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = resolve(dir, "config.json");
    if (!existsSync(file)) writeFileSync(file, JSON.stringify({ clientToken: randomBytes(32).toString("hex"),
      localDeviceId: "hosted-server", localDeviceName: "Hosted coordination", workspace: resolve(dir, "unused"), devices: [] }), { mode: 0o600 });
    const config = loadConfig(file);
    const provider = new ProviderAccess(() => !!this.accounts.get(account)?.key, this.providerFetch);
    const consentedFetch: typeof fetch = (...args) => {
      if (!this.accounts.hasAIConsent(account)) return Promise.reject(new AIConsentError());
      return provider.fetch(...args);
    };
    this.providers.set(account, provider);
    const app = new Coordinator(config, dir, { remoteOnly: true,
      masterFactory: options => new ApiRuntime(options, resolve(dir, "coordination.json"), () => this.accounts.readKey(account), this.model, consentedFetch) });
    this.apps.set(account, app);
    const speech = new Speech({}, consentedFetch, { provider: "openai", apiKey: this.accounts.readKey(account), model: "gpt-4o-mini-tts", voice: "marin" });
    const activity = new ActivityLeases();
    const server = createHttpServer(app, config.clientToken, { publicOrigin: this.origin, activity, clientLifetimeMs: 30 * 86400_000,
      hostedVoice: { speech, transcribe: input => transcribeAudio(input, this.accounts.readKey(account), "gpt-4o-mini-transcribe", consentedFetch) } });
    try {
      await app.start();
      await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); accept(); }); });
      return { app, server, port: (server.address() as { port: number }).port, token: config.clientToken, activity };
    } catch (error) {
      provider.close();
      if (this.providers.get(account) === provider) this.providers.delete(account);
      if (this.apps.get(account) === app) this.apps.delete(account);
      app.stop(); server.close(); throw error;
    }
  }
  async reset(account: string) {
    const pending = this.running.get(account); if (!pending) return;
    const workspace = await pending;
    if (Object.values(workspace.app.store.state.tasks).some(t => ["queued", "running", "needs_input"].includes(t.status)))
      throw new Error("Wait for active tasks and approvals before changing the API key");
    await this.disable(account);
  }
  clearChats(account: string, beforeClear?: () => Promise<void>): Promise<void> {
    if (!this.accounts.get(account) || !/^[0-9a-f-]{36}$/.test(account))
      return Promise.reject(new ClearChatsError(404, "Unknown account."));
    if (this.clearing.has(account) || this.stopping.has(account))
      return Promise.reject(new ClearChatsError(409, "Providence is finishing another account operation. Try again shortly."));
    const pending = this.running.get(account);
    let fenced = false;
    const clearing = (async () => {
      const current = await pending;
      const directory = resolve(this.root, "workspaces", account);
      if (!existsSync(directory)) { await beforeClear?.(); return; }
      for (const folder of [resolve(this.root, "workspaces"), directory]) {
        const stat = lstatSync(folder);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ClearChatsError(409, "Chat history directory requires inspection before clearing.");
      }
      const stateFile = resolve(directory, "state.json"), historyFile = resolve(directory, "coordination.json");
      for (const file of [stateFile, stateFile + ".bak", `${stateFile}.${process.pid}.tmp`, historyFile, historyFile + ".tmp"])
        requireRegularFile(file);
      if (current) requireIdleChatState(current.app.store.state);
      else {
        // Inspect before Store's restart recovery can turn active records into
        // interrupted records. A stopped account needs no API key to clear chats.
        const candidate = existsSync(stateFile) ? stateFile : stateFile + ".bak";
        if (existsSync(candidate)) {
          let state: Store["state"];
          try {
            state = JSON.parse(readFileSync(candidate, "utf8"));
            if (!state || typeof state !== "object" || !state.tasks || !state.approvals || !state.chats || !Array.isArray(state.events)) throw new Error("invalid_state");
          } catch { throw new ClearChatsError(409, "Chat history requires inspection before clearing."); }
          requireIdleChatState(state);
        }
      }
      // There is no await between the idle check and the admission fence.
      current?.app.beginShutdown(); fenced = true;
      await beforeClear?.();
      await this.disable(account);
      const store = new Store(stateFile);
      try {
        requireIdleChatState(store.state);
        // The hosted runtime and its pending jobs have stopped. Replace only its
        // known conversation file; leave device config, client tokens and files.
        const temporary = `${historyFile}.clear-${randomUUID()}.tmp`;
        try { writeFileSync(temporary, "{}", { flag: "wx", mode: 0o600 }); renameSync(temporary, historyFile); }
        finally { rmSync(temporary, { force: true }); }
        if (existsSync(historyFile + ".tmp")) rmSync(historyFile + ".tmp");
        store.clearChats();
      } finally { store.stop(); }
    })().finally(async () => {
      // A failed authorization/voice-close callback leaves the history intact,
      // but its fenced coordinator must not remain cached as a usable runtime.
      if (fenced && this.running.has(account)) await this.disable(account);
      this.clearing.delete(account);
    });
    this.clearing.set(account, clearing);
    return clearing;
  }
  disable(account: string): Promise<void> {
    const alreadyStopping = this.stopping.get(account);
    if (alreadyStopping) return alreadyStopping;
    const provider = this.providers.get(account);
    provider?.close(); // Synchronous: in-flight HTTP and cached provider users lose access now.
    const app = this.apps.get(account);
    app?.beginShutdown();
    const pending = this.running.get(account);
    if (!pending) { this.providers.delete(account); this.apps.delete(account); return Promise.resolve(); }
    const stopped = (async () => {
      try {
        const workspace = await pending.catch(() => undefined);
        if (workspace) {
          workspace.app.devices.requestKeepAwake(false);
          workspace.server.close();
          workspace.server.closeAllConnections();
          workspace.app.devices.stop();
          await workspace.app.master.stopAndWait();
          // Keep the old store locked until cancelled coordination callbacks end.
          workspace.app.stop();
        }
      } finally {
        if (this.running.get(account) === pending) this.running.delete(account);
        if (this.providers.get(account) === provider) this.providers.delete(account);
        if (this.apps.get(account) === app) this.apps.delete(account);
        this.stopping.delete(account);
      }
    })();
    this.stopping.set(account, stopped);
    return stopped;
  }
  /** Only after Accounts.beginDeletion has revoked this account's authority. */
  async removeDeletedAccountData(account: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(account) || !this.accounts.pendingDeletions().includes(account))
      throw new Error("Account deletion has not been authorized");
    await this.clearing.get(account)?.catch(() => undefined);
    await this.disable(account);
    const parent = resolve(this.root, "workspaces"), directory = resolve(parent, account);
    for (const folder of [parent, directory]) {
      try {
        const stat = lstatSync(folder);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Account data directory requires inspection");
      } catch (error: any) { if (error?.code === "ENOENT") return; throw error; }
    }
    const lock = resolve(directory, "state.lock");
    if (existsSync(lock)) {
      requireRegularFile(lock);
      const pid = Number(readFileSync(lock, "utf8").trim());
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Account data still has an unverified writer lock");
      try { process.kill(pid, 0); throw new Error("Account data still has a live writer"); }
      catch (error: any) { if (error?.code !== "ESRCH") throw error; }
    }
    // Exact UUID directory only. rm removes any contained symlinks themselves;
    // no config path, remote workspace, or user-supplied destination is followed.
    rmSync(directory, { recursive: true, force: true });
  }
  async stop() {
    await Promise.all([...this.running.keys()].map(account => this.disable(account)));
  }
}
