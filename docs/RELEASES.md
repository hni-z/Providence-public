# Providence releases

The release builder stages a tested snapshot of committed source. Deploying that snapshot to your own server is a separate operation.

## Stage one committed release

Use Node.js 22.12+ (or a newer major), npm, Git and tar. Commit and review all intended source changes first, including new files. The builder refuses dirty tracked files and untracked, non-ignored files. It also rejects tracked private configuration/state, source symlinks and submodules rather than accidentally copying credentials or following files outside the source archive. The root `.gitattributes` uses LF for text, with CRLF for PowerShell scripts. If a Windows checkout reports widespread line-ending changes, inspect the diff and Git configuration before treating them as source edits. Preserve real local changes before refreshing any tracked files.

```sh
node coordinator/scripts/build-release.mjs --help
node coordinator/scripts/build-release.mjs
# Or choose a new directory outside the checkout:
node coordinator/scripts/build-release.mjs --output /absolute/path/to/new-release
```

The default destination is `coordinator/.providence/releases/<full-commit-sha>`, which is ignored by Git. Every destination must be new; an existing release is never overwritten. An explicit destination within the checkout must also be ignored.

The builder archives exact committed HEAD with `git archive`; it does not copy the working directory, `.git`, `.providence`, environment files, device enrollment, Codex authentication or live state. It installs locked dependencies with `npm ci` in coordinator, web and Quest; runs backend type checks and tests, Quest tests, any configured web tests, and both production builds. The frontend builds include their TypeScript checks. There is no skip-tests option.

Build subprocesses receive only necessary OS/tool paths, an isolated npm cache/config and `VITE_RELEASE_COMMIT=<full-sha>`. Provider credentials, inherited `VITE_*` values and Codex session metadata are not forwarded. Output is captured in the staging directory's private `.release-build/build.log`. A failed directory is preserved for inspection and has no completed release manifest; choose a new output path after fixing the source and committing it.

After every required step succeeds, `coordinator/release.json` records:

```json
{
  "schemaVersion": 1,
  "commit": "<full-commit-sha>",
  "builtAt": "<ISO-8601-time>",
  "nodeVersion": "<actual-node-version>",
  "webEntry": {"path":"web/dist/assets/<entry>.js","url":"/assets/<entry>.js","sha256":"<actual-bytes-hash>"},
  "questEntry": {"path":"quest/dist/assets/<entry>.js","url":"/quest/assets/<entry>.js","sha256":"<actual-bytes-hash>"}
}
```

Entries come from each generated `index.html`; hashes are computed from the actual referenced files. Paths are relative to the staged coordinator directory. Successful stdout contains only the release/manifest paths and manifest JSON. Keep staged releases unchanged after building.

## Deploy a staged release

This script **stages and builds only**. It never deploys, restarts a process, changes nginx/routing, copies private state or switches a live release. The server operator manages deployment and routing.

Before promotion, confirm the coordinator has no active work, queued dependencies, pending decisions or pending transcriptions. Promotion restarts the process, which expires every pending approval and marks queued or running tasks interrupted, so a seeded demo decision does not survive it. Let existing tasks finish; do not interrupt them to simplify a cutover. Keep the current external `PROVIDENCE_DATA_DIR` and device credentials unchanged. Never run two coordinators against the same state directory, and never replace state with files from a release directory.

After cutover, check the **canonical HTTPS site**: `/health` proves liveness only. The running process's version endpoint must match this release's commit and manifest, and its reported web/Quest entry URLs must resolve to bytes with the recorded hashes. Verify the main page and `/quest/` actually reference those entries; a local build or file copied onto a server is insufficient. Reopen the existing authenticated session in Chrome and check the existing device/chat state and a harmless end-to-end action. The running coordinator exposes `/version`; the builder does not start a server.

Retain the previous release path and version evidence. If rollback is necessary, make the cutover while idle and restart the previous code against the **same external state**, after checking that its schema is compatible. Do not restore an old state snapshot merely to roll back code. Verify the canonical process/version and both client bundles again. If state compatibility is uncertain, stop the promotion and inspect it rather than resetting chats, pairing or credentials.


## Public release boundaries

The current downloadable computer product is a web interface plus a Mac/Windows/Linux companion installed with one command. It is not a signed native desktop DMG/MSI/EXE. State that clearly wherever downloads are described.

A public source showcase must use a reviewed history-free export. Do not make the development repository public merely because its current tree passes a secret scan: old commits may contain personal operational records. Preserve the all-rights-reserved source license unless its owner explicitly chooses different reuse rights. Generated web and Quest builds include runtime third-party license notices.

Native Apple development packages are for their provisioned devices. Complete the separate [distribution checklist](../iPhone/DISTRIBUTION.md) before claiming App Store or TestFlight readiness. Signing, required metadata/contact information, privacy declarations, review and physical acceptance are separate from source compilation.

The hosted server remains a trusted dispatcher. Neither passkey sign-in nor use of an OpenAI model makes server compromise harmless. Do not describe the system as 100% secure or as transferring Providence's security responsibilities to OpenAI.

## Account-data migration and rollback

The hosted schema includes account deletion tombstones and versioned AI consent. Deploy while idle, preserve the existing external data directory and encryption key, and check the account/voice flows after promotion. Existing accounts must accept the notice once before starting new AI work. Never insert consent silently during a migration.

Do not roll back to code that ignores a deleting account or bypasses the consent boundary. If rollback is needed after these controls have been used, use a compatible build and the same current data. Restoring an old account database can resurrect credentials or data the user deliberately removed; it is not an ordinary code rollback.

Before broad release, verify with the actual intended hardware: fresh install and uninstall on Mac/Windows, one authorized graphical action, background/idle sleep behavior, native iPhone passkey and audio lifecycle, Watch pairing/recording/reply, and Quest microphone/hand input. Simulated runtime success and task-card status are not physical proof. Record untested rows explicitly.
