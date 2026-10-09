import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import {
  formContent,
  grantedPermissions,
  parseFormSchema,
  permissionChoices,
  offeredPersistenceModes,
  elicitationResponseMeta,
} from "../web/src/approvalSchema.js";
import { statusLabel } from "../web/src/api.js";
import { taskDecisions } from "../web/src/navigation.js";
import {
  approvalDetails,
  approvalResponseSchema,
  structuredApprovalResult,
} from "../src/approval-protocol.js";
import { normalizeToolEvent } from "../src/tool-events.js";

// The web package owns React. SSR uses that same React instance and its JSX
// configuration without adding browser globals, requests, or UI automation.
const webRequire = createRequire(
  new URL("../web/package.json", import.meta.url),
);
const React = webRequire("react") as {
  createElement: (...args: any[]) => unknown;
};
const { renderToStaticMarkup } = webRequire("react-dom/server") as {
  renderToStaticMarkup: (element: unknown) => string;
};
let ApprovalCard: any;
let ToolEventDetail: any;
let InlineDecisions: any;
before(async () => {
  const options = {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(new URL("../web/tsconfig.json", import.meta.url)),
  };
  ({ default: ApprovalCard } = await tsImport(
    "../web/src/ApprovalCard.tsx",
    options,
  ));
  ({ ToolEventDetail, InlineDecisions } = await tsImport(
    "../web/src/App.tsx",
    options,
  ));
});

const task = {
  id: "task-fixture",
  requestId: "request-fixture",
  chatId: "chat-fixture",
  deviceId: "mac",
  status: "needs_input",
  prompt: "Review this exact operation.",
  text: "",
  createdAt: "2026-09-19T00:00:00Z",
  updatedAt: "2026-09-19T00:00:00Z",
};
const base = {
  id: "approval-fixture",
  taskId: task.id,
  deviceId: "mac",
  status: "pending",
  method: "mcpServer/elicitation/request",
  details: {},
};
const formSchema = {
  type: "object",
  required: ["name", "count", "allowed", "channels"],
  properties: {
    name: { type: "string", title: "Name", minLength: 2, maxLength: 20 },
    count: { type: "integer", title: "Count", minimum: 1, maximum: 5 },
    allowed: { type: "boolean", title: "Share output", default: true },
    audience: {
      type: "string",
      title: "Audience",
      oneOf: [
        { const: "team", title: "Project team" },
        { const: "private", title: "Only me" },
      ],
    },
    channels: {
      type: "array",
      title: "Channels",
      minItems: 1,
      maxItems: 2,
      items: {
        anyOf: [
          { const: "email", title: "Email" },
          { const: "calendar", title: "Calendar" },
        ],
      },
    },
  },
};
const denyEntry = {
  path: { type: "path", path: "/workspace/private" },
  access: "deny",
};
const writeEntry = {
  path: { type: "glob_pattern", pattern: "/workspace/reports/*.md" },
  access: "write",
};
const requestedPermissions = {
  network: { enabled: true },
  fileSystem: {
    read: ["/workspace/reference"],
    write: ["/workspace/output"],
    entries: [writeEntry, denyEntry],
    globScanMaxDepth: 2,
  },
};
function render(approval: unknown) {
  let responses = 0;
  const html = renderToStaticMarkup(
    React.createElement(ApprovalCard, {
      approval,
      task,
      deviceName: "MacBook",
      onResolve: async () => {
        responses++;
      },
    }),
  );
  assert.equal(responses, 0, "rendering must never submit an approval");
  return html;
}

test("form helper validates required values, false booleans, numeric limits, enum and array choices", () => {
  const parsed = parseFormSchema(formSchema);
  assert.equal(parsed.error, undefined);
  assert.ok(formContent(parsed.fields, {}).error);
  const input = {
    name: "Launch",
    count: "2",
    allowed: "false",
    audience: "team",
    channels: ["calendar"],
  };
  const valid = formContent(parsed.fields, input);
  assert.equal(valid.error, undefined);
  assert.deepEqual(
    { ...valid.content },
    {
      name: "Launch",
      count: 2,
      allowed: false,
      audience: "team",
      channels: ["calendar"],
    },
  );
  for (const change of [
    { name: "A" },
    { count: "2.2" },
    { count: "6" },
    { allowed: "yes" },
    { audience: "unrequested" },
    { channels: [] },
    { channels: ["unknown"] },
    { channels: ["calendar", "calendar"] },
  ])
    assert.ok(formContent(parsed.fields, { ...input, ...change }).error);
});

test("unsupported form constraints cannot silently become an accepted simpler form", () => {
  for (const field of [
    { type: "object", properties: {} },
    { type: "string", pattern: "^private$" },
    { type: "array", items: { type: "string", enum: ["a"], pattern: "^a$" } },
    { type: "string", oneOf: [{ const: "a", title: "A", not: {} }] },
  ])
    assert.ok(parseFormSchema({ type: "object", properties: { field } }).error);
  assert.ok(
    parseFormSchema({ type: "object", properties: {}, required: ["missing"] })
      .error,
  );
});

test("permission helper grants only selected paths and preserves detailed entries, exclusions and scan depth", () => {
  const parsed = permissionChoices(requestedPermissions);
  assert.equal(parsed.error, undefined);
  assert.equal(
    parsed.choices.find((choice) => choice.id === "entry-0")?.detail,
    "Pattern: /workspace/reports/*.md",
  );
  assert.deepEqual(grantedPermissions(parsed, []), {});
  assert.deepEqual(grantedPermissions(parsed, ["unrequested"]), {});
  const permissions = grantedPermissions(parsed, ["write-0", "entry-0"]);
  assert.deepEqual(permissions, {
    fileSystem: {
      write: ["/workspace/output"],
      read: null,
      entries: [writeEntry, denyEntry],
      globScanMaxDepth: 2,
    },
  });
  assert.deepEqual(grantedPermissions(parsed, ["network"]), {
    network: { enabled: true },
  });
  const details = approvalDetails(
    "item/permissions/requestApproval",
    {
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      cwd: "/workspace",
      permissions: requestedPermissions,
    },
    "provider-request",
  );
  const response = approvalResponseSchema.parse({
    kind: "permissions",
    permissions,
    scope: "turn",
  });
  assert.deepEqual(
    structuredApprovalResult(
      "item/permissions/requestApproval",
      details,
      response,
    ),
    { permissions, scope: "turn" },
  );
});

test("SSR approval form names its source/task and does not select requested defaults or reveal metadata", () => {
  const html = render({
    ...base,
    details: {
      kind: "elicitation",
      mode: "form",
      serverName: "Fixture service",
      message: "Provide your preferences.",
      requestedSchema: formSchema,
      _meta: { opaque: "REQUEST-META-MUST-NOT-LEAK" },
    },
  });
  for (const label of [
    "App or service request",
    "Fixture service",
    "MacBook",
    task.prompt,
    "Submit response",
    "Decline",
    "Cancel request",
    "Share output",
    "Project team",
    "Calendar",
  ])
    assert.ok(html.includes(label), label);
  assert.ok(!html.includes("REQUEST-META-MUST-NOT-LEAK"));
  assert.ok(!html.includes('checked=""'));
  assert.ok(!/<option value="true"[^>]*selected/.test(html));
});

test("SSR permission grants start unchecked, disabled, and scoped to this turn", () => {
  const html = render({
    ...base,
    method: "item/permissions/requestApproval",
    details: {
      kind: "permissions",
      cwd: "/workspace",
      permissions: requestedPermissions,
    },
  });
  for (const label of [
    "Device permissions requested",
    "Network access",
    "/workspace/output",
    "/workspace/reports/*.md",
    "filesystem exclusion",
    "This turn only",
    "including later turns",
    "Deny permissions",
  ])
    assert.ok(html.includes(label), label);
  assert.ok(!html.includes('checked=""'));
  assert.match(
    html,
    /<button[^>]+disabled=""[^>]*>[\s\S]*?Grant selected access/,
  );
  assert.match(html, /<option value="turn" selected="">/);
  assert.ok(!/<option value="session"[^>]*selected/.test(html));
});

test("unsupported and stale forms cannot present an accept control", () => {
  for (const details of [
    {
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: { nested: { type: "object" } },
      },
    },
    {
      mode: "openai/userVerification",
      title: "Verify identity",
      challenge: "UNSUPPORTED-PROOF",
    },
    {
      mode: "form",
      requestedSchema: formSchema,
      unsupportedReason: "Provider says this schema is unsupported.",
    },
  ]) {
    const html = render({ ...base, details });
    assert.ok(!html.includes("Submit response"));
    assert.ok(!html.includes("UNSUPPORTED-PROOF"));
    assert.ok(html.includes("Decline"));
    assert.ok(html.includes("Cancel request"));
  }
  const stale = render({
    ...base,
    status: "resolved",
    details: { mode: "form", requestedSchema: formSchema },
  });
  assert.ok(stale.includes("no longer pending"));
  assert.ok(!stale.includes("Submit response"));
});

test("URL elicitations retain explicit confirmation, decline and cancel without unsafe links", () => {
  const html = render({
    ...base,
    details: {
      mode: "url",
      message: "Complete this external step.",
      url: "https://example.com/authorize",
      elicitationId: "url-request",
    },
  });
  assert.ok(html.includes('href="https://example.com/authorize"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  for (const label of ["I completed this step", "Decline", "Cancel request"])
    assert.ok(html.includes(label));
  for (const url of [
    "javascript:alert(1)",
    "file:///private/item",
    "https://user:secret@example.com/",
  ]) {
    const unsupported = render({ ...base, details: { mode: "url", url } });
    assert.ok(!unsupported.includes("I completed this step"));
    assert.ok(!unsupported.includes("href="));
  }
});

test("real normalizer output interops with SSR tool evidence and completion stays neutral", () => {
  const event = normalizeToolEvent("item/completed", {
    item: {
      id: "calculator-fixture",
      type: "mcpToolCall",
      server: "cua_repl",
      tool: "js",
      status: "failed",
      arguments: { code: "private argument", token: "private token" },
      result: {
        content: [{ type: "text", text: "<script>untrusted output</script>" }],
      },
      error: { message: "Computer Use was not approved to use Calculator" },
    },
  });
  assert.ok(event);
  const html = renderToStaticMarkup(
    React.createElement(ToolEventDetail, {
      event: { ...event, sequence: 1, at: task.createdAt, taskId: task.id },
    }),
  );
  for (const label of [
    "cua_repl",
    "js",
    "failed",
    "Computer Use was not approved to use Calculator",
    "View tool details",
  ])
    assert.ok(html.includes(label), label);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("private argument"));
  assert.ok(!html.includes("private token"));
  assert.equal(statusLabel("completed"), "Agent finished");
});

test("legacy approval review reveals session write root, network destination and command permission overlay", () => {
  const file = render({
    ...base,
    method: "item/fileChange/requestApproval",
    details: {
      grantRoot: "/workspace/session-output",
      reason: "Save project files",
    },
  });
  assert.ok(file.includes("/workspace/session-output"));
  assert.ok(file.includes("File change permission requested"));
  assert.ok(file.includes("remainder of the session"));
  assert.ok(file.includes("Allow requested session writes"));
  assert.ok(!file.includes("Allow this action"));
  const command = render({
    ...base,
    method: "item/commandExecution/requestApproval",
    details: {
      command: "download project inputs",
      networkApprovalContext: { host: "example.com:443", protocol: "https" },
      additionalPermissions: requestedPermissions,
    },
  });
  for (const label of [
    "Command permission requested",
    "example.com:443",
    "https",
    "/workspace/reference",
    "/workspace/output",
    "/workspace/reports/*.md",
    "Filesystem exclusions",
    "Additional access requested for this command",
    "Allow network request",
  ])
    assert.ok(command.includes(label), label);
});

test("pending input requests retain exact legacy questions and controls without guessing their confirmation policy", () => {
  const question = "Send exactly this message to the verified recipient now?";
  for (const details of [
    { questions: [{ id: "choice", question, options: [{ label: "Send once" }, { label: "Cancel" }] }] },
    { questions: [{ id: "destination", question: "Which exact destination should receive the file?" }] },
  ]) {
    const html = render({ ...base, method: "item/tool/requestUserInput", details });
    assert.match(html, /aria-label="Input requested"/);
    assert.ok(html.includes(details.questions[0].question));
    assert.ok(html.includes("Submit response"));
    assert.ok(!html.includes('checked=""'));
    assert.ok(!html.includes("A decision for you"));
    assert.ok(!html.includes("Optional request"));
    assert.ok(!html.includes("Mandatory confirmation"));
  }
  const legacy = render({ ...base, method: "item/tool/requestUserInput", details: { questions: [{ id: "choice", question, options: [{ label: "Send once" }, { label: "Cancel" }] }] } });
  assert.ok(legacy.includes("Send once"));
  assert.ok(legacy.includes("Cancel"));
});

test("only explicitly timed nonblocking questions show the reply-window note without choosing an answer", () => {
  const questions = [{ id: "format", question: "Any preferred format?", options: [{ label: "Short" }, { label: "Detailed" }] }];
  const replyDeadlineAt = "2026-09-27T12:00:20.000Z";
  const note = "Closes after up to 20 seconds without a reply.";
  for (const isBlocking of [undefined, false]) {
    const html = render({ ...base, method: "item/tool/requestUserInput", details: { questions, replyDeadlineAt, isBlocking } });
    assert.ok(html.includes(note));
    assert.ok(html.includes("Submit response"));
    assert.ok(!html.includes('checked=""'));
  }
  for (const deadline of [undefined, "not-a-date", "2026-02-30T12:00:20.000Z", 20]) {
    const html = render({ ...base, method: "item/tool/requestUserInput", details: { questions, replyDeadlineAt: deadline } });
    assert.ok(!html.includes(note));
    assert.ok(html.includes("Submit response"));
  }
  for (const approval of [
    { ...base, method: "item/tool/requestUserInput", details: { questions, isBlocking: true, replyDeadlineAt } },
    { ...base, method: "item/commandExecution/requestApproval", details: { replyDeadlineAt } },
    { ...base, method: "item/fileChange/requestApproval", details: { replyDeadlineAt } },
    { ...base, details: { mode: "form", requestedSchema: { type: "object", properties: {} }, replyDeadlineAt } },
    { ...base, method: "item/permissions/requestApproval", details: { permissions: {}, replyDeadlineAt } },
  ]) assert.ok(!render(approval).includes(note));
});

test("unknown provider requests stay visible with their existing supported response controls", () => {
  const html = render({ ...base, method: "provider/futureRequest", details: { reason: "Review the provider request on this task." } });
  assert.match(html, /aria-label="Request needs review"/);
  assert.ok(html.includes("Review the provider request on this task."));
  assert.ok(html.includes("Decline"));
  assert.ok(html.includes("Cancel request"));
  assert.ok(!html.includes("Allow this action"));
  assert.ok(!html.includes("Permission requested"));
});

test("unsupported runtime request diagnostics expose only the available method and escaped error", () => {
  const html = renderToStaticMarkup(
    React.createElement(ToolEventDetail, {
      event: {
        type: "runtime.unsupported_request",
        sequence: 2,
        at: task.createdAt,
        method: "provider/unsupported",
        error: "No permission granted: <unsafe input>",
        privateMetadata: "not-for-display",
      },
    }),
  );
  assert.ok(html.includes("View request diagnostic"));
  assert.ok(html.includes("provider/unsupported"));
  assert.ok(html.includes("No permission granted: &lt;unsafe input&gt;"));
  assert.ok(!html.includes("<unsafe input>"));
  assert.ok(!html.includes("not-for-display"));
});

test("legacy command controls are limited to the provider's advertised basic decisions", () => {
  const declineOnly = render({
    ...base,
    method: "item/commandExecution/requestApproval",
    details: {
      command: "review-only command",
      availableDecisions: ["decline"],
    },
  });
  assert.ok(declineOnly.includes("Decline"));
  assert.ok(!declineOnly.includes("Allow this action"));
  assert.ok(!declineOnly.includes("Cancel request"));
  const cancelOnly = render({
    ...base,
    method: "item/commandExecution/requestApproval",
    details: {
      availableDecisions: ["cancel"],
    },
  });
  assert.ok(cancelOnly.includes("Cancel request"));
  assert.ok(!cancelOnly.includes("Decline"));
  const unsupported = render({
    ...base,
    method: "item/commandExecution/requestApproval",
    details: {
      availableDecisions: [
        "acceptForSession",
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["any"] } },
      ],
    },
  });
  assert.ok(unsupported.includes("Use Stop on this task"));
  assert.ok(!unsupported.includes("Allow this action"));
  assert.ok(!unsupported.includes("Decline"));
  assert.ok(!unsupported.includes("Cancel request"));
});

test("elicitation persistence remains one-time unless an advertised mode is explicitly selected on acceptance", () => {
  assert.deepEqual(
    offeredPersistenceModes(["session", "unknown", "always", "session"]),
    ["session", "always"],
  );
  assert.deepEqual(offeredPersistenceModes(undefined), []);
  assert.equal(
    elicitationResponseMeta("form", "accept", ["session", "always"], ""),
    null,
  );
  assert.deepEqual(
    elicitationResponseMeta("form", "accept", ["session"], "session"),
    { persist: "session" },
  );
  assert.deepEqual(
    elicitationResponseMeta("form", "accept", ["always"], "always"),
    { persist: "always" },
  );
  assert.equal(
    elicitationResponseMeta("form", "accept", ["session"], "always"),
    null,
  );
  assert.equal(
    elicitationResponseMeta("url", "accept", ["session"], "session"),
    null,
  );
  for (const action of ["decline", "cancel"])
    assert.equal(
      elicitationResponseMeta("form", action, ["session", "always"], "always"),
      null,
    );
  const html = render({
    ...base,
    details: {
      mode: "form",
      requestedSchema: formSchema,
      persistenceModes: ["session"],
    },
  });
  assert.ok(html.includes("Remember this choice"));
  assert.ok(html.includes('value="" selected=""'));
  assert.ok(html.includes("For this session"));
  assert.ok(!html.includes('value="always"'));
  const once = render({
    ...base,
    details: { mode: "form", requestedSchema: formSchema },
  });
  assert.ok(!once.includes("Remember this choice"));
});

const decision = {
  ...base,
  id: "d1e2f3a4-0000-4000-8000-000000000000",
  method: "item/tool/requestUserInput",
  details: {
    questions: [
      {
        id: "choice",
        question: "Choose the exact scope",
        options: [{ label: "Ship it" }, { label: "Hold" }],
      },
    ],
  },
};

test("a decision reachable in the conversation is answered in one open card, not two", () => {
  const reachable = [decision];
  const inDetails = taskDecisions([decision], reachable, task.id);
  assert.deepEqual(inDetails, []);
  assert.deepEqual(taskDecisions([decision], [], task.id), [decision]);
  const html = renderToStaticMarkup(
    React.createElement("div", null, [
      React.createElement(InlineDecisions, {
        key: "inline",
        approvals: reachable,
        tasks: [task],
        deviceName: () => "MacBook",
        chatName: () => "Superagent",
        onResolve: async () => {},
      }),
      ...inDetails.map((approval: any) =>
        React.createElement(ApprovalCard, {
          key: approval.id,
          approval,
          task,
          deviceName: "MacBook",
          onResolve: async () => {},
        }),
      ),
    ]),
  );
  assert.equal(html.split('class="decision-card"').length - 1, 1);
  assert.match(html, /<details class="inline-work inline-approval" open="">/);
  assert.ok(html.includes("Choose the exact scope"));
  assert.ok(html.includes("Ship it"));
});

test("several reachable decisions stay collapsed so the conversation is still readable", () => {
  const second = { ...decision, id: "b7c8d9e0-0000-4000-8000-000000000000" };
  const html = renderToStaticMarkup(
    React.createElement(InlineDecisions, {
      approvals: [decision, second],
      tasks: [task],
      deviceName: () => "MacBook",
      chatName: () => "Superagent",
      onResolve: async () => {},
    }),
  );
  assert.ok(!html.includes('open=""'));
  const resolved = renderToStaticMarkup(
    React.createElement(InlineDecisions, {
      approvals: [{ ...decision, status: "resolved" }],
      tasks: [task],
      deviceName: () => "MacBook",
      chatName: () => "Superagent",
      onResolve: async () => {},
    }),
  );
  assert.ok(!resolved.includes('open=""'));
});

test("repeated decision option labels remain separately selectable", () => {
  const reported: unknown[] = [];
  const previous = console.error;
  console.error = (...args: unknown[]) => reported.push(args);
  let html = "";
  try {
    html = render({
      ...decision,
      details: {
        questions: [
          {
            id: "choice",
            question: "Pick one",
            options: [{ label: "Same label" }, { label: "Same label" }],
          },
        ],
      },
    });
  } finally {
    console.error = previous;
  }
  assert.deepEqual(reported, []);
  assert.equal(html.split('type="radio"').length - 1, 2);
  assert.equal(html.split("Same label").length - 1, 2);
});
