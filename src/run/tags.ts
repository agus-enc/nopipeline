// The pass after a run: each note's frontmatter `tags` and its page's tags property are brought in step (design 2026-11-06-tags).
import { NotionPageError, type NotionGateway } from "../notion/gateway.ts";
import type { RecordStore } from "../state/records.ts";
import type { PageId, PageMeta, SyncRecord } from "../types.ts";
import type { VaultFs } from "../vault/fs.ts";
import { splitFrontmatter } from "../vault/frontmatter.ts";
import { isObsidianTag, mergeTags, readTags, sameTags, writeTags } from "../vault/tags.ts";

interface Decision {
  /** The page's names a note can hold. */
  valid: string[];
  /** The page's names a note can't hold: they stay in Notion only. */
  kept: string[];
  noteTags: string[];
  merged: string[];
}

/** What a note and its page should hold, or why the note's tags are left alone. */
function decide(record: SyncRecord, page: PageMeta, text: string): Decision | { unsafe: string } {
  const read = readTags(text);
  if (read.kind === "unsafe") return { unsafe: read.reason };
  const names = page.tags ?? [];
  const valid = names.filter(isObsidianTag);
  const kept = names.filter((name) => !isObsidianTag(name));
  return { valid, kept, noteTags: read.tags, merged: mergeTags(record.tags, read.tags, valid) };
}

/**
 * Brings, for every page with a record and a note that the run did not leave alone, the note's frontmatter tags and the
 * page's tags property to the same set (a three-way merge against the record's tags). Run after `execute`: each note is
 * read as the run left it. A page created during the run is not in `pages` (the listing is from before it), so it is
 * done next run. The record's tags (and note text, when the pass wrote the note) are saved only when everything that
 * had to be written was; a Notion error for one page lands in `skipped`.
 */
export async function syncTags(input: {
  pages: ReadonlyMap<PageId, PageMeta>;
  records: RecordStore;
  vault: VaultFs;
  notion: Pick<NotionGateway, "setTags">;
  leaveAlone: ReadonlySet<PageId>;
  skipped: { path: string; reason: string }[];
  log: (line: string) => void;
}): Promise<{ set: number; written: number }> {
  const { pages, records, vault, notion, leaveAlone, skipped, log } = input;
  let set = 0;
  let written = 0;
  for (const [id, record] of records.all()) {
    const page = pages.get(id);
    if (!page || leaveAlone.has(id)) continue;
    const text = await vault.read(record.path).catch(() => null);
    if (text === null) continue;
    const decision = decide(record, page, text);
    if ("unsafe" in decision) {
      log(`warning: ${record.path}: its frontmatter "tags" can't be edited safely (${decision.unsafe}); its tags are left alone`);
      continue;
    }
    // A body edited since the last sync is not the pass's to record as synced: the pair waits for the run that pushes it.
    if (splitFrontmatter(text).body !== splitFrontmatter(record.obsidianText).body) {
      skipped.push({ path: record.path, reason: `changed_in_obsidian: ${record.path} changed in Obsidian during this run; its tags sync next run` });
      continue;
    }
    const { kept, valid, noteTags, merged } = decision;
    for (const name of kept) log(`warning: ${record.path}: the Notion tag "${name}" can't be an Obsidian tag; it stays in Notion only`);
    let nextText = text;
    if (!sameTags(merged, noteTags)) {
      nextText = writeTags(text, merged);
      await vault.write(record.path, nextText);
      written++;
    }
    try {
      if (!sameTags(merged, valid)) {
        await notion.setTags(id, [...merged, ...kept]);
        set++;
      }
    } catch (error) {
      if (!(error instanceof NotionPageError)) throw error;
      skipped.push({ path: record.path, reason: `${error.code}: its tags could not be set in Notion; the next run tries again` });
      continue;
    }
    if (record.tags === undefined || !sameTags(record.tags, merged) || nextText !== text) {
      await records.put({ ...record, tags: merged, ...(nextText !== text ? { obsidianText: nextText } : {}) });
    }
  }
  return { set, written };
}

/** What the pass would do for each page it may touch, in record order: the note's path and which sides it would write. */
export function tagChanges(input: {
  notes: ReadonlyMap<string, { text: string }>;
  pages: ReadonlyMap<PageId, PageMeta>;
  records: ReadonlyMap<PageId, SyncRecord>;
  leaveAlone: ReadonlySet<PageId>;
}): { path: string; writeNote: boolean; setPage: boolean }[] {
  const changes: { path: string; writeNote: boolean; setPage: boolean }[] = [];
  for (const [id, record] of input.records) {
    const page = input.pages.get(id);
    const note = input.notes.get(record.path);
    if (!page || !note || input.leaveAlone.has(id)) continue;
    const decision = decide(record, page, note.text);
    if ("unsafe" in decision) continue;
    const writeNote = !sameTags(decision.merged, decision.noteTags);
    const setPage = !sameTags(decision.merged, decision.valid);
    if (writeNote || setPage) changes.push({ path: record.path, writeNote, setPage });
  }
  return changes;
}

/** The plan lines for a dry run, from the notes as scanned: `set tags in Notion on <path>` / `write tags to <path>`. */
export function previewTags(input: Parameters<typeof tagChanges>[0]): string[] {
  return tagChanges(input).flatMap((c) => [...(c.writeNote ? [`write tags to ${c.path}`] : []), ...(c.setPage ? [`set tags in Notion on ${c.path}`] : [])]);
}
