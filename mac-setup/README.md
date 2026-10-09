# Legacy Mac enrollment helper

For current hosted setup, open [Account and devices](https://providence.hani.so/account), choose **Add computer → Mac**, and run its one-command installer. See [the first-run guide](../coordinator/docs/FIRST_RUN.md) for background startup, updates and uninstall.

The helper below is a legacy operator route that requires an existing one-use device pairing code. It is not the current hosted browser/terminal setup flow. It pins `providence.hani.so`; it cannot target an arbitrary self-hosted coordinator without a reviewed origin change.

This helper enrolls the current Mac as a Providence executor. It uses only the
existing coordinator companion and does not alter Codex login, account settings,
macOS permissions, or install a background service.

From this repository checkout, after `npm ci` has completed in `coordinator/`:

```sh
node mac-setup/providence-mac.mjs pair --workspace /absolute/path/to/approved-workspace
node mac-setup/providence-mac.mjs status
node mac-setup/providence-mac.mjs start
```

`pair` asks for the one-use code in a TTY with echo disabled. It accepts only
`https://providence.hani.so`, rejects redirects, and will not retry an uncertain
exchange. The resulting device credential is written once to
`~/Library/Application Support/Providence/review-mac.device.json` with a private
parent directory and mode `0600`. Existing valid enrollment is reused; a
different workspace, unsafe file, or malformed enrollment must be resolved
deliberately before pairing again.

The enrolled companion defaults to `workerAccess: "workspace"`. Set
`"full-access"` only through an explicit private configuration change for a trusted
controller whose local Codex runtime has been verified to permit it.

For device-local transcription, add an existing private file reference only:

```sh
node mac-setup/providence-mac.mjs pair --workspace /absolute/path/to/approved-workspace --transcription-env /absolute/path/to/private.env
```

The helper validates that path without reading or copying its provider key. To
review local enrollment without connecting, run `status`; to validate the start
preconditions without launching the companion, run `start --dry-run`.

Chrome control is an explicit enrollment-time opt-in only after it has been
verified on this same Mac with a real local test. It does not install a browser
extension, grant permissions, or prove a control path by itself:

```sh
node mac-setup/providence-mac.mjs pair --workspace /absolute/path/to/approved-workspace --verified-chrome
```

The setting is saved as `browserControl: "chrome"`. Existing enrollment is
never silently changed; `status` reports whether the opt-in is configured.

Run the isolated tests with:

```sh
node --test mac-setup/*.test.mjs
```
