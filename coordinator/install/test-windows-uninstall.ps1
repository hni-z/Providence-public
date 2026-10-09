param([Parameter(Mandatory=$true)][string]$NodePath, [Parameter(Mandatory=$true)][string]$ControllerPath)
# Synthetic temporary roots only. No installed Providence state, keys, or tasks.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$controller = Get-Content -Raw -LiteralPath $ControllerPath
$needle = "[Environment]::GetFolderPath('UserProfile')"
if (-not $controller.Contains($needle)) { throw 'The controller fixture boundary changed.' }
$originalFixtureHome = $env:PROVIDENCE_UNINSTALL_FIXTURE_HOME
$originalFixtureMode = $env:PROVIDENCE_UNINSTALL_FIXTURE_MODE
$passed = 0
try {
    foreach ($mode in @('success','stale-lock','unknown-stop','changed-file','live-owner')) {
        $fixture = Join-Path ([IO.Path]::GetTempPath()) ('Providence-uninstall-test-' + [Guid]::NewGuid().ToString('N'))
        $installation = Join-Path $fixture '.providence/installation'
        $companion = Join-Path $fixture '.providence/companion'
        $null = New-Item -ItemType Directory -Force -Path (Join-Path $installation 'runtimes'), $companion
        $payload = Join-Path $installation 'runtimes/owned.txt'
        $inventory = Join-Path $installation '.providence-owned.json'
        $workspace = Join-Path $fixture 'workspace.txt'
        $module = Join-Path $fixture 'synthetic-planner.mjs'
        [IO.File]::WriteAllText($payload, 'owned fixture')
        [IO.File]::WriteAllText($inventory, 'fixture inventory')
        [IO.File]::WriteAllText($workspace, 'preserve user work')
        [IO.File]::WriteAllText($module, @'
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const home=process.env.PROVIDENCE_UNINSTALL_FIXTURE_HOME, mode=process.env.PROVIDENCE_UNINSTALL_FIXTURE_MODE;
if(!home || !home.includes('Providence-uninstall-test-') || !process.argv.includes('--prepare-windows-plan'))process.exit(9);
if(mode==='unknown-stop')process.exit(7);
const installation=join(home,'.providence/installation'),hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const files=['runtimes/owned.txt','.providence-owned.json'].map(path=>({base:'installation',path,kind:'file',sha256:hash(join(installation,path))}));
const plan={schemaVersion:1,home,parentPid:process.pid,revocation:'not-needed',files,directories:[{base:'installation',path:'runtimes'}],preserved:[]};
writeFileSync(join(installation,'.uninstall-lock'),String(process.pid),{flag:'wx'});
writeFileSync(join(installation,'.uninstall-plan.json'),JSON.stringify(plan),{flag:'wx'});
if(mode==='changed-file')writeFileSync(join(installation,'runtimes/owned.txt'),'user change');
console.log('Synthetic planner exited before cleanup.');
'@)
        try {
            if ($mode -eq 'stale-lock') {
                $retired = & $NodePath -e 'process.stdout.write(String(process.pid))'
                if ($LASTEXITCODE -ne 0) { throw 'Fixture process failed.' }
                [IO.File]::WriteAllText((Join-Path $installation '.uninstall-lock'), [string]$retired)
            } elseif ($mode -eq 'live-owner') { [IO.File]::WriteAllText((Join-Path $installation '.uninstall-lock'), [string]$PID) }
            $env:PROVIDENCE_UNINSTALL_FIXTURE_HOME = $fixture
            $env:PROVIDENCE_UNINSTALL_FIXTURE_MODE = $mode
            # Substitute only the fixed profile root in an in-memory fixture
            # copy, and turn process exit into a returned status for assertions.
            $quoted = "'" + $fixture.Replace("'", "''") + "'"
            $program = $controller.Replace($needle, $quoted).Replace('exit $cleanupExitCode', 'return $cleanupExitCode').Replace('exit 0 }', 'return 0 }')
            $output = @(& ([scriptblock]::Create($program)) -NodePath $NodePath -ModulePath $module -Yes)
            $result = [int]$output[-1]
            if ($mode -in @('success','stale-lock')) {
                if ($result -ne 0 -or (Test-Path -LiteralPath $installation) -or (Test-Path -LiteralPath $companion)) { throw ('Cleanup did not finish synchronously: ' + $mode) }
            } else {
                if ($result -ne 1 -or -not (Test-Path -LiteralPath $inventory) -or -not (Test-Path -LiteralPath $payload)) { throw ('Uncertain cleanup was not preserved: ' + $mode) }
            }
            if ([IO.File]::ReadAllText($workspace) -cne 'preserve user work' -or -not (Test-Path -LiteralPath $module)) { throw 'Fixture user/source files changed.' }
            $passed++
            Write-Output ('PASS: ' + $mode)
        } finally { Remove-Item -LiteralPath $fixture -Recurse -Force }
    }
} finally {
    $env:PROVIDENCE_UNINSTALL_FIXTURE_HOME = $originalFixtureHome
    $env:PROVIDENCE_UNINSTALL_FIXTURE_MODE = $originalFixtureMode
}
Write-Output ('PASS: ' + $passed + ' foreground Windows uninstall fixtures; no installed state accessed.')
