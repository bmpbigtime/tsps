#!/usr/bin/env bash
# End-to-end smoke test for the Docker image, runnable on a machine with Docker:
#
#   docker/ci-smoke.sh
#
# Builds the amd64 image, starts it through compose with a read-only root filesystem, waits for
# the game server, checks the data-only diff, exercises the countdown trigger, backs up, and
# confirms a graceful stop saves players. Intended for CI; it downloads the game cache.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TAG="${TSPS_SMOKE_TAG:-smoke}"
export TSPS_IMAGE_TAG="$TAG"
IMAGE="ghcr.io/rspsapp/tsps:${TAG}"
COMPOSE=(docker compose)

log() { printf '[docker-smoke] %s\n' "$*"; }
fail() { log "FAIL: $*"; exit 1; }

cleanup() {
  "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "building $IMAGE"
docker build -t "$IMAGE" .

log "starting compose ($IMAGE, read-only root)"
"${COMPOSE[@]}" up -d --pull never

log "waiting for the game server (cache download on a cold runner)"
healthy=0
for _ in $(seq 1 120); do
  state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}' tsps 2>/dev/null || true)"
  if [[ "$state" == "healthy" ]]; then healthy=1; break; fi
  if [[ "$state" == "unhealthy" ]]; then break; fi
  sleep 5
done
if [[ "$healthy" != "1" ]]; then
  docker logs tsps 2>&1 | tail -80 || true
  fail "container did not become healthy"
fi
log "healthy"

log "checking the game HTTP endpoint"
curl -fsS --max-time 10 http://127.0.0.1:43594/regions >/dev/null || fail "/regions did not answer"
log "checking the static client and generated server list"
curl -fsS --max-time 10 http://127.0.0.1:3000/ | grep -q '<div id="root"' || fail "client index did not answer"
curl -fsS --max-time 10 http://127.0.0.1:3000/servers.json | grep -q '"address"' || fail "servers.json did not answer"

log "checking that the image runs as non-root"
uid="$(docker run --rm --entrypoint id "$IMAGE" -u)"
[[ "$uid" == "10001" ]] || fail "runtime uid is $uid, expected 10001"

log "checking the notify trigger"
"${COMPOSE[@]}" exec -T app tsps-notify status | grep -q "No restart scheduled" || fail "status"
"${COMPOSE[@]}" exec -T app tsps-notify say "Docker smoke test" | grep -q "0 players" || fail "say"

log "checking that only /data and /tmp changed"
docker diff tsps | grep -vE '^(A|C|D) (/data|/tmp)(/|$)' | grep -vE '^(A|C|D) /etc/(hosts|hostname|resolv.conf)$' > /tmp/tsps-docker-diff-extra || true
if [[ -s /tmp/tsps-docker-diff-extra ]]; then
  cat /tmp/tsps-docker-diff-extra
  fail "files changed outside /data and /tmp (see above)"
fi
log "docker diff (outside the mounted volume this should be empty):"
docker diff tsps | head -40
log "data volume contents:"
docker exec tsps find /data -maxdepth 2 -type f | sort | head -40

log "checking backup"
mkdir -p backups
backup_path="$("${COMPOSE[@]}" --profile tools run --rm backup create | tail -1)"
backup_file="backups/$(basename "$backup_path")"
[[ -f "$backup_file" ]] || fail "backup did not create $backup_file"
"${COMPOSE[@]}" --profile tools run --rm backup list | grep -q "$(basename "$backup_file")" || fail "backup list"

log "checking graceful stop (player persistence log)"
"${COMPOSE[@]}" stop app >/dev/null
docker logs tsps 2>&1 | grep -q "Player persistence completed" || fail "graceful stop did not persist players"

rm -rf backups
log "all checks passed"
