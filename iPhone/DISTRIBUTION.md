# Native distribution readiness

The iPhone and Watch development packages can run on devices included in their development profiles. They are **not public downloads, TestFlight builds or App Store approvals**. Source/simulator checks and earlier physical-device receipts do not establish current hardware availability or complete native voice acceptance.

## Privacy manifest scope

Both app targets bundle `PrivacyInfo.xcprivacy` through their synchronized source groups. The native code does not implement advertising tracking or contact tracking domains. The Watch declares `NSPrivacyAccessedAPICategoryUserDefaults` with reason `CA92.1`: its own preferences and recoverable request state. It does not read another app's defaults. The iPhone shell currently calls no required-reason API directly. Neither manifest claims that Providence collects no data.

These files currently describe tracking and required-reason API use only. **Collected-data declarations and App Store privacy labels still require an end-to-end review of the hosted service and OpenAI processing before submission.** Account identifiers/names, user-provided messages, voice recordings, task content/results and diagnostics must be evaluated; a web view does not exempt the app from describing its service's data practices. Do not add an empty collected-data declaration as a substitute for that review.

Apple's current [required-reason documentation](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api) and [approved values](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitypereasons) govern these declarations. Recheck the manifest when adding storage, timestamps, disk-space checks or third-party SDKs.

## Before TestFlight or App Store submission

1. Select the final owned bundle identifiers and matching App Store Connect records. The checked-in projects keep example identifiers and no signing team; local development overrides are not App Store records. Changing the iPhone identifier also requires matching Associated Domains provisioning and the hosted AASA entry.
2. Prepare App Store distribution signing/provisioning or the approved Xcode-managed distribution route. Do not label an Apple Development IPA as a public release. Increment build numbers for subsequent uploads.
3. Supply the privacy-policy and support URLs, app description, screenshots, age rating, export-compliance responses, review contact and usable reviewer setup. The service and review account must function during review. Owner/legal decisions must be supplied accurately rather than guessed.
4. Make the privacy policy accessible in the app, provide the required account-deletion flow for account-creating apps, and disclose/obtain permission for third-party AI data sharing before transmission. These are distinct from microphone permission and from OS-level access to computers.
5. Explain the app's utility and native integration in review notes. The iPhone is a hosted web client, so Apple guideline 4.2 minimum-functionality review remains a real acceptance consideration. No source change or successful archive guarantees acceptance.
6. Upload and process a distribution build, finish TestFlight test information and any required beta review, then verify the installed build through TestFlight. No upload or store release is performed by the local readiness checks.

Primary references: [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/), [TestFlight workflow](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/), [App privacy](https://developer.apple.com/app-store/app-privacy-details/).

## Evidence to retain

Record the exact source commit, archive/export hash, signing identity type, profile expiry and bundle identifiers. Confirm privacy manifests and expected entitlements in the built products, not just the source. Keep development archives/profiles and device receipts private. For the intended physical phone/Watch, still verify sign-in/pairing, explicit microphone start/stop, received audio, background interruption, exact target routing and a harmless completed task. Never substitute simulator presentation or a standalone computer-runtime test for that native end-to-end result.
