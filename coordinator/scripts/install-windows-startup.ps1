# Invoke only after the combined runtime is reviewed and the idle transition is approved.
[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [Parameter(Mandatory=$true)][string]$CoordinatorDirectory,
    [Parameter(Mandatory=$true)][string]$ConfigPath,
    [Parameter(Mandatory=$true)][string]$NodeExecutable,
    [Parameter(Mandatory=$true)][string]$CodexExecutable
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Windows user-session installer required.' }
$launcher = Join-Path $PSScriptRoot 'supervise-windows.ps1'
foreach ($path in @($launcher, $ConfigPath, $NodeExecutable, $CodexExecutable)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'A required existing launcher file is missing.' }
}
$CoordinatorDirectory = (Resolve-Path -LiteralPath $CoordinatorDirectory).ProviderPath
$ConfigPath = (Resolve-Path -LiteralPath $ConfigPath).ProviderPath
$NodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).ProviderPath
$CodexExecutable = (Resolve-Path -LiteralPath $CodexExecutable).ProviderPath
Add-Type -Path (Join-Path $PSScriptRoot 'windows-companion-job.cs')
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$launcher,'-CoordinatorDirectory',$CoordinatorDirectory,'-ConfigPath',$ConfigPath,'-NodeExecutable',$NodeExecutable,'-CodexExecutable',$CodexExecutable)
$command = ($arguments | ForEach-Object { [ProvidenceWindowsJob]::Quote($_) }) -join ' '
$startup = [Environment]::GetFolderPath('Startup')
if (-not $startup) { throw 'Current-user Startup folder unavailable.' }
$name = 'Providence-' + [IO.Path]::GetFileNameWithoutExtension($ConfigPath) + '.lnk'
$destination = Join-Path $startup $name
if (Test-Path -LiteralPath $destination) { throw 'A startup entry already exists. Review its target before deliberately replacing it.' }
if ($PSCmdlet.ShouldProcess($destination, 'Install current-user companion startup shortcut')) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($destination)
    $shortcut.TargetPath = $powershell
    $shortcut.Arguments = $command
    $shortcut.WorkingDirectory = $CoordinatorDirectory
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'Providence existing-enrollment user-session companion supervisor'
    $shortcut.Save()
    Write-Output $destination
}
