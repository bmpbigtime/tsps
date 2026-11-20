const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const server = path.resolve(__dirname, "..");
const helper = path.join(server, "plugins", "lib", "GamePaths.js");

/** Runs the helper in a clean child so process.env mutations can't leak between cases. */
function paths(env) {
  const script = `
    const p = require(${JSON.stringify(helper)});
    console.log(JSON.stringify({
      saves: p.savesPath("x.json"),
      config: p.worldLocalConfigPath(),
      token: p.worldAdminTokenPath(),
      artwork: p.clientArtworkDir(),
      imported: p.pluginsImportedDir(),
      logs: p.logsDir(),
      caches: p.cachesDir(),
      bots: p.botsDataDir(),
      procedural: p.proceduralDataDir(),
      edits: p.definitionsEditsEnabled(),
    }));
  `;
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith("TSPS_")) delete clean[key];
  }
  const out = execFileSync(process.execPath, ["-e", script], {
    cwd: server,
    env: { ...clean, ...env },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

test("without TSPS_DATA_DIR every path is the historical one", () => {
  const got = paths({});
  assert.equal(got.saves, path.join(server, "data", "saves", "x.json"));
  assert.equal(got.config, path.join(server, "data", "definitions", "world.local.json"));
  assert.equal(got.token, path.join(server, "data", "definitions", "world-admin.token"));
  assert.equal(got.artwork, path.join(server, "data", "client-artwork"));
  assert.equal(got.imported, path.join(server, "plugins", "imported"));
  assert.equal(got.logs, path.join(server, "logs"));
  assert.equal(got.caches, path.join(server, "caches"));
  assert.equal(got.bots, path.join(server, "plugins", "bots", "data"));
  assert.equal(got.procedural, path.join(server, "plugins", "world", "data"));
  assert.equal(got.edits, true);
});

test("TSPS_DATA_DIR moves mutable state and disables shipped-definition edits", () => {
  const root = path.resolve("/tmp/tsps-data-test");
  const got = paths({ TSPS_DATA_DIR: root });
  assert.equal(got.saves, path.join(root, "saves", "x.json"));
  assert.equal(got.config, path.join(root, "config", "world.local.json"));
  assert.equal(got.token, path.join(root, "config", "world-admin.token"));
  assert.equal(got.artwork, path.join(root, "client-artwork"));
  assert.equal(got.imported, path.join(root, "plugins-imported"));
  assert.equal(got.logs, path.join(root, "logs"));
  assert.equal(got.caches, path.join(root, "caches"));
  assert.equal(got.bots, path.join(root, "bots"));
  assert.equal(got.procedural, path.join(root, "procedural"));
  assert.equal(got.edits, false);
});

test("TSPS_CACHE_DIR and TSPS_LOG_DIR win over TSPS_DATA_DIR", () => {
  const got = paths({
    TSPS_DATA_DIR: "/tmp/tsps-data-test",
    TSPS_CACHE_DIR: "/tmp/tsps-cache-test",
    TSPS_LOG_DIR: "/tmp/tsps-log-test",
  });
  assert.equal(got.caches, path.resolve("/tmp/tsps-cache-test"));
  assert.equal(got.logs, path.resolve("/tmp/tsps-log-test"));
});
