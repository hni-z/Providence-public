import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { issueCode } from "./issue-code.mjs";

const token = "synthetic-owner-token-".repeat(4);
const code = { code: "ABCD-2345-6789", expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "watch-pairing-helper-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "config.json"), JSON.stringify({ clientToken: token }), { mode: 0o600 });
  return dir;
}

test("helper uses private config on loopback, refuses redirects, makes one request and returns only code/expiry", async (t) => {
  const dataDirectory = await fixture(t);
  let calls = 0;
  const result = await issueCode({ dataDirectory, port: "12345", name: " Synthetic Watch ", fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, "http://127.0.0.1:12345/v1/clients/pair");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), { name: "Synthetic Watch" });
    return Response.json({ ...code, token, other: "must not print" }, { status: 201 });
  } });
  assert.deepEqual(result, code);
  assert.equal(calls, 1);
});

test("configuration, transport and server errors never surface credential text or retry", async (t) => {
  const dataDirectory = await fixture(t);
  for (const response of [
    () => { throw new Error(token); },
    () => Response.json({ error: token }, { status: 401 }),
    () => Response.json({ ...code, code: token }, { status: 201 }),
    () => Response.json({ ...code, expiresAt: token }, { status: 201 }),
    () => Response.json({ ...code, expiresAt: new Date(0).toISOString() }, { status: 201 }),
    () => Response.json({ ...code, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }, { status: 201 }),
    () => new Response(token, { status: 201 }),
  ]) {
    let calls = 0;
    await assert.rejects(issueCode({ dataDirectory, fetchImpl: async () => { calls++; return response(); } }), (error) => {
      assert.equal(error.message.includes(token), false);
      assert.match(error.message, /no automatic retry/);
      return true;
    });
    assert.equal(calls, 1);
  }
  await writeFile(join(dataDirectory, "config.json"), token);
  await assert.rejects(issueCode({ dataDirectory }), (error) => {
    assert.equal(error.message.includes(token), false);
    return true;
  });
});

test("invalid ports and labels fail before any request", async (t) => {
  const dataDirectory = await fixture(t);
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("must not fetch"); };
  for (const port of ["0", "65536", "8787@remote.example", "https://remote.example", "12.5"])
    await assert.rejects(issueCode({ dataDirectory, port, fetchImpl }));
  for (const name of ["", " ", "x".repeat(121)])
    await assert.rejects(issueCode({ dataDirectory, name, fetchImpl }));
  assert.equal(calls, 0);
});

test("CLI prints only code/expiry and suppresses arbitrary server error bodies", async (t) => {
  const dataDirectory = await fixture(t);
  let requests = 0;
  let success = true;
  const server = createServer(async (req, res) => {
    requests++;
    assert.equal(req.url, "/v1/clients/pair");
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    for await (const _chunk of req) { /* drain the synthetic request */ }
    res.writeHead(success ? 201 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify(success ? { ...code, token } : { error: token }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const run = () => promisify(execFile)(process.execPath, [fileURLToPath(new URL("./issue-code.mjs", import.meta.url)), "--name", "Synthetic Watch"], {
    env: { ...process.env, PROVIDENCE_DATA_DIR: dataDirectory, PORT: String(server.address().port) },
  });
  const { stdout, stderr } = await run();
  assert.equal(stdout, JSON.stringify(code) + "\n");
  assert.equal(stderr, "");
  success = false;
  await assert.rejects(run(), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    assert.equal(error.stderr.includes(token), false);
    assert.match(error.stderr, /Could not issue a Watch pairing code/);
    return true;
  });
  assert.equal(requests, 2);
});
