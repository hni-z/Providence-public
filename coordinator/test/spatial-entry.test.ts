import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedServer } from "../src/hosted/server.js";

test("spatial entry retains account authentication and maps only the exact /meta entry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-spatial-entry-"));
  const app = createHostedServer({ directory, origin: "https://providence.fixture", encryptionKey: randomBytes(32) });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const anonymous = await fetch(base + "/meta", { redirect: "manual" });
    assert.equal(anonymous.status, 303);
    assert.equal(anonymous.headers.get("location"), "/account?next=%2Fmeta");
    const account = app.accounts.create("Spatial test");
    const token = app.accounts.session(account.id);
    const headers = { Cookie: `__Host-providence=${token}` };
    assert.equal((await fetch(base + "/meta", { headers })).status, 409);
    app.accounts.setKey(account.id, "synthetic-spatial-test-key");
    const quest = await fetch(base + "/quest/", { headers });
    const content = await quest.text();
    for (const route of ["/meta", "/meta/"]) {
      const spatial = await fetch(base + route, { headers });
      assert.equal(spatial.status, quest.status);
      assert.equal(await spatial.text(), content);
    }
    assert.equal((await fetch(base + "/metadata", { headers })).status, 404);
    assert.equal((await fetch(base + "/meta/assets/unknown", { headers })).status, 404);
    app.accounts.logout(token);
    assert.equal((await fetch(base + "/meta", { headers, redirect: "manual" })).status, 303);
    assert.equal((await fetch(base + "/quest/")).status, 401);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
