import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalDetails, approvalResponseSchema, structuredApprovalResult } from "../src/approval-protocol.js";
import { Runtime, type Event } from "../src/runtime.js";

const method = "mcpServer/elicitation/request";
const request = { threadId: "thread", turnId: "turn", serverName: "fixture-provider", mode: "form",
  message: "Allow this exact fixture action?", requestedSchema: { type: "object", properties: {} } };

test("only advertised session/always modes survive normalization, without opaque metadata", () => {
  for (const [persist, expected] of [
    ["session", ["session"]], ["always", ["always"]],
    [["always", "session", "always"], ["session", "always"]],
    [["unknown", 42, "session"], ["session"]],
    ["forever", undefined], [true, undefined], [{ always: true }, undefined], [null, undefined],
  ] as [unknown, unknown][]) {
    const details = approvalDetails(method, { ...request, _meta: { persist, privateField: "must-not-survive" } }, 1);
    assert.deepEqual(details.persistenceModes, expected);
    assert.equal(Object.hasOwn(details, "_meta"), false);
    assert.equal(JSON.stringify(details).includes("must-not-survive"), false);
  }
  for (const meta of [undefined, null, "always", ["always"], {}])
    assert.equal(approvalDetails(method, { ...request, _meta: meta }, 1).persistenceModes, undefined);
});

test("advertising persistence does not select it; explicit accepted choice produces only persist metadata", () => {
  const details = approvalDetails(method, { ...request, _meta: { persist: ["session", "always"], ignored: true } }, 1);
  assert.deepEqual(structuredApprovalResult(method, details, { kind: "elicitation", action: "accept", content: {} }),
    { action: "accept", content: {}, _meta: null });
  for (const persist of ["session", "always"] as const)
    assert.deepEqual(structuredApprovalResult(method, details, { kind: "elicitation", action: "accept", content: {}, _meta: { persist } }),
      { action: "accept", content: null, _meta: { persist } });
  assert.deepEqual(structuredApprovalResult(method, details, { kind: "elicitation", action: "accept", content: null, _meta: { persist: "session" } }),
    { action: "accept", content: null, _meta: { persist: "session" } });
});

test("unoffered or previously unrecorded persistence is rejected without changing one-time acceptance", () => {
  const oneTime = approvalDetails(method, request, 1);
  const sessionOnly = approvalDetails(method, { ...request, _meta: { persist: "session" } }, 2);
  assert.throws(() => structuredApprovalResult(method, oneTime, { kind: "elicitation", action: "accept", content: {}, _meta: { persist: "session" } }), /did not offer/);
  assert.throws(() => structuredApprovalResult(method, sessionOnly, { kind: "elicitation", action: "accept", content: {}, _meta: { persist: "always" } }), /did not offer/);
  assert.deepEqual(structuredApprovalResult(method, oneTime, { kind: "elicitation", action: "accept", content: {}, _meta: null }),
    { action: "accept", content: {}, _meta: null });
});

test("malformed metadata, extra scope, and persistence attached to decline/cancel are rejected", () => {
  const details = approvalDetails(method, { ...request, _meta: { persist: "always" } }, 1);
  for (const meta of ["always", ["always"], {}, { persist: ["always"] }, { persist: true }, { persist: "forever" },
    { persist: "always", scope: "session" }, { persist: "always", arbitraryPermission: true }, { secret: "not-echoed" }])
    assert.equal(approvalResponseSchema.safeParse({ kind: "elicitation", action: "accept", content: {}, _meta: meta }).success, false);
  for (const action of ["decline", "cancel"] as const) {
    assert.throws(() => structuredApprovalResult(method, details, { kind: "elicitation", action, content: null, _meta: { persist: "always" } }), /accepted request/);
    assert.deepEqual(structuredApprovalResult(method, details, { kind: "elicitation", action, content: null, _meta: null }), { action, content: null, _meta: null });
  }
});

test("unsupported rich/URL forms cannot acquire persistence through the classic-form adapter", () => {
  for (const mode of ["openai/form", "openaiForm", "openai/userVerification", "url"]) {
    const details = approvalDetails(method, { ...request, mode, url: "https://example.com/confirm", elicitationId: "url-flow", _meta: { persist: "always" } }, 1);
    assert.equal(details.persistenceModes, undefined);
    assert.throws(() => structuredApprovalResult(method, details, { kind: "elicitation", action: "accept", content: mode === "url" ? null : {}, _meta: { persist: "always" } }), /did not offer/);
  }
  const ordinaryFields = approvalDetails(method, { ...request,
    requestedSchema: { type: "object", properties: { name: { type: "string" } } }, _meta: { persist: "always" } }, 2);
  assert.equal(ordinaryFields.persistenceModes, undefined);
  assert.throws(() => structuredApprovalResult(method, ordinaryFields,
    { kind: "elicitation", action: "accept", content: { name: "Example" }, _meta: { persist: "always" } }), /did not offer/);
});

test("runtime preserves an offered mode on that pending request and forwards only the explicitly selected choice", async () => {
  const root = mkdtempSync(join(tmpdir(), "providence-persistence-"));
  try {
    const runtime = new Runtime({ root });
    runtime.rpc.call = async method => method === "thread/start" ? { thread: { id: "thread" }, model: "gpt-6-sol", reasoningEffort: "low", serviceTier: "priority" } : { turn: { id: "turn" } };
    await runtime.create();
    await runtime.execute("thread", "task", "Fixture action");
    const events: Event[] = [];
    runtime.on("event", event => events.push(event));
    const pending = runtime.rpc.onRequest!(method, { ...request, _meta: { persist: "session", opaque: "not-returned" } }, 17);
    const approval = events.find(event => event.type === "approval.requested")!;
    assert.deepEqual(approval.details.persistenceModes, ["session"]);
    assert.throws(() => runtime.resolveApproval(approval.approvalId, undefined, undefined,
      { kind: "elicitation", action: "accept", content: {}, _meta: { persist: "always" } }), /did not offer/);
    runtime.resolveApproval(approval.approvalId, undefined, undefined,
      { kind: "elicitation", action: "accept", content: {}, _meta: { persist: "session" } });
    assert.deepEqual(await pending, { action: "accept", content: null, _meta: { persist: "session" } });
    assert.equal(events.find(event => event.type === "approval.resolved")?.requestedPersistence, "session");
    assert.equal(JSON.stringify(events).includes("not-returned"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
