# Docker deployment

The image at `ghcr.io/rspsapp/tsps` runs the compiled game server and the static client build in
one container. Everything the server writes lives on a single named volume (`/data`), so updating
the image never touches player or world state, and restoring a deployment means restoring that
volume.

- `linux/amd64` and `linux/arm64` images are published by
  [`.github/workflows/docker-publish.yml`](../.github/workflows/docker-publish.yml).
- The container runs as a non-root user with a **read-only root filesystem**; only `/data` and a
  small `/tmp` tmpfs are writable.
- The world-admin page stays on loopback unless you explicitly publish it
  ([Admin page](#admin-page)).

## Requirements

- Docker Engine with the Compose plugin, or Docker Desktop on Windows/macOS. The compose file uses
  `env_file.required`, so use Compose v2.24 or newer (Docker Desktop 4.25+).
- On Windows, use Docker Desktop with the **WSL2 backend** (the default); Hyper-V containers and
  Linux bind mounts from `C:\` are not supported for the data directory.
- A 64-bit CPU. The image also runs under emulation, but `linux/arm64` native is much faster on a
  Raspberry Pi or Apple Silicon.
- Open the game port (default `43594`) and the client port (default `3000`) in the host firewall.
  The game uses both HTTP and WebSocket on `43594`; a reverse proxy must allow the WebSocket
  upgrade.

## Quick start

```bash
git clone https://github.com/RSPSApp/tsps.git
cd tsps
cp .env.example .env
# edit .env: PUBLIC_HOST is the address players use, e.g. game.example.com
docker compose up -d
docker compose logs -f app
```

Open `http://localhost:3000`. The first start downloads the OSRS cache from
[OpenRS2](https://archive.openrs2.org) into the volume; expect several minutes and a few hundred
MiB. Progress appears in `docker compose logs -f app`. The health check only passes after the game
server is listening, which is after the cache download and startup.

To build from source instead of pulling:

```bash
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

## Configuration

All settings are environment variables, read from `.env` by Compose. No rebuild is needed for a
configuration change: `docker compose up -d` recreates the container with the new environment
(the data volume is reused).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_HOST` | `localhost` | Hostname or IP players reach. Written into the client's `/servers.json` at container start. A bare host, not a URL. |
| `GAME_PORT` | `43594` | Host port for the game HTTP/WebSocket listener; also the port in `servers.json`. |
| `CLIENT_PORT` | `3000` | Host port for the static client. |
| `SERVER_NAME` | `TSPS` | Name shown in the login page's server button. |
| `SERVER_SECURE` | `false` | Mark the server entry as `wss://` (set when a TLS proxy terminates WebSockets). |
| `MAX_PLAYERS` | `2047` | Advertised player cap in `servers.json`. |
| `WORLD_ADMIN_TOKEN` | generated | Fixed world-admin token (24+ chars of `A-Z a-z 0-9 _ -`). Without it the server generates one in `/data/config/world-admin.token`. |
| `WORLD_ADMIN_BIND` | `127.0.0.1` | Admin listener bind address. A non-loopback value requires `WORLD_ADMIN_TOKEN`. |
| `WORLD_ADMIN_PORT` | `49600` | Admin listener port inside the container. |
| `WORLD_ADMIN_TLS_CERT` / `_KEY` | unset | PEM files for HTTPS on the admin listener; required for remote access without an SSH tunnel. |
| `TSPS_DATA_DIR` | `/data` (image) | All mutable state: saves, config, imported plugins, artwork, logs, cache. |
| `TSPS_CACHE_DIR` | `$TSPS_DATA_DIR/caches` | Game cache; can be a separate mount. |
| `TSPS_LOG_DIR` | `$TSPS_DATA_DIR/logs` | Server, movement, combat-debug and bot logs. |
| `TSPS_UPDATE_DELAY` | `5m` | Warning time used by `scripts/docker-update.sh`. |
| `TZ` | `UTC` | Container time zone for log timestamps. |
| `TSPS_IMAGE_TAG` | `latest` | Image tag: `latest` follows `main`, `stable` follows release tags, or pin a semver/`sha-` tag. |
| `WEBRTC_WORLD_ID` / `WEBRTC_WORLD_TOKEN` | unset | Optional public world listing; passed through from `.env`. |

Other variables from `.env` are passed through too (`WEBRTC_*`, `QUEST_HELPER_*`, AI provider
keys, `BOT_*`). See [`.env.example`](../.env.example).

### Server list without rebuilding

The client fetches `/servers.json` at runtime. The container writes it from `PUBLIC_HOST`,
`GAME_PORT`, `SERVER_NAME`, `SERVER_SECURE` and `MAX_PLAYERS` on every start, so the prebuilt image
is not tied to one hostname. The static server reads the file per request; no client rebuild is
involved.

## Volumes and data layout

`compose.yaml` creates one named volume, `tsps-data`, mounted at `/data`:

| Path | Contents | Keep? |
| --- | --- | --- |
| `/data/saves/players.sqlite` (+ `-wal`, `-shm`) | Player saves and save history | **Yes** |
| `/data/saves/accounts.json`, `display-names.json` | Accounts and display names | **Yes** |
| `/data/saves/*.json` | Clans, groups, group storage, party rooms, scoreboards, seasonal rares, shooting stars, bots, abuse reports, ... | **Yes** |
| `/data/saves/Bans.txt`, `Mutes.txt`, `IPBans.txt`, `IPMutes.txt` | Staff punishments | **Yes** |
| `/data/saves/bank-pin-host.key` | Secret used for bank PIN host keys | **Yes** |
| `/data/saves/indexeddb/`, `/data/saves/characters/` | Browser-host handoff and legacy JSON saves | **Yes** |
| `/data/config/world.local.json` | Admin-page world settings | **Yes** |
| `/data/config/world-admin.token` | Generated admin token | Optional |
| `/data/plugins-imported/` | Plugins installed through the admin page | **Yes** |
| `/data/client-artwork/` | Per-world login artwork | **Yes** |
| `/data/client/servers.json` | Generated server list | Regenerates |
| `/data/logs/` | Server, movement, combat, bot logs | Regenerates |
| `/data/caches/` | OpenRS2 game cache | Regenerates (large) |

The shipped definitions (`server/data/definitions`), models and sprites stay inside the image.
`world.local.json` is read from `/data/config` and layered over the shipped `world.json`, so a
world's settings survive an image update exactly as they do for a `yarn start` deployment.

Use a **named volume**, as `compose.yaml` does. SQLite's WAL mode and file locking are unreliable
over Docker Desktop bind mounts from `C:\`; keep `/data` inside the Docker VM. If you need a host
path on Linux, a bind mount on a native Linux filesystem works, but `chown` it to uid/gid `10001`
first. On Windows, prefer `docker compose cp` or the backup helper instead of browsing the volume
with Windows tools.

## Ports and firewall

| Port | Service | Published by default |
| --- | --- | --- |
| `43594` (or `GAME_PORT`) | Game HTTP + WebSocket, `/regions`, gateway files | Yes |
| `3000` (or `CLIENT_PORT`) | Static client and `/caches/*` | Yes |
| `49600` | World-admin page | **No** |

Open only the game and client ports to the internet. `PUBLIC_HOST` must resolve to the host and
`GAME_PORT` must be reachable for players. If you put a TLS reverse proxy in front, proxy both
HTTP and WebSocket on the same host/port, and set `SERVER_SECURE=true` so the login page uses
`wss://`.

## Updating

### Manual

```bash
docker compose pull
docker compose up -d
```

This gives players no warning: Compose sends SIGTERM and the server saves and exits immediately.
For a warning, start the countdown first (below), or use the update script.

Tag policy: `latest` follows `main`, `stable` follows version tags, and every build also gets a
`sha-<commit>` tag. Pin a tag in `.env` (`TSPS_IMAGE_TAG=stable` or a version) for a deployment you
update deliberately.

### With a player warning and a backup (recommended)

```bash
scripts/docker-update.sh                 # 5 minute countdown
scripts/docker-update.sh --delay=10m
```

The script:

1. pulls the new image and compares image IDs (exits if already current);
2. takes a backup of the data volume;
3. starts the in-game countdown (`tsps-notify restart <delay>`);
4. waits out the countdown;
5. recreates the container with `docker compose up -d`.

A failure at any step before the final recreate leaves the old container running. The data volume
is never deleted. `--skip-backup` exists for tests but is not recommended.

Windows PowerShell equivalent, same behavior:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\docker-update.ps1 -Delay 10m
```

### On a schedule

The update script is safe to run from a scheduler: no update means no restart.

Linux cron (4am daily, logging to a file):

```cron
0 4 * * * cd /srv/tsps && scripts/docker-update.sh --delay=5m >> /var/log/tsps-update.log 2>&1
```

systemd timer:

```ini
# /etc/systemd/system/tsps-update.service
[Service]
Type=oneshot
WorkingDirectory=/srv/tsps
ExecStart=/srv/tsps/scripts/docker-update.sh --delay=5m
```

```ini
# /etc/systemd/system/tsps-update.timer
[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Windows Task Scheduler: create a daily task with
`powershell.exe -ExecutionPolicy Bypass -File C:\tsps\scripts\docker-update.ps1 -Delay 5m`.

### Opt-in unattended updates (not recommended)

```bash
docker compose --profile auto-update up -d
```

This runs `beatkind/watchtower:2.3.2`, a maintained fork of the end-of-life
`containrrr/watchtower` (pinned). It recreates the container **as soon as a new image appears**:
no countdown, no pre-update backup. The data volume is reused, so data survives, but players can
be disconnected mid-session. Leave the profile off unless that trade-off is acceptable; the
scheduled update script gives the same automation with warnings and backups.

## In-game notices and countdown

`tsps-notify` talks to the server's existing world-admin listener on loopback and reuses the
`GameUpdate` plugin's countdown (the same one as `::gameUpdate`). It never starts a second timer.

```bash
docker compose exec app tsps-notify status
docker compose exec app tsps-notify say "Maintenance at 20:00 UTC"
docker compose exec app tsps-notify restart 10m
docker compose exec app tsps-notify cancel
```

`restart` sends every online player the chat notice and the client's built-in on-screen timer,
re-pushed each tick and on login (so a player who logs in mid-countdown sees it). At zero the
server saves players and exits with code 75; `restart: unless-stopped` brings it back. With no
players online it restarts immediately without a countdown. `cancel` clears the timer and leaves
the server running. If the countdown is cancelled or the save fails, the server keeps running.

The update script uses this command. A plain `docker stop`, `docker compose down`, or an
unattended updater does **not** warn players; only the script/`tsps-notify` path does.

## Admin page

The world-admin listener binds `127.0.0.1:49600` inside the container, so it is not reachable from
the host by default. To open it:

1. Put a token of at least 24 characters (`[A-Za-z0-9_-]`) in `.env`:

   ```dotenv
   WORLD_ADMIN_TOKEN=replace-with-24-or-more-random-characters
   ```

2. Start with the admin override, which publishes the port on host loopback only:

   ```bash
   docker compose -f compose.yaml -f compose.admin.yaml up -d
   ```

3. Open `http://localhost:49600/?token=<WORLD_ADMIN_TOKEN>`.

The token is never printed to the logs. Without `WORLD_ADMIN_TOKEN`, the server generates
`/data/config/world-admin.token`; read it with:

```bash
docker compose exec app cat /data/config/world-admin.token
```

The generated token is not enough to bind beyond loopback: set `WORLD_ADMIN_TOKEN` explicitly for
that. For access from another machine, prefer an SSH tunnel
(`ssh -L 49600:localhost:49600 user@host`) and keep the port on loopback. If you must expose it,
terminate TLS in front of it or configure `WORLD_ADMIN_TLS_CERT` / `WORLD_ADMIN_TLS_KEY`, and never
publish `49600` on `0.0.0.0`.

## Backup and restore

The `backup` service runs in the same image (so it has `node:sqlite` and `tar`) and writes archives
to `./backups` on the host. It snapshots `players.sqlite` with SQLite's `VACUUM INTO`, which is
safe while the server is running; copying a live SQLite database with its WAL is not. The game
cache and logs are omitted.

```bash
docker compose --profile tools run --rm backup create      # prints ./backups/tsps-<timestamp>.tar.gz
docker compose --profile tools run --rm backup list
```

A backup contains:

- the consistent `saves/players.sqlite` snapshot;
- accounts, display names, clans, groups, party rooms, scoreboards and the other JSON/state files
  in `/data/saves`;
- `Bans.txt`, `Mutes.txt`, `IPBans.txt`, `IPMutes.txt`, `bank-pin-host.key`;
- `/data/config` (`world.local.json`, the admin token);
- imported plugins and client artwork;
- a `manifest.json`.

It does not contain caches or logs; they regenerate and are large.

### Restore on a new machine

1. Install Docker and clone the repo.
2. Copy the archive to `./backups` (create the directory if needed).
3. Start the data volume once so Docker creates it:

   ```bash
   docker compose pull app
   docker compose create app
   docker compose stop app
   ```

4. Restore into the volume:

   ```bash
   docker compose --profile tools run --rm backup restore /backups/tsps-<timestamp>.tar.gz --force
   ```

   On a clean volume `--force` is not needed. On an existing one, stop `app` first and keep a copy
   of the current backup.
5. Start:

   ```bash
   docker compose up -d
   ```

6. Copy the same `PUBLIC_HOST`/ports and, if you use it, `WORLD_ADMIN_TOKEN` into `.env`. Log in and
   confirm a character's saves, clans and world settings.

`bank-pin-host.key` is part of the backup. Losing it can invalidate existing bank PINs; keep it
with the save database rather than regenerating it.

## Windows and WSL2 notes

- Use Docker Desktop with the WSL2 backend. Keep the project in the WSL filesystem or a Windows
  path; either works for the image and named volume, but building from `C:\` is slower.
- Use the **named volume**, not a `C:\...` bind mount for `/data`. SQLite WAL and file locking over
  Windows bind mounts can corrupt or lock the save database.
- Run the PowerShell update script with `-ExecutionPolicy Bypass` if your policy blocks local
  scripts. The shell script needs WSL/Git Bash.
- `localhost:3000` and `localhost:43594` work from Windows through Docker Desktop's port forwarding.
  From other devices, use the host's LAN IP and open the ports in Windows Defender Firewall.
- `docker compose exec app tsps-notify ...` works from PowerShell/cmd unchanged.

## Troubleshooting

- **Health check stays `starting`**: the first cache download is still running, or startup is
  slower than the 180s start period. Watch `docker compose logs -f app`.
- **Cache download fails**: the container needs outbound HTTPS to `archive.openrs2.org`. Retry;
  an interrupted download resumes from the lock file in `/data/caches`.
- **Permission denied under `/data`**: a bind mount is owned by another uid. Use the named volume,
  or `chown -R 10001:10001` the host directory. The named volume inherits uid/gid 10001 from the
  image.
- **`read-only file system`**: the image intentionally has a read-only root. Anything that must be
  written belongs under `/data` (or `/tmp`). Report a path that tries to escape it.
- **Ports already in use**: change `GAME_PORT`/`CLIENT_PORT` in `.env`. Remember to update
  `PUBLIC_HOST`/firewall rules and the port in `servers.json` (regenerated on restart).
- **Admin page unreachable**: it is loopback-only by default; use `compose.admin.yaml` and
  `WORLD_ADMIN_TOKEN`, or an SSH tunnel.
- **Players connect to `localhost`**: set `PUBLIC_HOST` to the address players use and recreate the
  container; `docker compose exec app cat /data/client/servers.json` shows what the client gets.
- **WebRTC worlds behind NAT**: outbound `WEBRTC_SIGNAL_URL` registration is required for the
  world list; direct game traffic still uses the WebSocket port. If the relay cannot reach the
  advertised host, use the direct WebSocket world entry instead.

## Known limitations

- **In-game definition editors are disabled in Docker.** `::npcperm`, `::npcanim(s)`,
  `::npcanimscan`, the cache editor and the map editor rewrite files that ship in the image
  (`server/data/definitions`, `server/data/regions`). Writing those into the image would either
  fail on the read-only filesystem or be silently lost on the next image update. When
  `TSPS_DATA_DIR` is set they report that they are disabled. Edit the definitions in a source
  checkout and rebuild the image, or run without Docker for content authoring.
- **Upstream changes** arrive only after they are merged/released on `RSPSApp/tsps`; the image
  contains exactly that branch. There is no automatic upstream sync.
- **Save format downgrades**: updates can change the save format. There is no downgrade path;
  the pre-update backup from the update script is the rollback plan. To roll back, restore that
  archive onto the volume with the previous image tag.
- **Auto-update profile** skips the countdown and backup (see above).

## Environment variable changelog

New for Docker and non-Docker deployments:

| Variable | Default when unset | Notes |
| --- | --- | --- |
| `TSPS_DATA_DIR` | unset (historical paths) | Moves saves, config, artwork, imported plugins, logs and cache under one directory. |
| `TSPS_CACHE_DIR` | `<cwd>/caches` (or `<TSPS_DATA_DIR>/caches`) | Game cache directory. |
| `TSPS_LOG_DIR` | `<cwd>/logs` (or `<TSPS_DATA_DIR>/logs`) | Log directory. |
| `PUBLIC_HOST` | `localhost` | Docker only: address in the generated `servers.json`; also the existing gateway host. |
| `GAME_PORT`, `CLIENT_PORT`, `SERVER_NAME`, `SERVER_SECURE`, `MAX_PLAYERS` | see table above | Docker only (read by the entrypoint). |
| `TSPS_IMAGE_TAG`, `TSPS_UPDATE_DELAY` | `latest`, `5m` | Compose/update script only. |

Existing per-file overrides (`PLAYER_SAVE_DATABASE_PATH`, `TSPS_ACCOUNTS_FILE`, ...) still win over
`TSPS_DATA_DIR`. With `TSPS_DATA_DIR` unset, every path is exactly what it was before, so
`npm run setup && yarn start` is unchanged.
