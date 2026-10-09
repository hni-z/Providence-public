# Proposed mirroring adapter contract

This design contract describes requirements for a Mirroring adapter; it does not establish physical-phone execution. Do not register an adapter or mark it executable without target-specific verification. See [the current typed-route contract](../iphone-mirroring/CONTRACT.md) for the coordinator integration.

## Binding and capability

Every immutable request must contain `requestId`, selected `macDeviceId`, a trusted mirrored-iPhone binding, the exact action and its arguments. A caller-supplied phone name or the current Mac configuration alone is not sufficient identity proof. If the supported tool cannot supply a reliable fresh phone binding, execution must remain unavailable.

A fresh capability observation must report the selected and observed Mac/phone identities, tool/session identity, observation time, evidence reference, `executable`, and only the specific phone actions independently proved through that tool. Missing identity, unavailable phone, changed session or unsupported action must yield `executable: false` for the request. A recorded capability snapshot cannot authorize later input.

Opening Mirroring, selecting Connect or reaching an owner-unlock prompt does not prove control of the phone. These host-app operations must not be advertised as `safari.open_url` or general phone control. A successful example.com test proves only that scoped action, not arbitrary Safari destinations or other apps.

## Dispatch, cancellation and uncertain outcomes

Serialize observation and input with other operations on the same selected physical Mac. Recheck target identity, tool/session continuity and action-specific execution capability immediately before input. Reject changed Mac, changed phone, stale observation and unavailable capability without dispatch.

Persist request identity and a dispatch-intent record before input. Keep cancellation intent separately from outcome: `not_executed`, `confirmed`, or `unknown`. Cancellation before dispatch produces no input; cancellation after dispatch, lost acknowledgement, timeout or process restart cannot prove no effect. Retain any late observation as evidence without silently converting cancellation into success.

Never replay a dispatched or uncertain request automatically. Repeating its request ID returns its saved result or uncertainty; changing its target/action/arguments under the same ID is rejected. A fresh worker result must independently match requested and observed device identities, the supported action and its exact verification criteria. Expected page text or worker prose without tool evidence is insufficient.

## Focused tests required with a real implementation

An executor must cover the cases below. Synthetic tests verify safeguards only; they do not establish physical device access.

| Case | Required assertion |
| --- | --- |
| Unsupported action | Empty supported-action set or mismatched action causes zero input calls. |
| Unavailable phone | No connection or no reliable identity causes zero input calls. |
| Changed target | Changed selected or observed Mac, phone, or tool session rejects the request before input, including persisted jobs reopened with a different configuration. |
| Stale capability | A fresh action-specific capability check is mandatory immediately before input. |
| Lost acknowledgement | Dispatch once, retain unknown outcome, and never replay after repeated request or restart. |
| Cancellation before dispatch | Zero input calls and explicit not-executed outcome. |
| Cancellation after dispatch | Cancellation intent remains visible; outcome remains unknown unless direct evidence resolves it. |
| Verification mismatch | Wrong URL, heading, device, session, or missing evidence cannot become confirmed success. |

## Integration requirements

An adapter must carry the physical phone identity through admission, persistence and execution. Adapter presence alone cannot establish executability. Resuming a saved request must revalidate its selected Mac and phone rather than substituting the current configuration. Post-dispatch errors and cancellation must preserve uncertain outcomes and any later evidence.

Keep phone execution unavailable when the required binding, tools, permissions or action-specific verification are missing. Preserve the Watch target checks and validated Mac route when integrating an executor.
