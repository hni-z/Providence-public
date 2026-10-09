import { CodexRpc } from "../../src/rpc.js";

// Read-only discovery of the standalone runtime. Never print resource contents,
// environment, config, auth, or tool arguments; this is not desktop control.
const rpc = new CodexRpc();
try {
  await rpc.start();
  const result = await rpc.call("mcpServerStatus/list", { detail: "toolsAndAuthOnly", limit: 100 }, 15000);
  const entries = Array.isArray(result.data) ? result.data : [];
  const servers = entries.filter((entry: any) => /cua|computer-use|codex_app$/.test(entry.name)).map((entry: any) => ({
    name: entry.name,
    tools: Array.isArray(entry.tools)
      ? entry.tools.map((tool: any) => tool.name)
      : Object.keys(entry.tools ?? {}),
  }));
  console.log(JSON.stringify({
    inspectedAt: new Date().toISOString(),
    source: "standalone_codex_app_server",
    servers,
    morePages: Boolean(result.nextCursor),
    scope: "Configured MCP tool names only. Names are not proof that a desktop tool executes successfully.",
  }, null, 2));
} catch {
  console.error("Standalone tool discovery failed; GUI capability remains unverified.");
  process.exitCode = 1;
} finally {
  rpc.stop();
}
