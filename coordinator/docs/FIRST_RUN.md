# Try Providence on two computers

## Find your way around

- **Chat** is where you type requests and follow their progress. The voice button beside Send starts a conversation in that same chat.
- **Devices** shows your computers and the command to connect another one.
- **Account** contains your passkeys, sessions, API-key status, and billing information. **Sign out** is at the bottom of the navigation menu.
- **Spatial view** opens the experimental floating-orb interface at `/meta`.

On a phone, open the menu at the top left to find these pages. The iPhone app uses the same hosted interface. Apple Watch uses a compact voice interface and requires its own signed installation and pairing.


Use [Providence](https://providence.hani.so/account) on each computer. Start with one Mac or Windows computer, then repeat on the second. Use the same Providence account on both.

1. **Sign in.** Create or use your Providence passkey. Copy the command shown for your computer. Paste it into Terminal on a Mac or PowerShell on Windows.
2. **Connect the first computer.** Follow the terminal instructions, sign in to Codex only if needed, and name the computer something recognizable, such as “Kitchen laptop.” Setup uses `ProvidenceWorkspace` in your home folder automatically, then asks you to confirm the connection. New computers use **full access**: your approved Providence account can run commands and change files across this computer without a prompt for each task. The starting folder does not limit that access. Approve only the browser code that matches this terminal; signing into Codex alone does not pair the computer with Providence.
3. **Add your API key.** Enter it at the hidden terminal prompt. It will not appear as you type. Providence sends it to encrypted storage on its server. Your account needs one key; each computer still needs its own Codex sign-in.
4. **Choose background startup and keep awake.** These are separate choices. Background startup lets you close the terminal. Keep awake prevents automatic idle sleep while Providence is actively used or has running tasks.
5. **Connect the second computer.** Repeat the installation, using the same Providence account and a different computer name. You should not need to enter the API key again.
6. **Check the connection.** Refresh “Your computers.” Both should show Online. Open your workspace and ask which computers are available.
7. **Try a harmless action.** Ask Providence to report the current time on one named computer, then on the other. Check the computer named in each result. This checks the companion's file/command runtime; it does not verify browser or desktop control.

Do not rely on an Online label alone as proof that every app can be controlled. If a required permission is missing, setup should identify it instead of claiming success.

Providence acts on clear requests without adding a routine confirmation. It uses reasonable defaults for optional preferences and asks only for a missing detail that materially affects the work. Nonblocking clarification questions close after at most 20 seconds without a reply; Providence then continues authorized work that does not require the answer. It leaves a consequential action unresolved when a critical fact is missing, and reports that separately from completed work. A question on one computer does not block independent requests to Superagent. Required app, operating-system and provider approvals remain separate and are never granted by silence.

Run the command once on each computer. For everyday use, open Providence and select the computer you named. A repeated command reuses that computer's saved connection and choices. A confirmed running background helper does not need another Codex sign-in; a stopped helper checks its existing sign-in before restarting. An unconfirmed process lock is preserved and reported as needing attention, never treated as proof that Providence is running.

On Windows, the installer can recover stale startup state only after Windows confirms the recorded processes are gone or belong to other executable images, and no orphan uses Providence's saved Node runtime. A confirmed non-Node image name is sufficient even when its full path requires administrator privileges. It never stops a process by its saved PID. Missing image names, inaccessible Node paths or ambiguous process identities leave the setup fenced for inspection.

To choose a different starting folder during first setup, append `--workspace-folder /absolute/folder` after `sh -s --` on macOS/Linux, or `-WorkspaceFolder 'C:\Your folder'` to the PowerShell command. Folder overrides do not change an already linked computer. Developers choosing the narrower `node scripts/connect.mjs --workspace` mode are still asked which folder should define that boundary.

To update an already connected computer, run its normal installer command again. If its background helper uses an earlier release, setup asks **Update Providence now? [y/N]**. Choose yes when it is safe to stop that computer's current work. Providence confirms the old helper has stopped before starting the new release, while keeping the account, workspace, access choices and Codex sign-in. Press Enter or choose no to keep the earlier version running. An uncertain shutdown stops the update and preserves the existing controls.

## ChatGPT Remote and Computer Use

Providence's **Connect device** opens Account and devices for the current installer. Its companion uses the tools available to the local Codex runtime. ChatGPT Remote pairing is a separate feature; it is not a Providence setup step. **Full access** sets Codex's file and command permissions; it does not install or enable a native GUI tool. Check one harmless app action through Providence on each computer before relying on desktop control.

For **ChatGPT Remote**, use the same ChatGPT account and workspace on the controller and host. On each computer you want to control, open ChatGPT **Settings → Connections → Control this Mac or PC** and complete **Set up/Add**, including **Allow devices to control this Mac/PC** when shown. On the controlling desktop, use **Settings → Connections → Control other devices**, where available. A controller-only computer does not need to allow inbound control; enable that on both computers only when both should be controllable. [Official Remote setup](https://learn.chatgpt.com/docs/remote-connections)

For **Computer Use**, on each host that will operate graphical apps, open ChatGPT Work or Codex, then **Plugins → Computer Use**. Install or enable the plugin, turn on its **server and skill** toggles, and select **Try now**. Review app access in **Settings → Computer use**. On macOS, approve the requested **Accessibility** and **Screen Recording** permissions. On Windows, keep the target app visible in the foreground and the user session unlocked. [Official Computer Use setup](https://learn.chatgpt.com/docs/computer-use)

Those settings enable ChatGPT's own features. They do not by themselves connect Computer Use to Providence or prove that Providence can control the computer.

## Check that you can disconnect

In Account, select **Remove access** for one computer and confirm. It should lose its connection and be unable to reconnect with its previous credential. The other computer should retain its access. Removal from the website revokes access; it does not remotely erase files from that computer.

To remove the installation locally, run its saved uninstaller:

macOS or Linux, in Terminal:

```sh
~/.providence/companion/uninstall
```

Windows, in PowerShell:

```powershell
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -Command '$ErrorActionPreference=''Stop''; & ([scriptblock]::Create([IO.File]::ReadAllText((Join-Path ([Environment]::GetFolderPath(''UserProfile'')) ''.providence\companion\uninstall.ps1'')))); exit $LASTEXITCODE'
```

Read the confirmation. The uninstaller stops Providence, removes its startup entry, and removes its owned files and credentials. Existing Codex installations, Codex sign-in, your chosen workspace, and your documents must remain. If it cannot confirm shutdown, it must say so and preserve the files needed to manage the process. If remote revocation cannot be confirmed because the service is unreachable, use Account to remove access as soon as you can reconnect.

The shared hosted API key is a separate account setting. **Remove saved key** disables Providence's provider access for the whole account and begins stopping work. It does not undo actions already performed. For a suspected exposed key, also revoke the key on [OpenAI's API-key page](https://platform.openai.com/api-keys); deleting Providence's saved copy does not invalidate other copies or erase encrypted backups.

## Check sleep and phone access

With keep awake enabled, active use should show **Keep awake on**. Finish running tasks and close all Providence pages. Providence should release its temporary request after its short grace period, allowing the computer's usual sleep policy to apply. It does not wake sleeping computers, change display or lock settings, or override a computer already configured never to sleep.

Use Safari on iPhone for the current hosted sign-in. Native app passkey support requires a newly signed build and a matching website association; a web update alone cannot add it to an older installation. Apple Watch installation is separate from the computer command and currently requires Xcode. Pairing and a real microphone/speaker check follow a successful installation.
