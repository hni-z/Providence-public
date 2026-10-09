import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
const config = loadConfig();
const base = process.env.PROVIDENCE_URL ?? "http://127.0.0.1:8787";
async function api(path: string, body?: any) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${config.clientToken}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j;
}
async function wait(id: string) {
  const end = Date.now() + 240000;
  while (Date.now() < end) {
    const t = await api("/v1/tasks/" + id);
    if (t.status === "needs_input")
      throw new Error(
        "Smoke task needs human input. Inspect /v1/briefing; nothing was auto-approved.",
      );
    if (
      ["completed", "failed", "cancelled", "interrupted"].includes(t.status)
    ) {
      assert.equal(t.status, "completed", t.error);
      return t;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Smoke timed out; inspect task state.");
}
const run = randomUUID().slice(0, 8),
  filename = `smoke-${run}.txt`,
  marker = `providence-${run}`;
const chat = await api("/v1/chats", {
  deviceId: config.localDeviceId,
  name: `Smoke ${run}`,
});
console.log("Created real Codex conversation", chat.id);
const req = {
  requestId: randomUUID(),
  text: `Create the file ${filename} in the current workspace containing exactly ${marker}. Do not modify anything else. Verify by reading it. Remember this file for my next request.`,
};
const t = await api(`/v1/chats/${chat.id}/messages`, req);
assert.equal((await api(`/v1/chats/${chat.id}/messages`, req)).id, t.id);
await wait(t.id);
assert.equal(
  readFileSync(resolve(config.workspace, filename), "utf8").trim(),
  marker,
);
console.log("PASS: real file creation and idempotent retry");
const follow = await api(`/v1/chats/${chat.id}/messages`, {
  requestId: randomUUID(),
  text: "Append a new line with exactly followup-ok to the same file you just created. Do not modify anything else. Verify by reading it.",
});
await wait(follow.id);
assert.match(
  readFileSync(resolve(config.workspace, filename), "utf8"),
  /followup-ok/,
);
console.log("PASS: persistent conversation follow-up");
const master = await api("/v1/messages", {
  requestId: randomUUID(),
  text: `Use the existing registered conversation named "Smoke ${run}" on device ${config.localDeviceId}. Tell it to append a line containing exactly master-ok to its previous file ${filename}. Do not create another chat. Dispatch the work using the Providence tool and report the actual task ID.`,
});
await wait(master.id);
const end = Date.now() + 180000;
while (Date.now() < end) {
  if (
    existsSync(resolve(config.workspace, filename)) &&
    readFileSync(resolve(config.workspace, filename), "utf8").includes(
      "master-ok",
    )
  )
    break;
  await new Promise((r) => setTimeout(r, 1000));
}
assert.match(
  readFileSync(resolve(config.workspace, filename), "utf8"),
  /master-ok/,
);
console.log("PASS: subscription-backed master tool call dispatched real work");
console.log(
  "Live smoke passed. Files are inside the ignored configured workspace.",
);
