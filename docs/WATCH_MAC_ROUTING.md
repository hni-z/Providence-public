# Watch routing and pairing

The Watch can send requests to hosted coordination or a selected computer conversation. The hosted default uses the account’s transcription service; a deliberately locked target keeps its direct route. The separate email recorder/backend has its own configuration. Source support does not replace physical recording, playback and pairing checks.

## Hosted setup

A Watch build without a private configuration uses `https://providence.hani.so` with the account coordinator and `providence-voice` transcription route. Connect computers through [Account and devices](https://providence.hani.so/account), then choose **Pair an Apple Watch** there. No bundled device or chat ID is required for this default.

## Optional fixed target configuration

For an operator-configured computer conversation, use the helper below. It pins the hosted origin; using another origin requires updating both the helper and Watch origin validation. See [coordinator setup](../coordinator/README.md) for standalone instances.

In the authenticated workspace, confirm the chosen device's real hostname, online state and allowed workspace. Create one dedicated chat on that exact device. Record the returned device ID and chat ID; do not choose by a similar display name or assume `mac` refers to this computer.

Write the selected routing identifiers:

```sh
node scripts/configure-coordinator-watch.mjs REGISTERED_DEVICE_ID REGISTERED_CHAT_ID
```

The generated, ignored `WatchStarter/ProvidenceCoordinatorConfig.json` contains the canonical origin and two IDs. It contains no token. The app validates the canonical origin and ID syntax. Without this file, the Watch uses the hosted default described above. An absent email configuration does not disable computer requests.

## Pair the Watch client

Device enrollment and Watch client pairing are different operations. For hosted accounts, obtain a one-use **client** code from **Pair an Apple Watch** on the account page and confirm with an existing passkey. On a standalone coordinator, an authorized owner uses `/v1/clients/pair`. Enter the `XXXX-XXXX-XXXX` code in the Watch’s client-pairing field and choose **Pair Watch**. This uses `/client/exchange`; the returned token is stored in the Watch Keychain with ThisDeviceOnly accessibility. It is not stored in UserDefaults, bundled source, URLs or logs. The Watch pairing field accepts a nonempty code up to 50 characters, so this server-side format requires no SwiftUI change. Expired/rejected credentials require a new client code.

The existing email flow still needs its ignored `ProvidenceConfig.json` containing its original service's endpoint/demo credential. Neither Watch configuration should contain an OpenAI API key.

## Request and recovery behavior

- In hosted coordination mode, the app posts to `/v1/messages` and verifies the returned `master` chat and `coordinator` device identities. The coordinator routes work to registered computers.
- A direct computer request reconciles its selected device/chat online, posts to `/v1/chats/:chatId/messages`, and verifies those exact response identities. A locked target cannot silently fall back to the master or another computer. A retry keeps its originally saved route.
- The request UUID, exact text and selected route are saved on the Watch before the first POST. An uncertain POST exposes an explicit same-request retry. It cannot silently generate another UUID or change the target/text.
- Once a task ID is known, refresh performs GETs only. In-flight work and scheduled polling are cancelled/invalidated when the screen becomes inactive; returning refreshes existing task status rather than resubmitting.
- Command/file approvals display their complete details. An explicit choice refetches the task and briefing and must still match the exact displayed approval ID, method, details, task and device. Other approval forms stay in the existing full workspace UI.
- A completed Codex turn is displayed as a reported result. Verify actual files/browser state separately when testing device actions. A terminal task can be cleared with **New request** for an intentional new request.

## Validation and release boundaries

The native adapter's synthetic tests and the app's pure routing/approval contracts cover request identity, exact-host binding, error handling and stale/mismatched approvals. Xcode builds must include this local Swift package. Hardware dictation, pairing, interruptions and hosted Watch-to-Mac execution remain physical acceptance items.

For distribution, configure the intended origin and any optional fixed target, increment both distribution build numbers together and follow [DISTRIBUTION.md](../DISTRIBUTION.md). Verify the installed app on the physical Watch.

## First complete acceptance

1. Verify one target host/chat online in the workspace.
2. From that workspace, request a harmless browser task such as opening a new `https://example.com/` tab; observe the actual tab and returned result on the selected computer.
3. Pair the Watch with a client code, dictate the same bounded request, review/send, and verify the exact device/chat task and observed browser result.
4. Exercise interruption/reopen and same-request retry without another action being created. Test an explicit approval/decline and reject stale approval identity.
5. Separately record and review an email to the chosen test inbox; the user submits it once and observes delivery independently.
6. On the actual Quest, open `YOUR_HTTPS_ORIGIN/quest/`, log in and select the same verified conversation. Its browser microphone/transcription/review path requires a configured online transcription device. The web client is a remote control surface; installed Quest-game launching remains a separate, unproved native capability.
