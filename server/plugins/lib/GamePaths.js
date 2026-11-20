"use strict";

// Every mutable path the server writes, in one place. Set TSPS_DATA_DIR to move all of it onto
// one persistent directory (the Docker image does this); leave it unset and every path is the
// historical process.cwd()-relative one, so non-Docker installs behave exactly as before.
//
// Plain JavaScript so runtime plugins (server/plugins/**) and the compiled TypeScript server can
// share it: the TypeScript wrapper is src/main/typescript/elvarg/util/GamePaths.ts.
const path = require("path");

function configuredDir(name) {
  const value = (process.env[name] || "").trim();
  return value ? path.resolve(value) : null;
}

/** The mutable-data root: TSPS_DATA_DIR, else <cwd>/data. */
function dataRoot() {
  return configuredDir("TSPS_DATA_DIR") || path.resolve(process.cwd(), "data");
}

function dataPath(...parts) {
  return path.join(dataRoot(), ...parts);
}

/** Player/world state. */
function savesPath(...parts) {
  return dataPath("saves", ...parts);
}

/**
 * Deployment-owned config (world.local.json, the world-admin token). Without TSPS_DATA_DIR these
 * live in data/definitions next to the shipped world.json, as they always have.
 */
function configDir() {
  return configuredDir("TSPS_DATA_DIR") ? dataPath("config") : path.resolve(process.cwd(), "data", "definitions");
}

function worldLocalConfigPath() {
  return path.join(configDir(), "world.local.json");
}

function worldAdminTokenPath() {
  return path.join(configDir(), "world-admin.token");
}

/** Per-world login artwork uploaded from the admin page. */
function clientArtworkDir() {
  return configuredDir("TSPS_DATA_DIR") ? dataPath("client-artwork") : path.resolve(process.cwd(), "data", "client-artwork");
}

/** Plugins installed through the admin page. */
function pluginsImportedDir() {
  return configuredDir("TSPS_DATA_DIR") ? dataPath("plugins-imported") : path.resolve(process.cwd(), "plugins", "imported");
}

/** Logs: TSPS_LOG_DIR wins, else <data>/logs when TSPS_DATA_DIR is set, else <cwd>/logs. */
function logsDir() {
  return configuredDir("TSPS_LOG_DIR") || (configuredDir("TSPS_DATA_DIR") ? dataPath("logs") : path.resolve(process.cwd(), "logs"));
}

/** The OpenRS2 game cache: TSPS_CACHE_DIR wins, else <data>/caches when TSPS_DATA_DIR is set, else <cwd>/caches. */
function cachesDir() {
  return configuredDir("TSPS_CACHE_DIR") || (configuredDir("TSPS_DATA_DIR") ? dataPath("caches") : path.resolve(process.cwd(), "caches"));
}

/** Where the bot object index is cached (regenerates). */
function botsDataDir() {
  return configuredDir("TSPS_DATA_DIR") ? dataPath("bots") : path.resolve(process.cwd(), "plugins", "bots", "data");
}

/** Procedural region/terrain dumps (regenerate; used by development tools). */
function proceduralDataDir() {
  return configuredDir("TSPS_DATA_DIR") ? dataPath("procedural") : path.resolve(process.cwd(), "plugins", "world", "data");
}

/** Shipped definitions always stay in the image, even when mutable data moves. */
function shippedDefinitionsDir() {
  return path.resolve(process.cwd(), "data", "definitions");
}

/**
 * The in-game edit tools (::npcanim, persistent ::npc spawns, the cache/map editors) rewrite
 * files that ship in the image. Those edits cannot be layered safely across an image update yet,
 * so a deployment that moved its mutable data (TSPS_DATA_DIR, i.e. Docker) turns them off
 * instead of silently writing edits that an update would discard.
 */
function definitionsEditsEnabled() {
  return !configuredDir("TSPS_DATA_DIR");
}

/** Where an edit tool would write a definitions file (only meaningful while edits are enabled). */
function definitionsEditPath(file) {
  return path.join(shippedDefinitionsDir(), file);
}

module.exports = {
  dataRoot,
  dataPath,
  savesPath,
  configDir,
  worldLocalConfigPath,
  worldAdminTokenPath,
  clientArtworkDir,
  pluginsImportedDir,
  logsDir,
  cachesDir,
  botsDataDir,
  proceduralDataDir,
  shippedDefinitionsDir,
  definitionsEditsEnabled,
  definitionsEditPath,
};
