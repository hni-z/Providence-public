import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { Coordinator } from "../src/coordinator.js";
import { assetFile, createHttpServer } from "../src/server.js";

test("built assets resolve under either platform separator and never escape the assets directory", () => {
  for (const [path, root] of [
    [win32, "C:\\providence\\quest\\dist"],
    [posix, "/srv/providence/quest/dist"],
  ] as const) {
    assert.equal(assetFile(root, "/assets/app.js", path), path.join(root, "assets", "app.js"));
    assert.equal(assetFile(root, "/assets/../../config.json", path), null);
    assert.equal(assetFile(root, "/assets-other/app.js", path), null);
  }
});

async function pairingFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "providence-pairing-http-"));
  const config = {
    clientToken: "c".repeat(64), localDeviceId: "test-mac",
    localDeviceName: "Synthetic Mac", workspace: dir, devices: [],
  };
  const app = new Coordinator(config, dir);
  const server = createHttpServer(app, config.clientToken, { publicOrigin: "https://coordinator.example" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const owner = { Authorization: `Bearer ${config.clientToken}` };
  const post = (path: string, body: unknown, headers = {}) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const issue = async (kind = "client") => {
    const response = await post(`/v1/${kind === "client" ? "clients" : "devices"}/pair`, { name: "Synthetic Watch" }, owner);
    assert.equal(response.status, 201);
    return response.json();
  };
  return { base, owner, post, issue };
}

test("client HTTP exchange keeps session shape, normalization, replay rejection and owner access", async (t) => {
  const { base, owner, post, issue } = await pairingFixture(t);
  assert.equal((await post("/v1/clients/pair", { name: "Watch" })).status, 401);
  const code = await issue();
  assert.match(code.code, /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
  const response = await post("/client/exchange", { code: code.code.toLowerCase().replace("-", " \t-\n") });
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.deepEqual(Object.keys(session).sort(), ["clientId", "expiresAt", "token"]);
  assert.match(session.token, /^[a-f0-9]{64}$/);
  assert.ok(Math.abs(Date.parse(session.expiresAt) - Date.now() - 24 * 60 * 60 * 1000) < 5000);
  assert.equal((await post("/client/exchange", { code: code.code })).status, 400);
  assert.equal((await fetch(base + "/v1/clients", { headers: { Authorization: `Bearer ${session.token}` } })).status, 403);
  assert.equal((await fetch(base + "/v1/clients", { headers: owner })).status, 200);
});

test("malformed client exchanges return the generic error without invalidating other codes", async (t) => {
  const { base, post, issue } = await pairingFixture(t);
  const first = await issue();
  const second = await issue();
  const bodies = [{}, { code: 42 }, { code: "" }, { code: "X".repeat(51) }];
  for (let i = 0; i < 9; i++) {
    const response = await post("/client/exchange", bodies[i % bodies.length]);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Client code is invalid or expired" });
  }
  const tenth = await fetch(base + "/client/exchange", { method: "POST", body: "{" });
  assert.equal(tenth.status, 400);
  assert.deepEqual(await tenth.json(), { error: "Client code is invalid or expired" });
  for (const code of [first.code, second.code])
    assert.equal((await post("/client/exchange", { code })).status, 200);
});

test("parallel HTTP issuance stays within ten pending codes; invalid guesses leave live codes redeemable", async (t) => {
  const { owner, post } = await pairingFixture(t);
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    post("/v1/clients/pair", { name: `Watch ${i}` }, owner)));
  const codes: string[] = [];
  for (const response of responses) {
    const body = await response.json();
    if (response.status === 201) codes.push(body.code);
    else assert.match(body.error, /Too many pending client codes/);
  }
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  const failures = await Promise.all(Array.from({ length: 10 }, () => post("/client/exchange", { code: "wrong" })));
  for (const response of failures) assert.equal(response.status, 400);
  for (const code of codes) assert.equal((await post("/client/exchange", { code })).status, 200);
});

for (const [kind, endpoint, otherKind, otherEndpoint] of [
  ["client", "/client/exchange", "device", "/pair/exchange"],
  ["device", "/pair/exchange", "client", "/client/exchange"],
]) {
  test(`${kind} HTTP failures survive same-endpoint success and reset only at the window deadline`, async (t) => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const { post, issue } = await pairingFixture(t);
    for (let i = 0; i < 19; i++)
      assert.equal((await post(endpoint, { code: "wrong" })).status, 400);
    const valid = await issue(kind);
    assert.equal((await post(endpoint, { code: valid.code })).status, 200);
    const waiting = await issue(kind);
    assert.equal((await post(endpoint, { code: "wrong" })).status, 400);
    // A live code is not a guess, so a shared address budget cannot hold it.
    assert.equal((await post(endpoint, { code: waiting.code })).status, 200);
    assert.equal((await post(endpoint, { code: "wrong" })).status, 429);
    now += 59999;
    assert.equal((await post(endpoint, { code: "wrong" })).status, 429);
    now++;
    assert.equal((await post(endpoint, { code: "wrong" })).status, 400);
  });

  test(`${kind} failures neither lock nor reset the other endpoint, and forwarded addresses are ignored`, async (t) => {
    const { post, issue } = await pairingFixture(t);
    for (let i = 0; i < 19; i++)
      assert.equal((await post(endpoint, { code: "wrong" }, { "X-Forwarded-For": `192.0.2.${i}` })).status, 400);
    const other = await issue(otherKind);
    assert.equal((await post(otherEndpoint, { code: other.code })).status, 200);
    assert.equal((await post(endpoint, { code: "wrong" })).status, 400);
    const blocked = await issue(kind);
    assert.equal((await post(endpoint, { code: "wrong" }, { "X-Forwarded-For": "198.51.100.1" })).status, 429);
    assert.equal((await post(endpoint, { code: blocked.code }, { "X-Forwarded-For": "198.51.100.1" })).status, 200);
    const stillAvailable = await issue(otherKind);
    assert.equal((await post(otherEndpoint, { code: stillAvailable.code })).status, 200);
  });

  test(`${kind} concurrent HTTP failures all count toward the address budget`, async (t) => {
    const { post } = await pairingFixture(t);
    const responses = await Promise.all(Array.from({ length: 20 }, () => post(endpoint, { code: "wrong" })));
    for (const response of responses) assert.equal(response.status, 400);
    assert.equal((await post(endpoint, { code: "wrong" })).status, 429);
  });
}

test("canonical and compatibility origins remain exact; Quest assets and reusable/client authentication stay bounded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "providence-http-"));
  const config = {
    clientToken: "c".repeat(64),
    localDeviceId: "mac",
    localDeviceName: "Mac",
    workspace: dir,
    devices: [],
  };
  const app = new Coordinator(config, dir);
  const webRoot = join(dir, "web"),
    questRoot = join(dir, "quest");
  mkdirSync(webRoot);
  mkdirSync(join(questRoot, "assets"), { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<html>Main</html>");
  writeFileSync(join(questRoot, "index.html"), "<html>Quest</html>");
  writeFileSync(join(questRoot, "assets", "app.js"), "/*Quest*/");
  const server = createHttpServer(app, config.clientToken, {
    webRoot,
    questRoot,
    publicOrigin: "https://providence.hani.so",
    allowedOrigins: ["https://htn.hani.so"],
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const auth = {
    Authorization: "Bearer " + config.clientToken,
    "Content-Type": "application/json",
  };
  try {
    for (const origin of ["https://providence.hani.so", "https://htn.hani.so"])
      assert.equal(
        (
          await fetch(base + "/v1/tasks", {
            headers: { ...auth, Origin: origin },
          })
        ).status,
        200,
      );
    assert.equal(
      (
        await fetch(base + "/v1/tasks", {
          headers: { ...auth, Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    const q = await fetch(base + "/quest/deep");
    assert.equal(await q.text(), "<html>Quest</html>");
    assert.match(
      q.headers.get("permissions-policy")!,
      /microphone=\(self\), xr-spatial-tracking=\(self\)/,
    );
    assert.equal(q.headers.get("cache-control"), "no-store");
    assert.equal(
      await (await fetch(base + "/quest/assets/app.js")).text(),
      "/*Quest*/",
    );
    assert.equal(
      await (await fetch(base + "/quest-not-a-prefix")).text(),
      "<html>Main</html>",
    );
    const p = await (
      await fetch(base + "/v1/clients/pair", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "Test Quest" }),
      })
    ).json();
    const exchanged = await (
      await fetch(base + "/client/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: p.code }),
      })
    ).json();
    assert.equal(
      (
        await fetch(base + "/v1/tasks", {
          headers: { Authorization: "Bearer " + exchanged.token },
        })
      ).status,
      200,
    );
    assert.equal(
      readFileSync(join(dir, "client-sessions.json"), "utf8").includes(
        exchanged.token,
      ),
      false,
    );
    assert.equal(
      (
        await fetch(base + "/v1/clients/" + exchanged.clientId, {
          method: "DELETE",
          headers: auth,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(base + "/v1/tasks", {
          headers: { Authorization: "Bearer " + exchanged.token },
        })
      ).status,
      401,
    );
    assert.equal(
      (await fetch(base + "/v1/tasks", { headers: auth })).status,
      200,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
test("transcription discovery, authentication, MIME normalization and exact retries use one device call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "providence-audio-http-"));
  const config = {
    clientToken: "c".repeat(64),
    localDeviceId: "mac",
    localDeviceName: "Mac",
    workspace: dir,
    devices: [],
  };
  const app = new Coordinator(config, dir);
  app.devices.list = () =>
    [
      {
        id: "demoPC",
        name: "DemoPC",
        online: true,
        capabilities: {
          files: true,
          shell: true,
          browser: false,
          desktop: false,
          phoneMirroring: false,
          transcription: true,
        },
      },
    ] as any;
  let calls = 0;
  app.devices.call = async (id, method, p) => {
    assert.equal(id, "demoPC");
    assert.equal(method, "audio.transcribe");
    assert.equal(p.mimeType, "audio/webm");
    calls++;
    return { text: "Create a checklist" };
  };
  const server = createHttpServer(app, config.clientToken);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const headers = {
    Authorization: "Bearer " + config.clientToken,
    "Content-Type": "application/json",
  };
  try {
    assert.equal((await fetch(base + "/v1/transcriptions")).status, 401);
    const discovery = await (
      await fetch(base + "/v1/transcriptions", { headers })
    ).json();
    assert.equal(discovery.transcription.available, true);
    assert.equal(discovery.transcription.maxAudioBytes, 524288);
    const body = {
      requestId: "audio-1",
      deviceId: "demoPC",
      mimeType: "audio/webm;codecs=opus",
      base64: Buffer.from("fixture-audio").toString("base64"),
    };
    const post = () =>
      fetch(base + "/v1/transcriptions", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    const first = await post();
    assert.equal(first.status, 202);
    const job = await first.json();
    const retry = await (await post()).json();
    assert.equal(retry.id, job.id);
    assert.equal(calls, 1);
    const result = await (
      await fetch(base + "/v1/transcriptions/" + job.id, { headers })
    ).json();
    assert.equal(result.status, "completed");
    assert.equal(result.text, "Create a checklist");
    assert.equal(
      (
        await fetch(base + "/v1/transcriptions", {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...body,
            base64: Buffer.from("changed").toString("base64"),
          }),
        })
      ).status,
      409,
    );
    assert.equal(calls, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
