import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ProviderAccess } from "../src/hosted/provider-access.js";
import { Accounts } from "../src/hosted/accounts.js";
import { Workspaces } from "../src/hosted/workspaces.js";

test("revocation aborts a provider response body already streaming and rejects cached callers", { timeout: 5000 }, async () => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(200); res.write("first"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  const access = new ProviderAccess(() => true);
  try {
    const response = await access.fetch(endpoint);
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
    const pending = reader.read();
    access.close();
    await assert.rejects(pending);
    await assert.rejects(access.fetch(endpoint), /removed/);
    assert.equal(requests, 1);
    reader.releaseLock();
  } finally { access.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});

test("removed storage authorization rejects before transport and cannot be revived on the same provider object", async () => {
  let allowed = false, calls = 0;
  const access = new ProviderAccess(() => allowed, (async () => { calls++; return new Response("unexpected"); }) as typeof fetch);
  await assert.rejects(access.fetch("https://provider.example"), /removed/);
  allowed = true;
  await assert.rejects(access.fetch("https://provider.example"), /removed/);
  assert.equal(calls, 0);
});

test("revocation during transport resolution discards its body and does not affect another workspace", async () => {
  let resolve!: (response: Response) => void;
  let cancelled = false;
  const first = new ProviderAccess(() => true, (() => new Promise<Response>(accept => { resolve = accept; })) as typeof fetch);
  const second = new ProviderAccess(() => true, (async () => new Response("second")) as typeof fetch);
  const request = first.fetch("https://provider.example");
  first.close();
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await assert.rejects(request, /removed/);
  assert.equal(cancelled, true);
  assert.equal(await (await second.fetch("https://provider.example")).text(), "second");
  second.close();
});

test("caller cancellation is preserved and a disabled workspace drains its active coordinator before reopening", { timeout: 5000 }, async () => {
  const controller = new AbortController(); controller.abort();
  let requests = 0;
  const access = new ProviderAccess(() => true, (async () => { requests++; return new Response(); }) as typeof fetch);
  await assert.rejects(access.fetch("https://provider.example", { signal: controller.signal }));
  assert.equal(requests, 0);

  const directory = mkdtempSync(join(tmpdir(), "providence-provider-removal-"));
  const accounts = new Accounts(join(directory, "accounts.sqlite"), randomBytes(32));
  const account = accounts.create("Synthetic provider removal");
  accounts.setKey(account.id, "synthetic-key-for-local-fixture");
  accounts.acceptAIConsent(account.id, "2026-10-02");
  let started!: () => void;
  const entered = new Promise<void>(accept => { started = accept; });
  let requestSignal: AbortSignal | undefined;
  const transport = ((_input, init) => new Promise<Response>((_resolve, reject) => {
    requestSignal = init?.signal ?? undefined;
    requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), { once: true });
    started();
  })) as typeof fetch;
  const workspaces = new Workspaces(directory, "https://providence.example", accounts, "synthetic-model", transport);
  try {
    const workspace = await workspaces.get(account.id);
    const thread = await workspace.app.master.create();
    await workspace.app.master.execute(thread.threadId, "synthetic-task", "local fixture");
    await entered;
    accounts.db.prepare("UPDATE accounts SET key=NULL WHERE id=?").run(account.id);
    const stopped = workspaces.disable(account.id);
    assert.equal(requestSignal!.aborted, true, "removal aborts transport synchronously");
    assert.throws(() => workspaces.get(account.id), /API key/);
    accounts.setKey(account.id, "synthetic-replacement-key");
    assert.throws(() => workspaces.get(account.id), /finishing/);
    await stopped;
    assert.equal(workspace.app.master.connected, false);
    assert.equal(workspace.server.listening, false);
    const replacement = await workspaces.get(account.id);
    assert.notEqual(replacement.app.master, workspace.app.master);
    assert.equal(replacement.app.master.connected, true);
  } finally {
    await workspaces.stop(); accounts.close(); rmSync(directory, { recursive: true, force: true });
  }
});
