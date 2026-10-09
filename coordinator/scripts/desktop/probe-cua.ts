import { CodexRpc } from "../../src/rpc.js";

// A read-only proof through the documented app-server MCP interface.
// No existing desktop session IDs, private endpoints or credentials are injected.
const rpc = new CodexRpc();
try {
  await rpc.start();
  const created = await rpc.call("thread/start", {
    cwd: process.cwd(),
    ephemeral: true,
    approvalPolicy: "on-request",
    sandbox: "read-only",
  });
  const result = await rpc.call("mcpServer/tool/call", {
    threadId: created.thread.id,
    server: "cua_repl",
    tool: "js",
    arguments: { code: "let phone = await cua.getApp('com.apple.ScreenContinuity');", title: "Observe iPhone Mirroring through Providence runtime" },
  }, 30000);
  const text = (result.content ?? []).filter((item: any) => item.type === "text")
    .map((item: any) => item.text).filter((value: string) => !value.startsWith("## Computer Use"));
  console.log(JSON.stringify({ inspectedAt: new Date().toISOString(), source: "standalone_codex_app_server",
    app: "com.apple.ScreenContinuity", isError: result.isError === true, observations: text }, null, 2));
  if (result.isError) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Read-only CUA probe failed");
  process.exitCode = 1;
} finally {
  rpc.stop();
}
