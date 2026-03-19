param(
    [ValidateSet("dev", "default", "multitenant")]
    [string]$Profile = "dev",
    [switch]$DownFirst,
    [switch]$NoCache,
    [switch]$Pull,
    [switch]$NoWait,
    [string[]]$Services
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker CLI not found in PATH."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$composeDir = Resolve-Path (Join-Path $scriptDir "..\deployment\docker_compose")

$composeArgs = @("compose", "-p", "onyx")
switch ($Profile) {
    "dev" {
        $composeArgs += @("-f", "docker-compose.yml", "-f", "docker-compose.dev.yml")
    }
    "default" {
        $composeArgs += @("-f", "docker-compose.yml")
    }
    "multitenant" {
        $composeArgs += @("-f", "docker-compose.multitenant-dev.yml")
    }
}

Push-Location $composeDir
try {
    if ($DownFirst) {
        & docker @composeArgs down --remove-orphans
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }

    if ($Pull) {
        & docker @composeArgs pull
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }

    $buildArgs = @($composeArgs + @("build"))
    if ($NoCache) {
        $buildArgs += "--no-cache"
    }
    if ($Services -and $Services.Count -gt 0) {
        $buildArgs += $Services
    }

    & docker @buildArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    $upArgs = @($composeArgs + @("up", "-d", "--force-recreate"))
    if (-not $NoWait) {
        $upArgs += "--wait"
    }
    if ($Services -and $Services.Count -gt 0) {
        $upArgs += $Services
    }

    & docker @upArgs
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
