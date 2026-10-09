# Voice acceptance tests

Synthetic regression tests for the email backend, Watch transport and voice routing. Physical device acceptance is separate; see [the physical checklist](PHYSICAL_CHECKLIST.md). A passing synthetic test does not verify live recording, playback or delivery.

## Run from the repository root

Requirements: Node 22+ with npm; macOS Swift toolchain for `baseline`/`all`. No application configuration or credentials are required.

```sh
node voice-demo-validation/run.mjs --suite baseline --offline
node voice-demo-validation/run.mjs --suite voice --offline
node voice-demo-validation/run.mjs --suite all --offline
```

`--offline` uses the npm cache and fails if a locked dependency is missing. Omit it only to permit the **dependency installation** to use the registry. The tests do not use live providers. No application is started on a public interface.

- `baseline`: backend checks and regressions, Swift adapter and direct-route transport tests, current and pinned legacy decoding. When the Watch voice module is present, also runs its pure contracts, routing cases, clarification recovery and non-Mac target rejection.
- `voice`: email/recipient acceptance cases and harness typechecking. This does not test the Watch UI.
- `all` (default): both, and requires the Watch voice contract module/tests to exist. A nonzero exit is a failed check, not release acceptance.

The runner copies allowlisted source/test paths to a new OS temporary directory, installs pinned npm dependencies there with lifecycle scripts disabled, and compiles/runs those copies. It does not modify product source, `.env`, private contact files, configuration, build numbers, or another worktree. Every copied input gets a SHA-256 in `report.json`. The terminal prints the report and full log paths; keep them for local diagnosis or remove that specific temporary directory when finished. Synthetic data only is written there. Dependencies require disk space and the first Swift build can take a minute.

To test another checkout read-only, add `--source /absolute/product/worktree`. Test definitions still come from this package. The report records that source's HEAD, dirty state and copied-file hashes. A working-tree result is provisional until rechecked on the committed/integrated revision.

`backend.acceptance.test.ts` imports actual `createApp` and `validateDraftOutput`. Its Responses API fixture intercepts the actual SDK fetch in memory, exercising the SDK/parser and recipient safeguards with deliberately fallible provider output. Non-loopback network calls are rejected except that in-memory fixture. Apple Mail is always injected. No transcript model quality, real transcription, Mail configuration or delivery is inferred. The optional `Config.contactsFile` seam points exclusively to a new temporary file; a fresh app instance with an empty in-memory contact list proves that a remembered alias came from that file.

The Swift harness injects `HTTPTransport`, compiles actual `MacControlModels.swift`, and uses the package's production client. A Codable roundtrip proves only the saved request value format. Native dictation cancellation, UserDefaults/Keychain restoration, and real foreground/background behavior need lifecycle tests and the physical checklist. No replacement UI/router/state machine is implemented here.

Cross-contract gates deliberately include a `ready` question **without a draft**: it must remain answerable through the actual Watch clarification API while approval/remembering stay blocked. The target gate must reject explicit non-Mac destinations before dispatch; quoted device names, topics and email body content are different. Passing its pure function tests does not prove the UI invoked it, so dispatch callsites and physical zero-dispatch observations are separately recorded. This legacy configured-Mac target test is separate from current multi-device routing; it does not verify the coordinator’s device selection.

## Reproduce one failing backend case

After a runner invocation prints its temporary directory, run the following with that exact path (synthetic sandbox only):

```sh
cd /path/printed/by/the/runner
PROVIDENCE_ACCEPTANCE_SUITE=voice backend/node_modules/.bin/tsx --test --test-name-pattern='V04' voice-demo-validation/backend.acceptance.test.ts
```

Use `E03`, `E05`, `E11`, `E12`, or another case ID to isolate a gap. This runs copied source; run the main runner again after integration to capture fresh product source. Do not reuse a passing report from another commit as release evidence.

## Compatibility and integration boundaries

Existing audio, development text (when enabled), GET/PATCH, exact approval and journal semantics must remain. `voice-text` is independently enabled in production. `clarification` and `contactProposal` are additive optional fields: the runner compiles the original `c081b34` build-2 decoder against additive fixtures, as well as the current decoder. That proves JSON decoding, not installed-build or feature compatibility. Keep status/source/required Job types stable and do not make old clients send new required fields.

The backend may safely roll out additive endpoints before the new Watch. Do not release a Watch that calls missing endpoints: a 404/530/auth/provider failure must remain an actionable failure and must not trigger a new-ID resend or fallback to a different Mac. Short pairing codes retain the existing exchange/token format. Standalone client sessions default to 24 hours; hosted accounts use 30 days. Existing grants keep their recorded expiry. See [the client API contract](../coordinator/docs/WATCH_API.md) and the coordinator’s session tests. This test package does not issue pairing codes.

Before release, run `all`, Watch routing/lifecycle tests, unsigned simulator/device builds, backend tests and coordinator pairing tests on the same source revision. Deployment, signing, installation, physical execution and email delivery require their own checks.
