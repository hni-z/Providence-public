# Companion release checks

Providence distributes a web app and a per-user Node companion through `install.sh` / `install.ps1`. These are not notarized Mac or signed Windows desktop application installers. iPhone and Watch packages have a separate native distribution process.

The bootstrap uses HTTPS without redirects, fixed download origins, pinned official Node digests, a content-addressed companion release and locked npm dependencies. It verifies archive bytes before extraction. The installer and companion manifest are served by the same Providence origin: checksum verification does **not** protect against that origin or release pipeline being compromised. Publication must preserve the reviewed source and immutable artifact mapping.

The installer prefers an existing native app/CLI Codex executable, otherwise installs its pinned official fallback privately. Existing sign-in and `CODEX_HOME` are retained; no credentials are copied and no global Codex config is changed. Local startup checks the requested full-access/model profile and fails if it is unavailable. Full access covers files and commands; graphical tasks additionally require supported local tools, their permission grants, and the appropriate desktop session. A one-command bootstrap cannot replace those OS/application controls.

The current integration uses local Codex app-server stdio. OpenAI documents the stdio transport and `--stdio` alias but labels app-server experimental; compatibility checks do not imply an upstream production-support guarantee. See [developer commands](https://learn.chatgpt.com/docs/developer-commands) and [app-server documentation](https://learn.chatgpt.com/docs/app-server). The bootstrap must not silently switch a requested profile or expose an unauthenticated network app-server listener.

## Before publishing an update

1. Run `python3 coordinator/install/test_installers.py` and the Node tests in `coordinator/install/` plus `coordinator/scripts/connect-helpers.test.mjs`. These use fixtures; they must not install into the real user's profile.
2. Build the companion ZIP/TAR/manifest with `scripts/build-companion.py`. Build again from the same source and verify all three files are byte-identical. Inspect the whitelist and scan the extracted source with redaction enabled.
3. Publish both archives under their manifest's immutable version directory before making that manifest current. Never patch a versioned archive in place. Serve the matching reviewed bootstrap files.
4. Keep failure-path checks: changed hashes/redirects fail before execution; unsupported platforms stop; existing credentials/access choices survive resume; unknown process identity or shutdown cannot be interpreted as stopped; uninstall refuses protected workspaces, reparse escapes and unowned files.
5. Keep physical acceptance distinct: a fresh Mac and Windows setup should reach the intended account, report the actual computer Online, complete an independently observed harmless task, stop/revoke correctly, and uninstall owned files. Passing fixture tests or old device receipts is not proof of the current release on every device.

Keep-awake is optional, temporary, and tied to active UI/task leases. It does not change global power/lock settings or promise wake-from-sleep/closed-lid operation. Uninstall removes only verified Providence-owned assets after shutdown and reports uncertain remote revocation or remaining files honestly. Saved Windows removal uses `uninstall.ps1` through foreground system PowerShell; old `.cmd` entries are recognized for cleanup, not generated for new installs.
