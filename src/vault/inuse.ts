// Which notes are in use while Obsidian runs (spec "Sync while Obsidian is open"). Read-only: nothing is written.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { obsidianRunningWith } from "../auto/due.ts";
import type { PageId, SyncRecord, VaultNote } from "../types.ts";

/** A note edited this recently, and different from its record, counts as in use. */
export const RECENT_EDIT_MS = 300_000;

const TAB_ROOTS = ["main", "left", "right"];

function collectFiles(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectFiles(item, into);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const object = node as Record<string, unknown>;
  const state = object.state;
  if (typeof state === "object" && state !== null) {
    const file = (state as Record<string, unknown>).state;
    if (typeof file === "object" && file !== null) {
      const path = (file as Record<string, unknown>).file;
      if (typeof path === "string") into.add(path);
    }
  }
  for (const value of Object.values(object)) collectFiles(value, into);
}

/**
 * Vault paths of files open in tabs, from `<vault>/.obsidian/workspace.json` (the desktop file only).
 * Null when that file is missing, not JSON, or has no object `main`. The format is Obsidian's own and undocumented, so it is read defensively.
 */
export async function readOpenTabs(vaultPath: string): Promise<ReadonlySet<string> | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(vaultPath, ".obsidian", "workspace.json"), "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  if (typeof root.main !== "object" || root.main === null) return null;
  const files = new Set<string>();
  for (const key of TAB_ROOTS) collectFiles(root[key], files);
  return files;
}

export interface ObsidianProbe {
  running(): Promise<boolean>;
  openTabs(vaultPath: string): Promise<ReadonlySet<string> | null>;
  modifiedAt(vaultPath: string, path: string): Promise<Date | null>;
}

export const systemObsidian: ObsidianProbe = {
  running: obsidianRunningWith(),
  openTabs: readOpenTabs,
  async modifiedAt(vaultPath, path) {
    try {
      return (await stat(join(vaultPath, path))).mtime;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
};

export interface InUse {
  paths: ReadonlySet<string>;
  /** Obsidian runs but its open tabs could not be read. */
  tabsUnreadable: boolean;
}

export async function notesInUse(input: {
  vaultPath: string;
  notes: readonly VaultNote[];
  records: ReadonlyMap<PageId, SyncRecord>;
  probe: ObsidianProbe;
  now: Date;
}): Promise<InUse> {
  const { vaultPath, notes, records, probe, now } = input;
  if (!(await probe.running())) return { paths: new Set(), tabsUnreadable: false };

  const tabs = await probe.openTabs(vaultPath);
  const byPath = new Map<string, SyncRecord>();
  for (const record of records.values()) byPath.set(record.path, record);

  const paths = new Set<string>();
  for (const note of notes) {
    if (!note.path.endsWith(".md")) continue;
    if (tabs?.has(note.path)) {
      paths.add(note.path);
      continue;
    }
    const record = note.notionId === null ? byPath.get(note.path) : records.get(note.notionId);
    if (record !== undefined && record.obsidianText === note.text) continue;
    const modified = await probe.modifiedAt(vaultPath, note.path);
    if (modified !== null && now.getTime() - modified.getTime() <= RECENT_EDIT_MS) paths.add(note.path);
  }
  return { paths, tabsUnreadable: tabs === null };
}
