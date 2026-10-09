# Existing enrollment only. No installs, login, pairing, permission edits or task replay.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$CoordinatorDirectory,
    [Parameter(Mandatory=$true)][string]$ConfigPath,
    [Parameter(Mandatory=$true)][string]$NodeExecutable,
    [Parameter(Mandatory=$true)][string]$CodexExecutable,
    [switch]$ResumeAfterReview,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Windows user-session launcher required.' }
. (Join-Path $PSScriptRoot 'windows-supervisor-identity.ps1')
Add-Type -Path (Join-Path $PSScriptRoot 'windows-companion-job.cs')
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$stateRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Providence\supervisors'
$preflightPath = Join-Path $stateRoot ('preflight-' + (Get-ProvidenceDigest $ConfigPath.ToLowerInvariant()) + '.json')
if ((Test-Path -LiteralPath $preflightPath) -and -not $ResumeAfterReview) { throw 'Configuration preflight previously failed; review is required before retry.' }
try { $identity = Get-ProvidenceEnrollmentIdentity $ConfigPath }
catch {
    if (-not $CheckOnly) {
        New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
        [IO.File]::WriteAllText($preflightPath, '{"reason":"invalid-enrollment-identity","exitCode":78}')
    }
    throw
}
$stateDirectory = Join-Path $stateRoot $identity
$mutex = $null
$ownsMutex = $false
$child = $null
$launchPhase = $false
$oldCodex = $env:CODEX_BIN
try {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $mutex = New-Object Threading.Mutex($false, ('Global\Providence-' + $sid + '-' + $identity))
    try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'Another supervisor owns this enrollment; no companion was started.' }
    Assert-NoProvidenceCompanion $identity
    $stopPath = Join-Path $stateDirectory 'stopped.json'
    if (Test-Path -LiteralPath $stopPath) {
        if (-not $ResumeAfterReview) { throw 'The previous run requires review; automatic restart is disabled.' }
    }
    # Configuration/runtime preflight failures after ownership are terminal too.
    $launchPhase = $true
    foreach ($file in @($ConfigPath, $NodeExecutable, $CodexExecutable)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'A required existing launcher file is missing.' }
    }
    $CoordinatorDirectory = (Resolve-Path -LiteralPath $CoordinatorDirectory).ProviderPath
    $NodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).ProviderPath
    $CodexExecutable = (Resolve-Path -LiteralPath $CodexExecutable).ProviderPath
    $entry = Join-Path $CoordinatorDirectory 'src\device.ts'
    $tsx = Join-Path $CoordinatorDirectory 'node_modules\tsx\dist\cli.mjs'
    foreach ($file in @($entry, $tsx)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Prepared companion runtime is incomplete.' }
    }
    if ($NodeExecutable -notmatch '\.exe$' -or $CodexExecutable -notmatch '\.exe$') { throw 'Native executable paths are required.' }
    if ($CheckOnly) { Write-Output 'Launcher paths and exclusive ownership checks passed; no companion started.'; return }
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    if ($ResumeAfterReview) {
        foreach ($marker in @($stopPath, $preflightPath)) { if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker } }
    }
    $env:CODEX_BIN = $CodexExecutable
    $retryCount = 0
    while ($true) {
        if ((Get-ProvidenceEnrollmentIdentity $ConfigPath) -cne $identity) {
            throw 'Enrollment identity changed during supervision; review before starting another child.'
        }
        $runId = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fffffff')
        $stdout = Join-Path $stateDirectory ($runId + '.stdout.log')
        $stderr = Join-Path $stateDirectory ($runId + '.stderr.log')
        $child = [ProvidenceWindowsJob]::Start($NodeExecutable, @($tsx, $entry, $ConfigPath), $CoordinatorDirectory, $stdout, $stderr)
        $status = [ordered]@{ supervisorPid=$PID; childPid=$child.ProcessId; startedAt=[DateTime]::UtcNow.ToString('o'); state='process-started'; retryCount=$retryCount }
        # This is process ownership, not a server-ready or successful-task claim.
        [IO.File]::WriteAllText((Join-Path $stateDirectory 'status.json'), ($status | ConvertTo-Json))
        while (-not $child.Wait(500)) { }
        $code = $child.ExitCode
        $child.Dispose(); $child = $null
        $status.state = 'stopped'
        $status['exitCode'] = $code
        [IO.File]::WriteAllText((Join-Path $stateDirectory 'status.json'), ($status | ConvertTo-Json))
        # Only agreed code 75 is retryable. Three restarts total per reviewed run.
        if ($code -ne 75 -or $retryCount -ge 3) {
            [IO.File]::WriteAllText($stopPath, (@{exitCode=$code;retryCount=$retryCount;stoppedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json))
            break
        }
        $retryCount++
        Start-Sleep -Seconds ([Math]::Pow(2, $retryCount))
    }
} catch {
    # A launcher failure must also survive logon retries. Do not save raw exceptions.
    if ($ownsMutex -and $launchPhase -and -not $CheckOnly) {
        New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $stateDirectory 'stopped.json'), (@{reason='supervisor-failure';stoppedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json))
    }
    throw
} finally {
    if ($null -ne $child) { $child.Dispose() }
    $env:CODEX_BIN = $oldCodex
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    if ($null -ne $mutex) { $mutex.Dispose() }
}
