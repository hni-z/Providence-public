# Windows setup

For the hosted service, use [Providence Account and devices](https://providence.hani.so/account). The installer downloads its own runtime; you do not need to clone this repository or install Node.js and Git yourself.

## Connect a computer

1. Open Providence on the Windows computer and sign in with your passkey.
2. Select **Add computer**, choose **Windows**, and copy the command into PowerShell under your normal Windows account.
3. Follow setup, using your existing Codex sign-in or its official sign-in flow when prompted. Give the computer a recognizable name.
4. Confirm full access and choose whether Providence may keep the computer awake during active use. Full access allows commands and file changes across the computer; the starting folder does not restrict it.
5. Compare the terminal code with the browser page and approve it with your Providence passkey. Approve only a setup you started.
6. If your Providence account needs an OpenAI API key, enter it in the hidden terminal prompt. It is sent to encrypted storage on Providence's server for hosted coordination and voice. Each computer retains its own Codex sign-in.
7. Choose background startup if you want to close PowerShell and start the companion at login. Wait for **Online** in Providence, then try a harmless task on this named computer.

The default starting folder is `%USERPROFILE%\ProvidenceWorkspace`. An advanced `-WorkspaceFolder` option selects another starting folder during initial setup. Repeating the installer preserves an existing computer's pairing, folder, permissions and keep-awake choice. See [the two-computer walkthrough](FIRST_RUN.md).

## App control

Files and commands use the local Codex runtime. Native app control additionally needs compatible Computer Use tools, an unlocked Windows session, and the app permissions requested by those tools. Keep ChatGPT open when using its native Computer Use tools. Full access does not grant or override operating-system or application permissions.

Check app control separately: ask Providence to open Calculator on this computer and perform a small calculation, then verify the displayed result on the actual Windows screen. An Online badge alone does not verify every app or tool.

ChatGPT Remote pairing and Providence pairing are separate. A computer connected through ChatGPT Remote is not automatically enrolled in Providence. See [Computer Use and Remote setup](FIRST_RUN.md#chatgpt-remote-and-computer-use).

## Local controls and removal

Run the saved manager in PowerShell:

```powershell
& "$env:USERPROFILE\.providence\companion\manage.cmd" status
# Other commands: start, stop, disable, awake-on, awake-off
```

`stop` stops the helper; `disable` also removes login startup. Keep awake blocks automatic idle sleep only during active Providence use or tasks. It does not wake or unlock the PC, prevent manual sleep, or change normal display and lock settings.

To update, run the installer command again and accept the update when current work can stop. The installer preserves enrollment and checks that the previous helper stopped before starting its replacement. Ambiguous process state stops the update for inspection.

Use **Remove access** in Providence to revoke a computer's connection. To remove its local installation:

```powershell
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -Command '$ErrorActionPreference=''Stop''; & ([scriptblock]::Create([IO.File]::ReadAllText((Join-Path ([Environment]::GetFolderPath(''UserProfile'')) ''.providence\companion\uninstall.ps1'')))); exit $LASTEXITCODE'
```

The uninstaller removes Providence's owned helper, startup entry and credentials after checking shutdown. It preserves your workspace, documents and existing Codex installation/sign-in. If the service is unreachable, confirm remote removal in Account when you can reconnect. Revoking an OpenAI API key is separate from removing a device's Providence access.

## Self-hosted checkout setup

The older `scripts/start-windows.ps1` helper is for a separately operated coordinator and an existing source checkout. It requires Node.js 22+ and a usable local Codex runtime. Use the matching coordinator release and your own HTTPS endpoint:

```powershell
Set-Location 'C:\path\to\Providence\coordinator'
.\scripts\start-windows.ps1 -CoordinatorUrl 'https://YOUR_COORDINATOR' -Workspace "$env:USERPROFILE\ProvidenceWorkspace"
```

This helper uses a one-use pairing code from that coordinator and saves a private device file under `%LOCALAPPDATA%\Providence`. Leave its terminal open while the foreground companion runs. If a configuration already exists, it keeps the saved endpoint and requires the matching workspace. Do not use `-PairAgain` to migrate an endpoint; inspect the existing configuration privately and follow the operator's migration procedure.

The legacy configuration defaults to workspace-limited access when `workerAccess` is omitted. Its behavior is separate from the hosted installer's deliberate full-access enrollment. Do not copy device credentials between computers, print them, or commit them. The helper does not copy Codex authentication files.
