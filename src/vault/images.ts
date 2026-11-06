// The attachments of a vault (images, PDFs, audio, video, other files): which file a citation means, and how to cite a file.
import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { encodeVaultPath } from "../links/index.ts";
import { mediaKind } from "../notion/hosted.ts";

/** The most a single-part Notion upload takes: 20 MB. A larger file never uploaded stays literal in its note (spec §5.10). */
export const UPLOAD_LIMIT = 20 * 1024 * 1024;

export interface VaultMedia {
  /** The vault path a citation's target means, as Obsidian resolves it, or null (no such attachment, or one over the upload limit that Notion doesn't hold yet). */
  resolve(target: string, fromPath: string): string | null;
  /** The vault path a citation's target means when that file is over the upload limit and not hosted, else null. */
  oversized(target: string, fromPath: string): string | null;
  /** How a note cites the file at `path`: its file name alone when no other vault file has it, else its full path; as a link destination. */
  pathFor(path: string, fromPath: string): string;
  /** The folder downloaded files go to ("" for the vault root). */
  folder: string;
  /**
   * Whether Notion already holds the file at `path` (the run sets it from the store). Such a file is never over the limit: its
   * line keeps its block however large the file is (spec §5.10). Without it, no file counts as hosted.
   */
  hosted?: (path: string) => boolean;
}

const normal = (path: string) => path.normalize("NFC").toLowerCase();
const folderOf = (path: string) => (posix.dirname(path) === "." ? "" : posix.dirname(path));

/** The file among `files` that `target` means from `fromPath`: an exact path, a path from the note's folder, or a path suffix or bare name (the shortest path when several match). */
function find(files: readonly string[], target: string, fromPath: string): string | null {
  let wanted = target.trim().normalize("NFC");
  if (wanted === "") return null;
  if (wanted.startsWith("./") || wanted.startsWith("../")) wanted = posix.normalize(posix.join(folderOf(fromPath), wanted));
  wanted = wanted.replace(/^\/+/, "").toLowerCase();
  const keyed = files.map((path) => ({ path, key: normal(path) }));
  const exact = keyed.find((f) => f.key === wanted);
  if (exact) return exact.path;
  const sibling = posix.join(folderOf(fromPath), wanted).toLowerCase();
  const near = keyed.find((f) => f.key === sibling);
  if (near) return near.path;
  const ends = keyed.filter((f) => f.key.endsWith(`/${wanted}`));
  return ends.sort((a, b) => a.path.length - b.path.length || (a.path < b.path ? -1 : 1))[0]?.path ?? null;
}

/** The attachments of a vault from its file list (the notes, canvases and bases among it are ignored), for tests and `scanMedia`. `tooLarge`: the files over the upload limit, among `files`. */
export function mediaOf(files: readonly string[], folder: string, tooLarge: readonly string[] = []): VaultMedia {
  const big = new Set(tooLarge);
  const attachments = files.filter((path) => mediaKind(path) !== null);
  const uploadable = attachments.filter((path) => !big.has(path));
  const have = new Set(attachments);
  const named = new Map<string, number>();
  for (const path of attachments) named.set(normal(posix.basename(path)), (named.get(normal(posix.basename(path))) ?? 0) + 1);
  const media: VaultMedia = {
    folder,
    // A large file counts as one the sync can place as long as Notion holds it; `hosted` is read at each call, as the run may set it after the scan.
    resolve: (target, fromPath) => find(media.hosted ? attachments.filter((path) => !big.has(path) || media.hosted!(path)) : uploadable, target, fromPath),
    oversized: (target, fromPath) => find(attachments.filter((path) => big.has(path) && !media.hosted?.(path)), target, fromPath),
    pathFor(path) {
      const name = posix.basename(path);
      const others = (named.get(normal(name)) ?? 0) - (have.has(path) ? 1 : 0);
      return encodeVaultPath(others === 0 ? name : path);
    },
  };
  return media;
}

/**
 * `attachmentFolderPath` of the vault's Obsidian settings, as a vault folder ("" for the root, when it isn't set). A folder
 * relative to each note (`./`, `./pics`: Obsidian's "same folder as the file" and "in a subfolder under it") has no single
 * place in the vault, so it counts as the vault root: downloads go there, and only files there can ever move to `.trash`.
 */
async function attachmentFolder(root: string): Promise<string> {
  try {
    const settings: unknown = JSON.parse(await readFile(join(root, ".obsidian", "app.json"), "utf8"));
    const folder = (settings as { attachmentFolderPath?: unknown } | null)?.attachmentFolderPath;
    if (typeof folder !== "string") return "";
    const plain = folder.replace(/^\/+|\/+$/g, "");
    return plain === "." || plain.startsWith("./") ? "" : plain;
  } catch {
    return "";
  }
}

/** Every attachment of the vault outside dot-folders (any file that isn't a note, a canvas or a base), with its size in bytes, in path order. */
export async function listMedia(root: string): Promise<{ path: string; size: number }[]> {
  const files: { path: string; size: number }[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && mediaKind(path) !== null) {
        files.push({ path, size: (await stat(join(root, path))).size });
      }
    }
  }
  await walk("");
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The attachments of the vault (see `listMedia`) and the attachment folder. `extra`: paths to count too, such as downloads a dry run did not write. */
export async function scanMedia(root: string, extra: readonly string[] = []): Promise<VaultMedia> {
  const listed = await listMedia(root);
  const files = listed.map((f) => f.path);
  const tooLarge = listed.filter((f) => f.size > UPLOAD_LIMIT).map((f) => f.path);
  for (const path of extra) if (mediaKind(path) !== null && !files.includes(path)) files.push(path);
  return mediaOf(files.sort(), await attachmentFolder(root), tooLarge);
}
