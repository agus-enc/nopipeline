// Files that come into Obsidian: images, PDFs, audio, video and other files pasted in Notion, downloaded into the attachment
// folder, and cited by their notes (the image design §5.3, §5.6; the attachments design §2.2, §5.4, §5.9).
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdtemp, readdir, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import { flush, makeFolders } from "../durable.ts";
import { outsideCode } from "../links/rewrite.ts";
import { NotionPageError } from "../notion/gateway.ts";
import { hostedFile, mediaKind, mediaLine, type MediaKind } from "../notion/hosted.ts";
import type { ImageGateway, PendingImage } from "../notion/images.ts";
import type { ImageStore } from "../state/images.ts";
import type { PageId } from "../types.ts";
import type { VaultFs } from "../vault/fs.ts";
import type { VaultMedia } from "../vault/images.ts";

const key = (name: string) => name.normalize("NFC").toLowerCase();

/** A file's SHA-256 (hex) and size: all that is needed to tell whether two files hold the same bytes, and all a streamed download keeps. */
export interface Digest {
  sha256: string;
  size: number;
}

/** The highest folder on the way to `dir` that doesn't exist yet (the first one `makeFolders` would create), or null when `dir` exists. */
async function firstMissing(dir: string): Promise<string | null> {
  let missing: string | null = null;
  for (let at = dir; await access(at).then(() => false, () => true); at = dirname(at)) missing = at;
  return missing;
}

/** Removes the folders `makeFolders` created for a download that left nothing in them: `dir` and its parents up to `created`, each only if empty. */
async function removeEmptyFolders(dir: string, created: string): Promise<void> {
  for (let at = dir; ; at = dirname(at)) {
    try {
      await rmdir(at);
    } catch {
      return;
    }
    if (at === created) return;
  }
}

const digestOfBytes = (bytes: Uint8Array): Digest => ({ sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });

/** The digest of the file at `fullPath`, read as a stream so a large file (a video) is never held in memory. */
async function digestOfFile(fullPath: string): Promise<Digest> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(fullPath)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), size };
}

/** What a folder holds under each file name: its content (bytes, or their digest), or a way to get it (only used when a name is taken). */
export type FolderFiles = Map<string, Uint8Array | Digest | (() => Promise<Uint8Array | Digest>)>;

/**
 * The name a downloaded file is saved under in a folder holding `folderFiles`: a file by that name (or a numbered
 * copy of it) with the very same bytes (`content`: the bytes, or their digest) is reused; otherwise the name itself, or
 * `name 1.ext`, `name 2.ext`… for the first not taken, as Obsidian numbers files. Names are compared ignoring case.
 */
export async function downloadName(name: string, content: Uint8Array | Digest, folderFiles: FolderFiles): Promise<{ name: string; reuse: boolean }> {
  const wanted = content instanceof Uint8Array ? digestOfBytes(content) : content;
  const held = new Map([...folderFiles].map(([file, held]) => [key(file), { file, content: held }]));
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : `${stem} ${n}${ext}`;
    const taken = held.get(key(candidate));
    if (!taken) return { name: candidate, reuse: false };
    const there = typeof taken.content === "function" ? await taken.content() : taken.content;
    const digest = there instanceof Uint8Array ? digestOfBytes(there) : there;
    if (digest.size === wanted.size && digest.sha256 === wanted.sha256) return { name: taken.file, reuse: true };
  }
}

export interface DownloadDeps {
  /** The gateway the run uses: it downloads, and its files are the ones `pending` lists. */
  notion: ImageGateway;
  store: ImageStore;
  vault: VaultFs;
  /** Where downloads go (`media.folder`). */
  media: VaultMedia;
  dryRun: boolean;
}

export interface Downloads {
  /** Each file brought in, with the page that holds it and the kind of its block there (what the run's lines call it). */
  downloaded: { path: string; pageId: PageId; kind: MediaKind }[];
  /** Downloads that went wrong: their pages are held until the file can be downloaded. */
  failed: { pageId: PageId; name: string; reason: string }[];
  /** Hosted files whose name no note can cite (no extension, or a note's, canvas's, base's or drawing's): no download can ever make a citation of them, so their pages are not held. */
  unsupported: { pageId: PageId; name: string }[];
}

/** A file name Notion gave, as a name in one folder. */
const fileNameOf = (name: string) => name.replace(/[\\/\0]/g, "_");

/**
 * Downloads every file of `pending` (any kind) that the vault doesn't have yet, saves it in `media.folder` (a file whose
 * key the store knows goes back to its own path), and records `key -> path` so the page's canonical text cites the file.
 * Each download is streamed to a temporary file beside its destination and hashed on the way, so a large video is never
 * held in memory; it then takes its name (or is dropped, when the vault already holds those bytes under that name).
 * Nothing is overwritten. In a dry run nothing is written to the vault or saved: the file goes to a temporary folder and
 * is removed, and the store only remembers in memory.
 */
export async function fetchPending(pending: PendingImage[], deps: DownloadDeps): Promise<Downloads> {
  const { notion, store, vault, media, dryRun } = deps;
  const result: Downloads = { downloaded: [], failed: [], unsupported: [] };
  const folder = media.folder;
  const inVault = (path: string) => join(vault.root, path);
  /** The folder as it is, and as this run leaves it. */
  let files: FolderFiles | undefined;
  const folderFiles = async (): Promise<FolderFiles> => {
    if (files) return files;
    files = new Map();
    const entries = await readdir(inVault(folder), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile()) files.set(entry.name, () => digestOfFile(inVault(posix.join(folder, entry.name))));
    }
    return files;
  };

  /**
   * Streams the file behind `url` into a temporary file and runs `use` on its digest and a `keep` that gives it its final vault
   * path; the temporary file is gone afterwards however `use` ends. A real run's temporary file sits beside its destination (so
   * taking its name is one atomic rename); a dry run's is in the system's temporary folder.
   */
  async function received<T>(url: string, into: string, use: (digest: Digest, keep: (path: string) => Promise<void>) => Promise<T>): Promise<T> {
    const scratch = dryRun ? await mkdtemp(join(tmpdir(), "nopipeline-download-")) : null;
    const dir = scratch ?? inVault(into);
    // A folder this download makes is taken away again if nothing ends up in it, so a refused download changes nothing.
    const created = scratch === null ? await firstMissing(dir) : null;
    if (scratch === null) await makeFolders(dir);
    const temp = join(dir, scratch === null ? `.nopipeline-download-${randomBytes(6).toString("hex")}` : "download");
    try {
      const digest = await notion.downloadTo(url, temp);
      return await use(digest, async (path) => {
        if (scratch !== null) return;
        await flush(temp);
        await vault.move(posix.join(into, basename(temp)), path);
      });
    } finally {
      if (scratch !== null) await rm(scratch, { recursive: true, force: true });
      else {
        await rm(temp, { force: true });
        if (created !== null) await removeEmptyFolders(dir, created);
      }
    }
  }

  for (const file of pending) {
    const known = store.pathOf(file.key);
    // Pending is not pruned once a download is recorded: a file the vault has is done.
    if (known !== null && (await vault.exists(known))) continue;
    const bare = hostedFile(file.url)!.bare;
    const name = fileNameOf(file.name);
    if (known === null && (mediaKind(name) === null || name === "." || name === "..")) {
      result.unsupported.push({ pageId: file.pageId, name: file.name });
      continue;
    }
    try {
      if (known !== null) {
        // A file the sync knew whose copy was deleted: back to the same path.
        await received(file.url, posix.dirname(known) === "." ? "" : posix.dirname(known), async (digest, keep) => {
          await keep(known);
          const entry = store.get(known)!;
          // The upload stays as it is: it is reused only while it holds the file as it is (`uploadSha`).
          store.set(known, { ...entry, sha256: digest.sha256, size: digest.size });
        });
        result.downloaded.push({ path: known, pageId: file.pageId, kind: file.kind });
        continue;
      }
      const all = await folderFiles();
      const path = await received(file.url, folder, async (digest, keep) => {
        const chosen = await downloadName(name, digest, all);
        const target = folder === "" ? chosen.name : `${folder}/${chosen.name}`;
        if (!chosen.reuse) {
          await keep(target);
          all.set(chosen.name, digest);
        }
        const entry = store.get(target);
        const same = entry?.sha256 === digest.sha256 ? entry : undefined;
        store.set(target, {
          sha256: digest.sha256,
          size: digest.size,
          uploadId: entry?.uploadId ?? null,
          uploadSha: entry?.uploadSha ?? null,
          keys: [...new Set([...(same?.keys ?? []), file.key])],
          urls: { ...(same?.urls ?? {}), [file.key]: bare },
        });
        return target;
      });
      result.downloaded.push({ path, pageId: file.pageId, kind: file.kind });
    } catch (error) {
      if (!(error instanceof NotionPageError)) throw error;
      result.failed.push({ pageId: file.pageId, name: file.name, reason: error.message });
    }
  }
  if (!dryRun && result.downloaded.length > 0) await store.save();
  return result;
}

/** A note's text with its hosted files written as citations. */
export interface ImageConversion {
  path: string;
  text: string;
  /** How many lines (images, PDFs, audio, video or files) were written as citations. */
  images: number;
}

/**
 * `text` (a note's, or a record's) with each media line (an image, or a PDF, audio, video or file tag: the form Notion's
 * markdown gives, `<pdf src="https://prod-files-secure…">caption</pdf>`) that holds a Notion-hosted file the store maps to a vault file
 * written as the Markdown citation of that file, caption and indent kept: an embed `![c](path)` for an image, PDF, audio or video,
 * a link `[c or name](path)` for a file; null when no line changes. A file the vault doesn't have stays as it is. Code is left alone.
 */
export function convertHostedImages(text: string, notePath: string, pathOf: (key: string) => string | null, media: VaultMedia): ImageConversion | null {
  if (!text.includes("prod-files-secure")) return null;
  let count = 0;
  const convert = (part: string) => {
    const crlf = part.endsWith("\r");
    const found = mediaLine(crlf ? part.slice(0, -1) : part);
    const file = found && hostedFile(found.url);
    const path = file && pathOf(file.key);
    if (!found || !path || media.resolve(path, notePath) !== path) return part;
    count++;
    const target = media.pathFor(path, notePath);
    const citation = found.kind === "file" ? `[${found.caption === "" ? posix.basename(path) : found.caption}](${target})` : `![${found.caption}](${target})`;
    return `${found.indent}${citation}${crlf ? "\r" : ""}`;
  };
  const converted = outsideCode(text, convert);
  return count > 0 ? { path: notePath, text: converted, images: count } : null;
}
