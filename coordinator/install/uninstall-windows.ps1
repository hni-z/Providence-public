param([Parameter(Mandatory=$true)][string]$NodePath, [Parameter(Mandatory=$true)][string]$ModulePath, [switch]$Yes, [switch]$AllowOffline)
# Foreground controller: Node stops/revokes and writes a private, token-free plan.
# This system PowerShell stays alive, waits for Node, then removes owned files.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$cleanupExitCode = 1
$phase = 'preparation'
function Assert-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -Force -LiteralPath $Path
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe directory' }
}
function Assert-RegularFile([string]$Path) {
    $item = Get-Item -Force -LiteralPath $Path
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe file' }
}
function File-Hash([string]$Path) {
    Assert-RegularFile $Path
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}
function Get-OwnedPath([string]$Base, [string]$Relative) {
    if ($Base -notin @('installation','companion') -or -not $Relative -or $Relative -match '[\\:\x00-\x1f\x7f]' -or $Relative.StartsWith('/')) { throw 'Unsafe path' }
    $parts = $Relative.Split('/')
    if ($parts | Where-Object { $_ -in @('', '.', '..') }) { throw 'Unsafe path' }
    $root = $paths[$Base]
    Assert-Directory $root
    for ($i = 1; $i -lt $parts.Length; $i++) { Assert-Directory (Join-Path $root (($parts[0..($i-1)]) -join '/')) }
    return Join-Path $root $Relative
}
function Assert-NoInstall {
    if (Test-Path -LiteralPath (Join-Path $paths.installation '.install-lock')) { throw 'An installation may be active' }
}
function Assert-RetiredProcess([long]$OwnerPid) {
    if ($OwnerPid -le 0 -or $OwnerPid -gt 4294967295) { throw 'Invalid process owner' }
    if (Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue) { throw 'The original process may still be active' }
    # A dead parent alone is insufficient: the old deferred helper or another
    # child may still be alive. No PID is ever signalled or forcibly terminated.
    $children = @(Get-CimInstance -ClassName Win32_Process -Filter ('ParentProcessId=' + $OwnerPid) -Property ProcessId -ErrorAction Stop)
    if ($children.Count -ne 0) { throw 'An owned child may still be active' }
}
function Assert-CompanionsStopped {
    foreach ($name in @('device.json.lock', 'device.json.background.lock')) {
        $file = Join-Path $paths.companion $name
        if (-not (Test-Path -LiteralPath $file)) { continue }
        Assert-RegularFile $file
        if ((Get-Item -LiteralPath $file).Length -gt 1024) { throw 'Invalid companion lock' }
        $value = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
        Assert-RetiredProcess $value.pid
        Assert-RetiredProcess $value.childPid
    }
}
function Read-OwnedPlan([string]$Path) {
    Assert-RegularFile $Path
    if ((Get-Item -LiteralPath $Path).Length -gt 33554432) { throw 'Plan too large' }
    return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}
function Write-RetryGuidance {
    [Console]::Error.WriteLine('Retry this foreground controller from an intact extracted Providence source copy, using the same -NodePath and -ModulePath. A saved plan resumes without starting Node. Do not clear its ownership lock manually.')
}
function Assert-PlanOwnership($Plan) {
    Assert-NoInstall
    if ($Plan.schemaVersion -ne 1 -or [IO.Path]::GetFullPath($Plan.home) -ine $userProfilePath) { throw 'Unrecognized removal plan' }
    $inventoryEntries = @($Plan.files | Where-Object { $_.base -eq 'installation' -and $_.path -eq '.providence-owned.json' })
    if ($inventoryEntries.Count -ne 1 -or $inventoryEntries[0].kind -ne 'file' -or $inventoryEntries[0].sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Missing ownership record' }
    if ((File-Hash $inventoryPath) -cne $inventoryEntries[0].sha256) { throw 'Ownership record changed' }
    Assert-RegularFile $lockPath
    if ((Get-Content -Raw -LiteralPath $lockPath) -cne [string]$Plan.parentPid) { throw 'Uninstall ownership changed' }
    Assert-RetiredProcess $Plan.parentPid
    Assert-CompanionsStopped
    foreach ($entry in $Plan.files) {
        $null = Get-OwnedPath $entry.base $entry.path
        if ($entry.kind -eq 'file' -and $entry.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid file digest' }
    }
    foreach ($entry in $Plan.directories) { $null = Get-OwnedPath $entry.base $entry.path }
}
try {
    $userProfilePath = [IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile'))
    $base = Join-Path $userProfilePath '.providence'
    $paths = @{ installation = (Join-Path $base 'installation'); companion = (Join-Path $base 'companion') }
    Assert-Directory $userProfilePath; Assert-Directory $base
    Assert-Directory $paths.installation; Assert-Directory $paths.companion
    $inventoryPath = Get-OwnedPath 'installation' '.providence-owned.json'
    $lockPath = Get-OwnedPath 'installation' '.uninstall-lock'
    $planPath = Get-OwnedPath 'installation' '.uninstall-plan.json'
    Assert-NoInstall
    if (-not (Test-Path -LiteralPath $planPath)) {
        if (Test-Path -LiteralPath $lockPath) {
            # Recover only an unchanged interrupted old handoff with no parent
            # or descendant left. Preserve its inventory and configuration.
            $lockHash = File-Hash $lockPath; $inventoryHash = File-Hash $inventoryPath
            $oldOwner = Get-Content -Raw -LiteralPath $lockPath
            if ($oldOwner -cnotmatch '^[1-9][0-9]{0,9}$') { throw 'Invalid uninstall owner' }
            Assert-RetiredProcess ([long]$oldOwner); Assert-CompanionsStopped
            Start-Sleep -Milliseconds 100
            Assert-RetiredProcess ([long]$oldOwner); Assert-CompanionsStopped; Assert-NoInstall
            if ((File-Hash $lockPath) -cne $lockHash -or (File-Hash $inventoryPath) -cne $inventoryHash) { throw 'Uninstall state changed' }
            Remove-Item -LiteralPath $lockPath
        }
        Assert-RegularFile $NodePath; Assert-RegularFile $ModulePath
        $arguments = @('--prepare-windows-plan')
        if ($Yes) { $arguments += '--yes' }; if ($AllowOffline) { $arguments += '--allow-offline' }
        & $NodePath $ModulePath @arguments
        if ($LASTEXITCODE -ne 0) { throw 'Local shutdown or removal planning did not complete' }
        if (-not (Test-Path -LiteralPath $planPath)) { exit 0 } # Owner cancelled before removal.
    }
    $phase = 'ownership verification'
    $planHash = File-Hash $planPath
    $plan = Read-OwnedPlan $planPath
    Assert-PlanOwnership $plan
    Assert-PlanOwnership $plan
    if ((File-Hash $planPath) -cne $planHash) { throw 'Removal plan changed' }
    $phase = 'owned file cleanup'
    $remaining = New-Object 'Collections.Generic.List[string]'
    foreach ($existing in $plan.preserved) {
        try { $null = Get-Item -Force -LiteralPath $existing; $remaining.Add([string]$existing) }
        catch [Management.Automation.ItemNotFoundException] { }
        catch { $remaining.Add([string]$existing) }
    }
    foreach ($entry in $plan.files) {
        if ($entry.base -eq 'installation' -and $entry.path -eq '.providence-owned.json') { continue }
        Assert-NoInstall
        $file = Get-OwnedPath $entry.base $entry.path
        if (-not (Test-Path -LiteralPath $file)) { continue }
        $item = Get-Item -Force -LiteralPath $file
        if ($entry.kind -ne 'file' -or $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (File-Hash $file) -cne $entry.sha256) { $remaining.Add($file); continue }
        $removed = $false
        for ($attempt = 0; $attempt -lt 3; $attempt++) {
            try { Remove-Item -Force -LiteralPath $file; $removed = $true; break }
            catch { Start-Sleep -Milliseconds 300 }
        }
        if (-not $removed) { $remaining.Add($file) }
    }
    foreach ($entry in ($plan.directories | Sort-Object { $_.path.Length } -Descending)) {
        $directory = Get-OwnedPath $entry.base $entry.path
        if (-not (Test-Path -LiteralPath $directory)) { continue }
        try { Assert-Directory $directory; [IO.Directory]::Delete($directory, $false) }
        catch { $remaining.Add($directory) }
    }
    foreach ($name in @('companion','installation')) {
        if (-not (Test-Path -LiteralPath $paths[$name])) { continue }
        $left = @(Get-ChildItem -Force -LiteralPath $paths[$name] | Where-Object { $name -ne 'installation' -or $_.Name -notin @('.providence-owned.json','.uninstall-plan.json','.uninstall-lock') })
        if ($left.Count) { $remaining.Add($paths[$name]) }
    }
    if ($remaining.Count) {
        [Console]::Error.WriteLine('Providence cleanup is incomplete. Modified, unrelated, or locked files were preserved; ownership records remain for retry:')
        $remaining | Sort-Object -Unique | ForEach-Object { [Console]::WriteLine($_) }
        Write-RetryGuidance
    } else {
        # Last: remove only unchanged receipts/lock, then empty owned roots.
        $phase = 'final verification'
        Assert-PlanOwnership $plan
        if ((File-Hash $planPath) -cne $planHash) { throw 'Removal plan changed' }
        Remove-Item -LiteralPath $inventoryPath
        Remove-Item -LiteralPath $planPath
        Remove-Item -LiteralPath $lockPath
        foreach ($directory in @($paths.companion, $paths.installation)) { if (Test-Path -LiteralPath $directory) { Assert-Directory $directory; [IO.Directory]::Delete($directory, $false) } }
        $cleanupExitCode = 0
        [Console]::WriteLine('Providence-owned local files removed. Your workspace and existing Codex account were preserved.')
    }
    if ($plan.revocation -eq 'unconfirmed') { [Console]::WriteLine('Remote revocation still needs confirmation. Remove this computer at https://providence.hani.so/account when online.') }
} catch {
    [Console]::Error.WriteLine('Providence uninstall is incomplete during ' + $phase + '. Owned state was retained where possible; check permissions and process status before retrying.')
    Write-RetryGuidance
    $cleanupExitCode = 1
}
exit $cleanupExitCode
