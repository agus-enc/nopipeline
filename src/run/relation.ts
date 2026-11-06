// The pass after a run: each page's "Links to" relation follows the links in its text (design 2026-11-03-links-to-relation §5).
import { linkedPageIds, nextRelation, sameEntries } from "../links/relation.ts";
import { NotionPageError, type NotionGateway } from "../notion/gateway.ts";
import type { RecordStore } from "../state/records.ts";
import type { PageId, PageMeta, SyncRecord } from "../types.ts";
import type { Summary } from "./execute.ts";

const HAND_OVER = "its Links to relation holds more than 100 notes added by hand; the sync leaves it as it is";
const sameOwned = (a: PageId[], b: PageId[] | undefined) => b !== undefined && sameEntries(a, b);

/**
 * Sets, for every page with a record that the run did not refuse, skip or leave alone, the relation entries its text
 * links to. Run after `execute`: the records hold each page's final text. A page created during the run is not in
 * `pages` (the listing is from before the run), so it is skipped this run; the next run lists it and fills it.
 * A relation that already holds the right entries gets no request. Failures for one page land in `summary.skipped`.
 */
export async function updateLinksTo(input: {
  notion: NotionGateway;
  records: RecordStore;
  pages: PageMeta[];
  leaveAlone: ReadonlySet<PageId>;
  summary: Summary;
}): Promise<void> {
  const { notion, records, leaveAlone, summary } = input;
  const listed = new Map(input.pages.map((p) => [p.id, p]));
  // The listing is from before the run: a page the run trashed or replaced is still in it, but doesn't count (§5.1).
  const live = new Set([...listed.keys()].filter((id) => !summary.trashedPages.includes(id)));
  for (const [id, record] of records.all()) {
    const page = listed.get(id);
    if (!page || leaveAlone.has(id)) continue;
    const linked = linkedPageIds(record.notionMarkdown, live, id);
    const remember = async (owned: PageId[]) => {
      if (!sameOwned(owned, record.linksTo)) await records.put({ ...record, linksTo: owned });
    };
    try {
      const current = page.linksTo?.more ? await notion.readRelation(id) : (page.linksTo?.ids ?? []);
      let next = nextRelation({ current, owned: record.linksTo, linked, live });
      if (next.handOver) {
        summary.skipped.push({ path: record.path, reason: HAND_OVER });
        continue;
      }
      if (sameEntries(next.relation, current)) {
        await remember(next.owned);
      } else {
        // The user may have changed the relation since the listing: read it again and decide on what is there now.
        const fresh = await notion.readRelation(id);
        next = nextRelation({ current: fresh, owned: record.linksTo, linked, live });
        if (next.handOver) {
          summary.skipped.push({ path: record.path, reason: HAND_OVER });
          continue;
        }
        if (sameEntries(next.relation, fresh)) {
          await remember(next.owned);
        } else {
          await notion.setRelation(id, next.relation);
          await records.put({ ...record, linksTo: next.owned });
          summary.linksTo++;
        }
      }
      if (next.capped) summary.skipped.push({ path: record.path, reason: "its Links to relation would hold more than 100 notes; only the first 100 were set" });
    } catch (error) {
      if (!(error instanceof NotionPageError)) throw error;
      summary.skipped.push({ path: record.path, reason: `${error.code}: its Links to relation could not be set; the next run tries again` });
    }
  }
}

/**
 * The pages whose relation a run would change, estimated before any action: from the text read this run (the record's
 * otherwise) and the relation as the pass sees it (read in full, a read only, when the listing shows 25 entries and more).
 * A page without a record is skipped; one in `leaveAlone` is not counted but stays a live link target.
 */
export async function previewLinksTo(input: {
  pages: PageMeta[];
  records: ReadonlyMap<PageId, SyncRecord>;
  fetched: ReadonlyMap<PageId, string>;
  readRelation: (id: PageId) => Promise<PageId[]>;
  leaveAlone?: ReadonlySet<PageId>;
}): Promise<PageId[]> {
  const live = new Set(input.pages.map((p) => p.id));
  const changed: PageId[] = [];
  for (const page of input.pages) {
    const record = input.records.get(page.id);
    if (!record || input.leaveAlone?.has(page.id)) continue;
    const linked = linkedPageIds(input.fetched.get(page.id) ?? record.notionMarkdown, live, page.id);
    let current = page.linksTo?.ids ?? [];
    if (page.linksTo?.more) {
      try {
        current = await input.readRelation(page.id);
      } catch (error) {
        // As the pass does: a page whose relation can't be read is left out of the estimate.
        if (!(error instanceof NotionPageError)) throw error;
        continue;
      }
    }
    const next = nextRelation({ current, owned: record.linksTo, linked, live });
    if (!next.handOver && !sameEntries(next.relation, current)) changed.push(page.id);
  }
  return changed;
}
