import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
const text = process.argv.slice(2).join(" ").trim();
if (!text)
  throw new Error(
    'Usage: npm run ask -- "What devices and chats can you use?"',
  );
const { clientToken } = loadConfig();
const base = process.env.PROVIDENCE_URL ?? "http://127.0.0.1:8787";
async function request(path: string, body?: any) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${clientToken}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data: any = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
}
const task = await request("/v1/messages", { requestId: randomUUID(), text });
console.log(`Task ${task.id}`);
const deadline = Date.now() + 180000;
while (Date.now() < deadline) {
  const current = await request(`/v1/tasks/${task.id}`);
  if (current.status === "completed") {
    console.log(current.text);
    break;
  }
  if (current.status === "needs_input") {
    const b = await request("/v1/briefing");
    console.log(JSON.stringify(b.approvals, null, 2));
    break;
  }
  if (["failed", "cancelled", "interrupted"].includes(current.status))
    throw new Error(current.error ?? current.status);
  await new Promise((r) => setTimeout(r, 1000));
  if (Date.now() >= deadline)
    console.log(
      "Still working. Keep this task ID and query /v1/tasks/:id; no new request was sent.",
    );
}
