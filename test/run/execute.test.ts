import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../../src/config.ts";
import { NotionPageError } from "../../src/notion/gateway.ts";
import { runSync } from "../../src/sync.ts";
import { execute } from "../../src/run/execute.ts";
import { folderless } from "../../src/run/projects.ts";
import { openRecordStore } from "../../src/state/records.ts";
import { createVaultFs } from "../../src/vault/fs.ts";
import { scanVault } from "../../src/vault/scan.ts";
import { FakeNotion } from "../helpers/fake-notion.ts";
import { tempDir, writeTree } from "../helpers/tmp.ts";

async function setup(t: import("node:test").TestContext, files: Record<string, string>, projects = false) {
  const vault = await tempDir(t);
  const state = await tempDir(t);
  let clock = Date.parse("2026-09-27T10:00:00Z");
  const now = () => new Date(clock);
  const notion = new FakeNotion(now);
  if (projects) notion.schema.set("Project", "relation");
  const config: Config = {
    profile: "test",
    vaultPath: vault,
    vaultName: "DemoVault",
    dataSourceId: "a50245e9-8e6a-41aa-8ccf-d8795ed0dead",
    titleProperty: "Name",
    projectsRelation: projects ? "Project" : null,
    pageIcon: null,
    ignoredKeys: [],
    linksToProperty: "Links to",
    inboxFolder: "0-In",
    massTrashLimit: 2,
    tokenFile: null,
    stateDir: state,
  };
  const sync = (allowMassTrash = false) => {
    clock += 5 * 60_000;
    return runSync({ config, notion, dryRun: false, yes: true, allowMassTrash, now, log: () => {} });
  };
  await writeTree(vault, files);
  await sync();
  const read = (path: string) => readFile(join(vault, path), "utf8");
  const idOf = async (path: string) => /notion-id: (\S+)/.exec(await read(path))![1]!;
  return { vault, state, notion, sync, read, idOf };
}

test("moving or renaming a note in Obsidian moves or renames its page", async (t) => {
  const { vault, notion, sync, idOf } = await setup(t, { "A/Note.md": "text\n" }, true);
  const id = await idOf("A/Note.md");
  const project = notion.projectsOf(id)[0]!;
  assert.equal(notion.projectPages.get(project)!.title, "A");
  await rename(join(vault, "A"), join(vault, "B"));
  await rename(join(vault, "B/Note.md"), join(vault, "B/Better name.md"));
  assert.deepEqual((await sync()).summary!.done, { renameProject: 1, renameInNotion: 1 });
  assert.equal(notion.pages.get(id)!.title, "Better name");
  // The folder's rename renamed its project; the page keeps it.
  assert.deepEqual(notion.projectsOf(id), [project]);
  assert.equal(notion.projectPages.get(project)!.title, "B");
});

test("moving a note to another folder in Obsidian moves its page to that folder's project", async (t) => {
  const { vault, notion, sync, idOf } = await setup(t, { "A/Note.md": "text\n", "B/Other.md": "other\n" }, true);
  const id = await idOf("A/Note.md");
  const b = notion.projectsOf(await idOf("B/Other.md"))[0]!;
  await rename(join(vault, "A/Note.md"), join(vault, "B/Note.md"));
  assert.deepEqual((await sync()).summary!.done, { renameInNotion: 1 });
  assert.deepEqual(notion.projectsOf(id), [b]);
  assert.deepEqual((await sync()).plan.actions, []);
  // A move to the root or the default folder removes the project.
  await rename(join(vault, "B/Note.md"), join(vault, "Note.md"));
  await sync();
  assert.deepEqual(notion.projectsOf(id), []);
});

test("an edit wins over a delete on the other side", async (t) => {
  const { vault, notion, sync, read, idOf } = await setup(t, { "Kept.md": "v1\n", "Gone.md": "v1\n" });
  const kept = await idOf("Kept.md");
  const gone = await idOf("Gone.md");
  await rm(join(vault, "Gone.md"));
  notion.edit(gone, { markdown: "v2 from Notion" });
  await writeFile(join(vault, "Kept.md"), (await read("Kept.md")).replace("v1", "v2 from Obsidian"));
  notion.edit(kept, { inTrash: true });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { recreatePage: 1, restoreNote: 1 });
  assert.match(await read("Gone.md"), /v2 from Notion/);
  const newId = await idOf("Kept.md");
  assert.notEqual(newId, kept);
  assert.equal(notion.pages.get(newId)!.markdown, "v2 from Obsidian");
});

test("a page trashed in Notion moves the note to .trash", async (t) => {
  const { vault, notion, sync, idOf } = await setup(t, { "Note.md": "text\n" });
  notion.edit(await idOf("Note.md"), { inTrash: true });
  assert.deepEqual((await sync()).summary!.done, { trashNote: 1 });
  assert.equal(await readFile(join(vault, ".trash/Note.md"), "utf8").then(() => true), true);
});

test("too many trashes are held back until allowed", async (t) => {
  const { vault, notion, sync } = await setup(t, { "1.md": "a\n", "2.md": "b\n", "3.md": "c\n" });
  for (const n of ["1", "2", "3"]) await rm(join(vault, `${n}.md`));
  const held = await sync();
  assert.equal(held.plan.heldTrashes, 3);
  assert.equal([...notion.pages.values()].filter((p) => p.inTrash).length, 0);
  assert.deepEqual((await sync(true)).summary!.done, { trashPage: 3 });
});

test("a note Notion refuses is skipped and reported, the rest still sync", async (t) => {
  const { vault, notion, sync, read, idOf } = await setup(t, { "Bad.md": "one\n", "Good.md": "one\n" });
  const bad = await idOf("Bad.md");
  notion.updateContent = async (id, edits) => {
    if (id === bad) throw new NotionPageError("validation_error", "refused");
    return FakeNotion.prototype.updateContent.call(notion, id, edits);
  };
  await writeFile(join(vault, "Bad.md"), (await read("Bad.md")).replace("one", "two"));
  await writeFile(join(vault, "Good.md"), (await read("Good.md")).replace("one", "two"));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { push: 1 });
  assert.deepEqual(outcome.summary!.skipped, [{ path: "Bad.md", reason: "validation_error: refused" }]);
  assert.equal(notion.pages.get(await idOf("Good.md"))!.markdown, "two");
});

test("edits go one per request and may carry bookmark tags, which Notion keeps", async (t) => {
  const { vault, notion, sync, read, idOf } = await setup(t, { "Note.md": "first\n" });
  const id = await idOf("Note.md");
  const bookmark = '<unknown url="https://app.notion.com/p/abc#def" alt="bookmark"/>';
  notion.edit(id, { markdown: `first\nsame\n${bookmark}\nsame` });
  await sync();
  const edited = (await read("Note.md")).replace("first", "first, edited").replace(/same\n$/, "same, edited\n");
  await writeFile(join(vault, "Note.md"), edited);
  const before = notion.calls.length;
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.equal(notion.pages.get(id)!.markdown, `first, edited\nsame\n${bookmark}\nsame, edited`);
  assert.equal(notion.calls.slice(before).filter((c) => c.startsWith("updateContent")).length, 2);
});

test("a pull keeps Windows line endings and changes only the edited line", async (t) => {
  const { vault, notion, sync, read, idOf } = await setup(t, { "Win.md": "one\r\n\r\ntwo\r\n" });
  const id = await idOf("Win.md");
  notion.edit(id, { markdown: "one\ntwo, edited" });
  await sync();
  assert.equal(await read("Win.md"), `---\r\nnotion-id: ${id}\r\n---\r\none\r\n\r\ntwo, edited\r\n`);
});

test("a page too large to read is left alone, never trashed", async (t) => {
  const { vault, notion, sync, read, idOf } = await setup(t, { "Big.md": "big\n" });
  const id = await idOf("Big.md");
  notion.edit(id, { truncated: true, markdown: "partial" });
  const outcome = await sync();
  assert.deepEqual(outcome.plan.actions, []);
  assert.match(await read("Big.md"), /big/);
  assert.equal(notion.pages.get(id)!.inTrash, false);
});

test("a note is trashed only when Notion confirms its page is in the trash or gone", async (t) => {
  const { vault, notion, sync, idOf } = await setup(t, { "Missed.md": "one\n", "Hidden.md": "two\n", "Deleted.md": "three\n" });
  const [missed, hidden, deleted] = [await idOf("Missed.md"), await idOf("Hidden.md"), await idOf("Deleted.md")];
  // The listing misses two live pages (one of them unreadable); the third page is gone for good.
  notion.listPages = async () => (await FakeNotion.prototype.listPages.call(notion)).filter((p) => p.id !== missed && p.id !== hidden);
  notion.pageStatus = async (id) => {
    if (id === hidden) throw new NotionPageError("restricted_resource", "no access");
    return FakeNotion.prototype.pageStatus.call(notion, id);
  };
  notion.pages.delete(deleted);
  const outcome = await sync(true);
  assert.deepEqual(outcome.summary!.done, { trashNote: 1 });
  assert.deepEqual(
    outcome.summary!.skipped.map((s) => [s.path, s.reason.split(":")[0]]).sort(),
    [["Hidden.md", "restricted_resource"], ["Missed.md", "still_in_notion"]],
  );
  assert.deepEqual((await readdir(vault)).sort(), [".trash", "Hidden.md", "Missed.md"]);
  // The note kept for a live page says how to resolve it.
  assert.match(outcome.summary!.skipped.find((s) => s.path === "Missed.md")!.reason, /move the page back into the database, or delete the note by hand/);
});

test("a conversion whose note changed in Obsidian after the scan is skipped, and the note keeps its new text", async (t) => {
  const { vault, state, notion, sync, read, idOf } = await setup(t, { "A.md": "plain\n", "B.md": "Bee\n" });
  const id = await idOf("A.md");
  const scanned = (await read("A.md")).replace("plain", "See [[B]]");
  await writeFile(join(vault, "A.md"), scanned);
  const typed = scanned.replace("See [[B]]", "See [[B]], typed during the run");
  // Notion is listed after the vault is scanned: the note changes in between.
  notion.listPages = async () => {
    await writeFile(join(vault, "A.md"), typed);
    return FakeNotion.prototype.listPages.call(notion);
  };
  const outcome = await sync();
  assert.equal(outcome.plan.actions[0]!.kind, "convertLinks");
  assert.deepEqual(
    outcome.summary!.skipped.filter((s) => s.path === "A.md").map((s) => s.reason.split(":")[0]),
    ["changed_in_obsidian"],
  );
  assert.equal(outcome.summary!.done.convertLinks, undefined);
  assert.equal(await read("A.md"), typed);
  const record = JSON.parse(await readFile(join(state, "records", `${id}.json`), "utf8")) as { obsidianText: string };
  assert.doesNotMatch(record.obsidianText, /\[B\]\(B\.md\)/);
  // The push still carried the note as scanned: the same page link either form gives.
  assert.match(notion.pages.get(id)!.markdown, /^See \[B\]\(https:\/\/app\.notion\.com\/p\/[0-9a-f]{32}\)$/);
  // The next run converts the note as it is now, and pushes it.
  notion.listPages = FakeNotion.prototype.listPages;
  await sync();
  assert.match(await read("A.md"), /^See \[B\]\(B\.md\), typed during the run$/m);
  assert.match(notion.pages.get(id)!.markdown, /, typed during the run$/);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a skipped conversion and a Notion edit on a link line merge with no conflict copy, and nothing unwritten is recorded", async (t) => {
  const { vault, state, notion, sync, read, idOf } = await setup(t, { "A.md": "plain\n\nOther\n", "B.md": "Bee\n" });
  const id = await idOf("A.md");
  const url = `https://app.notion.com/p/${(await idOf("B.md")).replace(/-/g, "")}`;
  // The note and its record still hold the [[ ]] form (a conversion skipped before, or a sync before conversions).
  const scanned = (await read("A.md")).replace("plain", "See [[B]] here");
  await writeFile(join(vault, "A.md"), scanned);
  const recordFile = join(state, "records", `${id}.json`);
  const record = JSON.parse(await readFile(recordFile, "utf8")) as { obsidianText: string; notionMarkdown: string };
  record.obsidianText = scanned;
  record.notionMarkdown = `See [B](${url}) here\nOther`;
  await writeFile(recordFile, JSON.stringify(record));
  notion.edit(id, { markdown: `See [B](${url}) here, edited in Notion\nOther` });
  // Another line edited in Obsidian after the scan: the conversion is skipped.
  const typed = scanned.replace("Other", "Other, typed during the run");
  notion.listPages = async () => {
    await writeFile(join(vault, "A.md"), typed);
    return FakeNotion.prototype.listPages.call(notion);
  };
  const before = await readFile(recordFile, "utf8");
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.conflicts, []);
  assert.deepEqual(outcome.summary!.skipped.map((s) => `${s.path} ${s.reason.split(":")[0]}`), ["A.md changed_in_obsidian", "A.md changed_in_obsidian"]);
  assert.equal(notion.pages.get(id)!.markdown, `See [B](${url}) here, edited in Notion\nOther`);
  assert.equal(await read("A.md"), typed);
  assert.equal(await readFile(recordFile, "utf8"), before, "nothing recorded as synced that isn't on disk");
  // The next run merges both edits.
  notion.listPages = FakeNotion.prototype.listPages;
  const next = await sync();
  assert.deepEqual(next.summary!.conflicts, []);
  assert.equal(notion.pages.get(id)!.markdown, `See [B](${url}) here, edited in Notion\nOther, typed during the run`);
  assert.match(await read("A.md"), /\nSee \[B\]\(B\.md\) here, edited in Notion\n\nOther, typed during the run\n$/);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a write, move or trash of a note in use is not done: it waits, and is no skip", async (t) => {
  const { vault, state, notion, read, idOf } = await setup(t, { "X.md": "one\n", "Y.md": "two\n", "W.md": "three\n" });
  const [x, y, w] = [await idOf("X.md"), await idOf("Y.md"), await idOf("W.md")];
  notion.edit(x, { markdown: "one\nedited\n" });
  notion.edit(y, { title: "Z" });
  const before = { x: await read("X.md"), y: await read("Y.md"), w: await read("W.md") };
  const scan = await scanVault(vault, null);
  const pages = (await notion.listPages()).map((p) => ({ ...p, folder: null }));
  const summary = await execute(
    {
      actions: [
        { kind: "pull", pageId: x },
        { kind: "moveInVault", pageId: y, from: "Y.md", to: "Z.md" },
        { kind: "trashNote", pageId: w, path: "W.md" },
      ],
      warnings: [],
      heldTrashes: 0,
    },
    { notes: scan.notes, drawings: scan.drawings, pages, fetched: new Map([[x, (await notion.getMarkdown(x)).markdown]]), titles: new Map() },
    { vault: createVaultFs(vault, null), notion: folderless(notion), records: await openRecordStore(state), vaultName: "DemoVault", now: () => new Date(), inUse: new Set(["X.md", "Y.md", "W.md"]) },
  );
  assert.equal(await read("X.md"), before.x);
  assert.equal(await read("Y.md"), before.y);
  assert.equal(await read("W.md"), before.w);
  assert.deepEqual(summary.skipped, []);
  assert.deepEqual(summary.waiting, ["W.md", "X.md", "Y.md"]);
  assert.deepEqual(summary.done, {});
  assert.deepEqual(summary.skippedPages.sort(), [x, y, w].sort());
});

test("a rewrite that meets a note in use undoes the notes it had rewritten, and the action waits", async (t) => {
  const { vault, state, notion, read, idOf } = await setup(t, { "Target.md": "text\n", "A.md": "see [[Mid]]\n", "Open.md": "see [[Mid]]\n" });
  const target = await idOf("Target.md");
  const recordFile = join(state, "records", `${target}.json`);
  const record = JSON.parse(await readFile(recordFile, "utf8"));
  await writeFile(recordFile, JSON.stringify({ ...record, aliases: ["Folder/Mid.md"] }));
  const before = { a: await read("A.md"), open: await read("Open.md") };
  const recordBefore = await readFile(recordFile);
  const scan = await scanVault(vault, null);
  const pages = (await notion.listPages()).map((p) => ({ ...p, folder: null }));
  const summary = await execute(
    { actions: [{ kind: "endRename", pageId: target as never }], warnings: [], heldTrashes: 0 },
    { notes: scan.notes, drawings: scan.drawings, pages, fetched: new Map(), titles: new Map() },
    { vault: createVaultFs(vault, null), notion: folderless(notion), records: await openRecordStore(state), vaultName: "DemoVault", now: () => new Date(), inUse: new Set(["Open.md"]) },
  );
  assert.equal(await read("A.md"), before.a);
  assert.equal(await read("Open.md"), before.open);
  assert.deepEqual(await readFile(recordFile), recordBefore, "the aliases stay for the next run");
  assert.deepEqual(summary.skipped, []);
  assert.ok(summary.waiting?.includes("Open.md"));
});

test("a record keeps its tags after a push and after a pull", async (t) => {
  const { vault, state, notion, sync, idOf } = await setup(t, { "Note.md": "text\n" });
  const id = await idOf("Note.md");
  const store = await openRecordStore(state);
  await store.put({ ...store.all().get(id)!, tags: ["a"] });
  const tagsAfter = async () => (await openRecordStore(state)).all().get(id)!.tags;
  const path = join(vault, "Note.md");
  await writeFile(path, (await readFile(path, "utf8")).replace("text", "pushed"));
  assert.deepEqual((await sync()).summary!.done, { push: 1 });
  assert.deepEqual(await tagsAfter(), ["a"]);
  notion.edit(id, { markdown: "pulled\n" });
  assert.deepEqual((await sync()).summary!.done, { pull: 1 });
  assert.deepEqual(await tagsAfter(), ["a"]);
});
