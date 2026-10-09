[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$NodeExecutable, [Parameter(Mandatory=$true)][string]$CodexExecutable)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('providence-supervisor-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
$powershell = (Get-Process -Id $PID).Path
$supervisor = Join-Path $PSScriptRoot 'supervise-windows.ps1'
Add-Type -Path (Join-Path $PSScriptRoot 'windows-companion-job.cs')
. (Join-Path $PSScriptRoot 'windows-supervisor-identity.ps1')
$owned = @()
$statePaths = [Collections.Generic.List[string]]::new()
$preflightPaths = [Collections.Generic.List[string]]::new()
$ownedJobs = @()
function Assert-True($condition, $message) { if (-not $condition) { throw $message } }
function Start-Fixture([string]$label, [int]$code, [int]$delay=0, [switch]$PrepareOnly) {
    $directory = Join-Path $fixtureRoot $label
    New-Item -ItemType Directory -Path (Join-Path $directory 'src'), (Join-Path $directory 'node_modules\tsx\dist') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $directory 'src\device.ts'), '// Inert fixture; no enrollment or network.')
    $fakeCli = @'
import fs from 'node:fs';
import {spawn} from 'node:child_process';
const c = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
fs.appendFileSync(c.counter, 'started\n');
if (c.descendant) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {stdio:'ignore'});
  fs.writeFileSync(c.descendant, String(child.pid));
}
setTimeout(() => process.exit(c.exitCode), c.delay);
'@
    [IO.File]::WriteAllText((Join-Path $directory 'node_modules\tsx\dist\cli.mjs'), $fakeCli)
    $config = Join-Path $directory 'device.fixture.json'
    $counter = Join-Path $directory 'starts.txt'
    $descendant = Join-Path $directory 'descendant.pid'
    [IO.File]::WriteAllText($config, (@{ deviceId=('fixture-' + [Guid]::NewGuid().ToString('N')); url='wss://offline.invalid/worker'; counter=$counter; exitCode=$code; delay=$delay; descendant=$descendant } | ConvertTo-Json))
    $state = Join-Path (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Providence\supervisors') (Get-ProvidenceEnrollmentIdentity $config)
    $statePaths.Add($state)
    $arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$supervisor,'-CoordinatorDirectory',$directory,'-ConfigPath',$config,'-NodeExecutable',$NodeExecutable,'-CodexExecutable',$CodexExecutable)
    $command = ($arguments | ForEach-Object { [ProvidenceWindowsJob]::Quote($_) }) -join ' '
    $process = $null
    if (-not $PrepareOnly) {
        $process = Start-Process -FilePath $powershell -ArgumentList $command -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $directory 'test.stdout') -RedirectStandardError (Join-Path $directory 'test.stderr')
        $null = $process.Handle
    }
    return @{process=$process;directory=$directory;config=$config;counter=$counter;descendant=$descendant;command=$command;state=$state}
}
try {
    foreach ($code in @(0,78,74,75)) {
        $f = Start-Fixture ('exit-' + $code) $code
        $owned += $f.process
        Assert-True ($f.process.WaitForExit(40000)) ('Supervisor timeout for ' + $code)
        if ($f.process.ExitCode -ne 0) { Get-Content -LiteralPath (Join-Path $f.directory 'test.stderr') | Write-Output }
        Assert-True ($f.process.ExitCode -eq 0) ('Supervisor failed for ' + $code)
        $starts = @(Get-Content -LiteralPath $f.counter).Count
        $expected = 1; if ($code -eq 75) { $expected = 4 }
        Assert-True ($starts -eq $expected) ('Incorrect restart count for ' + $code)
        Assert-True (Test-Path -LiteralPath (Join-Path $f.state 'stopped.json')) 'Missing persistent stop gate'
        $descendantPid = [int](Get-Content -LiteralPath $f.descendant)
        $descendantProcess = Get-Process -Id $descendantPid -ErrorAction SilentlyContinue
        Assert-True ($null -eq $descendantProcess) 'Owned descendant survived job disposal'
        $again = Start-Process -FilePath $powershell -ArgumentList $f.command -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $f.directory 'again.stdout') -RedirectStandardError (Join-Path $f.directory 'again.stderr')
        $null = $again.Handle
        $owned += $again
        Assert-True ($again.WaitForExit(10000)) 'Stopped-run check timeout'
        Assert-True ($again.ExitCode -ne 0) 'Terminal state was silently restarted'
        Assert-True (@(Get-Content -LiteralPath $f.counter).Count -eq $expected) 'Stopped-run gate spawned a child'
        if ($code -eq 78) {
            $copy = Join-Path $fixtureRoot 'copied-enrollment.json'
            Copy-Item -LiteralPath $f.config -Destination $copy
            $copyCommand = $f.command.Replace([ProvidenceWindowsJob]::Quote($f.config), [ProvidenceWindowsJob]::Quote($copy))
            $copyProcess = Start-Process -FilePath $powershell -ArgumentList $copyCommand -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $f.directory 'copy.stdout') -RedirectStandardError (Join-Path $f.directory 'copy.stderr')
            $null = $copyProcess.Handle; $owned += $copyProcess
            Assert-True ($copyProcess.WaitForExit(10000)) 'Copied enrollment check timeout'
            Assert-True ($copyProcess.ExitCode -ne 0) 'Copy bypassed enrollment terminal gate'
            Assert-True ((Get-Content -LiteralPath (Join-Path $f.directory 'copy.stderr') -Raw).Contains('previous run requires review')) 'Copy did not retain enrollment stop gate'
        }
        Write-Output "PASS exit ${code}: $expected start(s), persistent stop, descendant cleanup"
    }
    $f = Start-Fixture 'exclusive-owner' 0 15000
    $owned += $f.process
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $f.counter) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    Assert-True (Test-Path -LiteralPath $f.counter) 'Fixture did not start'
    $duplicate = Start-Process -FilePath $powershell -ArgumentList $f.command -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $f.directory 'duplicate.stdout') -RedirectStandardError (Join-Path $f.directory 'duplicate.stderr')
    $null = $duplicate.Handle
    $owned += $duplicate
    Assert-True ($duplicate.WaitForExit(10000)) 'Duplicate owner check timeout'
    Assert-True ($duplicate.ExitCode -ne 0) 'Duplicate owner accepted'
    $alias = Join-Path $fixtureRoot 'different-name-hardlink.json'
    New-Item -ItemType HardLink -Path $alias -Target $f.config | Out-Null
    $aliasCommand = $f.command.Replace([ProvidenceWindowsJob]::Quote($f.config), [ProvidenceWindowsJob]::Quote($alias))
    $aliasProcess = Start-Process -FilePath $powershell -ArgumentList $aliasCommand -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $f.directory 'alias.stdout') -RedirectStandardError (Join-Path $f.directory 'alias.stderr')
    $null = $aliasProcess.Handle; $owned += $aliasProcess
    Assert-True ($aliasProcess.WaitForExit(10000)) 'Alias ownership check timeout'
    Assert-True ($aliasProcess.ExitCode -ne 0) 'Hardlink/name alias bypassed ownership'
    Assert-True ((Get-Content -LiteralPath (Join-Path $f.directory 'alias.stderr') -Raw).Contains('Another supervisor owns this enrollment')) 'Alias was not rejected by identity mutex'
    Assert-True ($f.process.WaitForExit(20000)) 'Original owner failed to finish'
    Assert-True (@(Get-Content -LiteralPath $f.counter).Count -eq 1) 'Duplicate companion started'
    Write-Output 'PASS exclusive enrollment ownership including different-name hardlink alias'
    $f = Start-Fixture 'owner-loss' 0 60000
    $owned += $f.process
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $f.descendant) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    Assert-True (Test-Path -LiteralPath $f.descendant) 'Owner-loss fixture did not start'
    $descendantPid = [int](Get-Content -LiteralPath $f.descendant)
    $status = Get-Content -LiteralPath (Join-Path $f.state 'status.json') -Raw | ConvertFrom-Json
    $f.process.Kill(); $f.process.WaitForExit()
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $survivors = @(Get-Process -Id @([int]$status.childPid, $descendantPid) -ErrorAction SilentlyContinue)
        if ($survivors.Count -eq 0) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    Assert-True ($survivors.Count -eq 0) 'Supervisor loss left owned child processes alive'
    Write-Output 'PASS unexpected supervisor loss kills owned child tree'
    $f = Start-Fixture 'unmanaged-renamed' 0 60000 -PrepareOnly
    $renamedNode = Join-Path $fixtureRoot 'renamed-runtime.exe'
    Copy-Item -LiteralPath $NodeExecutable -Destination $renamedNode
    $job = [ProvidenceWindowsJob]::Start($renamedNode, @((Join-Path $f.directory 'node_modules\tsx\dist\cli.mjs'),(Join-Path $f.directory 'src\device.ts'),$f.config), $f.directory, (Join-Path $f.directory 'unmanaged.stdout'), (Join-Path $f.directory 'unmanaged.stderr'))
    $ownedJobs += $job
    $attempt = Start-Process -FilePath $powershell -ArgumentList $f.command -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $f.directory 'attempt.stdout') -RedirectStandardError (Join-Path $f.directory 'attempt.stderr')
    $null = $attempt.Handle; $owned += $attempt
    Assert-True ($attempt.WaitForExit(10000)) 'Unmanaged ownership check timeout'
    Assert-True ($attempt.ExitCode -ne 0) 'Renamed unmanaged runtime was missed'
    Assert-True ((Get-Content -LiteralPath (Join-Path $f.directory 'attempt.stderr') -Raw).Contains('An existing companion uses this enrollment')) 'Unmanaged rejection did not compare enrollment identity'
    $other = Start-Fixture 'same-name-other-enrollment' 0
    $owned += $other.process
    Assert-True ($other.process.WaitForExit(10000)) 'Distinct identity check timeout'
    Assert-True ($other.process.ExitCode -eq 0) 'Same config basename falsely blocked a distinct enrollment'
    $job.Dispose()
    Write-Output 'PASS renamed unmanaged runtime detection and same-basename distinct enrollment'
    $f = Start-Fixture 'missing-runtime-preflight' 0 -PrepareOnly
    Remove-Item -LiteralPath (Join-Path $f.directory 'src\device.ts')
    $attempt = Start-Process -FilePath $powershell -ArgumentList $f.command -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $f.directory 'missing.stdout') -RedirectStandardError (Join-Path $f.directory 'missing.stderr')
    $null = $attempt.Handle; $owned += $attempt
    Assert-True ($attempt.WaitForExit(10000)) 'Preflight check timeout'
    Assert-True ($attempt.ExitCode -ne 0) 'Missing runtime was accepted'
    Assert-True (Test-Path -LiteralPath (Join-Path $f.state 'stopped.json')) 'Missing runtime preflight did not persist terminal gate'
    Assert-True (-not (Test-Path -LiteralPath $f.counter)) 'Preflight failure started a worker'
    Write-Output 'PASS terminal runtime preflight persists without starting a child'
    $f = Start-Fixture 'invalid-identity-preflight' 0 -PrepareOnly
    $preflight = Join-Path (Split-Path $f.state -Parent) ('preflight-' + (Get-ProvidenceDigest ([IO.Path]::GetFullPath($f.config).ToLowerInvariant())) + '.json')
    $preflightPaths.Add($preflight)
    [IO.File]::WriteAllText($f.config, '{invalid-private-fixture-content')
    foreach ($attemptNumber in @(1,2)) {
        $errorLog = Join-Path $f.directory ("invalid-$attemptNumber.stderr")
        $attempt = Start-Process -FilePath $powershell -ArgumentList $f.command -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $f.directory ("invalid-$attemptNumber.stdout")) -RedirectStandardError $errorLog
        $null = $attempt.Handle; $owned += $attempt
        Assert-True ($attempt.WaitForExit(10000)) 'Invalid identity check timeout'
        Assert-True ($attempt.ExitCode -ne 0) 'Invalid identity was accepted'
        $errorText = Get-Content -LiteralPath $errorLog -Raw
        Assert-True (-not $errorText.Contains('invalid-private-fixture-content')) 'Config content leaked into error'
        if ($attemptNumber -eq 2) { Assert-True ($errorText.Contains('preflight previously failed')) 'Invalid-config gate did not suppress next invocation' }
    }
    Assert-True (Test-Path -LiteralPath $preflight) 'Invalid enrollment identity gate missing'
    Assert-True (-not (Test-Path -LiteralPath $f.counter)) 'Invalid config started a worker'
    Write-Output 'PASS invalid enrollment preflight persists and emits no config contents'
} finally {
    foreach ($job in $ownedJobs) { $job.Dispose() }
    foreach ($process in $owned) { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() } }
    $resolved = [IO.Path]::GetFullPath($fixtureRoot)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'providence-supervisor-test-*') { throw 'Fixture cleanup path rejected.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
    $expectedStateRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Providence\supervisors')).TrimEnd('\')
    foreach ($state in $statePaths) {
        $resolvedState = [IO.Path]::GetFullPath($state)
        if ([IO.Path]::GetDirectoryName($resolvedState) -ne $expectedStateRoot -or [IO.Path]::GetFileName($resolvedState) -notmatch '^[a-f0-9]{64}$') { throw 'Fixture state cleanup path rejected.' }
        if (Test-Path -LiteralPath $resolvedState) { Remove-Item -LiteralPath $resolvedState -Recurse -Force }
    }
    foreach ($preflight in $preflightPaths) {
        if ([IO.Path]::GetDirectoryName($preflight) -ne $expectedStateRoot -or [IO.Path]::GetFileName($preflight) -notmatch '^preflight-[a-f0-9]{64}\.json$') { throw 'Preflight cleanup path rejected.' }
        if (Test-Path -LiteralPath $preflight) { Remove-Item -LiteralPath $preflight }
    }
}
