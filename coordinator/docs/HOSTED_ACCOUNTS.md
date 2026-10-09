# Hosted accounts

The hosted service uses passkeys for Providence sign-in. Each account has its own coordinator state, registered computers, client grants, conversations and artifacts. Users enter their OpenAI API key in a hidden terminal prompt, never in Providence's browser page. The terminal transmits the key over HTTPS to the hosted service, which encrypts it using AES-256-GCM with the account ID as authenticated data. The encryption key belongs in a private file outside the source tree. This is encrypted server storage, not a local-only key arrangement: users must trust the Providence server with their key.

Computers retain their own Codex sign-in. Their outbound companion connection is authenticated separately from browser or Watch sessions. New installations default to full access after one explicit local connection confirmation; they do not prompt for each task. Full access is accepted only when the installed Codex runtime advertises that permission profile. Native app, browser and operating-system controls continue to apply. Existing installations keep their saved access mode.

## Account changes and recovery

Before the first hosted AI request, each account explicitly accepts the current AI-processing notice in Account. This is separate from device authorization and microphone permission. It applies once to future requests, including paired Watch controllers; it is not a per-task approval. Account setup, device enrollment, reads and cancellation remain usable before acceptance. The public `/privacy` page describes active data handling.

**Clear all chats** clears Providence conversation history and hosted model context while keeping account/device credentials. It refuses active work or pending decisions and keeps content-free request hashes so stale browser retries cannot replay deleted tasks. **Delete account** requires a fresh passkey assertion for the current account, revokes access immediately, then removes active hosted account data. Failed cleanup remains revoked and is retried after restart; the UI reports cleanup pending. It does not revoke the external OpenAI API key or remove files/Codex threads on connected computers.


Adding a passkey, approving terminal setup and issuing a device or controller pairing code require a fresh assertion from a passkey already registered to the account. The resulting proof expires after five minutes, works once, and is bound to the signed-in session, account, operation and target. This protects enrollment; it does not change task permissions or enable per-task approval prompts.

Account security lists passkeys and active browser/controller sign-ins. Removing a sign-in rejects its future requests and closes its existing gateway connections. Removing a passkey requires verification with a different retained passkey and signs out other browsers/controllers. At least one passkey must remain. **Sign out everywhere and stop work** revokes all account sign-ins and pending grants, and begins stopping the hosted workspace. Work already sent to a computer may require local inspection; earlier file changes or other effects are not undone.

These are Providence account controls. They do not turn a Providence connection into an OpenAI Remote connection. The hosted server remains trusted to dispatch work, and local Codex sign-in alone is not remote-controller authorization.

## Server

Use Node.js 22.16 or newer. Build the web client, then configure:

- `PROVIDENCE_PUBLIC_ORIGIN`: the exact HTTPS origin used for passkeys and browser requests.
- `PROVIDENCE_HOSTED_DATA_DIR`: private account database and per-account state directory.
- `PROVIDENCE_ACCOUNT_KEY_FILE`: a private file containing exactly 32 random bytes. Keep a secure backup; losing it prevents decryption of saved API keys.
- `PROVIDENCE_HOSTED_MODEL`: optional coordination model, default `gpt-6-sol`.
- `PROVIDENCE_APPLE_APP_IDS`: optional comma-separated, exact signed Apple application identifiers for native passkeys; see below. Leave unset until the intended signing identities are verified.
- `PORT`: loopback listener, default `8788`.

Run `npm run hosted` from `coordinator/` behind an HTTPS reverse proxy. Forward WebSocket upgrades, overwrite `X-Real-IP` at the trusted local proxy and preserve Origin. Do not expose the loopback tenant listeners.

The hosted coordinator uses Responses API function calls with explicit low reasoning and Fast processing (`reasoning: { effort: "low" }`, `service_tier: "fast"`). `PROVIDENCE_HOSTED_MODEL` preserves an explicit model selection; there is no silent fallback. This API-funded profile is separate from the companion's subscription-authenticated `gpt-6-sol` / `low` / `priority` profile and its per-device overrides. The [runtime profile guide](RUNTIME_PROFILE.md) records the six-request synthetic comparison behind this choice and its limits; it is not a general accuracy or desktop-control benchmark.

The hosted coordinator has no host execution tools and never starts a local Codex worker. Tenant HTTP servers listen only on dynamically assigned loopback ports and independently enforce their workspace credentials. Public routing uses verified account sessions or indexed device credentials, never a caller-selected account ID.

The initial service supports one server process, up to 1,000 accounts and 32 loaded workspaces. Passkey challenges, sessions, account keys and device routing indexes persist in SQLite; pairing codes expire after ten minutes and are single-use. Browser sessions last seven days. Watch client sessions last thirty days and can be revoked from their account's workspace. This is an initial hosted version, not a horizontally scaled deployment.

## Native Apple passkey association

Set `PROVIDENCE_APPLE_APP_IDS` only to the exact application identifiers of signed apps that should be trusted for the hosted domain. Each value has the form `<Application Identifier Prefix>.<Bundle Identifier>`, for example `ABCDE12345.com.example.Providence` (illustrative only). Take the value from the signed app's `application-identifier` entitlement; do not assume its prefix from a display name or substitute a different signing team. Multiple explicit IDs may be comma-separated. Wildcards, malformed identifiers and empty entries in a nonempty list fail server startup before hosted state is created.

When configured, both `/.well-known/apple-app-site-association` and `/apple-app-site-association` serve `{"webcredentials":{"apps":[...]}}` directly without authentication or redirects. GET returns JSON; HEAD returns the same representation headers with no body. The document has a five-minute public cache lifetime. When unset or empty, both paths return 404 with `no-store`; there is no built-in trusted app identity.

The native app must separately include the matching `webcredentials:<host>` Associated Domains entitlement for the passkey relying-party domain. Each entitled domain needs its own directly served HTTPS association file; a redirecting alias does not substitute for it. Apple caches domain associations, so publishing this file alone does not prove that an installed app can sign in. Verify the signed entitlement and native passkey flow on the intended device. See [Apple's associated-domains documentation](https://developer.apple.com/documentation/xcode/supporting-associated-domains) and [passkey integration guidance](https://developer.apple.com/documentation/authenticationservices/connecting-to-a-service-with-passkeys).

## Computer installation

The hosted workspace’s **Devices** navigation opens `/account#devices`. Run the command shown there on each computer to install the companion and start guided setup. Hosted accounts do not use the older self-hosted pairing-code bootstrap. Use the canonical hosted origin, not a redirecting alias.

macOS or Linux:

```sh
curl --proto '=https' --tlsv1.2 -fsS https://providence.hani.so/install.sh | sh
```

Windows PowerShell:

```powershell
& ([scriptblock]::Create((irm -MaximumRedirection 0 https://providence.hani.so/install.ps1)))
```

Initial setup checks the local Codex sign-in, asks for a recognizable computer name, uses `~/ProvidenceWorkspace` as the starting folder, then asks for confirmation to connect with full access. The starting folder is a working directory, not a permission boundary. Advanced first setup can supply `--workspace-folder PATH` (or PowerShell `-WorkspaceFolder PATH`). Declining the connection stops before browser approval, key changes or registration. A developer running `node scripts/connect.mjs --workspace` can select workspace access instead; that mode still asks for the folder unless one was supplied. `--full-access` remains supported and matches the new-install default. These options do not change an existing installation's saved scope or folder.

Setup then starts a short-lived request and shows a comparison code. Sign in with a passkey on the browser page it opens, compare the displayed code with the terminal, and explicitly approve that terminal. Opening the link or signing in does not approve a request. Local Codex sign-in and Providence pairing are separate authorizations. A link from someone else's terminal must not be approved.

Return to the terminal to confirm the account identity and enter an OpenAI API key if the account needs one. The key prompt does not echo its input; pressing Enter submits it. One API key supports hosted coordination and voice for the account. Each computer retains its own Codex authentication. A subscription sign-in and API billing are separate. An already linked computer resumes with its saved configuration. A confirmed running helper or a declined update does not repeat Codex sign-in; a helper that needs starting checks its retained Codex binary/profile first. Repeating the command does not grant additional access.

To replace the hosted key from an already configured computer, use the same installer in key configuration mode:

```sh
curl --proto '=https' --tlsv1.2 -fsS https://providence.hani.so/install.sh | sh -s -- --configure-key
```

```powershell
& ([scriptblock]::Create((irm -MaximumRedirection 0 https://providence.hani.so/install.ps1))) -ConfigureKey
```

This mode asks for browser authorization and account confirmation, then updates the account key without re-pairing the computer or starting the companion. The account page shows whether a key is configured and allows its removal, but has no key input. Refresh the account page after terminal setup to see the new state.

After setup, the terminal asks whether to run Providence in the background and start it at login. Accepting installs a helper for the current user: a LaunchAgent on macOS, a user service on Linux with systemd, or a Startup-folder launcher on Windows. Once the helper starts, the terminal can close. If the user declines or the platform cannot run that helper, setup explains the foreground alternative. Existing enrollment and access are preserved on repeat runs; the helper checks for an existing managed process to avoid duplicates.

Keep awake is a separate opt-in during terminal setup. On supported systems it blocks automatic idle sleep only during active Providence use or running tasks, then releases when idle. Merely leaving the companion running in the background does not hold a sleep inhibitor. The browser reports activity only while visible, focused and recently used; passive polling and programmatic chat scrolling do not refresh it. Hiding, leaving or closing the page sends an inactive signal, and expired or disconnected activity leases release the request after the bounded grace period. Running tasks can hold their own activity lease independently of the browser.

This feature does not change screen-lock or display-sleep settings. The Linux `logind-idle` method blocks logind's automatic idle action only; a desktop environment's separate power policy can still suspend the computer. Keep awake does not override manual sleep, closing the lid, shutdown or low-battery sleep, and does not unlock the computer. Desktop interaction can still require the user's unlocked session. The account page shows **Keep awake on** only when the device reports the helper active. **Keep awake idle** means normal sleep is allowed while waiting for use or a task; unsupported or unconfirmed activation shows **Keep awake unavailable** with a safe explanation. **Normal sleep settings** means the preference is disabled. A missing status is not treated as active, and the server marks offline devices inactive to avoid showing a stale assertion as current.

Keep the computer awake, online and signed in for remote work. The helper does not bypass authentication failures or required owner actions. The account page's **Your computers** list and **Refresh** button report coordinator-observed readiness: **Online** requires the companion's ready acknowledgement, not merely registration or a started background process. The displayed **Full access** or **Workspace access** is the device's reported profile. Browser and desktop checks are **not verified** unless the service has a scoped verification record; a false capability flag alone is not proof that a tool is unavailable.

The companion starts its own Codex app-server with the tools available to that local runtime. It does not use ChatGPT Remote pairing to connect to Providence. **Full access** controls file and shell permissions; native GUI work also requires an available control tool and the owner's OS/app permissions. Verify a harmless graphical action on the selected computer. Linux and Raspberry Pi GUI work also requires a graphical session.

Follow [the Remote and Computer Use steps in the first-run guide](FIRST_RUN.md#chatgpt-remote-and-computer-use): host-side **Settings → Connections** allows control of that host, while the controlling device uses **Control other devices**. Computer Use has separate plugin server/skill switches and OS/app permissions on each graphical host. These controls are not a Providence integration by themselves. See the official [Remote](https://learn.chatgpt.com/docs/remote-connections) and [Computer Use](https://learn.chatgpt.com/docs/computer-use) instructions.

## Windows uninstall

In PowerShell on the computer you want to remove, load the saved entry into a child PowerShell before it removes its own files:

```powershell
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -Command '$ErrorActionPreference=''Stop''; & ([scriptblock]::Create([IO.File]::ReadAllText((Join-Path ([Environment]::GetFolderPath(''UserProfile'')) ''.providence\companion\uninstall.ps1'')))); exit $LASTEXITCODE'
```

Read the normal confirmation. The command reports completion only after cleanup; it preserves workspaces, source checkouts and existing Codex sign-in. It does not change PowerShell execution policy. See [the first-run guide](FIRST_RUN.md#check-that-you-can-disconnect) for removal and revocation details on each platform.

## Companion release archive

From the repository root, create a fresh archive:

```sh
python3 scripts/build-companion.py /path/to/new/providence-companion.zip
```

The builder also writes `providence-companion.tar.gz` and `companion-manifest.json`. Publish both archives under `downloads/<version>/` in the hosted data directory, using the manifest's content-derived version and fixed filenames. Publish the manifest at `downloads/companion-manifest.json` after both immutable archives are available. The manifest includes the archive hashes and pinned runtime versions. The allowlisted package contains source, local helper scripts and package locks, without credentials, `.git`, local state or dependencies.

The installer consumes this archive. The private companion configuration is stored outside the workspace under the user's `.providence/companion` directory. It contains the device credential and must not be copied into source control or shared.

## Watch

A build without an operator-specific configuration defaults to the hosted origin and account coordinator. Pair it using **Pair an Apple Watch** on the account page. Default voice requests go to hosted coordination; a deliberately locked computer conversation retains its direct route. Transcription uses the account's hosted OpenAI voice service.

The Watch is a client for controlling connected computers. This does not enable arbitrary execution on watchOS or iOS. Install the Watch app through Xcode for now; the computer command cannot install it. An existing paired iPhone app does not need replacement just to reinstall the Watch app. App installation, passkey creation and physical microphone/speaker checks are separate from automated source tests.

iPhone, iPad and Quest can use a browser or an available Providence client as controllers. They are not computer companion targets, and signing in does not grant full operating-system or arbitrary app control on those devices.

## Checks

```sh
npm run check
npm test
npm --prefix web run build
```

The hosted tests verify actual passkey signatures, origin and challenge checks, session expiry, encryption binding, account isolation and the absence of a local execution worker. No test uses a live provider key.

The local companion manager accepts `awake-on` and `awake-off` to change this preference without restarting tasks. A running companion reads the updated setting; the account page reports whether the operating system actually holds the request. Turning the preference on does not prevent sleep during inactivity. The browser stops renewing after two minutes without input, or immediately on blur/hide/exit, and server/device leases expire automatically. Completed or unanswered approval-only tasks do not keep a machine awake indefinitely.
