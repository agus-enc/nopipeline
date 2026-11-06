// Which attachments (of any kind) of the attachment folder the notes still cite, and which stored ones changed on disk (spec §5.7, §5.8, §5.12, attachments §5.13).
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { encodeSegment } from "../links/index.ts";
import { mediaKind, mediaLine, placeholderPath, placeholderUrl, type MediaKind } from "../notion/hosted.ts";
import type { ImageStore } from "../state/images.ts";
import type { StrandedMedia } from "../translate/index.ts";
import type { PageId } from "../types.ts";
import { isStatusNote } from "../vault/frontmatter.ts";
import { UPLOAD_LIMIT } from "../vault/images.ts";

/** Text as compared: composed and in lower case, so a citation that differs only in case or accents' form still protects its file. */
const folded = (text: string) => text.normalize("NFC").toLowerCase();

/** The forms a note may write a file name in: as it is, `encodeURIComponent`-encoded, and as the links the sync writes. */
const spellings = (name: string) => [...new Set([name, encodeURIComponent(name), encodeSegment(name)].map(folded))];

/** An attachment by its file name: a kind of file the sync carries, and no hidden file (`.DS_Store`). */
const isAttachmentName = (name: string) => !name.startsWith(".") && mediaKind(name) !== null;

/** A character a file name goes on with: before a name, it means the name is the end of a longer one (`alpha.png` holds `a.png`). */
const NAME_CHAR = /[\p{L}\p{N}_.-]/u;

/**
 * Whether `text` holds the name of the file at `path`, as written or URL-encoded (case ignored). Anywhere in the text, unless
 * `wholeName`: then not as the end of a longer name (a citation of `alpha.png` does not name `a.png`).
 */
export function namesMedia(text: string, path: string, wholeName = false): boolean {
  const lower = folded(text);
  return spellings(posix.basename(path)).some((name) => {
    for (let i = lower.indexOf(name); i !== -1; i = lower.indexOf(name, i + 1)) {
      if (!wholeName || i === 0 || !NAME_CHAR.test(lower[i - 1]!)) return true;
    }
    return false;
  });
}

const isNoteFile = (name: string) => name.endsWith(".md") || name.endsWith(".canvas");

/**
 * The vault paths of the attachments (images, PDFs, audio, video and other files) in `folder` (the files directly in it; "" is the vault root) that something still cites:
 * a file counts if its name, as written or URL-encoded, appears anywhere in any `.md` or `.canvas` file of the vault outside
 * `.trash` and the other dot-folders. That covers notes, conflict copies, drawings, canvases, frontmatter and HTML, and
 * over-protects on purpose: a file something may still use is never reported unused. A note that can't be read counts as
 * citing every attachment. `also`: texts counted as if a file held them (the last-synced text of a note this run left alone).
 */
export async function citedMedia(root: string, folder: string, also: readonly string[] = [], skip: string | null = null): Promise<Set<string>> {
  let entries;
  try {
    entries = await readdir(join(root, folder), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
  const images = entries.filter((e) => (e.isFile() || e.isSymbolicLink()) && isAttachmentName(e.name)).map((e) => ({ path: folder === "" ? e.name : `${folder}/${e.name}` }));
  return namedMedia(root, images.map((image) => image.path), also, false, skip);
}

/**
 * Which of `paths` (attachments, present or not) some `.md` or `.canvas` file of the vault names, by the same reading as `citedMedia`
 * (names anywhere in the text, over-protecting on purpose; an unreadable note names them all). `also`: texts counted as if a file held them.
 * `wholeName`: a longer name that ends like the file's doesn't count (the question is whether a citation of that very file is left).
 */
export async function namedMedia(root: string, paths: readonly string[], also: readonly string[] = [], wholeName = false, skip: string | null = null): Promise<Set<string>> {
  const images = paths.map((path) => ({ path }));
  const cited = new Set<string>();
  if (images.length === 0) return cited;
  const everything = () => images.forEach((image) => cited.add(image.path));
  const look = (text: string) => {
    for (const image of images) if (!cited.has(image.path) && namesMedia(text, image.path, wholeName)) cited.add(image.path);
  };

  for (const text of also) look(text);
  // A symlinked folder is followed, as Obsidian shows it (a note there may cite an image): on the safe side, one that can't be
  // looked into counts as citing every image. Each real folder is looked into once, so a link back up ends the walk.
  const visited = new Set<string>();
  async function walk(dir: string): Promise<void> {
    const real = await realpath(join(root, dir));
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || cited.size === images.length) continue;
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      let kind = { directory: entry.isDirectory(), file: entry.isFile() };
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(join(root, path));
          kind = { directory: target.isDirectory(), file: target.isFile() };
        } catch (error) {
          // A link to nothing cites nothing; one that can't be followed might lead to any note.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") everything();
          continue;
        }
      }
      if (kind.directory) {
        try {
          await walk(path);
        } catch (error) {
          if (!entry.isSymbolicLink() || (error as NodeJS.ErrnoException).code === "ENOENT") throw error;
          everything();
        }
      } else if (kind.file && isNoteFile(entry.name) && path !== skip) {
        try {
          const text = await readFile(join(root, path), "utf8");
          if (!isStatusNote(text)) look(text);
        } catch (error) {
          // A note that vanished since the listing cites nothing; one that can't be read might cite anything.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") everything();
        }
      }
    }
  }
  await walk("");
  return cited;
}

/** How many media blocks (image, PDF, audio, video or file) of each vault file `markdown` holds, as placeholder lines (a page read through the sync, or the text written for a note). */
function placeholderCounts(markdown: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of markdown.split("\n")) {
    const media = mediaLine(line);
    const path = media && placeholderPath(media.url);
    if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return counts;
}

/**
 * The vault files that `desired` (the text a write puts on a page) holds in more media blocks (of any kind) than `current` (the page as it
 * is, with its known files as placeholders): the blocks the write adds, each file once, in the order `desired` shows them.
 * Those blocks need an upload (a dry run lists them; spec §5.15).
 */
export function addedPlaceholders(desired: string, current: string): string[] {
  const there = placeholderCounts(current);
  const wanted = placeholderCounts(desired);
  return [...wanted].filter(([path, n]) => n > (there.get(path) ?? 0)).map(([path]) => path);
}

/** The attachments cited at the end of the last run, no longer cited, and still on disk: the ones to move to `.trash`. */
export function unusedMedia(previous: Set<string>, now: Set<string>, exists: (path: string) => boolean): string[] {
  return [...previous].filter((path) => !now.has(path) && exists(path));
}

/**
 * The stored attachments whose file now has a different hash than when it was last uploaded or downloaded (a file that's gone is not replaced).
 * A file that still has its stored hash, and whose entry has no size yet, gets its size (`sizeOf`) in the store, in memory: it is saved with
 * the store's next save, and a run that changes nothing writes nothing.
 */
export async function replacedMedia(
  store: ImageStore,
  sha: (path: string) => Promise<string | null>,
  sizeOf?: (path: string) => Promise<number | null>,
): Promise<string[]> {
  const replaced: string[] = [];
  for (const path of store.paths()) {
    const now = await sha(path);
    const entry = store.get(path)!;
    if (now === null) continue;
    if (now !== entry.sha256) replaced.push(path);
    else if (entry.size === undefined && sizeOf) {
      const size = await sizeOf(path);
      if (size !== null) store.set(path, { ...entry, size });
    }
  }
  return replaced;
}

/** Whether `path` is an attachment file (of any kind) directly in `folder` ("" is the vault root): the only files the run ever moves to `.trash`. */
export function inFolder(path: string, folder: string): boolean {
  return isAttachmentName(posix.basename(path)) && posix.dirname(path) === (folder === "" ? "." : folder);
}

/**
 * The pages (among `records`, of the ids `live` accepts) whose text, as last synced, holds the placeholder of the file at `path`:
 * as an image line (`![c](url)`) or as the `src` of a PDF, audio, video or file tag.
 */
export function pagesShowing(path: string, records: ReadonlyMap<PageId, { notionMarkdown: string }>, live: (id: PageId) => boolean): PageId[] {
  const url = placeholderUrl(path);
  const shown = [`](${url})`, `src="${url}"`];
  return [...records].filter(([id, record]) => live(id) && shown.some((form) => record.notionMarkdown.includes(form))).map(([id]) => id);
}

/** How the warnings call a file of each kind, and with what article. */
const KIND_NAMES: Record<MediaKind, { noun: string; article: string }> = {
  image: { noun: "image", article: "an" },
  pdf: { noun: "PDF", article: "a" },
  audio: { noun: "audio file", article: "an" },
  video: { noun: "video", article: "a" },
  file: { noun: "file", article: "a" },
};

/** A citation in a note's line: a wikilink's target, or a Markdown link's destination. */
const CITED = /\[\[([^\]|#\n]+)|\]\((?:<([^>\n]*)>|([^\s()<>]*))/g;

/** What kind of file the line cites: the first citation of an attachment (a note's link doesn't count), else a plain "file". */
function kindOfLine(line: string): MediaKind {
  for (const match of line.matchAll(CITED)) {
    let target = match[1] ?? match[2] ?? match[3] ?? "";
    try {
      target = decodeURIComponent(target);
    } catch {
      // keep it as written
    }
    const kind = mediaKind(target.split("#")[0]!.trim());
    if (kind !== null) return kind;
  }
  return "file";
}

/** The warning for a citation that stays text in Notion (spec §5.1, §5.10); `path` is the note. */
export function strandedWarning(path: string, { line, why }: StrandedMedia): string {
  const { noun, article } = KIND_NAMES[kindOfLine(line)];
  const on = `${path}: the ${noun} on the line "${line}"`;
  if (why === "large") return `${on} is over ${UPLOAD_LIMIT / 1024 / 1024} MB, the most Notion takes in one upload, so it stays text in Notion`;
  if (why === "followed") return `${on} has text after it in its list item or quote, so it stays text in Notion; move the text above it to sync it as ${article} ${noun}`;
  return `${on} shares its line with other text (or sits in a quote or table), so it stays text in Notion; put it on its own line to sync it as ${article} ${noun}`;
}

/** The warning for more unused attachments than the limit allows to move. */
export const tooManyFiles = (count: number, limit: number) =>
  `${count} files would be moved to .trash, more than the limit of ${limit}, so none were. Check the plan, then run again with --allow-mass-trash.`;
