import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator.js";
import { createHttpServer } from "../src/server.js";
import { api, REQUEST_TIMEOUT_MS } from "../web/src/api.js";
import { downloadBlob, REVOKE_AFTER_MS } from "../web/src/download.js";
import { loadConfig } from "../src/config.js";
import { Pairing } from "../src/pairing.js";
test("web auth, exact origin, master history, one-use pairing, and revocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "providence-api-"));
  const config = {
    clientToken: "a".repeat(64),
    localDeviceId: "mac",
    localDeviceName: "Mac",
    workspace: dir,
    devices: [],
  };
  const app = new Coordinator(config, dir);
  const webRoot = join(dir, "web");
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, "index.html"), "<html>Providence</html>");
  const server = createHttpServer(app, config.clientToken, {
    publicOrigin: "https://providence.example",
    webRoot,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const auth = {
    Authorization: "Bearer " + config.clientToken,
    "Content-Type": "application/json",
  };
  try {
    assert.equal((await fetch(base + "/")).status, 200);
    assert.equal((await fetch(base + "/v1/tasks")).status, 401);
    assert.equal(
      (
        await fetch(base + "/v1/tasks", {
          headers: { ...auth, Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    app.store.createTask("req", "master", "coordinator", "hello");
    const response = await fetch(base + "/v1/tasks", {
      headers: { ...auth, Origin: "https://providence.example" },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).tasks[0].chatId, "master");
    const issue = await fetch(base + "/v1/devices/pair", {
      method: "POST",
      headers: { ...auth, Origin: "https://providence.example" },
      body: JSON.stringify({ name: "DemoPC" }),
    });
    assert.equal(issue.status, 201);
    const { code } = await issue.json();
    const exchange = await fetch(base + "/pair/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.match(/.{1,4}/g).join(" ") }),
    });
    assert.equal(exchange.status, 200);
    const paired = await exchange.json();
    assert.equal(paired.url, "wss://providence.example/worker");
    assert.ok(paired.token.length >= 32);
    const replay = await fetch(base + "/pair/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    assert.equal(replay.status, 400);
    const list = JSON.stringify(app.devices.list());
    assert.equal(list.includes(paired.token), false);
    assert.equal(app.config.devices.length, 1);
    assert.equal(
      (
        await fetch(base + "/v1/devices/" + paired.deviceId, {
          method: "DELETE",
          headers: auth,
        })
      ).status,
      200,
    );
    assert.equal(app.config.devices.length, 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a request that is never answered settles inside its budget and the next round still runs", async () => {
  const held: any[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/v1/never-answers") {
      held.push(response);
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ tasks: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  // The client builds coordinator-relative paths, so point them at this server
  // and keep the real network, the real hang and the real abort.
  const direct = globalThis.fetch;
  globalThis.fetch = ((input: any, init: any) =>
    direct(new URL(String(input), base), init)) as typeof fetch;
  try {
    const started = Date.now();
    await assert.rejects(
      api("b".repeat(64), "/never-answers"),
      (error: Error) => error.name === "TimeoutError",
    );
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < REQUEST_TIMEOUT_MS + 1000,
      `held request settled after ${elapsed}ms`,
    );
    assert.deepEqual(await api("b".repeat(64), "/tasks"), { tasks: [] });
  } finally {
    globalThis.fetch = direct;
    for (const response of held) response.destroy();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("artifact download attaches the link before clicking and keeps the object URL alive", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const steps: string[] = [];
  const created = t.mock.method(
    URL,
    "createObjectURL",
    () => "blob:artifact-fixture",
  );
  const revoked = t.mock.method(URL, "revokeObjectURL", () =>
    steps.push("revoke"),
  );
  const link = { href: "", download: "", click: () => steps.push("click") };
  const document = {
    createElement: () => link,
    body: {
      appendChild: (node: unknown) => {
        assert.equal(node, link);
        steps.push("append");
      },
      removeChild: (node: unknown) => {
        assert.equal(node, link);
        steps.push("remove");
      },
    },
  } as unknown as Document;
  downloadBlob(new Blob(["report"]), "report.md", document);
  assert.deepEqual(steps, ["append", "click", "remove"]);
  assert.equal(link.href, "blob:artifact-fixture");
  assert.equal(link.download, "report.md");
  assert.equal(created.mock.callCount(), 1);
  t.mock.timers.tick(REVOKE_AFTER_MS - 1);
  assert.deepEqual(steps, ["append", "click", "remove"]);
  t.mock.timers.tick(1);
  assert.deepEqual(steps, ["append", "click", "remove", "revoke"]);
  assert.equal(revoked.mock.calls[0].arguments[0], "blob:artifact-fixture");
});

type ServerOptions = Parameters<typeof createHttpServer>[2];
async function fixture(t: TestContext, options: ServerOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "providence-api-"));
  const config = {
    clientToken: "b".repeat(64),
    localDeviceId: "mac",
    localDeviceName: "Mac",
    workspace: dir,
    devices: [],
  };
  const app = new Coordinator(config, dir);
  const server = createHttpServer(app, config.clientToken, options);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    app,
    server,
    base: "http://127.0.0.1:" + (server.address() as { port: number }).port,
    auth: {
      Authorization: `Bearer ${config.clientToken}`,
      "Content-Type": "application/json",
    },
  };
}

test("a loopback browser origin is accepted only while no origin is configured", async (t) => {
  const configured = await fixture(t, { publicOrigin: "https://providence.example" });
  const refused = await fetch(configured.base + "/v1/tasks", {
    headers: { ...configured.auth, Origin: configured.base },
  });
  assert.equal(refused.status, 403);
  const development = await fixture(t, { publicOrigin: "", allowedOrigins: [] });
  assert.equal(
    (await fetch(development.base + "/v1/tasks", {
      headers: { ...development.auth, Origin: development.base },
    })).status,
    200,
  );
  assert.equal(
    (await fetch(development.base + "/v1/tasks", {
      headers: { ...development.auth, Origin: "http://localhost:1" },
    })).status,
    403,
  );
});

test("a configured origin with a trailing slash still admits the exact browser origin", async (t) => {
  const { base, auth } = await fixture(t, {
    publicOrigin: "https://providence.example/",
    allowedOrigins: [],
  });
  const headers = { ...auth, Origin: "https://providence.example" };
  assert.equal((await fetch(base + "/v1/tasks", { headers })).status, 200);
  const issued = await fetch(base + "/v1/devices/pair", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "DemoPC" }),
  });
  assert.equal(issued.status, 201);
  const paired = await (
    await fetch(base + "/pair/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: (await issued.json()).code }),
    })
  ).json();
  assert.equal(paired.url, "wss://providence.example/worker");
});

test("the browser allowlist is logged at listen and an unreachable bind is reported", async (t) => {
  const logged: string[] = [];
  const failed: string[] = [];
  t.mock.method(console, "log", (line: string) => { logged.push(line); });
  t.mock.method(console, "error", (line: string) => { failed.push(line); });
  const { server } = await fixture(t, { publicOrigin: "", allowedOrigins: [] });
  assert.deepEqual(logged, ["Allowed browser origins: none configured"]);
  assert.deepEqual(failed, []);
  (server as unknown as { address: () => unknown }).address = () => ({
    address: "0.0.0.0",
    family: "IPv4",
    port: 8787,
  });
  server.emit("listening");
  assert.equal(failed.length, 1);
  assert.match(failed[0], /PROVIDENCE_PUBLIC_ORIGIN/);
});

test("a live pairing code still redeems after twenty failures from the same address", async (t) => {
  const { base, auth } = await fixture(t, { publicOrigin: "https://providence.example" });
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const issue = async (path: string) =>
    (await (
      await fetch(base + path, {
        method: "POST",
        headers: { ...auth, Origin: "https://providence.example" },
        body: JSON.stringify({ name: "Operator" }),
      })
    ).json()).code as string;
  for (let i = 0; i < 20; i++)
    assert.equal((await post("/pair/exchange", { code: `WRONG${i}` })).status, 400);
  assert.equal((await post("/pair/exchange", { code: "WRONG" })).status, 429);
  assert.equal((await post("/pair/exchange", { code: await issue("/v1/devices/pair") })).status, 200);
  for (let i = 0; i < 20; i++)
    assert.equal((await post("/client/exchange", {})).status, 400);
  assert.equal((await post("/client/exchange", {})).status, 429);
  assert.equal((await post("/client/exchange", { code: await issue("/v1/clients/pair") })).status, 200);
});

test("the public version response carries the security headers and no host runtime version", async (t) => {
  const { base } = await fixture(t, { publicOrigin: "https://providence.example" });
  const response = await fetch(base + "/version");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  const body = await response.json();
  assert.equal("nodeVersion" in body, false);
  assert.equal(typeof body.commit, "string");
});

test("pairing keeps operator keys that this build does not know", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "providence-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({
    clientToken: "e".repeat(64),
    localDeviceId: "mac",
    localDeviceName: "Mac",
    workspace: join(dir, "workspace"),
    devices: [],
    futureSetting: { keep: true },
  }));
  const app = new Coordinator(loadConfig(file), dir);
  const pairing = new Pairing(app, "https://providence.example");
  const paired = pairing.exchange(pairing.issue("DemoPC").code);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(saved.futureSetting, { keep: true });
  assert.equal(saved.devices.length, 1);
  assert.equal(pairing.revoke(paired.deviceId).revoked, true);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).futureSetting, { keep: true });
});

test("the event feed returns a bounded batch and reports the oldest sequence it still holds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "providence-events-"));
  const config = { clientToken: "e".repeat(64), localDeviceId: "mac", localDeviceName: "Mac", workspace: dir, devices: [] };
  const app = new Coordinator(config, dir);
  const server = createHttpServer(app, config.clientToken, {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const auth = { Authorization: "Bearer " + config.clientToken };
  try {
    for (let index = 0; index < 1100; index++) app.store.event({ type: "chat.renamed", chatId: `chat-${index}` });
    const cold = await (await fetch(base + "/v1/events?after=0", { headers: auth })).json();
    assert.equal(cold.events.length, 200);
    assert.equal(cold.events.at(-1).sequence, 1100);
    assert.equal(cold.latestSequence, 1100);
    // The ring dropped the first hundred, so a client that stopped at sequence 1 can never be brought up to date.
    assert.equal(cold.oldestSequence, 101);
    const warm = await (await fetch(base + "/v1/events?after=1099", { headers: auth })).json();
    assert.equal(warm.events.length, 1);
    assert.equal(warm.events[0].sequence, 1100);
  } finally {
    server.close();
    app.store.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
