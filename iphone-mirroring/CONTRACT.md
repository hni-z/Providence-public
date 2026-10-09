# Exact normal-worker iPhone route

The selected registered Mac runs its existing native computer-use tool against
Apple iPhone Mirroring (`com.apple.ScreenContinuity`). The Watch default Mac and
selected phone's Mac may differ. Phone requests never fall back to a Mac browser,
desktop app, another phone, or another account.

## Configured routing and live preflight

The current path admits an attempt using a durable operator-confirmed binding.
The normal worker verifies the actual connection before phone input, preserving
provider permission decisions. Configuration grants no app use and proves no
live connection, account, control, or completed effect.

The coordinator reads private `iphone-mirroring-evidence.json` on demand. It must
be a regular coordinator-owned file with no group/other access (0600). Symlinks,
oversized/malformed documents and invalid fields fail closed. There is no client
or model writer and no automatic timestamp renewal.

```json
{
  "schemaVersion": 2,
  "binding": {
    "verification": "owner_confirmed_pairing",
    "enabled": true,
    "deviceId": "EXACT_REGISTERED_PHONE_HOST",
    "chatId": "EXACT_REGISTERED_PHONE_CHAT",
    "phoneId": "OWNER_CONFIRMED_OPAQUE_PHONE_ID",
    "phoneName": "Selected iPhone",
    "epoch": "NEW_CONFIGURATION_EPOCH",
    "allowedActions": ["general"],
    "confirmedAt": 1000
  }
}
```

This is a schema example, not installation data. `confirmedAt` records actual
owner confirmation in Unix seconds. Startup/offline events do not renew or
invalidate routing configuration; disable it to revoke, and change the epoch
when selection changes. Allowed actions are routing categories, not permission
or physical acceptance of every operation in them.

`binding.mjs` exposes `capabilities.iphoneMirroringBinding` with exact public
identities, bindingEpoch, allowedActions, status `configured`,
`requiresLivePreflight:true`, `grantsPermission:false`. It exposes no ready,
authenticated, controllable, executable or effect-verified flags. Any v2 binding
key, including invalid/disabled, suppresses legacy readiness fallback.

Watch `iphoneMirroringTarget` contains matching deviceId/chatId/phoneId/phoneName.
Existing deviceId/chatId remain the default Mac route. Optional
`preferredChatIDsByDevice` maps explicit other-computer requests to an exact
existing chat when several exist. It never overrides the default or picks an
arbitrary chat. Registry ownership and online state must still match.

## Typed requests and reservation

Direct `/v1/chats/:id/messages` accepts and echoes this optional exact object:

```ts
executionTarget?: {
  transport: "apple-iphone-mirroring";
  deviceId: string; chatId: string; phoneId: string; phoneName: string;
  leaseId: string; // bindingEpoch, or a legacy observation lease
  action: "general" | "browser" | "messaging" | "email";
}
```

Extra/missing fields fail. Master `/v1/messages` rejects phone targets. Exact UUID,
text and route persist before dispatch. Retry looks up UUID before admission,
returning an existing task even after revocation without replay. Changed input
conflicts. Every new/queued start validates the online Mac/chat, current binding
and epoch/action, and reserves that Mac across all Providence conversations.

Uncertain failed/interrupted/cancelled phone tasks retain their reservation until
host-owned exact task/lease provider-quiescence proof reconciles it. Proven
pre-dispatch failure releases unused reservation; lost acknowledgement does not.
Other computers remain independent. Only an authenticated exact HTTP409 with
requestId, `requestStatus:"not_accepted"` and reason code lets Watch discard an
unused submission identity; generic HTTP/network errors retain it.

## Native execution and evidence

The documented first `getApp` entry stands alone. Recheck actual phone continuity
before input, including after approval waits. A deterministic input plus its
fresh returned observation may share one native call when supported. Later
actions depending on unseen state require another observation/decision. Preserve
real call IDs/order; never invent evidence or skip effect verification.

After owner confirmation that the phone is locked, one fresh visible Connect/Try
Again attempt may resolve a stale In Use banner; observe the result. Do not loop,
change accounts, alter permission policy or substitute another phone. The owner
retains the GUI slot against manual/other automation throughout the task.

Messages require exact sender/recipient/content and a genuine Send decision,
then one send and actual effect verification. Approval acknowledgement, terminal
prose or an empty composer do not prove delivery. Reconcile unknown outcomes.
Calls, camera/microphone, biometrics and account/security operations remain
unsupported.

The optional legacy `capability-publisher.mjs`/`preflight.mjs` path still requires
independently inspected action acceptance and fresh <=60-second observation. It
has no automatic producer and is not required for configured attempts. A shared
pre/input/post call ID requires inspected preOperationIndex/inputOperationIndex/
postOperationIndex order. No acceptance is created just because tests pass.

Synthetic Node/Swift checks prove policy only. Release acceptance requires actual
normal-worker pre/input/post evidence, a physical Watch request tied to the exact
task/device, verified effect and timed rehearsal. Settings followed by In Use
before Home remains partial acceptance. Tool spans include approval/broker/native/
return waits; residual time is not isolated model inference.
