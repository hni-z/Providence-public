# Providence coordinator

The coordinator connects the web, Watch and Quest interfaces to authorized device companions. It tracks conversations, tasks, approvals and output artifacts. Each host uses its own configured Codex runtime and permissions.

For the hosted service, start with [the two-computer setup guide](docs/FIRST_RUN.md). Providence uses [passkey accounts](docs/HOSTED_ACCOUNTS.md) and separate state for each user. The instructions below run your own single-user coordinator with a private workspace key. See [self-hosting](docs/DEPLOYMENT.md) for HTTPS deployment.

## Web prototype

```sh
cd coordinator
npm ci
npm --prefix web ci
npm run build:web
npm run setup
npm start
```

Open `http://127.0.0.1:8787` on the coordinator Mac. Sign in using `clientToken` from the local, ignored `.providence/config.json`. This access key authorizes the workspace; keep it private. The frontend stores it only for the browser session. Conversation/task state lives on the coordinator and survives a refresh.

For other computers and phone browsers, expose the service through HTTPS/WSS and set `PROVIDENCE_PUBLIC_ORIGIN` to that **exact HTTPS origin** when starting the coordinator. Same-origin browser requests are allowed; other origins are rejected, and API authentication remains required. A temporary demo tunnel can be started with `cloudflared tunnel --url http://127.0.0.1:8787`; its random URL changes when the tunnel restarts. Configure a stable authenticated endpoint for continued use. Do not use venue-wide plaintext transport.

To use an existing state directory, set `PROVIDENCE_DATA_DIR` to the private state directory before launch. Do not run two coordinators against that directory. Local configuration and account credentials are not stored in Git.

On the hosted service, **Connect device** opens `/account` and the current guided installer. For your own coordinator, **Connect device** still creates a one-use, ten-minute pairing code; provide the target computer's owner with a compatible companion and your coordinator's HTTPS/WSS address. The public installer connects to `providence.hani.so`, not an arbitrary self-hosted server. Each computer retains its own Codex login. Device revocation invalidates its credential and disconnects it. Omitted companion `workerAccess` defaults to `workspace`; `full-access` is an explicit trusted-controller setting.

Providence's companion is separate from ChatGPT Remote and does not automatically attach to it. Full access grants file/command permissions; native browser and desktop tools require their own integration. Follow [the first-run Remote and Computer Use steps](docs/FIRST_RUN.md#chatgpt-remote-and-computer-use) for the host/controller connection settings, host plugin toggles, and operating-system permissions. Enabling those settings alone does not prove Providence GUI control. Official references: [Remote](https://learn.chatgpt.com/docs/remote-connections) and [Computer Use](https://learn.chatgpt.com/docs/computer-use).

### Implemented scope

- Main and direct conversations, names, workspace/purpose association and registered supported Codex threads.
- Explicit labelled cross-chat context from Providence-tracked turns; imported pre-registration history is not advertised as shared context.
- Authenticated outbound companions, actual connection status, conservative capability declarations, reconnect handling and duplicate-request protection.
- Scoped decisions, stop/cancel and revision-safe file delivery. Files are verified in the device workspace, limited to 512 KiB each, hashed and retained as immutable snapshots.
- Explicit MCP form decisions and requested-only file/network permission grants. Provider request IDs and resolution notifications expire stale prompts; unsupported extended forms cannot be accepted. These protocol handlers do not themselves grant native app access.
- Provider-advertised session/always choices for supported empty approval forms, with one-time behavior as the default. Only advertised, explicitly selected scope is forwarded.
- Browser/desktop capability evidence tied to independently verified, completed device tasks. Evidence describes its exact observed scope and still requires app permission; it is not a grant for all apps. Unverified devices and phone control remain unverified.
- An iPhone — via Mac request queue that reports the current permission blocker. Integrated phone execution and arbitrary desktop/browser control are **not verified or enabled**; see [desktop and phone evidence](docs/DESKTOP_PHONE.md).

[Two-minute demo](docs/DEMO.md) · [Engineering and attribution](docs/ENGINEERING.md)

A Codex **master conversation** routes user requests to persistent conversations on registered devices. Each client uses the same coordinator API.

## Quick start on the coordinator Mac

Requires Node 22+, npm and a signed-in Codex CLI. The bundled Mac app binary is detected automatically; otherwise set `CODEX_BIN` to the actual executable.

```sh
cd coordinator
npm ci
codex login                     # if not already signed in; each person uses their own account
npm run setup
npm start
```

If `codex` isn't on PATH on this Mac, use `/Applications/ChatGPT.app/Contents/Resources/codex login status`. The coordinator automatically finds that executable. It starts at `http://127.0.0.1:8787`.

`npm run setup` creates ignored `.providence/config.json` with a random **clientToken**, local device name/id and workspace. It does not print credentials. Initial execution is restricted to the configured workspace, default `.providence/workspace`. Change that path to a folder you deliberately want this agent to work in, then restart. Set `workerAccess: "full-access"` only for a deliberately trusted controller; the master has a separate read-only working directory.

This prototype uses local Codex authentication for both the master and workers. It does **not** convert a Pro subscription into an OpenAI API key. Each device keeps its own credentials; do not copy auth.json or share account logins. Optional voice routes use separate provider API credentials; see [voice configuration](docs/ELEVENLABS_VOICE.md).

## Watch interface

To talk to the running master from this computer, use `npm run ask -- "What devices and chats can you use?"`. Follow-up commands continue the same master conversation. To create your first task: `npm run ask -- "Create a chat called Demo on mac and ask it to create checklist.txt containing a short packing checklist."`

See [WATCH_API.md](docs/WATCH_API.md). Send transcribed **text**, not audio, to `POST /v1/messages`, then poll the returned task. Optional transcription and reply speech use separate authenticated endpoints and private provider configuration. Current web/Quest source supports independently selected OpenAI or ElevenLabs input/output; [input and output configuration is documented here](docs/ELEVENLABS_VOICE.md). This client/server support does not establish native Watch dictation or playback integration; Watch packaging and push notifications remain separate work.

All `/v1` endpoints require `Authorization: Bearer <clientToken>`. Provision this token privately into the development client. Never hardcode it in committed Swift or commit `.providence`. The public health endpoint contains no user data. The built React client is served by this same process; browser requests must match loopback or the configured exact public origin. CORS is not opened to arbitrary origins.

The default loopback address is **not reachable from a physical Watch/phone/Windows PC**. Put the coordinator behind an authenticated HTTPS/WSS endpoint you control (or private VPN with TLS) before remote use. Only after securing that transport, bind the service to the intended interface with `HOST`/`PORT`. A fresh checkout does not start a public tunnel.

## Add Windows, another Mac, or Linux

On the coordinator:

```sh
npm run setup -- --device windows
```

This adds a separate device credential and writes ignored `.providence/windows.device.json`. Set its URL to your coordinator's `wss://.../worker`. Transfer **only that device file** privately to its owner, not the coordinator client token or Codex credentials. Restart the coordinator to load the enrollment.

On the other computer:

1. Clone this branch; install Node 22+ and the official Codex CLI; run `codex login` with that device owner's account.
2. `cd coordinator` and `npm ci`.
3. Edit `workspace` in the private device JSON to an existing/new local project directory that this computer may work in.
4. If needed, set `CODEX_BIN` to its Codex executable. On Windows use the real **codex.exe**, not a `.cmd` wrapper; the desktop/CLI distribution must provide it. The wrapper intentionally does not shell-evaluate arbitrary executable strings.
5. Run `npm run device -- /path/to/windows.device.json` (use the Windows path on Windows).

The companion makes an **outbound** authenticated WebSocket connection. No incoming app-server port is exposed on the worker. An offline connection is reported; interrupted jobs are not replayed automatically. On disconnect the companion shuts down its runtime and reconnects, retaining durable thread history. External subprocess side effects may already have occurred; inspect before resubmitting an interrupted job.

For an explicitly trusted private-network demo only, the worker can accept plaintext WS with `PROVIDENCE_ALLOW_PLAINTEXT=1`. Do not use that on an untrusted venue network. The code does not disable certificate verification.

## Conversations and execution

- `POST /v1/chats` creates a persistent conversation on the specified device.
- Register an existing supported Codex conversation using the optional `threadId`. Its actual cwd must be within the companion's configured workspace. Consumer ChatGPT chat import and automatic desktop-plugin inheritance are not promised.
- The worker resumes the provider thread on follow-ups. Providence's cross-chat context currently includes only the recent turns **tracked by Providence**; pre-import history is not fetched into context summaries yet. The worker itself retains its Codex history.
- The master has tools to list devices/chats, read tracked context, create a chat, dispatch, inspect/wait for tasks, brief recent work, and cancel. It cannot approve its own operations.
- Context transfers include source chat IDs and a real event in `/v1/events`.
- User decisions are resolved only through `POST /v1/approvals/:id`; approval IDs expire with their turn/connection. Do not turn every “yes” into accept. Present the specific action and decision ID in the client.
- That endpoint accepts exactly one of legacy `decision`, question `answers`, or a typed `response`. MCP responses use `{kind:"elicitation",action:"accept"|"decline"|"cancel",content?,_meta?}`; file/network responses use `{kind:"permissions",permissions,scope:"turn"|"session"}`. Permission grants must be a subset of the exact request, preserving exclusions; an empty permission object denies the request. No extended-form capability is advertised. User verification and native Computer Use permissions are not interchangeable with filesystem/network approval.
- Each provider turn's `completed` status means **the turn ended successfully**, not independently verified external side effects. The smoke tests independently verify their files. The web prototype now verifies bounded file artifacts separately and exposes their hashes and revisions.
- The initial execution capability is the CLI's supported tools within the configured workspace. This is not arbitrary GUI control of every desktop, a phone OS controller, or a wake-from-sleep service.

## Checks

```sh
npm run check
npm run build:web
npm test
npm run smoke          # consumes local signed-in Codex usage; server must be running
npm run smoke:remote   # real second companion on this same computer, not a Windows test
```

`smoke` creates an isolated file, retries the same request without duplicate execution, continues its conversation, then asks the real master to dispatch a further change. `smoke:remote` starts a separate runtime over WebSocket and verifies context transfer, actual file output and disconnect behaviour. Test data and credentials stay under ignored `.providence/`.

`npm run demo:fixture` starts a local coordinator on loopback with both devices online, so the demonstration sequence can be rehearsed and recorded in a browser.
It answers every turn from a scripted fake runtime inside temporary directories, and it never reads `.providence` or starts Codex.
Build the web client with `npm run build:web` first, or the fixture refuses to start.

Persistence is an atomic local JSON store for this single-coordinator prototype. Do not run two coordinators against one data directory. Event history is capped at 1,000 entries; clients should refresh task snapshots after reconnecting. If the coordinator restarts, unfinished jobs become `interrupted` and pending approvals expire rather than silently being executed again.

## Sources and compatibility

- [Official app-server protocol](https://learn.chatgpt.com/docs/app-server)
- [Official Codex authentication](https://learn.chatgpt.com/docs/auth)

Developed against local `codex-cli 0.155.0-alpha.2.6`; the [runtime profile](docs/RUNTIME_PROFILE.md) was validated against `0.155.0-alpha.9.2`. An older CLI may not advertise the `priority` service tier, and the profile fails with an explicit error rather than falling back. Dynamic tools are experimental; update the adapter against the installed CLI schema if that protocol changes. Existing desktop chats/tools are not automatically the same runtime as this standalone app-server.
