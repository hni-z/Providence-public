param([switch]$ConfigureKey, [string]$WorkspaceFolder)
# Run in your own PowerShell window. No Administrator session is required.
# & ([scriptblock]::Create((irm -MaximumRedirection 0 https://providence.hani.so/install.ps1)))
# Append -ConfigureKey for a key update, or -WorkspaceFolder for an advanced first-setup folder.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($args.Count -ne 0) { throw 'Unexpected arguments. Never put API keys in a command.' }
if ($ConfigureKey -and $WorkspaceFolder) { throw 'Folder selection is for computer setup; omit it with -ConfigureKey.' }
if ($PSBoundParameters.ContainsKey('WorkspaceFolder') -and [string]::IsNullOrWhiteSpace($WorkspaceFolder)) { throw 'Provide an absolute working folder.' }
if ($PSVersionTable.PSVersion.Major -lt 5) { throw 'PowerShell 5.1 or newer is required.' }
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows uses this installer. macOS and Linux use install.sh; iPhone and Apple Watch need their native app.' }

function New-PrivateDirectory([string]$Path) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -Force -LiteralPath $Path
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Unsafe install directory: $Path" }
    } else { $null = New-Item -ItemType Directory -Path $Path }
    $sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
    $before = [Security.AccessControl.DirectorySecurity]::new($Path, $sections)
    if ($before.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw "Install directory is owned by another account and was left untouched: $Path" }
    # Persist only the DACL. Set-Acl may also request audit/SACL privileges that
    # a normal user does not have. Do not read/write audits or change ownership.
    $acl = [Security.AccessControl.DirectorySecurity]::new($Path, [Security.AccessControl.AccessControlSections]::Access)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in $acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) { $acl.PurgeAccessRules($rule.IdentityReference) }
    $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    foreach ($identity in @($sid, $systemSid)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    $item = Get-Item -Force -LiteralPath $Path
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Unsafe install directory: $Path" }
    if ($PSVersionTable.PSVersion.Major -ge 6) { [IO.FileSystemAclExtensions]::SetAccessControl($item, $acl) }
    else { [IO.Directory]::SetAccessControl($Path, $acl) }
    $verified = [Security.AccessControl.DirectorySecurity]::new($Path, $sections)
    if ($verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or -not $verified.AreAccessRulesProtected) { throw "Private directory permissions could not be verified: $Path" }
    $rules = @($verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 2) { throw "Private directory permissions could not be verified: $Path" }
    $seen = @{}
    foreach ($rule in $rules) {
        $identity = $rule.IdentityReference.Value
        if (($identity -ne $sid.Value -and $identity -ne $systemSid.Value) -or $seen.ContainsKey($identity) -or $rule.IsInherited -or
            $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
            $rule.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or
            $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw "Private directory permissions could not be verified: $Path" }
        $seen[$identity] = $true
    }
}

function Get-VerifiedDownload([string]$Url, [string]$Path, [long]$MaximumBytes) {
    if (-not $Url.StartsWith('https://', [StringComparison]::Ordinal)) { throw 'Only HTTPS downloads are allowed.' }
    # Do not follow redirects or weaken certificate verification.
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path -MaximumRedirection 0 -TimeoutSec 600 | Out-Null
    $length = (Get-Item -LiteralPath $Path).Length
    if ($length -le 0 -or $length -gt $MaximumBytes) { throw 'A required download had an unexpected size.' }
}

function Assert-Hash([string]$Path, [string]$Expected) {
    if ($Expected -cnotmatch '^[a-f0-9]{64}$' -or (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() -cne $Expected) { throw 'Archive checksum mismatch. Nothing was extracted.' }
}

function Expand-VerifiedZip([string]$Path, [string]$Destination, [string]$Prefix) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
    $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    try {
        if ($archive.Entries.Count -eq 0) { throw 'The archive is empty.' }
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName
            $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
            if (-not $name.StartsWith($Prefix + '/', [StringComparison]::Ordinal) -or $name -notmatch '^[A-Za-z0-9_./@+() ~-]+$' -or $name -match '(^|/)\.\.(/|$)' -or ($unixType -ne 0 -and $unixType -ne 0x8000 -and $unixType -ne 0x4000) -or -not $seen.Add($name)) { throw 'The ZIP contains an unsafe or duplicate entry.' }
        }
        foreach ($entry in $archive.Entries) {
            $target = Join-Path $Destination $entry.FullName
            if ($entry.FullName.EndsWith('/')) { $null = New-Item -ItemType Directory -Force -Path $target; continue }
            $null = New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($target))
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
        }
    } finally { $archive.Dispose() }
}

$originalPath = $env:PATH
$originalCodex = $env:CODEX_BIN
$originalTls = [Net.ServicePointManager]::SecurityProtocol
$stage = $null
$lock = $null
$exitStatus = 0
try {
    [Net.ServicePointManager]::SecurityProtocol = $originalTls -bor [Net.SecurityProtocolType]::Tls12
    try { $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() }
    catch { $architecture = $env:PROCESSOR_ARCHITEW6432; if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE } }
    switch -Regex ($architecture) {
        '^(X64|AMD64)$' { $arch = 'x64'; $expectedNodeHash = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71'; break }
        '^ARM64$' { $arch = 'arm64'; $expectedNodeHash = '33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535'; break }
        default { throw 'Unsupported Windows processor. x64 or ARM64 is required.' }
    }
    $profileDirectory = [Environment]::GetFolderPath('UserProfile')
    if (-not $profileDirectory) { throw 'Your home directory could not be located.' }
    $providenceRoot = Join-Path $profileDirectory '.providence'
    if ((Test-Path -LiteralPath $providenceRoot) -and ((Get-Item -Force -LiteralPath $providenceRoot).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'The Providence directory must not be a reparse point.' }
    $root = Join-Path $providenceRoot 'installation'
    $null = New-Item -ItemType Directory -Force -Path $providenceRoot
    New-PrivateDirectory $root
    # Device credentials belong to the current user, including on Windows where
    # POSIX mode 0600 alone does not restrict access.
    New-PrivateDirectory (Join-Path $providenceRoot 'companion')
    New-PrivateDirectory (Join-Path $root 'runtimes')
    New-PrivateDirectory (Join-Path $root 'releases')
    $lockPath = Join-Path $root '.install-lock'
    if (Test-Path -LiteralPath (Join-Path $root '.uninstall-lock')) { throw 'An uninstall is active or needs attention. Check its completion before reinstalling.' }
    try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
    catch { throw "Another install is active, or an interrupted install left $lockPath. Check it before retrying." }
    if (Test-Path -LiteralPath (Join-Path $root '.uninstall-lock')) { throw 'An uninstall started concurrently. Nothing was downloaded or activated.' }
    $stage = Join-Path $root ('.install-' + [Guid]::NewGuid().ToString('N'))
    New-PrivateDirectory $stage
    $manifestFile = Join-Path $stage 'manifest.json'
    Get-VerifiedDownload 'https://providence.hani.so/downloads/companion-manifest.json' $manifestFile 65536
    $manifest = Get-Content -Raw -LiteralPath $manifestFile | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.nodeVersion -cne '22.23.3' -or $manifest.codexVersion -cne '0.157.1' -or $manifest.version -cnotmatch '^[a-f0-9]{64}$' -or $manifest.archiveZipSha256 -cnotmatch '^[a-f0-9]{64}$' -or $manifest.archiveTarGzSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid install manifest.' }
    $archiveBase = 'https://providence.hani.so/downloads/' + $manifest.version + '/providence-companion'
    if ($manifest.archiveZipUrl -cne ($archiveBase + '.zip') -or $manifest.archiveTarGzUrl -cne ($archiveBase + '.tar.gz')) { throw 'Untrusted archive location.' }
    $nodeHash = $manifest.('node_win_' + $arch + '_sha256')
    if ($nodeHash -cne $expectedNodeHash) { throw 'The manifest does not match the pinned Node runtime.' }
    $runtimeName = 'node-v22.23.3-win-' + $arch
    $runtime = Join-Path (Join-Path $root 'runtimes') $runtimeName
    $runtimeMarker = Join-Path $runtime '.providence-archive-sha256'
    if (Test-Path -LiteralPath $runtime) {
        if (((Get-Item -Force -LiteralPath $runtime).Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not (Test-Path -LiteralPath $runtimeMarker) -or (Get-Content -Raw -LiteralPath $runtimeMarker).Trim() -cne $nodeHash) { throw "Existing runtime is unrecognized and was left untouched: $runtime" }
    } else {
        Write-Host ('Installing private Node.js 22.23.3 for Windows ' + $arch + '...')
        $nodeArchive = Join-Path $stage 'node.zip'
        Get-VerifiedDownload ('https://nodejs.org/dist/v22.23.3/' + $runtimeName + '.zip') $nodeArchive 150000000
        Assert-Hash $nodeArchive $nodeHash
        Expand-VerifiedZip $nodeArchive $stage $runtimeName
        $runtimeStage = Join-Path $stage $runtimeName
        [IO.File]::WriteAllText((Join-Path $runtimeStage '.providence-archive-sha256'), $nodeHash + "`n")
        Move-Item -LiteralPath $runtimeStage -Destination $runtime
    }
    $node = Join-Path $runtime 'node.exe'
    $npmCli = Join-Path $runtime 'node_modules/npm/bin/npm-cli.js'
    $nodeVersion = & $node -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -cne '22.23.3') { throw 'The private Node runtime cannot run on this Windows version. Windows 10 or newer is required.' }
    $env:PATH = $runtime + [IO.Path]::PathSeparator + $originalPath
    $release = Join-Path (Join-Path $root 'releases') $manifest.version
    $releaseMarker = Join-Path $release '.providence-archive-sha256'
    if (Test-Path -LiteralPath $release) {
        if (((Get-Item -Force -LiteralPath $release).Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not (Test-Path -LiteralPath $releaseMarker) -or (Get-Content -Raw -LiteralPath $releaseMarker).Trim() -cne $manifest.archiveZipSha256 -or -not (Test-Path -LiteralPath (Join-Path $release 'coordinator/scripts/connect.mjs'))) { throw "Existing release is incomplete or unrecognized and was left untouched: $release" }
    } else {
        Write-Host 'Downloading and verifying Providence...'
        $companionArchive = Join-Path $stage 'companion.zip'
        Get-VerifiedDownload $manifest.archiveZipUrl $companionArchive 20000000
        Assert-Hash $companionArchive $manifest.archiveZipSha256
        Expand-VerifiedZip $companionArchive $stage 'providence-companion'
        $source = Join-Path $stage 'providence-companion'
        foreach ($required in @('coordinator/scripts/connect.mjs', 'coordinator/package-lock.json', 'coordinator/install/prepare-codex.mjs')) {
            if (-not (Test-Path -LiteralPath (Join-Path $source $required) -PathType Leaf)) { throw 'The companion archive is incomplete.' }
        }
        Push-Location (Join-Path $source 'coordinator')
        try {
            & $node $npmCli ci --ignore-scripts --include=dev --include=optional --no-audit --no-fund --update-notifier=false --registry=https://registry.npmjs.org --cache (Join-Path $source 'coordinator/.npm-cache')
            if ($LASTEXITCODE -ne 0) { throw 'Locked companion dependency installation failed.' }
        } finally { Pop-Location }
        [IO.File]::WriteAllText((Join-Path $source '.providence-archive-sha256'), $manifest.archiveZipSha256 + "`n")
        Copy-Item -LiteralPath $manifestFile -Destination (Join-Path $source '.providence-manifest.json')
        Move-Item -LiteralPath $source -Destination $release
    }
    & $node (Join-Path $release 'coordinator/install/uninstall.mjs') --register > $null
    if ($LASTEXITCODE -ne 0) { throw 'The local uninstall entry could not be saved safely.' }
    if (-not $ConfigureKey) {
        Write-Host 'Checking the installed Codex runtime...'
        $codex = & $node (Join-Path $release 'coordinator/install/prepare-codex.mjs') (Join-Path $root 'runtimes') $npmCli
        if ($LASTEXITCODE -ne 0 -or -not $codex) { throw 'Codex setup failed.' }
        $env:CODEX_BIN = $codex
        & $node (Join-Path $release 'coordinator/install/uninstall.mjs') --register > $null
        if ($LASTEXITCODE -ne 0) { throw 'The private runtime ownership record could not be updated.' }
    }
    Remove-Item -Recurse -Force -LiteralPath $stage
    $stage = $null
    $lock.Dispose(); $lock = $null
    Remove-Item -Force -LiteralPath $lockPath
    Push-Location (Join-Path $release 'coordinator')
    try {
        if ($ConfigureKey) { & $node scripts/connect.mjs --configure-key }
        elseif ($WorkspaceFolder) { & $node scripts/connect.mjs --full-access --workspace-folder $WorkspaceFolder }
        else { & $node scripts/connect.mjs --full-access }
        $exitStatus = $LASTEXITCODE
    } finally { Pop-Location }
} finally {
    if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -Recurse -Force -LiteralPath $stage }
    if ($lock) { $lock.Dispose(); Remove-Item -Force -LiteralPath $lockPath }
    $env:PATH = $originalPath
    $env:CODEX_BIN = $originalCodex
    [Net.ServicePointManager]::SecurityProtocol = $originalTls
}
if ($exitStatus -ne 0) { throw "Providence exited with status $exitStatus." }
