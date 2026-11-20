import * as fs from "fs";
import * as path from "path";

/**
 * Typed view of the shared runtime path helper in plugins/lib/GamePaths.js. Plugins and the
 * compiled server use the same implementation, so TSPS_DATA_DIR has one meaning everywhere.
 */
interface GamePathsModule {
    dataRoot(): string;
    dataPath(...parts: string[]): string;
    savesPath(...parts: string[]): string;
    configDir(): string;
    worldLocalConfigPath(): string;
    worldAdminTokenPath(): string;
    clientArtworkDir(): string;
    pluginsImportedDir(): string;
    logsDir(): string;
    cachesDir(): string;
    botsDataDir(): string;
    proceduralDataDir(): string;
    shippedDefinitionsDir(): string;
    definitionsEditsEnabled(): boolean;
    definitionsEditPath(file: string): string;
}

function load(): GamePathsModule {
    // Resolve from the repository rather than the working directory: __dirname is
    // <root>/server/src/main/typescript/elvarg/util in development and <root>/server/dist/util
    // in production, and both are under server/.
    let dir = __dirname;
    for (let depth = 0; depth < 8; depth++) {
        const candidate = path.join(dir, "plugins", "lib", "GamePaths.js");
        if (fs.existsSync(candidate)) return require(candidate) as GamePathsModule;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return require(path.join(process.cwd(), "plugins", "lib", "GamePaths.js")) as GamePathsModule;
}

const gamePaths = load();

export const dataRoot = gamePaths.dataRoot;
export const dataPath = gamePaths.dataPath;
export const savesPath = gamePaths.savesPath;
export const configDir = gamePaths.configDir;
export const worldLocalConfigPath = gamePaths.worldLocalConfigPath;
export const worldAdminTokenPath = gamePaths.worldAdminTokenPath;
export const clientArtworkDir = gamePaths.clientArtworkDir;
export const pluginsImportedDir = gamePaths.pluginsImportedDir;
export const logsDir = gamePaths.logsDir;
export const cachesDir = gamePaths.cachesDir;
export const botsDataDir = gamePaths.botsDataDir;
export const proceduralDataDir = gamePaths.proceduralDataDir;
export const shippedDefinitionsDir = gamePaths.shippedDefinitionsDir;
export const definitionsEditsEnabled = gamePaths.definitionsEditsEnabled;
export const definitionsEditPath = gamePaths.definitionsEditPath;
