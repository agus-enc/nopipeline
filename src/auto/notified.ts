// Notify an automatic run's result only once (spec §4.6.1 and §4.6.2).
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { makeFolders, writeFlushed } from "../durable.ts";

export interface AutoResult {
  failed?: string;
  heldPages: readonly string[];
  heldFiles: readonly string[];
  /** Skipped, conflict and rewritten paths. */
  needLook: readonly string[];
}

const sorted = (list: readonly string[]) => [...list].sort();

/** What makes this result "the same" as the last one; null: nothing to notify. Failure beats held beats needLook. */
export function fingerprintOf(r: AutoResult): string | null {
  if (r.failed !== undefined) return JSON.stringify({ failed: r.failed });
  if (r.heldPages.length + r.heldFiles.length > 0) return JSON.stringify({ held: { pages: sorted(r.heldPages), files: sorted(r.heldFiles) } });
  if (r.needLook.length > 0) return JSON.stringify({ needLook: sorted(r.needLook) });
  return null;
}

export const autoNotifiedFile = (stateDir: string) => join(stateDir, "auto-notified.json");

export const configErrorFile = (env: Record<string, string | undefined> = process.env) =>
  join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "nopipeline", "auto-config-error.json");

const readJson = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
};

const save = async (file: string, value: unknown) => {
  await makeFolders(dirname(file));
  await writeFlushed(file, `${JSON.stringify(value, null, 2)}\n`);
};

/** null: remove the file, false. The stored fingerprint: false. Anything else: true (not yet remembered; see `rememberResult`). */
export async function isNewResult(file: string, fingerprint: string | null): Promise<boolean> {
  if (fingerprint === null) {
    await rm(file, { force: true });
    return false;
  }
  const saved = (await readJson(file)) as { fingerprint?: unknown } | null;
  return !(saved && typeof saved === "object" && saved.fingerprint === fingerprint);
}

/** Remembers a result that was shown, so the next run stays quiet about it. */
export async function rememberResult(file: string, fingerprint: string): Promise<void> {
  await save(file, { fingerprint });
}

const readMap = async (file: string): Promise<Record<string, string>> => {
  const saved = await readJson(file);
  return saved && typeof saved === "object" && !Array.isArray(saved) ? { ...(saved as Record<string, string>) } : {};
};

/** A profile that can't load: is this message new for this config path? (`rememberConfigError` stores it once shown.) */
export async function isNewConfigError(env: Record<string, string | undefined>, configPath: string, message: string): Promise<boolean> {
  return (await readMap(configErrorFile(env)))[configPath] !== message;
}

export async function rememberConfigError(env: Record<string, string | undefined>, configPath: string, message: string): Promise<void> {
  const file = configErrorFile(env);
  const map = await readMap(file);
  map[configPath] = message;
  await save(file, map);
}

/** The profile loaded: forget this path's error, so the same error later notifies again. Removes the file when it empties. */
export async function clearConfigError(env: Record<string, string | undefined>, configPath: string): Promise<void> {
  const file = configErrorFile(env);
  const map = await readMap(file);
  if (!(configPath in map)) return;
  delete map[configPath];
  if (Object.keys(map).length === 0) await rm(file, { force: true });
  else await save(file, map);
}
