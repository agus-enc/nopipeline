import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NotionPageError } from "../../src/notion/gateway.ts";
import { withImages, type PendingImage } from "../../src/notion/images.ts";
import { convertHostedImages, downloadName, fetchPending } from "../../src/run/downloads.ts";
import { openImageStore } from "../../src/state/images.ts";
import { mediaOf } from "../../src/vault/images.ts";
import { createVaultFs } from "../../src/vault/fs.ts";
import { FakeNotion } from "../helpers/fake-notion.ts";
import { tempDir, writeTree } from "../helpers/tmp.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

test("downloadName keeps a free name", async () => {
  assert.deepEqual(await downloadName("a.png", bytes("x"), new Map()), { name: "a.png", reuse: false });
});

test("downloadName reuses a file of that name holding the same bytes, loading it only when the name is taken", async () => {
  let loads = 0;
  const files = new Map<string, Uint8Array | (() => Promise<Uint8Array>)>([
    [
      "a.png",
      async () => {
        loads++;
        return bytes("x");
      },
    ],
    ["other.png", async () => assert.fail("a file with another name is never read")],
  ]);
  assert.deepEqual(await downloadName("a.png", bytes("x"), files), { name: "a.png", reuse: true });
  assert.equal(loads, 1);
});

test("downloadName numbers the name as Obsidian does when the bytes differ, case-insensitively", async () => {
  const files = new Map<string, Uint8Array>([
    ["Shot.PNG", bytes("one")],
    ["shot 1.png", bytes("two")],
  ]);
  assert.deepEqual(await downloadName("shot.png", bytes("three"), files), { name: "shot 2.png", reuse: false });
  // The same bytes as an earlier numbered copy reuse that copy.
  assert.deepEqual(await downloadName("shot.png", bytes("two"), files), { name: "shot 1.png", reuse: true });
  assert.deepEqual(await downloadName("shot.png", bytes("one"), files), { name: "Shot.PNG", reuse: true });
});

test("downloadName numbers a name without an extension and keeps the dots of the rest", async () => {
  const files = new Map<string, Uint8Array>([
    ["v1.2.png", bytes("a")],
    ["noext", bytes("a")],
  ]);
  assert.equal((await downloadName("v1.2.png", bytes("b"), files)).name, "v1.2 1.png");
  assert.equal((await downloadName("noext", bytes("b"), files)).name, "noext 1");
});

async function fixture(t: import("node:test").TestContext, files: Record<string, string> = {}) {
  const root = await tempDir(t);
  const state = await tempDir(t);
  await writeTree(root, files);
  const notion = new FakeNotion();
  const store = await openImageStore(state);
  const vault = createVaultFs(root, null);
  const gateway = withImages(notion, {
    store,
    readFile: async (path) => (await vault.exists(path) ? new Uint8Array(await readFile(join(root, path))) : null),
    log: () => {},
  });
  const page = notion.add("P", "Intro");
  return { root, state, notion, store, vault, gateway, page, media: mediaOf([], "Media") };
}

test("fetchPending writes each new image into the folder, numbering a name another file holds, and records it", async (t) => {
  const { root, state, notion, store, vault, gateway, page, media } = await fixture(t, { "Media/pic.png": "old bytes" });
  notion.pasteImage(page, "Intro", "pic.png", bytes("new bytes"));
  notion.pasteImage(page, "Intro", "pic.png", bytes("new bytes"));
  notion.pasteImage(page, "Intro", "pic.png", bytes("third"));
  await gateway.getMarkdown(page);
  const result = await fetchPending(gateway.pending(), { notion: gateway, store, vault, media, dryRun: false });
  // Each paste lands right after "Intro", so the page lists them last-pasted first: "third" takes the first number,
  // and the two copies of "new bytes" share the second file.
  assert.deepEqual(result.downloaded.map((d) => d.path), ["Media/pic 1.png", "Media/pic 2.png", "Media/pic 2.png"]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual((await readdir(join(root, "Media"))).sort(), ["pic 1.png", "pic 2.png", "pic.png"]);
  assert.equal(await readFile(join(root, "Media/pic 1.png"), "utf8"), "third");
  assert.equal(await readFile(join(root, "Media/pic 2.png"), "utf8"), "new bytes");
  assert.equal(await readFile(join(root, "Media/pic.png"), "utf8"), "old bytes");
  const entry = store.get("Media/pic 2.png")!;
  assert.equal(entry.uploadId, null);
  assert.equal(entry.keys.length, 2);
  assert.equal(store.pathOf(entry.keys[0]!), "Media/pic 2.png");
  assert.match(entry.urls[entry.keys[0]!]!, /^https:\/\/prod-files-secure[^?#]*pic\.png$/);
  assert.deepEqual((await openImageStore(state)).get("Media/pic 2.png"), entry);
});

test("fetchPending in a dry run writes no file and does not save the store, but remembers the names it chose", async (t) => {
  const { root, state, notion, store, vault, gateway, page, media } = await fixture(t);
  notion.pasteImage(page, "Intro", "pic.png", bytes("one"));
  notion.pasteImage(page, "Intro", "pic.png", bytes("two"));
  await gateway.getMarkdown(page);
  const result = await fetchPending(gateway.pending(), { notion: gateway, store, vault, media, dryRun: true });
  assert.deepEqual(result.downloaded.map((d) => d.path).sort(), ["Media/pic 1.png", "Media/pic.png"]);
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual((await openImageStore(state)).paths(), []);
  assert.equal(store.paths().length, 2);
});

test("fetchPending reports a refused download and goes on with the others", async (t) => {
  const { notion, store, vault, gateway, page, media } = await fixture(t);
  notion.pasteImage(page, "Intro", "a.png", bytes("a"));
  notion.pasteImage(page, "Intro", "b.png", bytes("b"));
  await gateway.getMarkdown(page);
  const refusing = Object.create(gateway) as typeof gateway;
  refusing.downloadTo = async (url, fullPath) => {
    if (url.includes("a.png")) throw new NotionPageError("download_failed", "downloading the file answered 403");
    return gateway.downloadTo(url, fullPath);
  };
  const result = await fetchPending(gateway.pending(), { notion: refusing, store, vault, media, dryRun: false });
  assert.deepEqual(result.failed, [{ pageId: page, name: "a.png", reason: "downloading the file answered 403" }]);
  assert.deepEqual(result.downloaded.map((d) => d.path), ["Media/b.png"]);
});

test("fetchPending skips an image the store maps to a file that is there, and downloads a missing one back to its path", async (t) => {
  const { root, notion, store, vault, gateway, page, media } = await fixture(t);
  notion.pasteImage(page, "Intro", "pic.png", bytes("one"));
  await gateway.getMarkdown(page);
  const first = await fetchPending(gateway.pending(), { notion: gateway, store, vault, media, dryRun: false });
  assert.equal(first.downloaded.length, 1);
  // The queue is not pruned; the stored file makes the entry done.
  const again = await fetchPending(gateway.pending(), { notion: gateway, store, vault, media, dryRun: false });
  assert.deepEqual(again, { downloaded: [], failed: [], unsupported: [] });
  await rm(join(root, "Media/pic.png"));
  const back = await fetchPending(gateway.pending(), { notion: gateway, store, vault, media, dryRun: false });
  assert.deepEqual(back.downloaded.map((d) => d.path), ["Media/pic.png"]);
  assert.equal(await readFile(join(root, "Media/pic.png"), "utf8"), "one");
  assert.equal(store.paths().length, 1);
});

test("fetchPending refuses a name no note can cite, whatever the kind of the block", async (t) => {
  const { store, vault, gateway, page, media, root } = await fixture(t);
  const names = ["scan", "notes.md", "board.canvas", "..", "."];
  const pending = names.map((name, n): PendingImage => ({ pageId: page, key: `6b5d1c7e-0000-4000-8000-00000000000${n}`, name, url: `https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/6b5d1c7e-0000-4000-8000-00000000000${n}/${name}`, kind: "file" }));
  const result = await fetchPending(pending, { notion: gateway, store, vault, media, dryRun: false });
  assert.deepEqual(result.failed, [], "no failure to hold the page for");
  assert.deepEqual(result.unsupported.map((u) => u.name), names);
  assert.deepEqual(await readdir(root), []);
});

test("a hosted file with no extension never reaches fetchPending: the gateway reports it as unsupported", async (t) => {
  const { notion, store, vault, gateway, page, media, root } = await fixture(t);
  notion.pasteImage(page, "Intro", "scan", bytes("a"));
  await gateway.getMarkdown(page);
  assert.deepEqual(gateway.pending(), []);
  assert.deepEqual(gateway.unsupported().map((u) => [u.pageId, u.name]), [[page, "scan"]]);
  assert.deepEqual(await fetchPending(gateway.pending(), { notion: gateway, store, vault, media, dryRun: false }), { downloaded: [], failed: [], unsupported: [] });
  assert.deepEqual(await readdir(root), []);
});

test("convertHostedImages writes a hosted image line of a known file as the citation of its path, keeping the caption and indent", () => {
  const media = mediaOf(["Assets/pic.png", "Other/same.png", "Assets/same.png"], "Assets");
  const url = "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/6b5d1c7e-0000-4000-8000-000000000001/pic.png?X-Amz-Signature=1#notion_record=block.x.ws";
  const pathOf = (key: string) => (key === "6b5d1c7e-0000-4000-8000-000000000001" ? "Assets/pic.png" : null);
  const text = `---\nnotion-id: x\n---\nBefore\n![a caption](${url})\n- item\n\t![](${url})\n\`\`\`\n![](${url})\n\`\`\`\n`;
  const out = convertHostedImages(text, "Note.md", pathOf, media)!;
  assert.equal(out.images, 2);
  assert.equal(out.text, "---\nnotion-id: x\n---\nBefore\n![a caption](pic.png)\n- item\n\t![](pic.png)\n```\n![](" + url + ")\n```\n");
  assert.equal(convertHostedImages("Nothing\n", "Note.md", pathOf, media), null);
  // A file the vault doesn't have, or an unknown file, stays as it is.
  assert.equal(convertHostedImages(text, "Note.md", () => "Assets/gone.png", media), null);
  assert.equal(convertHostedImages(text, "Note.md", () => null, media), null);
});

test("fetchPending downloads a PDF block and a file block as they are named, streamed, and records them like images", async (t) => {
  const { root, state, notion, store, vault, gateway, page, media } = await fixture(t);
  notion.pasteFile(page, "Intro", "pdf", "Leaflet.pdf", bytes("%PDF-1 leaflet"), "leaflet");
  notion.pasteFile(page, "Intro", "file", "plan.docx", bytes("docx bytes"));
  notion.pasteFile(page, "Intro", "video", "clip.mp4", bytes("video bytes"));
  await gateway.getMarkdown(page);
  assert.deepEqual(gateway.pending().map((p) => p.kind).sort(), ["file", "pdf", "video"]);
  notion.calls.length = 0;
  const result = await fetchPending(gateway.pending(), { notion: gateway, store, vault, media, dryRun: false });
  assert.deepEqual(result.downloaded.map((d) => [d.path, d.kind]).sort(), [["Media/Leaflet.pdf", "pdf"], ["Media/clip.mp4", "video"], ["Media/plan.docx", "file"]]);
  assert.deepEqual(notion.calls.filter((c) => c.startsWith("download")), ["downloadTo", "downloadTo", "downloadTo"], "streamed: the bytes are never read into memory");
  assert.equal(await readFile(join(root, "Media/Leaflet.pdf"), "utf8"), "%PDF-1 leaflet");
  assert.equal(await readFile(join(root, "Media/plan.docx"), "utf8"), "docx bytes");
  assert.deepEqual((await readdir(join(root, "Media"))).sort(), ["Leaflet.pdf", "clip.mp4", "plan.docx"], "no temporary file is left behind");
  const entry = store.get("Media/plan.docx")!;
  assert.equal(entry.sha256, createHash("sha256").update("docx bytes").digest("hex"));
  assert.equal(entry.uploadId, null);
  assert.equal(store.pathOf(entry.keys[0]!), "Media/plan.docx");
  assert.deepEqual((await openImageStore(state)).get("Media/plan.docx"), entry);
});

test("fetchPending reuses a file of the folder that holds the very same bytes, whatever the kind, and numbers a name taken by other bytes", async (t) => {
  const { root, notion, store, vault, gateway, page, media } = await fixture(t, { "Media/Manual.pdf": "same pdf", "Media/plan.docx": "other docx" });
  notion.pasteFile(page, "Intro", "pdf", "Manual.pdf", bytes("same pdf"));
  notion.pasteFile(page, "Intro", "file", "plan.docx", bytes("new docx"));
  await gateway.getMarkdown(page);
  const result = await fetchPending(gateway.pending(), { notion: gateway, store, vault, media, dryRun: false });
  assert.deepEqual(result.downloaded.map((d) => d.path).sort(), ["Media/Manual.pdf", "Media/plan 1.docx"]);
  assert.deepEqual((await readdir(join(root, "Media"))).sort(), ["Manual.pdf", "plan 1.docx", "plan.docx"]);
  assert.equal(await readFile(join(root, "Media/plan.docx"), "utf8"), "other docx");
  assert.equal(store.get("Media/Manual.pdf")!.keys.length, 1);
});

test("fetchPending in a dry run streams to a temporary place and leaves the vault and the folder untouched", async (t) => {
  const { root, state, notion, store, vault, gateway, page, media } = await fixture(t, { "Media/a.txt": "x" });
  notion.pasteFile(page, "Intro", "pdf", "Manual.pdf", bytes("pdf"));
  await gateway.getMarkdown(page);
  const result = await fetchPending(gateway.pending(), { notion: gateway, store, vault, media, dryRun: true });
  assert.deepEqual(result.downloaded.map((d) => [d.path, d.kind]), [["Media/Manual.pdf", "pdf"]]);
  assert.deepEqual(await readdir(join(root, "Media")), ["a.txt"]);
  assert.deepEqual((await openImageStore(state)).paths(), []);
  assert.equal(store.pathOf(store.get("Media/Manual.pdf")!.keys[0]!), "Media/Manual.pdf");
});

test("fetchPending leaves nothing behind when a download breaks halfway, and reports the file", async (t) => {
  const { root, notion, store, vault, gateway, page, media } = await fixture(t);
  notion.pasteFile(page, "Intro", "pdf", "Manual.pdf", bytes("pdf"));
  await gateway.getMarkdown(page);
  const breaking = Object.create(gateway) as typeof gateway;
  breaking.downloadTo = async (_url, fullPath) => {
    await writeFile(fullPath, "half");
    throw new NotionPageError("download_failed", "downloading the file answered 500");
  };
  const result = await fetchPending(gateway.pending(), { notion: breaking, store, vault, media, dryRun: false });
  assert.deepEqual(result.failed.map((f) => f.name), ["Manual.pdf"]);
  assert.deepEqual(await readdir(root), [], "not even the folder it made for it");
  assert.deepEqual(store.paths(), []);
});

test("fetchPending brings back a known PDF whose file was deleted, to its own path, and updates its hash", async (t) => {
  const { root, notion, store, vault, gateway, page, media } = await fixture(t);
  notion.pasteFile(page, "Intro", "pdf", "Manual.pdf", bytes("one"));
  await gateway.getMarkdown(page);
  await fetchPending(gateway.pending(), { notion: gateway, store, vault, media, dryRun: false });
  await rm(join(root, "Media/Manual.pdf"));
  const back = await fetchPending(gateway.pending(), { notion: gateway, store, vault, media, dryRun: false });
  assert.deepEqual(back.downloaded.map((d) => [d.path, d.kind]), [["Media/Manual.pdf", "pdf"]]);
  assert.equal(await readFile(join(root, "Media/Manual.pdf"), "utf8"), "one");
  assert.deepEqual(await readdir(join(root, "Media")), ["Manual.pdf"]);
});

const MANUAL = "https://prod-files-secure.s3.us-west-2.amazonaws.com/46e5b3c1-0000-4000-8000-000000000000/5ca1ab1e-0000-4000-8000-000000000001/Manual.pdf";
const FIGURES = "https://prod-files-secure.s3.us-west-2.amazonaws.com/46e5b3c1-0000-4000-8000-000000000000/5ca1ab1e-0000-4000-8000-000000000002/Figures.xlsx";
const KEYS: Record<string, string> = { "5ca1ab1e-0000-4000-8000-000000000001": "Assets/Manual.pdf", "5ca1ab1e-0000-4000-8000-000000000002": "Assets/Figures.xlsx", "5ca1ab1e-0000-4000-8000-000000000003": "Assets/clip.mp4", "5ca1ab1e-0000-4000-8000-000000000004": "Assets/song.mp3" };

test("convertHostedImages turns the Manual form, <pdf src=hosted?>, into an embed of the downloaded PDF", () => {
  const media = mediaOf(["Assets/Manual.pdf"], "Assets");
  const text = `---\nnotion-id: x\n---\nIntro\n<pdf src="${MANUAL}?"></pdf>\n<pdf src="${MANUAL}?">Handbook</pdf>\nEnd\n`;
  const out = convertHostedImages(text, "0-In/Leaflet.md", (key) => KEYS[key] ?? null, media)!;
  assert.equal(out.images, 2);
  assert.equal(out.text, "---\nnotion-id: x\n---\nIntro\n![](Manual.pdf)\n![Handbook](Manual.pdf)\nEnd\n");
});

test("convertHostedImages writes an audio or video tag as an embed and a file tag as a link, with the file's name when it has no caption", () => {
  const media = mediaOf(["Assets/Figures.xlsx", "Assets/clip.mp4", "Assets/song.mp3"], "Assets");
  const sign = (url: string) => `${url}?X-Amz-Signature=abc#notion_record=block.b.ws`;
  const clip = "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/5ca1ab1e-0000-4000-8000-000000000003/clip.mp4";
  const song = "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/5ca1ab1e-0000-4000-8000-000000000004/song.mp3";
  const text = [`<file src="${sign(FIGURES)}"></file>`, `\t<file src="${sign(FIGURES)}">the figures</file>`, `<video src="${sign(clip)}">demo</video>`, `<audio src="${sign(song)}"></audio>`, "<file src=\"https://example.com/x.zip\">web</file>", ""].join("\n");
  const out = convertHostedImages(text, "N.md", (key) => KEYS[key] ?? null, media)!;
  assert.equal(out.images, 4);
  assert.equal(out.text, ["[Figures.xlsx](Figures.xlsx)", "\t[the figures](Figures.xlsx)", "![demo](clip.mp4)", "![](song.mp3)", "<file src=\"https://example.com/x.zip\">web</file>", ""].join("\n"));
});

test("convertHostedImages leaves a hosted tag of an unknown file, a file the vault lacks, and one inside code, as they are", () => {
  const media = mediaOf([], "Assets");
  const line = `<pdf src="${MANUAL}?">c</pdf>`;
  assert.equal(convertHostedImages(`${line}\n`, "N.md", () => null, media), null, "unknown file");
  assert.equal(convertHostedImages(`${line}\n`, "N.md", (key) => KEYS[key] ?? null, media), null, "the vault doesn't have it");
  const there = mediaOf(["Assets/Manual.pdf"], "Assets");
  assert.equal(convertHostedImages(`\`\`\`\n${line}\n\`\`\`\n`, "N.md", (key) => KEYS[key] ?? null, there), null, "code");
  assert.equal(convertHostedImages(`a ${line} b\n`, "N.md", (key) => KEYS[key] ?? null, there), null, "not alone on its line");
});
