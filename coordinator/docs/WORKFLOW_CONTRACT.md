# Guarded three-computer workflow contract

This is an optional contract for a deliberate research → analysis and presentation workflow. Ordinary Superagent and direct-chat requests retain their existing behavior. No device enrollment, permission grant or new conversation is created by this contract.

`POST /v1/messages` accepts:

```json
{
  "requestId": "stable-root-request",
  "text": "Research the topic, then analyze and present the findings",
  "workflow": {
    "version": 1,
    "bindings": [
      { "role": "research", "deviceId": "research-computer", "chatId": "research-chat" },
      { "role": "analysis", "deviceId": "analysis-computer", "chatId": "analysis-chat" },
      { "role": "presentation", "deviceId": "presentation-computer", "chatId": "presentation-chat" }
    ]
  }
}
```

IDs above are illustrative. Use the exact existing registered IDs. The strict manifest requires all three unique roles, computers and conversations. The server checks each chat/computer binding, current online readiness, file/shell support and browser or desktop support before creating the parent. Capability metadata is not app permission or fresh visible-effect proof. Failed preflight creates no parent or child task. The accepted manifest is frozen and persisted on the parent as `workflow`.

Submitting any `workflow` field to `/v1/chats/:id/messages` is rejected before direct dispatch. Only `/v1/messages` can admit this guarded workflow.

`providence_dispatch` requires `role` for this parent. Research starts without a dependency or source conversation. Analysis and presentation are independent siblings: each must use `afterTaskId` equal to that parent's research child and may receive source context only from its research conversation. Omitting `sourceChatIds` adds that exact research conversation automatically. A wrong role, destination, dependency or conflicting duplicate is rejected before reservation. A repeated identical role call returns its existing child and binds the retry request ID to that child (at most 64 aliases); it cannot later be reused for another role or prompt. A root retry returns the original parent and child set. Neither replays work.

The parent exposes `childTaskIds`, `workStatus`, and a server-derived `workflowStatus`:

```ts
type WorkflowStatus = {
  state: "waiting_research" | "running" | "needs_input" | "partial_failure" | "completed";
  reasonCode?: "required_role_not_started" | "parent_failed" | "role_failed";
  requiredRolesCompleted: number;
  artifactsPublished: number;
  outputsReady: boolean;
  effectVerification: "not_verified";
  roles: Array<{
    role: "research" | "analysis" | "presentation";
    deviceId: string;
    chatId: string;
    taskId?: string;
    status: string; // "not_started" or the actual task status
  }>;
  publishedArtifacts: Array<{
    id: string; taskId: string; chatId: string; deviceId: string;
    name: string; mime: string; size: number; sha256: string; revision: number;
  }>;
};
```

The role and artifact arrays contain actual IDs and authoritative published metadata. `artifactsPublished` counts only registry records belonging to an exact manifest-bound child. `outputsReady` requires the completed parent, all three completed roles with the exact successful research dependencies, a valid exact-origin research bundle, and at least one nonempty artifact with a valid SHA-256 value per role. The research publication reference must also match the registry as described below. It does not prove the output is open on a screen or factually correct.

Research receives its actual task/chat/device IDs in the worker prompt. Its complete final text must be the strict JSON format exported by `workflow-facts.ts`: version, topic, criteria, generatedAt, exact origin and declared artifact state, one or two sources, and one to six source-linked facts. The whole text must fit 2,048 UTF-8 bytes. At dependent release, the coordinator calls the shared parser with the exact expected origin. Invalid JSON, extra prose/fences, oversized text or wrong provenance interrupts each dependent before execution; no truncation or repair is attempted. Only the validated fact bundle is passed onward. Source conversation IDs remain in the context-transfer audit, but unrelated recent history is excluded. Structural validation is not independent fact-checking or proof of a declared publication.

The worker publisher verifies local path, size and hash without returning the server-minted artifact ID. This normal result must be represented honestly:

```json
{"status":"publication_unconfirmed","path":"research-brief.md","size":512,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

These are illustrative values; copy the actual publisher result. Never invent a server ID. `publication_unconfirmed` is valid factual handoff data, but output readiness stays false until the server registry contains the exact research task/device/chat/path/hash/size. `{status:"published",id,sha256}` is permitted only for an actually acknowledged server publication; the server checks its exact ID/hash and origin against the registry before releasing dependents. `{status:"not_published"}` carries no invented references and cannot alone establish readiness; a later authoritative artifact from that exact research child can establish file availability without changing the declared bundle. No state establishes visible-screen proof.

| Fixture | Expected fields |
| --- | --- |
| Parent and all three roles completed, no artifacts | `state:completed`, `requiredRolesCompleted:3`, `artifactsPublished:0`, `outputsReady:false` |
| Parent and roles completed, valid file published by each exact role | `state:completed`, `requiredRolesCompleted:3`, `artifactsPublished:3`, `outputsReady:true`, `effectVerification:not_verified` |
| Artifact has another task/device/chat, zero size or invalid hash | `outputsReady:false` if that role has no other valid artifact |
| Research publication is unconfirmed and no exact path/hash/size registry match exists | `outputsReady:false`, even if another research artifact exists |
| Research claims a published ID absent from its authoritative registry | Dependents interrupted before execution; `outputsReady:false` |
| Parent completed, a required child is still running | `state:running`, `outputsReady:false` |
| Parent completed with zero, one or two roles started | `state:partial_failure`, `reasonCode:required_role_not_started`, `outputsReady:false` |
| A role failed or the parent failed/cancelled | `state:partial_failure`, `outputsReady:false` |

Clients may announce that the brief, comparison and webpage files are ready only when `outputsReady` is true. They must not announce that all screens were opened or visually verified. `state:completed` alone means task completion; display verification remains separate. Tests in `coordinator/test/workflow-manifest.test.ts` exercise the real coordinator with fake runtimes and local artifact bytes, without provider calls or physical-computer acceptance.
