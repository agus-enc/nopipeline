import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { contentUpdates } from "../../src/merge/edits.ts";
import { NotionPageError, type NotionGateway } from "../../src/notion/gateway.ts";
import { hostedFile, isUnsearchableMediaLine, mediaLine, mediaText, placeholderUrl, type MediaKind } from "../../src/notion/hosted.ts";
import { withImages } from "../../src/notion/images.ts";
import { openImageStore } from "../../src/state/images.ts";
import { UPLOAD_LIMIT } from "../../src/vault/images.ts";
import { FakeNotion } from "../helpers/fake-notion.ts";
import { tempDir } from "../helpers/tmp.ts";

const PATH = "Assets/pictures/a.png";
const OTHER = "Assets/pictures/b.png";
const bytesOf = (...n: number[]) => Uint8Array.from(n);
const line = (path: string, caption = "cap") => `![${caption}](${placeholderUrl(path)})`;

async function setup(t: TestContext, files: Record<string, Uint8Array> = { [PATH]: bytesOf(1, 2, 3) }) {
  const notion = new FakeNotion();
  const store = await openImageStore(await tempDir(t));
  const disk = new Map(Object.entries(files));
  const log: string[] = [];
  const gateway = withImages(notion, { store, readFile: async (path) => disk.get(path) ?? null, log: (l) => log.push(l) });
  const count = (what: string) => notion.calls.filter((c) => c.startsWith(`${what} `) || c === what).length;
  return { notion, store, disk, log, gateway, count };
}

/** The image blocks of a page as the block API shows them: id and the file uuid behind each hosted one. */
async function blocks(notion: NotionGateway, id: string) {
  return (await notion.mediaBlocks(id)).map((b) => ({ id: b.id, key: b.hosted ? hostedFile(b.hosted)!.key : null, external: b.external }));
}

/** Applies `after` to the page the way the executor does: small edits, else the whole page. */
async function write(gateway: NotionGateway, id: string, after: string) {
  const before = (await gateway.getMarkdown(id)).markdown;
  const edits = contentUpdates(before, after, 100, isUnsearchableMediaLine);
  if (edits === null) return { how: "replace", markdown: await gateway.replaceContent(id, after) };
  let markdown = before;
  for (const edit of edits) markdown = await gateway.updateContent(id, [edit]);
  return { how: "update", markdown };
}

test("a placeholder line pushed with updateContent ends hosted, reads back as the placeholder, and its file uuid is stored", async (t) => {
  const { notion, store, gateway, count } = await setup(t);
  const id = notion.add("Note", "# T\ntext");
  const markdown = await gateway.updateContent(id, [{ old_str: "text", new_str: `text\n${line(PATH)}` }]);
  assert.equal(markdown, `# T\ntext\n${line(PATH)}`);
  const [block] = await blocks(notion, id);
  assert.equal(block!.external, null);
  assert.notEqual(block!.key, null);
  assert.equal(store.pathOf(block!.key!), PATH);
  const stored = store.get(PATH)!;
  assert.deepEqual(stored.keys, [block!.key]);
  assert.match(stored.urls[block!.key!]!, /^https:\/\/prod-files-secure\.s3\.[^/]+\/[^/]+\/[^/]+\/a\.png$/);
  assert.match(stored.sha256, /^[0-9a-f]{64}$/);
  assert.equal(count("uploadFile"), 1);
  assert.equal((await gateway.getMarkdown(id)).markdown, `# T\ntext\n${line(PATH)}`);
  assert.deepEqual(gateway.pending(), []);
});

test("the store is saved with the new keys", async (t) => {
  const dir = await tempDir(t);
  const notion = new FakeNotion();
  const store = await openImageStore(dir);
  const gateway = withImages(notion, { store, readFile: async () => bytesOf(1), log: () => {} });
  const id = notion.add("Note", "x");
  await gateway.updateContent(id, [{ old_str: "x", new_str: `x\n${line(PATH)}` }]);
  const again = await openImageStore(dir);
  assert.deepEqual(again.get(PATH)!.keys, store.get(PATH)!.keys);
});

test("a placeholder line as a list item's image is attached too", async (t) => {
  const { notion, store, gateway } = await setup(t);
  const id = notion.add("Note", "- a");
  const markdown = await gateway.updateContent(id, [{ old_str: "- a", new_str: `- a\n- ${line(PATH)}` }]);
  assert.equal(markdown, `- a\n-\n\t${line(PATH)}`);
  const [block] = await blocks(notion, id);
  assert.equal(store.pathOf(block!.key!), PATH);
});

test("an edit beside a hosted image leaves the image block alone", async (t) => {
  const { notion, gateway } = await setup(t);
  const id = notion.add("Note", `first\n${line(PATH)}\nsecond`);
  await gateway.replaceContent(id, `first\n${line(PATH)}\nsecond`);
  const before = await blocks(notion, id);
  assert.notEqual(before[0]!.key, null);
  const result = await write(gateway, id, `first\n${line(PATH)}\nSECOND`);
  assert.equal(result.markdown, `first\n${line(PATH)}\nSECOND`);
  assert.deepEqual(await blocks(notion, id), before);
  // An edit that needs the image line as context cannot be searched for: the page is replaced, and the block still stays.
  const twice = `x\n${line(PATH)}\nx`;
  await gateway.replaceContent(id, twice);
  const two = await blocks(notion, id);
  const second = await write(gateway, id, `x\n${line(PATH)}\ny`);
  assert.equal(second.how, "replace");
  assert.equal(second.markdown, `x\n${line(PATH)}\ny`);
  assert.deepEqual(await blocks(notion, id), two);
});

test("the same image twice on a page and once on another is one upload and three hosted blocks", async (t) => {
  const { notion, store, gateway, count } = await setup(t);
  const one = notion.add("One", "");
  const two = notion.add("Two", "");
  const text = `a\n${line(PATH, "first")}\nb\n${line(PATH, "second")}`;
  assert.equal(await gateway.replaceContent(one, text), text);
  assert.equal(await gateway.replaceContent(two, `c\n${line(PATH)}`), `c\n${line(PATH)}`);
  assert.equal(count("uploadFile"), 1);
  const all = [...(await blocks(notion, one)), ...(await blocks(notion, two))];
  assert.equal(all.length, 3);
  assert.ok(all.every((b) => b.key !== null && b.external === null));
  assert.equal(new Set(all.map((b) => b.key)).size, 1);
  assert.deepEqual(store.get(PATH)!.keys.length, 1);
  assert.equal((await gateway.getMarkdown(one)).markdown, text);
  assert.equal((await gateway.getMarkdown(two)).markdown, `c\n${line(PATH)}`);
});

test("replaceContent of a canonical text keeps every hosted block and uploads nothing", async (t) => {
  const { notion, gateway, count } = await setup(t, { [PATH]: bytesOf(1), [OTHER]: bytesOf(2) });
  const id = notion.add("Note", "");
  const text = `${line(PATH)}\nmiddle\n${line(OTHER, "other")}\n${line(PATH, "again")}`;
  await gateway.replaceContent(id, text);
  const before = await blocks(notion, id);
  const uploads = count("uploadFile");
  const attaches = count("attachFile");
  const canonical = (await gateway.getMarkdown(id)).markdown;
  assert.equal(canonical, text);
  assert.equal(await gateway.replaceContent(id, `${canonical}\nmore`), `${text}\nmore`);
  assert.deepEqual(await blocks(notion, id), before);
  assert.equal(count("uploadFile"), uploads);
  assert.equal(count("attachFile"), attaches);
});

test("replaceContent moves and drops placeholder lines, and a new one for a known image reuses its upload", async (t) => {
  const { notion, gateway, count } = await setup(t);
  const id = notion.add("Note", "");
  await gateway.replaceContent(id, `${line(PATH, "one")}\ntext`);
  const [kept] = await blocks(notion, id);
  await gateway.replaceContent(id, `text\n${line(PATH, "one")}\n${line(PATH, "two")}`);
  const after = await blocks(notion, id);
  assert.equal(after.length, 2);
  assert.equal(after[0]!.id, kept!.id, "the block that was there keeps its id");
  assert.equal(after[1]!.key, kept!.key);
  assert.equal(count("uploadFile"), 1);
});

test("a changed file is uploaded again, and its block is replaced rather than kept", async (t) => {
  const { notion, store, disk, gateway, count } = await setup(t);
  const id = notion.add("Note", "");
  await gateway.replaceContent(id, line(PATH));
  const [old] = await blocks(notion, id);
  const oldSha = store.get(PATH)!.sha256;
  disk.set(PATH, bytesOf(9, 9, 9));
  assert.equal(await gateway.replaceContent(id, line(PATH)), line(PATH));
  const [now] = await blocks(notion, id);
  assert.notEqual(now!.id, old!.id);
  assert.notEqual(now!.key, old!.key);
  assert.equal(count("uploadFile"), 2);
  // The upload is of the new file; the pages still show the old one on other blocks, so what they show moves only with `refreshImage`.
  assert.equal(store.get(PATH)!.sha256, oldSha);
  assert.equal(store.get(PATH)!.uploadSha, createHash("sha256").update(bytesOf(9, 9, 9)).digest("hex"));
  assert.equal(store.pathOf(now!.key!), PATH);
  const [block] = await notion.mediaBlocks(id);
  assert.deepEqual(await notion.download(block!.hosted!), bytesOf(9, 9, 9));
});

test("an upload Notion no longer takes is made again, once", async (t) => {
  const { notion, store, gateway, count } = await setup(t);
  store.set(PATH, { sha256: createHash("sha256").update(bytesOf(1, 2, 3)).digest("hex"), uploadId: "expired-upload", uploadSha: createHash("sha256").update(bytesOf(1, 2, 3)).digest("hex"), keys: [], urls: {} });
  const id = notion.add("Note", "");
  await gateway.replaceContent(id, line(PATH));
  assert.equal(count("uploadFile"), 1);
  assert.notEqual(store.get(PATH)!.uploadId, "expired-upload");
  assert.equal((await blocks(notion, id))[0]!.external, null);
});

test("an upload kept from an earlier run that Notion answers with any page-level refusal is made again, once", async (t) => {
  for (const code of ["object_not_found", "validation_error", "restricted_resource"]) {
    const { notion, store, gateway, count } = await setup(t);
    const sha = createHash("sha256").update(bytesOf(1, 2, 3)).digest("hex");
    store.set(PATH, { sha256: sha, uploadId: "kept-upload", uploadSha: sha, keys: [], urls: {} });
    const real = notion.attachFile.bind(notion);
    const sent: string[] = [];
    notion.attachFile = async (blockId, kind, uploadId) => {
      sent.push(uploadId);
      if (uploadId === "kept-upload") throw new NotionPageError(code, "no");
      return real(blockId, kind, uploadId);
    };
    const id = notion.add("Note", "");
    await gateway.replaceContent(id, line(PATH));
    assert.equal(count("uploadFile"), 1, code);
    assert.equal(sent.length, 2, code);
    assert.equal(sent[0], "kept-upload");
    assert.equal(store.get(PATH)!.uploadId, sent[1]);
    assert.equal((await blocks(notion, id))[0]!.external, null);
  }
});

test("a refusal of a fresh upload, and an error that is not Notion's, are not retried", async (t) => {
  const { notion, gateway, count } = await setup(t);
  const id = notion.add("Note", "");
  const real = notion.attachFile.bind(notion);
  notion.attachFile = async () => {
    throw new NotionPageError("validation_error", "no");
  };
  await assert.rejects(gateway.replaceContent(id, line(PATH)), NotionPageError);
  assert.equal(count("uploadFile"), 1, "a fresh upload is not made again");
  // The upload kept from that run is tried; a network error is not a refusal and goes up as it is.
  notion.attachFile = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(gateway.attach(id), TypeError);
  assert.equal(count("uploadFile"), 1);
  notion.attachFile = real;
});

test("an upload kept from an earlier run that expired unattached is made again (the fake answers it as Notion does)", async (t) => {
  const { notion, store, gateway, count } = await setup(t);
  const id = notion.add("Note", "");
  const real = notion.attachFile.bind(notion);
  notion.attachFile = async () => {
    throw new NotionPageError("internal_server_error", "boom");
  };
  await assert.rejects(gateway.replaceContent(id, line(PATH)), NotionPageError);
  const kept = store.get(PATH)!.uploadId;
  assert.notEqual(kept, null);
  notion.attachFile = real;
  notion.expireUploads();
  await assert.rejects(notion.attachFile((await notion.mediaBlocks(id))[0]!.id, "image", kept!), /invalid status of expired/);
  await gateway.attach(id);
  assert.equal(count("uploadFile"), 2);
  assert.notEqual(store.get(PATH)!.uploadId, kept);
  assert.equal((await blocks(notion, id))[0]!.external, null);
});

test("a stored upload of the file as it is now is attached without uploading again", async (t) => {
  const { notion, store, gateway, count } = await setup(t);
  const id = notion.add("Note", "");
  await gateway.replaceContent(id, line(PATH));
  const uploadId = store.get(PATH)!.uploadId;
  assert.notEqual(uploadId, null);
  const other = notion.add("Other", "");
  await gateway.replaceContent(other, line(PATH));
  assert.equal(count("uploadFile"), 1);
  assert.equal(store.get(PATH)!.uploadId, uploadId);
});

test("a placeholder whose file is not on disk is left as it is and said so", async (t) => {
  const { notion, store, log, gateway, count } = await setup(t, {});
  const id = notion.add("Note", "");
  assert.equal(await gateway.replaceContent(id, `a\n${line(PATH)}`), `a\n${line(PATH)}`);
  assert.equal(count("uploadFile"), 0);
  const [block] = await blocks(notion, id);
  assert.equal(block!.key, null);
  assert.equal(block!.external, placeholderUrl(PATH));
  assert.equal(log.length, 1);
  assert.match(log[0]!, /a\.png/);
  assert.equal(store.get(PATH), undefined);
});

test("an image pasted in Notion shows as its bare URL and is pending once", async (t) => {
  const { notion, gateway } = await setup(t);
  const id = notion.add("Note", "one\ntwo");
  notion.pasteImage(id, "one", "pasted pic.png", bytesOf(7, 7), "look");
  const first = (await gateway.getMarkdown(id)).markdown;
  const m = /^!\[look\]\((.*)\)$/.exec(first.split("\n")[1]!);
  assert.ok(m);
  assert.doesNotMatch(m![1]!, /[?#]/, "no signature, no record");
  assert.equal(hostedFile(m![1]!)!.name, "pasted_pic.png");
  const second = (await gateway.getMarkdown(id)).markdown;
  assert.equal(second, first);
  const pending = gateway.pending();
  assert.equal(pending.length, 1);
  assert.deepEqual([pending[0]!.pageId, pending[0]!.name, pending[0]!.key], [id, "pasted_pic.png", hostedFile(m![1]!)!.key]);
  assert.match(pending[0]!.url, /\?X-Amz-Signature=\d+/, "the URL is signed, so it can be downloaded");
  assert.deepEqual(await notion.download(pending[0]!.url), bytesOf(7, 7));
  await gateway.getMarkdown(id);
  assert.equal(gateway.pending().length, 1);
});

test("an image the store knows whose file is gone from the vault is pending to be downloaded again", async (t) => {
  const { notion, store, disk, gateway } = await setup(t);
  const id = notion.add("Note", "");
  await gateway.replaceContent(id, line(PATH));
  assert.deepEqual(gateway.pending(), []);
  disk.delete(PATH);
  assert.equal((await gateway.getMarkdown(id)).markdown, line(PATH), "it still reads as the placeholder");
  const [pending] = gateway.pending();
  assert.equal(gateway.pending().length, 1);
  assert.equal(store.pathOf(pending!.key), PATH);
  assert.equal(pending!.name, "a.png");
  await gateway.getMarkdown(id);
  assert.equal(gateway.pending().length, 1);
});

test("two reads with different signatures give identical text", async (t) => {
  const { notion, gateway } = await setup(t);
  const id = notion.add("Note", "");
  await gateway.replaceContent(id, `${line(PATH)}\ntext`);
  notion.pasteImage(id, "text", "p.png", bytesOf(5));
  const raw = [(await notion.getMarkdown(id)).markdown, (await notion.getMarkdown(id)).markdown];
  assert.notEqual(raw[0], raw[1], "the fake signs every read differently");
  const a = (await gateway.getMarkdown(id)).markdown;
  const b = (await gateway.getMarkdown(id)).markdown;
  assert.equal(a, b);
  assert.equal(gateway.canonical(id), a);
});

test("canonical is null for a page not read yet", async (t) => {
  const { notion, gateway } = await setup(t);
  assert.equal(gateway.canonical(notion.add("Note", "x")), null);
});

test("calls it doesn't change go straight through", async (t) => {
  const { notion, gateway } = await setup(t);
  const id = await gateway.createPage({ title: "New" });
  assert.ok(notion.pages.has(id));
  assert.deepEqual((await gateway.listPages()).map((p) => p.id), [id]);
  assert.equal(await gateway.pageStatus(id), "live");
  await gateway.trash(id);
  assert.equal(await gateway.pageStatus(id), "trashed");
});

test("the title and project calls go straight through", async (t) => {
  const { notion, gateway } = await setup(t);
  const cooking = await gateway.createProject("Cooking");
  const id = await gateway.createPage({ title: "New", projects: [cooking] });
  await gateway.setTitle(id, "Renamed");
  assert.deepEqual(await gateway.readProjects(id), [cooking]);
  const other = notion.addProject("Other");
  await gateway.setProjects(id, [other, cooking]);
  await gateway.renameProject(cooking, "Cooking 2");
  assert.deepEqual(notion.projectsOf(id), [other, cooking]);
  assert.deepEqual(await gateway.listProjects(), [{ id: cooking, title: "Cooking 2" }, { id: other, title: "Other" }]);
  assert.deepEqual(await gateway.projectsSource(), { dataSourceId: notion.projectsDataSourceId, titleProperty: "Name" });
  assert.equal(notion.pages.get(id)!.title, "Renamed");
});

test("a failed attach still records the blocks already switched", async (t) => {
  const { notion, store, gateway } = await setup(t, { [PATH]: bytesOf(1), [OTHER]: bytesOf(2) });
  const id = notion.add("Note", "");
  const real = notion.attachFile.bind(notion);
  let n = 0;
  notion.attachFile = async (blockId, kind, uploadId) => {
    if (++n === 2) throw new NotionPageError("restricted_resource", "no");
    return real(blockId, kind, uploadId);
  };
  await assert.rejects(gateway.replaceContent(id, `${line(PATH)}\n${line(OTHER)}`), NotionPageError);
  const [first] = await blocks(notion, id);
  assert.notEqual(first!.key, null);
  assert.equal(store.pathOf(first!.key!), PATH, "a hosted block the store doesn't know would be read as a new image");
});

test("refreshImage switches every block of the changed file to one new upload and keeps the text", async (t) => {
  const { notion, store, disk, gateway, count } = await setup(t);
  const one = notion.add("One", "");
  const two = notion.add("Two", "");
  const three = notion.add("Three", "");
  await gateway.replaceContent(one, `${line(PATH, "x")}\ntext\n${line(PATH, "y")}`);
  await gateway.replaceContent(two, line(PATH));
  await gateway.replaceContent(three, "no images");
  const before = [...(await blocks(notion, one)), ...(await blocks(notion, two))];
  const oldKey = before[0]!.key!;
  disk.set(PATH, bytesOf(8, 8));
  const switched = await gateway.refreshImage(PATH, [one, two, three]);
  assert.equal(switched, 3);
  assert.equal(count("uploadFile"), 2, "one for the first version, one new");
  const after = [...(await blocks(notion, one)), ...(await blocks(notion, two))];
  assert.deepEqual(after.map((b) => b.id), before.map((b) => b.id), "the blocks keep their ids");
  assert.ok(after.every((b) => b.key !== null && b.key !== oldKey));
  assert.equal(new Set(after.map((b) => b.key)).size, 1);
  for (const id of [one, two]) {
    for (const block of await notion.mediaBlocks(id)) assert.deepEqual(await notion.download(block.hosted!), bytesOf(8, 8));
  }
  assert.equal((await gateway.getMarkdown(one)).markdown, `${line(PATH, "x")}\ntext\n${line(PATH, "y")}`);
  const stored = store.get(PATH)!;
  assert.ok(stored.keys.includes(after[0]!.key!));
  assert.ok(stored.urls[after[0]!.key!]);
  assert.equal(store.pathOf(after[0]!.key!), PATH);
  assert.deepEqual(gateway.pending(), []);
  // The page is now written with the new file's blocks, which a whole-page write keeps.
  assert.equal(await gateway.replaceContent(one, `${line(PATH, "x")}\ntext\n${line(PATH, "y")}`), `${line(PATH, "x")}\ntext\n${line(PATH, "y")}`);
  assert.equal(count("uploadFile"), 2);
});

test("refreshImage with no block of the image on those pages uploads nothing", async (t) => {
  const { notion, gateway, count } = await setup(t);
  const id = notion.add("Note", "text");
  await gateway.getMarkdown(id);
  assert.equal(await gateway.refreshImage(PATH, [id]), 0);
  assert.equal(count("uploadFile"), 0);
});

test("refreshImage leaves things as they are when the file is gone", async (t) => {
  const { notion, disk, gateway, log, count } = await setup(t);
  const id = notion.add("Note", "");
  await gateway.replaceContent(id, line(PATH));
  disk.delete(PATH);
  assert.equal(await gateway.refreshImage(PATH, [id]), 0);
  assert.equal(count("uploadFile"), 1);
  assert.equal(log.length, 1);
});

test("a page left holding a placeholder is listed, kept in the store, and cleared once its images are switched", async (t) => {
  const dir = await tempDir(t);
  const notion = new FakeNotion();
  const store = await openImageStore(dir);
  const gateway = withImages(notion, { store, readFile: async () => bytesOf(1, 2, 3), log: () => {} });
  const id = notion.add("Note", "");
  const real = notion.uploadFile.bind(notion);
  notion.uploadFile = async () => {
    throw new NotionPageError("internal_server_error", "boom");
  };
  await assert.rejects(gateway.replaceContent(id, line(PATH)), NotionPageError);
  assert.deepEqual(gateway.unattached(), [id]);
  assert.deepEqual([...(await openImageStore(dir)).unattached()], [id], "saved the moment the placeholder was written");
  // A fresh gateway on the saved store (the next run) knows the page too.
  assert.deepEqual(withImages(notion, { store: await openImageStore(dir), readFile: async () => bytesOf(1, 2, 3), log: () => {} }).unattached(), [id]);
  notion.uploadFile = real;
  await gateway.attach(id);
  assert.deepEqual(gateway.unattached(), []);
  assert.equal((await notion.mediaBlocks(id))[0]!.external, null);
  assert.deepEqual([...(await openImageStore(dir)).unattached()], []);
});

test("a page whose placeholder's file is not in the vault stays listed; a page that is gone or trashed is dropped", async (t) => {
  const { notion, store, disk, gateway } = await setup(t);
  const kept = notion.add("Kept", "");
  const trashed = notion.add("Trashed", "");
  const gone = notion.add("Gone", "");
  disk.delete(PATH);
  for (const id of [kept, trashed, gone]) await gateway.replaceContent(id, line(PATH));
  assert.deepEqual(gateway.unattached().sort(), [gone, kept, trashed].sort());
  await gateway.trash(trashed);
  notion.pages.delete(gone);
  await gateway.listPages();
  assert.deepEqual(gateway.unattached(), [kept]);
  assert.deepEqual([...store.unattached()], [kept]);
  disk.set(PATH, bytesOf(1, 2, 3));
  await gateway.attach(kept);
  assert.deepEqual(gateway.unattached(), []);
});

test("a read-only gateway keeps the store as it is", async (t) => {
  const dir = await tempDir(t);
  const notion = new FakeNotion();
  const store = await openImageStore(dir);
  store.setUnattached(["some-page"]);
  const gateway = withImages(notion, { store, readFile: async () => null, log: () => {}, readOnly: true });
  const id = notion.add("Note", line(PATH));
  await gateway.listPages();
  await gateway.getMarkdown(id);
  assert.deepEqual([...store.unattached()], ["some-page"]);
  assert.deepEqual([...(await openImageStore(dir)).unattached()], [], "nothing was saved");
});

test("refreshImage records the new file as the one the pages show only when every block was switched", async (t) => {
  const { notion, store, disk, gateway } = await setup(t);
  const one = notion.add("One", "");
  const two = notion.add("Two", "");
  await gateway.replaceContent(one, line(PATH));
  await gateway.replaceContent(two, line(PATH));
  const shown = store.get(PATH)!.sha256;
  disk.set(PATH, bytesOf(8, 8));
  const newSha = createHash("sha256").update(bytesOf(8, 8)).digest("hex");
  const real = notion.attachFile.bind(notion);
  // 1. a refusal for the second block (a Notion error); 2. an error that is not Notion's.
  for (const error of [new NotionPageError("validation_error", "refused"), new TypeError("fetch failed")]) {
    let n = 0;
    notion.attachFile = async (blockId, kind, uploadId) => {
      if (++n === 2) throw error;
      return real(blockId, kind, uploadId);
    };
    await assert.rejects(gateway.refreshImage(PATH, [one, two]), error.constructor);
    assert.equal(store.get(PATH)!.sha256, shown, "a page still shows the old file");
    assert.equal(store.get(PATH)!.uploadSha, newSha, "the upload of the new file is kept for reuse");
  }
  notion.attachFile = real;
  assert.equal(await gateway.refreshImage(PATH, [one, two]), 2);
  assert.equal(store.get(PATH)!.sha256, newSha);
});

test("an attach during a push of the replaced file keeps the hash of what the other pages show", async (t) => {
  const { notion, store, disk, gateway } = await setup(t);
  const one = notion.add("One", "");
  await gateway.replaceContent(one, line(PATH));
  const shown = store.get(PATH)!.sha256;
  disk.set(PATH, bytesOf(8, 8));
  const two = notion.add("Two", "");
  await gateway.replaceContent(two, line(PATH));
  assert.equal(store.get(PATH)!.sha256, shown);
  // The refresh is what moves it, on every page that shows the old file.
  assert.equal(await gateway.refreshImage(PATH, [one, two]), 2);
  assert.equal(store.get(PATH)!.sha256, createHash("sha256").update(bytesOf(8, 8)).digest("hex"));
});

test("a read cut short after a switch is no record of the page: the write fails, the switched block's file is still stored, and the page is looked at again (final review 10)", async (t) => {
  const { notion, store, gateway } = await setup(t);
  const id = notion.add("Note", "x");
  notion.edit(id, { truncated: true });
  await assert.rejects(
    gateway.updateContent(id, [{ old_str: "x", new_str: `x\n${line(PATH)}` }]),
    (error) => error instanceof NotionPageError && error.code === "truncated",
  );
  assert.equal(store.get(PATH)!.keys.length, 1, "the file uuid of the switched block is kept, so it is not read as a new image later");
  assert.deepEqual(gateway.unattached(), [id], "no partial read stands in for the page");
  assert.equal(gateway.canonical(id), `x\n${line(PATH)}`);
});

test("refreshImage that finds one page's read cut short still records the other pages' new file, keeps the old hash and reports it (final review 10)", async (t) => {
  const { notion, store, disk, gateway } = await setup(t);
  const one = notion.add("One", "");
  const two = notion.add("Two", "");
  await gateway.replaceContent(one, line(PATH));
  await gateway.replaceContent(two, line(PATH));
  const shown = store.get(PATH)!.sha256;
  disk.set(PATH, bytesOf(8, 8));
  const read = notion.getMarkdown.bind(notion);
  notion.getMarkdown = async (id) => ({ ...(await read(id)), truncated: id === one });
  await assert.rejects(gateway.refreshImage(PATH, [one, two]), (error) => error instanceof NotionPageError && error.code === "truncated");
  assert.equal(store.get(PATH)!.sha256, shown, "a page may still show the old file");
  const keys = [...(await blocks(notion, one)), ...(await blocks(notion, two))].map((b) => b.key!);
  assert.ok(keys.every((key) => store.pathOf(key) === PATH), "every block's file uuid is known");
  notion.getMarkdown = read;
  assert.equal(await gateway.refreshImage(PATH, [one, two]), 2);
});

// --- Every attachment kind (attachments spec §5.9–§5.11) ---------------------------------------------------------------

const DIR = "Assets/attachments";
const OF_KIND: Record<MediaKind, string> = {
  image: `${DIR}/a.png`,
  pdf: `${DIR}/Manual.pdf`,
  audio: `${DIR}/lecture.mp3`,
  video: `${DIR}/lecture.mp4`,
  file: `${DIR}/minutes.docx`,
};
const KINDS = Object.keys(OF_KIND) as MediaKind[];
/** The placeholder line the translator writes for a file of that kind. */
const media = (kind: MediaKind, caption = "cap", path = OF_KIND[kind]) => mediaText(kind, "", caption, placeholderUrl(path));
const allFiles = () => Object.fromEntries(Object.values(OF_KIND).map((path, n) => [path, bytesOf(n + 1, 2, 3)]));

test("a placeholder line of every kind pushed with updateContent ends hosted in a block of its kind, reads back as the placeholder, and its file uuid is stored", async (t) => {
  for (const kind of KINDS) {
    const { notion, store, gateway, count } = await setup(t, allFiles());
    const path = OF_KIND[kind];
    const id = notion.add("Note", "# T\ntext");
    const markdown = await gateway.updateContent(id, [{ old_str: "text", new_str: `text\n${media(kind)}` }]);
    assert.equal(markdown, `# T\ntext\n${media(kind)}`, kind);
    const [block] = await notion.mediaBlocks(id);
    assert.equal(block!.kind, kind);
    assert.equal(block!.external, null, kind);
    assert.equal(hostedFile(block!.hosted!)!.name, path.slice(path.lastIndexOf("/") + 1));
    assert.equal(store.pathOf(hostedFile(block!.hosted!)!.key), path, kind);
    assert.equal(count("uploadFile"), 1, kind);
    assert.equal(count("attachFile"), 1, kind);
    assert.equal((await gateway.getMarkdown(id)).markdown, `# T\ntext\n${media(kind)}`, kind);
    assert.deepEqual(gateway.pending(), [], kind);
    assert.deepEqual(gateway.unattached(), [], kind);
  }
});

test("a placeholder of every kind written as a list item's child is attached too", async (t) => {
  for (const kind of KINDS) {
    const { notion, store, gateway } = await setup(t, allFiles());
    const id = notion.add("Note", "- a");
    const markdown = await gateway.updateContent(id, [{ old_str: "- a", new_str: `- a\n-\n\t${media(kind)}` }]);
    assert.equal(markdown, `- a\n-\n\t${media(kind)}`, kind);
    const [block] = await notion.mediaBlocks(id);
    assert.equal(block!.kind, kind);
    assert.equal(store.pathOf(hostedFile(block!.hosted!)!.key), OF_KIND[kind], kind);
  }
});

test("a whole-page write of every kind at once uploads each file once and keeps all five blocks on the next write of the same text", async (t) => {
  const { notion, gateway, count } = await setup(t, allFiles());
  const id = notion.add("Note", "");
  const text = KINDS.map((kind) => media(kind)).join("\n");
  assert.equal(await gateway.replaceContent(id, text), text);
  assert.equal(count("uploadFile"), 5);
  const before = await blocks(notion, id);
  assert.ok(before.every((b) => b.key !== null));
  assert.equal(await gateway.replaceContent(id, `${text}\nmore`), `${text}\nmore`);
  assert.deepEqual(await blocks(notion, id), before, "every block kept: same ids, still hosted");
  assert.equal(count("uploadFile"), 5);
  assert.equal(count("attachFile"), 5);
});

test("an edit beside a hosted block of every kind leaves the block alone, and an edit that needs its line as context replaces the page and keeps it", async (t) => {
  for (const kind of KINDS) {
    const { notion, gateway } = await setup(t, allFiles());
    const id = notion.add("Note", "");
    await gateway.replaceContent(id, `first\n${media(kind)}\nsecond`);
    const before = await blocks(notion, id);
    assert.notEqual(before[0]!.key, null, kind);
    const small = await write(gateway, id, `first\n${media(kind)}\nSECOND`);
    assert.equal(small.how, "update", kind);
    assert.equal(small.markdown, `first\n${media(kind)}\nSECOND`, kind);
    assert.deepEqual(await blocks(notion, id), before, kind);
    const twice = `x\n${media(kind)}\nx`;
    await gateway.replaceContent(id, twice);
    const two = await blocks(notion, id);
    const whole = await write(gateway, id, `x\n${media(kind)}\ny`);
    assert.equal(whole.how, "replace", kind);
    assert.equal(whole.markdown, `x\n${media(kind)}\ny`, kind);
    assert.deepEqual(await blocks(notion, id), two, kind);
  }
});

test("one file cited as an embed and as a link is one upload and two hosted blocks of different kinds, and each keeps its block on a rewrite", async (t) => {
  const path = OF_KIND.pdf;
  const { notion, store, gateway, count } = await setup(t, { [path]: bytesOf(4, 5) });
  const id = notion.add("Note", "");
  const text = `${media("pdf", "shown")}\n${media("file", "link", path)}`;
  assert.equal(await gateway.replaceContent(id, text), text);
  assert.equal(count("uploadFile"), 1);
  const found = await notion.mediaBlocks(id);
  assert.deepEqual(found.map((b) => b.kind), ["pdf", "file"]);
  assert.equal(new Set(found.map((b) => hostedFile(b.hosted!)!.key)).size, 1, "one uploaded file, in two blocks");
  assert.equal(store.get(path)!.keys.length, 1);
  assert.equal(await gateway.replaceContent(id, `${text}\nmore`), `${text}\nmore`);
  assert.deepEqual((await notion.mediaBlocks(id)).map((b) => b.id), found.map((b) => b.id));
  assert.equal(count("uploadFile"), 1);
  // Swapping which form comes first moves each to the block of its own kind, not the other's.
  const swapped = `${media("file", "link", path)}\n${media("pdf", "shown")}`;
  assert.equal(await gateway.replaceContent(id, swapped), swapped);
  assert.deepEqual((await notion.mediaBlocks(id)).map((b) => [b.kind, b.id]), [...found].reverse().map((b) => [b.kind, b.id]));
});

test("a changed file of any kind is uploaded again and its block replaced; refreshImage switches every block of the kind and keeps the text", async (t) => {
  for (const kind of KINDS) {
    const path = OF_KIND[kind];
    const { notion, store, disk, gateway, count } = await setup(t, { [path]: bytesOf(1, 2, 3) });
    const one = notion.add("One", "");
    const two = notion.add("Two", "");
    await gateway.replaceContent(one, `${media(kind, "x")}\ntext\n${media(kind, "y")}`);
    await gateway.replaceContent(two, media(kind));
    const before = [...(await blocks(notion, one)), ...(await blocks(notion, two))];
    disk.set(path, bytesOf(8, 8));
    assert.equal(await gateway.refreshImage(path, [one, two]), 3, kind);
    const after = [...(await blocks(notion, one)), ...(await blocks(notion, two))];
    assert.deepEqual(after.map((b) => b.id), before.map((b) => b.id), kind);
    assert.ok(after.every((b) => b.key !== null && b.key !== before[0]!.key), kind);
    for (const id of [one, two]) for (const block of await notion.mediaBlocks(id)) assert.deepEqual(await notion.download(block.hosted!), bytesOf(8, 8));
    assert.equal((await gateway.getMarkdown(one)).markdown, `${media(kind, "x")}\ntext\n${media(kind, "y")}`, kind);
    assert.equal(store.get(path)!.sha256, createHash("sha256").update(bytesOf(8, 8)).digest("hex"), kind);
    assert.equal(count("uploadFile"), 2, kind);
  }
});

test("a hosted file of every kind pasted in Notion shows as its bare URL, with its kind and caption, and is pending once", async (t) => {
  for (const kind of KINDS) {
    const { notion, gateway } = await setup(t);
    const id = notion.add("Note", "one\ntwo");
    const name = { image: "pic.png", pdf: "Manual.pdf", audio: "lecture.mp3", video: "lecture.mp4", file: "minutes.docx" }[kind];
    notion.pasteFile(id, "one", kind, name, bytesOf(7, 7), "look");
    const first = (await gateway.getMarkdown(id)).markdown;
    const found = mediaLine(first.split("\n")[1]!)!;
    assert.equal(found.kind, kind);
    assert.equal(found.caption, "look");
    assert.doesNotMatch(found.url, /[?#]/, `${kind}: no signature, no record`);
    assert.equal((await gateway.getMarkdown(id)).markdown, first, `${kind}: two reads agree`);
    const pending = gateway.pending();
    assert.equal(pending.length, 1, kind);
    assert.deepEqual([pending[0]!.pageId, pending[0]!.name, pending[0]!.kind, pending[0]!.key], [id, name, kind, hostedFile(found.url)!.key]);
    assert.match(pending[0]!.url, /\?X-Amz-Signature=\d+/, `${kind}: signed, so it can be downloaded`);
    assert.deepEqual(await notion.download(pending[0]!.url), bytesOf(7, 7));
    await gateway.getMarkdown(id);
    assert.equal(gateway.pending().length, 1, kind);
    assert.deepEqual(gateway.unsupported(), [], kind);
  }
});

test("two reads with different signatures give identical text for a known hosted file of every kind", async (t) => {
  const { notion, store, gateway } = await setup(t, allFiles());
  const id = notion.add("Note", "");
  await gateway.replaceContent(id, `${KINDS.map((kind) => media(kind)).join("\n")}\nend`);
  notion.pasteFile(id, "end", "pdf", "Other.pdf", bytesOf(5), "p");
  const raw = [(await notion.getMarkdown(id)).markdown, (await notion.getMarkdown(id)).markdown];
  assert.notEqual(raw[0], raw[1], "the fake signs every read differently");
  assert.equal(raw[0]!.split("\n").filter((l) => /X-Amz-Signature/.test(l)).length, 6);
  const a = (await gateway.getMarkdown(id)).markdown;
  const b = (await gateway.getMarkdown(id)).markdown;
  assert.equal(a, b);
  assert.equal(gateway.canonical(id), a);
  for (const kind of KINDS) assert.ok(a.includes(media(kind)), `${kind} reads as its placeholder`);
  assert.equal(store.paths().length, 5);
});

test("a hosted file the store knows whose file is gone from the vault is pending, with its kind, to be downloaded again", async (t) => {
  for (const kind of KINDS) {
    const path = OF_KIND[kind];
    const { notion, store, disk, gateway } = await setup(t, { [path]: bytesOf(1, 2, 3) });
    const id = notion.add("Note", "");
    await gateway.replaceContent(id, media(kind));
    assert.deepEqual(gateway.pending(), [], kind);
    disk.delete(path);
    assert.equal((await gateway.getMarkdown(id)).markdown, media(kind), `${kind}: it still reads as the placeholder`);
    const [pending] = gateway.pending();
    assert.equal(gateway.pending().length, 1, kind);
    assert.equal(store.pathOf(pending!.key), path);
    assert.equal(pending!.kind, kind);
  }
});

test("a hosted file with no extension, or one that is a note, canvas, base or drawing by name, is not pending but reported, once", async (t) => {
  const { notion, gateway } = await setup(t);
  const id = notion.add("Note", "one");
  const names = ["noext", "Meeting.md", "Board.canvas", "Table.base", "Sketch.excalidraw"];
  names.forEach((name, n) => notion.pasteFile(id, "one", n % 2 === 0 ? "file" : "pdf", name, bytesOf(n), ""));
  notion.pasteFile(id, "one", "pdf", "fine.pdf", bytesOf(9), "ok");
  await gateway.getMarkdown(id);
  await gateway.getMarkdown(id);
  assert.deepEqual(gateway.pending().map((p) => p.name), ["fine.pdf"]);
  assert.deepEqual(gateway.unsupported().map((p) => [p.pageId, p.name]).sort(), names.map((name) => [id, name]).sort());
  assert.deepEqual(new Set(gateway.unsupported().map((p) => p.kind)), new Set(["file", "pdf"]));
});

test("a large hosted file keeps its block: the video the user uploaded in Notion, downloaded, stays hosted when the note is edited on another line", async (t) => {
  const path = `${DIR}/Lecture.mp4`;
  const big = new Uint8Array(UPLOAD_LIMIT + 1024);
  big[5] = 9;
  const { notion, store, gateway, count } = await setup(t, { [path]: big });
  const id = notion.add("Note", "intro\noutro");
  notion.pasteFile(id, "intro", "video", "Lecture.mp4", big, "the lecture");
  await gateway.getMarkdown(id);
  // What the download step records for it: the file as downloaded.
  const [pending] = gateway.pending();
  store.set(path, { sha256: createHash("sha256").update(big).digest("hex"), uploadId: null, uploadSha: null, keys: [pending!.key], urls: { [pending!.key]: hostedFile(pending!.url)!.bare } });
  const canonical = (await gateway.getMarkdown(id)).markdown;
  assert.equal(canonical, `intro\n${media("video", "the lecture", path)}\noutro`);
  const before = await blocks(notion, id);
  // An edit on another line, written the way the executor does: the line can't be a search text, so the page is replaced whole.
  const result = await write(gateway, id, `INTRO\n${media("video", "the lecture", path)}\noutro`);
  assert.equal(result.markdown, `INTRO\n${media("video", "the lecture", path)}\noutro`);
  assert.deepEqual(await blocks(notion, id), before, "same block id, still hosted, not text");
  assert.equal(count("uploadFile"), 0);
  assert.equal(count("attachFile"), 0);
  assert.deepEqual(gateway.refused(), []);
  // The same with a replace of the whole page.
  assert.equal(await gateway.replaceContent(id, `${canonical}\nmore`), `${canonical}\nmore`);
  assert.deepEqual(await blocks(notion, id), before);
});

test("with the vault's own exists and sha256, a large hosted file is never read into memory to read a page or keep its block", async (t) => {
  const path = `${DIR}/Lecture.mp4`;
  const big = new Uint8Array(UPLOAD_LIMIT + 1024);
  const notion = new FakeNotion();
  const store = await openImageStore(await tempDir(t));
  const sha = createHash("sha256").update(big).digest("hex");
  const gateway = withImages(notion, {
    store,
    readFile: async () => assert.fail("the file is not read"),
    exists: async (p) => p === path,
    sha256: async (p) => (p === path ? sha : null),
    log: () => {},
  });
  const id = notion.add("Note", "intro");
  notion.pasteFile(id, "intro", "video", "Lecture.mp4", big, "c");
  await gateway.getMarkdown(id);
  const [pending] = gateway.pending();
  store.set(path, { sha256: sha, uploadId: null, uploadSha: null, keys: [pending!.key], urls: { [pending!.key]: hostedFile(pending!.url)!.bare } });
  const before = await blocks(notion, id);
  assert.equal((await gateway.getMarkdown(id)).markdown, `intro\n${media("video", "c", path)}`);
  assert.deepEqual(gateway.pending().length, 1, "queued once, as before: reading again adds nothing");
  assert.equal(await gateway.replaceContent(id, `INTRO\n${media("video", "c", path)}`), `INTRO\n${media("video", "c", path)}`);
  assert.deepEqual(await blocks(notion, id), before);
});

// --- Refused uploads (spec §5.11) ----------------------------------------------------------------------------------------

test("an upload Notion refuses for its content type leaves the line as literal text, is reported, and the page's other edit is written", async (t) => {
  const clip = `${DIR}/clip.3gp`;
  const { notion, store, gateway, count } = await setup(t, { [clip]: bytesOf(3, 3), [OF_KIND.audio]: bytesOf(4, 4) });
  notion.refusedTypes.add("audio/3gpp");
  const id = notion.add("Note", "# T\ntext");
  const markdown = await gateway.updateContent(id, [{ old_str: "text", new_str: `TEXT\n${media("audio", "clip", clip)}\n${media("audio", "song")}` }]);
  assert.equal(markdown, `# T\nTEXT\n!\\[clip\\](clip.3gp)\n${media("audio", "song")}`, "the refused line is text, the other file is a block, the edit is written");
  assert.deepEqual((await notion.mediaBlocks(id)).map((b) => [b.kind, b.external === null]), [["audio", true]]);
  const refused = gateway.refused();
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.path, clip);
  assert.match(refused[0]!.reason, /audio\/3gpp/);
  assert.equal(store.get(clip), undefined, "nothing is kept for a file Notion won't take");
  assert.equal(count("uploadFile"), 2);
  assert.equal(gateway.uploaded(), 1, "a refused upload is not an upload");
  assert.deepEqual(gateway.unattached(), [], "no placeholder is left on the page");
  assert.equal((await gateway.getMarkdown(id)).markdown, markdown);
});

test("a refused file in a whole-page write, in a list item, as a link, and cited twice is literal each time and asks Notion once", async (t) => {
  const clip = `${DIR}/clip.3gp`;
  const { notion, gateway, count } = await setup(t, { [clip]: bytesOf(3, 3) });
  notion.refusedTypes.add("audio/3gpp");
  const id = notion.add("Note", "");
  const text = `${media("audio", "one", clip)}\n-\n\t${media("audio", "two", clip)}\n${media("file", "", clip)}\nafter`;
  const written = await gateway.replaceContent(id, text);
  assert.equal(written, "!\\[one\\](clip.3gp)\n-\n\t!\\[two\\](clip.3gp)\n\\[clip.3gp\\](clip.3gp)\nafter");
  assert.deepEqual(await notion.mediaBlocks(id), []);
  assert.equal(count("uploadFile"), 1, "the same file as it is, refused once");
  assert.deepEqual(gateway.refused().map((r) => r.path), [clip], "reported once");
});

test("a refused upload does not hold the page: no error, and the other pages and files go on", async (t) => {
  const clip = `${DIR}/clip.3gp`;
  const { notion, store, gateway } = await setup(t, { [clip]: bytesOf(3, 3), [OF_KIND.pdf]: bytesOf(1) });
  notion.refusedTypes.add("audio/3gpp");
  const one = notion.add("One", "");
  const two = notion.add("Two", "");
  await gateway.replaceContent(one, media("audio", "", clip));
  await gateway.replaceContent(two, media("pdf"));
  assert.equal(store.get(OF_KIND.pdf)!.keys.length, 1);
  assert.deepEqual(gateway.unattached(), []);
});

test("a refused file is tried again when its bytes change", async (t) => {
  const clip = `${DIR}/clip.3gp`;
  const { notion, disk, gateway, count } = await setup(t, { [clip]: bytesOf(3, 3) });
  notion.refusedTypes.add("audio/3gpp");
  const id = notion.add("Note", "");
  await gateway.replaceContent(id, media("audio", "", clip));
  await gateway.replaceContent(id, media("audio", "", clip));
  assert.equal(count("uploadFile"), 1);
  notion.refusedTypes.clear();
  disk.set(clip, bytesOf(4, 4));
  await gateway.replaceContent(id, media("audio", "", clip));
  assert.equal(count("uploadFile"), 2);
  assert.equal((await notion.mediaBlocks(id))[0]!.external, null, "now it is a block");
});

test("a file over the upload limit that was never uploaded is refused without asking Notion; a hosted block of the file keeps its place when the replacement is too big", async (t) => {
  const path = `${DIR}/Lecture.mp4`;
  const { notion, store, disk, gateway, count } = await setup(t, { [path]: bytesOf(1, 2, 3) });
  const id = notion.add("Note", "");
  await gateway.replaceContent(id, media("video", "lecture", path));
  const before = await blocks(notion, id);
  const old = store.get(path)!.sha256;
  disk.set(path, new Uint8Array(UPLOAD_LIMIT + 1));
  // Replaced by a file too big to upload: the block that is there stays (never turned back into text for its size), and it is said.
  assert.equal(await gateway.replaceContent(id, media("video", "lecture", path)), media("video", "lecture", path));
  assert.deepEqual(await blocks(notion, id), before);
  assert.equal(count("uploadFile"), 1);
  assert.equal(gateway.refused().length, 1);
  assert.match(gateway.refused()[0]!.reason, /20 MB/);
  assert.equal(store.get(path)!.sha256, old);
  // A page that holds no block of it can't keep one: the line is text.
  const other = notion.add("Other", "");
  assert.equal(await gateway.replaceContent(other, media("video", "lecture", path)), "!\\[lecture\\](Lecture.mp4)");
  assert.equal(count("uploadFile"), 1);
});

test("a placeholder a page already holds whose upload is refused is reported and left, without an error", async (t) => {
  const clip = `${DIR}/clip.3gp`;
  const { notion, gateway } = await setup(t, { [clip]: bytesOf(3, 3) });
  notion.refusedTypes.add("audio/3gpp");
  const id = notion.add("Note", `a\n${media("audio", "clip", clip)}`);
  await gateway.getMarkdown(id);
  assert.deepEqual(gateway.unattached(), [id]);
  await gateway.attach(id);
  assert.deepEqual(gateway.refused().map((r) => r.path), [clip]);
  assert.match(gateway.refused()[0]!.reason, /audio\/3gpp/);
  assert.equal((await notion.mediaBlocks(id))[0]!.external, placeholderUrl(clip), "still the placeholder; the next run looks at it again");
  assert.deepEqual(gateway.unattached(), [id], "still listed, so the next run looks at it again");
});

test("refreshImage of a replaced file Notion refuses reports it and changes nothing", async (t) => {
  const clip = `${DIR}/clip.mp3`;
  const { notion, store, disk, gateway } = await setup(t, { [clip]: bytesOf(3, 3) });
  const id = notion.add("Note", "");
  await gateway.replaceContent(id, media("audio", "", clip));
  const shown = store.get(clip)!.sha256;
  const before = await blocks(notion, id);
  notion.refusedTypes.add("audio/mpeg");
  disk.set(clip, bytesOf(4, 4));
  assert.equal(await gateway.refreshImage(clip, [id]), 0);
  assert.deepEqual(gateway.refused().map((r) => r.path), [clip]);
  assert.deepEqual(await blocks(notion, id), before);
  assert.equal(store.get(clip)!.sha256, shown, "the pages still show the old file; the next run finds it replaced again");
});
