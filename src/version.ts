import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** The folder above `src/`. */
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

async function readJson(file: string): Promise<{ version?: unknown } | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as { version?: unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The version to show: `<root>/version.json` (written by the package build) when it exists, otherwise package.json's
 * version and the folder it runs from (a clone).
 */
export async function versionString(root: string = packageRoot): Promise<string> {
  const built = await readJson(`${root}/version.json`);
  if (built && typeof built.version === "string") return built.version;
  const pkg = await readJson(`${root}/package.json`);
  return `${typeof pkg?.version === "string" ? pkg.version : "unknown"} (from ${root})`;
}
