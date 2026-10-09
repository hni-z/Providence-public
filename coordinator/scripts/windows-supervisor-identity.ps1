function Get-ProvidenceDigest([string]$value) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($value)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Get-ProvidenceEnrollmentIdentity([string]$path) {
    # Return only a digest of public registration identity, never config contents/errors.
    try {
        $saved = [IO.File]::ReadAllText($path) | ConvertFrom-Json
        if ($saved.deviceId -isnot [string] -or $saved.deviceId -cnotmatch '^[a-zA-Z0-9_-]+$') { throw 'invalid' }
        $url = [Uri]$saved.url
        if (-not $url.IsAbsoluteUri -or $url.Scheme -notin @('ws','wss') -or $url.UserInfo -or $url.Query -or $url.Fragment -or $url.AbsolutePath -cne '/worker') { throw 'invalid' }
        $identity = $url.GetLeftPart([UriPartial]::Authority).ToLowerInvariant() + '/worker' + "`n" + $saved.deviceId
        return Get-ProvidenceDigest $identity
    } catch { throw 'Existing enrollment identity cannot be validated; review the private configuration.' }
    finally { $saved = $null }
}
function Assert-NoProvidenceCompanion([string]$identity) {
    # Do not assume the executable is called node.exe. Parse real argv, then compare
    # validated registration identity instead of substrings or configuration filenames.
    foreach ($candidate in Get-CimInstance Win32_Process) {
        if (-not $candidate.CommandLine -or $candidate.CommandLine -notmatch 'device\.ts') { continue }
        $argv = [ProvidenceWindowsJob]::Arguments($candidate.CommandLine)
        for ($i = 1; $i -lt $argv.Length; $i++) {
            if ($argv[$i] -notmatch '(^|[\\/])device\.ts$') { continue }
            if ($i + 1 -ge $argv.Length -or -not [IO.Path]::IsPathRooted($argv[$i + 1])) {
                throw 'An existing companion has ambiguous configuration ownership; no process was changed.'
            }
            $otherIdentity = Get-ProvidenceEnrollmentIdentity $argv[$i + 1]
            if ($otherIdentity -ceq $identity) { throw 'An existing companion uses this enrollment; coordinate an idle transition first.' }
        }
    }
}
