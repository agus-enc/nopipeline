// Writing files so a power cut can't leave them empty or half-written: a file's data reaches the disk before
// it takes its name, and the name reaches the disk before the write counts as done.
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

/** Refusals of a flush by a file system that can't flush that file or folder; there, it is as safe as the system makes it. */
const UNFLUSHABLE = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EBADF"]);

/** Flushes an open file to the disk, where the file system can. */
async function sync(handle: FileHandle): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    if (!UNFLUSHABLE.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

/** Flushes a file's data, or a folder's names, to the disk. */
export async function flush(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    // Some systems can't open a folder to flush it; there, the names are as safe as the system makes them.
    if (["EISDIR", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
  try {
    await sync(handle);
  } finally {
    await handle.close();
  }
}

/** Writes `text` (or raw bytes) to a new or emptied `file` and flushes it to the disk. */
export async function writeFlushed(file: string, text: string | Uint8Array): Promise<void> {
  const handle = await open(file, "w");
  try {
    if (typeof text === "string") await handle.writeFile(text, "utf8");
    else await handle.writeFile(text);
    await sync(handle);
  } finally {
    await handle.close();
  }
}

/** Creates `dir` and any missing folders above it, each new folder's name flushed into the folder that holds it. */
export async function makeFolders(dir: string): Promise<void> {
  const first = await mkdir(dir, { recursive: true });
  if (first === undefined) return;
  const made: string[] = [];
  for (let folder = dir; ; folder = dirname(folder)) {
    made.unshift(folder);
    if (folder === first || dirname(folder) === folder) break;
  }
  for (const folder of made) await flush(dirname(folder));
}
