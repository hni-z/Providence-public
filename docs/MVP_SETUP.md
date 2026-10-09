# Run the email backend

## 1. Open the source

Use a checkout or source export of this project. Run the commands below from its root directory.

Requirements: Node.js 22 or newer (24 tested), npm, Xcode with the Watch SDK/runtime, and an Apple Watch already paired to its existing iPhone. Do not erase or move the Watch between phones. Use the [Watch pairing and signing instructions](../WATCH_SETUP.md).

## 2. Configure and start the backend

```sh
cd backend
npm ci
npm run setup
```

Open `backend/.env.local` privately in your editor:

- `OPENAI_API_KEY`: your existing API key, only on the backend. An existing key in the repository-root `.env.local` is also loaded when the backend value is empty. No key is included in Git.
- `DEMO_TOKEN`: generated automatically. This is a separate demo credential; it is not the OpenAI key. Copy it privately into the browser login field later.
- `MAIL_SENDER`: the exact sender email address already configured in Apple Mail.
- Keep `ENABLE_SENDING=false` until Mail setup passes.
- `TRANSCRIPTION_MODEL=gpt-transcribe`, `DRAFT_MODEL=gpt-4.1-mini`: configurable. Account access is established only by an actual request. Missing keys and provider errors are shown; no fixtures are substituted.

For names such as “Alex”, optionally edit `.providence/contacts.local.json`:

```json
[{"name":"Alex","email":"the-real-address-you-have-verified@example.com"}]
```

Use your real verified recipient address, not the example. Aliases are local, exact and case-insensitive. An explicit address can use spoken separators, for example “Send an email to alex at example dot com saying hi.” Without a matching alias or complete address, the app leaves it blank. On the Watch, tap **Recipient email**, dictate or enter the full address, then choose **Save recipient**. The Mac review page remains available. Speech recognition may misunderstand addresses, so always inspect the final recipient.

```sh
npm run check
npm test
npm start
```

Open `http://127.0.0.1:3000`. Connect with the demo token. Use **Typed development test** first. It calls the real drafting API, but does not test audio. Example: “Draft an email to Alex asking whether they can test our prototype at six. Keep it short.”

## 3. Enable real Gmail sending through Apple Mail

1. Open Mail on the same Mac. Use **Mail → Add Account → Google**, sign into the intended Gmail test account and enable Mail. Verify normal manual sending works.
2. Set `MAIL_SENDER` to that account's exact email address.
3. In another terminal, from `backend/`, run `npm run mail-check`. Accept macOS's permission for Terminal/Node to control Mail. This command checks account availability only; it sends nothing.
4. Set `ENABLE_SENDING=true` and restart the backend. Reconnect the browser to refresh its capabilities.
5. Review an email addressed to your own test inbox. Choose **Review & send**, inspect From/To/subject/body, then **Send email**.
6. Verify the message in Mail Sent, Gmail Sent, and the recipient inbox. The app reports **Handed to Apple Mail**; it does not assert delivery or a Gmail message ID.

If AppleScript times out after dispatch, the result is **uncertain**. Check Sent and Outbox before doing anything else. The job cannot be resent; neither reconnecting nor restarting bypasses the send journal. Do not delete the journal to make a retry button work. Mail's sender/formatting behavior needs testing on the actual Mac.

## 4. Connect the physical Watch

Install cloudflared using Homebrew if needed, then run in a separate terminal:

```sh
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:3000
```

Copy the generated HTTPS origin, then from `backend/`:

```sh
npm run configure-watch -- https://your-generated-name.trycloudflare.com
open ../WatchStarter.xcodeproj
```

This writes ignored `WatchStarter/ProvidenceConfig.json` with only the backend URL and demo token. Xcode's synchronized folder includes it as a resource. The app compiles without it and shows setup instructions, but cannot connect until it exists. Check target **Build Phases → Copy Bundle Resources** if the file isn't bundled by your Xcode version. The provider key is never copied to the Watch.

Select scheme **WatchStarter**, target **WatchStarter**, choose your signing team and physical Watch destination, then Run (⌘R). Use a unique bundle identifier if required. Keep the backend, tunnel and Mac awake. Do not set the Watch URL to localhost; that refers to the Watch, not the Mac.

Quick Tunnel URLs change when restarted. Regenerate the Watch config and rebuild after URL or token changes. This is a trusted single-user development demo; the bundled session token is not production device authentication.

## 5. Physical acceptance checklist

- [ ] App installs and opens on the actual Watch (not just a simulator).
- [ ] **Test connection** authenticates successfully.
- [ ] Microphone permission is requested and denial gives an actionable error.
- [ ] Record real speech; duration and level respond. Stop closes the file; 30 seconds stops automatically.
- [ ] Discard and wrist-lowering/interruption do not upload. Before Upload & draft, no new job appears on the review page.
- [ ] **Upload & draft** yields a transcript matching that recording and a useful draft on both screens.
- [ ] “Send an email to [your exact address] saying hi” produces the intended recipient and a short message without an invented greeting.
- [ ] Missing/incorrect recipient can be corrected directly on Watch: **Recipient email** or **Edit recipient** → dictate/enter the address → **Save recipient**. Nothing is sent by saving. The returned draft shows the exact address.
- [ ] A concurrent edit on Mac prevents a stale Watch edit/approval; **Refresh status** loads the current version for another review.
- [ ] **Review & send** on the Watch shows the exact sender, recipient, subject and body. **Keep draft** sends nothing.
- [ ] Explicit **Send email** submits once. Verify the real test inbox; feel the foreground haptic.
- [ ] Lower/reopen during processing: same request ID resumes; no automatic new model job or resend.
- [ ] Disconnect the backend: honest error, no fake success. Restore connection and check existing status.
- [ ] A Mail failure/timeout shows uncertain or an actionable preflight error; no automatic resend.
- [ ] Browser Disconnect clears visible private content. **Clear content** removes an individual completed draft/transcript.

## Data and privacy

Audio remains in a Watch cache until authorized upload is accepted or it is discarded. Network failure retains the local recording for explicit retry; request ID is reused. On successful upload it is deleted locally. The backend processes bytes in memory and does not intentionally write audio to disk. Jobs are bounded to 50 and become unavailable after one hour (cleaned on the next API access) or restart.

The temporary Mail payload is owner-readable and removed in `finally`; a force-kill or OS crash can leave a `providence-mail-*` directory in the OS temp directory. The send journal stores request IDs, content fingerprints and Mail attempt status, not transcripts or email bodies. It persists across backend restarts. Only one backend process should use a given demo session/journal.

The browser holds the demo credential in tab memory, not URLs or localStorage. Disconnect clears this browser session; it does not revoke the Watch token. To revoke access, stop the backend, rotate DEMO_TOKEN, restart, and rebuild the Watch config. Local `.env.local` files remain private and untracked; production credential storage/device pairing is not implemented. Mail manages its existing account credentials.

Cloudflare terminates the tunnel and OpenAI receives the recording/transcript for processing. `store:false` does not promise provider-side deletion or zero retention. This is not an offline or end-to-end private AI system.

## API and scope

`GET /health` is public and non-sensitive. Every `/api` route requires `Authorization: Bearer <DEMO_TOKEN>`.

| Route | Purpose |
| --- | --- |
| GET /api/config | Authenticated capability summary |
| POST /api/jobs/audio | Raw audio/mp4, <=5 MB, X-Request-ID UUID |
| POST /api/jobs/text | Development-only JSON text test; controlled by ENABLE_TEXT_TEST |
| GET /api/jobs, GET /api/jobs/:id | Session jobs/status/draft |
| PATCH /api/jobs/:id | Replace reviewed draft with matching version |
| DELETE /api/jobs/:id | Clear completed content; preserve replay protection |
| POST /api/jobs/:id/approval | Short-lived token bound to current reviewed version |
| POST /api/jobs/:id/send | Explicit token/version; fixed Mail adapter, no model tool call |

Draft generation never creates a Gmail draft or sends mail. Only the final send action invokes Mail. There is no inbox access, attachment access, arbitrary shell execution, code editing, TITAN integration, or iPhone companion in this MVP.

## Build commands

```sh
xcodebuild -project WatchStarter.xcodeproj -scheme WatchStarter \
  -destination 'generic/platform=watchOS Simulator' \
  -derivedDataPath build/simulator CODE_SIGNING_ALLOWED=NO build
xcodebuild -project WatchStarter.xcodeproj -scheme WatchStarter \
  -destination 'generic/platform=watchOS' \
  -derivedDataPath build/device CODE_SIGNING_ALLOWED=NO build
osacompile -o /tmp/providence-mail-check.scpt backend/scripts/mail-check.applescript
osacompile -o /tmp/providence-mail-send.scpt backend/scripts/mail-send.applescript
```

These commands compile without sending mail. Unsigned builds cannot be installed on a physical Watch. GitHub CI also checks backend contracts and Swift JSON decoding. Actual device and Gmail acceptance still require the checklist above.

### Signed-build metadata error in synced folders

If codesigning fails with `resource fork, Finder information, or similar detritus not allowed` while building inside a synced Documents/Desktop folder, put generated build products in Xcode's local DerivedData directory. For example:

```sh
xcodebuild -project WatchStarter.xcodeproj -scheme WatchStarter \
  -destination 'generic/platform=watchOS' \
  -derivedDataPath "$HOME/Library/Developer/Xcode/DerivedData/ProvidenceVoiceEmailTest" \
  DEVELOPMENT_TEAM=YOUR_EXISTING_TEAM_ID CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates build
```

Replace `YOUR_EXISTING_TEAM_ID` with the intended team already configured in Xcode. Keep team-specific settings local. The physical Watch still needs to be discoverable and eligible for the resulting provisioning profile before installation.
