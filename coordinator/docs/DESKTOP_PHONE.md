# Desktop and iPhone Mirroring

Phone execution requires a separately configured, verified Mirroring adapter and the device owner's permissions. The default queue does not execute phone actions. Real device observations, account state and screenshots belong outside the public source.

## Queue contract

`src/desktop/mirroring.ts` supplies a server-side `MirroringQueue`. Instantiate it once in the coordinator using a private file under the ignored data directory, the actual Mac device ID, and an optional independently tested `MirroringAdapter`.

```ts
const phone = new MirroringQueue({
  file: resolve(privateDirectory, "phone-requests.json"),
  macDeviceId: config.localDeviceId,
  onChange: (job) => store.event({ type: "phone.request.updated", job }),
});
```

The default has **no adapter**. Its capability is `unavailable`, `executable: false`, and queued requests are `needs_input` with `adapter_not_configured`. It cannot falsely complete a phone action.

When access is denied, the coordinator can set `unavailableReason: "permission_required"`. This remains non-executable; it reports the observed access blocker without pretending that locking the phone alone will enable product control.

- `capability()` exposes the exact target label **iPhone — via Mac**, parent Mac ID, readiness and limitations.
- `enqueue({requestId, url, sourceTaskId?})` saves a bounded HTTP(S) navigation request. Repeated identical request IDs return the original job; changed input with an old ID fails. Embedded URL credentials and other schemes are rejected.
- `list()` / `get(id)` return cloned records. The queue retains a maximum of 1,000 request identities and 20 unfinished jobs.
- `resume(id)` serializes with every operation using `desktopSerialQueue` on the same physical Mac. It always asks the adapter for a new observation. `phone_locked_required`, `phone_not_found`, authentication and permission blockers become `needs_input` with specific user guidance. Observation timestamps older than five seconds do not authorize input.
- `cancel(id)` aborts the adapter signal. Late completion cannot overwrite cancellation; a running operation may already have had an effect and must be inspected.
- A fresh, distinct post-action observation must contain the exact requested URL and nonempty verification evidence before the job becomes `completed`. A redirect to a different URL fails verification until explicitly supported with its own criteria.
- In-flight actions become `interrupted` after coordinator restart. They are never replayed automatically. Pending requests remain available for an explicit resume and fresh observation.

Keep all routes behind the coordinator's existing authentication and origin checks. A browser request must never be allowed to submit its own `PhoneObservation`, mark a task complete, configure an arbitrary adapter, or widen capability. A generic chat “yes” is not a resume instruction. Resume is specific to a displayed phone request and its unchanged URL; consequential operations require their own task-specific decision design beyond this URL-only interface.

Suggested integration routes are GET `/v1/phone`, POST `/v1/phone/requests`, GET `/v1/phone/requests/:id`, and POST `/v1/phone/requests/:id/resume` or `/cancel`. Route integration belongs to the coordinator owner; this module does not expose a second HTTP listener.

## Product adapter boundary and next proof

The development task's CUA permissions are not automatically Providence's permissions. A supported standalone integration must be separately authorized and exercised. Do not call undocumented Codex desktop internals, inject an existing desktop session's metadata, or copy its credentials.

Codex app-server supports explicit tools and configured MCP discovery. `scripts/desktop/probe-runtime.ts` uses the official `mcpServerStatus/list` method and prints only relevant tool names to inspect the standalone runtime without exposing credentials. Even a listed tool still needs a real execution test before advertising capability. [Official app-server protocol](https://learn.chatgpt.com/docs/app-server)

`scripts/desktop/probe-cua.ts` checks runtime tool availability. A listed tool or successful inventory request does not establish app permission or phone control. Verify the selected device and its actual permissions before enabling an adapter.

For a future native Mac helper, documented OS building blocks include [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit) for owner-selected app/window capture, [AXIsProcessTrusted](https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted) for Accessibility authorization, and [Core Graphics event posting](https://developer.apple.com/documentation/coregraphics/cgevent/post(tap:)) for input. These documents establish APIs, not working Mirroring automation in this prototype. The helper must have its own explicitly approved permissions, app allowlist, fresh observations, cancellation, and shared desktop lock. This development session uses CUA for live UI interaction, as required by its tool instructions; no alternate input helper was run.

After the physical connection is ready, the development proof is: observe the real phone, open Safari through Mirroring, navigate to `https://example.com/`, and observe the resulting page and URL. Record whether it was a development-tool proof or an actual Providence-origin request. Only the latter proves integrated product control.

## Tests

```sh
npx tsx --test src/desktop/mirroring.test.ts
npx tsx scripts/desktop/probe-runtime.ts
```

Seven queue tests cover disabled capability, durable request identity, locked-phone pause/resume, stale observations, independent output verification, cancellation versus late output, restart interruption, and per-desktop serialization. These use an explicitly mocked adapter. They do not prove macOS permissions, physical phone access, native input or integrated product execution.
