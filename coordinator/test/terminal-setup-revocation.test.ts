import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";

test("removing an account key invalidates an earlier terminal upload waiting for validation", { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-key-removal-race-"));
  const origin = "https://providence.example";
  let finishValidation!: (valid: boolean) => void;
  let enterValidation!: () => void;
  const validationEntered = new Promise<void>(accept => { enterValidation = accept; });
  const validation = new Promise<boolean>(accept => { finishValidation = accept; });
  const app = createHostedServer({
    directory, origin, encryptionKey: randomBytes(32),
    validateApiKey: async () => { enterValidation(); return validation; },
  });
  let upload: Promise<Response> | undefined;
  try {
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const account = app.accounts.create("Synthetic revocation test");
    app.accounts.setKey(account.id, "sk-" + "synthetic-old".repeat(4));
    const owner = { Origin: origin, Cookie: `__Host-providence=${app.accounts.session(account.id)}` };
    const setup = app.setup.start();
    app.setup.approve(setup.userCode, account.id);
    const grant = app.setup.poll(setup.deviceCode);
    assert.equal(grant.status, "approved");
    if (grant.status !== "approved") throw new Error("Expected terminal authorization");
    const terminal = { Authorization: `Bearer ${grant.setupToken}`, "Content-Type": "application/json" };
    const input = JSON.stringify({ apiKey: "sk-" + "synthetic-new".repeat(4) });
    upload = fetch(base + "/setup/api-key", { method: "POST", headers: terminal, body: input });
    await validationEntered;

    const removal = await fetch(base + "/auth/api-key", { method: "DELETE", headers: owner });
    assert.equal(removal.status, 202);
    assert.deepEqual(await removal.json(), { ok: true, keyRemoved: true, workStopping: true, providerKeyRevoked: false });
    assert.equal(app.accounts.get(account.id)?.key, null);

    finishValidation(true);
    const resumed = await upload;
    assert.equal(resumed.status, 403, "The in-flight upload must lose its revoked authorization");
    assert.equal(app.accounts.get(account.id)?.key, null, "A completed removal must not be undone by an earlier upload");
    assert.throws(() => app.setup.poll(setup.deviceCode), /declined/);
    const retry = await fetch(base + "/setup/api-key", { method: "POST", headers: terminal, body: input });
    assert.equal(retry.status, 403, "The old grant must not be reusable after removal");
    assert.equal(app.accounts.get(account.id)?.key, null);
  } finally {
    finishValidation(false);
    await upload?.catch(() => undefined);
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
