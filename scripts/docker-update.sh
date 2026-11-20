#!/usr/bin/env bash
# Update a Docker deployment safely: pull, back up, warn players, then recreate on the new image.
#
#   scripts/docker-update.sh                 # 5 minute countdown
#   scripts/docker-update.sh --delay=10m
#   scripts/docker-update.sh --delay=30s
#
# Safe for cron/systemd timers: when the image is already current it exits 0 without touching
# the running container. Any failure before the final `compose up` leaves the old container
# running. The data volume is never recreated or deleted.
#
# Requires: docker with the compose plugin, run from anywhere inside the checkout.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -n "${COMPOSE:-}" ]]; then
  read -r -a COMPOSE_CMD <<< "$COMPOSE"
else
  COMPOSE_CMD=(docker compose)
fi
DOCKER="${DOCKER:-docker}"
DELAY="${TSPS_UPDATE_DELAY:-5m}"
SKIP_BACKUP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --delay=*) DELAY="${1#*=}" ;;
    --delay) [[ $# -ge 2 ]] || { echo "docker-update: --delay needs a value" >&2; exit 2; }; DELAY="$2"; shift ;;
    --skip-backup) SKIP_BACKUP=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "docker-update: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

delay_seconds() {
  local value="$1"
  if [[ "$value" =~ ^([0-9]+)([smh])?$ ]]; then
    local n="${BASH_REMATCH[1]}" unit="${BASH_REMATCH[2]:-s}"
    case "$unit" in s) echo "$n" ;; m) echo $((n * 60)) ;; h) echo $((n * 3600)) ;; esac
  else
    return 1
  fi
}
SECONDS_TO_WAIT="$(delay_seconds "$DELAY")" || { echo "docker-update: invalid --delay $DELAY (use 30s, 5m or 1h)" >&2; exit 2; }
(( SECONDS_TO_WAIT >= 10 )) || { echo "docker-update: --delay must be at least 10s" >&2; exit 2; }

log() { printf '[docker-update] %s\n' "$*"; }

if ! "${COMPOSE_CMD[@]}" ps >/dev/null 2>&1; then
  log "cannot talk to Docker Compose here"
  exit 1
fi

IMAGE="$("${COMPOSE_CMD[@]}" config --images 2>/dev/null | grep -v '^beatkind/watchtower' | head -1)"
[[ -n "$IMAGE" ]] || { log "could not resolve the app image from compose.yaml"; exit 1; }

CONTAINER="$("${COMPOSE_CMD[@]}" ps -q app 2>/dev/null | head -1)"
if [[ -z "$CONTAINER" ]]; then
  log "app is not running; starting it"
  "${COMPOSE_CMD[@]}" up -d --no-deps app
  exit 0
fi

log "pulling $IMAGE"
if ! "${COMPOSE_CMD[@]}" pull app; then
  log "pull failed; the old container is untouched"
  exit 1
fi

OLD_IMAGE="$("$DOCKER" inspect --format '{{.Image}}' "$CONTAINER")"
NEW_IMAGE="$("$DOCKER" image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || true)"
if [[ -z "$NEW_IMAGE" ]]; then
  log "image $IMAGE is not present after pull; refusing to update"
  exit 1
fi
if [[ "$OLD_IMAGE" == "$NEW_IMAGE" ]]; then
  log "already running the newest image; nothing to do"
  exit 0
fi

if [[ "$SKIP_BACKUP" == "1" ]]; then
  log "WARNING: --skip-backup set; no pre-update backup will be taken"
else
  log "backing up the data volume first"
  if ! "${COMPOSE_CMD[@]}" --profile tools run --rm backup create; then
    log "backup failed; the old container is untouched"
    exit 1
  fi
fi

log "warning players: restarting in $DELAY"
if ! "${COMPOSE_CMD[@]}" exec -T app tsps-notify restart "$DELAY"; then
  log "could not start the countdown; the old container is left running"
  exit 1
fi

# Give the countdown time to run. A few extra seconds covers the last tick; the server saves
# players and exits 75, then compose recreates on the pulled image. If it has already exited and
# restart:unless-stopped brought the old image back, the compose up below replaces it.
WAIT=$((SECONDS_TO_WAIT + 5))
log "waiting ${WAIT}s for the countdown"
sleep "$WAIT"

log "recreating the app on the new image"
if ! "${COMPOSE_CMD[@]}" up -d --no-deps app; then
  log "compose up failed. The data volume is intact; the old container may still be running."
  log "retry with: docker compose up -d --no-deps app"
  exit 1
fi

log "waiting for the new container to become healthy"
for ((i = 0; i < 60; i++)); do
  status="$("${COMPOSE_CMD[@]}" ps --format json app 2>/dev/null | tr -d '\n' || true)"
  if [[ "$status" == *'"Health":"healthy"'* || "$status" == *'"State":"running"'* || "$status" == *'"Status":"running"'* ]]; then
    log "update complete"
    exit 0
  fi
  sleep 3
done

log "container started but did not report healthy within 3 minutes; check: docker compose logs app"
exit 1
