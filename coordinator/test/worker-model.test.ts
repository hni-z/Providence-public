import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { validateWorkerModel, workerModelSettings } from "../src/worker-model.js";

test("settings trim bounded explicit worker model and advertised effort values", () => {
  const schema = z.object(workerModelSettings);
  assert.deepEqual(schema.parse({ localWorkerModel: "  model-a  ", localWorkerReasoningEffort: "  experimental  " }), { localWorkerModel: "model-a", localWorkerReasoningEffort: "experimental" });
  assert.throws(() => schema.parse({ localWorkerModel: "   " }));
  assert.throws(() => schema.parse({ localWorkerReasoningEffort: "   " }));
  assert.throws(() => schema.parse({ localWorkerReasoningEffort: "x".repeat(81) }));
  assert.throws(() => schema.parse({ localWorkerModel: "x".repeat(201) }));
});

test("no scoped setting makes no model-list RPC call and never selects a default tier", async () => {
  let calls = 0;
  const result = await validateWorkerModel({ call: async () => { calls++; return { data: [] }; } });
  assert.equal(result, undefined);
  assert.equal(calls, 0);
});

test("finds the exact requested model through a bounded paginated listing", async () => {
  const calls: unknown[] = [];
  const result = await validateWorkerModel({ call: async (_method, params) => {
    calls.push(params);
    return calls.length === 1
      ? { data: [{ id: "fast-default-id", model: "fast-default", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }], isDefault: true }], nextCursor: "page-2" }
      : { data: [{ id: "requested-id", model: "requested-model", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }, { reasoningEffort: "ultra", description: "" }] }] };
  } }, "requested-id", "high");
  assert.deepEqual(result, { model: "requested-model", effort: "high" });
  assert.deepEqual(calls, [{}, { cursor: "page-2" }]);
});

test("rejects an unsupported effort or effort without an explicit model before work", async () => {
  let calls = 0;
  await assert.rejects(
    validateWorkerModel({ call: async () => { calls++; return { data: [] }; } }, undefined, "high"),
    /requires an explicit localWorkerModel/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    validateWorkerModel({ call: async () => ({ data: [{ id: "requested-id", model: "requested-model", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }] }] }) }, "requested-model", "ultra"),
    /does not support reasoning effort/,
  );
});

test("stops on malformed or repeated pagination instead of silently falling back", async () => {
  await assert.rejects(
    validateWorkerModel({ call: async () => ({ data: [], nextCursor: "again" }) }, "requested-model"),
    /repeated a page cursor/,
  );
  await assert.rejects(
    validateWorkerModel({ call: async () => ({ unexpected: [] }) }, "requested-model"),
    /returned no models/,
  );
});
