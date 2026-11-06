import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { placeholderUrl } from "../../src/notion/hosted.ts";
import { applyRekeys, planRekeys } from "../../src/run/rekey.ts";
import { openImageStore, type StoredImage } from "../../src/state/images.ts";
import { openRecordStore } from "../../src/state/records.ts";
import type { SyncRecord } from "../../src/types.ts";
import { tempDir } from "../helpers/tmp.ts";

const stored = (sha256: string, key: string): StoredImage => ({ sha256, uploadId: "up", uploadSha: sha256, keys: [key], urls: { [key]: `https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/${key}/a.png` } });
const OLD = "Assets/pictures";
const NEW = "Assets/attachments";
const ID = "11111111-1111-1111-1111-111111111111";

/** A store holding `entries` (path -> sha), and a plan call over `files` (path -> [size, sha]) of which only the listed `gone` stored paths are missing. */
async function plan(t: import("node:test").TestContext, entries: Record<string, string>, files: Record<string, string>, sizes: Record<string, number> = {}, named: string[] = []) {
  const store = await openImageStore(await tempDir(t));
  Object.entries(entries).forEach(([path, sha], i) => store.set(path, { ...stored(sha, `k${i}`), ...(sizes[path] === undefined ? {} : { size: sizes[path] }) }));
  const present = new Set(Object.keys(files));
  const hashed: string[] = [];
  const result = await planRekeys(
    store,
    Object.entries(files).map(([path, sha]) => ({ path, size: sha.length })),
    async (path) => {
      hashed.push(path);
      return files[path]!;
    },
    (path) => present.has(path),
    (path) => named.includes(path),
  );
  return { store, result, hashed };
}

test("planRekeys: a stored file that is gone and a vault file the store doesn't know with its bytes is one move", async (t) => {
  const { result } = await plan(t, { [`${OLD}/a.png`]: "aa" }, { [`${NEW}/a.png`]: "aa" });
  assert.deepEqual(result, { moves: [{ from: `${OLD}/a.png`, to: `${NEW}/a.png` }], ambiguous: [] });
});

test("planRekeys: nothing is gone, nothing is hashed", async (t) => {
  const { result, hashed } = await plan(t, { "a.png": "aa" }, { "a.png": "aa", "b.png": "bb" });
  assert.deepEqual(result, { moves: [], ambiguous: [] });
  assert.deepEqual(hashed, []);
});

test("planRekeys: a file the store knows is never a candidate, and a file with other bytes is not one either", async (t) => {
  const { result } = await plan(t, { "a.png": "aa", "gone.png": "bb" }, { "a.png": "aa", "copy of a.png": "aa", "other.png": "cc" });
  assert.deepEqual(result, { moves: [], ambiguous: [] });
});

test("planRekeys: several files with the bytes, one with the stored name, and that one wins", async (t) => {
  const { result } = await plan(t, { [`${OLD}/a.png`]: "aa" }, { [`${NEW}/a.png`]: "aa", "Elsewhere/copy.png": "aa" });
  assert.deepEqual(result.moves, [{ from: `${OLD}/a.png`, to: `${NEW}/a.png` }]);
  assert.deepEqual(result.ambiguous, []);
});

test("planRekeys: several files with the bytes and none with the stored name, or two with it, are ambiguous", async (t) => {
  const none = await plan(t, { [`${OLD}/a.png`]: "aa" }, { "x/b.png": "aa", "y/c.png": "aa" });
  assert.deepEqual(none.result, { moves: [], ambiguous: [{ from: `${OLD}/a.png`, candidates: ["x/b.png", "y/c.png"] }] });
  const two = await plan(t, { [`${OLD}/a.png`]: "aa" }, { "x/a.png": "aa", "y/a.png": "aa" });
  assert.deepEqual(two.result, { moves: [], ambiguous: [{ from: `${OLD}/a.png`, candidates: ["x/a.png", "y/a.png"] }] });
});

test("planRekeys: two gone entries that would take the same file are both ambiguous", async (t) => {
  const { result } = await plan(t, { "one.png": "aa", "two.png": "aa" }, { "moved.png": "aa" });
  assert.deepEqual(result.moves, []);
  assert.deepEqual(result.ambiguous.map((a) => a.from).sort(), ["one.png", "two.png"]);
});

test("planRekeys: a file of another name is taken only when no note names the stored file any more", async (t) => {
  const renamed = { [`${OLD}/a.png`]: "aa" };
  const files = { [`${OLD}/copy.png`]: "aa" };
  const free = await plan(t, renamed, files);
  assert.deepEqual(free.result.moves, [{ from: `${OLD}/a.png`, to: `${OLD}/copy.png` }], "Obsidian renamed it and rewrote the citations");
  const cited = await plan(t, renamed, files, {}, [`${OLD}/a.png`]);
  assert.deepEqual(cited.result, { moves: [], ambiguous: [] }, "a note still names a.png: copy.png is another file");
  const sameName = await plan(t, renamed, { [`${NEW}/a.png`]: "aa" }, {}, [`${OLD}/a.png`]);
  assert.deepEqual(sameName.result.moves, [{ from: `${OLD}/a.png`, to: `${NEW}/a.png` }], "a moved file keeps its name: cited or not, it is the file");
  const both = await plan(t, renamed, { [`${NEW}/a.png`]: "aa", "x/copy.png": "aa", "y/other.png": "aa" }, {}, [`${OLD}/a.png`]);
  assert.deepEqual(both.result, { moves: [{ from: `${OLD}/a.png`, to: `${NEW}/a.png` }], ambiguous: [] }, "among copies, the one with the name; the others are not candidates");
});

test("planRekeys: with the stored size known, a vault file of another size is never hashed", async (t) => {
  // The files' sizes are their hashes' lengths: "aa" is 2 bytes, "bbbb" 4.
  const { result, hashed } = await plan(t, { "a.png": "aa" }, { "x/a.png": "aa", "y/big.mov": "bbbbbb", "y/other.png": "bbbb" }, { "a.png": 2 });
  assert.deepEqual(result.moves, [{ from: "a.png", to: "x/a.png" }]);
  assert.deepEqual(hashed, ["x/a.png"]);
  const none = await plan(t, { "a.png": "aa" }, { "y/big.mov": "bbbbbb", "y/other.png": "bbbb" }, { "a.png": 2 });
  assert.deepEqual(none.result, { moves: [], ambiguous: [] });
  assert.deepEqual(none.hashed, [], "nothing of the stored size: nothing is read");
});

test("planRekeys: an entry without a size (stored before sizes were) still re-keys, by the bytes alone", async (t) => {
  const { result, hashed } = await plan(t, { "a.png": "aa", "b.png": "bbbb" }, { "x/a.png": "aa", "x/b.png": "bbbb", "x/c.png": "cccccc" }, { "b.png": 4 });
  assert.deepEqual(result.moves, [{ from: "a.png", to: "x/a.png" }, { from: "b.png", to: "x/b.png" }]);
  assert.deepEqual([...hashed].sort(), ["x/a.png", "x/b.png", "x/c.png"], "the old entry hashes every unknown file, once");
});

test("planRekeys: a file is hashed once however many stored files are gone", async (t) => {
  const { hashed } = await plan(t, { "a.png": "aa", "b.png": "bb", "c.png": "cc" }, { "x/a.png": "aa", "x/b.png": "bb", "x/c.png": "cc" });
  assert.deepEqual([...hashed].sort(), ["x/a.png", "x/b.png", "x/c.png"]);
});

const record = (notionMarkdown: string, obsidianText: string): SyncRecord => ({
  notionId: ID,
  path: "N.md",
  title: "N",
  folder: null,
  obsidianText,
  notionMarkdown,
  notionSeenAt: "2026-09-27T10:00:00.000Z",
  syncedAt: "2026-09-27T10:00:00.000Z",
});

test("applyRekeys: the store, the records' page text and any placeholder in a note's text move; a real run saves both, a dry run neither", async (t) => {
  const from = `${OLD}/a b.png`;
  const to = `${NEW}/a b.png`;
  const other = `${OLD}/a b.png.png`;
  for (const save of [true, false]) {
    const dir = await tempDir(t);
    const images = await openImageStore(dir);
    images.set(from, stored("aa", "k1"));
    images.set(other, stored("bb", "k2"));
    images.setCited([from, other]);
    const records = await openRecordStore(dir);
    const text = (path: string) => `Intro\n![](${placeholderUrl(path)})\n![](${placeholderUrl(other)})\n`;
    const first = record(text(from), `---\nnotion-id: ${ID}\n---\n![[a b.png]]\n`);
    const second = { ...first, notionId: "22222222-2222-2222-2222-222222222222", obsidianText: text(from) };
    await records.put(first);
    await records.put(second);
    const all = records.all();
    await applyRekeys([{ from, to }], images, all, save ? records : null);
    assert.equal(images.get(from), undefined);
    assert.equal(images.get(to)?.sha256, "aa");
    assert.equal(images.pathOf("k1"), to);
    assert.deepEqual([...images.cited()], [other]);
    assert.equal(all.get(first.notionId)!.notionMarkdown, text(to));
    assert.equal(all.get(first.notionId)!.notionMarkdown.includes(placeholderUrl(other)), true, "a path that only starts like the old one is left alone");
    assert.equal(all.get(first.notionId)!.obsidianText, first.obsidianText, "a note's text without the placeholder is as it was");
    assert.equal(all.get(second.notionId)!.obsidianText, text(to));
    const onDisk = JSON.parse(await readFile(join(dir, "records", `${first.notionId}.json`), "utf8")) as SyncRecord;
    assert.equal(onDisk.notionMarkdown, save ? text(to) : text(from));
    const reopened = await openImageStore(dir).then((s) => s.get(to) !== undefined);
    assert.equal(reopened, save);
  }
});
