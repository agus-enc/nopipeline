import { test } from "node:test";
import assert from "node:assert/strict";
import { NotionPageError } from "../../src/notion/gateway.ts";
import { previewLinksTo, updateLinksTo } from "../../src/run/relation.ts";
import type { Summary } from "../../src/run/execute.ts";
import type { RecordStore } from "../../src/state/records.ts";
import type { PageId, SyncRecord } from "../../src/types.ts";
import { FakeNotion } from "../helpers/fake-notion.ts";

const link = (id: PageId) => `[page](https://app.notion.com/p/${id.replace(/-/g, "")})`;
const emptySummary = (): Summary => ({ done: {}, conflicts: [], skipped: [], rewritten: [], linksTo: 0, skippedPages: [], trashedPages: [], mediaUpdated: [], mediaMoved: [], mediaUploaded: 0, mediaRekeyed: [] });

function memoryStore(): RecordStore & { puts: SyncRecord[]; map: Map<PageId, SyncRecord> } {
  const map = new Map<PageId, SyncRecord>();
  const puts: SyncRecord[] = [];
  return {
    map,
    puts,
    all: () => new Map(map),
    async put(record) {
      puts.push(record);
      map.set(record.notionId, record);
    },
    async remove(id) {
      map.delete(id);
    },
  };
}

/** A database where each page has a record saying its text is `markdown`. */
function world(pages: Record<string, string | ((ids: Record<string, PageId>) => string)>) {
  const notion = new FakeNotion();
  notion.addLinksTo();
  const ids: Record<string, PageId> = {};
  for (const name of Object.keys(pages)) ids[name] = notion.add(name, "");
  const records = memoryStore();
  for (const [name, text] of Object.entries(pages)) {
    const markdown = typeof text === "function" ? text(ids) : text;
    notion.edit(ids[name]!, { markdown });
    records.map.set(ids[name]!, {
      notionId: ids[name]!,
      path: `${name}.md`,
      title: name,
      folder: null,
      obsidianText: markdown,
      notionMarkdown: markdown,
      notionSeenAt: "2026-09-27T10:00:00.000Z",
      syncedAt: "2026-09-27T10:00:00.000Z",
    });
  }
  notion.calls.length = 0;
  const pass = async (leaveAlone: ReadonlySet<PageId> = new Set(), summary = emptySummary()) => {
    const listed = await notion.listPages();
    notion.calls.length = 0;
    await updateLinksTo({ notion, records, pages: listed, leaveAlone, summary });
    return summary;
  };
  return { notion, ids, records, pass };
}

const writes = (notion: FakeNotion) => notion.calls.filter((c) => c.startsWith("setRelation"));
const reads = (notion: FakeNotion) => notion.calls.filter((c) => c.startsWith("readRelation"));

test("the first pass fills a page that links to two others, and a second identical pass makes no request", async () => {
  const { notion, ids, records, pass } = world({ A: (i) => `${link(i.B!)} and ${link(i.C!)}`, B: "b", C: "c" });
  const first = await pass();
  assert.equal(first.linksTo, 1);
  assert.deepEqual(notion.pages.get(ids.A!)!.linksTo, [ids.B, ids.C]);
  assert.deepEqual(records.map.get(ids.A!)!.linksTo, [ids.B, ids.C]);
  assert.equal(writes(notion).length, 1);
  assert.deepEqual(first.skipped, []);

  const second = await pass();
  assert.equal(second.linksTo, 0);
  assert.deepEqual(notion.calls.filter((c) => c.startsWith("setRelation") || c.startsWith("readRelation")), []);
});

test("a page with no links gets an empty linksTo on its record and no request", async () => {
  const { notion, ids, records, pass } = world({ A: "text", B: "text" });
  const summary = await pass();
  assert.equal(summary.linksTo, 0);
  assert.deepEqual(notion.calls.filter((c) => c.startsWith("setRelation") || c.startsWith("readRelation")), []);
  assert.deepEqual(records.map.get(ids.A!)!.linksTo, []);
  records.puts.length = 0;
  await pass();
  assert.deepEqual(records.puts, []);
});

test("a hand entry survives a pass where the text lost its link, and the sync's own entry goes", async () => {
  const { notion, ids, records, pass } = world({ A: (i) => link(i.B!), B: "b", C: "c" });
  await pass();
  notion.edit(ids.A!, { linksTo: [ids.B!, ids.C!] }); // the user added C by hand
  notion.edit(ids.A!, { markdown: "no links now" });
  records.map.set(ids.A!, { ...records.map.get(ids.A!)!, notionMarkdown: "no links now" });
  const summary = await pass();
  assert.equal(summary.linksTo, 1);
  assert.deepEqual(notion.pages.get(ids.A!)!.linksTo, [ids.C]);
  assert.deepEqual(records.map.get(ids.A!)!.linksTo, []);
});

test("a page in leaveAlone gets no call and keeps its record", async () => {
  const { notion, ids, records, pass } = world({ A: (i) => link(i.B!), B: "b" });
  const before = records.map.get(ids.A!);
  const summary = await pass(new Set([ids.A!]));
  assert.equal(summary.linksTo, 0);
  assert.deepEqual(notion.calls.filter((c) => c.includes(ids.A!)), []);
  assert.equal(records.map.get(ids.A!), before);
  assert.equal(notion.pages.get(ids.A!)!.linksTo, undefined);
});

test("a page this run trashed or replaced is not linked to, and its links are not written", async () => {
  const { notion, ids, records, pass } = world({ A: (i) => `${link(i.B!)} and ${link(i.C!)}`, B: (i) => link(i.A!), C: "c" });
  // B was trashed by this run (its record is gone) but is still in the listing taken before it.
  records.map.delete(ids.B!);
  const summary = emptySummary();
  summary.trashedPages = [ids.B!];
  await pass(new Set(), summary);
  assert.deepEqual(notion.pages.get(ids.A!)!.linksTo, [ids.C]);
  assert.deepEqual(records.map.get(ids.A!)!.linksTo, [ids.C]);
  assert.deepEqual(summary.skipped, []);
  assert.deepEqual(notion.calls.filter((c) => c.includes(ids.B!)), []);
});

test("an entry the sync added keeps being the sync's through a trash and restore of its page", async () => {
  const { notion, ids, records, pass } = world({ A: (i) => link(i.T!), T: "t", H: "h" });
  await pass();
  assert.deepEqual(notion.pages.get(ids.A!)!.linksTo, [ids.T]);
  notion.edit(ids.T!, { inTrash: true });
  await pass();
  assert.deepEqual(records.map.get(ids.A!)!.linksTo, [ids.T]);
  // Restored, and the link is gone from the text meanwhile: the entry goes, it was never the user's.
  notion.pages.get(ids.T!)!.inTrash = false;
  records.map.set(ids.A!, { ...records.map.get(ids.A!)!, notionMarkdown: "no links now" });
  await pass();
  assert.deepEqual(notion.pages.get(ids.A!)!.linksTo, []);
  assert.deepEqual(records.map.get(ids.A!)!.linksTo, []);
});

test("a page with more than 100 hand entries is left as it is and reported", async () => {
  const { notion, ids, records, pass } = world({ A: (i) => link(i.B!), B: "b" });
  const hand = Array.from({ length: 101 }, (_, n) => notion.add(`X${n}`, ""));
  notion.edit(ids.A!, { linksTo: hand });
  const before = records.map.get(ids.A!);
  const summary = await pass();
  assert.deepEqual(writes(notion), []);
  assert.equal(notion.pages.get(ids.A!)!.linksTo, hand);
  assert.equal(records.map.get(ids.A!), before);
  assert.equal(summary.linksTo, 0);
  assert.deepEqual(summary.skipped, [{ path: "A.md", reason: "its Links to relation holds more than 100 notes added by hand; the sync leaves it as it is" }]);
});

test("a record whose page is not listed is skipped", async () => {
  const { notion, ids, records, pass } = world({ A: (i) => link(i.B!), B: "b" });
  notion.edit(ids.A!, { inTrash: true });
  const summary = await pass();
  assert.equal(summary.linksTo, 0);
  assert.deepEqual(writes(notion), []);
  assert.equal(records.map.get(ids.A!)!.linksTo, undefined);
});

test("a page with more than 25 entries is read in full and keeps the hand entries past the 25th", async () => {
  const { notion, ids, records, pass } = world({ A: (i) => link(i.B!), B: "b" });
  const extra = Array.from({ length: 30 }, (_, n) => notion.add(`X${n}`, ""));
  notion.edit(ids.A!, { linksTo: extra });
  const summary = await pass();
  assert.equal(summary.linksTo, 1);
  assert.ok(reads(notion).length >= 1);
  assert.deepEqual(notion.pages.get(ids.A!)!.linksTo, [...extra, ids.B]);
  assert.deepEqual(notion.pages.get(ids.A!)!.linksTo!.slice(25, 30), extra.slice(25, 30));
  assert.deepEqual(records.map.get(ids.A!)!.linksTo, [ids.B]);
});

test("a refused relation write lands in the skipped list and leaves the record as it was", async () => {
  const { notion, ids, records, pass } = world({ A: (i) => link(i.B!), B: "b", C: (i) => link(i.B!) });
  const original = notion.setRelation.bind(notion);
  notion.setRelation = async (id, list) => {
    if (id === ids.A) throw new NotionPageError("validation_error", "refused");
    return original(id, list);
  };
  const before = records.map.get(ids.A!);
  const summary = await pass();
  assert.deepEqual(summary.skipped, [{ path: "A.md", reason: "validation_error: its Links to relation could not be set; the next run tries again" }]);
  assert.equal(records.map.get(ids.A!), before);
  assert.equal(summary.linksTo, 1);
  assert.deepEqual(notion.pages.get(ids.C!)!.linksTo, [ids.B]);
});

test("a page that cannot be read is skipped the same way", async () => {
  const { notion, ids, pass } = world({ A: (i) => link(i.B!), B: "b" });
  notion.edit(ids.A!, { linksTo: Array.from({ length: 30 }, (_, n) => notion.add(`X${n}`, "")) });
  notion.readRelation = async () => {
    throw new NotionPageError("object_not_found", "gone");
  };
  const summary = await pass();
  assert.deepEqual(summary.skipped.map((s) => s.reason), ["object_not_found: its Links to relation could not be set; the next run tries again"]);
});

test("an entry added in Notion between the listing and the write is kept", async () => {
  const { notion, ids, records, pass } = world({ A: (i) => link(i.B!), B: "b", C: "c" });
  const original = notion.readRelation.bind(notion);
  notion.readRelation = async (id) => {
    // The user adds C after the run listed the pages and before the sync writes.
    if (id === ids.A && notion.pages.get(id)!.linksTo === undefined) notion.edit(id, { linksTo: [ids.C!] });
    return original(id);
  };
  await pass();
  assert.deepEqual(notion.pages.get(ids.A!)!.linksTo, [ids.C, ids.B]);
  assert.deepEqual(records.map.get(ids.A!)!.linksTo, [ids.B]);
});

test("a page that would hold more than 100 entries gets the first 100 and a skipped line", async () => {
  const { notion, ids, records, pass } = world({ A: (i) => link(i.B!), B: "b" });
  const extra = Array.from({ length: 100 }, (_, n) => notion.add(`X${n}`, ""));
  notion.edit(ids.A!, { linksTo: extra });
  const summary = await pass();
  assert.deepEqual(notion.pages.get(ids.A!)!.linksTo, extra);
  assert.deepEqual(records.map.get(ids.A!)!.linksTo, []);
  assert.deepEqual(summary.skipped, [{ path: "A.md", reason: "its Links to relation would hold more than 100 notes; only the first 100 were set" }]);
});

test("previewLinksTo lists the pages whose relation would change, from the fetched text first", async () => {
  const notion = new FakeNotion();
  const a = notion.add("A", "");
  const b = notion.add("B", "");
  const c = notion.add("C", "");
  const record = (id: PageId, name: string, text: string): SyncRecord => ({
    notionId: id,
    path: `${name}.md`,
    title: name,
    folder: null,
    obsidianText: text,
    notionMarkdown: text,
    notionSeenAt: "",
    syncedAt: "",
  });
  const pages = [a, b, c].map((id, n) => ({ id, title: "ABC"[n]!, folder: null, lastEditedTime: "", linksTo: { ids: [] as PageId[], more: false } }));
  const records = new Map([
    [a, record(a, "A", "old")],
    [b, record(b, "B", link(c))],
  ]);
  // A's record says nothing, but the text read this run links to B; C has no record and is skipped.
  const readRelation = async () => [] as PageId[];
  assert.deepEqual(await previewLinksTo({ pages, records, fetched: new Map([[a, link(b)]]), readRelation }), [a, b]);
});

test("P2: previewLinksTo reads the whole relation of a page whose listing was cut short, as the pass does, and counts links to a page left alone", async () => {
  const notion = new FakeNotion();
  const hub = notion.add("Hub", "");
  const targets = Array.from({ length: 37 }, (_, n) => notion.add(`T${n}`, ""));
  const text = targets.map(link).join("\n");
  const record: SyncRecord = { notionId: hub, path: "Hub.md", title: "Hub", folder: null, obsidianText: text, notionMarkdown: text, notionSeenAt: "", syncedAt: "", linksTo: targets };
  const all = [hub, ...targets].map((id) => ({ id, title: id, folder: null, lastEditedTime: "", ...(id === hub ? { linksTo: { ids: targets.slice(0, 25), more: true } } : {}) }));
  const readRelation = async () => targets;
  const records = new Map([[hub, record]]);
  assert.deepEqual(await previewLinksTo({ pages: all, records, fetched: new Map(), readRelation }), [], "nothing to set: the relation is already complete");
  // A link to a page the run leaves alone is still a link to a live page.
  assert.deepEqual(await previewLinksTo({ pages: all, records, fetched: new Map(), readRelation, leaveAlone: new Set([targets[0]!]) }), []);
});

test("previewLinksTo skips a page whose relation can't be read and still estimates the others", async () => {
  const notion = new FakeNotion();
  const [a, b, t] = [notion.add("A", ""), notion.add("B", ""), notion.add("T", "")];
  const rec = (id: PageId, name: string): SyncRecord => ({ notionId: id, path: `${name}.md`, title: name, folder: null, obsidianText: link(t), notionMarkdown: link(t), notionSeenAt: "", syncedAt: "" });
  const pages = [a, b, t].map((id, n) => ({ id, title: "ABT"[n]!, folder: null, lastEditedTime: "", ...(id === t ? {} : { linksTo: { ids: [] as PageId[], more: true } }) }));
  const records = new Map([[a, rec(a, "A")], [b, rec(b, "B")]]);
  const readRelation = async (id: PageId): Promise<PageId[]> => {
    if (id === a) throw new NotionPageError("object_not_found", "gone");
    return [];
  };
  assert.deepEqual(await previewLinksTo({ pages, records, fetched: new Map(), readRelation }), [b]);
});
