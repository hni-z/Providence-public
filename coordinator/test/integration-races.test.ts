import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createConnection, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import { Coordinator } from "../src/coordinator.js";
import { registrationEnded } from "../src/devices.js";
import { runtimeMetadata } from "../src/device-config.js";
import { Runtime, type Event } from "../src/runtime.js";
import type { ArtifactPayload } from "../src/artifacts.js";
import { createHttpServer } from "../src/server.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(devices: { id: string; name: string; token: string }[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "providence-races-"));
  const config = {
    clientToken: "c".repeat(64),
    localDeviceId: "mac",
    localDeviceName: "Test Mac",
    workspace: directory,
    devices,
  };
  const app = new Coordinator(config, directory);
  return {
    app,
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function payload(content: string, path = "result.txt"): ArtifactPayload {
  const bytes = Buffer.from(content);
  return {
    path,
    name: path,
    mime: "text/plain",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    base64: bytes.toString("base64"),
  };
}

test("terminal tasks ignore late artifact events and retain their original snapshot", () => {
  const f = fixture();
  try {
    for (const status of ["completed", "failed", "cancelled", "interrupted"]) {
      const task = f.app.store.createTask(
        status,
        `chat-${status}`,
        "mac",
        "Produce an output",
      ).task;
      f.app.event("mac", {
        type: "artifact.created",
        taskId: task.id,
        artifact: payload(`original-${status}`),
      });
      const original = task.artifacts![0];
      f.app.store.update(task.id, { status });
      const sequence = f.app.store.state.sequence;
      f.app.event("mac", {
        type: "artifact.created",
        taskId: task.id,
        artifact: payload(`late-${status}`),
      });
      assert.equal(
        task.artifacts!.length,
        1,
        `${status} must not accept a late output`,
      );
      assert.equal(
        f.app.store.state.sequence,
        sequence,
        "ignored output must not produce an artifact event",
      );
      assert.equal(
        f.app.artifacts.content(original.id).bytes.toString(),
        `original-${status}`,
      );
    }
  } finally {
    f.cleanup();
  }
});

test("historical task cannot displace a newer file revision, including direct publication", async () => {
  const f = fixture();
  try {
    const chat = f.app.store.addChat("Project", "mac", "thread-project");
    const oldTask = f.app.store.createTask(
      "first",
      chat.id,
      "mac",
      "Create result",
    ).task;
    const first = f.app.artifacts.save(oldTask, payload("version one"));
    f.app.store.update(oldTask.id, { status: "completed" });
    const newTask = f.app.store.createTask(
      "second",
      chat.id,
      "mac",
      "Revise result",
    ).task;
    const second = f.app.artifacts.save(newTask, payload("version two"));
    assert.equal(second.revision, first.revision + 1);
    assert.throws(
      () => f.app.artifacts.save(oldTask, payload("late version one")),
      /newer task/,
    );
    let reads = 0;
    f.app.devices.call = async () => {
      reads++;
      return payload("late version one");
    };
    await assert.rejects(
      f.app.publishArtifact(oldTask.id, "result.txt"),
      /latest task/,
    );
    assert.equal(
      reads,
      0,
      "historical publication must fail before reading a possibly revised workspace file",
    );
    const versions = Object.values(f.app.store.state.artifacts!);
    assert.equal(versions.length, 2);
    assert.equal(versions.at(-1)!.id, second.id);
    assert.equal(
      f.app.artifacts.content(first.id).bytes.toString(),
      "version one",
    );
    assert.equal(
      f.app.artifacts.content(second.id).bytes.toString(),
      "version two",
    );
  } finally {
    f.cleanup();
  }
});

test("queued master cancellation survives an awaited thread creation and skips execution", async () => {
  const f = fixture();
  const creation = deferred<{ threadId: string; workspace: string }>();
  try {
    let executions = 0;
    f.app.master.create = () => creation.promise;
    f.app.master.execute = async () => {
      executions++;
      return { turnId: "must-not-start" };
    };
    const task = await f.app.message({
      requestId: "queued-cancel",
      text: "Start a project",
    });
    assert.equal(task.status, "queued");
    await f.app.cancel(task.id);
    assert.equal(f.app.task(task.id).status, "cancelled");
    creation.resolve({
      threadId: "created-after-cancellation",
      workspace: f.directory,
    });
    await setImmediate();
    assert.equal(executions, 0);
    assert.equal(f.app.task(task.id).status, "cancelled");
    assert.equal(
      f.app.store.state.masterThreadId,
      "created-after-cancellation",
    );
    const retry = await f.app.message({
      requestId: "queued-cancel",
      text: "Start a project",
    });
    assert.equal(retry.id, task.id);
    assert.equal(
      executions,
      0,
      "a network retry must not replay the cancelled request",
    );
  } finally {
    f.cleanup();
  }
});

test("runtime cancellation before turn ID exists interrupts the exact turn once it arrives", async () => {
  const f = fixture();
  const runtime = new Runtime({ root: f.directory });
  const started = deferred<unknown>();
  const calls: { method: string; params: any }[] = [];
  try {
    runtime.rpc.call = async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/start")
        return { thread: { id: "thread-pending" }, model: "gpt-6-sol", reasoningEffort: "low", serviceTier: "priority" };
      if (method === "turn/start") return started.promise;
      if (method === "turn/interrupt") return {};
      throw new Error(`Unexpected RPC method ${method}`);
    };
    const chat = await runtime.create();
    const execution = runtime.execute(
      chat.threadId,
      "pending-task",
      "Do useful work",
    );
    assert.equal(calls.at(-1)!.method, "turn/start");
    const result = await runtime.cancel(chat.threadId);
    assert.deepEqual(result, {
      interrupted: false,
      cancellationRequested: true,
    });
    assert.equal(
      calls.filter((call) => call.method === "turn/interrupt").length,
      0,
    );
    started.resolve({ turn: { id: "late-turn-id" } });
    await execution;
    assert.deepEqual(
      calls.filter((call) => call.method === "turn/interrupt"),
      [
        {
          method: "turn/interrupt",
          params: { threadId: chat.threadId, turnId: "late-turn-id" },
        },
      ],
    );
  } finally {
    f.cleanup();
  }
});

test("runtime cancellation during thread import prevents a turn from starting", async () => {
  const f = fixture();
  const runtime = new Runtime({ root: f.directory });
  const read = deferred<unknown>();
  const methods: string[] = [];
  const events: Event[] = [];
  try {
    runtime.on("event", (event: Event) => events.push(event));
    runtime.rpc.call = async (method) => {
      methods.push(method);
      if (method === "thread/read") return read.promise;
      if (method === "thread/resume") return { model: "gpt-6-sol", reasoningEffort: "low", serviceTier: "priority" };
      throw new Error(`Unexpected RPC method ${method}`);
    };
    const execution = runtime.execute(
      "existing-thread",
      "import-cancel",
      "Continue work",
    );
    await runtime.cancel("existing-thread");
    read.resolve({ thread: { cwd: f.directory } });
    assert.deepEqual(await execution, { interrupted: true });
    assert.deepEqual(methods, ["thread/read", "thread/resume"]);
    assert.deepEqual(events.filter(event => event.type !== "runtime.timing"), [
      {
        type: "task.cancelled",
        taskId: "import-cancel",
        threadId: "existing-thread",
      },
    ]);
  } finally {
    f.cleanup();
  }
});

test("cancelled first request and its replacement share one master creation and preserve conversation identity", async () => {
  const f = fixture();
  const creation = deferred<{ threadId: string; workspace: string }>();
  const executions: { threadId: string; taskId: string; text: string }[] = [];
  try {
    let creations = 0;
    f.app.master.create = () => {
      creations++;
      return creation.promise;
    };
    f.app.master.execute = async (threadId, taskId, text) => {
      executions.push({ threadId, taskId, text });
      return { turnId: `turn-${taskId}` };
    };
    const cancelled = await f.app.message({
      requestId: "first-cancelled",
      text: "Original request",
    });
    await f.app.cancel(cancelled.id);
    const replacement = await f.app.message({
      requestId: "replacement",
      text: "Replacement request",
    });
    assert.equal(
      creations,
      1,
      "replacement must reuse the in-flight provider thread creation",
    );
    creation.resolve({ threadId: "shared-master", workspace: f.directory });
    await setImmediate();
    assert.equal(f.app.store.state.masterThreadId, "shared-master");
    assert.equal(f.app.task(cancelled.id).status, "cancelled");
    assert.deepEqual(executions, [
      {
        threadId: "shared-master",
        taskId: replacement.id,
        text: "Replacement request",
      },
    ]);
    f.app.event("coordinator", {
      type: "task.completed",
      taskId: replacement.id,
      text: "Finished",
    });
    const continuation = await f.app.message({
      requestId: "follow-up",
      text: "Continue the replacement",
    });
    await setImmediate();
    assert.equal(
      creations,
      1,
      "follow-up must retain the established main conversation",
    );
    assert.deepEqual(executions.at(-1), {
      threadId: "shared-master",
      taskId: continuation.id,
      text: "Continue the replacement",
    });
  } finally {
    f.cleanup();
  }
});

test("malformed public HTTP and upgrade URLs are rejected without stopping the server", async () => {
  const f = fixture();
  const webRoot = join(f.directory, "web");
  mkdirSync(join(webRoot, "assets", "directory-not-a-file"), {
    recursive: true,
  });
  const server = createHttpServer(f.app, f.app.config.clientToken, { webRoot });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  function rawRequest(headers: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      let response = "";
      socket.setEncoding("utf8");
      socket.setTimeout(2000, () =>
        socket.destroy(
          new Error("Malformed request did not receive a bounded response"),
        ),
      );
      socket.on("connect", () =>
        socket.write(
          `GET http://[ HTTP/1.1\r\nHost: localhost\r\n${headers}\r\n\r\n`,
        ),
      );
      socket.on("data", (chunk) => {
        response += chunk;
      });
      socket.on("error", reject);
      socket.on("close", () => resolve(response));
    });
  }
  try {
    assert.match(await rawRequest("Connection: close"), /^HTTP\/1\.1 400/);
    assert.match(
      await rawRequest(
        "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", // gitleaks:allow -- intentional synthetic security-test fixture
      ),
      /^HTTP\/1\.1 400/,
    );
    const base = `http://127.0.0.1:${port}`;
    assert.equal(
      (await fetch(base + "/assets/directory-not-a-file")).status,
      404,
    );
    assert.equal((await fetch(base + "/health")).status, 200);
    assert.equal(
      (await fetch(base + "/v1/tasks")).status,
      401,
      "invalid input must not affect authentication",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.cleanup();
  }
});

test("a data directory that disappears mid-run degrades the coordinator instead of ending it", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "providence-degraded-"));
  const token = "w".repeat(64);
  const config = {
    clientToken: "c".repeat(64),
    localDeviceId: "mac",
    localDeviceName: "Test Mac",
    workspace: directory,
    devices: [{ id: "windows", name: "Windows", token }],
  };
  t.mock.method(console, "error", () => {});
  const app = new Coordinator(config, directory);
  const server = createHttpServer(app, config.clientToken);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const task = app.store.createTask("request", "chat", "windows", "Do useful work").task;
    rmSync(directory, { recursive: true, force: true });
    app.event("windows", { type: "task.failed", taskId: task.id, error: "host stopped" });
    assert.equal(app.task(task.id).status, "failed", "a removed directory is recreated for the retry");
    assert.equal(app.storeDegraded, false);
    assert.deepEqual(await (await fetch(base + "/health")).json(), {
      status: "ok", service: "providence", storeDegraded: false,
    });
    // A path that cannot hold the state file at all: the write has nowhere left to retry.
    rmSync(directory, { recursive: true, force: true });
    writeFileSync(directory, "not a directory");
    app.event("windows", { type: "runtime.offline", error: "codex exited" });
    assert.deepEqual(await (await fetch(base + "/health")).json(), {
      status: "degraded", service: "providence", storeDegraded: true,
    });
    const socket = new WebSocket(`${base.replace("http", "ws")}/worker?deviceId=windows`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await once(socket, "open");
    const ready = once(app.devices, "online");
    socket.send(JSON.stringify({ kind: "ready" }));
    await ready;
    // Stands in for any handler fault while processing a device message.
    app.devices.once("event", () => {
      throw new Error("handler fault");
    });
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ kind: "event", event: { type: "task.failed", taskId: task.id } }));
    const [code] = await closed;
    assert.equal(code, 1011, "a message that cannot be handled closes only its own socket");
    assert.equal((await fetch(base + "/health")).status, 200, "the server still answers");
    socket.terminate();
  } finally {
    app.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a companion reconnecting after a drop keeps the newer socket", async () => {
  const f = fixture([{ id: "demoPC", name: "DemoPC", token: "d".repeat(64) }]);
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  server.on("connection", (socket) => f.app.devices.attach("demoPC", socket));
  const port = (server.address() as AddressInfo).port;
  const announce = (socket: WebSocket) => {
    const online = once(f.app.devices, "online");
    socket.send(
      JSON.stringify({ kind: "ready", metadata: runtimeMetadata(f.directory) }),
    );
    return online;
  };
  const dropped = new WebSocket(`ws://127.0.0.1:${port}`);
  let reconnected: WebSocket | undefined;
  try {
    await once(dropped, "open");
    await announce(dropped);
    assert.equal(f.app.devices.online("demoPC"), true);
    // The companion cannot see that its old socket is stale; it simply dials again.
    await delay(100);
    reconnected = new WebSocket(`ws://127.0.0.1:${port}`);
    let refused: number | undefined;
    reconnected.on("close", (code) => {
      refused = code;
    });
    await once(reconnected, "open");
    await delay(100);
    assert.equal(refused, undefined, "the newer socket must not be refused");
    assert.equal(dropped.readyState, WebSocket.CLOSED);
    await announce(reconnected);
    assert.equal(reconnected.readyState, WebSocket.OPEN);
    assert.equal(f.app.devices.online("demoPC"), true);
  } finally {
    for (const socket of server.clients) socket.terminate();
    dropped.terminate();
    reconnected?.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // The coordinator writes its state when a device goes offline, so let that land first.
    await delay(50);
    f.cleanup();
  }
});

test("revoking a device stops its companion and refuses its next connection", async () => {
  const token = "e".repeat(64);
  const f = fixture([{ id: "demoPC", name: "DemoPC", token }]);
  const server = createHttpServer(f.app, f.app.config.clientToken);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const workerUrl = `ws://127.0.0.1:${port}/worker?deviceId=demoPC`;
  const credential = { Authorization: `Bearer ${token}` };
  const companion = new WebSocket(workerUrl, { headers: credential });
  let refused: WebSocket | undefined;
  try {
    await once(companion, "open");
    const online = once(f.app.devices, "online");
    companion.send(
      JSON.stringify({ kind: "ready", metadata: runtimeMetadata(f.directory) }),
    );
    await online;
    const closed = once(companion, "close");
    const revoked = await fetch(`http://127.0.0.1:${port}/v1/devices/demoPC`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${f.app.config.clientToken}` },
    });
    assert.equal(revoked.status, 200);
    const [, reason] = await closed;
    assert.equal(
      registrationEnded(reason.toString()),
      true,
      "the companion must read the close as terminal",
    );
    refused = new WebSocket(workerUrl, { headers: credential });
    // A rejected handshake aborts the socket, which ws reports as an error.
    refused.on("error", () => {});
    const [, response] = await once(refused, "unexpected-response");
    response.resume();
    assert.equal([401, 403].includes(response.statusCode ?? 0), true);
  } finally {
    companion.terminate();
    refused?.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // The coordinator writes its state when a device goes offline, so let that land first.
    await delay(50);
    f.cleanup();
  }
});

test("a turn the provider never answers fails on the watchdog and frees its chat", async () => {
  const f = fixture();
  const runtime = new Runtime({ root: f.directory, turnTimeoutMs: 5 });
  try {
    runtime.rpc.call = async (method) => {
      if (method === "thread/start")
        return { thread: { id: "thread-stalled" }, model: "gpt-6-sol", reasoningEffort: "low", serviceTier: "priority" };
      if (method === "turn/start") return { turn: { id: "turn-stalled" } };
      throw new Error(`Unexpected RPC method ${method}`);
    };
    const created = await runtime.create();
    const chat = f.app.store.addChat("Stalled", "mac", created.threadId);
    const task = f.app.store.createTask("stalled", chat.id, "mac", "Do useful work").task;
    f.app.store.update(task.id, { status: "running" });
    runtime.on("event", (event: Event) => f.app.event("mac", event));
    await runtime.execute(created.threadId, task.id, "Do useful work");
    // The watchdog is unref'd and does not hold the event loop open; this poll does.
    for (let waited = 0; waited < 2000; waited += 5) {
      if (f.app.task(task.id).status !== "running") break;
      await delay(5);
    }
    assert.equal(f.app.task(task.id).status, "failed");
    assert.equal(
      f.app.task(task.id).error,
      "No provider turn result was received; inspect the host before resubmitting.",
    );
    assert.equal((runtime as any).active.size, 0, "a stalled turn must not keep holding its chat");
    assert.equal(
      f.app.store.createTask("next", chat.id, "mac", "Try again").created,
      true,
      "the chat must accept a new message",
    );
    assert.deepEqual(await runtime.execute(created.threadId, "next-task", "Try again"), {
      turnId: "turn-stalled",
    });
  } finally {
    runtime.stop();
    f.cleanup();
  }
});

test("cancelling a task the provider no longer knows releases it instead of bricking its chat", async () => {
  const f = fixture([{ id: "windows", name: "Windows", token: "w".repeat(64) }]);
  try {
    const chat = f.app.store.addChat("Project", "windows", "thread-project");
    const task = f.app.store.createTask("stuck", chat.id, "windows", "Do useful work").task;
    f.app.store.update(task.id, { status: "running" });
    f.app.devices.online = () => true;
    f.app.devices.call = async () => {
      throw new Error("No active turn");
    };
    assert.deepEqual(await f.app.cancel(task.id), { interrupted: false, released: true });
    assert.equal(f.app.task(task.id).status, "interrupted");
    assert.equal(
      f.app.task(task.id).error,
      "No active provider turn; the task was released without confirming host state.",
    );
    assert.equal(
      f.app.store.createTask("next", chat.id, "windows", "Try again").created,
      true,
      "the chat must accept a new message",
    );
    const second = f.app.store.addChat("Other project", "windows", "thread-other");
    const other = f.app.store.createTask("other", second.id, "windows", "More work").task;
    f.app.store.update(other.id, { status: "running" });
    f.app.devices.call = async () => {
      throw new Error("Device disconnected");
    };
    await assert.rejects(f.app.cancel(other.id), /Device disconnected/);
    assert.equal(f.app.task(other.id).status, "running", "an unrelated failure must not release a task");
  } finally {
    f.cleanup();
  }
});

test("an interrupt the provider never confirms cancels the task once, even if a turn result arrives late", async () => {
  const f = fixture();
  const runtime = new Runtime({ root: f.directory, cancelGraceMs: 5 });
  try {
    runtime.rpc.call = async (method) => {
      if (method === "thread/start")
        return { thread: { id: "thread-silent" }, model: "gpt-6-sol", reasoningEffort: "low", serviceTier: "priority" };
      if (method === "turn/start") return { turn: { id: "turn-silent" } };
      if (method === "turn/interrupt") return {};
      throw new Error(`Unexpected RPC method ${method}`);
    };
    const created = await runtime.create();
    const chat = f.app.store.addChat("Silent", "mac", created.threadId);
    const task = f.app.store.createTask("silent", chat.id, "mac", "Do useful work").task;
    f.app.store.update(task.id, { status: "running" });
    runtime.on("event", (event: Event) => f.app.event("mac", event));
    await runtime.execute(created.threadId, task.id, "Do useful work");
    assert.deepEqual(await runtime.cancel(created.threadId), { interrupted: true });
    assert.equal(f.app.task(task.id).status, "running", "the provider is given its grace period first");
    // The grace timer is unref'd and does not hold the event loop open; this poll does.
    for (let waited = 0; waited < 2000; waited += 5) {
      if (f.app.task(task.id).status !== "running") break;
      await delay(5);
    }
    assert.equal(f.app.task(task.id).status, "cancelled");
    const terminal = () =>
      f.app.store.state.events.filter(
        (event) => event.taskId === task.id && event.type.startsWith("task."),
      );
    assert.deepEqual(terminal().map((event) => event.type), ["task.cancelled"]);
    runtime.rpc.emit("notification", "turn/completed", {
      threadId: created.threadId,
      turn: { id: "turn-silent", status: "completed" },
    });
    f.app.event("mac", { type: "task.completed", taskId: task.id, text: "Late result" });
    assert.deepEqual(terminal().map((event) => event.type), ["task.cancelled"]);
    assert.equal(f.app.task(task.id).status, "cancelled");
  } finally {
    runtime.stop();
    f.cleanup();
  }
});
