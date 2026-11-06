import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NotionPageError } from "../../src/notion/gateway.ts";
import { previewTags, syncTags } from "../../src/run/tags.ts";
import type { RecordStore } from "../../src/state/records.ts";
import type { PageId, PageMeta, SyncRecord } from "../../src/types.ts";
import { createVaultFs } from "../../src/vault/fs.ts";
import { tempDir } from "../helpers/tmp.ts";

const ID = "11111111-1111-1111-1111-111111111111" as PageId;
const record = (extra: Partial<SyncRecord> = {}): SyncRecord => ({
  notionId: ID, path: "A.md", title: "A", folder: null, obsidianText: "Body\n", notionMarkdown: "Body", notionSeenAt: "2026-09-27T10:00:00.000Z", syncedAt: "2026-09-27T10:00:00.000Z", ...extra,
});
const page = (tags: string[]): PageMeta => ({ id: ID, title: "A", folder: null, lastEditedTime: "2026-09-27T10:00:00.000Z", tags });

async function world(t: import("node:test").TestContext, text: string, rec: SyncRecord, tags: string[]) {
  const dir = await tempDir(t);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "A.md"), text);
  const map = new Map([[ID, rec]]);
  const records: RecordStore = { all: () => new Map(map), put: async (r) => void map.set(r.notionId, r), remove: async (id) => void map.delete(id) };
  const sets: string[][] = [];
  const skipped: { path: string; reason: string }[] = [];
  const lines: string[] = [];
  const input = {
    pages: new Map([[ID, page(tags)]]), records, vault: createVaultFs(dir, null), leaveAlone: new Set<PageId>(), skipped, log: (l: string) => void lines.push(l),
    notion: { setTags: async (_id: PageId, names: string[]) => void sets.push(names) },
  };
  return { dir, map, sets, skipped, lines, input };
}

test("a Notion refusal leaves the record alone and is reported with its code; the note, already written, is picked up next run", async (t) => {
  const w = await world(t, "Body\n", record({ tags: [] }), []);
  await writeFile(join(w.dir, "A.md"), "---\ntags: [a]\n---\nBody\n");
  w.input.notion.setTags = async () => {
    throw new NotionPageError("validation_error", "refused");
  };
  const done = await syncTags(w.input);
  assert.deepEqual(done, { set: 0, written: 0 });
  assert.deepEqual(w.map.get(ID)!.tags, []);
  assert.match(w.skipped[0]!.reason, /^validation_error: /);
});

test("a note whose write is needed is written, the record follows, and the page keeps names a note can't hold", async (t) => {
  const w = await world(t, "Body\n", record({ tags: [] }), ["x", "to do"]);
  const done = await syncTags(w.input);
  assert.deepEqual(done, { set: 0, written: 1 });
  assert.equal(await readFile(join(w.dir, "A.md"), "utf8"), "---\ntags:\n  - x\n---\nBody\n");
  assert.deepEqual(w.map.get(ID)!.tags, ["x"]);
  assert.equal(w.map.get(ID)!.obsidianText, "---\ntags:\n  - x\n---\nBody\n");
  assert.deepEqual(w.sets, []);
});

test("a page in leaveAlone is not touched", async (t) => {
  const w = await world(t, "Body\n", record({ tags: ["q"] }), ["x"]);
  w.input.leaveAlone = new Set([ID]);
  assert.deepEqual(await syncTags(w.input), { set: 0, written: 0 });
  assert.equal(await readFile(join(w.dir, "A.md"), "utf8"), "Body\n");
  assert.deepEqual(w.map.get(ID)!.tags, ["q"]);
});

test("previewTags names both kinds of change and skips unsafe notes and pages left alone", () => {
  const notes = new Map([["A.md", { text: "---\ntags: [n]\n---\nBody\n" }]]);
  const input = { notes, pages: new Map([[ID, page(["p"])]]), records: new Map([[ID, record({ tags: [] })]]), leaveAlone: new Set<PageId>() };
  assert.deepEqual(previewTags(input), ["write tags to A.md", "set tags in Notion on A.md"]);
  assert.deepEqual(previewTags({ ...input, leaveAlone: new Set([ID]) }), []);
  assert.deepEqual(previewTags({ ...input, notes: new Map([["A.md", { text: "---\ntags: a # c\n---\n" }]]) }), []);
});

test("a note whose body was edited after the last sync is left alone on both sides and skipped as changed_in_obsidian", async (t) => {
  const w = await world(t, "Body\n", record({ tags: [], obsidianText: "Body\n" }), ["x"]);
  await writeFile(join(w.dir, "A.md"), "Body edited\n");
  const done = await syncTags(w.input);
  assert.deepEqual(done, { set: 0, written: 0 });
  assert.equal(await readFile(join(w.dir, "A.md"), "utf8"), "Body edited\n");
  assert.deepEqual(w.sets, []);
  assert.deepEqual(w.map.get(ID), record({ tags: [], obsidianText: "Body\n" }));
  assert.equal(w.skipped.length, 1);
  assert.match(w.skipped[0]!.reason, /^changed_in_obsidian: /);
  // A frontmatter-only edit (the tags) is no body edit.
  const v = await world(t, "---\ntags: [n]\n---\nBody\n", record({ tags: [], obsidianText: "Body\n" }), []);
  assert.deepEqual(await syncTags(v.input), { set: 1, written: 0 });
  assert.deepEqual(v.skipped, []);
});
