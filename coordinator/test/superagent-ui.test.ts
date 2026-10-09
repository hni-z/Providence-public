import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import {
  filterRegisteredChats,
  childUpdatesFor,
  historicalSuperagentReply,
} from "../web/src/presentation.js";
import type { Chat, Device, Task, ChildUpdate } from "../web/src/types.js";
const webRequire = createRequire(
  new URL("../web/package.json", import.meta.url),
);
const React = webRequire("react") as {
  createElement: (...args: any[]) => unknown;
};
const { renderToStaticMarkup } = webRequire("react-dom/server") as {
  renderToStaticMarkup: (element: unknown) => string;
};
let App: any,
  TaskMarkdown: any,
  LatestChildUpdates: any,
  EarlierSuperagentReply: any,
  DeviceCapabilities: any;
before(async () => {
  ({
    default: App,
    TaskMarkdown,
    LatestChildUpdates,
    EarlierSuperagentReply,
    DeviceCapabilities,
  } = await tsImport("../web/src/App.tsx", {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(new URL("../web/tsconfig.json", import.meta.url)),
  }));
});
const devices: Device[] = [
  { id: "mac", name: "MacBook", online: true },
  { id: "windows", name: "DemoPC", online: false },
];
const chats: Chat[] = [
  {
    id: "chat-a",
    name: "Launch | Exact wording",
    deviceId: "mac",
    threadId: "thread-a",
    online: true,
    workspace: "/workspace/launch",
  },
  {
    id: "chat-b",
    name: "Travel notes",
    deviceId: "windows",
    threadId: "thread-b",
    online: false,
    workspace: "C:\\Projects\\Personal",
  },
];

test("Chats search matches registered metadata without renaming, reordering or changing ownership", () => {
  assert.equal(filterRegisteredChats(chats, devices, ""), chats);
  assert.deepEqual(filterRegisteredChats(chats, devices, "launch MACBOOK"), [
    chats[0],
  ]);
  assert.deepEqual(filterRegisteredChats(chats, devices, "demoPC personal"), [
    chats[1],
  ]);
  assert.deepEqual(filterRegisteredChats(chats, devices, "missing"), []);
  assert.equal(chats[0].name, "Launch | Exact wording");
  assert.equal(chats[1].deviceId, "windows");
});

test("default authenticated workspace has clear chat, device and account navigation without diagnostics", () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) =>
        key === "providence.session"
          ? "ssr-only-fixture"
          : key === "providence.chat"
            ? "chat-b"
            : null,
    },
  });
  try {
    const html = renderToStaticMarkup(React.createElement(App));
    assert.ok(html.includes("Providence"));
    assert.ok(html.includes('aria-controls="app-navigation"'));
    assert.ok(html.includes('aria-expanded="false"'));
    assert.ok(html.includes("single-chat-layout"));
    assert.ok(html.includes('data-selected-chat="master"'));
    assert.ok(html.includes('aria-label="Providence navigation"'));
    assert.ok(html.includes('aria-label="Start voice conversation"'));
    assert.ok(!html.includes('>Workspace</button>'));
    assert.ok(!html.includes('>Voice</button>'));
    assert.ok(!html.includes('class="sidebar'));
    assert.ok(!html.includes('class="details-panel'));
    assert.ok(!html.includes('aria-label="Conversation to send to"'));
    assert.ok(html.includes('aria-label="Dark theme"'));
    assert.ok(!html.includes("Host bridge proof"));
    assert.ok(!html.includes("Computer use proof"));
    assert.ok(!html.includes('href="#host-bridge-proof"'));
    assert.ok(!html.includes('href="#computer-use-proof"'));
  } finally {
    if (prior) Object.defineProperty(globalThis, "sessionStorage", prior);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("shared task response rendering preserves text and escapes untrusted content without local-file navigation", () => {
  const original =
    "Waiting for your earlier decision. [Local output](/Users/example/result.txt) [Source](https://example.com/page) <script>untrusted</script>";
  let opened = 0;
  const html = renderToStaticMarkup(
    React.createElement(TaskMarkdown, {
      text: original,
      tasks: [],
      chatName: () => "",
      onOpen: () => opened++,
    }),
  );
  assert.ok(html.includes("Waiting for your earlier decision."));
  assert.ok(html.includes("Local output"));
  assert.ok(!html.includes('href="/Users/'));
  assert.ok(html.includes('href="https://example.com/page"'));
  assert.ok(!html.includes("<script>"));
  assert.equal(opened, 0);
  assert.equal(
    original,
    "Waiting for your earlier decision. [Local output](/Users/example/result.txt) [Source](https://example.com/page) <script>untrusted</script>",
  );
});

test("derived child updates supersede display only when the backend explicitly marks the parent reply historical", () => {
  const update: ChildUpdate = {
    id: "worker",
    chatId: "chat-a",
    chatName: "Launch | Exact wording",
    deviceId: "mac",
    deviceName: "MacBook",
    status: "completed",
    text: "The requested action is finished.",
    updatedAt: "2026-09-19T10:00:00Z",
    hasLiveText: false,
  };
  const parent: Task = {
    id: "parent",
    requestId: "request",
    chatId: "master",
    deviceId: "coordinator",
    status: "completed",
    prompt: "Carry out the requested action.",
    text: "Waiting for approval before proceeding.",
    createdAt: "2026-09-19T09:00:00Z",
    updatedAt: "2026-09-19T09:01:00Z",
    childUpdates: [update],
    hasNewerChildUpdates: true,
  };
  const originalText = parent.text;
  assert.equal(
    childUpdatesFor(parent, [], chats, devices),
    parent.childUpdates,
  );
  assert.equal(historicalSuperagentReply(parent), true);
  assert.equal(
    historicalSuperagentReply({ ...parent, hasNewerChildUpdates: false }),
    false,
  );
  assert.equal(
    historicalSuperagentReply({ ...parent, hasNewerChildUpdates: undefined }),
    false,
  );
  const html = renderToStaticMarkup(
    React.createElement(EarlierSuperagentReply, {
      task: parent,
      tasks: [],
      chatName: () => "",
      onOpen: () => assert.fail("No navigation during SSR"),
    }),
  );
  assert.ok(html.includes("Earlier Providence reply"));
  assert.ok(html.includes("Waiting for approval before proceeding."));
  assert.ok(html.includes("historical snapshot"));
  assert.ok(!/<details[^>]*\sopen(?:=|>)/.test(html));
  assert.equal(parent.text, originalText);
});

test("latest child result shows exact device/chat/time and result without guessing success or invoking actions", () => {
  const update: ChildUpdate = {
    id: "worker",
    chatId: "chat-a",
    chatName: "Launch | Exact wording",
    deviceId: "mac",
    deviceName: "MacBook",
    status: "completed",
    text: "Permission denied; no action was performed.",
    updatedAt: "2026-09-19T10:00:00Z",
    hasLiveText: false,
    textTruncated: true,
  };
  let actions = 0;
  const html = renderToStaticMarkup(
    React.createElement(LatestChildUpdates, {
      updates: [update],
      allTasks: [],
      allArtifacts: [],
      token: "ssr-only",
      chatName: () => "",
      onOpen: async () => {
        actions++;
      },
      onError: () => {
        actions++;
      },
      truncated: true,
      total: 25,
    }),
  );
  for (const label of [
    "MacBook",
    "Launch | Exact wording",
    "Agent finished",
    "Agent response",
    update.text,
    "Response excerpt",
    "Inspect work",
    "Showing 1 of 25",
  ])
    assert.ok(html.includes(label), label);
  assert.ok(html.includes('dateTime="2026-09-19T10:00:00Z"'));
  assert.ok(!html.includes("Succeeded"));
  assert.ok(html.includes('class="inline-work"'));
  assert.ok(!/<details class="inline-work"[^>]*\sopen(?:=|>)/.test(html));
  assert.equal(actions, 0);
});

test("latest progress and approval state stay visibly distinct from a final response", () => {
  const update: ChildUpdate = {
    id: "worker",
    chatId: "chat-a",
    chatName: "Launch | Exact wording",
    deviceId: "mac",
    deviceName: "MacBook",
    status: "needs_input",
    text: "",
    updatedAt: "2026-09-19T10:00:00Z",
    hasLiveText: false,
    progress: {
      kind: "waiting_input",
      text: "Choose the offered scope.",
      updatedAt: "2026-09-19T10:00:00Z",
    },
  };
  const html = renderToStaticMarkup(
    React.createElement(LatestChildUpdates, {
      updates: [update],
      allTasks: [],
      allArtifacts: [],
      token: "ssr-only",
      chatName: () => "",
      onOpen: async () => assert.fail("No navigation"),
      onError: () => {},
    }),
  );
  for (const label of [
    "Needs your input",
    "An input or permission request needs your response",
    "Choose the offered scope.",
    "Review request",
  ])
    assert.ok(html.includes(label), label);
  assert.ok(!html.includes("Agent response"));
  assert.ok(!html.includes("Agent finished"));
});

test("older API snapshots fall back to linked worker records while explicit empty updates stay authoritative", () => {
  const parent: Task = {
    id: "parent",
    requestId: "p",
    chatId: "master",
    deviceId: "coordinator",
    status: "completed",
    prompt: "Do work",
    text: "Working.",
    createdAt: "2026-09-19T09:00:00Z",
    updatedAt: "2026-09-19T09:01:00Z",
  };
  const worker: Task = {
    id: "worker",
    requestId: "w",
    chatId: "chat-a",
    deviceId: "mac",
    parentTaskId: parent.id,
    status: "running",
    prompt: "Do work",
    text: "Actual progress",
    createdAt: "2026-09-19T09:00:00Z",
    updatedAt: "2026-09-19T09:02:00Z",
  };
  const updates = childUpdatesFor(parent, [worker], chats, devices);
  assert.equal(updates[0].chatName, chats[0].name);
  assert.equal(updates[0].text, worker.text);
  assert.equal(updates[0].hasLiveText, true);
  assert.deepEqual(
    childUpdatesFor({ ...parent, childUpdates: [] }, [worker], chats, devices),
    [],
  );
  assert.equal(historicalSuperagentReply(parent), false);
});

test("device details qualify scoped evidence without granting permission or implying general app access", () => {
  const device: Device = {
    id: "mac",
    name: "MacBook",
    online: true,
    capabilities: {
      files: true,
      shell: true,
      browser: true,
      desktop: true,
      phoneMirroring: false,
    },
    capabilityEvidence: {
      browser: {
        status: "verified_scoped",
        requiresApproval: true,
        grantsPermission: false,
        taskId: "browser-observation",
        observedAt: "2026-09-19T11:00:00Z",
        scope:
          "Observed the Discord login page after origin approval; no signed-in browser action.",
      },
      desktop: {
        status: "verified_scoped",
        requiresApproval: true,
        grantsPermission: false,
        taskId: "desktop-observation",
        observedAt: "2026-09-19T11:01:00Z",
        scope: "Native Discord: one exact message sent and read back.",
      },
    },
  };
  const html = renderToStaticMarkup(
    React.createElement(DeviceCapabilities, { device }),
  );
  assert.equal(html.split("Observed with permission").length - 1, 2);
  for (const scope of [
    device.capabilityEvidence!.browser!.scope!,
    device.capabilityEvidence!.desktop!.scope!,
  ])
    assert.ok(html.includes(scope));
  assert.ok(html.includes('dateTime="2026-09-19T11:00:00Z"'));
  assert.ok(html.includes('dateTime="2026-09-19T11:01:00Z"'));
  assert.ok(html.includes("App approval is required."));
  assert.ok(html.includes("does not grant permission"));
  assert.ok(html.includes("browser-observation"));
  assert.ok(html.includes("desktop-observation"));
  assert.ok(!html.includes("All apps"));
  const offline = renderToStaticMarkup(
    React.createElement(DeviceCapabilities, {
      device: { ...device, online: false },
    }),
  );
  assert.equal(offline.split("Observed with permission").length - 1, 2);
  assert.ok(offline.includes("Offline"));
  const unverified = renderToStaticMarkup(
    React.createElement(DeviceCapabilities, {
      device: {
        id: "windows",
        name: "DemoPC",
        online: true,
        capabilities: { browser: true, desktop: true },
      },
    }),
  );
  assert.ok(!unverified.includes("Observed with permission"));
  assert.ok(unverified.includes("Not verified"));
});
