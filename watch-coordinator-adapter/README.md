# WatchCoordinatorAdapter

A small, dependency-free Swift transport/model package for a future native
Apple Watch Providence client. It has no UI, transcription, coordinator server,
AI provider, stored credential, or automatic retry/poll loop.

`CoordinatorClient` is an actor: its shared JSON encoder/decoder remain isolated,
and its immutable request/response values are `Sendable`. Existing `try await`
calls from `@MainActor` UI code keep the same shape. A custom `HTTPTransport` must
be `Sendable` (use an actor for mutable transport state); the token provider is
an `@Sendable` async closure. When reading a main-actor token store, explicitly
`await` that store's method rather than capturing mutable UI state. Network
requests can overlap while the client awaits I/O; actor isolation does not add
a request queue, deduplication, or automatic retry.

The implementation follows `coordinator/docs/WATCH_API.md` at Providence commit
`24be76548a378a3d3e07021e19dbbd2b805797ed`.

## Integration sketch

```swift
import WatchCoordinatorAdapter

let client = try CoordinatorClient(
    baseURL: URL(string: "https://providence.hani.so")!,
    tokenProvider: ClosureBearerTokenProvider {
        // Read from the app's native secure storage. Never commit the token.
        try await secureTokenStore.clientToken()
    }
)

// Persist this value before the network call. Keep the entire submission until
// a task ID is known so an explicitly requested ambiguous-failure retry can
// resend the same UUID, text, and encoded JSON body.
let submission = try MessageSubmission(requestID: UUID(), text: exactText)
let task = try await client.submit(submission)

// Save task.id separately. Each call performs exactly one GET and cannot submit.
let current = try await client.task(id: task.id)
if current.status == .needsInput {
    let briefing = try await client.briefing()
    if let approval = briefing.approvals.first(where: { $0.taskID == current.id }) {
        // Only after an explicit choice in the Watch UI:
        _ = try await client.resolveApproval(
            approval,
            for: current,
            with: .decision(.accept)
        )
    }
}
```

`POST /v1/messages` always creates a `chatId:"master"`,
`deviceId:"coordinator"` task. Its body has no device, workspace, or chat field;
the master decides whether and where to delegate. It therefore cannot guarantee
that a request runs on Review's Mac.

For an exact host, an administrator must first register Review's companion and a
conversation on that device. The documented setup sequence is:

1. Connect the companion with its private `deviceId`, token, coordinator URL,
   and allowed absolute workspace.
2. Confirm `GET /v1/devices` returns that exact device ID as `online:true` and
   inspect its workspace/capabilities.
3. Create or import a conversation with `POST /v1/chats` using
   `{deviceId,name,threadId?,workspace?,instructions?}`. This is an explicit,
   state-changing administrator/integration step and is intentionally not
   automated by this package.
4. Persist the returned chat ID and expected device ID. Re-fetch `GET /v1/chats`
   on reconnect and require the chat's `deviceId`, workspace, and online state
   to match.
5. Prepare `DirectMessageSubmission` and send it to
   `POST /v1/chats/:chatId/messages`. The adapter requires the expected device
   match, includes the documented `sourceChatIds` array, and verifies the task
   response still names that chat and device.

```swift
let chat = (try await client.chats()).first {
    $0.id == savedReviewChatID && $0.deviceID == savedReviewDeviceID
}!
let direct = try DirectMessageSubmission(
    requestID: UUID(),
    text: exactText,
    chat: chat,
    expectedDeviceID: savedReviewDeviceID
)
let reviewMacTask = try await client.submit(direct)
```

Do not select a device by a mutable display name and do not fall back to
`/v1/messages` when the saved Review chat/device is absent or offline. Exact
device registration, workspace choice, and chat creation remain coordinator
setup work outside the Watch app.

The application owner controls persistence, cadence, foreground recovery, UI,
and secure token provisioning. Do not generate a new request ID after an
ambiguous send failure. Do not call `submit` from a polling loop. Do not infer an
approval from speech or resolve an approval that was not explicitly selected.

`ApprovalResolution` covers the server's three exclusive payload forms:
`decision`, question `answers`, and typed provider `response`. Typed permission
grants remain explicit JSON because they must mirror the exact fields in the
pending approval; the coordinator remains the authority that validates no
unrequested permission was added.

## Local checks

```sh
swift test --package-path watch-coordinator-adapter
xcodebuild -scheme WatchCoordinatorAdapter \
  -destination 'generic/platform=watchOS' \
  -derivedDataPath /tmp/watch-coordinator-adapter-derived \
  CODE_SIGNING_ALLOWED=NO build
```

The tests use synthetic fixtures and an injected transport. They do not contact
Providence or require credentials.
