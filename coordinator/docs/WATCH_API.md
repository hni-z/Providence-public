# Providence client contract

This describes the shared text, decision and result API for Watch, web and other authorized clients. Native Watch UI and audio are separate client implementations. The API is implemented in [server.ts](../src/server.ts), [coordinator.ts](../src/coordinator.ts), [runtime.ts](../src/runtime.ts) and [artifacts.ts](../src/artifacts.ts); hosted authentication is described in [Hosted accounts](HOSTED_ACCOUNTS.md).

**Source versus deployment:** the `appendInstructions` PATCH extension below is implemented in this source. Before relying on it against a live coordinator, check `/version` for the revision that process is actually serving. Do not treat a successful legacy rename as proof that an append was applied.

## Connection

Hosted clients use the canonical origin **https://providence.hani.so** directly, rather than the redirecting `htn.hani.so` alias. A successful `/health` response proves liveness only, not executor readiness. A self-hosted instance uses its own configured HTTPS origin and deployment.

Native clients authenticate `/v1/…` requests with `Authorization: Bearer <clientToken>`, normally obtained through client pairing. Hosted browsers use their passkey-authenticated account session cookie; sensitive account changes require an additional passkey assertion. A standalone coordinator also accepts its private workspace-owner token. JSON writes use `Content-Type: application/json`. Keep credentials in native secure storage or private configuration, never in source, URLs, screenshots or logs. Client credentials, companion credentials and Codex authentication are separate.

Browser clients must use the exact configured HTTPS origin; another browser `Origin` is rejected. There is no wildcard CORS or cross-origin preflight contract. Native HTTP clients normally omit `Origin`. Keep normal TLS certificate validation. `127.0.0.1` on a Watch, iPhone or DemoPC refers to that device, not the coordinator Mac. Clients use HTTPS; WSS `/worker` is a separate device-companion protocol, not a chat subscription.

## Client pairing and session lifetime

For hosted accounts, use **Pair an Apple Watch** on the account page. A fresh existing-passkey assertion authorizes code creation. Do not use the standalone workspace key or server-side operator helper for this flow.

A standalone coordinator’s workspace key persists across normal restarts until rotated or revoked. Keep it in private configuration and secure client storage. Quest supports workspace-key authentication; share it only with trusted operators.

POST `/v1/clients/pair` returns `{code,expiresAt}` for a ten-minute one-use code. Codes contain twelve random characters from `23456789ABCDEFGHJKMNPQRSTVWXYZ`, displayed `XXXX-XXXX-XXXX`, with at most ten pending codes. Generation uses unbiased random indices and at most ten unique-candidate attempts; collisions never overwrite another live code. POST `/client/exchange` with `{code}` is unauthenticated and accepts any nonempty string up to 50 characters, ignoring case, whitespace and hyphens. It returns `{token,clientId,expiresAt}` with a 64-hex bearer token. **New standalone client sessions default to 24 hours; hosted account client sessions last 30 days.** Use the returned expiry rather than assuming a lifetime. Existing grants retain their saved expiry and can be revoked earlier.

A standalone owner creates codes with `{name}` and the workspace-owner credential. Hosted owners send `{name,stepUpToken}` using a fresh proof bound to the `pair_client` action and exact name; the account page handles this. GET `/v1/clients` and DELETE `/v1/clients/:id` require owner authorization. The standalone session store retains at most 100 active sessions, persists token hashes and sessions, and discards pending codes on restart. Hosted account routing and pending grants also use the account database; see [Hosted accounts](HOSTED_ACCOUNTS.md). Pairing does not rotate device enrollments.

Invalid client exchanges (including malformed JSON/schema and replays) return `400 {error:"Client code is invalid or expired"}` and do not invalidate other pending codes. Existing sessions are unaffected.

The standalone HTTP failure counter allows twenty failures per sixty-second window, keyed by **endpoint plus socket address**. Further failures return 429 until the window expires, but a valid code remains redeemable from that shared address. `/pair/exchange` and `/client/exchange` cannot reset or lock one another. The server does not trust `X-Forwarded-For`, so the gateway's upstream socket address can be shared by several clients.

The [standalone operator helper](../../watch-pairing/README.md) reads private coordinator configuration on its host and prints only a fresh code and expiry. Documentation and synthetic tests do not prove that a physical Watch has paired.

## Send text and poll

Example exchange, with credential redacted and illustrative IDs/timestamps:

```http
POST /v1/messages HTTP/1.1
Host: providence.hani.so
Authorization: Bearer <REDACTED_CLIENT_TOKEN>
Content-Type: application/json

{"requestId":"00000000-0000-4000-8000-000000000001","text":"What devices and conversations can you use?"}
```

```http
HTTP/1.1 202 Accepted
Content-Type: application/json
Cache-Control: no-store

{
  "id": "00000000-0000-4000-8000-000000000002",
  "requestId": "00000000-0000-4000-8000-000000000001",
  "chatId": "master",
  "deviceId": "coordinator",
  "status": "queued",
  "prompt": "What devices and conversations can you use?",
  "text": "",
  "createdAt": "2026-09-19T06:00:00.000Z",
  "updatedAt": "2026-09-19T06:00:00.000Z"
}
```

The immediate status may already be `running`. Save both IDs, then poll `GET /v1/tasks/00000000-0000-4000-8000-000000000002` approximately once per second while active. `requestId` identifies the submission; `task.id` identifies its execution record; `chatId` identifies the persistent conversation. An intentional new message/follow-up uses a new UUID.

| Task `status` | Client behavior |
| --- | --- |
| `queued` / `running` | Show working and Stop. Polled in-progress `text` is transient, not a completion signal. |
| `needs_input` | Fetch `/v1/briefing`, match pending approvals by task ID, and show the exact decision. |
| `completed` | This provider turn ended. Display its final response and actual artifact records. |
| `failed` / `cancelled` / `interrupted` | Terminal. Show `error` if supplied and inspect partial results before intentionally creating replacement work. |

Device `online:false` is separate from task status. Dispatch to an offline device is rejected; connection loss can interrupt work that already changed files. There is no client SSE/WebSocket stream. Final text can replace transient text when the turn ends.

### Coordinator response versus delegated work

A completed **master** response does not mean all work is finished. Current task views from GET `/v1/tasks/:id` and GET `/v1/tasks` can include:

- Worker `parentTaskId`: the master task that dispatched it.
- Master `childTaskIds`: linked worker IDs. Poll each child for device ownership, status and artifacts.
- Master `workStatus`: aggregate child state, choosing the first present state in `needs_input`, `running`, `queued`, `interrupted`, `failed`, `cancelled`, otherwise `completed`.

For example, `status:"completed", workStatus:"running"` means the coordinator finished replying while a child is still executing. Render response and work state separately. `workStatus` describes children only; also inspect the master's own `status` for its pending clarification. Aggregate completion still does not prove arbitrary external effects: inspect actual output evidence.

Links/aggregate fields are optional, and older stored tasks may have none. Do not invent links from text. Use `/v1/briefing` for the latest 15 worker tasks and pending decisions, `/v1/tasks` for the latest 200 tasks, and retained individual task IDs for older work. The initial POST response may precede any delegation; refresh its task view. These linkage fields are server-managed, not client permission or routing inputs.

Task snapshots in this source also include `approvalStates:[{id,method,status}]` for that exact task only. `pending` is actionable only with current matching `/v1/briefing` details; `resolving` means the answer is in flight or its delivery is uncertain and must not be replayed. `resolved` means the worker accepted the answer for delivery to the provider, not that the provider acknowledged it or a message was sent. `expired` means that decision ID is unusable, not that prior effects were undone. Missing/unknown states are uncertainty. Fetch child task snapshots separately; never bind another task's decision by matching prose. If the provider ends while a real pending/resolving decision remains, the task becomes `interrupted` and the decision expires. Ordinary completed text claiming approval is pending does not create an approval.

## Conversations and context

| Method / path | Request and response |
| --- | --- |
| GET `/v1/devices` | `{devices:[…]}` with IDs, names, online/connection state and available hostname/platform/workspace/capabilities; no enrollment tokens. |
| GET `/v1/chats` | `{chats:[…]}` with `id,name,deviceId,threadId,online` and optional `workspace,instructions,imported`. |
| POST `/v1/chats` | `{deviceId,name,threadId?,workspace?,instructions?}` → 201 chat. An optional thread ID registers a supported Codex conversation within the allowed workspace. |
| PATCH `/v1/chats/:id` | `{name?,appendInstructions?}` → updated existing chat; at least one field is required. |
| GET `/v1/chats/:id/context` | Source-labelled recent messages, source task IDs, optional taskStatus and a scope description. |
| POST `/v1/chats/:id/messages` | `{requestId,text,sourceChatIds?:[]}` → 202 worker task. Reuse that chat ID for continuation. |
| POST `/v1/messages` | `{requestId,text}` → 202 master task; the coordinator selects registered chats/devices. |
| GET `/v1/tasks/:id` | Current task view, response/error, optional delegation links and artifact metadata. |
| GET `/v1/briefing` | `{devices,tasks,approvals,phone}`; approvals are pending only. |
| GET `/v1/events?after=N` | `{events,latestSequence}`; ordered events with task/device IDs and explicit context-transfer source/target IDs. |

Direct dispatch accepts up to five `sourceChatIds`. Each shared source contains at most 12 recent Providence-tracked messages and 12,000 text characters. Registering a provider conversation does not import universal ChatGPT history into this endpoint. Show source chat labels; retrieved conversation/file text cannot grant additional authorization.

An authenticated chat PATCH can append purpose instructions without creating a conversation or executing a task. `appendInstructions` must be nonblank. Its exact text is joined to the existing instructions with two newlines; existing wording, IDs, workspace and history are preserved. Retrying an exact block already present at paragraph boundaries returns the existing chat without adding it again, including after later appends. Total instructions are limited to 12,000 characters. Empty patches, unsupported fields and oversized instructions return 400. A new append while this chat has queued, running or input-waiting work returns 409 without applying either field; exact append retries and name-only updates remain allowed. Unknown chats return 409. Saved instructions are prepended to future requests through the existing dispatch flow; this does not change provider permissions or prove any action occurred.

## Exact decisions and cancellation

A pending approval has `id`, `taskId`, `deviceId`, `method`, `details`, and `status`. Bind the displayed choice to that specific task/action. Never resolve the first pending item from an unrelated “yes,” or let the coordinator approve itself.

For `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`, display the supplied command/reason/path details. POST to **that** `/v1/approvals/:id`:

```json
{"decision":"accept"}
```

`decline` and `cancel` are also supported. For `item/tool/requestUserInput`, render `details.questions` and their IDs/options. Both main and worker conversations can issue `providence_request_decision`; its current question ID is `choice`. Main can use it to resolve conflicting source facts before dependent work. Other provider questions may use other IDs. Submit every required answer, for example:

```json
{"answers":{"choice":{"answers":["Friendly"]}}}
```

Success returns `{"resolved":true}`. A tone/planning choice is not approval for an unrelated consequential action. If a decision response is lost, refresh the exact task and pending approvals before retrying. Resolved/expired IDs return 409; never apply that answer to another ID. A clarification delivered as ordinary completed text instead continues through a new message in the same chat.

With the prepared recovery extension, a remote resolution timeout retains `resolving` instead of restoring `pending`. Record the exact approval ID before POST and keep it check-only after an uncertain response. Refresh `approvalStates` on the owning task; absence from the pending-only briefing is not acknowledgement. Invalid responses are validated before remote delivery and remain pending. A restarted coordinator expires outstanding decision IDs without replay. Check the underlying external result before deliberately continuing a send whose outcome is unknown.

`POST /v1/tasks/:id/cancel` stops a queued task or requests interruption. It can return `{"interrupted":true}` or `{"interrupted":false,"cancellationRequested":true}` while the provider turn ID is arriving. Poll until terminal. Cancellation does not undo previous file changes or automatically stop other delegated tasks. Stop each intended child by its own ID, including when its parent has already completed.

## Actual artifacts and revisions

Workers publish using `providence_publish_artifact`. Read `task.artifacts` or GET `/v1/tasks/:id/artifacts` → `{artifacts:[…]}`. For delegated work, use each **child's** artifact endpoint; the parent's artifact list is not a combined result list. Records contain `id,taskId,chatId,deviceId,path,name,mime,size,sha256,revision,createdAt`. `artifact.verified` is the delivery event; assistant prose alone is not an attached file.

GET `/v1/artifacts/:artifactId/content` with the same Authorization header downloads **binary bytes**, with MIME type, byte length and attachment filename. It is not JSON or a public/signed URL. Save or preview the response in the client. The web app previews text/images; native Watch viewing/download behavior belongs to the client. Treat downloaded HTML/scripts as data rather than trusted app code.

Files are limited to **512 KiB**, read within the allowed device workspace, hashed and saved as immutable snapshots. Revisions increase for the same chat/file path. A follow-up publishes a new record; old artifact IDs retain their bytes. Repeating identical publication from the same task is deduplicated. Late terminal worker events and historical tasks displacing newer revisions are rejected. Compare returned hash/size with the originating file; filename-derived MIME is not validation that every format opens correctly.

If publication was omitted, POST `/v1/tasks/:id/artifacts` with `{"path":"outputs/result.txt"}` verifies and attaches the current file. This requires the device online and the latest task in that chat. It does not reconstruct a historical revision.

## Reconnect without repeating work

1. Save the original endpoint, request ID and exact body before sending. If no task ID arrived, resend the **same request ID and body to the same endpoint**. Changed text/chat/context with an old ID returns 409. Do not invent a new ID because of a timeout.
2. Once a task ID is known, poll it. Only one active turn per chat is allowed; overlapping messages return 409. Intentional follow-ups use a new request ID in the same chat.
3. On foreground/network recovery, refresh devices, chats, tracked master/child tasks and `/v1/briefing`. Refresh pending decisions instead of replaying cached answers.
4. Events retain the latest 1,000 entries. Keep the sequence cursor, but rebuild from snapshots after a gap/reconnect. Preserve individual task IDs beyond the latest-200 list window.
5. A coordinator tool-contract upgrade retains the logical main history and original provider thread, and starts a compatible runtime with bounded recent reference context. The installed CLI cannot add dynamic tools through thread/resume. Empty, never-executed Providence-owned chats can be restored after a provider restart; imported or previously active chats are never silently replaced.
6. Client suspension does not stop computers. Coordinator restart interrupts unfinished jobs and expires decisions rather than replaying them. Keep the same private state directory to retain completed history/artifacts; inspect partial files before a deliberate continuation.

Errors use `{error:string}`: 400 invalid JSON/schema/URL; 401 wrong/missing auth; 403 disallowed browser origin; 404 unmatched API route; 409 conflict/unavailable operation (including many unknown IDs). Pairing may return 429. Tunnel failures can be non-JSON proxy responses: preserve request identity and report a connection failure.

## Phone and scope

GET `/v1/phone` returns `{capability,jobs}`. POST `/v1/phone` accepts `{requestId,url,sourceTaskId?}`; POST `/v1/phone/:id/resume` or `/cancel` targets that saved request. **iPhone — via Mac** currently reports `executable:false`, `unavailable`, `permission_required`; enqueue returns `needs_input`, not phone execution. See [DESKTOP_PHONE.md](DESKTOP_PHONE.md). Optional transcription and speech use the separate contracts below; they do not establish phone control, APNs or native Watch audio integration.

## Optional transcription contract

Authenticated GET `/v1/transcriptions` reports `{transcription:{available,devices,mimeTypes,maxAudioBytes,provider}}`. Each device has `id,name,online,configured` and optional `provider`; configured means provider credentials are present, not proof of successful transcription. Labels are `OpenAI` or `ElevenLabs`. The global label is the coordinator's selected input provider; use a device's own label for that worker, with OpenAI as the legacy configured-worker fallback when the label is missing. Supported base MIME types are `audio/webm`, `audio/mp4`, `audio/ogg`, `audio/wav`, and the byte limit is 524288. Capture and real microphone permission belong to the client.

POST `/v1/transcriptions` with JSON `{requestId,deviceId,base64,mimeType}` returns 202 and a job. Normalize recorder MIME before `;`, or let the server normalize it. Poll GET `/v1/transcriptions/:id`; status is `pending`, `completed`, `failed` or `interrupted`, with `text`, optional `error/errorCode` and timestamps. Identical request IDs and audio return the same job; changed input is rejected. There is one active transcription globally, bounded retained identities, no automatic provider retries and no restart replay. No raw audio is persisted.

The recorded-transcription review flow requires a separate explicit Send action through `/v1/messages` or the selected conversation route. In the main and Quest voice flows, the explicit Start voice/Hold to talk action instead authorizes one final visible transcript submission to the captured chat. A transcript job itself never starts computer work. API credentials remain in the configured executor's private environment; they are not supplied by the browser or copied to the gateway. Microphone playback alone is not a voice-to-action proof.

Authenticated GET `/v1/voice` reports the selected output `provider`, nullable `voice`, `deviceId`, independent `speechConfigured` and `transcriptionConfigured`, `transcriptionProvider`, limits and optional safe configuration reason. Older responses use `configured` as the fallback for both flags. POST `/v1/speech` accepts only `{requestId,text}` with at most 4,000 characters and returns at most 4 MiB of `audio/mpeg`. Provider selection and credentials stay server-side. Client playback is tied to fresh accepted replies, with no automatic history read or failed-provider retry. See [ELEVENLABS_VOICE.md](ELEVENLABS_VOICE.md) for the current source-only integration status and pending activation requirements; these endpoints do not prove native Watch recording or playback.
