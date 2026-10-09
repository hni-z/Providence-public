# Run on the physical DemoPC Windows laptop. Requires PowerShell 5.1+, Git and Node 22+.
[CmdletBinding()]
param(
    [string]$CoordinatorUrl,
    [string]$Workspace,
    [string]$RepositoryDirectory,
    [string]$ExpectedComputerName = 'DemoPC',
    [switch]$PairAgain
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') { throw 'This bootstrap must run on Windows.' }
if (-not $Workspace) { $Workspace = Join-Path $env:USERPROFILE 'ProvidenceWorkspace' }
if (-not $RepositoryDirectory) { $RepositoryDirectory = Join-Path $env:USERPROFILE 'Providence' }
if ($env:COMPUTERNAME -ne $ExpectedComputerName) {
    throw "This computer is $env:COMPUTERNAME, not $ExpectedComputerName. Run this on DemoPC or explicitly pass the intended -ExpectedComputerName."
}
foreach ($command in @('node.exe', 'npm.cmd', 'git.exe')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "$command is missing. Install Node.js 22+ and Git, then open a new PowerShell window. See docs/WINDOWS_SETUP.md."
    }
}
$nodeVersion = & node.exe -p 'process.versions.node.split(".")[0]'
if ($LASTEXITCODE -ne 0 -or -not $nodeVersion) { throw 'Node.js did not report its version. Install Node.js 22+ and open a new PowerShell window.' }
$nodeMajor = [int](([string]$nodeVersion).Trim())
if ($nodeMajor -lt 22) { throw 'Providence requires Node.js 22 or newer.' }

# The script can run from a checkout or be downloaded alone from the coordinator.
$adjacentCoordinator = Split-Path $PSScriptRoot -Parent
if ((Test-Path (Join-Path $adjacentCoordinator 'src/device.ts')) -and
    (Test-Path (Join-Path $adjacentCoordinator 'package-lock.json'))) {
    $coordinatorRoot = $adjacentCoordinator
} else {
    if (-not (Test-Path $RepositoryDirectory)) {
        & git.exe clone --branch main --single-branch https://github.com/hni-z/Providence-public.git $RepositoryDirectory
        if ($LASTEXITCODE -ne 0) { throw 'Cloning Providence failed. Confirm GitHub access to hni-z/Providence.' }
    }
    $coordinatorRoot = Join-Path $RepositoryDirectory 'coordinator'
    if (-not (Test-Path (Join-Path $coordinatorRoot 'src/device.ts'))) {
        throw 'The selected repository does not contain the Providence companion. Choose an isolated -RepositoryDirectory.'
    }
    # Never reset, switch, or overwrite an existing local checkout.
    $remote = & git.exe -C $RepositoryDirectory remote get-url origin
    if ($LASTEXITCODE -ne 0 -or -not $remote) { throw 'The existing directory is not a Git checkout of Providence.' }
    $origin = ([string]$remote).Trim()
    if ($origin -notmatch '(github\.com[:/]hni-z/Providence)(\.git)?$') {
        throw 'The existing directory is not the expected hni-z/Providence repository.'
    }
}

function Find-CodexExecutable {
    if ($env:CODEX_BIN) {
        if ((Test-Path -LiteralPath $env:CODEX_BIN -PathType Leaf) -and $env:CODEX_BIN -match '\.exe$') {
            return (Resolve-Path -LiteralPath $env:CODEX_BIN).Path
        }
        throw 'CODEX_BIN must name an existing native codex.exe, not a .cmd/.ps1 wrapper or command string.'
    }
    $nativeCommand = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($nativeCommand) { return $nativeCommand.Source }
    $standalone = Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\Codex\bin\codex.exe'
    if (Test-Path -LiteralPath $standalone -PathType Leaf) { return $standalone }
    $npmRootOutput = & npm.cmd root --global
    if ($LASTEXITCODE -ne 0 -or -not $npmRootOutput) { throw 'Unable to locate global npm packages.' }
    $npmRoot = ([string]$npmRootOutput).Trim()
    $openaiRoot = Join-Path $npmRoot '@openai'
    if (Test-Path -LiteralPath $openaiRoot -PathType Container) {
        foreach ($package in Get-ChildItem -LiteralPath $openaiRoot -Directory -Filter 'codex*') {
            $binary = Get-ChildItem -LiteralPath $package.FullName -Recurse -File -Filter codex.exe | Select-Object -First 1
            if ($binary) { return $binary.FullName }
        }
    }
    return $null
}

$codexExe = Find-CodexExecutable
if (-not $codexExe) {
    Write-Host 'Installing the official Codex CLI for this Windows user...'
    & npm.cmd install --global '@openai/codex@0.155.1' --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Codex installation failed. Install the official CLI and retry.' }
    $codexExe = Find-CodexExecutable
    if (-not $codexExe) { throw 'Could not find native codex.exe. Set CODEX_BIN to its full path and retry.' }
}
$env:CODEX_BIN = $codexExe
& $codexExe --version
if ($LASTEXITCODE -ne 0) { throw 'The Codex executable could not run.' }
& $codexExe login status
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Sign in to your own ChatGPT account on this device. Credentials stay on DemoPC.'
    & $codexExe login
    if ($LASTEXITCODE -ne 0) { throw 'Codex sign-in did not complete.' }
}

$Workspace = [IO.Path]::GetFullPath($Workspace)
if ($Workspace.TrimEnd('\') -eq [IO.Path]::GetPathRoot($Workspace).TrimEnd('\')) {
    throw 'Select a dedicated workspace folder, not a drive root.'
}
$privateDirectory = Join-Path $env:LOCALAPPDATA 'Providence'
if ($privateDirectory.StartsWith($Workspace.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $privateDirectory.Equals($Workspace, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The workspace must not contain the private Providence configuration directory.'
}
New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
New-Item -ItemType Directory -Force -Path $privateDirectory | Out-Null

# Restrict the private directory before receiving any credential.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagation = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', $inheritance, $propagation, $allow)))
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, 'FullControl', $inheritance, $propagation, $allow)))
Set-Acl -LiteralPath $privateDirectory -AclObject $acl
$configPath = Join-Path $privateDirectory 'demoPC.device.json'

Push-Location $coordinatorRoot
try {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Providence dependency installation failed.' }
    if ($PairAgain -or -not (Test-Path -LiteralPath $configPath)) {
        if (-not $CoordinatorUrl) { throw 'Pass -CoordinatorUrl with the HTTPS address shown by Providence.' }
        $uri = [Uri]$CoordinatorUrl
        if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') {
            throw 'CoordinatorUrl must be an HTTPS origin, with no credentials, path, query or fragment.'
        }
        $origin = $uri.GetLeftPart([UriPartial]::Authority)
        $secret = Read-Host 'Enter the one-use pairing code from Providence' -AsSecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        try {
            $code = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
            $body = @{ code = $code.Trim(); name = $env:COMPUTERNAME } | ConvertTo-Json -Compress
            $paired = Invoke-RestMethod -Method Post -Uri ($origin + '/pair/exchange') -ContentType 'application/json' -Body $body -TimeoutSec 30
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
            $code = $null
            $body = $null
            $secret = $null
        }
        $worker = [Uri]$paired.url
        if ($worker.Scheme -ne 'wss' -or $worker.Authority -ne $uri.Authority -or
            $worker.AbsolutePath -ne '/worker' -or $worker.UserInfo -or $worker.Query -or $worker.Fragment -or
            $paired.deviceId -notmatch '^[a-zA-Z0-9_-]+$' -or $paired.token.Length -lt 32) {
            throw 'The pairing response was invalid. No device credential was saved.'
        }
        $config = @{ deviceId = $paired.deviceId; token = $paired.token; url = $paired.url; workspace = $Workspace }
        [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        $paired = $null
        $config = $null
        Write-Host 'Pairing complete. The private device credential is stored outside the workspace.'
    } else {
        $saved = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        if ($saved.workspace -ne $Workspace) {
            throw "Existing enrollment uses another workspace. Run with its -Workspace value or use -PairAgain to deliberately replace enrollment."
        }
        $saved = $null
    }
    Write-Host "Starting Providence on $env:COMPUTERNAME. Approved workspace: $Workspace"
    Write-Host 'Keep this window open. Ctrl+C disconnects this companion. Files and shell are available; desktop/browser control is not configured.'
    $restarts = 0
    while ($true) {
        & npm.cmd run device -- $configPath
        $exit = $LASTEXITCODE
        # 3221225786 is the Windows status for Ctrl+C, which means the operator stopped it.
        if ($exit -eq 0 -or $exit -eq 3221225786) { break }
        # The companion exits 3 only when its registration is gone, which a restart cannot fix.
        if ($exit -eq 3) { throw 'This device registration is no longer active. Re-run with -PairAgain to enroll again.' }
        $restarts++
        if ($restarts -gt 10) { throw 'The companion stopped repeatedly. Review the preceding status before starting it again.' }
        Write-Host "The companion stopped with exit code $exit. Restarting in 5 seconds; press Ctrl+C to stop."
        Start-Sleep -Seconds 5
    }
} finally {
    Pop-Location
}
