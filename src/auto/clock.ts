// last-sync.json: when the last real run ended, for `sync --auto` (spec §4.1).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeFolders, writeFlushed } from "../durable.ts";

const fileOf = (stateDir: string) => join(stateDir, "last-sync.json");

/** When the last real run ended; null when there is no usable file. */
export async function readLastSync(stateDir: string): Promise<Date | null> {
  try {
    const saved = JSON.parse(await readFile(fileOf(stateDir), "utf8")) as { endedAt?: unknown } | null;
    if (!saved || typeof saved !== "object" || typeof saved.endedAt !== "string") return null;
    const at = new Date(saved.endedAt);
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}

export async function writeLastSync(stateDir: string, at: Date): Promise<void> {
  await makeFolders(stateDir);
  await writeFlushed(fileOf(stateDir), `${JSON.stringify({ endedAt: at.toISOString() }, null, 2)}\n`);
}
