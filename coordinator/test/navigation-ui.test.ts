import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import {
  initialSelectedChat,
  selectedChatAfter,
  reachableApprovals,
  blockingApprovals,
  selectedVoiceOutcomes,
} from "../web/src/navigation.js";
import type { SelectionEvent } from "../web/src/navigation.js";
import type { Task, Approval, Chat } from "../web/src/types.js";
import { VoiceSessionGuard } from "../web/src/browser-voice.js";
import { HOSTED_ACCOUNT_SESSION } from "../web/src/api.js";
const webRequire = createRequire(
  new URL("../web/package.json", import.meta.url),
);
const React = webRequire("react") as {
  createElement: (...args: any[]) => unknown;
};
const { renderToStaticMarkup } = webRequire("react-dom/server") as {
  renderToStaticMarkup: (element: unknown) => string;
};
let HostedSignIn: any, AIProcessingNotice: any, Mark: any,
  ChatHistoryInspection: any,
  App: any,
  PairModal: any,
  SelfHostedPairingInstructions: any,
  requestSelfHostedPairing: any,
  ComposerSend: any,
  composerPlaceholder: any;
before(async () => {
  ({
    HostedSignIn,
    AIProcessingNotice,
    Mark,
    ChatHistoryInspection,
    ComposerSend,
    PairModal,
    SelfHostedPairingInstructions,
    requestSelfHostedPairing,
    composerPlaceholder,
    default: App,
  } = await tsImport("../web/src/App.tsx", {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(new URL("../web/tsconfig.json", import.meta.url)),
  }));
});
test("hosted device setup cannot render the legacy pairing form, including before hosted detection settles", () => {
  for (const props of [{ hosted: true, token: "previous-session" }, { hosted: false, token: HOSTED_ACCOUNT_SESSION }]) {
    const html = renderToStaticMarkup(React.createElement(PairModal, { ...props, onClose: () => {} }));
    assert.match(html, /href="\/account"/);
    assert.match(html, /Open Account and devices/);
    assert.doesNotMatch(html, /<form|Create pairing code|\/bootstrap\/|start-windows|DemoPC|github\.com/);
  }
});

test("self-hosted device setup keeps pairing without demo-specific or private repository instructions", () => {
  const html = renderToStaticMarkup(React.createElement(PairModal, { hosted: false, token: "private-workspace-token", onClose: () => {} }));
  assert.match(html, /<form/);
  assert.match(html, /Create pairing code/);
  assert.doesNotMatch(html, /href="\/account"|DemoPC/);
  const help = renderToStaticMarkup(React.createElement(SelfHostedPairingInstructions, { origin: "https://private.example" }));
  assert.match(help, /https:\/\/private\.example/);
  assert.match(help, /server owner/);
  assert.doesNotMatch(help, /\/bootstrap\/|start-windows|DemoPC|github\.com/);
});

test("a stale session cannot create legacy credentials on the hosted server", async () => {
  let redirected = 0;
  const result = await requestSelfHostedPairing("older-session", "Office computer", {
    fetcher: async () => new Response(JSON.stringify({ hosted: true }), { status: 200 }),
    createPairing: () => assert.fail("Hosted setup must not issue a pairing credential"),
    openAccount: () => { redirected++; },
  });
  assert.equal(result, null); assert.equal(redirected, 1);
  for (const hostname of ["providence.hani.so", "htn.hani.so"]) {
    await requestSelfHostedPairing("older-session", "Office computer", {
      hostname,
      fetcher: () => assert.fail("Known hosted origins go directly to account setup"),
      createPairing: () => assert.fail("Known hosted origins never issue legacy credentials"),
      openAccount: () => { redirected++; },
    });
  }
  assert.equal(redirected, 3);
});

test("confirmed self-host setup can create its code; an unknown server response cannot", async () => {
  const expected = { code: "fixture-code", expiresAt: "2026-09-26T00:00:00Z" };
  const result = await requestSelfHostedPairing("private-workspace-token", "Office computer", {
    fetcher: async () => new Response("not found", { status: 404 }),
    createPairing: async () => expected,
    openAccount: () => assert.fail("Self-hosted setup must remain on its coordinator"),
  });
  assert.equal(result, expected);
  const spaResult = await requestSelfHostedPairing("private-workspace-token", "Office computer", {
    fetcher: async () => new Response("<html>Providence</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    createPairing: async () => expected,
    openAccount: () => assert.fail("The self-hosted SPA fallback is not a hosted account server"),
  });
  assert.equal(spaResult, expected);
  await assert.rejects(requestSelfHostedPairing("private-workspace-token", "Office computer", {
    fetcher: async () => new Response("unavailable", { status: 503 }),
    createPairing: () => assert.fail("Unknown server mode must not create a credential"),
    openAccount: () => assert.fail("Unknown server mode must not guess account availability"),
  }), /could not confirm/);
});
const base: Task = {
  id: "task",
  requestId: "request",
  chatId: "child",
  deviceId: "mac",
  status: "running",
  prompt: "An existing task",
  text: "",
  createdAt: "2026-09-19T09:00:00Z",
  updatedAt: "2026-09-19T09:01:00Z",
};

test("every initial load selects Superagent and only explicit chat selection changes the current view", () => {
  for (const previous of [undefined, null, "child", "master"])
    assert.equal(initialSelectedChat(previous), "master");
  let selected = selectedChatAfter("master", {
    kind: "user_selected_chat",
    chatId: "child",
  });
  assert.equal(selected, "child");
  const events: SelectionEvent[] = [
    { kind: "request_routed" },
    { kind: "task_progress" },
    { kind: "task_completed" },
    { kind: "approval_resolved" },
    { kind: "refreshed" },
    { kind: "task_inspected" },
    { kind: "device_inspected" },
  ];
  for (const event of events) {
    assert.equal(selectedChatAfter("master", event), "master");
    assert.equal(selectedChatAfter(selected, event), "child");
  }
  assert.equal(
    selectedChatAfter(selected, {
      kind: "user_selected_chat",
      chatId: "master",
    }),
    "master",
  );
});

test("child approvals remain reachable from Superagent without switching chat", () => {
  const child: Approval = {
    id: "child-approval",
    taskId: base.id,
    deviceId: "mac",
    method: "item/tool/requestUserInput",
    status: "pending",
    details: { questions: [{ id: "choice", question: "Choose exact scope" }] },
  };
  const other: Approval = {
    ...child,
    id: "other-approval",
    taskId: "other-task",
  };
  const approvals = [child, other];
  assert.equal(reachableApprovals("master", [base], approvals), approvals);
  assert.deepEqual(reachableApprovals("child", [base], approvals), [child]);
  assert.deepEqual(reachableApprovals("unrelated", [base], approvals), []);
  assert.deepEqual(blockingApprovals("master", [base], approvals), []);
  assert.deepEqual(blockingApprovals("child", [base], approvals), [child]);
  const own = { ...child, id: "master-approval", taskId: "master-task", deviceId: "coordinator", status: "resolving" };
  const master = { ...base, id: own.taskId, chatId: "master", deviceId: "coordinator", status: "needs_input" };
  assert.deepEqual(blockingApprovals("master", [base, master], [...approvals, own]), [own]);
  assert.deepEqual(reachableApprovals("master", [base, master], [...approvals, own]), [...approvals, own]);
  assert.deepEqual(blockingApprovals("master", [base, master], [{ ...own, status: "expired" }]), []);
});

test("voice outcomes stay in selected context and omit interim and historical coordinator text", () => {
  const parent: Task = {
    ...base,
    id: "parent",
    chatId: "master",
    status: "completed",
    text: "Waiting for approval.",
    hasNewerChildUpdates: true,
    childTaskIds: ["worker"],
    workStatus: "completed",
    childUpdates: [
      {
        id: "worker",
        chatId: "child",
        chatName: "Exact | Chat",
        deviceId: "mac",
        deviceName: "MacBook",
        status: "completed",
        text: "Actual final response.",
        updatedAt: "2026-09-19T09:03:00Z",
        hasLiveText: false,
      },
    ],
  };
  const outcomes = selectedVoiceOutcomes("master", [
    parent,
    { ...base, id: "other", status: "completed", text: "Other chat response" },
  ]);
  assert.deepEqual(outcomes, [
    {
      id: "worker",
      contextKey: "master",
      parentTaskId: "parent",
      text: "Actual final response.",
      status: "completed",
      updatedAt: "2026-09-19T09:03:00Z",
    },
  ]);
  assert.deepEqual(
    selectedVoiceOutcomes("master", [
      {
        ...parent,
        childUpdates: [
          {
            ...parent.childUpdates![0],
            status: "running",
            hasLiveText: true,
            text: "Interim text",
          },
        ],
      },
    ]),
    [],
  );
  assert.deepEqual(
    selectedVoiceOutcomes("child", [
      parent,
      { ...base, status: "completed", text: "Selected chat result." },
    ]).map((outcome) => outcome.text),
    ["Selected chat result."],
  );
});

test("voice waits for the accepted Superagent turn and every sibling to finish before exposing child outcomes", () => {
  const child = { id: "C", chatId: "child", chatName: "Child", deviceId: "mac", deviceName: "Mac", status: "completed", text: "C finished", updatedAt: base.updatedAt, hasLiveText: false };
  const parent: Task = { ...base, id: "A", chatId: "master", status: "completed", workStatus: "running", childTaskIds: ["C", "D"], childUpdates: [child, { ...child, id: "D", status: "running", text: "D still running" }], hasNewerChildUpdates: true };
  const guard = new VoiceSessionGuard(), token = guard.begin("master");
  guard.claimTranscript(token, "master", "Accepted voice task A");
  guard.acceptTranscript(token, "master", { id: "A", requestId: parent.requestId, chatId: "master" });
  const unrelated = { ...base, id: "B", chatId: "master", status: "completed", text: "Another client's reply" };
  assert.equal(guard.claimFreshOutcome("master", selectedVoiceOutcomes("master", [parent, unrelated])), undefined);
  assert.deepEqual(selectedVoiceOutcomes("master", [parent]), []);
  assert.deepEqual(selectedVoiceOutcomes("master", [{ ...parent, workStatus: "completed" }]), []);
  const finished = { ...parent, workStatus: "completed", childUpdates: [child, { ...child, id: "D", text: "D finished" }] };
  assert.deepEqual(selectedVoiceOutcomes("master", [{ ...finished, status: "running" }]), []);
  assert.deepEqual(selectedVoiceOutcomes("master", [{ ...finished, workStatus: undefined }]), []);
  assert.deepEqual(selectedVoiceOutcomes("master", [finished]).map(value => [value.id, value.parentTaskId]), [["C", "A"], ["D", "A"]]);
  const finalOutcomes = selectedVoiceOutcomes("master", [finished, unrelated]);
  assert.equal(guard.claimFreshOutcome("master", finalOutcomes)?.id, "C");
  assert.equal(guard.claimFreshOutcome("master", finalOutcomes)?.id, "D");
  assert.equal(guard.claimFreshOutcome("master", finalOutcomes), undefined);
  assert.deepEqual(selectedVoiceOutcomes("master", [finished, { ...base, id: "D", parentTaskId: "A", status: "needs_input" }]), []);
  assert.deepEqual(selectedVoiceOutcomes("master", [finished, { ...base, id: "D", status: "running" }]), []);
  assert.deepEqual(selectedVoiceOutcomes("master", [finished, { ...base, id: "D", status: "completed", workStatus: "running" }]), []);
});

test("child outcome provenance comes from its server parent and conflicting links are excluded", () => {
  const child = { id: "C", chatId: "child", chatName: "Child", deviceId: "mac", deviceName: "Mac", status: "completed", text: "C finished", updatedAt: base.updatedAt, hasLiveText: false };
  const parent: Task = { ...base, id: "A", chatId: "master", status: "completed", workStatus: "completed", childTaskIds: ["C"], childUpdates: [child], hasNewerChildUpdates: true };
  assert.deepEqual(selectedVoiceOutcomes("master", [parent, { ...base, id: "C", parentTaskId: "B", status: "completed" }]), []);
  assert.deepEqual(selectedVoiceOutcomes("master", [{ ...parent, childTaskIds: ["different-child"] }]), []);
});

test("approved origami geometry remains consistent with a contrasting browser icon tile", () => {
  const html = renderToStaticMarkup(React.createElement(Mark));
  const favicon = readFileSync(
    new URL("../web/public/favicon.svg", import.meta.url),
    "utf8",
  );
  const paths = [
    "M3 12 8.5 6.4 9 12Z",
    "M9.7 6.1 18.9 8.5 11.1 20.5Z",
    "m12.2 21 8.6-14 9.4 13.8Z",
    "m22 6.7 11.1-3.5-1.8 17.1Z",
    "m34.3 3 26.7 5.4-28.5 12Z",
    "m12.4 22.3 18.6-.2 10.7 16Z",
    "M21.9 28.9 42.3 39.4 21.9 61Z",
  ];
  for (const path of paths) {
    assert.ok(html.includes(path));
    assert.ok(favicon.includes(path));
  }
  assert.ok(html.includes('fill="currentColor"'));
  assert.ok(favicon.includes('<rect width="80" height="80"'));
  assert.ok(favicon.includes('fill="#111111"'));
  assert.ok(favicon.includes('fill="#ffffff"'));
  assert.ok(!html.includes("m6 22 10-15"));
});

test("compact chat-history inspection preserves saved wording and context coverage without navigating", () => {
  const chat: Chat = {
    id: "child",
    name: "Exact | Chat",
    deviceId: "mac",
    threadId: "thread",
    online: true,
  };
  let opened = 0;
  const html = renderToStaticMarkup(
    React.createElement(ChatHistoryInspection, {
      chat,
      history: {
        messages: [
          { role: "user", text: "Keep this exact request.", taskId: "old" },
          {
            role: "assistant",
            text: "Keep this exact response.",
            taskId: "old",
          },
        ],
        scope: "Recent Providence-tracked history only.",
      },
      tasks: [],
      chatName: () => chat.name,
      onOpenTask: () => opened++,
    }),
  );
  for (const phrase of [
    "Exact | Chat",
    "Keep this exact request.",
    "Keep this exact response.",
    "Recent Providence-tracked history only.",
  ])
    assert.ok(html.includes(phrase));
  assert.equal(opened, 0);
});

test("a rehydrated unconfirmed send offers a dismiss control that does not cancel the task", () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) =>
        key === "providence.session"
          ? "ssr-only-fixture"
          : key === "providence.pending"
            ? JSON.stringify({
                requestId: "request-fixture",
                text: "Keep this exact request.",
                chatId: "child",
                sourceChatIds: [],
              })
            : null,
    },
  });
  try {
    const html = renderToStaticMarkup(React.createElement(App));
    assert.ok(html.includes("retry-banner"));
    assert.ok(html.includes("Check delivery"));
    assert.ok(html.includes("Dismiss local retry"));
    assert.ok(html.includes("it does not cancel any submitted task"));
  } finally {
    if (prior) Object.defineProperty(globalThis, "sessionStorage", prior);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("a working conversation says when the next message can be sent instead of inviting one", () => {
  const placeholder = composerPlaceholder(true, "master");
  assert.ok(placeholder.includes("can be sent when it finishes"));
  assert.ok(!/while this task runs/i.test(placeholder));
  assert.ok(!/write your next message/i.test(placeholder));
  assert.equal(
    composerPlaceholder(false, "child", "Exact | Chat"),
    "Message Exact | Chat…",
  );
  const html = renderToStaticMarkup(
    React.createElement(ComposerSend, {
      busy: true,
      sending: false,
      disabled: false,
    }),
  );
  assert.ok(html.includes(`title="${placeholder}"`));
  assert.ok(html.includes('disabled=""'));
  assert.ok(
    !renderToStaticMarkup(
      React.createElement(ComposerSend, {
        busy: false,
        sending: false,
        disabled: false,
      }),
    ).includes("title="),
  );
});


test("hosted sign-in and AI consent notices lead to Account without exposing a legacy key form or accepting consent", () => {
  const signIn = renderToStaticMarkup(React.createElement(HostedSignIn));
  assert.match(signIn, /Sign in with a passkey/); assert.match(signIn, /href="\/account"/);
  assert.doesNotMatch(signIn, /<input|Workspace access key|one-use code/);
  const consent = renderToStaticMarkup(React.createElement(AIProcessingNotice));
  assert.match(consent, /OpenAI processes your data/); assert.match(consent, /href="\/account#ai-processing"/);
  assert.doesNotMatch(consent, /<input|Allow OpenAI processing/);
});
