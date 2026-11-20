#!/usr/bin/env node
/**
 * Backup and restore for the TSPS data volume. Run it in the app image:
 *
 *   docker compose run --rm backup create
 *   docker compose run --rm backup list
 *   docker compose stop app
 *   docker compose run --rm backup restore /backups/tsps-2026-01-01T030000Z.tar.gz
 *   docker compose up -d
 *
 * players.sqlite is snapshotted with SQLite's VACUUM INTO, which is consistent while the
 * server is running, rather than copied live with its WAL. The game cache and logs are left
 * out: they are large and regenerate.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = path.resolve(process.env.TSPS_DATA_DIR || "/data");
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || "/backups");
const EXCLUDED = new Set(["caches", "logs", "backups"]);
const LIVE_SAVE_FILES = new Set(["players.sqlite", "players.sqlite-wal", "players.sqlite-shm", "players.sqlite.pid"]);

function usage(message) {
  if (message) console.error(`backup: ${message}`);
  console.error("Usage: backup create [name] | backup list | backup restore <file> [--force]");
  process.exit(2);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/-(\d{3})Z$/, "Z");
}

function copyData(target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name)) continue;
    const from = path.join(DATA_DIR, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory() && entry.name === "saves") {
      fs.mkdirSync(to, { recursive: true });
      for (const saved of fs.readdirSync(from, { withFileTypes: true })) {
        if (LIVE_SAVE_FILES.has(saved.name)) continue;
        fs.cpSync(path.join(from, saved.name), path.join(to, saved.name), { recursive: true });
      }
      continue;
    }
    fs.cpSync(from, to, { recursive: true });
  }
}

function snapshotDatabase(target) {
  const source = path.join(DATA_DIR, "saves", "players.sqlite");
  if (!fs.existsSync(source)) return false;
  const destination = path.join(target, "saves", "players.sqlite");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.rmSync(destination, { force: true });
  const database = new DatabaseSync(source);
  try {
    database.exec("PRAGMA busy_timeout = 10000");
    const quoted = destination.replace(/'/g, "''");
    database.exec(`VACUUM INTO '${quoted}'`);
  } finally {
    database.close();
  }
  return true;
}

function create(args) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = (args[0] || `tsps-${timestamp()}`).replace(/[^A-Za-z0-9._-]/g, "-");
  const archive = path.join(BACKUP_DIR, `${name}.tar.gz`);
  const partial = `${archive}.partial`;
  const staging = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "tsps-backup-"));
  try {
    const dataStaging = path.join(staging, "data");
    copyData(dataStaging);
    const savedDatabase = snapshotDatabase(dataStaging);
    const manifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      dataDir: DATA_DIR,
      playersDatabase: savedDatabase ? "saves/players.sqlite (VACUUM INTO snapshot)" : "absent",
      omitted: ["caches/ (re-downloads)", "logs/ (regenerated)", "saves/players.sqlite* live files (replaced by the snapshot)"],
    };
    fs.writeFileSync(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const tar = spawnSync("tar", ["-czf", partial, "-C", staging, "."], { stdio: "inherit" });
    if (tar.error) throw tar.error;
    if (tar.status !== 0) throw new Error(`tar exited with ${tar.status}`);
    fs.renameSync(partial, archive);
    console.log(archive);
    return archive;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(partial, { force: true });
  }
}

function list() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const files = fs.readdirSync(BACKUP_DIR).filter((name) => name.endsWith(".tar.gz")).sort();
  if (files.length === 0) console.log("No backups.");
  for (const name of files) {
    const stat = fs.statSync(path.join(BACKUP_DIR, name));
    console.log(`${name}  ${(stat.size / 1024 / 1024).toFixed(1)} MiB  ${stat.mtime.toISOString()}`);
  }
}

function restore(args) {
  const archive = args[0];
  if (!archive) usage("restore needs an archive");
  const force = args.includes("--force");
  const source = path.isAbsolute(archive) ? archive : path.join(BACKUP_DIR, archive);
  if (!fs.existsSync(source)) usage(`no archive at ${source}`);

  const staging = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "tsps-restore-"));
  try {
    const tar = spawnSync("tar", ["-xzf", source, "-C", staging], { stdio: "inherit" });
    if (tar.error) throw tar.error;
    if (tar.status !== 0) throw new Error(`tar exited with ${tar.status}`);
    const manifestFile = path.join(staging, "manifest.json");
    if (!fs.existsSync(manifestFile)) throw new Error("archive has no manifest.json; refusing to restore");
    JSON.parse(fs.readFileSync(manifestFile, "utf8"));

    const saves = path.join(DATA_DIR, "saves");
    if (!force && fs.existsSync(saves) && fs.readdirSync(saves).length > 0) {
      throw new Error(`${saves} is not empty; stop the server and pass --force to overwrite (a clean volume is recommended)`);
    }
    fs.mkdirSync(saves, { recursive: true });
    for (const stale of ["players.sqlite-wal", "players.sqlite-shm", "players.sqlite.pid"]) {
      fs.rmSync(path.join(saves, stale), { force: true });
    }
    const dataStaging = path.join(staging, "data");
    for (const entry of fs.readdirSync(dataStaging, { withFileTypes: true })) {
      fs.cpSync(path.join(dataStaging, entry.name), path.join(DATA_DIR, entry.name), { recursive: true, force: true });
    }
    console.log(`Restored ${source} into ${DATA_DIR}. Start the server with: docker compose up -d`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "create") create(args);
  else if (command === "list") list();
  else if (command === "restore") restore(args);
  else usage(command ? `unknown command "${command}"` : undefined);
} catch (error) {
  console.error(`backup: ${error?.message ?? error}`);
  process.exit(1);
}
