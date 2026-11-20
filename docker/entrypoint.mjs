#!/usr/bin/env node
/**
 * Container entrypoint: prepare the persistent data directory, write the client's runtime
 * server list, then supervise the game server and the static client server.
 *
 * One container is enough (and has fewer moving parts than two): the game server owns the data
 * volume and the static server only needs the same filesystem for the game cache. Both get the
 * same signals, and Docker's restart policy acts on the game server's exit code.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(process.env.TSPS_DATA_DIR || "/data");
const SERVER_DIR = "/app/server";
const CLIENT_PORT = Number(process.env.CLIENT_PORT || process.env.PORT || 3000);
const GAME_PORT = Number(process.env.WEBSOCKET_PORT || 43594);
const STOP_GRACE_MS = Math.max(15, Number(process.env.TSPS_STOP_GRACE_SECONDS || 90) - 5) * 1000;

function log(message) {
  console.log(`[entrypoint] ${message}`);
}

function ensureDirectories() {
  for (const dir of ["saves", "config", "client", "client-artwork", "plugins-imported", "caches", "logs"]) {
    fs.mkdirSync(path.join(DATA_DIR, dir), { recursive: true });
  }
  // The image links server/plugins/imported here; the link is created at build time so a
  // read-only root filesystem still has it.
  const imported = path.join(SERVER_DIR, "plugins", "imported");
  try {
    if (!fs.existsSync(imported)) fs.symlinkSync(path.join(DATA_DIR, "plugins-imported"), imported, "dir");
  } catch (error) {
    log(`could not create the imported-plugin link (${error?.message ?? error}); admin plugin uploads may fail`);
  }
}

function publicServerAddress() {
  const configured = (process.env.PUBLIC_HOST || "").trim() || "localhost";
  let host = configured;
  let secure = /^(wss|https):\/\//i.test(host);
  host = host.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
  if (/[/?#]/.test(host)) {
    log(`PUBLIC_HOST "${configured}" is not a bare host name or address; using localhost`);
    host = "localhost";
    secure = false;
  }
  return {
    host,
    address: /:\d+$/.test(host) ? host : `${host}:${GAME_PORT}`,
    secure,
  };
}

function writeServersJson() {
  const { address, secure: schemeSecure } = publicServerAddress();
  const secure = (process.env.SERVER_SECURE || "").toLowerCase() === "true" || schemeSecure;
  const entry = {
    name: (process.env.SERVER_NAME || "TSPS").trim(),
    address,
    secure,
    maxPlayers: Number(process.env.MAX_PLAYERS || 2047),
  };
  const file = path.join(DATA_DIR, "client", "servers.json");
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify([entry], null, 2)}\n`);
  fs.renameSync(temporary, file);
  log(`client server list: ${address}${secure ? " (secure)" : ""} -> ${file}`);
  return file;
}

function firstRun() {
  const saves = path.join(DATA_DIR, "saves");
  return fs.readdirSync(saves).length === 0;
}

function printFirstRunHelp() {
  log("first start: the game cache downloads on first boot; follow it in the server log.");
  log(`admin panel: loopback-only on 127.0.0.1:${process.env.WORLD_ADMIN_PORT || 49600} inside the container.`);
  if (process.env.WORLD_ADMIN_TOKEN) {
    log("admin panel token: WORLD_ADMIN_TOKEN (configured; not printed)");
  } else {
    log(`admin panel token: generated at ${DATA_DIR}/config/world-admin.token`);
    log("  docker compose exec app cat /data/config/world-admin.token");
  }
  log("  to reach it from the host: docker compose -f compose.yaml -f compose.admin.yaml up -d");
}

function childEnv(extra) {
  return { ...process.env, ...extra };
}

function main() {
  ensureDirectories();
  const serversFile = writeServersJson();
  if (firstRun()) printFirstRunHelp();

  const common = {
    TSPS_DATA_DIR: DATA_DIR,
    TSPS_SUPERVISED: "1",
    NODE_ENV: "production",
  };

  const client = spawn(process.execPath, [path.join("/app/client/scripts/serve-build.mjs")], {
    cwd: "/app",
    env: childEnv({
      ...common,
      PORT: String(CLIENT_PORT),
      HOST: "0.0.0.0",
      CACHE_DIR: process.env.TSPS_CACHE_DIR || path.join(DATA_DIR, "caches"),
      SERVERS_JSON_FILE: serversFile,
    }),
    stdio: "inherit",
  });

  const game = spawn(
    process.execPath,
    ["--max-old-space-size=8192", "--max-semi-space-size=16", "./dist/Server.js", "1"],
    {
      cwd: SERVER_DIR,
      env: childEnv({
        ...common,
        TSPS_CACHE_DIR: process.env.TSPS_CACHE_DIR || path.join(DATA_DIR, "caches"),
        TSPS_LOG_DIR: process.env.TSPS_LOG_DIR || path.join(DATA_DIR, "logs"),
        WEBSOCKET_PORT: String(GAME_PORT),
        // A bare host, in case PUBLIC_HOST was given as a URL for servers.json.
        PUBLIC_HOST: publicServerAddress().host,
        BOT_RUNTIME_EVENT_LOGGING: "0",
        BOT_RUNTIME_TELEMETRY_ENABLED: "0",
        BOT_TASK_PROFILER_ENABLED: "0",
        TASK_SLOW_WARN_ENABLED: "0",
        PROJECTILE_DEBUG: "0",
        MAGIC_CAST_DEBUG: "0",
      }),
      stdio: "inherit",
    }
  );

  let stopping = false;
  let forceTimer = null;
  const killAll = (signal) => {
    for (const child of [game, client]) {
      if (child.exitCode === null && !child.killed) {
        try { child.kill(signal); } catch { /* already gone */ }
      }
    }
  };

  const shutdown = (signal) => {
    if (stopping) {
      log(`${signal} again; forcing immediate exit`);
      killAll("SIGKILL");
      process.exit(1);
    }
    stopping = true;
    log(`${signal}: stopping the game server (players are saved before it exits)`);
    // The game server handles SIGTERM itself (graceful save). The static server can stop now.
    try { game.kill("SIGTERM"); } catch { /* gone */ }
    try { client.kill("SIGTERM"); } catch { /* gone */ }
    forceTimer = setTimeout(() => {
      log(`grace period expired after ${Math.round(STOP_GRACE_MS / 1000)}s; killing remaining processes`);
      killAll("SIGKILL");
      process.exit(1);
    }, STOP_GRACE_MS);
    forceTimer.unref();
  };

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => shutdown(signal));

  client.on("exit", (code, signal) => {
    if (stopping) return;
    log(`static client server exited (code ${code}, signal ${signal}); stopping the container`);
    stopping = true;
    try { game.kill("SIGTERM"); } catch { /* gone */ }
  });

  game.on("exit", (code, signal) => {
    log(`game server exited (code ${code}, signal ${signal})`);
    if (!stopping) stopping = true;
    try { client.kill("SIGTERM"); } catch { /* gone */ }
    // 75 is the supervised admin-panel restart; any nonzero exit restarts with
    // `restart: unless-stopped`, and 0 lets `docker compose down` finish.
    process.exitCode = code ?? (signal ? 1 : 0);
    // Give the static server a moment to close its listener, then exit.
    const done = () => process.exit(process.exitCode ?? 0);
    if (client.exitCode !== null) done();
    else client.once("exit", done);
    setTimeout(done, 5_000).unref();
  });

}

try {
  main();
} catch (error) {
  console.error("[entrypoint] failed to start:", error);
  process.exit(1);
}
