# Apple Watch distribution

The `ProvidenceDistribution` scheme builds a Watch-only distribution container and the Watch app. The shared project uses placeholder bundle identifiers. Configure your own unique identifiers and existing Apple Developer team locally before distributing a build.

## Local archive

```sh
xcodebuild -project WatchStarter.xcodeproj \
  -scheme ProvidenceDistribution -configuration Release \
  -destination 'generic/platform=watchOS' \
  -archivePath "$HOME/Library/Developer/Xcode/Archives/Providence.xcarchive" \
  DEVELOPMENT_TEAM=YOUR_TEAM_ID CODE_SIGN_STYLE=Automatic archive
```

Use Organizer to inspect the archive and choose the appropriate export method. Uploads, provisioning and tester access are separate actions under your own account. Never commit signing keys, provisioning profiles, account emails, archives, or upload logs.

Configure the ignored Watch connection files before archiving; see [backend setup](docs/MVP_SETUP.md) and [Watch routing](docs/WATCH_MAC_ROUTING.md). Provider API keys must stay on the backend. Validate the packaged app's identifiers, microphone usage description, endpoint and authentication behavior before installing it. A successful simulator build does not prove physical Watch operation.
