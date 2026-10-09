import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appleAppIdsFromEnvironment, validateAppleAppIds } from "../src/hosted/associated-domains.js";
import { createHostedServer } from "../src/hosted/server.js";

const apps = ["ABCDE12345.com.example.Providence", "ZYXWV98765.org.example.Second-app"];
const paths = ["/.well-known/apple-app-site-association", "/apple-app-site-association"];

async function fixture(appleAppIds?: readonly string[]) {
  const directory = mkdtempSync(join(tmpdir(), "providence-associated-domains-"));
  const app = createHostedServer({ directory, origin: "https://providence.example", encryptionKey: randomBytes(32), appleAppIds,
    validateApiKey: async () => assert.fail("Association retrieval must not validate a provider key") });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  return { app, base: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`,
    async close() { await app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("Apple app IDs are explicit, deduplicated identifiers and environment parsing rejects malformed entries", () => {
  assert.deepEqual(validateAppleAppIds(undefined), []);
  assert.deepEqual(validateAppleAppIds([]), []);
  assert.deepEqual(appleAppIdsFromEnvironment(undefined), []);
  assert.deepEqual(appleAppIdsFromEnvironment(" \t "), []);
  assert.deepEqual(appleAppIdsFromEnvironment(` ${apps[0]}, ${apps[1]}, ${apps[0]} `), apps);
  for (const invalid of [null, apps[0], {}, [null], [3], [""], ["*"], ["ABCDE12345.*"], ["*.com.example.app"],
    ["ABCDE12345.com.example.*"], ["ABCDE12345.com..example"], ["ABCDE12345.com.example."],
    ["ABCDE12345.com_example.app"], ["abcde12345.com.example.app"], ["SHORT.com.example.app"],
    ["ABCDE12345.com.example/app"], ["ABCDE12345.com.example.app?mode=developer"], ["ABCDE12345.com.example.app\n"],
    ["ABCDE12345." + "a".repeat(256)], [apps[0], "invalid"]]) {
    assert.throws(() => validateAppleAppIds(invalid), /Invalid PROVIDENCE_APPLE_APP_IDS/);
  }
  for (const value of [",", `${apps[0]},`, `,${apps[0]}`, `${apps[0]}, ,${apps[1]}`]) {
    assert.throws(() => appleAppIdsFromEnvironment(value), /Invalid PROVIDENCE_APPLE_APP_IDS/);
  }
});

test("invalid associated-domain configuration fails startup before creating hosted state", () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-invalid-association-"));
  try {
    for (const invalid of [["ABCDE12345.*"], null, "ABCDE12345.com.example.app"]) {
      const state = join(directory, "must-not-exist");
      assert.throws(() => createHostedServer({ directory: state, origin: "https://providence.example", encryptionKey: randomBytes(32),
        appleAppIds: invalid as unknown as readonly string[] }), /Invalid PROVIDENCE_APPLE_APP_IDS/);
      assert.equal(existsSync(state), false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("both association URLs serve exact webcredentials JSON publicly without redirects or sessions", async () => {
  const configured = [...apps];
  const f = await fixture(configured);
  configured.push("ABCDE12345.com.example.AddedAfterStartup");
  try {
    f.app.accounts.authenticate = () => assert.fail("Public association retrieval must not require session lookup");
    for (const path of paths) {
      const response = await fetch(f.base + path, { redirect: "manual", headers: { Origin: "https://another.example", Cookie: "untrusted=ignored" } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("location"), null);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.match(response.headers.get("content-type")!, /^application\/json(?:;|$)/);
      assert.equal(response.headers.get("cache-control"), "public, max-age=300, must-revalidate");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      const body = await response.text();
      assert.equal(Number(response.headers.get("content-length")), Buffer.byteLength(body));
      assert.deepEqual(JSON.parse(body), { webcredentials: { apps } });
    }
  } finally { await f.close(); }
});

test("HEAD has the same association representation headers and no response body", async () => {
  const f = await fixture(apps);
  try {
    for (const path of paths) {
      const get = await fetch(f.base + path), expected = await get.text();
      const head = await fetch(f.base + path, { method: "HEAD", redirect: "manual" });
      assert.equal(head.status, 200);
      for (const header of ["content-type", "cache-control", "content-length"]) assert.equal(head.headers.get(header), get.headers.get(header));
      assert.equal(Number(head.headers.get("content-length")), Buffer.byteLength(expected));
      assert.equal(await head.text(), "");
    }
  } finally { await f.close(); }
});

test("unconfigured association endpoints fail closed for GET and HEAD without caching a trust list", async () => {
  for (const configuration of [undefined, []]) {
    const f = await fixture(configuration);
    try {
      for (const path of paths) for (const method of ["GET", "HEAD"]) {
        const response = await fetch(f.base + path, { method, redirect: "manual" });
        assert.equal(response.status, 404);
        assert.equal(response.headers.get("location"), null);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const body = await response.text();
        if (method === "HEAD") assert.equal(body, "");
        else { assert.deepEqual(JSON.parse(body), { error: "Not found" }); assert.ok(!body.includes("webcredentials")); }
      }
    } finally { await f.close(); }
  }
});

test("association routes reject writes and do not expose similarly named paths", async () => {
  const f = await fixture(apps);
  try {
    for (const path of paths) {
      const response = await fetch(f.base + path, { method: "POST", body: "{}", redirect: "manual" });
      assert.equal(response.status, 405); assert.equal(response.headers.get("allow"), "GET, HEAD");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await fetch(f.base + path + ".json")).status, 404);
      assert.equal((await fetch(f.base + path + "/extra")).status, 404);
    }
  } finally { await f.close(); }
});
