# Update a Docker Compose deployment safely on Windows (Docker Desktop + WSL2).
#
#   powershell -ExecutionPolicy Bypass -File scripts\docker-update.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\docker-update.ps1 -Delay 10m
#
# Same behavior as scripts/docker-update.sh: pull first, back up, warn players through the
# in-game countdown, then recreate on the new image. If the image is current it exits without
# touching the container. The data volume is never recreated or deleted.
#
# Run from the repository root (or pass -ProjectDirectory).
[CmdletBinding()]
param(
    [string]$Delay = $(if ($env:TSPS_UPDATE_DELAY) { $env:TSPS_UPDATE_DELAY } else { "5m" }),
    [string]$ProjectDirectory = "",
    [switch]$SkipBackup
)

$ErrorActionPreference = "Stop"

if ($ProjectDirectory -eq "") {
    $ProjectDirectory = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
Set-Location $ProjectDirectory

function Log([string]$Message) { Write-Host "[docker-update] $Message" }

function Invoke-Docker {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    & docker @Args
    if ($LASTEXITCODE -ne 0) { throw "docker $($Args -join ' ') failed with exit code $LASTEXITCODE" }
}

function ConvertTo-Seconds([string]$Value) {
    if ($Value -match '^([0-9]+)([smh])?$') {
        $n = [int]$Matches[1]
        switch ($Matches[2]) {
            "h" { return $n * 3600 }
            "m" { return $n * 60 }
            default { return $n }
        }
    }
    throw "invalid -Delay '$Value' (use 30s, 5m or 1h)"
}

$SecondsToWait = ConvertTo-Seconds $Delay
if ($SecondsToWait -lt 10) { throw "-Delay must be at least 10s" }

try {
    Invoke-Docker compose ps | Out-Null

    $image = (& docker compose config --images) |
        Where-Object { $_ -notmatch 'beatkind/watchtower' } |
        Select-Object -First 1
    if (-not $image) { throw "could not resolve the app image from compose.yaml" }

    $container = (& docker compose ps -q app | Select-Object -First 1)
    if (-not $container) {
        Log "app is not running; starting it"
        Invoke-Docker compose up -d --no-deps app
        exit 0
    }

    Log "pulling $image"
    try {
        Invoke-Docker compose pull app
    } catch {
        Log "pull failed; the old container is untouched"
        exit 1
    }

    $oldImage = (& docker inspect --format '{{.Image}}' $container)
    $newImage = (& docker image inspect --format '{{.Id}}' $image 2>$null)
    if (-not $newImage) { Log "image $image is not present after pull; refusing to update"; exit 1 }
    if ($oldImage -eq $newImage) { Log "already running the newest image; nothing to do"; exit 0 }

    if ($SkipBackup) {
        Log "WARNING: -SkipBackup set; no pre-update backup will be taken"
    } else {
        Log "backing up the data volume first"
        try {
            Invoke-Docker compose --profile tools run --rm backup create
        } catch {
            Log "backup failed; the old container is untouched"
            exit 1
        }
    }

    Log "warning players: restarting in $Delay"
    try {
        Invoke-Docker compose exec -T app tsps-notify restart $Delay
    } catch {
        Log "could not start the countdown; the old container is left running"
        exit 1
    }

    $wait = $SecondsToWait + 5
    Log "waiting $wait seconds for the countdown"
    Start-Sleep -Seconds $wait

    Log "recreating the app on the new image"
    try {
        Invoke-Docker compose up -d --no-deps app
    } catch {
        Log "compose up failed. The data volume is intact; the old container may still be running."
        Log "retry with: docker compose up -d --no-deps app"
        exit 1
    }

    Log "waiting for the new container to become healthy"
    for ($i = 0; $i -lt 60; $i++) {
        $cid = (& docker compose ps -q app | Select-Object -First 1)
        if ($cid) {
            $health = (& docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $cid 2>$null)
            if ($health -eq "healthy" -or $health -eq "running") { Log "update complete"; exit 0 }
        }
        Start-Sleep -Seconds 3
    }
    Log "container started but did not report healthy within 3 minutes; check: docker compose logs app"
    exit 1
} catch {
    Log $_.Exception.Message
    exit 1
}
