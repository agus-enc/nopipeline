import { test } from "node:test";
import assert from "node:assert/strict";
import { open, readFile, readdir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { conflictCopyPath, createVaultFs } from "../../src/vault/fs.ts";
import { flushes } from "../helpers/fsync.ts";
import { tempDir, writeTree } from "../helpers/tmp.ts";

test("write creates folders, replaces files atomically and backs up the old version once", async (t) => {
  const root = await tempDir(t);
  const backups = await tempDir(t);
  await writeTree(root, { "A/Note.md": "v1" });
  const vault = createVaultFs(root, backups);
  await vault.write("A/Note.md", "v2");
  await vault.write("A/Note.md", "v3");
  await vault.write("B/New.md", "new");
  assert.equal(await readFile(join(root, "A/Note.md"), "utf8"), "v3");
  assert.equal(await readFile(join(root, "B/New.md"), "utf8"), "new");
  assert.equal(await readFile(join(backups, "A/Note.md"), "utf8"), "v1");
  assert.deepEqual(await readdir(join(root, "A")), ["Note.md"]);
});

test("move refuses to overwrite and keeps a backup of the moved file", async (t) => {
  const root = await tempDir(t);
  const backups = await tempDir(t);
  await writeTree(root, { "A.md": "a", "B.md": "b" });
  const vault = createVaultFs(root, backups);
  await assert.rejects(vault.move("A.md", "B.md"), /already exists/);
  await vault.move("A.md", "Folder/A2.md");
  assert.equal(await vault.exists("A.md"), false);
  assert.equal(await readFile(join(root, "Folder/A2.md"), "utf8"), "a");
  assert.equal(await readFile(join(backups, "A.md"), "utf8"), "a");
});

test("trash moves notes into .trash without clobbering earlier trash", async (t) => {
  const root = await tempDir(t);
  await writeTree(root, { "X/Note.md": "one", "Y/Note.md": "two", ".trash/Note.md": "older" });
  const vault = createVaultFs(root, null);
  assert.equal(await vault.trash("X/Note.md"), ".trash/Note (2).md");
  assert.equal(await vault.trash("Y/Note.md"), ".trash/Note (3).md");
  assert.equal(await readFile(join(root, ".trash/Note.md"), "utf8"), "older");
});

test("trash numbers a taken image name before its extension", async (t) => {
  const root = await tempDir(t);
  await writeTree(root, { "M/shot.png": "one", "N/shot.png": "two", ".trash/shot.png": "older" });
  const vault = createVaultFs(root, null);
  assert.equal(await vault.trash("M/shot.png"), ".trash/shot (2).png");
  assert.equal(await vault.trash("N/shot.png"), ".trash/shot (3).png");
  assert.equal(await readFile(join(root, ".trash/shot (3).png"), "utf8"), "two");
});

test("conflictCopyPath names the copy after the note and the date, adding the time when needed", async (t) => {
  const root = await tempDir(t);
  const vault = createVaultFs(root, null);
  const now = new Date("2026-09-27T04:05:06Z");
  assert.equal(await conflictCopyPath(vault, "Cloud/Elm.md", now), "Cloud/Elm (Notion conflict 2026-09-27).md");
  await writeTree(root, { "Cloud/Elm (Notion conflict 2026-09-27).md": "x" });
  assert.equal(await conflictCopyPath(vault, "Cloud/Elm.md", now), "Cloud/Elm (Notion conflict 2026-09-27 040506).md");
});

test("no path can reach outside the vault", async (t) => {
  const parent = await tempDir(t);
  const root = join(parent, "vault");
  await writeTree(root, { "A.md": "a" });
  const vault = createVaultFs(root, null);
  for (const path of ["../outside.md", "Folder/../../outside.md", "/etc/passwd"]) {
    await assert.rejects(vault.write(path, "x"), /outside the vault/);
    await assert.rejects(vault.read(path), /outside the vault/);
  }
  await assert.rejects(vault.move("A.md", "../A.md"), /outside the vault/);
  await assert.rejects(vault.trash("../A.md"), /outside the vault/);
  assert.deepEqual(await readdir(parent), ["vault"]);
});

test("a written note reaches the disk before it takes its name, and its name right after", async (t) => {
  const root = await tempDir(t);
  const backups = await tempDir(t);
  await writeTree(root, { "A/Note.md": "v1" });
  const vault = createVaultFs(root, backups);
  const flushed = await flushes(t);
  await vault.write("A/Note.md", "v2");
  await vault.move("A/Note.md", "B/Note.md");
  // A folder made for a write has its name flushed into the folder that holds it (backups/A, then B).
  if (flushed.some((path) => path.startsWith("/"))) {
    assert.deepEqual(flushed, [backups, join(backups, "A/Note.md"), join(backups, "A"), join(root, "A/Note.md.nopipeline-tmp"), join(root, "A"), root, join(root, "A"), join(root, "B")]);
  } else assert.equal(flushed.length, 8);
});

test("folders made for a write reach the disk, each in the folder that holds it", async (t) => {
  const root = await tempDir(t);
  const vault = createVaultFs(root, null);
  const flushed = await flushes(t);
  await vault.write("New/Sub/Note.md", "text");
  if (flushed.some((path) => path.startsWith("/"))) {
    assert.deepEqual(flushed, [root, join(root, "New"), join(root, "New/Sub/Note.md.nopipeline-tmp"), join(root, "New/Sub")]);
  } else assert.equal(flushed.length, 4);
});

test("a flush the file system can't do (EINVAL and the like) doesn't stop a write; other errors still do", async (t) => {
  const root = await tempDir(t);
  const probe = await open(join(root, "probe"), "w");
  const handles = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const refuse = (code: string) => () => Promise.reject(Object.assign(new Error(`${code}: fsync`), { code }));
  const vault = createVaultFs(root, null);
  t.mock.method(handles, "sync", refuse("EINVAL"));
  await vault.write("A/Note.md", "text");
  assert.equal(await readFile(join(root, "A/Note.md"), "utf8"), "text");
  t.mock.method(handles, "sync", refuse("EIO"));
  await assert.rejects(vault.write("A/Note.md", "again"), /EIO/);
});

test("writeBytes creates a binary file and its folders, and never overwrites", async (t) => {
  const root = await tempDir(t);
  const vault = createVaultFs(root, null);
  const bytes = Uint8Array.from([0, 255, 10, 13, 128]);
  await vault.writeBytes("Media/deep/pic.png", bytes);
  assert.deepEqual([...(await readFile(join(root, "Media/deep/pic.png")))], [...bytes]);
  await assert.rejects(vault.writeBytes("Media/deep/pic.png", Uint8Array.from([1])), /already exists/);
  assert.deepEqual([...(await readFile(join(root, "Media/deep/pic.png")))], [...bytes]);
  assert.deepEqual(await readdir(join(root, "Media/deep")), ["pic.png"]);
  await assert.rejects(vault.writeBytes("../outside.png", bytes), /outside the vault/);
});
