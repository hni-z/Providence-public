import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/runtime.js";
import {
  readRuntimeProfile, verifyRuntimeProfileAvailable, verifyResolvedRuntimeProfile,
} from "../src/runtime-profile.js";
import { configSchema, localWorkerProfile } from "../src/config.js";

const expected = { model: "gpt-6-sol", reasoningEffort: "low", serviceTier: "priority" };
const catalogModel = {
  id: "sol", model: "gpt-6-sol", supportedReasoningEfforts: [{ reasoningEffort: "low" }],
  serviceTiers: [{ id: "priority", name: "Fast" }],
};

test("Providence profile defaults are scoped, immutable, and reject malformed explicit overrides", () => {
  assert.deepEqual(readRuntimeProfile({}), expected);
  const env = { PROVIDENCE_MODEL: "custom-model", PROVIDENCE_REASONING_EFFORT: "medium", PROVIDENCE_SERVICE_TIER: "custom-tier" };
  const profile = readRuntimeProfile(env);
  assert.deepEqual(profile, { model: "custom-model", reasoningEffort: "medium", serviceTier: "custom-tier" });
  env.PROVIDENCE_MODEL = "later-change";
  assert.equal(profile.model, "custom-model");
  assert.equal(Object.isFrozen(profile), true);
  assert.deepEqual(readRuntimeProfile({ PROVIDENCE_MODEL: "gpt-5.6-sol" }), {
    model: "gpt-5.6-sol", reasoningEffort: "low", serviceTier: "priority",
  }, "An explicit older model remains an override rather than being silently upgraded");
  assert.deepEqual(
    readRuntimeProfile(env, { model: "role-model", reasoningEffort: "high" }),
    { model: "role-model", reasoningEffort: "high", serviceTier: "custom-tier" },
  );
  for (const key of Object.keys(env))
    for (const value of ["", " ", "low\n", " value", "value ", "bad=value"])
      assert.throws(() => readRuntimeProfile({ [key]: value }), new RegExp(key));
});

test("existing local worker overrides remain distinct from companion aliases and master profile", () => {
  const base = { clientToken: "t".repeat(32), localDeviceId: "mac", localDeviceName: "Mac", workspace: "/tmp/work" };
  const configured = configSchema.parse({
    ...base, localWorkerModel: "local-sol", localWorkerReasoningEffort: "low",
    workerModel: "local-sol", workerReasoningEffort: "low",
    masterModel: "master-sol", masterReasoningEffort: "medium",
  });
  assert.deepEqual(localWorkerProfile(configured), { model: "local-sol", reasoningEffort: "low" });
  assert.deepEqual(readRuntimeProfile({}, { model: configured.masterModel, reasoningEffort: configured.masterReasoningEffort }),
    { model: "master-sol", reasoningEffort: "medium", serviceTier: "priority" });
  assert.throws(() => configSchema.parse({ ...base, localWorkerModel: "one", workerModel: "two" }), /conflicts/);
});

test("authenticated model catalog validates model, effort, and canonical tier without fallback", async () => {
  const profile = readRuntimeProfile({});
  const requests: any[] = [];
  await verifyRuntimeProfileAvailable(profile, async (method, params) => {
    assert.equal(method, "model/list");
    requests.push(params);
    return params.cursor ? { data: [catalogModel], nextCursor: null } : { data: [], nextCursor: "page-2" };
  });
  assert.deepEqual(requests, [
    { limit: 100, includeHidden: true },
    { limit: 100, includeHidden: true, cursor: "page-2" },
  ]);
  for (const [model, pattern] of [
    [{ ...catalogModel, model: "another-model" }, /not available/],
    [{ ...catalogModel, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }, /not supported/],
    [{ ...catalogModel, serviceTiers: [], additionalSpeedTiers: ["fast"] }, /not advertised/],
    [{ ...catalogModel, serviceTiers: [{ id: "fast" }] }, /not advertised/],
  ] as const)
    await assert.rejects(verifyRuntimeProfileAvailable(profile, async () => ({ data: [model], nextCursor: null })), pattern);
  await assert.rejects(verifyRuntimeProfileAvailable(profile, async () => ({})), /did not return a model catalog/);
  await assert.rejects(verifyRuntimeProfileAvailable(profile, async () => ({ data: [], nextCursor: "same-page" })), /pagination/);
  await assert.rejects(verifyRuntimeProfileAvailable(profile, async () => { throw new Error("catalog unavailable"); }), /catalog unavailable/);
  const custom = readRuntimeProfile({ PROVIDENCE_MODEL: "custom-model", PROVIDENCE_REASONING_EFFORT: "medium", PROVIDENCE_SERVICE_TIER: "custom-tier" });
  await verifyRuntimeProfileAvailable(custom, async () => ({ data: [{
    model: custom.model, supportedReasoningEfforts: [{ reasoningEffort: "medium" }], serviceTiers: [{ id: "custom-tier" }],
  }] }));
});

test("new workers and resumed old master threads override saved profiles on every turn without changing access", async () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-profile-"));
  const root = realpathSync(directory);
  try {
    for (const options of [{ master: true }, { workerAccess: "workspace" as const }, { workerAccess: "full-access" as const }]) {
      const runtime = new Runtime({ root, ...options });
      const calls: { method: string; params: any }[] = [];
      const fullAccess = !options.master && options.workerAccess === "full-access";
      runtime.rpc.start = async () => {};
      runtime.rpc.call = async (method, params) => {
        calls.push({ method, params });
        if (method === "account/read") return { account: { type: "chatgpt" } };
        if (method === "permissionProfile/list") return { data: [{ id: ":danger-full-access", allowed: true }] };
        if (method === "model/list") return { data: [catalogModel], nextCursor: null };
        if (method === "thread/read") return { thread: { cwd: root, model: "gpt-6-astra", reasoningEffort: "ultra" } };
        if (method === "thread/start" || method === "thread/resume") return {
          thread: { id: "chat" }, ...expected,
          approvalPolicy: fullAccess ? "never" : "on-request",
          sandbox: { type: fullAccess ? "dangerFullAccess" : options.master ? "readOnly" : "workspaceWrite" },
        };
        if (method === "turn/start") return { turn: { id: "turn" } };
        throw new Error(`Unexpected method ${method}`);
      };
      await runtime.start();
      if (!options.master) await runtime.create();
      for (const taskId of ["first", "second"]) {
        await runtime.execute("chat", taskId, "Use the configured device");
        runtime.rpc.emit("notification", "turn/completed", { threadId: "chat", turn: { id: "turn", status: "completed" } });
      }
      assert.equal(calls.filter(call => call.method === "model/list").length, 1);
      const thread = calls.find(call => call.method === (options.master ? "thread/resume" : "thread/start"))!;
      assert.equal(thread.params.model, "gpt-6-sol");
      assert.equal(thread.params.serviceTier, "priority");
      assert.deepEqual(thread.params.config, { model_reasoning_effort: "low" });
      assert.equal(thread.params.approvalPolicy, fullAccess ? "never" : "on-request");
      assert.equal(thread.params.permissions, fullAccess ? ":danger-full-access" : undefined);
      assert.equal(thread.params.sandbox, fullAccess ? undefined : options.master ? "read-only" : "workspace-write");
      const turns = calls.filter(call => call.method === "turn/start");
      assert.equal(turns.length, 2);
      for (const { params } of turns) assert.deepEqual(params, {
        threadId: "chat", input: [{ type: "text", text: "Use the configured device" }],
        model: "gpt-6-sol", effort: "low", serviceTier: "priority",
      });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("unconfirmed or downgraded resumed profiles reject execution before any turn and can be retried", async () => {
  const root = mkdtempSync(join(tmpdir(), "providence-profile-reject-"));
  try {
    const runtime = new Runtime({ root, master: true });
    let actual: any = { ...expected, reasoningEffort: "ultra" };
    let turns = 0;
    runtime.rpc.call = async method => {
      if (method === "thread/read") return { thread: { cwd: root } };
      if (method === "thread/resume") return actual;
      if (method === "turn/start") { turns++; return { turn: { id: "turn" } }; }
      throw new Error(`Unexpected method ${method}`);
    };
    for (const candidate of [actual, { ...expected, model: "gpt-6-astra" }, { ...expected, serviceTier: null }, {}]) {
      actual = candidate;
      await assert.rejects(runtime.execute("old-master", "task", "Work"), /did not confirm/);
      assert.equal(turns, 0);
    }
    actual = { ...expected };
    await runtime.execute("old-master", "task", "Work");
    assert.equal(turns, 1);
    verifyResolvedRuntimeProfile(readRuntimeProfile({}), actual);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
