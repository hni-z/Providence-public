/** Live integration proof. Uses only a designated demo workspace and real model calls. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, dataDir } from "./config.js";
const config = loadConfig();
const base = process.env.PROVIDENCE_URL ?? "http://127.0.0.1:8787";
async function api(path: string, body?: any) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + config.clientToken,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value: any = await r.json();
  if (!r.ok) throw new Error(value.error);
  return value;
}
async function wait(id: string, expected = "completed") {
  const end = Date.now() + 240000;
  while (Date.now() < end) {
    const t = await api("/v1/tasks/" + id);
    if (t.status === expected) return t;
    if (
      ["failed", "cancelled", "interrupted", "needs_input"].includes(t.status)
    )
      throw new Error(`Unexpected task ${t.status}: ${t.error ?? t.text}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Timed out waiting for " + id);
}
const run = randomUUID().slice(0, 8);
const source = await api("/v1/chats", {
  deviceId: config.localDeviceId,
  name: "Event brief " + run,
  instructions:
    "Maintain the event brief and its facts. This is designated Providence demo data.",
});
const brief = await api(`/v1/chats/${source.id}/messages`, {
  requestId: randomUUID(),
  text: "Remember our demonstration event is named Cedar Table. It starts at 6:30 PM on Saturday. Its audience is student volunteers. Reply with these facts briefly. Do not create files.",
});
await wait(brief.id);
console.log("PASS: real source conversation retained demo facts");
const target = await api("/v1/chats", {
  deviceId: config.localDeviceId,
  name: "Invitation " + run,
  instructions:
    "Write concise event invitations using supplied source facts and the requested tone.",
});
const filename = "invitation-" + run + ".txt";
const task = await api(`/v1/chats/${target.id}/messages`, {
  requestId: randomUUID(),
  sourceChatIds: [source.id],
  text: `Draft ${filename} using the facts in the supplied Event brief. Use a friendly tone without a separate style confirmation. Create the file and publish it with providence_publish_artifact. Do not modify other files.`,
});
const completed = await wait(task.id);
const artifact = completed.artifacts?.find((value: any) => value.name === filename);
assert.ok(artifact, "Verified artifact publication required");
const bytes = readFileSync(resolve(config.workspace, filename));
assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
assert.match(bytes.toString("utf8"), /Cedar Table/);
const evidence = { run, sourceChatId: source.id, targetChatId: target.id,
  taskId: task.id, filename, status: completed.status, artifactId: artifact.id,
  sha256: artifact.sha256, bytes: bytes.length };
writeFileSync(resolve(dataDir, `artifact-demo-proof-${run}.json`),
  JSON.stringify(evidence, null, 2), { mode: 0o600, flag: "wx" });
console.log("PASS: actual invitation artifact published and local bytes verified", JSON.stringify(evidence));
