import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";
import { ClearChatsError } from "../src/hosted/workspaces.js";
import { digest } from "../src/hosted/accounts.js";

const origin = "https://providence.fixture";
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "providence-clear-gateway-"));
  const app = createHostedServer({ directory, origin, encryptionKey: randomBytes(32), validateApiKey: async () => assert.fail("No provider access in gateway tests") });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const account = app.accounts.create("Synthetic owner"), other = app.accounts.create("Other synthetic owner");
  const raw = app.accounts.session(account.id), otherRaw = app.accounts.session(other.id), client = app.accounts.session(account.id, "client");
  const headers = { Origin: origin, Cookie: `__Host-providence=${raw}`, "Content-Type": "application/json" };
  const post = (body: unknown, values: Record<string, string> = headers, suffix = "") => fetch(base + "/auth/chats/clear" + suffix, {
    method: "POST", headers: values, body: JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: "error",
  });
  return { app, directory, base, account, other, raw, otherRaw, client, headers, post,
    cleanup: async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic gateway request timed out")), 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

test("chat clearing rejects anonymous, client-scoped and wrong-origin requests before touching a workspace", async () => {
  const f = await fixture();
  try {
    f.app.workspaces.clearChats = async () => assert.fail("Rejected request must not clear a workspace");
    for (const headers of [
      { Origin: origin, "Content-Type": "application/json" },
      { ...f.headers, Cookie: `__Host-providence=${f.client}` },
      { ...f.headers, Authorization: `Bearer ${f.client}` },
    ]) {
      const response = await f.post({}, headers); assert.equal(response.status, 401); await response.body?.cancel();
    }
    for (const wrongOrigin of ["", "https://untrusted.fixture"]) {
      const response = await f.post({}, { ...f.headers, Origin: wrongOrigin });
      assert.equal(response.status, 403); await response.body?.cancel();
    }
  } finally { await f.cleanup(); }
});

test("only an empty object is accepted; caller-provided account selection cannot reach cleanup", async () => {
  const f = await fixture();
  try {
    f.app.workspaces.clearChats = async () => assert.fail("Malformed request must not clear a workspace");
    for (const body of [{ account: f.other.id }, { confirmed: true }, { allAccounts: true }, [], null, "{}", 1]) {
      const response = await f.post(body);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "Use the Clear all chats button in Account" });
    }
  } finally { await f.cleanup(); }
});

test("valid requests use only their authenticated owner and do not need an API key or passkey step-up", async () => {
  const f = await fixture(), cleared: string[] = [];
  try {
    f.app.workspaces.clearChats = async (account, beforeClear) => { assert.equal(typeof beforeClear, "function"); await beforeClear!(); cleared.push(account); };
    assert.equal(f.app.accounts.get(f.account.id)!.key, null);
    const first = await f.post({}, f.headers, `?account=${f.other.id}`);
    assert.equal(first.status, 200); assert.deepEqual(await first.json(), { cleared: true });
    const second = await f.post({}, { ...f.headers, Cookie: `__Host-providence=${f.otherRaw}` });
    assert.equal(second.status, 200); assert.deepEqual(await second.json(), { cleared: true });
    assert.deepEqual(cleared, [f.account.id, f.other.id]);
    assert.ok(f.app.accounts.authenticate(f.raw)); assert.ok(f.app.accounts.authenticate(f.otherRaw));
  } finally { await f.cleanup(); }
});

test("an owner revoked or changed while the body is pending cannot clear chats", async () => {
  for (const change of ["revoke", "scope", "account"]) {
    const f = await fixture(); let reachedCleanup = 0;
    try {
      f.app.workspaces.clearChats = async () => { reachedCleanup++; };
      const arrived = once(f.app.server, "request");
      const request = httpRequest(f.base + "/auth/chats/clear", { method: "POST", headers: f.headers });
      const response = new Promise<{ status: number; body: any }>((resolve, reject) => {
        request.on("error", reject);
        request.on("response", incoming => {
          const chunks: Buffer[] = [];
          incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
          incoming.on("error", reject);
          incoming.on("end", () => { try { resolve({ status: incoming.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } });
        });
      });
      try {
        request.write("{");
        await bounded(arrived);
        if (change === "revoke") f.app.accounts.logout(f.raw);
        else if (change === "scope") f.app.accounts.db.prepare("UPDATE sessions SET scope='client' WHERE hash=?").run(digest(f.raw));
        else f.app.accounts.db.prepare("UPDATE sessions SET account=? WHERE hash=?").run(f.other.id, digest(f.raw));
        request.end("}");
        const result = await bounded(response);
        assert.equal(result.status, 401); assert.match(result.body.error, /Sign in again/);
        assert.equal(reachedCleanup, 0);
      } finally { request.destroy(); }
    } finally { await f.cleanup(); }
  }
});

test("the final before-clear callback refuses revocation after workspace preparation", async () => {
  const f = await fixture(); let removed = false;
  try {
    f.app.workspaces.clearChats = async (_account, beforeClear) => {
      f.app.accounts.logout(f.raw);
      await beforeClear!();
      removed = true;
    };
    const response = await f.post({});
    assert.equal(response.status, 401); assert.match((await response.json() as { error: string }).error, /Sign in again/);
    assert.equal(removed, false);
  } finally { await f.cleanup(); }
});

test("busy cleanup returns its safe 409 message and unexpected failures do not reveal diagnostics", async () => {
  const f = await fixture();
  try {
    const message = "Finish or cancel active work and questions before clearing chats.";
    f.app.workspaces.clearChats = async () => { throw Object.assign(new ClearChatsError(409, message), { cause: new Error("synthetic-private-diagnostic") }); };
    const busy = await f.post({}); assert.equal(busy.status, 409); assert.deepEqual(await busy.json(), { error: message });
    f.app.workspaces.clearChats = async () => { throw new Error("synthetic-private-diagnostic"); };
    const failed = await f.post({}); assert.equal(failed.status, 400);
    const body = await failed.json(); assert.doesNotMatch(JSON.stringify(body), /synthetic-private-diagnostic|stack|cause/);
    assert.ok(f.app.accounts.authenticate(f.raw));
  } finally { await f.cleanup(); }
});
