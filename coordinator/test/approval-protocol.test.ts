import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime, type Event } from "../src/runtime.js";
import { ProviderRequestError, approvalDetails, structuredApprovalResult } from "../src/approval-protocol.js";
import { runtimeRequest } from "../src/devices.js";
import { Store } from "../src/store.js";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "providence-approvals-"));
  const runtime = new Runtime({ root });
  runtime.rpc.call = async method => method === "thread/start" ? { thread: { id: "thread" }, model: "gpt-6-sol", reasoningEffort: "low", serviceTier: "priority" } : { turn: { id: "turn" } };
  await runtime.create();
  await runtime.execute("thread", "task", "Fixture action");
  const events: Event[] = [];
  runtime.on("event", event => events.push(event));
  return { root, runtime, events, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const form = {
  threadId: "thread", turnId: "turn", serverName: "fixture-provider", mode: "form", message: "Choose the exact options",
  requestedSchema: { type: "object", properties: {
    name: { type: "string", minLength: 2, maxLength: 20 },
    count: { type: "integer", minimum: 1, maximum: 3 },
    confirmed: { type: "boolean" },
    format: { type: "string", oneOf: [{ const: "brief", title: "Brief" }, { const: "full", title: "Full" }] },
    days: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", enum: ["Friday", "Saturday"] } },
  }, required: ["name", "count", "confirmed", "format", "days"] },
  _meta: { opaqueProviderMetadata: "must-not-be-echoed" },
};

test("elicitation retains provider/task identity, validates fields and sends exactly one explicit response", async () => {
  const f = await fixture();
  try {
    const pending = f.runtime.rpc.onRequest!("mcpServer/elicitation/request", form, "provider-request");
    const approval = f.events.find(event => event.type === "approval.requested")!;
    assert.equal(approval.taskId, "task");
    assert.equal(approval.threadId, "thread");
    assert.equal(approval.providerRequestId, "provider-request");
    assert.equal(approval.details.providerRequestId, "provider-request");
    assert.equal(approval.details.kind, "elicitation");
    assert.throws(() => f.runtime.resolveApproval(approval.approvalId, "accept"), /structured response/);
    assert.throws(() => f.runtime.resolveApproval(approval.approvalId, undefined, undefined, { kind: "elicitation", action: "accept", content: { name: "A" } }), /required/);
    const content = { name: "Cedar", count: 2, confirmed: false, format: "brief", days: ["Friday"] };
    for (const invalid of [{ ...content, count: 4 }, { ...content, confirmed: "yes" }, { ...content, format: "unrequested" }, { ...content, days: ["Friday", "Friday"] }, { ...content, surprise: true }])
      assert.throws(() => f.runtime.resolveApproval(approval.approvalId, undefined, undefined, { kind: "elicitation", action: "accept", content: invalid }));
    await runtimeRequest(f.runtime, "approval.resolve", { approvalId: approval.approvalId, response: { kind: "elicitation", action: "accept", content } });
    assert.deepEqual(await pending, { action: "accept", content, _meta: null });
    assert.throws(() => f.runtime.resolveApproval(approval.approvalId, undefined, undefined, { kind: "elicitation", action: "cancel" }), /no longer pending/);
  } finally { f.cleanup(); }
});

test("unsupported rich forms and unsafe URL flows can be declined or cancelled but never accepted", () => {
  for (const mode of ["openai/form", "openaiForm", "openai/userVerification"]) {
    const details = approvalDetails("mcpServer/elicitation/request", { ...form, mode }, 4);
    assert.ok(details.unsupportedReason);
    assert.throws(() => structuredApprovalResult("mcpServer/elicitation/request", details, { kind: "elicitation", action: "accept", content: {} }), /cannot be accepted/);
    assert.deepEqual(structuredApprovalResult("mcpServer/elicitation/request", details, { kind: "elicitation", action: "cancel" }), { action: "cancel", content: null, _meta: null });
  }
  const unsupported = approvalDetails("mcpServer/elicitation/request", { ...form, requestedSchema: { type: "object", properties: { nested: { type: "object" } } } }, 4);
  assert.ok(unsupported.unsupportedReason);
  const unsafe = approvalDetails("mcpServer/elicitation/request", { ...form, mode: "url", url: "javascript:bad()", elicitationId: "url-flow" }, 4);
  assert.ok(unsafe.unsupportedReason);
  const url = approvalDetails("mcpServer/elicitation/request", { ...form, mode: "url", url: "https://example.com/confirm", elicitationId: "url-flow" }, 4);
  assert.deepEqual(structuredApprovalResult("mcpServer/elicitation/request", url, { kind: "elicitation", action: "accept" }), { action: "accept", content: null, _meta: null });
  assert.throws(() => structuredApprovalResult("mcpServer/elicitation/request", url, { kind: "elicitation", action: "decline", content: { hidden: "answer" } }), /must not contain/);
});

test("permissions require a structured requested subset, preserve exclusions, and reject privilege expansion", async () => {
  const f = await fixture();
  try {
    const denied = { path: { type: "path" as const, path: "/workspace/private" }, access: "deny" as const };
    const params = { threadId: "thread", turnId: "turn", itemId: "item", environmentId: null, startedAtMs: 1, cwd: "/workspace", reason: "Write the requested output", permissions: {
      network: null, fileSystem: { read: ["/workspace/input"], write: ["/workspace/output"], entries: [denied], globScanMaxDepth: 3 },
    } };
    const pending = f.runtime.rpc.onRequest!("item/permissions/requestApproval", params, 7);
    const approval = f.events.find(event => event.type === "approval.requested")!;
    assert.equal(approval.details.kind, "permissions");
    assert.throws(() => f.runtime.resolveApproval(approval.approvalId, "accept"), /structured/);
    for (const permissions of [
      { network: { enabled: true } },
      { fileSystem: { read: null, write: ["/"], entries: [denied] } },
      { fileSystem: { read: null, write: ["/workspace/output"], entries: [] } },
      { fileSystem: { read: null, write: ["/workspace/output"], entries: [denied], globScanMaxDepth: 4 } },
    ]) assert.throws(() => f.runtime.resolveApproval(approval.approvalId, undefined, undefined, { kind: "permissions", permissions, scope: "turn" }));
    const permissions = { fileSystem: { read: null, write: ["/workspace/output"], entries: [denied] } };
    f.runtime.resolveApproval(approval.approvalId, undefined, undefined, { kind: "permissions", permissions, scope: "turn" });
    assert.deepEqual(await pending, { permissions: { fileSystem: { ...permissions.fileSystem, globScanMaxDepth: 3 } }, scope: "turn" });
    const deny = f.runtime.rpc.onRequest!("item/permissions/requestApproval", params, 8);
    const next = f.events.filter(event => event.type === "approval.requested").at(-1)!;
    f.runtime.resolveApproval(next.approvalId, undefined, undefined, { kind: "permissions", permissions: {}, scope: "turn" });
    assert.deepEqual(await deny, { permissions: {}, scope: "turn" });
  } finally { f.cleanup(); }
});

test("omitted and null permission fields normalize to no grant without rejecting valid provider requests", () => {
  const base = { threadId: "thread", turnId: "turn", cwd: "/workspace", itemId: "item" };
  const networkOnly = approvalDetails("item/permissions/requestApproval", { ...base, permissions: { network: { enabled: true } } }, 1);
  assert.equal(networkOnly.permissions.fileSystem, null);
  assert.deepEqual(structuredApprovalResult("item/permissions/requestApproval", networkOnly, { kind: "permissions", permissions: { network: { enabled: true } }, scope: "turn" }), { permissions: { network: { enabled: true } }, scope: "turn" });
  const empty = approvalDetails("item/permissions/requestApproval", { ...base, permissions: {} }, 2);
  assert.deepEqual(empty.permissions, { network: null, fileSystem: null });
  assert.throws(() => structuredApprovalResult("item/permissions/requestApproval", empty, { kind: "permissions", permissions: { network: { enabled: true } }, scope: "turn" }), /not requested/);
  const paths = approvalDetails("item/permissions/requestApproval", { ...base, permissions: { fileSystem: { write: ["/workspace/output"], entries: null, globScanMaxDepth: null } } }, 3);
  assert.equal(paths.permissions.network, null);
  assert.equal(paths.permissions.fileSystem.read, null);
  assert.equal(paths.permissions.fileSystem.entries, undefined);
  assert.equal(paths.permissions.fileSystem.globScanMaxDepth, undefined);
  assert.throws(() => structuredApprovalResult("item/permissions/requestApproval", paths, { kind: "permissions", permissions: { fileSystem: { read: null, write: ["/"] } }, scope: "turn" }), /unrequested/);
  const roots = approvalDetails("item/permissions/requestApproval", { ...base, permissions: { fileSystem: { entries: [{ access: "read", path: { type: "special", value: { kind: "project_roots" } } }] } } }, 4);
  assert.equal(roots.permissions.fileSystem.entries[0].path.value.subpath, null);
  assert.equal(roots.permissions.fileSystem.read, null);
  assert.throws(() => approvalDetails("item/permissions/requestApproval", { ...base, permissions: { fileSystem: { globScanMaxDepth: 0 } } }, 5), ProviderRequestError);
});

test("legacy command decisions are restricted to the offered supported options", async () => {
  const f = await fixture();
  try {
    const params = { threadId: "thread", turnId: "turn", itemId: "command", command: "example", availableDecisions: ["decline", "cancel"] };
    const pending = f.runtime.rpc.onRequest!("item/commandExecution/requestApproval", params, 21);
    const approval = f.events.find(event => event.type === "approval.requested")!;
    assert.throws(() => f.runtime.resolveApproval(approval.approvalId, "accept"), /not offered/);
    f.runtime.resolveApproval(approval.approvalId, "decline");
    assert.deepEqual(await pending, { decision: "decline" });
    const legacy = f.runtime.rpc.onRequest!("item/commandExecution/requestApproval", { ...params, availableDecisions: null }, 22);
    const next = f.events.filter(event => event.type === "approval.requested").at(-1)!;
    f.runtime.resolveApproval(next.approvalId, "accept");
    assert.deepEqual(await legacy, { decision: "accept" });
    const specific = f.runtime.rpc.onRequest!("item/commandExecution/requestApproval", { ...params, availableDecisions: ["acceptForSession", "cancel"] }, 23);
    const last = f.events.filter(event => event.type === "approval.requested").at(-1)!;
    assert.throws(() => f.runtime.resolveApproval(last.approvalId, "accept"), /not offered/);
    assert.throws(() => f.runtime.resolveApproval(last.approvalId, "acceptForSession"), /Choose/);
    f.runtime.resolveApproval(last.approvalId, "cancel");
    assert.deepEqual(await specific, { decision: "cancel" });
  } finally { f.cleanup(); }
});

test("provider-cleared approvals expire only for the exact thread and typed provider request ID", async () => {
  const f = await fixture();
  try {
    const pending = f.runtime.rpc.onRequest!("mcpServer/elicitation/request", form, 9);
    const rejected = assert.rejects(pending, error => error instanceof ProviderRequestError && error.code === "request_cleared");
    const approval = f.events.find(event => event.type === "approval.requested")!;
    f.runtime.rpc.emit("notification", "serverRequest/resolved", { threadId: "wrong-thread", requestId: 9 });
    f.runtime.rpc.emit("notification", "serverRequest/resolved", { threadId: "thread", requestId: "9" });
    assert.equal(f.events.filter(event => event.type === "approval.expired").length, 0);
    f.runtime.rpc.emit("notification", "serverRequest/resolved", { threadId: "thread", requestId: 9 });
    await rejected;
    assert.equal(f.events.filter(event => event.type === "approval.expired").length, 1);
    assert.throws(() => f.runtime.resolveApproval(approval.approvalId, undefined, undefined, { kind: "elicitation", action: "accept", content: {} }), /no longer pending/);
  } finally { f.cleanup(); }
});

test("unsupported requests and stale-turn requests produce sanitized diagnostics without approval", async () => {
  const f = await fixture();
  try {
    const secret = "secret-fixture-must-not-be-logged";
    await assert.rejects(f.runtime.rpc.onRequest!(`unknown\n${secret}`, { threadId: "thread", value: secret }, "unknown"), ProviderRequestError);
    await assert.rejects(f.runtime.rpc.onRequest!("mcpServer/elicitation/request", { ...form, turnId: "old-turn" }, "stale"), ProviderRequestError);
    assert.equal(f.events.filter(event => event.type === "approval.requested").length, 0);
    assert.equal(f.events.filter(event => event.type === "runtime.unsupported_request").length, 2);
    assert.equal(JSON.stringify(f.events).includes(secret), false);
  } finally { f.cleanup(); }
});

test("restart expires resolving approvals while preserving provider correlation", () => {
  const root = mkdtempSync(join(tmpdir(), "providence-approval-restart-"));
  try {
    const file = join(root, "state.json");
    const original = new Store(file);
    original.state.approvals.approval = { id: "approval", taskId: "task", deviceId: "mac", method: "mcpServer/elicitation/request", details: {}, status: "resolving", providerRequestId: 42 };
    original.save();
    original.stop();
    const restored = new Store(file);
    assert.equal(restored.state.approvals.approval.status, "expired");
    assert.equal(restored.state.approvals.approval.providerRequestId, 42);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime emits bounded tool feedback only for its active thread and turn", async () => {
  const f = await fixture();
  try {
    const payload = { threadId: "thread", turnId: "turn", item: { id: "tool", type: "commandExecution", command: "echo ready", status: "completed", exitCode: 0, aggregatedOutput: "ready", arguments: { privateToken: "not-for-client" }, _meta: { secret: "not-for-client" } } };
    f.runtime.rpc.emit("notification", "item/completed", { ...payload, threadId: "other-thread" });
    f.runtime.rpc.emit("notification", "item/completed", { ...payload, turnId: "old-turn" });
    assert.equal(f.events.length, 0);
    f.runtime.rpc.emit("notification", "item/started", payload);
    f.runtime.rpc.emit("notification", "item/completed", payload);
    assert.equal(f.events.filter(event => event.type === "tool.started").length, 1);
    assert.equal(f.events.filter(event => event.type === "tool.completed").length, 1);
    const result = f.events.find(event => event.type === "tool.completed")!;
    assert.equal(result.taskId, "task");
    assert.equal(result.threadId, "thread");
    assert.equal(result.output, "ready");
    assert.equal(JSON.stringify(f.events).includes("not-for-client"), false);
  } finally { f.cleanup(); }
});

test("retired product decisions never create approvals, regardless of option labels", async () => {
  const f = await fixture();
  try {
    for (const options of [["Ship it", "Ship it"], ["Ship it", "Hold"]]) {
      const result = await f.runtime.rpc.onRequest!("item/tool/call", { threadId: "thread", turnId: "turn", tool: "providence_request_decision", arguments: { question: "Choose the exact scope", options } }, "provider-request");
      assert.equal(result.success, false);
    }
    assert.equal(f.events.filter(event => event.type === "approval.requested").length, 0);
  } finally { f.cleanup(); }
});
