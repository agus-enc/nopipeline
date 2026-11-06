import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import { mediaOf, scanMedia, UPLOAD_LIMIT } from "../../src/vault/images.ts";
import { tempDir, writeTree } from "../helpers/tmp.ts";

const FILES = [
  "Assets/pictures/whisk.png",
  "Assets/pictures/Pasted image 1.png",
  "Assets/pictures/chart 2.png",
  "Notes/pics/a.png",
  "Other/a.png",
  "Other/deep/b.JPG",
  "Notes/readme.md",
  "Notes/doc.pdf",
];

test("resolve finds an image as Obsidian does: exact path, path from the note's folder, bare name in any case", () => {
  const media = mediaOf(FILES, "Assets/pictures");
  assert.equal(media.resolve("Assets/pictures/whisk.png", "Cookbook/x.md"), "Assets/pictures/whisk.png");
  assert.equal(media.resolve("whisk.png", "Cookbook/x.md"), "Assets/pictures/whisk.png");
  assert.equal(media.resolve("WHISK.PNG", "Cookbook/x.md"), "Assets/pictures/whisk.png");
  assert.equal(media.resolve("pics/a.png", "Notes/x.md"), "Notes/pics/a.png");
  assert.equal(media.resolve("../Other/deep/b.JPG", "Notes/x.md"), "Other/deep/b.JPG");
  assert.equal(media.resolve("deep/b.jpg", "Other/x.md"), "Other/deep/b.JPG");
  assert.equal(media.resolve("/Other/a.png", "Notes/x.md"), "Other/a.png");
});

test("a bare name shared by several files resolves to the shortest path; a path picks its own file", () => {
  const media = mediaOf(FILES, "Assets/pictures");
  assert.equal(media.resolve("a.png", "x.md"), "Other/a.png");
  assert.equal(media.resolve("pics/a.png", "x.md"), "Notes/pics/a.png");
  assert.equal(media.resolve("Other/a.png", "Notes/x.md"), "Other/a.png");
});

test("resolve answers null for a missing file, a note and a name with no extension; a PDF is an attachment like an image", () => {
  const media = mediaOf(FILES, "Assets/pictures");
  assert.equal(media.resolve("nothing.png", "x.md"), null);
  assert.equal(media.resolve("readme.md", "x.md"), null);
  assert.equal(media.resolve("readme", "x.md"), null);
  assert.equal(media.resolve("", "x.md"), null);
  assert.equal(media.resolve("doc.pdf", "Notes/x.md"), "Notes/doc.pdf");
});

test("pathFor is the file name alone when no other file shares it, else the full path, encoded as a link destination", () => {
  const media = mediaOf(FILES, "Assets/pictures");
  assert.equal(media.pathFor("Assets/pictures/chart 2.png", "0-In/x.md"), "chart%202.png");
  assert.equal(media.pathFor("Assets/pictures/whisk.png", "0-In/x.md"), "whisk.png");
  assert.equal(media.pathFor("Other/a.png", "0-In/x.md"), "Other/a.png");
  assert.equal(media.pathFor("Notes/pics/a.png", "0-In/x.md"), "Notes/pics/a.png");
  // A file that is not in the vault (yet) is named the same way.
  assert.equal(media.pathFor("Assets/pictures/new (1).png", "0-In/x.md"), "new%20%281%29.png");
});

test("a file over the upload limit isn't resolved, but is told apart", () => {
  const media = mediaOf(["a/small.png", "a/big.png"], "", ["a/big.png"]);
  assert.equal(media.resolve("big.png", "x.md"), null);
  assert.equal(media.resolve("small.png", "x.md"), "a/small.png");
  assert.equal(media.oversized("big.png", "x.md"), "a/big.png");
  assert.equal(media.oversized("small.png", "x.md"), null);
});

test("scanMedia lists the images outside dot-folders, with the attachment folder of app.json", async (t) => {
  const root = await tempDir(t);
  await writeTree(root, {
    "Assets/pictures/a.png": "png",
    "Notes/x.md": "note",
    "Notes/b.GIF": "gif",
    ".trash/old.png": "png",
    ".obsidian/icon.png": "png",
    ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: "Assets/pictures", useMarkdownLinks: true }),
  });
  const media = await scanMedia(root);
  assert.equal(media.folder, "Assets/pictures");
  assert.equal(media.resolve("a.png", "x.md"), "Assets/pictures/a.png");
  assert.equal(media.resolve("b.gif", "x.md"), "Notes/b.GIF");
  assert.equal(media.resolve("old.png", "x.md"), null);
  assert.equal(media.resolve("icon.png", "x.md"), null);
});

test("without an attachment folder in app.json (or without app.json), the folder is the vault root", async (t) => {
  const root = await tempDir(t);
  await writeTree(root, { "a.png": "png", ".obsidian/app.json": "{}" });
  assert.equal((await scanMedia(root)).folder, "");
  const bare = await tempDir(t);
  await writeTree(bare, { "a.png": "png" });
  assert.equal((await scanMedia(bare)).folder, "");
  const broken = await tempDir(t);
  await writeTree(broken, { ".obsidian/app.json": "{ not json" });
  assert.equal((await scanMedia(broken)).folder, "");
});

test("scanMedia keeps a file over the limit apart", async (t) => {
  const root = await tempDir(t);
  await mkdir(join(root, "pics"), { recursive: true });
  await writeFile(join(root, "pics/big.png"), "");
  await truncate(join(root, "pics/big.png"), UPLOAD_LIMIT + 1);
  await writeFile(join(root, "pics/edge.png"), "");
  await truncate(join(root, "pics/edge.png"), UPLOAD_LIMIT);
  const media = await scanMedia(root);
  assert.equal(UPLOAD_LIMIT, 20 * 1024 * 1024);
  assert.equal(media.resolve("big.png", "x.md"), null);
  assert.equal(media.oversized("big.png", "x.md"), "pics/big.png");
  assert.equal(media.resolve("edge.png", "x.md"), "pics/edge.png");
  // Both count as vault files for naming: a big file's name is taken.
  assert.equal(media.pathFor("pics/edge.png", "x.md"), "edge.png");
});

test("scanMedia counts the extra paths it is given, such as downloads a dry run didn't write", async (t) => {
  const root = await tempDir(t);
  await writeTree(root, { "Media/a.png": "png", ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: "Media" }) });
  const media = await scanMedia(root, ["Media/new.png", "Media/a.png", "Media/note.md"]);
  assert.equal(media.resolve("new.png", "x.md"), "Media/new.png");
  assert.equal(media.resolve("a.png", "x.md"), "Media/a.png");
  assert.equal(media.resolve("note.md", "x.md"), null);
  assert.equal(media.pathFor("Media/a.png", "x.md"), "a.png", "listed once, so its name alone is enough");
});

test("an attachment folder relative to the note (./, ./sub, .) is the vault root, where downloads can be found again (final review 16)", async (t) => {
  for (const relative of ["./", ".", "./pics", "./pics/", "/./"]) {
    const root = await tempDir(t);
    await writeTree(root, { "a.png": "png", ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: relative }) });
    assert.equal((await scanMedia(root)).folder, "", relative);
  }
});

const MEDIA_FILES = [
  "Assets/attachments/Manual.pdf",
  "Assets/attachments/lecture.MP4",
  "Assets/attachments/memo.mp3",
  "Assets/attachments/minutes.docx",
  "Assets/attachments/pic.png",
  "Assets/attachments/no extension",
  "Notes/a.md",
  "Notes/Doodle.excalidraw.md",
  "Notes/board.canvas",
  "Notes/table.base",
];

test("every kind of attachment resolves as Obsidian does; notes, drawings, canvases, bases and names without an extension never do", () => {
  const media = mediaOf(MEDIA_FILES, "Assets/attachments");
  assert.equal(media.resolve("Manual.pdf", "Notes/x.md"), "Assets/attachments/Manual.pdf");
  assert.equal(media.resolve("lecture.mp4", "Notes/x.md"), "Assets/attachments/lecture.MP4");
  assert.equal(media.resolve("memo.mp3", "Notes/x.md"), "Assets/attachments/memo.mp3");
  assert.equal(media.resolve("minutes.docx", "Notes/x.md"), "Assets/attachments/minutes.docx");
  assert.equal(media.resolve("pic.png", "Notes/x.md"), "Assets/attachments/pic.png");
  for (const target of ["a.md", "Doodle.excalidraw.md", "board.canvas", "table.base", "no extension", "a"]) assert.equal(media.resolve(target, "Notes/x.md"), null, target);
  // A note's name isn't taken by an attachment of the same stem: pathFor counts attachments only.
  assert.equal(media.pathFor("Assets/attachments/Manual.pdf", "Notes/x.md"), "Manual.pdf");
});

test("a bare name is shared only between files of the same name, whatever their kind", () => {
  const media = mediaOf(["A/x.pdf", "B/x.pdf", "A/x.png"], "");
  assert.equal(media.pathFor("A/x.pdf", "n.md"), "A/x.pdf");
  assert.equal(media.pathFor("A/x.png", "n.md"), "x.png");
});

test("a large file of any kind isn't resolved, unless Notion already holds it (hosted): then it is never oversized", () => {
  const media = mediaOf(["a/lecture.mp4", "a/small.pdf"], "", ["a/lecture.mp4"]);
  assert.equal(media.resolve("lecture.mp4", "x.md"), null);
  assert.equal(media.oversized("lecture.mp4", "x.md"), "a/lecture.mp4");
  assert.equal(media.oversized("small.pdf", "x.md"), null);
  // The run sets it after the scan, from the store; it is read at each call.
  media.hosted = (path) => path === "a/lecture.mp4";
  assert.equal(media.resolve("lecture.mp4", "x.md"), "a/lecture.mp4");
  assert.equal(media.oversized("lecture.mp4", "x.md"), null);
  media.hosted = () => false;
  assert.equal(media.resolve("lecture.mp4", "x.md"), null);
  assert.equal(media.oversized("lecture.mp4", "x.md"), "a/lecture.mp4");
});

test("scanMedia lists every attachment outside dot-folders and keeps a large one apart, whatever its kind", async (t) => {
  const root = await tempDir(t);
  await writeTree(root, {
    "Media/Manual.pdf": "pdf",
    "Media/minutes.docx": "docx",
    "Notes/x.md": "note",
    "Notes/board.canvas": "{}",
    ".trash/old.pdf": "pdf",
    ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: "Media" }),
  });
  await writeFile(join(root, "Media/lecture.mp4"), "");
  await truncate(join(root, "Media/lecture.mp4"), UPLOAD_LIMIT + 1);
  const media = await scanMedia(root, ["Media/new.mp3", "Media/x.md"]);
  assert.equal(media.folder, "Media");
  assert.equal(media.resolve("Manual.pdf", "x.md"), "Media/Manual.pdf");
  assert.equal(media.resolve("minutes.docx", "x.md"), "Media/minutes.docx");
  assert.equal(media.resolve("new.mp3", "x.md"), "Media/new.mp3");
  assert.equal(media.resolve("old.pdf", "x.md"), null);
  assert.equal(media.resolve("board.canvas", "x.md"), null);
  assert.equal(media.resolve("x.md", "x.md"), null);
  assert.equal(media.resolve("lecture.mp4", "x.md"), null);
  assert.equal(media.oversized("lecture.mp4", "x.md"), "Media/lecture.mp4");
});
