import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, StoreLockError } from "../src/store.js";
import { tokenMatches } from "../src/config.js";
import { Coordinator } from "../src/coordinator.js";
import { createHttpServer } from "../src/server.js";
import { WebSocket } from "ws";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "providence-test-"));
  const config = {
    clientToken: "c".repeat(64),
    localDeviceId: "mac",
    localDeviceName: "test",
    workspace: dir,
    devices: [{ id: "windows", name: "windows", token: "w".repeat(64) }],
  };
  return {
    dir,
    config,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test("retries do not duplicate work; changed input and overlapping chat are rejected", () => {
  const f = fixture();
  try {
    const s = new Store(join(f.dir, "state.json"));
    const a = s.createTask("r", "chat", "mac", "hello");
    const b = s.createTask("r", "chat", "mac", "hello");
    assert.equal(a.task.id, b.task.id);
    assert.equal(b.created, false);
    assert.throws(() => s.createTask("r", "chat", "mac", "changed"));
    assert.throws(() => s.createTask("r2", "chat", "mac", "hello"));
    s.update(a.task.id, { status: "completed" });
    assert.equal(s.createTask("r2", "chat", "mac", "next").created, true);
  } finally {
    f.cleanup();
  }
});
test("restart does not silently replay unfinished jobs or preserve usable approvals", () => {
  const f = fixture();
  try {
    const path = join(f.dir, "state.json");
    const s = new Store(path);
    const t = s.createTask("r", "c", "mac", "hello").task;
    s.state.approvals.a = {
      id: "a",
      taskId: t.id,
      deviceId: "mac",
      method: "approval",
      details: {},
      status: "pending",
    };
    s.save();
    s.stop();
    const next = new Store(path);
    assert.equal(next.state.tasks[t.id].status, "interrupted");
    assert.equal(next.state.approvals.a.status, "expired");
    assert.equal(next.findRequest("r")?.id, t.id);
  } finally {
    f.cleanup();
  }
});
test("a remote device cannot forge completion of another device task", () => {
  const f = fixture();
  try {
    const c = new Coordinator(f.config, f.dir);
    const t = c.store.createTask("r", "c", "mac", "hello").task;
    c.event("windows", {
      type: "task.completed",
      taskId: t.id,
      text: "forged",
    });
    assert.equal(t.status, "queued");
    c.event("mac", { type: "task.completed", taskId: t.id, text: "real" });
    assert.equal(t.status, "completed");
    assert.equal(t.text, "real");
  } finally {
    f.cleanup();
  }
});
test("explicit context transfer is recorded and requests to offline hosts fail", async () => {
  const f = fixture();
  try {
    const c = new Coordinator(f.config, f.dir);
    const source = c.store.addChat("brief", "mac", "thread1");
    source.history.push({ role: "user", text: "launch Friday", taskId: "old" });
    const target = c.store.addChat("edit", "mac", "thread2");
    let sent: any;
    c.devices.online = () => true;
    c.devices.call = async (_id, method, p) => {
      sent = { method, p };
      return {};
    };
    await c.dispatch(target.id, {
      requestId: "r",
      text: "make it",
      sourceChatIds: [source.id],
    });
    assert.match(sent.p.text, /launch Friday/);
    assert.equal(
      c.store.state.events.some((e) => e.type === "context.transferred"),
      true,
    );
    c.devices.online = () => false;
    await assert.rejects(
      c.dispatch(source.id, { requestId: "r2", text: "new" }),
      /offline/,
    );
  } finally {
    f.cleanup();
  }
});
test("approval can be resolved once and only through the explicit user endpoint", async () => {
  const f = fixture();
  try {
    const c = new Coordinator(f.config, f.dir);
    const t = c.store.createTask("r", "c", "mac", "hello").task;
    c.event("mac", {
      type: "approval.requested",
      taskId: t.id,
      approvalId: "approval1",
      method: "item/commandExecution/requestApproval",
      details: { command: "example" },
    });
    let calls = 0;
    c.devices.call = async () => {
      calls++;
      return { resolved: true };
    };
    await c.approval("approval1", "decline");
    await assert.rejects(
      c.approval("approval1", "accept"),
      /no longer pending/,
    );
    assert.equal(calls, 1);
  } finally {
    f.cleanup();
  }
});
test("HTTP and worker connections require distinct configured credentials", async () => {
  const f = fixture();
  const c = new Coordinator(f.config, f.dir);
  const server = createHttpServer(c, f.config.clientToken);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  try {
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/v1/chats`)).status,
      401,
    );
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}/v1/chats`, {
          headers: { Authorization: `Bearer ${f.config.clientToken}` },
        })
      ).status,
      200,
    );
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/worker?deviceId=windows`,
        { headers: { Authorization: `Bearer ${f.config.clientToken}` } },
      );
      ws.on("open", () => {
        ws.close();
        reject(new Error("Client credential incorrectly accepted as device"));
      });
      ws.on("error", (e) => {
        try {
          assert.match(e.message, /401/);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    assert.equal(tokenMatches("bad", f.config.clientToken), false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    f.cleanup();
  }
});
test("a truncated state file restarts from its backup instead of refusing to start", (t) => {
  const f = fixture();
  const errors: string[] = [];
  t.mock.method(console, "error", (message: unknown) => errors.push(String(message)));
  try {
    const path = join(f.dir, "state.json");
    const first = new Store(path);
    const chat = first.addChat("Demo", "mac", "thread-demo");
    const task = first.createTask("r", chat.id, "mac", "hello").task;
    first.update(task.id, { status: "completed" });
    first.stop();
    const good = readFileSync(path, "utf8");
    writeFileSync(path, good.slice(0, Math.floor(good.length / 2)));
    const recovered = new Store(path);
    assert.equal(recovered.state.chats[chat.id]?.name, "Demo");
    // The backup is the snapshot before the last write, so its task is still unfinished on restart.
    assert.equal(recovered.state.tasks[task.id]?.status, "interrupted");
    assert.equal(recovered.findRequest("r")?.id, task.id);
    assert.equal(errors.some((message) => message.includes("state.json.bak")), true);
    recovered.stop();
    writeFileSync(path, "{");
    writeFileSync(path + ".bak", "also truncated");
    const empty = new Store(path);
    assert.deepEqual(empty.state.chats, {});
    assert.equal(errors.some((message) => message.includes("empty state")), true);
    empty.stop();
  } finally {
    f.cleanup();
  }
});
test("a second coordinator cannot share a live data directory, but may take over an abandoned one", () => {
  const f = fixture();
  try {
    const path = join(f.dir, "state.json");
    const first = new Store(path);
    assert.throws(() => new Store(path), (error: unknown) => {
      assert.equal(error instanceof StoreLockError, true);
      assert.match((error as Error).message, /already in use by process/);
      return true;
    });
    first.stop();
    const second = new Store(path);
    second.stop();
    // A host that was powered off leaves its lock behind; the next start must not be blocked by it.
    writeFileSync(join(f.dir, "state.lock"), "2147483647");
    const third = new Store(path);
    third.stop();
  } finally {
    f.cleanup();
  }
});
