[CmdletBinding()]
param([switch]$Runner, [switch]$Pull)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Avoid per-byte Windows PowerShell progress overhead on large archives.
Set-Location (Split-Path -Parent $PSScriptRoot)

function Invoke-Docker([string[]]$DockerArguments) {
    & docker @DockerArguments
    if ($LASTEXITCODE -ne 0) { throw "Docker command failed (exit $LASTEXITCODE). Check Docker Desktop and the messages above." }
}
function New-Secret {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}
try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install and start Docker Desktop with the WSL 2 Linux-container backend.' }
    & docker compose version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 is required. Start or update Docker Desktop.' }
    $daemon = & docker info --format '{{.OSType}}/{{.Architecture}}'
    if ($LASTEXITCODE -ne 0) { throw 'Docker is not ready. Start Docker Desktop and wait for the engine.' }
    switch ($daemon.Trim()) {
        { $_ -in 'linux/amd64', 'linux/x86_64' } { $architecture = 'amd64'; break }
        { $_ -in 'linux/arm64', 'linux/aarch64' } { $architecture = 'arm64'; break }
        default { throw "Unsupported Docker engine: $daemon. Select Linux containers (amd64 or arm64)." }
    }
    $envFile = Join-Path (Get-Location) '.compose.env'
    if (-not (Test-Path -LiteralPath $envFile)) {
        $initial = "WA_DB_PASSWORD=$(New-Secret)`nWA_DB_ROOT_PASSWORD=$(New-Secret)`nWA_PORT=5188`nWA_PUBLIC_URL=http://localhost:5188`n"
        [IO.File]::WriteAllText($envFile, $initial, [Text.Encoding]::ASCII)
    }
    if ($Pull) {
        $version = (Get-Content -LiteralPath 'release/version' -Raw).Trim()
        if ($version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$') { throw 'Invalid release/version' }
        foreach ($kind in @('CONSOLE', 'RUNNER')) {
            if (-not (Select-String -LiteralPath $envFile -Pattern "^WA_${kind}_IMAGE=" -Quiet)) {
                $image = "WA_${kind}_IMAGE=ghcr.io/jeanron100/web-agents-oss-$($kind.ToLowerInvariant()):$version`n"
                [IO.File]::AppendAllText($envFile, $image, [Text.Encoding]::ASCII)
            }
        }
    }
    $composeArgs = @('compose', '--env-file', '.compose.env', '-f', 'compose.yaml')
    if ($Runner) { $composeArgs += @('-f', 'compose.runner.yaml') }
    if ($Pull) {
        $services = @('console')
        if ($Runner) { $services += 'runner' }
        & docker @composeArgs pull @services
        if ($LASTEXITCODE -ne 0) {
            $images = @(& docker @composeArgs config --images)
            if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect configured images.' }
            foreach ($kind in $services) {
                if ($images -notcontains "ghcr.io/jeanron100/web-agents-oss-${kind}:$version") { throw 'Custom image pull failed; check its registry and credentials. References were preserved.' }
            }
            $archiveDir = Join-Path ([IO.Path]::GetTempPath()) ('web-agents-images-' + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $archiveDir | Out-Null
            try {
                $archive = "web-agents-images-linux-$architecture.tar.gz"
                $releaseUrl = "https://github.com/jeanron100/web-agents-oss/releases/download/$version"
                # Windows PowerShell 5.1 may otherwise negotiate an obsolete TLS protocol.
                [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
                Write-Host 'Using the verified public Release image archive...'
                Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/$archive" -OutFile (Join-Path $archiveDir $archive)
                $checksumFile = Join-Path $archiveDir 'checksum'
                Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/$archive.sha256" -OutFile $checksumFile
                $checksumText = Get-Content -LiteralPath $checksumFile -Raw
                $pattern = '(?m)^([a-f0-9]{64})[ \t]+\*?' + [regex]::Escape($archive) + '\r?$'
                if ($checksumText -notmatch $pattern) { throw 'Invalid archive checksum file.' }
                $expected = $Matches[1]
                $archivePath = Join-Path $archiveDir $archive
                $hashEngine = [Security.Cryptography.SHA256]::Create()
                $archiveStream = [IO.File]::OpenRead($archivePath)
                try { $actual = ([BitConverter]::ToString($hashEngine.ComputeHash($archiveStream))).Replace('-', '').ToLowerInvariant() }
                finally { $archiveStream.Dispose(); $hashEngine.Dispose() }
                if ($actual -ne $expected) { throw 'Release image archive checksum mismatch. Nothing loaded.' }
                Invoke-Docker @('load', '--input', $archivePath)
            } finally { Remove-Item -LiteralPath $archiveDir -Recurse -Force }
        }
        Invoke-Docker ($composeArgs + @('up', '-d', '--pull', 'missing', '--no-build', '--wait', '--wait-timeout', '240'))
    } else {
        Invoke-Docker ($composeArgs + @('up', '-d', '--build', '--wait', '--wait-timeout', '240'))
    }
    Write-Host 'Console ready.'
    Write-Host 'Fresh installations: admin / admin123; set a new password after signing in.'
    Write-Host 'Existing accounts and passwords are preserved. If WA_INITIAL_ACCOUNT=0, use manage.mjs setup-token.'
    Write-Host 'Open WA_PUBLIC_URL configured in .compose.env (default http://localhost:5188).'
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
