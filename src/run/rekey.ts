// Moved and renamed attachments are recognized by their bytes (attachments design §5.6, §5.12): a stored file that is gone
// and a vault file the store doesn't know with the same bytes are the same file, and everything the sync holds for it follows.
import { posix } from "node:path";
import { placeholderUrl } from "../notion/hosted.ts";
import type { ImageStore } from "../state/images.ts";
import type { RecordStore } from "../state/records.ts";
import type { PageId, SyncRecord } from "../types.ts";

export interface Rekey {
  from: string;
  to: string;
}

export interface RekeyPlan {
  moves: Rekey[];
  /** Stored files that several vault files could be: the run stops, naming them. */
  ambiguous: { from: string; candidates: string[] }[];
}

/**
 * For each stored file that is gone (`exists` says so), the vault `files` the store doesn't know whose bytes (`sha`) are the stored ones.
 * One is a move; several, the one with the stored file's name; else ambiguous. Two gone files that would take the same file are both
 * ambiguous. A file of another name than the stored one is taken only when no note names the stored file any more (`named`: Obsidian
 * renamed the file and rewrote the citations); while one does, a never-cited copy of the same bytes is not the file and is left alone
 * (spec §5.12). A stored file with a known size is compared with the files of that size only, so no other file is read; one stored without a
 * size (before sizes were kept) is compared with every unknown file. A file is hashed once, and only when something is gone.
 */
export async function planRekeys(
  store: ImageStore,
  files: readonly { path: string; size: number }[],
  sha: (path: string) => Promise<string>,
  exists: (path: string) => boolean,
  named: (path: string) => boolean = () => false,
): Promise<RekeyPlan> {
  const gone = store.paths().filter((path) => !exists(path)).sort();
  if (gone.length === 0) return { moves: [], ambiguous: [] };
  const known = new Set(store.paths());
  const unknown = files.filter((f) => !known.has(f.path));
  const hashes = new Map<string, string>();
  const hashOf = async (path: string) => {
    if (!hashes.has(path)) hashes.set(path, await sha(path));
    return hashes.get(path)!;
  };

  const chosen = new Map<string, string>();
  const ambiguous = new Map<string, string[]>();
  for (const from of gone) {
    const { sha256: wanted, size } = store.get(from)!;
    const candidates: string[] = [];
    for (const file of unknown) if ((size === undefined || file.size === size) && (await hashOf(file.path)) === wanted) candidates.push(file.path);
    const sameName = candidates.filter((path) => posix.basename(path) === posix.basename(from));
    const eligible = named(from) ? sameName : candidates;
    if (eligible.length === 0) continue;
    if (eligible.length === 1) chosen.set(from, eligible[0]!);
    else if (sameName.length === 1) chosen.set(from, sameName[0]!);
    else ambiguous.set(from, eligible);
  }
  // Two stored files can't both become one vault file.
  const wanting = [...chosen];
  for (const [from, to] of wanting) {
    if (wanting.filter(([, other]) => other === to).length > 1) {
      chosen.delete(from);
      ambiguous.set(from, [to]);
    }
  }
  return {
    moves: [...chosen].map(([from, to]) => ({ from, to })),
    ambiguous: [...ambiguous].map(([from, candidates]) => ({ from, candidates })).sort((a, b) => (a.from < b.from ? -1 : 1)),
  };
}

const URL_END = /[\s"'()<>#?]/;

/** `text` with the placeholder URL of `from` replaced by that of `to`; a longer URL that only starts like it is left alone. */
function replaceUrl(text: string, from: string, to: string): string {
  const old = placeholderUrl(from);
  const fresh = placeholderUrl(to);
  let out = "";
  let at = 0;
  for (let i = text.indexOf(old); i !== -1; i = text.indexOf(old, at)) {
    const next = text[i + old.length];
    out += text.slice(at, i) + (next === undefined || URL_END.test(next) ? fresh : old);
    at = i + old.length;
  }
  return out + text.slice(at);
}

/**
 * Re-keys the store and every record's page text (and a note's text where it holds the placeholder), in memory. With `save`, the
 * changed records are written first and the image records after, so a run cut short in between finds the moves again and finishes them.
 */
export async function applyRekeys(moves: readonly Rekey[], images: ImageStore, records: Map<PageId, SyncRecord>, save: RecordStore | null): Promise<void> {
  if (moves.length === 0) return;
  for (const [id, record] of records) {
    let { notionMarkdown, obsidianText } = record;
    for (const { from, to } of moves) {
      notionMarkdown = replaceUrl(notionMarkdown, from, to);
      obsidianText = replaceUrl(obsidianText, from, to);
    }
    if (notionMarkdown === record.notionMarkdown && obsidianText === record.obsidianText) continue;
    const moved = { ...record, notionMarkdown, obsidianText };
    records.set(id, moved);
    await save?.put(moved);
  }
  for (const { from, to } of moves) images.rekey(from, to);
  if (save !== null) await images.save();
}
