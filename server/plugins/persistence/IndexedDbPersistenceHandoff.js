const { savesPath } = require("../lib/GamePaths");
const path = require("path");

const HANDOFF_DIRECTORY = savesPath("indexeddb", "characters");

function isBrowserHost(environment = process.env) {
  return environment.BROWSER_HOST === "1";
}

module.exports = { HANDOFF_DIRECTORY, isBrowserHost };
