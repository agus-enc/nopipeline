// Writing to the vault safely: atomic writes flushed to the disk, backups before any change, Obsidian's own
// .trash folder.
import { access, copyFile, readFile, rename } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { flush, makeFolders, writeFlushed } from "../durable.ts";

/** A move whose destination is already taken. */
export class PathTakenError extends Error {
  constructor(from: string, to: string) {
    super(`cannot move ${from}: ${to} already exists`);
    this.name = "PathTakenError";
  }
}

export interface VaultFs {
  readonly root: string;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  write(path: string, text: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  /** Writes a new binary file (a downloaded image). Refuses an existing path: downloads never overwrite. */
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** Moves a note into the vault's `.trash` folder and returns its new vault path. */
  trash(path: string): Promise<string>;
}

async function fileExists(full: string): Promise<boolean> {
  try {
    await access(full);
    return true;
  } catch {
    return false;
  }
}

/** `backupDir` receives a copy of every file before it is first overwritten, moved or trashed in this run. */
export function createVaultFs(root: string, backupDir: string | null): VaultFs {
  const backedUp = new Set<string>();
  const top = resolve(root);
  /** The file's full path; a path that would resolve outside the vault is refused. */
  const full = (path: string) => {
    const target = resolve(top, path);
    if (!target.startsWith(top + sep)) throw new Error(`refusing to touch ${path}: it is outside the vault`);
    return target;
  };

  async function backup(path: string): Promise<void> {
    if (backupDir === null || backedUp.has(path) || !(await fileExists(full(path)))) return;
    const target = join(backupDir, path);
    await makeFolders(dirname(target));
    await copyFile(full(path), target);
    await flush(target);
    await flush(dirname(target));
    backedUp.add(path);
  }

  async function freePath(path: string): Promise<string> {
    if (!(await fileExists(full(path)))) return path;
    const ext = extname(path);
    const stem = path.slice(0, path.length - ext.length);
    for (let n = 2; ; n++) {
      const candidate = `${stem} (${n})${ext}`;
      if (!(await fileExists(full(candidate)))) return candidate;
    }
  }

  return {
    root,
    read: async (path) => readFile(full(path), "utf8"),
    exists: async (path) => fileExists(full(path)),
    async write(path, text) {
      await backup(path);
      await makeFolders(dirname(full(path)));
      const temp = `${full(path)}.nopipeline-tmp`;
      await writeFlushed(temp, text);
      await rename(temp, full(path));
      await flush(dirname(full(path)));
    },
    async writeBytes(path, bytes) {
      if (await fileExists(full(path))) throw new Error(`refusing to overwrite ${path}: it already exists`);
      await makeFolders(dirname(full(path)));
      const temp = `${full(path)}.nopipeline-tmp`;
      await writeFlushed(temp, bytes);
      await rename(temp, full(path));
      await flush(dirname(full(path)));
    },
    async move(from, to) {
      if (from === to) return;
      if (await fileExists(full(to))) throw new PathTakenError(from, to);
      await backup(from);
      await makeFolders(dirname(full(to)));
      await rename(full(from), full(to));
      await flush(dirname(full(from)));
      await flush(dirname(full(to)));
    },
    async trash(path) {
      await backup(path);
      const target = await freePath(`.trash/${basename(path)}`);
      await makeFolders(dirname(full(target)));
      await rename(full(path), full(target));
      await flush(dirname(full(path)));
      await flush(dirname(full(target)));
      return target;
    },
  };
}

/** `Note (Notion conflict 2026-09-27).md` beside the note, with the time added if that name is taken. */
export async function conflictCopyPath(vault: VaultFs, notePath: string, now: Date): Promise<string> {
  const stem = notePath.replace(/\.md$/, "");
  const day = now.toISOString().slice(0, 10);
  const first = `${stem} (Notion conflict ${day}).md`;
  if (!(await vault.exists(first))) return first;
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  return `${stem} (Notion conflict ${day} ${time}).md`;
}
