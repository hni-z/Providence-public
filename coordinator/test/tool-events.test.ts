import test from "node:test";
import assert from "node:assert/strict";
import { MAX_TOOL_TEXT_BYTES, normalizeToolEvent } from "../src/tool-events.js";

// These field shapes follow the installed 0.155.0-alpha.2.6 experimental ThreadItem schema.
test("command completion exposes real combined output and exit status without raw context", () => {
  const item = Object.freeze({ id: "cmd-1", type: "commandExecution", command: "node --test", cwd: "/private/workspace", commandActions: [], processId: "private-process", pluginId: "private-plugin", status: "completed", aggregatedOutput: "stdout: 3 passed\nstderr: diagnostic\n", exitCode: 0, durationMs: 50 });
  const event = normalizeToolEvent("item/completed", { threadId: "owned-thread", turnId: "owned-turn", taskId: "forged-task", item })!;
  assert.equal(event.type, "tool.completed");
  assert.equal(event.item.command, "node --test");
  assert.equal(event.item.exitCode, 0);
  assert.equal(event.item.status, "completed");
  assert.equal(event.output, item.aggregatedOutput);
  assert.equal("taskId" in event, false);
  assert.equal("threadId" in event, false);
  assert.equal(JSON.stringify(event).includes("/private/workspace"), false);
  assert.equal(JSON.stringify(event).includes("private-process"), false);
});

test("normal MCP denial preserves the exact error while omitting arguments and app metadata", () => {
  const event = normalizeToolEvent("item/completed", { item: {
    id: "calculator-call", type: "mcpToolCall", server: "cua_repl", tool: "js", status: "failed",
    arguments: { code: "let app = await cua.getApp('Calculator');", authorization: "never-display-argument" },
    appContext: { resourceUri: "private-resource" }, mcpAppResourceUri: "private-resource",
    result: null, error: { message: "Computer Use was not approved to use Calculator" },
  } })!;
  assert.equal(event.type, "tool.completed");
  assert.equal(event.item.server, "cua_repl");
  assert.equal(event.item.tool, "js");
  assert.equal(event.error, "Computer Use was not approved to use Calculator");
  assert.equal(JSON.stringify(event).includes("never-display"), false);
  assert.equal(JSON.stringify(event).includes("private-resource"), false);
});

test("MCP text and structured output omit credential keys, hidden metadata and media", () => {
  const event = normalizeToolEvent("item/completed", { item: {
    id: "mcp-result", type: "mcpToolCall", server: "files", tool: "inspect", status: "completed", arguments: {},
    result: {
      _meta: { private: "hidden-meta-value" },
      content: [
        { type: "text", text: '{"message":"Saved proof.txt","access_token":"private-access","_meta":{"private":"hidden-text-meta"},"authorization":"private-auth"}' },
        { type: "image", data: "private-image-value", mimeType: "image/png" },
        { type: "resource", resource: { text: "unrequested-resource" } },
      ],
      structuredContent: { rows: 2, nested: { result: "verified", headers: { Authorization: "private-header" }, api_key: "private-key", password: "private-password", screenshotBase64: "private-screenshot", reasoning: "private-reasoning" } },
    },
  } })!;
  assert.match(event.output!, /Saved proof\.txt/);
  assert.match(event.output!, /verified/);
  assert.match(event.output!, /"rows": 2/);
  for (const text of ["private-", "hidden-", "unrequested-resource"]) assert.equal(JSON.stringify(event).includes(text), false);
});

test("dynamic and function outputs retain supported text items only", () => {
  const dynamic = normalizeToolEvent("item/completed", { item: {
    id: "dynamic-1", type: "dynamicToolCall", tool: "providence_publish_artifact", namespace: null,
    arguments: { path: "proof.txt" }, status: "completed", success: false,
    contentItems: [{ type: "inputText", text: "File was not found" }, { type: "inputImage", imageUrl: "data:image/png;base64,private-image" }],
  } })!;
  assert.equal(dynamic.item.status, "failed");
  assert.equal(dynamic.output, "File was not found");
  const fn = normalizeToolEvent("item/completed", { item: {
    id: "function-output-1", type: "functionCallOutput", name: "lookup", namespace: "connector",
    output: [{ type: "input_text", text: "Actual response" }, { type: "input_image", image_url: "private-image-url" }, { type: "encrypted_content", encrypted_content: "private-encrypted-value" }],
  } })!;
  assert.equal(fn.type, "tool.output");
  assert.equal(fn.item.tool, "lookup");
  assert.equal(fn.output, "Actual response");
  assert.equal(JSON.stringify(fn).includes("private-"), false);
  assert.equal(normalizeToolEvent("item/started", { item: { id: "f", type: "functionCallOutput", output: "pending" } }), undefined);
});

test("file updates and command text redact inline secrets without concealing useful feedback", () => {
  const file = normalizeToolEvent("item/completed", { item: {
    id: "file-1", type: "fileChange", status: "completed",
    changes: [{ path: "settings.ts", kind: { type: "update", move_path: null }, diff: '+ const password = "private-password";\n+ const count = 4;' }],
  } })!;
  assert.match(file.output!, /settings\.ts/);
  assert.match(file.output!, /count = 4/);
  assert.equal(file.output!.includes("private-password"), false);
  const command = normalizeToolEvent("item/started", { item: {
    id: "cmd-secret", type: "commandExecution", status: "inProgress",
    command: "curl -H 'Authorization: Bearer private-bearer' -H 'Cookie: sid=private-cookie; other=private-other' --token private-flag https://username:private-pass@example.com", // gitleaks:allow -- intentional synthetic security-test fixture
  } })!;
  assert.equal(command.type, "tool.started");
  assert.match(command.item.command!, /curl/);
  assert.equal(command.item.command!.includes("private-"), false);
  assert.equal(command.item.command!.includes("username"), false);
});

test("truncation inside a quoted secret cannot expose the remaining secret text", () => {
  const event = normalizeToolEvent("item/completed", { item: {
    id: "large-secret", type: "functionCallOutput", name: "inspect",
    output: '{"message":"safe-prefix","password":"' + "private phrase ".repeat(6000) + '"}',
  } })!;
  assert.equal(event.truncated, true);
  assert.match(event.output!, /safe-prefix/);
  assert.equal(event.output!.includes("private phrase"), false);
});

test("combined text is UTF-8 bounded and long output cannot suppress the actual MCP error", () => {
  const event = normalizeToolEvent("item/completed", { item: {
    id: "large", type: "mcpToolCall", server: "test", tool: "large-output", status: "failed", arguments: {},
    error: { message: "Permission denied" }, result: { content: [{ type: "text", text: "🧪 measured output\n".repeat(5000) }] },
  } })!;
  assert.equal(event.error, "Permission denied");
  assert.equal(event.truncated, true);
  const allText = [event.item.command, event.item.tool, event.item.server, event.output, event.error].filter((v): v is string => typeof v === "string").join("");
  assert.ok(Buffer.byteLength(allText, "utf8") <= MAX_TOOL_TEXT_BYTES);
  assert.equal(allText.includes("\ufffd"), false);
});

test("streamed output and MCP progress retain item linkage; base64 process streams are ignored", () => {
  const delta = normalizeToolEvent("item/commandExecution/outputDelta", { itemId: "cmd-1", threadId: "actual-thread", turnId: "actual-turn", delta: "stdout chunk\n" })!;
  assert.equal(delta.type, "tool.output");
  assert.equal(delta.item.id, "cmd-1");
  assert.equal(delta.output, "stdout chunk\n");
  const progress = normalizeToolEvent("item/mcpToolCall/progress", { itemId: "mcp-1", message: "Reading document" })!;
  assert.equal(progress.output, "Reading document");
  assert.equal(normalizeToolEvent("command/exec/outputDelta", { processId: "p", deltaBase64: "cHJpdmF0ZQ==", stream: "stdout", capReached: false }), undefined);
});

test("reasoning and unsupported items never enter tool feedback; recursive results remain bounded", () => {
  assert.equal(normalizeToolEvent("item/completed", { item: { id: "r", type: "reasoning", summary: "private reasoning", content: "hidden" } }), undefined);
  assert.equal(normalizeToolEvent("item/reasoning/textDelta", { itemId: "r", delta: "private reasoning" }), undefined);
  assert.equal(normalizeToolEvent("item/completed", { item: { id: "a", type: "agentMessage", text: "different channel" } }), undefined);
  const result: any = { message: "safe" }; result.self = result;
  const event = normalizeToolEvent("item/completed", { item: { id: "cycle", type: "mcpToolCall", server: "test", tool: "inspect", status: "completed", result: { content: [], structuredContent: result } } })!;
  assert.match(event.output!, /safe/);
  assert.match(event.output!, /circular omitted/);
});
