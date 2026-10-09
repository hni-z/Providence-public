# Native task routing checks

Run from the repository root:

```sh
bash tests/task-routing/run.sh
```

The runner builds the existing `WatchCoordinatorAdapter` package, links the
standalone planner and test executable against that adapter, and compiles with
complete strict concurrency and warnings as errors. All inventory is synthetic;
there are no provider, coordinator, or device calls.

## Integration API

```swift
let route = try TaskRoutePlanner.resolve(
    text: transcript,
    devices: freshDevices,
    chats: freshChats,
    defaultDeviceID: configuration.deviceID,
    defaultChatID: configuration.chatID
)
```

`TaskRouteSelection` has immutable `deviceID`, `chatID`, `deviceName`, `action`,
and `reason`. `TaskRouteAction` is a String-backed Codable enum: `general`,
`browser`, `files`, `messaging`, `email`, `phoneCall`. The last category always
throws for now. `TaskRouteError` exposes useful `LocalizedError` descriptions
through `.clarification(String)` and `.unavailable(String)`.

Explicit iPhone requests additionally accept `expectedMirroringTarget` from the
public Watch configuration. A successful selection includes optional
`iphoneMirroring` (exact Mac/chat/phone plus readiness lease and action). Typed
`IPhoneMirroringError` failures have a short headline and separate recovery
suggestion. See [the contract](../../iphone-mirroring/CONTRACT.md) for required
Watch caller and coordinator-owner integration, and the staged
Demo acceptance packet.

The planner only selects a route. The caller must persist the exact returned
IDs with the original transcript and request identity, then revalidate that
same registered device and online chat before the direct chat POST. Never
re-run selection to change an ambiguous submission's target during retry.

## Policy and limitations

- Positive explicit targets constrain the inventory. An explicit target that
  matches the configured computer stays bound to it even if it is offline.
- Without an explicit target, an eligible configured default is preferred.
  Otherwise weighted capability scores choose a unique best eligible device;
  equal scores ask for clarification.
- Only effective top-level boolean `files`, `shell`, `browser`, and `desktop`
  values count. Browser/desktop labels already reflect the coordinator's scoped
  verification. Model metadata and raw declarations grant nothing.
- General/email/messaging can use the trusted configured Mac without browser
  evidence. A browser request first considers verified browser candidates;
  if there are none, the trusted Mac can accept a general Codex attempt with an
  explicit unverified-browser reason. Its actual tools/permissions decide what
  executes. Files require `files: true`.
- Explicit iPhone/phone requests use only the selected Mac's iPhone Mirroring
  path when the exact configured phone and a fresh effective readiness lease
  pass all independent gates. Missing setup gives a specific typed blocker.
  Android/iPad/Quest targets and phone calls remain unavailable.
  `phoneMirroring` does not prove an executable adapter. Windows/Linux targets
  require their actual platform. A missing platform is trusted as Mac only for
  the configured device; arbitrary display names cannot grant a platform.
- The default device retains its exact configured chat. Another device must
  have exactly one online chat; the planner never chooses an arbitrary context.
- This is a bounded English command grammar, not general language understanding
  or a security boundary. Quotes, unclosed quotes, common dictated-body markers,
  topic mentions, and negative destination clauses are treated conservatively.
  Multiple recognized action classes require one task at a time.

The original 112 routing checks are retained, extended with Mirroring checks for
each readiness gate, action scope, exact phone/Mac/chat/lease binding, expiry,
unsupported native operations, body/negation handling, optional configuration,
request persistence and preserved speech/name/send policies. All are synthetic.
The suite also covers
offline targets, capability absence/weighting, content versus destinations,
negative targets, named targets, duplicate names/IDs, chat integrity, deferred
calls, and the trusted Mac exception. Watch app/Xcode integration is owned by
the parent task and is not established by this executable.
