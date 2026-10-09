# Providence for iPhone

Open `iPhone/Providence.xcodeproj` and select the shared **Providence** scheme. This standalone iPhone app loads **https://providence.hani.so/** in WKWebView. It uses the deployed shared frontend and authenticated coordinator; no frontend fork, agent runtime, API client or provider credentials are bundled. The workspace is the default entry. The shell loads the shared web interface and preserves its selected view.

Hosted web changes can appear on the next page load or reload, subject to caching. Changes to the native shell, entitlements, or permissions require a new signed app installation; a website deployment cannot update those parts of an already installed app.

The native shell now uses the shared origami identity and black, white and neutral-gray palette. First launch shows a clear connecting state. Network failures, a terminated web process, server errors and a page that takes longer than twenty seconds expose explicit **Try again** and **Open in Safari** actions. These screens never retry or submit a task automatically. Their text scales with Dynamic Type and the recovery layout scrolls when needed.

## Build and install

Xcode 26.6 was used; minimum iOS is 16.0. There are no package dependencies. Bundle ID: `com.example.providence.iphone`. Signing team is deliberately a local build choice, not a shared project setting.

```sh
xcodebuild -project iPhone/Providence.xcodeproj -scheme Providence \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build/iphone-simulator CODE_SIGNING_ALLOWED=NO build

# Choose an existing booted iPhone simulator; do not use a physical identifier here.
xcodebuild -project iPhone/Providence.xcodeproj -scheme Providence \
  -destination 'platform=iOS Simulator,id=SIMULATOR_ID' \
  -derivedDataPath build/iphone-simulator CODE_SIGNING_ALLOWED=NO \
  -parallel-testing-enabled NO test

# Use the verified existing development team and provisioning on the installing Mac.
xcodebuild -project iPhone/Providence.xcodeproj -scheme Providence \
  -destination 'generic/platform=iOS' -derivedDataPath build/iphone-device \
  DEVELOPMENT_TEAM=YOUR_EXISTING_TEAM build

xcrun devicectl list devices
# Only after verifying the intended physical phone and coordinating its test slot:
xcrun devicectl device install app --device VERIFIED_DEVICE_ID \
  build/iphone-device/Build/Products/Debug-iphoneos/Providence.app
xcrun devicectl device process launch --device VERIFIED_DEVICE_ID com.example.providence.iphone
```

No provisioning update, account change, Watch packaging, server deployment or TestFlight upload is part of this project.

## Passkey association

Both app build configurations use `Providence/Providence.entitlements`, which declares `webcredentials:providence.hani.so`. This is required for the hosted account's passkeys inside WKWebView. Signing team and bundle ID overrides remain local build choices.

The host must also serve a valid JSON association file at `https://providence.hani.so/.well-known/apple-app-site-association`, over HTTPS with no redirect:

```json
{
  "webcredentials": {
    "apps": ["YOUR_APP_ID_PREFIX.YOUR_BUNDLE_IDENTIFIER"]
  }
}
```

Use the exact `application-identifier` from the intended signed app for this entry, including any local bundle ID override. The placeholder is not a working app association. The provisioning profile must allow Associated Domains. An unsigned build checks the project source; it does not verify signing, Apple's association cache, or successful passkey sign-in on a phone.

An older installed shell without this entitlement needs a newly signed build after the matching association is hosted. Reloading the website cannot add the entitlement. Until that installation and physical sign-in are verified, use Providence directly in Safari; a Safari session is not proof that the embedded WebView is signed in.

Apple documents the [WKWebView passkey requirement](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys) and [matching app/domain association](https://developer.apple.com/documentation/xcode/supporting-associated-domains).

## Auth, navigation and voice

- The hosted version uses its account sign-in screen. Passkeys inside WKWebView require the association described above. The shell neither creates pairing codes nor copies another client's credential. Existing server grants and expiry remain authoritative.
- WKWebsiteDataStore is persistent, but **the web app stores its paired session and selected chat in sessionStorage**. Same-page reload retains this storage; a newly created WebView/cold launch may require pairing again. Persistent cookies do not make sessionStorage persistent. No native storage shim changes this contract.
- Only exact `https://providence.hani.so` content is admitted in the embedded view. User-tapped external HTTP(S) references open in Safari's separate in-app browser. Microphone requests require the main frame on the exact origin and the active app; the normal permission prompt remains visible. Camera capture is denied.
- The shared frontend owns chat, the voice control, transcript and replies, and recording/transcribing/working/speaking states. It can use the hosted WebRTC voice session or its supported recording/transcription path; no provider key or separate native voice runtime is added to this wrapper. A native rebuild alone does not deploy or verify a new hosted voice feature.
- Inline audio playback is enabled so the shared web voice controller can play replies after its explicit Start gesture. The web lifecycle cancels voice on page hide, and the shell also stops microphone capture and suspends media when entering the background. Returning to the app does not call capture or play. No background-audio entitlement is present.
- Authenticated artifact object URLs remain inside the embedded origin. Downloads use WKDownload and the iOS share sheet, with temporary files removed after the sheet completes. A reload/error does not automatically resubmit a request.

The app icons use the shared black tile and original seven-facet mark. Regenerate both the iPhone and Watch icons from the repository root with `swift iPhone/scripts/generate-icon.swift`.

## Acceptance boundaries

See [native distribution readiness](DISTRIBUTION.md) before calling a development package public or TestFlight-ready. Privacy manifests are bundled, but hosted data disclosures, store metadata and review remain separate release requirements.

The XCTest suite checks origin escapes, configuration, read-only live HTTPS loading, recording/playback API availability, and non-auth sessionStorage behavior. It does not record a microphone, pair a client, call transcription/TTS or submit a task. Live-origin tests require network access to Providence.

On the intended physical phone, still verify: existing pairing, exact selected device/chat, tap-to-record permission and actual clip upload, final transcript, returned reply and heard audio, playback stop/retry, background interruption without automatic restart, and an artifact download. Simulator API availability is not physical capture or audible-output proof.

The origin is currently pinned in `Providence/ProvidenceViewController.swift`. Passkey behavior in the embedded WebView needs physical device verification with the matching hosted association. Before using your own deployment, update the origin, associated-domain entitlement, matching tests, and hosted association, then rebuild the app.
