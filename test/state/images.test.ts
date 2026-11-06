import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openImageStore, type StoredImage } from "../../src/state/images.ts";
import { flushes } from "../helpers/fsync.ts";
import { tempDir } from "../helpers/tmp.ts";

const url = (key: string) => `https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/${key}/a.png`;
const image: StoredImage = { sha256: "ab12", uploadId: "up-1", uploadSha: "ab12", keys: ["k1", "k2"], urls: { k1: url("k1"), k2: url("k2") } };

test("a missing file opens as an empty store", async (t) => {
  const store = await openImageStore(await tempDir(t));
  assert.deepEqual(store.paths(), []);
  assert.equal(store.cited().size, 0);
  assert.equal(store.get("x.png"), undefined);
  assert.equal(store.pathOf("k1"), null);
  assert.equal(store.urlOf("k1"), null);
});

test("images and the cited set survive save and a fresh open", async (t) => {
  const dir = await tempDir(t);
  const store = await openImageStore(dir);
  store.set("Assets/a.png", image);
  store.set("Assets/b.png", { sha256: "cd34", uploadId: null, uploadSha: null, keys: [], urls: {} });
  store.setCited(["Assets/a.png"]);
  await store.save();
  const text = JSON.parse(await readFile(join(dir, "images.json"), "utf8"));
  assert.deepEqual(Object.keys(text), ["images", "cited", "unattached"]);
  const again = await openImageStore(dir);
  assert.deepEqual(again.get("Assets/a.png"), image);
  assert.deepEqual(again.get("Assets/b.png"), { sha256: "cd34", uploadId: null, uploadSha: null, keys: [], urls: {} });
  assert.deepEqual(again.paths().sort(), ["Assets/a.png", "Assets/b.png"]);
  assert.deepEqual([...again.cited()], ["Assets/a.png"]);
  assert.equal(again.pathOf("k2"), "Assets/a.png");
});

test("pathOf and urlOf follow set, and delete drops the key mapping", async (t) => {
  const store = await openImageStore(await tempDir(t));
  store.set("a.png", image);
  assert.equal(store.pathOf("k1"), "a.png");
  assert.equal(store.urlOf("k2"), url("k2"));
  store.set("a.png", { ...image, keys: ["k2"], urls: { k2: url("k2") } });
  assert.equal(store.pathOf("k1"), null, "a key the new entry no longer lists stops mapping");
  assert.equal(store.pathOf("k2"), "a.png");
  store.delete("a.png");
  assert.equal(store.get("a.png"), undefined);
  assert.equal(store.pathOf("k2"), null);
  assert.equal(store.urlOf("k2"), null);
  store.delete("a.png");
});

test("a key that moved to another path survives the old path's delete", async (t) => {
  const store = await openImageStore(await tempDir(t));
  store.set("old.png", image);
  store.set("new.png", image);
  store.delete("old.png");
  assert.equal(store.pathOf("k1"), "new.png");
});

test("cited() hands out a copy, and setCited replaces the set", async (t) => {
  const store = await openImageStore(await tempDir(t));
  store.setCited(["a.png", "b.png"]);
  store.cited().add("c.png");
  assert.deepEqual([...store.cited()].sort(), ["a.png", "b.png"]);
  store.setCited(new Set(["z.png"]));
  assert.deepEqual([...store.cited()], ["z.png"]);
});

test("the pages left holding a placeholder survive save and a fresh open, and unattached() hands out a copy", async (t) => {
  const dir = await tempDir(t);
  const store = await openImageStore(dir);
  assert.equal(store.unattached().size, 0);
  store.setUnattached(["page-1", "page-2"]);
  store.unattached().add("page-3");
  assert.deepEqual([...store.unattached()], ["page-1", "page-2"]);
  await store.save();
  assert.deepEqual([...(await openImageStore(dir)).unattached()], ["page-1", "page-2"]);
});

test("the refused uploads survive save and a fresh open, refusals() hands out a copy, and a store without any writes no refused key", async (t) => {
  const dir = await tempDir(t);
  const store = await openImageStore(dir);
  await store.save();
  assert.equal("refused" in JSON.parse(await readFile(join(dir, "images.json"), "utf8")), false);
  store.setRefusals([["Assets/memo.3gp", "The content type audio/3gpp is not supported"]]);
  store.refusals().clear();
  assert.equal(store.refusals().size, 1);
  await store.save();
  assert.deepEqual([...(await openImageStore(dir)).refusals()], [["Assets/memo.3gp", "The content type audio/3gpp is not supported"]]);
  // Images written before refusals were kept open with none.
  await writeFile(join(dir, "images.json"), JSON.stringify({ images: {}, cited: [] }));
  assert.equal((await openImageStore(dir)).refusals().size, 0);
});

test("records from before the hash was split open with the old hash as the upload's too (null where there is no upload)", async (t) => {
  const dir = await tempDir(t);
  await writeFile(
    join(dir, "images.json"),
    JSON.stringify({
      images: {
        "a.png": { sha256: "ab12", uploadId: "up-1", keys: ["k1"], urls: { k1: url("k1") } },
        "b.png": { sha256: "cd34", uploadId: null, keys: [], urls: {} },
      },
      cited: ["a.png"],
    }),
  );
  const store = await openImageStore(dir);
  assert.deepEqual(store.get("a.png"), { sha256: "ab12", uploadId: "up-1", uploadSha: "ab12", keys: ["k1"], urls: { k1: url("k1") } });
  assert.deepEqual(store.get("b.png"), { sha256: "cd34", uploadId: null, uploadSha: null, keys: [], urls: {} });
  assert.equal(store.unattached().size, 0);
  assert.equal(store.pathOf("k1"), "a.png");
});

test("a broken images.json is named in the error", async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "images.json"), '{"images": {');
  await assert.rejects(openImageStore(dir), /can't read the image records .*images\.json/);
});

test("saving flushes the data before the name, and the name after", async (t) => {
  const dir = await tempDir(t);
  const flushed = await flushes(t);
  const store = await openImageStore(dir);
  store.set("a.png", image);
  await store.save();
  assert.deepEqual(flushed, [join(dir, "images.json.tmp"), dir]);
});

test("rekey moves the entry, its keys and its refusal to the new path; the old path leaves the cited set and the new one does not join it", async (t) => {
  const dir = await tempDir(t);
  const store = await openImageStore(dir);
  store.set("old/a.png", image);
  store.set("old/b.png", { ...image, keys: ["k9"], urls: { k9: url("k9") } });
  store.setCited(["old/a.png", "old/b.png"]);
  store.setRefusals([["old/a.png", "too big"]]);
  store.rekey("old/a.png", "new/a.png");
  assert.equal(store.get("old/a.png"), undefined);
  assert.deepEqual(store.get("new/a.png"), image);
  assert.equal(store.pathOf("k1"), "new/a.png");
  assert.equal(store.urlOf("k2"), url("k2"));
  assert.deepEqual([...store.cited()].sort(), ["old/b.png"], "what is cited is the run's own scan, not what the old path was");
  assert.deepEqual([...store.refusals()], [["new/a.png", "too big"]]);
  assert.equal(store.pathOf("k9"), "old/b.png");
  await store.save();
  const again = await openImageStore(dir);
  assert.deepEqual(again.paths().sort(), ["new/a.png", "old/b.png"]);
  assert.equal(again.pathOf("k1"), "new/a.png");
  store.rekey("missing.png", "x.png");
  assert.equal(store.get("x.png"), undefined, "a path the store doesn't hold is left alone");
  assert.throws(() => store.rekey("new/a.png", "old/b.png"), /already/);
});
