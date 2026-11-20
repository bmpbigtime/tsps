#!/usr/bin/env node
/**
 * Talk to the running server's world-admin listener (loopback by default):
 *
 *   tsps-notify status
 *   tsps-notify restart 10m
 *   tsps-notify cancel
 *   tsps-notify say "Maintenance at 20:00 UTC"
 *
 * Restart reuses the in-game GameUpdate countdown, so every online player sees the chat notice
 * and the client's on-screen timer. In the Docker image TSPS_SUPERVISED=1 makes the server exit
 * with code 75 at zero, which is what `restart: unless-stopped` restarts.
 *
 * The token comes from WORLD_ADMIN_TOKEN, or from the generated world-admin token file under
 * TSPS_DATA_DIR (the Docker image mounts it on /data).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { worldAdminTokenPath } = require("../plugins/lib/GamePaths");

const LOOPBACK = "127.0.0.1";
const DEFAULT_PORT = 49600;
const DEFAULT_RESTART_SECONDS = 10 * 60;
const MAX_SECONDS = 24 * 60 * 60;

function usage(message) {
  if (message) console.error(`tsps-notify: ${message}`);
  console.error('Usage: tsps-notify status | cancel | restart [30s|10m|1h] | say "<message>"');
  process.exit(2);
}

function parseDuration(raw) {
  if (raw === undefined) return DEFAULT_RESTART_SECONDS;
  const match = /^(\d+)([smh])?$/i.exec(String(raw).trim());
  if (!match) usage(`invalid duration "${raw}" (use 30s, 10m or 1h)`);
  const value = Number(match[1]);
  const multiplier = match[2]?.toLowerCase() === "h" ? 3600 : match[2]?.toLowerCase() === "m" ? 60 : 1;
  const seconds = value * multiplier;
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_SECONDS) {
    usage(`duration must be between 1 second and 24 hours`);
  }
  return seconds;
}

function readToken() {
  const configured = (process.env.WORLD_ADMIN_TOKEN || "").trim();
  if (configured) return configured;
  const file = worldAdminTokenPath();
  try {
    return require("node:fs").readFileSync(file, "utf8").trim();
  } catch (error) {
    console.error(
      `tsps-notify: no WORLD_ADMIN_TOKEN and cannot read ${file} (${error?.code ?? error}). ` +
        "Is the server running with the same data directory?"
    );
    process.exit(1);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  let body;
  switch (command) {
    case "status":
    case "cancel":
      body = { action: command };
      break;
    case "restart":
      body = { action: "restart", seconds: parseDuration(rest[0]) };
      break;
    case "say": {
      const message = rest.join(" ").trim();
      if (!message) usage("say needs a message");
      body = { action: "say", message };
      break;
    }
    case undefined:
    case "-h":
    case "--help":
    case "help":
      usage();
      break;
    default:
      usage(`unknown command "${command}"`);
  }

  const port = Number(process.env.WORLD_ADMIN_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) usage("WORLD_ADMIN_PORT is not a valid port");
  const url = `http://${LOOPBACK}:${port}/api/notify`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${readToken()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error(
      `tsps-notify: cannot reach ${url} (${error?.cause?.code ?? error?.message ?? error}). ` +
        "The world-admin listener is loopback-only; run this inside the container or on the host."
    );
    process.exit(1);
  }

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    console.error(`tsps-notify: ${response.status} ${payload.error ?? text}`);
    process.exit(1);
  }

  if (command === "status") {
    if (payload.scheduled) console.log(`Restart scheduled: ${payload.remainingSeconds}s remaining.`);
    else console.log(`No restart scheduled (${payload.onlinePlayers ?? 0} players online, mode ${payload.mode ?? "?"}).`);
  } else if (command === "cancel") {
    console.log(payload.cancelled ? "Restart cancelled." : "No restart was scheduled.");
  } else if (command === "say") {
    console.log(`Announcement sent to ${payload.onlinePlayers ?? 0} players.`);
  } else if (payload.countdownSeconds) {
    console.log(`Restart countdown started: ${payload.countdownSeconds}s (${payload.onlinePlayers} players online).`);
  } else {
    console.log("No players online; restarting immediately.");
  }
}

await main();
