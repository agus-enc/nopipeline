// What the sync knows about the vault's images and their Notion uploads, as one JSON file.
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { flush, makeFolders, writeFlushed } from "../durable.ts";
import type { PageId } from "../types.ts";

export interface StoredImage {
  /**
   * Hash of the file the blocks of the pages show: advanced only by a download and by a replacement that reached every
   * page (`refreshImage`), so a different hash on disk means some page still shows the old file, however many uploads of
   * the new one were made meanwhile.
   */
  sha256: string;
  /**
   * Size in bytes of the file that `sha256` is the hash of; absent in records from before it was kept (filled in the next time the
   * file is read and still has that hash). It lets a moved file be found among the vault's files by size before any is hashed.
   */
  size?: number;
  /** The last Notion upload of this file, if any: kept to attach it to more blocks (a new citation) instead of uploading again. */
  uploadId: string | null;
  /** Hash of the file as `uploadId` holds it; null when there is no upload. The upload is reused only while the file still has this hash. */
  uploadSha: string | null;
  /** The file uuids Notion gave this image's blocks (see `hostedFile`). */
  keys: string[];
  /** File uuid -> that file's bare hosted URL. */
  urls: Record<string, string>;
}

export interface ImageStore {
  get(path: string): StoredImage | undefined;
  /** The vault path of the image with this file uuid, or null. */
  pathOf(key: string): string | null;
  /** The bare hosted URL stored for this file uuid, or null. */
  urlOf(key: string): string | null;
  set(path: string, image: StoredImage): void;
  delete(path: string): void;
  /**
   * Moves what the store holds for `from` (the entry, its file uuids, a refusal of it; `from` leaves the cited set and `to` doesn't join it: what is cited is the run's own scan) to `to`, for
   * a file that was moved or renamed in the vault (attachments design §5.6). Nothing happens when `from` isn't held; `to` must be free.
   */
  rekey(from: string, to: string): void;
  paths(): string[];
  /** The images the notes cited at the last run (a copy). */
  cited(): Set<string>;
  setCited(paths: Iterable<string>): void;
  /** The pages that were last seen holding a placeholder image no upload has replaced (a copy): they are read again to finish the switch. */
  unattached(): Set<PageId>;
  setUnattached(ids: Iterable<PageId>): void;
  /** Why Notion refused the upload of each vault file whose citation still stands, by vault path (a copy): said in every run's warnings until the citation changes (attachments design §5.11). */
  refusals(): Map<string, string>;
  setRefusals(refusals: Iterable<[path: string, reason: string]>): void;
  save(): Promise<void>;
}

interface Stored {
  images: Record<string, StoredImage>;
  cited: string[];
  unattached?: PageId[];
  refused?: Record<string, string>;
}

export async function openImageStore(stateDir: string): Promise<ImageStore> {
  const file = join(stateDir, "images.json");
  const images = new Map<string, StoredImage>();
  const owner = new Map<string, string>();
  let cited = new Set<string>();
  let unattached = new Set<PageId>();
  let refused = new Map<string, string>();
  const claim = (path: string, image: StoredImage) => {
    for (const key of image.keys) owner.set(key, path);
  };

  let text: string | undefined;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text !== undefined) {
    let stored: Partial<Stored>;
    try {
      stored = JSON.parse(text) as Partial<Stored>;
    } catch (error) {
      throw new Error(`can't read the image records ${file} (${error instanceof Error ? error.message : String(error)}); fix or delete it, then run again`);
    }
    for (const [path, image] of Object.entries(stored.images ?? {})) {
      // Records from before the hash was split in two: the one hash was also the upload's.
      const entry = { ...image, uploadSha: image.uploadSha !== undefined ? image.uploadSha : image.uploadId === null ? null : image.sha256 };
      images.set(path, entry);
      claim(path, entry);
    }
    cited = new Set(stored.cited ?? []);
    unattached = new Set(stored.unattached ?? []);
    refused = new Map(Object.entries(stored.refused ?? {}));
  }

  /** Releases the keys of `path`'s entry, except those another path has taken over since. */
  const release = (path: string) => {
    for (const key of images.get(path)?.keys ?? []) if (owner.get(key) === path) owner.delete(key);
  };

  return {
    get: (path) => images.get(path),
    pathOf: (key) => owner.get(key) ?? null,
    urlOf(key) {
      const path = owner.get(key);
      return (path !== undefined && images.get(path)?.urls[key]) || null;
    },
    set(path, image) {
      release(path);
      const copy = structuredClone(image);
      images.set(path, copy);
      claim(path, copy);
    },
    delete(path) {
      release(path);
      images.delete(path);
    },
    rekey(from, to) {
      const image = images.get(from);
      if (image === undefined) return;
      if (images.has(to)) throw new Error(`can't re-key ${from} to ${to}: the image records already hold ${to}`);
      release(from);
      images.delete(from);
      images.set(to, image);
      claim(to, image);
      // `from` is no longer cited as a stored file; `to` is not either until a note is seen citing it (the run's own scan says so): a
      // never-cited copy that took the place of a deleted file must not count as cited at the end of the last run (spec §5.12).
      cited.delete(from);
      const reason = refused.get(from);
      if (reason !== undefined) {
        refused.delete(from);
        refused.set(to, reason);
      }
    },
    paths: () => [...images.keys()],
    cited: () => new Set(cited),
    setCited(paths) {
      cited = new Set(paths);
    },
    unattached: () => new Set(unattached),
    setUnattached(ids) {
      unattached = new Set(ids);
    },
    refusals: () => new Map(refused),
    setRefusals(refusals) {
      refused = new Map(refusals);
    },
    async save() {
      const stored: Stored = { images: Object.fromEntries(images), cited: [...cited], unattached: [...unattached], ...(refused.size > 0 ? { refused: Object.fromEntries(refused) } : {}) };
      await makeFolders(stateDir);
      // Flushed before it takes its name, and the name after: a power cut leaves the old file or the new one.
      await writeFlushed(`${file}.tmp`, `${JSON.stringify(stored, null, 2)}\n`);
      await rename(`${file}.tmp`, file);
      await flush(stateDir);
    },
  };
}
