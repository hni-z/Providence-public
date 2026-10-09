# How Providence was built

Providence has an authenticated coordinator, device companions and web, Watch and Quest clients. The coordinator routes requests to registered conversations and tracks task progress, approvals and output files. Each companion uses its computer's locally authenticated Codex runtime and connects outward over WebSocket.

## Technology stack

| Part | Implementation |
| --- | --- |
| Hosted coordinator | TypeScript on Node.js; HTTP APIs and WebSocket connections |
| Account sign-in | WebAuthn passkeys through SimpleWebAuthn; account and session records in SQLite |
| Workspace state | Atomic JSON files for conversations, tasks and results |
| Web client | React, TypeScript and Vite |
| Computer companion | Node.js, a local Codex app-server over stdio, and platform-specific install/startup/removal scripts |
| Voice | OpenAI live voice, transcription and speech APIs; optional ElevenLabs integration in the separate voice paths |
| iPhone | Swift, UIKit and WKWebView loading the shared hosted interface |
| Apple Watch | SwiftUI with a compact voice and task interface |
| Spatial view | Three.js, TypeScript and WebXR support for compatible browsers |
| Separate email backend | Express, the OpenAI SDK and Zod for transcription and validated email drafts |

## Request flow

1. A user signs in to Providence with a passkey and authorizes each computer during setup. Providence sign-in and the computer's Codex sign-in are separate.
2. A web, phone or Watch client submits text or a voice request. Voice input is transcribed or handled by the live voice session.
3. The hosted coordinator uses the account's OpenAI API key to interpret the request and choose a registered computer and conversation.
4. That computer's companion receives work over its authenticated outbound connection and uses the locally signed-in Codex runtime. Available tools and operating-system permissions determine which actions it can perform.
5. Task events, verified results and returned files reach the client through the coordinator. The spatial view presents this activity; it does not stream live desktop screens.

Providence's server owns account authentication, device authorization and dispatch. OpenAI supplies model services and the local Codex runtime. Using OpenAI does not transfer all of Providence's security responsibilities to OpenAI.

## Build and validation

Dependencies are recorded in the committed npm lockfiles. The web and spatial clients compile TypeScript and build static assets with Vite; Apple clients build through Xcode with the operator's own signing configuration.

`coordinator/scripts/build-release.mjs` stages a clean committed revision, installs locked dependencies, runs the required checks and tests, builds both frontends, and records their hashes in an immutable release manifest. `scripts/build-companion.py` creates an allowlisted companion archive and checksum manifest without credentials or local runtime state.

Before sharing source, create a history-free export and run the privacy checker and a secret scan on that export. Automated tests cover account isolation, authorization, routing, voice contracts and installer failure paths. They do not substitute for fresh installation, microphone, speaker or graphical-control checks on physical devices. See [the first-run guide](FIRST_RUN.md), [companion release checks](../install/README.md) and [Apple distribution requirements](../../iPhone/DISTRIBUTION.md).

## AI-assisted development

Codex and ChatGPT assisted with implementation, debugging, documentation and test work. The application's OpenAI integrations are separate from those development tools.

Private development conversations, prompt transcripts, internal handoffs and operational receipts are excluded from the showcase export. The model instructions used by the running application and synthetic test inputs are functional source code and are currently included; they are not a record of the private development chats.

## Task lifecycle

Request IDs prevent duplicate dispatch after an uncertain client submission. The coordinator tracks queued dependencies, cancellation, disconnects and restart interruption. Runtime permission requests remain associated with their task and expire when their turn or connection ends.

A completed model turn does not verify a file. Published artifacts are read from the allowed workspace, bounded to 512 KiB, hashed and copied into retained coordinator snapshots. Revision ordering prevents a late result from replacing a newer task's output.

## Persistence

The coordinator uses an atomic JSON store and supports one process per state directory. Device credentials, sessions, conversations and artifacts belong in private storage. A resumed provider thread retains its own conversation state; Providence's shared cross-chat context contains turns tracked by Providence.

A provably empty, never-executed provider conversation can be recreated after a restart. Imported or previously active conversations are not silently replaced.

## Components

- **Providence:** routing, context transfer, pairing, client interfaces, task state and artifact delivery.
- **Codex:** model reasoning, execution tools, runtime permissions and persistent provider conversations.
- **OpenAI or ElevenLabs APIs:** optional transcription and speech, configured independently.
- **HTTPS gateway:** an operator-managed proxy for browser and companion access. See [deployment](DEPLOYMENT.md).
- **Apple clients:** Watch and iPhone interfaces; native device control depends on separate tools and operating-system permissions.

See [runtime compatibility](RUNTIME_PROFILE.md), [Watch API](WATCH_API.md) and [desktop support](DESKTOP_PHONE.md) for implementation limits.
