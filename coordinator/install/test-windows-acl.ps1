param([Parameter(Mandatory=$true)][string]$InstallerPath)
# Test only the installer ACL function on newly created temporary fixtures.
# Does not run downloads, enrollment, startup, or read Providence credentials.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This fixture requires Windows.' }
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this fixture in non-elevated PowerShell.' }
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $InstallerPath).Path, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'The installer did not parse.' }
$definitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'New-PrivateDirectory' }, $false))
if ($definitions.Count -ne 1) { throw 'Expected exactly one private-directory function.' }
. ([scriptblock]::Create($definitions[0].Extent.Text))

function Save-FixtureAcl([string]$Path, $Acl) {
    if ($PSVersionTable.PSVersion.Major -ge 6) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Path), $Acl) }
    else { [IO.Directory]::SetAccessControl($Path, $Acl) }
}

$fixture = Join-Path ([IO.Path]::GetTempPath()) ('Providence-acl-test-' + [Guid]::NewGuid().ToString('N'))
$junction = Join-Path $fixture 'linked'
$null = New-Item -ItemType Directory -Path $fixture
try {
    $fresh = Join-Path $fixture 'fresh'
    New-PrivateDirectory $fresh
    $marker = Join-Path $fresh 'marker.txt'
    [IO.File]::WriteAllText($marker, 'fixture-preserved')
    $acl = [Security.AccessControl.DirectorySecurity]::new($fresh, [Security.AccessControl.AccessControlSections]::Access)
    $everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    $acl.SetAccessRuleProtection($false, $true)
    Save-FixtureAcl $fresh $acl
    New-PrivateDirectory $fresh
    New-PrivateDirectory $fresh
    if ([IO.File]::ReadAllText($marker) -cne 'fixture-preserved') { throw 'Existing file content changed.' }
    $refused = $false
    try { New-PrivateDirectory $marker } catch { $refused = $true }
    if (-not $refused) { throw 'An existing file was not refused.' }

    $target = Join-Path $fixture 'junction-target'
    $null = New-Item -ItemType Directory -Path $target
    $access = [Security.AccessControl.AccessControlSections]::Access
    $before = [Security.AccessControl.DirectorySecurity]::new($target, $access).GetSecurityDescriptorSddlForm($access)
    $null = New-Item -ItemType Junction -Path $junction -Target $target
    $refused = $false
    try { New-PrivateDirectory $junction } catch { $refused = $true }
    if (-not $refused) { throw 'A reparse point was not refused.' }
    $after = [Security.AccessControl.DirectorySecurity]::new($target, $access).GetSecurityDescriptorSddlForm($access)
    if ($before -cne $after) { throw 'The junction target permissions changed.' }
    Write-Output ('PASS: PowerShell ' + $PSVersionTable.PSVersion + '; non-elevated private creation, broad-grant removal, repeat setup, existing-file and junction refusal.')
} finally {
    if (Test-Path -LiteralPath $junction) { [IO.Directory]::Delete($junction) }
    Remove-Item -LiteralPath $fixture -Recurse -Force
}
