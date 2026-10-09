import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { Accounts } from "../src/hosted/accounts.js";
import { Workspaces } from "../src/hosted/workspaces.js";

class DelayedCloseSocket extends EventEmitter {
  readyState = 1;
  requests: { kind: string; id: string }[] = [];
  send(data: string, callback?: (error?: Error) => void) { this.requests.push(JSON.parse(data)); callback?.(); }
  close() { this.readyState = 2; }
  ping() {}
  terminate() { this.emit("close", 1001); }
}

test("removed-key workspace retires old socket callbacks before a replacement can write state", { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-stale-workspace-"));
  const accounts = new Accounts(join(directory, "accounts.sqlite"), randomBytes(32));
  const account = accounts.create("Synthetic workspace shutdown");
  accounts.setKey(account.id, "synthetic-old-provider-key");
  let providerRequests = 0;
  const workspaces = new Workspaces(directory, "https://providence.example", accounts, "fixture", async () => {
    providerRequests++; throw new Error("This test must not invoke a provider");
  });
  const socket = new DelayedCloseSocket();
  try {
    const old = await workspaces.get(account.id);
    old.app.devices.registered.push({ id: "fixture-device", name: "Synthetic device" });
    old.app.devices.attach("fixture-device", socket as unknown as WebSocket);
    socket.emit("message", JSON.stringify({ kind: "ready" }));
    assert.equal(old.app.devices.online("fixture-device"), true);
    const pending = old.app.devices.call("fixture-device", "chat.create", {});
    const rejected = assert.rejects(pending, /Device disconnected/);
    const request = socket.requests.find(value => value.kind === "request")!;
    assert.ok(request);

    accounts.db.prepare("UPDATE accounts SET key=NULL WHERE id=?").run(account.id);
    await workspaces.disable(account.id);
    await rejected;
    accounts.setKey(account.id, "synthetic-replacement-provider-key");
    const replacement = await workspaces.get(account.id);
    assert.notEqual(replacement.app, old.app);
    const chat = replacement.app.store.addChat("Created after key re-add", "fixture-device", "fixture-thread");
    const expected = readFileSync(replacement.app.store.file);

    // The old network peer may reply or finish its close handshake after a new
    // workspace has acquired the state directory. Neither may reach the old store.
    socket.emit("message", JSON.stringify({ kind: "response", id: request.id, result: { threadId: "stale-thread" } }));
    socket.emit("message", JSON.stringify({ kind: "event", event: { type: "task.completed", taskId: "stale-task", text: "stale" } }));
    socket.emit("message", JSON.stringify({ kind: "ready" }));
    socket.emit("close", 1001);
    await new Promise<void>(accept => setImmediate(accept));
    assert.deepEqual(readFileSync(replacement.app.store.file), expected, "Late callbacks must not overwrite the replacement's state snapshot");
    assert.equal(JSON.parse(readFileSync(replacement.app.store.file, "utf8")).chats[chat.id].name, "Created after key re-add");
    assert.equal(providerRequests, 0);
  } finally {
    socket.emit("close", 1001);
    await workspaces.stop(); accounts.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("an already queued admission microtask cannot start another task after key removal", { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-shutdown-admission-"));
  const accounts = new Accounts(join(directory, "accounts.sqlite"), randomBytes(32));
  const account = accounts.create("Synthetic queued admission");
  accounts.setKey(account.id, "synthetic-provider-key"); accounts.acceptAIConsent(account.id, "2026-10-02");
  let entered!: () => void;
  const providerEntered = new Promise<void>(accept => { entered = accept; });
  let providerRequests = 0;
  const workspaces = new Workspaces(directory, "https://providence.example", accounts, "fixture", (_input, init) => {
    providerRequests++;
    return new Promise<Response>((_accept, reject) => {
      const signal = init!.signal!;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      entered();
    });
  });
  try {
    const workspace = await workspaces.get(account.id);
    const execute = workspace.app.master.execute.bind(workspace.app.master);
    const startedTasks: string[] = [];
    workspace.app.master.execute = async (...args: Parameters<typeof execute>) => {
      startedTasks.push(args[1]); return execute(...args);
    };
    const first = await workspace.app.message({ requestId: randomUUID(), text: "First synthetic task", queueIfBusy: true });
    await providerEntered;
    // message() queues admission synchronously. Do not await it before removal:
    // its queued microtask must see the shutdown fence, even after task one ends.
    const queued = workspace.app.message({ requestId: randomUUID(), text: "Second synthetic task", queueIfBusy: true });
    accounts.db.prepare("UPDATE accounts SET key=NULL WHERE id=?").run(account.id);
    const stopping = workspaces.disable(account.id);
    const second = await queued;
    await stopping;
    await new Promise<void>(accept => setImmediate(accept));
    assert.deepEqual(startedTasks, [first.id]);
    assert.equal(providerRequests, 1);
    assert.notEqual(workspace.app.store.state.tasks[second.id].status, "running");
    await assert.rejects(workspace.app.message({ requestId: randomUUID(), text: "Late synthetic task" }), /stopping/);
    await assert.rejects(workspace.app.master.create(), /stopped/);
    assert.equal(providerRequests, 1);
  } finally {
    await workspaces.stop(); accounts.close(); rmSync(directory, { recursive: true, force: true });
  }
});
