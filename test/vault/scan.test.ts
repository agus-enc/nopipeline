import { test } from "node:test";
import assert from "node:assert/strict";
import { scanVault } from "../../src/vault/scan.ts";
import { tempDir, writeTree } from "../helpers/tmp.ts";

const ID = "cb56bbf0-dc78-4886-8553-6285651b9f5d";

test("scanVault lists notes with their Notion ids and skips everything that isn't a note", async (t) => {
  const root = await tempDir(t);
  await writeTree(root, {
    "Elm.md": `---\nnotion-id: ${ID}\n---\n# Elm\n`,
    "Grove/Oak.md": "Oak notes",
    "Grove/Oak (Notion conflict 2026-09-27).md": "conflict copy",
    "Cards/Sketchpad.excalidraw.md": "---\nexcalidraw-plugin: parsed\n---\n",
    "Layouts/Floor Plan.md": "---\nexcalidraw-plugin: parsed\n---\n",
    "Resources/Board.canvas": "{}",
    "Assets/pictures/a.png": "png",
    ".obsidian/app.json": "{}",
    ".trash/Old.md": "old",
    ".stfolder/x.md": "x",
  });
  const scan = await scanVault(root);
  assert.deepEqual(
    scan.notes.map((n) => [n.path, n.notionId]),
    [
      ["Elm.md", ID],
      ["Grove/Oak.md", null],
    ],
  );
  assert.deepEqual(scan.drawings, ["Cards/Sketchpad.excalidraw.md", "Layouts/Floor Plan.md"]);
  assert.deepEqual(scan.folders, ["Assets", "Assets/pictures", "Cards", "Grove", "Layouts", "Resources"]);
  const elm = scan.notes.find((n) => n.path === "Elm.md")!;
  assert.equal(elm.body, "# Elm\n");
  assert.equal(elm.text, `---\nnotion-id: ${ID}\n---\n# Elm\n`);
});

test("the status note is skipped by path", async (t) => {
  const root = await tempDir(t);
  await writeTree(root, { "A.md": "a", "nopipeline status.md": "status" });
  assert.deepEqual((await scanVault(root, "nopipeline status.md")).notes.map((n) => n.path), ["A.md"]);
  assert.deepEqual((await scanVault(root)).notes.map((n) => n.path), ["A.md", "nopipeline status.md"]);
});

test("a note marked as the status note is skipped wherever it lies and whatever the configured path", async (t) => {
  const root = await tempDir(t);
  const marked = "---\nnopipeline: status\n---\n# nopipeline status\n";
  await writeTree(root, { "A.md": "a", "nopipeline status.md": marked, "Meta/old status.md": marked, "Meta/mine.md": "---\ntitle: x\n---\nnopipeline: status\n" });
  assert.deepEqual((await scanVault(root, null)).notes.map((n) => n.path), ["A.md", "Meta/mine.md"]);
  assert.deepEqual((await scanVault(root, "Meta/mine.md")).notes.map((n) => n.path), ["A.md"]);
});
