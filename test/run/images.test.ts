import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { citedMedia, inFolder, namedMedia, namesMedia, pagesShowing, replacedMedia, strandedWarning, unusedMedia } from "../../src/run/images.ts";
import { openImageStore } from "../../src/state/images.ts";
import { tempDir, writeTree } from "../helpers/tmp.ts";

const DIR = "Assets/pictures";
const files = (...names: string[]) => Object.fromEntries(names.map((name) => [`${DIR}/${name}`, "PNG"]));
const at = (...names: string[]) => new Set(names.map((name) => `${DIR}/${name}`));

test("citedMedia: the files of the folder whose name any note, canvas or drawing of the vault holds, images included", async (t) => {
  const root = await tempDir(t);
  await writeTree(root, {
    ...files("a.png", "my pic.png", "b.png", "c.png", "d (1).png", "e.png", "Upper.PNG", "none.png"),
    "N1.md": "x\n\n![[a.png]]\n",
    "Deep/er/N2.md": "![pic](../../Assets/pictures/my%20pic.png)",
    "Board.canvas": JSON.stringify({ nodes: [{ type: "file", file: `${DIR}/b.png` }] }),
    "Drawing.excalidraw.md": "## Embedded Files\nabc: [[c.png]]\n",
    "Page.md": "---\ncover: d%20%281%29.png\n---\n<img src=\"e.png\">\n![[upper.png]]",
    "None.md": "a note that names no file",
    // Not counted: the trash, other dot-folders, files that are not notes or canvases.
    ".trash/Old.md": "![[none.png]]",
    ".obsidian/x.md": "![[none.png]]",
    "Other/notes.txt": "none.png",
  });
  assert.deepEqual(await citedMedia(root, DIR), at("a.png", "my pic.png", "b.png", "c.png", "d (1).png", "e.png", "Upper.PNG"));
});

test("citedMedia: a name is found as written or encoded, a conflict copy counts, and only the folder's own files are listed", async (t) => {
  const root = await tempDir(t);
  await writeTree(root, {
    ...files("x y.png"),
    [`${DIR}/inner/z.png`]: "PNG",
    "Other/outside.png": "PNG",
    "A.md": "![[x y.png]]",
    "A (Notion conflict 2026-09-27).md": "![](x%20y.png) ![[inner/z.png]] ![[outside.png]]",
  });
  assert.deepEqual(await citedMedia(root, DIR), at("x y.png"));
  assert.deepEqual(await citedMedia(root, "Other"), new Set(["Other/outside.png"]));
});

test("citedMedia: the vault root as the folder, a folder that doesn't exist, and extra texts counted as notes", async (t) => {
  const root = await tempDir(t);
  await writeTree(root, { "r.png": "PNG", "Sub/s.png": "PNG", "A.md": "![[s.png]]" });
  assert.deepEqual(await citedMedia(root, ""), new Set());
  assert.deepEqual(await citedMedia(root, "", ["![[r.png]]"]), new Set(["r.png"]));
  assert.deepEqual(await citedMedia(root, "Missing"), new Set());
});

test("citedMedia: a note it can't read counts as citing every image", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads everything");
  const root = await tempDir(t);
  await writeTree(root, { ...files("a.png", "b.png"), "Locked.md": "nothing", "Other.md": "![[a.png]]" });
  await chmod(join(root, "Locked.md"), 0o000);
  try {
    assert.deepEqual(await citedMedia(root, DIR), at("a.png", "b.png"));
  } finally {
    await chmod(join(root, "Locked.md"), 0o644); // so the folder can be removed
  }
});

test("citedMedia: notes in a symlinked folder protect their images, links that loop or dangle are harmless (final review 12)", async (t) => {
  const root = await tempDir(t);
  const outside = await tempDir(t);
  await writeTree(root, { ...files("a.png", "b.png", "c.png"), "Plain.md": "![[c.png]]" });
  await writeTree(outside, { "Deep/Linked note.md": "![[a.png]]\n", "Deep/Other.txt": "![[b.png]]" });
  // A folder elsewhere, shown in the vault by a link (Obsidian lists it); one linking back up (a loop); one to nothing; two names for one folder.
  await symlink(outside, join(root, "Linked"));
  await symlink(root, join(root, "Linked", "Back"));
  await symlink(join(root, "Nowhere"), join(root, "Dangling"));
  await symlink(join(outside, "Deep"), join(root, "Again"));
  assert.deepEqual(await citedMedia(root, DIR), at("a.png", "c.png"));
  // The loop alone ends too, and nothing is cited by a vault that has no notes.
  const loop = await tempDir(t);
  await writeTree(loop, files("a.png"));
  await symlink(loop, join(loop, "Self"));
  assert.deepEqual(await citedMedia(loop, DIR), new Set());
});

test("unusedMedia: cited before, not now, and still on disk", () => {
  const previous = new Set(["a.png", "b.png", "c.png"]);
  const now = new Set(["a.png", "d.png"]);
  assert.deepEqual(unusedMedia(previous, now, (path) => path !== "c.png"), ["b.png"]);
  assert.deepEqual(unusedMedia(new Set(), now, () => true), [], "files never cited are never touched");
});

test("replacedMedia: the stored images whose file now has another hash", async (t) => {
  const store = await openImageStore(await tempDir(t));
  const entry = (sha256: string) => ({ sha256, uploadId: null, uploadSha: null, keys: [], urls: {} });
  store.set("a.png", entry("old"));
  store.set("b.png", entry("same"));
  store.set("gone.png", entry("whatever"));
  const hashes: Record<string, string> = { "a.png": "new", "b.png": "same" };
  assert.deepEqual(await replacedMedia(store, async (path) => hashes[path] ?? null), ["a.png"]);
});

test("replacedMedia: an unchanged file with no stored size gets its size; a changed one doesn't (its size isn't the hash's)", async (t) => {
  const store = await openImageStore(await tempDir(t));
  const entry = (sha256: string, size?: number) => ({ sha256, uploadId: null, uploadSha: null, keys: [], urls: {}, ...(size === undefined ? {} : { size }) });
  store.set("a.png", entry("old"));
  store.set("b.png", entry("same"));
  store.set("c.png", entry("kept", 7));
  const hashes: Record<string, string> = { "a.png": "new", "b.png": "same", "c.png": "kept" };
  await replacedMedia(store, async (path) => hashes[path] ?? null, async () => 99);
  assert.equal(store.get("a.png")!.size, undefined);
  assert.equal(store.get("b.png")!.size, 99);
  assert.equal(store.get("c.png")!.size, 7);
});

test("strandedWarning names the image as before, and the file, PDF, audio or video for the other kinds", () => {
  // Images: the wording is as it was.
  assert.equal(
    strandedWarning("A.md", { line: "![[oven.png]] text after", why: "shared" }),
    'A.md: the image on the line "![[oven.png]] text after" shares its line with other text (or sits in a quote or table), so it stays text in Notion; put it on its own line to sync it as an image',
  );
  assert.equal(strandedWarning("A.md", { line: "![x](huge.png)", why: "large" }), 'A.md: the image on the line "![x](huge.png)" is over 20 MB, the most Notion takes in one upload, so it stays text in Notion');
  // A citation alone on its line, with text after it in its item or quote: it is told to move the text, not the citation.
  assert.equal(
    strandedWarning("A.md", { line: "![[oven.png]]", why: "followed" }),
    'A.md: the image on the line "![[oven.png]]" has text after it in its list item or quote, so it stays text in Notion; move the text above it to sync it as an image',
  );
  // Other kinds, found by the extension of what the line cites.
  assert.equal(
    strandedWarning("A.md", { line: "see ![[Manual.pdf#page=3]] here", why: "shared" }),
    'A.md: the PDF on the line "see ![[Manual.pdf#page=3]] here" shares its line with other text (or sits in a quote or table), so it stays text in Notion; put it on its own line to sync it as a PDF',
  );
  assert.equal(strandedWarning("A.md", { line: "![[lecture.mp4|Lecture]]", why: "large" }), 'A.md: the video on the line "![[lecture.mp4|Lecture]]" is over 20 MB, the most Notion takes in one upload, so it stays text in Notion');
  assert.equal(strandedWarning("A.md", { line: "> [Song](Song%20one.mp3)", why: "shared" }), 'A.md: the audio file on the line "> [Song](Song%20one.mp3)" shares its line with other text (or sits in a quote or table), so it stays text in Notion; put it on its own line to sync it as an audio file');
  // A note linked first on the line does not decide it; a line citing nothing recognizable says "file".
  assert.equal(strandedWarning("A.md", { line: "- [[Draft]] ![[Manual.pdf]] x", why: "shared" }).startsWith("A.md: the PDF on the line"), true);
  assert.equal(strandedWarning("A.md", { line: "[[Draft]] and more", why: "shared" }).startsWith("A.md: the file on the line"), true);
});

test("citedMedia: PDFs, audio, video and other files of the folder are cited by an embed or a link, the way images are", async (t) => {
  const root = await tempDir(t);
  await writeTree(root, {
    ...files("Manual.pdf", "meeting notes.docx", "song.mp3", "lecture.mp4", "figures.xlsx", "free.zip", "Unused.PDF", ".DS_Store", "noext"),
    "N1.md": "![[Manual.pdf#page=3]]\n\n[[song.mp3]]\n",
    "N2.md": "[minutes](meeting%20notes.docx)\n\n![lecture](../Assets/pictures/lecture.mp4)\n",
    "Board.canvas": JSON.stringify({ nodes: [{ type: "file", file: `${DIR}/figures.xlsx` }] }),
    "Drawing.excalidraw.md": "## Embedded Files\nabc: [[free.zip]]\n",
    // A hidden file and one with no extension are no attachments; the trash does not count.
    ".trash/Old.md": "![[Unused.pdf]]",
    "Dots.md": ".DS_Store noext",
  });
  assert.deepEqual(await citedMedia(root, DIR), at("Manual.pdf", "meeting notes.docx", "song.mp3", "lecture.mp4", "figures.xlsx", "free.zip"));
});

test("inFolder: any attachment directly in the folder, of any kind; nothing deeper, elsewhere, or that is a note", () => {
  for (const name of ["a.png", "Manual.pdf", "song.MP3", "lecture.mp4", "minutes.docx", "x.zip"]) assert.equal(inFolder(`${DIR}/${name}`, DIR), true, name);
  for (const path of [`${DIR}/inner/a.pdf`, "Other/a.pdf", `${DIR}/Note.md`, `${DIR}/Board.canvas`, `${DIR}/Drawing.excalidraw`, `${DIR}/noext`]) assert.equal(inFolder(path, DIR), false, path);
  assert.equal(inFolder("a.pdf", ""), true);
  assert.equal(inFolder(`${DIR}/a.pdf`, ""), false);
});

test("pagesShowing: the live pages whose text holds the placeholder of the file, as an image or as a PDF, audio, video or file block", () => {
  const PH = "https://nopipeline.invalid/vault";
  const records = new Map<string, { notionMarkdown: string }>([
    ["img", { notionMarkdown: `![](${PH}/${DIR}/a.png)` }],
    ["pdf", { notionMarkdown: `Intro\n<pdf src="${PH}/${DIR}/Manual.pdf"></pdf>` }],
    ["both", { notionMarkdown: `<file src="${PH}/${DIR}/Manual.pdf">x</file>\n- \n\t<audio src="${PH}/${DIR}/s%20s.mp3"></audio>` }],
    ["other", { notionMarkdown: `<pdf src="${PH}/${DIR}/Manual.pdf.bak"></pdf>\n![](${PH}/${DIR}/b.png)` }],
    ["gone", { notionMarkdown: `<video src="${PH}/${DIR}/lecture.mp4"></video>` }],
  ]);
  const live = (id: string) => id !== "gone";
  assert.deepEqual(pagesShowing(`${DIR}/a.png`, records, live), ["img"]);
  assert.deepEqual(pagesShowing(`${DIR}/Manual.pdf`, records, live), ["pdf", "both"]);
  assert.deepEqual(pagesShowing(`${DIR}/s s.mp3`, records, live), ["both"]);
  assert.deepEqual(pagesShowing(`${DIR}/lecture.mp4`, records, live), []);
});

test("namesMedia: anywhere in the text, or with wholeName, not as the end of a longer name", () => {
  assert.equal(namesMedia("![[alpha.png]]", "F/a.png"), true, "anywhere: over-protecting on purpose");
  assert.equal(namesMedia("![[alpha.png]]", "F/a.png", true), false);
  for (const text of ["![[a.png]]", "![](F/a.png)", "![[F/A.png|x]]", "a.png", "![](a.png)"]) assert.equal(namesMedia(text, "F/a.png", true), true, text);
  assert.equal(namesMedia("![](My%20Pics/my%20a.png)", "F/my a.png", true), true, "URL-encoded");
  assert.equal(namesMedia("![[alpha.png]] and ![[a.png]]", "F/a.png", true), true, "a later, whole occurrence counts");
});

test("namedMedia: the paths some note or canvas names, present or not", async (t) => {
  const root = await tempDir(t);
  await writeTree(root, { "N.md": "![[gone.png]] ![[alpha.png]]", "C.canvas": '{"file":"Pics/other.pdf"}', ".hidden/H.md": "![[hidden.png]]" });
  const named = await namedMedia(root, ["F/gone.png", "F/a.png", "F/other.pdf", "F/hidden.png", "F/none.png"], [], true);
  assert.deepEqual([...named].sort(), ["F/gone.png", "F/other.pdf"]);
});

test("a file named only in the status note isn't cited", async (t) => {
  const root = await tempDir(t);
  await writeTree(root, { "img/a.png": "PNG", "nopipeline status.md": "unused: a.png\n" });
  assert.deepEqual(await citedMedia(root, "img", [], "nopipeline status.md"), new Set());
  assert.deepEqual(await citedMedia(root, "img"), new Set(["img/a.png"]));
  assert.deepEqual(await namedMedia(root, ["img/a.png"], [], false, "nopipeline status.md"), new Set());
});

test("a file named only in a marked status note isn't cited, at any path", async (t) => {
  const root = await tempDir(t);
  await writeTree(root, { "img/a.png": "PNG", "Meta/old.md": "---\nnopipeline: status\n---\nunused: a.png\n" });
  assert.deepEqual(await citedMedia(root, "img", [], null), new Set());
  assert.deepEqual(await namedMedia(root, ["img/a.png"], [], false, null), new Set());
  await writeTree(root, { "Meta/mine.md": "see a.png" });
  assert.deepEqual(await citedMedia(root, "img"), new Set(["img/a.png"]));
});
