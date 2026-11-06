import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { NotionPageError } from "../src/notion/gateway.ts";
import { exitCode, formatPlan, formatSummary } from "../src/report.ts";
import { runSync } from "../src/sync.ts";
import type { ObsidianProbe } from "../src/vault/inuse.ts";
import { FakeNotion } from "./helpers/fake-notion.ts";
import { tempDir, writeTree } from "./helpers/tmp.ts";

/** `nested` puts the vault two folders down its temporary folder, so paths that climb out stay inside it. */
async function setup(t: import("node:test").TestContext, nested = false, projects = false) {
  const vault = nested ? join(await tempDir(t), "a", "vault") : await tempDir(t);
  if (nested) await mkdir(vault, { recursive: true });
  const state = await tempDir(t);
  let clock = Date.parse("2026-09-27T10:00:00Z");
  const now = () => new Date(clock);
  const tick = (ms: number) => {
    clock += ms;
  };
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
    massTrashLimit: 10,
    tokenFile: null,
    stateDir: state,
  };
  const sync = (extra: Partial<{ dryRun: boolean; yes: boolean; allowMassTrash: boolean; allowTrashes: { pages: readonly string[]; files: readonly string[] }; obsidian: ObsidianProbe; log: (line: string) => void }> = {}) => {
    clock += 5 * 60_000;
    return runSync({ config, notion, dryRun: false, yes: true, allowMassTrash: false, now, log: () => {}, ...extra });
  };
  const read = (path: string) => readFile(join(vault, path), "utf8");
  const pageNamed = (title: string) => [...notion.pages.values()].find((p) => p.title === title && !p.inTrash);
  /** The title of the page's first project (null: none). */
  const projectOf = (id: string) => {
    const first = notion.projectsOf(id)[0];
    return first === undefined ? null : notion.projectPages.get(first)!.title;
  };
  return { vault, state, notion, sync, read, pageNamed, tick, config, projectOf };
}

const reasons = (outcome: Awaited<ReturnType<typeof runSync>>) => outcome.summary!.skipped.map((s) => s.reason.split(":")[0]);

test("an old profile's folderProperty is noted once per run", async (t) => {
  const { vault, notion, config } = await setup(t);
  await writeTree(vault, { "A.md": "Hello\n" });
  const lines: string[] = [];
  await runSync({ config: { ...config, ignoredKeys: ["folderProperty"] }, notion, dryRun: false, yes: true, allowMassTrash: false, log: (line) => lines.push(line) });
  assert.deepEqual(lines.filter((line) => line.includes("folderProperty")), ['note: "folderProperty" is no longer used; folders follow the "projectsRelation" now']);
});

test("the first run only previews unless --yes is given", async (t) => {
  const { vault, notion, sync } = await setup(t);
  await writeTree(vault, { "A.md": "Hello\n" });
  const outcome = await sync({ yes: false });
  assert.equal(outcome.summary, null);
  assert.deepEqual(outcome.plan.actions, [{ kind: "createPage", path: "A.md" }]);
  assert.equal(notion.pages.size, 0);
  assert.equal(await readFile(join(vault, "A.md"), "utf8"), "Hello\n");
});

test("a full cycle: first sync, no-op, edits both ways, conflict, rename and delete", async (t) => {
  const { vault, state, notion, sync, read, pageNamed, projectOf } = await setup(t, false, true);
  await writeTree(vault, { "Zettel/A.md": "Links to [[B]] and [[C]].\n", "Zettel/B.md": "Note B\n" });
  notion.add("B", "Note B");
  notion.add("C", "Note C from Notion");

  // 1. First sync: A's [[links]] become Markdown links, A gets a page, B is paired, C comes into the inbox.
  const first = await sync();
  assert.deepEqual(first.summary!.done, { convertLinks: 1, createPage: 1, createNote: 1, pair: 1 });
  assert.deepEqual(first.summary!.projectsCreated, ["Zettel"]);
  const [a, b, c] = [pageNamed("A")!, pageNamed("B")!, pageNamed("C")!];
  assert.equal(projectOf(a.id), "Zettel");
  assert.equal(projectOf(b.id), "Zettel");
  assert.equal(projectOf(c.id), null);
  assert.equal(a.markdown, `Links to [B](https://app.notion.com/p/${b.id.replace(/-/g, "")}) and [C](https://app.notion.com/p/${c.id.replace(/-/g, "")}).`);
  assert.equal(await read("0-In/C.md"), `---\nnotion-id: ${c.id}\n---\nNote C from Notion\n`);
  assert.match(await read("Zettel/A.md"), new RegExp(`^---\\nnotion-id: ${a.id}\\n---\\nLinks to \\[B\\]\\(B\\.md\\) and \\[C\\]\\(C\\.md\\)\\.\\n$`));

  // 2. Nothing changed: nothing to do.
  const second = await sync();
  assert.deepEqual(second.plan.actions, []);

  // 3. Edits on each side travel to the other.
  await writeFile(join(vault, "Zettel/A.md"), (await read("Zettel/A.md")).replace("Links to", "Now links to"));
  notion.edit(c.id, { markdown: "Note C, edited in Notion" });
  const third = await sync();
  assert.deepEqual(third.summary!.done, { push: 1, pull: 1 });
  assert.match(pageNamed("A")!.markdown, /^Now links to \[B\]\(https:\/\/app\.notion\.com\/p\//);
  assert.equal(await read("0-In/C.md"), `---\nnotion-id: ${c.id}\n---\nNote C, edited in Notion\n`);
  // The pull backed up the note it overwrote.
  const runs = await readdir(join(state, "backups"));
  const saved = await Promise.all(runs.map((run) => readFile(join(state, "backups", run, "0-In/C.md"), "utf8").catch(() => null)));
  assert.ok(saved.includes(`---\nnotion-id: ${c.id}\n---\nNote C from Notion\n`));

  // 4. Both sides edit the same line: Obsidian wins and the Notion text is kept in a conflict copy.
  await writeFile(join(vault, "Zettel/B.md"), (await read("Zettel/B.md")).replace("Note B", "Note B from Obsidian"));
  notion.edit(b.id, { markdown: "Note B from Notion" });
  const fourth = await sync();
  assert.deepEqual(fourth.summary!.done, { merge: 1 });
  assert.equal(fourth.summary!.conflicts.length, 1);
  assert.match(await read(fourth.summary!.conflicts[0]!), /Note B from Notion/);
  assert.match(await read("Zettel/B.md"), /Note B from Obsidian/);
  assert.equal(pageNamed("B")!.markdown, "Note B from Obsidian");

  // 5. A rename in Notion renames the file and the links to it: a link that read the old title reads the new one,
  // in the vault and, pushed in the same run, on the linking page.
  notion.edit(c.id, { title: "C: renamed" });
  const fifth = await sync();
  assert.deepEqual(fifth.summary!.done, { moveInVault: 1, push: 1 });
  assert.equal(await read("0-In/C- renamed.md"), `---\nnotion-id: ${c.id}\nnotion-title: "C: renamed"\n---\nNote C, edited in Notion\n`);
  assert.match(await read("Zettel/A.md"), /and \[C: renamed\]\(C-%20renamed\.md\)\./);
  assert.match(pageNamed("A")!.markdown, new RegExp(`and \\[C: renamed\\]\\(https://app\\.notion\\.com/p/${c.id.replace(/-/g, "")}\\)\\.$`));
  assert.deepEqual((await sync()).plan.actions, []);

  // 6. Deleting a note in Obsidian trashes its page.
  await rm(join(vault, "Zettel/B.md"));
  const sixth = await sync();
  assert.deepEqual(sixth.summary!.done, { trashPage: 1 });
  assert.equal(notion.pages.get(b.id)!.inTrash, true);
  assert.deepEqual(await readdir(join(vault, "Zettel")), ["A.md", fourth.summary!.conflicts[0]!.replace("Zettel/", "")].sort());
});

test("first sync pairs notes whose Notion copy holds links as escaped text, and upgrades the links", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "Grove/Grove Index.md": "- [[Elm]]\n- [[Oak]]\n", "Grove/Elm.md": "Shadowed\n" });
  notion.add("Grove Index", "- \\[\\[Elm\\]\\]\n- \\[\\[Oak\\]\\]");
  notion.add("Elm", "Shadowed");
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.conflicts, []);
  assert.deepEqual(outcome.summary!.done, { convertLinks: 1, pair: 2 });
  const elm = pageNamed("Elm")!;
  assert.equal(pageNamed("Grove Index")!.markdown, `- [Elm](https://app.notion.com/p/${elm.id.replace(/-/g, "")})\n- \\[\\[Oak\\]\\]`);
  assert.match(await read("Grove/Grove Index.md"), /^---\nnotion-id: [^\n]*\n---\n- \[Elm\]\(Elm\.md\)\n- \[Oak\]\(Oak\.md\)\n$/);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("empty notes and empty pages sync and then stay quiet", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "Empty.md": "" });
  notion.add("Blank", "");
  await sync();
  assert.equal(pageNamed("Empty")!.markdown, "");
  assert.equal(await read("0-In/Blank.md"), `---\nnotion-id: ${pageNamed("Blank")!.id}\n---\n`);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("mentions of pages outside the database come into Obsidian with their titles", async (t) => {
  const { notion, sync, read } = await setup(t);
  const area = "f81667b8-032f-4c48-8b1e-c45e19085615";
  notion.outside.set(area, "Grove");
  notion.add("Note", 'Area: <mention-page url="https://app.notion.com/p/f81667b8032f4c488b1ec45e19085615"/>');
  await sync();
  assert.match(await read("0-In/Note.md"), /Area: \[Grove\]\(https:\/\/app\.notion\.com\/p\/f81667b8032f4c488b1ec45e19085615\)/);
});

test("first-run pairing keeps a conflict copy when the texts differ in more than spacing", async (t) => {
  const { vault, notion, sync, read } = await setup(t);
  notion.add("Cmd", "Run `a || b`");
  await writeTree(vault, { "Cmd.md": "Run `a && b`\n" });
  const outcome = await sync();
  assert.equal(outcome.summary!.conflicts.length, 1);
  assert.match(await read(outcome.summary!.conflicts[0]!), /a \|\| b/);
});

const LAYOUT_NOTE = "Glossary:\n\n- Tide\n    - smallest range at __neap__\n";
const LAYOUT_PAGE = "Glossary:\n- Tide\n\t- smallest range at **neap**";

test("P11: a title pair whose texts differ only in __bold__ vs **bold** and indentation pairs quietly", async (t) => {
  const { vault, notion, sync, pageNamed } = await setup(t);
  notion.add("Layout", LAYOUT_PAGE);
  await writeTree(vault, { "Layout.md": LAYOUT_NOTE });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.conflicts, []);
  assert.deepEqual((await readdir(vault)).filter((n) => n.includes("conflict")), []);
  assert.equal(pageNamed("Layout")!.markdown, LAYOUT_PAGE);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("P11: a note carrying the id of a page filled before the record was saved is linked quietly", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  const id = notion.add("Layout", LAYOUT_PAGE);
  await writeTree(vault, { "Layout.md": `---\nnotion-id: ${id}\n---\n${LAYOUT_NOTE}` });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.conflicts, []);
  assert.equal(pageNamed("Layout")!.markdown, LAYOUT_PAGE);
  assert.match(await read("Layout.md"), /__neap__/);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("P11: a real wording difference still makes a conflict copy", async (t) => {
  const { vault, notion, sync } = await setup(t);
  notion.add("Layout", LAYOUT_PAGE.replace("smallest range", "largest range"));
  await writeTree(vault, { "Layout.md": LAYOUT_NOTE });
  assert.equal((await sync()).summary!.conflicts.length, 1);
});

test("a dry run changes nothing anywhere", async (t) => {
  const { vault, state, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "D.md": "d1\n\nd2\n" });
  await sync();
  const id = pageNamed("D")!.id;
  await writeFile(join(vault, "D.md"), (await read("D.md")).replace("\nd1\n", "\nd1, edited\n"));
  notion.edit(id, { markdown: "d1\nd2, edited" });
  const text = await read("D.md");
  const record = await readFile(join(state, "records", `${id}.json`), "utf8");
  const before = notion.calls.length;
  const preview = await sync({ dryRun: true });
  assert.deepEqual(preview.plan.actions, [{ kind: "merge", pageId: id }]);
  assert.equal(preview.summary, null);
  assert.equal(await read("D.md"), text);
  assert.equal(await readFile(join(state, "records", `${id}.json`), "utf8"), record);
  assert.deepEqual(notion.calls.slice(before).filter((call) => !/^(properties|listPages|getMarkdown)/.test(call)), []);
});

test("a push cut off after Notion applied it is finished next run without writing the edit twice", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "Note.md": "alpha\n\ngamma\n" });
  await sync();
  const id = pageNamed("Note")!.id;
  await writeFile(join(vault, "Note.md"), (await read("Note.md")).replace("alpha\n", "alpha\n\nbeta\n"));
  notion.updateContent = async (page, edits) => {
    notion.updateContent = FakeNotion.prototype.updateContent;
    await FakeNotion.prototype.updateContent.call(notion, page, edits);
    throw new Error("ECONNRESET");
  };
  await assert.rejects(sync(), /ECONNRESET/);
  await sync();
  assert.equal(notion.pages.get(id)!.markdown, "alpha\nbeta\ngamma");
  assert.match(await read("Note.md"), /\nalpha\n\nbeta\n\ngamma\n$/);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a merge Notion refuses leaves the note as it was, and the next run finishes it with one conflict copy", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "Note.md": "one\n\ntwo\n\nthree\n" });
  await sync();
  const id = pageNamed("Note")!.id;
  const mine = (await read("Note.md")).replace("one", "one (Obsidian)");
  await writeFile(join(vault, "Note.md"), mine);
  notion.edit(id, { markdown: "one (Notion)\ntwo\nnew from Notion\nthree" });
  notion.updateContent = async () => {
    notion.updateContent = FakeNotion.prototype.updateContent;
    throw new NotionPageError("conflict_error", "try again");
  };
  const refused = await sync();
  assert.deepEqual(reasons(refused), ["conflict_error"]);
  assert.equal(await read("Note.md"), mine);
  const finished = await sync();
  assert.deepEqual(finished.summary!.done, { merge: 1 });
  assert.equal(finished.summary!.conflicts.length, 1);
  assert.equal(notion.pages.get(id)!.markdown, "one (Obsidian)\ntwo\nnew from Notion\nthree");
  assert.match(await read("Note.md"), /\none \(Obsidian\)\n\ntwo\n\nnew from Notion\n\nthree\n$/);
  assert.equal((await readdir(vault)).filter((name) => name.includes("Notion conflict")).length, 1);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("after the records are lost, notes that match their pages are linked without rewriting the pages", async (t) => {
  const { state, notion, sync, pageNamed } = await setup(t);
  notion.add("Rich", 'Colored text {color="blue"}\nPlain');
  await sync();
  const id = pageNamed("Rich")!.id;
  await rm(join(state, "records"), { recursive: true });
  const before = notion.calls.length;
  const relinked = await sync();
  assert.deepEqual(relinked.summary!.done, { pair: 1 });
  assert.deepEqual(notion.calls.slice(before).filter((call) => /^(replaceContent|updateContent)/.test(call)), []);
  assert.equal(notion.pages.get(id)!.markdown, 'Colored text {color="blue"}\nPlain');
  assert.deepEqual((await sync()).plan.actions, []);
});

test("pairing never replaces a page that holds bookmarks or embeds", async (t) => {
  const { vault, notion, sync, pageNamed } = await setup(t);
  const bookmark = '<unknown url="https://www.notion.so/abc#def" alt="bookmark"/>';
  notion.add("B", `Note B\n${bookmark}`);
  await writeTree(vault, { "B.md": "Note B\n" });
  const outcome = await sync();
  assert.deepEqual(reasons(outcome), ["unsupported_blocks"]);
  assert.equal(pageNamed("B")!.markdown, `Note B\n${bookmark}`);
  assert.deepEqual(await readdir(vault), ["B.md"]);
});

test("a refused pairing says what resolves it, and doing that resolves it (final review, third round N6)", async (t) => {
  const why = (outcome: Awaited<ReturnType<typeof runSync>>) => outcome.summary!.skipped.map((s) => s.reason.replace(/\(bookmarks[^)]*\)/, "(…)"));
  // A pair by title: copying the note's text into the page wouldn't pair them, removing the blocks does.
  {
    const { vault, notion, sync } = await setup(t);
    await writeTree(vault, { "Topic.md": "Alpha line\n\nBeta line\n" });
    const id = notion.add("Topic", "<table_of_contents/>\nOld text from Notion");
    assert.deepEqual(why(await sync()), [
      "unsupported_blocks: the page has blocks a note can't hold (…), so it can't be replaced by the note; remove those blocks from the page in Notion, or rename the note or the page so the two sync as separate notes",
    ]);
    notion.edit(id, { markdown: "Old text from Notion" });
    assert.deepEqual((await sync()).summary!.done, { pair: 1 });
    assert.equal(notion.pages.get(id)!.markdown, "Alpha line\nBeta line");
    assert.deepEqual((await sync()).plan.actions, []);
  }
  // Or renamed: the two sync as separate notes, and the page keeps its blocks.
  {
    const { vault, notion, sync, read } = await setup(t);
    await writeTree(vault, { "Topic.md": "Alpha line\n" });
    const id = notion.add("Topic", "<table_of_contents/>\nOld text from Notion");
    assert.deepEqual(reasons(await sync()), ["unsupported_blocks"]);
    await rename(join(vault, "Topic.md"), join(vault, "My topic.md"));
    assert.deepEqual((await sync()).summary!.done, { createPage: 1, createNote: 1 });
    assert.equal(notion.pages.get(id)!.markdown, "<table_of_contents/>\nOld text from Notion");
    assert.match(await read("0-In/Topic.md"), /Old text from Notion/);
    assert.deepEqual((await sync()).plan.actions, []);
  }
  // A note carrying the page's id (its record lost): once the two say the same, they pair as they are.
  {
    const { vault, state, notion, sync, read } = await setup(t);
    const id = notion.add("Rich", "<table_of_contents/>\nAlpha");
    await sync();
    await rm(join(state, "records"), { recursive: true });
    await writeFile(join(vault, "0-In/Rich.md"), (await read("0-In/Rich.md")).replace("Alpha", "Alpha, edited"));
    assert.deepEqual(why(await sync()), [
      "unsupported_blocks: the page has blocks a note can't hold (…), so it can't be replaced by the note; make the note and the page say the same thing (a note shows such a block as a link or as its text; the next run then pairs them as they are), or remove those blocks from the page in Notion",
    ]);
    notion.edit(id, { markdown: "<table_of_contents/>\nAlpha, edited" });
    const before = notion.calls.length;
    assert.deepEqual((await sync()).summary!.done, { pair: 1 });
    assert.deepEqual(notion.calls.slice(before).filter((call) => /^(replaceContent|updateContent)/.test(call)), []);
    assert.equal(notion.pages.get(id)!.markdown, "<table_of_contents/>\nAlpha, edited");
    assert.deepEqual((await sync()).plan.actions, []);
  }
});

test("a first run cut off before any content was pushed leaves no empty conflict copies", async (t) => {
  const { vault, notion, sync, pageNamed } = await setup(t);
  await writeTree(vault, { "A.md": "Hello\n", "Z/C.md": "Sea\n" });
  notion.replaceContent = async () => {
    notion.replaceContent = FakeNotion.prototype.replaceContent;
    throw new Error("ETIMEDOUT");
  };
  await assert.rejects(sync(), /ETIMEDOUT/);
  const rerun = await sync();
  assert.deepEqual(rerun.summary!.conflicts, []);
  assert.equal(pageNamed("A")!.markdown, "Hello");
  assert.equal(pageNamed("C")!.markdown, "Sea");
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a Notion edit made during a run, after its page was read, is picked up by the next run", async (t) => {
  const { vault, notion, sync, read, pageNamed, tick } = await setup(t);
  await writeTree(vault, { "X.md": "x\n" });
  await sync();
  const id = pageNamed("X")!.id;
  notion.getMarkdown = async (page) => {
    const result = await FakeNotion.prototype.getMarkdown.call(notion, page);
    if (page === id) {
      notion.getMarkdown = FakeNotion.prototype.getMarkdown;
      tick(60_000);
      notion.edit(id, { markdown: "x, edited in Notion during the run" });
      tick(60_000);
    }
    return result;
  };
  await sync();
  const next = await sync();
  assert.deepEqual(next.summary!.done, { pull: 1 });
  assert.match(await read("X.md"), /\nx, edited in Notion during the run\n$/);
});

test("a page edited in Notion while its push runs is merged, not written over", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "P.md": "p1\n\np2\n" });
  await sync();
  await sync();
  const id = pageNamed("P")!.id;
  await writeFile(join(vault, "P.md"), (await read("P.md")).replace("p1", "p1 (Obsidian)"));
  notion.getMarkdown = async (page) => {
    if (page === id) {
      notion.getMarkdown = FakeNotion.prototype.getMarkdown;
      notion.edit(id, { markdown: "p1\np2 (Notion, during the run)" });
    }
    return FakeNotion.prototype.getMarkdown.call(notion, page);
  };
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { push: 1 });
  assert.equal(notion.pages.get(id)!.markdown, "p1 (Obsidian)\np2 (Notion, during the run)");
  assert.match(await read("P.md"), /\np1 \(Obsidian\)\n\np2 \(Notion, during the run\)\n$/);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a note saved in Obsidian during a run is not overwritten; the next run merges it", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "N.md": "n1\n\nn2\n" });
  await sync();
  const id = pageNamed("N")!.id;
  notion.edit(id, { markdown: "n1\nn2 (Notion)" });
  const typed = (await read("N.md")).replace("n1", "n1 (typed during the run)");
  notion.listPages = async () => {
    notion.listPages = FakeNotion.prototype.listPages;
    await writeFile(join(vault, "N.md"), typed);
    return FakeNotion.prototype.listPages.call(notion);
  };
  const held = await sync();
  assert.deepEqual(reasons(held), ["changed_in_obsidian"]);
  assert.equal(await read("N.md"), typed);
  await sync();
  assert.match(await read("N.md"), /\nn1 \(typed during the run\)\n\nn2 \(Notion\)\n$/);
  assert.equal(notion.pages.get(id)!.markdown, "n1 (typed during the run)\nn2 (Notion)");
});

test("a page too large to read is never trashed, even when its note was deleted", async (t) => {
  const { vault, notion, sync, pageNamed } = await setup(t);
  await writeTree(vault, { "Big.md": "big\n" });
  await sync();
  const id = pageNamed("Big")!.id;
  notion.edit(id, { truncated: true, markdown: "big, edited" });
  await rm(join(vault, "Big.md"));
  const outcome = await sync();
  assert.deepEqual(outcome.plan.actions, []);
  assert.deepEqual(reasons(outcome), ["truncated"]);
  assert.equal(notion.pages.get(id)!.inTrash, false);
});

test("an Obsidian move that Notion refuses once is still carried out by the next run", async (t) => {
  const { vault, notion, sync, read, pageNamed, projectOf } = await setup(t, false, true);
  await writeTree(vault, { "A/Note.md": "text\n", "B/Other.md": "other\n" });
  await sync();
  const id = pageNamed("Note")!.id;
  assert.equal(projectOf(id), "A");
  await writeFile(join(vault, "B/Note.md"), (await read("A/Note.md")).replace("text", "text, edited"));
  await rm(join(vault, "A/Note.md"));
  notion.setProjects = async () => {
    notion.setProjects = FakeNotion.prototype.setProjects;
    throw new NotionPageError("conflict_error", "try again");
  };
  const first = await sync();
  assert.deepEqual(first.summary!.done, { push: 1 });
  assert.equal(projectOf(id), "A");
  const second = await sync();
  assert.deepEqual(second.summary!.done, { renameInNotion: 1 });
  assert.equal(notion.pages.get(id)!.title, "Note");
  assert.equal(projectOf(id), "B");
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a page whose mention shows a new title, with no new edit time, still takes pushes", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  // An embed: a note's link is a page link, and an embed of a note its mention.
  await writeTree(vault, { "Target.md": "target\n", "Linker.md": "see ![[Target]]\n\nsecond line\n" });
  await sync();
  await sync();
  const linker = notion.pages.get(pageNamed("Linker")!.id)!;
  linker.markdown = linker.markdown.replace('"/>', '">Target</mention-page>');
  await writeFile(join(vault, "Linker.md"), (await read("Linker.md")).replace("second line", "second line, edited in Obsidian"));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { push: 1 });
  assert.match(linker.markdown, /">Target<\/mention-page>\nsecond line, edited in Obsidian$/);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a conflict with a page emptied in Notion is still reported", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "E.md": "one\n\ntwo\n" });
  await sync();
  const id = pageNamed("E")!.id;
  await writeFile(join(vault, "E.md"), (await read("E.md")).replace("two", "two (Obsidian)"));
  notion.edit(id, { markdown: "" });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { merge: 1 });
  assert.equal(outcome.summary!.conflicts.length, 1);
  assert.equal(await read(outcome.summary!.conflicts[0]!), "");
});

test("a first-run pair whose page changes during the run waits, and the next run keeps the new Notion text", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  const id = notion.add("Doc", "Notion v1");
  await writeTree(vault, { "Doc.md": "Obsidian text\n" });
  notion.getMarkdown = async (page) => {
    const result = await FakeNotion.prototype.getMarkdown.call(notion, page);
    if (page === id) {
      notion.getMarkdown = FakeNotion.prototype.getMarkdown;
      notion.edit(id, { markdown: "Notion v2, typed during the run" });
    }
    return result;
  };
  const waited = await sync();
  assert.deepEqual(reasons(waited), ["changed_in_notion"]);
  assert.equal(pageNamed("Doc")!.markdown, "Notion v2, typed during the run");
  const paired = await sync();
  assert.deepEqual(paired.summary!.done, { pair: 1 });
  assert.match(await read(paired.summary!.conflicts[0]!), /Notion v2, typed during the run/);
  assert.equal(pageNamed("Doc")!.markdown, "Obsidian text");
});

test("an edit in Obsidian and a paragraph or list item added next to it in Notion both arrive, with no conflict", async (t) => {
  for (const [note, obsidian, notion, merged] of [
    ["Alpha\n\nBeta\n\nGamma\n", ["Gamma", "Gamma (Obsidian)"], ["Beta\n", "Beta\nNew paragraph from Notion\n"], "Alpha\n\nBeta\n\nNew paragraph from Notion\n\nGamma (Obsidian)\n"],
    ["- one\n- two\n- three\n", ["- two", "- two (Obsidian)"], ["- three", "- two and a half (Notion)\n- three"], "- one\n- two (Obsidian)\n- two and a half (Notion)\n- three\n"],
  ] as const) {
    const { vault, notion: fake, sync, read, pageNamed } = await setup(t);
    await writeTree(vault, { "Note.md": note });
    await sync();
    const page = pageNamed("Note")!;
    await writeFile(join(vault, "Note.md"), (await read("Note.md")).replace(obsidian[0], obsidian[1]));
    fake.edit(page.id, { markdown: page.markdown.replace(notion[0], notion[1]) });
    const outcome = await sync();
    assert.deepEqual(outcome.summary!.done, { merge: 1 });
    assert.deepEqual(outcome.summary!.conflicts, []);
    assert.equal((await read("Note.md")).replace(/^---\n[\s\S]*?\n---\n/, ""), merged);
    assert.deepEqual((await readdir(vault)).filter((name) => name.includes("Notion conflict")), []);
    assert.deepEqual((await sync()).plan.actions, []);
  }
});

test("a project whose title is ../outside or .hidden can't put a note outside the vault or into a folder the scan can't see", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t, true, true);
  const outside = notion.addProject("../outside");
  const hidden = notion.addProject(".hidden");
  notion.add("Escapee", "written by Notion", [outside]);
  notion.add("Hidden", "hidden text", [hidden]);
  await writeTree(vault, { "Kept.md": "kept text\n" });
  const first = await sync();
  assert.deepEqual(first.summary!.done, { createPage: 1, createNote: 2 });
  assert.deepEqual(first.plan.warnings, []);
  // The folders take the file-name form of the titles, inside the vault and visible.
  assert.match(await read("---outside/Escapee.md"), /written by Notion/);
  assert.match(await read("-hidden/Hidden.md"), /hidden text/);

  // A project renamed in Notion to a path that climbs out of the vault moves its note to a folder inside it.
  notion.editProject(outside, { title: "../../moved-out" });
  for (let run = 0; run < 2; run++) {
    const outcome = await sync();
    assert.deepEqual(outcome.plan.warnings, []);
    assert.deepEqual(outcome.summary!.skipped, []);
  }
  assert.match(await read("---..-moved-out/Escapee.md"), /written by Notion/);
  assert.match(await read("Kept.md"), /kept text/);
  assert.deepEqual([...notion.pages.values()].filter((p) => p.inTrash), []);
  assert.equal(pageNamed("Escapee")!.title, "Escapee");
  assert.deepEqual(await readdir(join(vault, "..")), ["vault"]);
  assert.deepEqual(await readdir(join(vault, "../..")), ["a"]);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a renamed or retyped title property stops the run before anything changes", async (t) => {
  const { vault, notion, sync, read } = await setup(t);
  await writeTree(vault, { "Cloud/Elm.md": "Shadowed, see [[Oak]]\n", "Cloud/Oak.md": "Knotted\n" });
  await sync();
  const note = await read("Cloud/Elm.md");
  const pages = JSON.stringify([...notion.pages.values()]);
  for (const [change, error] of [
    [(schema: Map<string, string>) => schema.delete("Name") && schema.set("Titel", "title"), /title property is "Titel", not "Name": rename it back to "Name" in Notion, or set "titleProperty": "Titel"/],
  ] as const) {
    const saved = new Map(notion.schema);
    change(notion.schema);
    const before = notion.calls.length;
    await assert.rejects(sync(), error);
    assert.deepEqual(notion.calls.slice(before), ["properties"]);
    assert.equal(await read("Cloud/Elm.md"), note);
    assert.equal(JSON.stringify([...notion.pages.values()]), pages);
    notion.schema.clear();
    for (const [name, type] of saved) notion.schema.set(name, type);
  }
  assert.deepEqual((await sync()).plan.actions, []);
});

test("the sync never creates or changes a database property, in a preview or a real run", async (t) => {
  const { vault, notion, sync } = await setup(t);
  await writeTree(vault, { "A.md": "Hello\n" });
  const schema = [...notion.schema];
  await sync({ dryRun: true });
  await sync({ yes: false });
  await sync();
  await sync();
  assert.deepEqual([...notion.schema], schema);
  assert.equal(notion.schema.has("Folder"), false);
});

test("a rename in Notion rewrites links in other notes' frontmatter too, keeping every other byte", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  const front = "up: \"[[Parent]]\"\ndown: '[[Parent|the parent]]'\nrelated:\n  - \"[[Parent]]\"\n  - \"[[Other]]\"\ntags: [a, b]\n";
  await writeTree(vault, { "Parent.md": "The parent\n", "Other.md": "other\n", "Child.md": `---\n${front}---\nBody links to [[Parent]]\n` });
  await sync();
  const child = await read("Child.md");
  notion.edit(pageNamed("Parent")!.id, { title: "Parent's note" });
  assert.deepEqual((await sync()).summary!.done, { moveInVault: 1, push: 1 });
  const expected = child.replace('up: "[[Parent]]"', "up: \"[[Parent's note]]\"").replace("'[[Parent|the parent]]'", "'[[Parent''s note|the parent]]'").replace('  - "[[Parent]]"', "  - \"[[Parent's note]]\"").replace("to [Parent](Parent.md)", "to [Parent's note](Parent's%20note.md)");
  assert.equal(await read("Child.md"), expected);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a note that gets its notion-id back and a new name from Notion in one run keeps the links to it", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "Target.md": "target\n", "Linker.md": "see [[Target]]\n" });
  await sync();
  await writeFile(join(vault, "Target.md"), (await read("Target.md")).replace(/^---\nnotion-id: .*\n---\n/, ""));
  notion.edit(pageNamed("Target")!.id, { title: "Renamed" });
  assert.deepEqual((await sync()).summary!.done, { writeId: 1, moveInVault: 1, push: 1 });
  assert.match(await read("Linker.md"), /see \[Renamed\]\(Renamed\.md\)\n$/);
  assert.equal(pageNamed("Linker")!.markdown, `see [Renamed](https://app.notion.com/p/${pageNamed("Renamed")!.id.replace(/-/g, "")})`);
});

test("a move onto a file that appeared during the run is skipped and reported, and the rest of the run goes on", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "Target.md": "target\n", "Linker.md": "see [[Target]]\n", "Other.md": "other\n" });
  await sync();
  notion.edit(pageNamed("Target")!.id, { title: "Renamed" });
  await writeFile(join(vault, "Other.md"), (await read("Other.md")).replace("other", "other, edited"));
  notion.listPages = async () => {
    notion.listPages = FakeNotion.prototype.listPages;
    await writeFile(join(vault, "Renamed.md"), "typed in Obsidian during the run\n");
    return FakeNotion.prototype.listPages.call(notion);
  };
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { push: 1 });
  assert.deepEqual(reasons(outcome), ["path_taken"]);
  assert.match(await read("Target.md"), /target/);
  assert.equal(await read("Renamed.md"), "typed in Obsidian during the run\n");
  assert.match(await read("Linker.md"), /see \[Target\]\(Target\.md\)\n$/);
});

test("a rename in Notion cut off while it rewrites links is finished by the next run", async (t) => {
  const vault = await tempDir(t);
  const state = await tempDir(t);
  let clock = Date.parse("2026-09-27T10:00:00Z");
  let cut = false;
  // The power fails right after the first note linking to the renamed one has been rewritten.
  const now = () => {
    if (cut && readFileSync(join(vault, "A linker.md"), "utf8").includes("(Renamed.md)")) {
      cut = false;
      throw new Error("power cut");
    }
    return new Date(clock);
  };
  const notion = new FakeNotion(() => new Date(clock));
  const config: Config = { profile: "test", vaultPath: vault, vaultName: "DemoVault", dataSourceId: "a50245e9-8e6a-41aa-8ccf-d8795ed0dead", titleProperty: "Name", linksToProperty: "Links to", projectsRelation: null, pageIcon: null, ignoredKeys: [], inboxFolder: "0-In", massTrashLimit: 10, tokenFile: null, stateDir: state };
  const sync = () => {
    clock += 5 * 60_000;
    return runSync({ config, notion, dryRun: false, yes: true, allowMassTrash: false, now, log: () => {} });
  };
  await writeTree(vault, { "Target.md": "target\n", "A linker.md": "see [[Target]]\n", "B linker.md": "and [[Target]]\n" });
  await sync();
  notion.edit([...notion.pages.values()].find((p) => p.title === "Target")!.id, { title: "Renamed" });
  cut = true;
  await assert.rejects(sync(), /power cut/);
  await sync();
  assert.match(readFileSync(join(vault, "A linker.md"), "utf8"), /see \[Renamed\]\(Renamed\.md\)\n$/);
  assert.match(readFileSync(join(vault, "B linker.md"), "utf8"), /and \[Renamed\]\(Renamed\.md\)\n$/);
  assert.match(readFileSync(join(vault, "Renamed.md"), "utf8"), /target/);
  // The linking pages still link the renamed page: none of them turned the link into text. Their text is the new
  // title: Notion keeps a page link's text (live probe), so the rewritten text was pushed.
  const target = [...notion.pages.values()].find((p) => p.title === "Renamed")!.id.replace(/-/g, "");
  for (const title of ["A linker", "B linker"]) assert.match([...notion.pages.values()].find((p) => p.title === title)!.markdown, new RegExp(`\\[Renamed\\]\\(https://app\\.notion\\.com/p/${target}\\)$`));
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a [[link]] written before its note existed becomes a page link once the note has a page", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "A.md": "Idea: see [[B]] for details\n\nSecond paragraph\n" });
  await sync();
  const a = pageNamed("A")!;
  assert.equal(a.markdown, "Idea: see \\[\\[B\\]\\] for details\nSecond paragraph");
  await writeTree(vault, { "B.md": "The B note\n" });
  const preview = await sync({ dryRun: true });
  assert.deepEqual(preview.plan.actions, [{ kind: "createPage", path: "B.md" }, { kind: "relink", pageId: a.id }]);
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { createPage: 1, relink: 1 });
  const b = pageNamed("B")!;
  assert.equal(a.markdown, `Idea: see [B](https://app.notion.com/p/${b.id.replace(/-/g, "")}) for details\nSecond paragraph`);
  assert.match(await read("A.md"), /Idea: see \[B\]\(B\.md\) for details/);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a [[link]] to a note whose page Notion refused stays text without errors, and becomes a page link next run", async (t) => {
  const { vault, notion, sync, pageNamed } = await setup(t);
  await writeTree(vault, { "A.md": "See [[B]]\n" });
  await sync();
  const a = pageNamed("A")!;
  await writeTree(vault, { "B.md": "The B note\n" });
  notion.createPage = async () => {
    notion.createPage = FakeNotion.prototype.createPage;
    throw new NotionPageError("validation_error", "refused");
  };
  const refused = await sync();
  assert.deepEqual(refused.summary!.skipped, [{ path: "B.md", reason: "validation_error: refused" }]);
  assert.deepEqual(refused.summary!.done, {});
  assert.equal(a.markdown, "See \\[\\[B\\]\\]");
  const next = await sync();
  assert.deepEqual(next.summary!.done, { createPage: 1, relink: 1 });
  assert.equal(a.markdown, `See [B](https://app.notion.com/p/${pageNamed("B")!.id.replace(/-/g, "")})`);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a Markdown link to a note that doesn't exist yet becomes a page link once the note has a page", async (t) => {
  const { vault, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "A.md": "See [Later](Later.md)\n" });
  await sync();
  const a = pageNamed("A")!;
  assert.equal(a.markdown, "See \\[\\[Later\\]\\]");
  await writeTree(vault, { "Later.md": "Later on\n" });
  const preview = await sync({ dryRun: true });
  assert.deepEqual(preview.plan.actions, [{ kind: "createPage", path: "Later.md" }, { kind: "relink", pageId: a.id }]);
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { createPage: 1, relink: 1 });
  assert.equal(a.markdown, `See [Later](https://app.notion.com/p/${pageNamed("Later")!.id.replace(/-/g, "")})`);
  assert.match(await read("A.md"), /\nSee \[Later\]\(Later\.md\)\n$/);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a hand-written link to no note keeps the folder in its text when its line is edited in Notion (final review)", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "A.md": "x [Folder/Missing](Folder/Missing.md) end\n" });
  await sync();
  const a = pageNamed("A")!;
  assert.equal(a.markdown, "x \\[\\[Folder/Missing\\|Folder/Missing\\]\\] end");
  notion.edit(a.id, { markdown: a.markdown.replace("end", "END") });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.match(await read("A.md"), /\nx \[Folder\/Missing\]\(Folder\/Missing\.md\) END\n$/);
  assert.deepEqual((await sync()).plan.actions, []);
});

// the relinked line is the note's own link translated, so later edits on that line place as edits.
for (const { name, target, title, file, typed, link } of [
  { name: "a plain link", target: "Later.md", title: "Later", file: "Later on\n", typed: "[[Later]]", link: "[Later](Later.md)" },
  { name: "a heading link into a folder", target: "Sub/Note.md", title: "Note", file: "# Part\n\ntext\n", typed: "[[Sub/Note#Part]]", link: "[Note › Part](Sub/Note.md#Part)" },
  { name: "a link to a note whose notion-title differs from its file name", target: "Soup- Tomato.md", title: "Soup: Tomato", file: '---\nnotion-title: "Soup: Tomato"\n---\nerrors\n', typed: "[[Soup- Tomato]]", link: "[Soup- Tomato](Soup-%20Tomato.md)" },
]) {
  test(`after a relink of ${name}, edits on its line in either app are placed as edits`, async (t) => {
    const { vault, notion, sync, read, pageNamed } = await setup(t);
    await writeTree(vault, { "A.md": `See ${typed} here\n\nOther\n` });
    await sync();
    const a = pageNamed("A")!;
    assert.ok((await read("A.md")).endsWith(`\nSee ${link} here\n\nOther\n`));
    await writeTree(vault, { [target]: file });
    assert.deepEqual((await sync()).summary!.done, { createPage: 1, relink: 1 });
    const url = `https://app.notion.com/p/${pageNamed(title)!.id.replace(/-/g, "")}`;
    const text = link.slice(1, link.indexOf("]("));
    assert.equal(a.markdown, `See [${text}](${url}) here\nOther`);
    assert.deepEqual((await sync()).plan.actions, []);
    // Edited in Notion on the link's line: pulled into the note's line.
    notion.edit(a.id, { markdown: a.markdown.replace(" here", " here, edited in Notion") });
    const pulled = await sync();
    assert.deepEqual(pulled.summary!.done, { pull: 1 });
    assert.deepEqual([pulled.summary!.skipped, pulled.summary!.rewritten], [[], []]);
    assert.ok((await read("A.md")).endsWith(`\nSee ${link} here, edited in Notion\n\nOther\n`));
    // Edited in Obsidian on the link's line: placed on the page's line, not a whole rewrite.
    await writeFile(join(vault, "A.md"), (await read("A.md")).replace("edited in Notion", "then in Obsidian"));
    const pushed = await sync();
    assert.deepEqual(pushed.summary!.done, { push: 1 });
    assert.deepEqual([pushed.summary!.skipped, pushed.summary!.rewritten], [[], []]);
    assert.equal(a.markdown, `See [${text}](${url}) here, then in Obsidian\nOther`);
    assert.deepEqual((await sync()).plan.actions, []);
  });
}

// --- Final review, second round ---------------------------------------------------------------------------

/** A sync whose clock does `act` (by default, a power cut) as soon as "A linker.md" holds `link` (`at`). */
async function cutAfterRewrite(t: import("node:test").TestContext) {
  const vault = join(await tempDir(t), "a", "vault");
  await mkdir(vault, { recursive: true });
  const state = await tempDir(t);
  let clock = Date.parse("2026-09-27T10:00:00Z");
  let cutAt: string | null = null;
  let act: () => void = () => {
    throw new Error("power cut");
  };
  const now = () => {
    if (cutAt !== null && readFileSync(join(vault, "A linker.md"), "utf8").includes(cutAt)) {
      cutAt = null;
      act();
    }
    return new Date(clock);
  };
  const notion = new FakeNotion(() => new Date(clock));
  const config: Config = { profile: "test", vaultPath: vault, vaultName: "DemoVault", dataSourceId: "a50245e9-8e6a-41aa-8ccf-d8795ed0dead", titleProperty: "Name", linksToProperty: "Links to", projectsRelation: null, pageIcon: null, ignoredKeys: [], inboxFolder: "0-In", massTrashLimit: 10, tokenFile: null, stateDir: state };
  const sync = (dryRun = false) => {
    clock += 5 * 60_000;
    return runSync({ config, notion, dryRun, yes: true, allowMassTrash: false, now, log: () => {} });
  };
  const cut = (link: string, then?: () => void) => {
    cutAt = link;
    if (then) act = then;
  };
  const read = (path: string) => readFile(join(vault, path), "utf8");
  const page = (title: string) => [...notion.pages.values()].find((p) => p.title === title && !p.inTrash)!;
  /** The names a page is known by until its note moves, as its record keeps them. */
  const aliases = async (id: string) => (JSON.parse(await readFile(join(state, "records", `${id}.json`), "utf8")) as { aliases?: string[] }).aliases ?? [];
  return { vault, notion, sync, cut, read, page, aliases };
}

test("a rename in Notion cut off while it rewrites links, then renamed again, leaves no link dangling or turned into text", async (t) => {
  const s = await cutAfterRewrite(t);
  await writeTree(s.vault, { "Target.md": "target\n", "A linker.md": "see [[Target]]\n", "B linker.md": "and [[Target]]\n" });
  await s.sync();
  const target = s.page("Target");
  s.notion.edit(target.id, { title: "Renamed" });
  s.cut("(Renamed.md)");
  await assert.rejects(s.sync(), /power cut/);
  s.notion.edit(target.id, { title: "Second" });
  await s.sync();
  // The text the cut-off run gave A's link (Renamed) follows the second rename too, as B's old title does.
  assert.match(await s.read("A linker.md"), /see \[Second\]\(Second\.md\)\n$/);
  assert.match(await s.read("B linker.md"), /and \[Second\]\(Second\.md\)\n$/);
  assert.match(await s.read("Second.md"), /target/);
  // A page link to the target, with the new text pushed (Notion keeps a page link's text, live probe).
  const url = `https://app.notion.com/p/${target.id.replace(/-/g, "")}`;
  assert.equal(s.page("A linker").markdown, `see [Second](${url})`);
  assert.equal(s.page("B linker").markdown, `and [Second](${url})`);
  // An edit made later still pushes the page link, not the old name as text.
  await writeFile(join(s.vault, "A linker.md"), (await s.read("A linker.md")).replace("see", "now see"));
  await s.sync();
  assert.equal(s.page("A linker").markdown, `now see [Second](${url})`);
  assert.deepEqual((await s.sync()).plan.actions, []);
});

test("a move whose new name another file takes during the run puts the links it rewrote back", async (t) => {
  const s = await cutAfterRewrite(t);
  await writeTree(s.vault, { "Target.md": "target\n", "A linker.md": "see [[Target]]\n" });
  await s.sync();
  s.notion.edit(s.page("Target").id, { title: "Renamed" });
  // The file appears right after the links were rewritten, before the note moves.
  s.cut("(Renamed.md)", () => writeFileSync(join(s.vault, "Renamed.md"), "someone else's note\n"));
  const linker = s.page("A linker").markdown;
  const outcome = await s.sync();
  assert.deepEqual(reasons(outcome), ["path_taken"]);
  // The link's text goes back too, and its page, never pushed, keeps the text it had.
  assert.match(await s.read("A linker.md"), /see \[Target\]\(Target\.md\)\n$/);
  assert.equal(outcome.summary!.done.push, undefined);
  assert.equal(s.page("A linker").markdown, linker);
  assert.equal(await s.read("Renamed.md"), "someone else's note\n");
  assert.match(await s.read("Target.md"), /target/);
});

test("a note renamed from Notion also renames its links to itself, as Obsidian does", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "Target.md": "# Top\n\nBack to [[Target#Top|the top]] and [[Target]]\n" });
  await sync();
  notion.edit(pageNamed("Target")!.id, { title: "Renamed" });
  assert.deepEqual((await sync()).summary!.done, { moveInVault: 1, push: 1 });
  assert.match(await read("Renamed.md"), /Back to \[the top\]\(Renamed\.md#Top\) and \[Renamed\]\(Renamed\.md\)\n$/);
  assert.match(pageNamed("Renamed")!.markdown, new RegExp(`and \\[Renamed\\]\\(https://app\\.notion\\.com/p/${pageNamed("Renamed")!.id.replace(/-/g, "")}\\)$`));
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a relink waits when the page changed during the run, even only in how its lines nest", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "A.md": "- see [[B]]\n- second item\n" });
  await sync();
  await sync();
  const a = pageNamed("A")!;
  await writeTree(vault, { "B.md": "The B note\n" });
  // Nested in Notion after this run read the page, before the relink reads it again.
  let reads = 0;
  notion.getMarkdown = async (id) => {
    if (id === a.id && ++reads === 1) notion.edit(a.id, { markdown: a.markdown.replace("- second item", "\t- second item") });
    return FakeNotion.prototype.getMarkdown.call(notion, id);
  };
  const outcome = await sync();
  assert.deepEqual(reasons(outcome), ["changed_in_notion"]);
  notion.getMarkdown = FakeNotion.prototype.getMarkdown;
  const next = await sync();
  assert.deepEqual(next.summary!.done, { pull: 1, relink: 1 });
  assert.match(await read("A.md"), /- see \[B\]\(B\.md\)\n\t- second item\n$/);
  assert.match(pageNamed("A")!.markdown, /^- see \[B\]\(https:\/\/app\.notion\.com\/p\/[^)]+\)\n\t- second item$/);
  assert.deepEqual((await sync()).plan.actions, []);
});

// --- Final review, third round N5: record aliases end with the move they belong to ---------------------------

test("an Obsidian rename after a rename from Notion was cut off ends it: the links it rewrote follow the note, and its name goes", async (t) => {
  const s = await cutAfterRewrite(t);
  await writeTree(s.vault, { "Target.md": "target\n", "A linker.md": "see [[Target]]\n" });
  await s.sync();
  const target = s.page("Target");
  s.notion.edit(target.id, { title: "Renamed" });
  s.cut("(Renamed.md)");
  await assert.rejects(s.sync(), /power cut/);
  assert.deepEqual(await s.aliases(target.id), ["Renamed.md"]);
  // Obsidian's name wins over Notion's.
  await rename(join(s.vault, "Target.md"), join(s.vault, "Mine.md"));
  const outcome = await s.sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  // The text the cut-off run gave the link (Renamed) follows Obsidian's name, in the vault and on the page.
  assert.match(await s.read("A linker.md"), /see \[Mine\]\(Mine\.md\)\n$/);
  const url = (id: string) => `https://app.notion.com/p/${id.replace(/-/g, "")}`;
  assert.equal(s.page("A linker").markdown, `see [Mine](${url(target.id)})`);
  assert.equal(s.notion.pages.get(target.id)!.title, "Mine");
  assert.deepEqual(await s.aliases(target.id), []);
  // A note named like the old alias, and a link to it, later: the link means that note.
  await mkdir(join(s.vault, "Sub"), { recursive: true });
  await writeTree(s.vault, { "Sub/Renamed.md": "the new note\n", "C.md": "points at [[Renamed]]\n" });
  await s.sync();
  assert.equal(s.page("C").markdown, `points at [Renamed](${url(s.page("Renamed").id)})`);
  assert.deepEqual((await s.sync()).plan.actions, []);
});

test("a name kept for a cut-off move never wins over a real note a link can mean", async (t) => {
  const s = await cutAfterRewrite(t);
  await writeTree(s.vault, { "Target.md": "target\n", "A linker.md": "see [[Target]]\n" });
  await s.sync();
  const target = s.page("Target");
  s.notion.edit(target.id, { title: "Renamed" });
  s.cut("(Renamed.md)");
  await assert.rejects(s.sync(), /power cut/);
  // Before the next run, a note of that name appears elsewhere, and a new note links it.
  await mkdir(join(s.vault, "Sub"), { recursive: true });
  await writeTree(s.vault, { "Sub/Renamed.md": "the new note\n", "C.md": "points at [[Renamed]]\n" });
  await s.sync();
  // Both pages are titled Renamed now: the link means the new note's.
  const other = [...s.notion.pages.values()].find((p) => p.title === "Renamed" && p.id !== target.id)!;
  assert.equal(s.page("C").markdown, `points at [Renamed](https://app.notion.com/p/${other.id.replace(/-/g, "")})`);
});

test("a move whose name another file takes during the run drops that name, and a rename Notion takes back ends the names a cut-off run kept", async (t) => {
  // The taken name: the links go back and the record keeps no alias.
  const taken = await cutAfterRewrite(t);
  await writeTree(taken.vault, { "Target.md": "target\n", "A linker.md": "see [[Target]]\n" });
  await taken.sync();
  const target = taken.page("Target");
  taken.notion.edit(target.id, { title: "Renamed" });
  taken.cut("(Renamed.md)", () => writeFileSync(join(taken.vault, "Renamed.md"), "someone else's note\n"));
  assert.deepEqual(reasons(await taken.sync()), ["path_taken"]);
  assert.match(await taken.read("A linker.md"), /see \[Target\]\(Target\.md\)\n$/);
  assert.deepEqual(await taken.aliases(target.id), []);
  // Notion's title goes back after a cut-off run: no move happens, and the links it rewrote go back.
  const back = await cutAfterRewrite(t);
  await writeTree(back.vault, { "Target.md": "target\n", "A linker.md": "see [[Target]]\n" });
  await back.sync();
  const page = back.page("Target");
  back.notion.edit(page.id, { title: "Renamed" });
  back.cut("(Renamed.md)");
  await assert.rejects(back.sync(), /power cut/);
  back.notion.edit(page.id, { title: "Target" });
  const outcome = await back.sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.match(await back.read("A linker.md"), /see \[Target\]\(Target\.md\)\n$/);
  assert.equal(back.page("A linker").markdown, `see [Target](https://app.notion.com/p/${page.id.replace(/-/g, "")})`);
  assert.match(await back.read("Target.md"), /target/);
  assert.deepEqual(await back.aliases(page.id), []);
  assert.deepEqual((await back.sync()).plan.actions, []);
});

test("ending a rename from Notion cut short shows in the plan, so in a dry run, and in the summary (final review, fourth round P4)", async (t) => {
  const s = await cutAfterRewrite(t);
  await writeTree(s.vault, { "Target.md": "target\n", "A linker.md": "see [[Target]]\n" });
  await s.sync();
  const target = s.page("Target");
  s.notion.edit(target.id, { title: "Renamed" });
  s.cut("(Renamed.md)");
  await assert.rejects(s.sync(), /power cut/);
  await rename(join(s.vault, "Target.md"), join(s.vault, "Mine.md"));
  const preview = await s.sync(true);
  assert.ok(preview.plan.actions.some((action) => action.kind === "endRename" && action.pageId === target.id));
  assert.match(formatPlan(preview.plan, preview.notes, preview.pages), /\n {2}rewrite the links that use an unfinished rename's name to Mine\.md\n/);
  assert.match(await s.read("A linker.md"), /see \[Renamed\]\(Renamed\.md\)\n$/, "a dry run changes nothing");
  const outcome = await s.sync();
  assert.equal(outcome.summary!.done.endRename, 1);
  assert.match(formatSummary(outcome.summary!, outcome.plan), /1 × unfinished rename finished by rewriting the links that used its name\n/);
  assert.match(await s.read("A linker.md"), /see \[Mine\]\(Mine\.md\)\n$/);
  assert.equal(s.page("A linker").markdown, `see [Mine](https://app.notion.com/p/${target.id.replace(/-/g, "")})`);
  assert.deepEqual((await s.sync()).plan.actions, []);
});

// --- Markdown links: each run converts [[links]] in the vault ---------------------------------------------

test("each run converts [[links]] in the vault before planning, and never changes them back", async (t) => {
  const { vault, state, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "A.md": "See [[B]] and [[B|bee]]\n", "B.md": "Bee\n" });
  const body = async (path: string) => (await read(path)).replace(/^---\n[\s\S]*?\n---\n/, "");

  // The dry run lists the conversion and writes nothing.
  const preview = await sync({ dryRun: true });
  assert.deepEqual(preview.plan.actions[0], { kind: "convertLinks", path: "A.md", text: "See [B](B.md) and [bee](B.md)\n", links: 2 });
  assert.match(formatPlan(preview.plan, preview.notes, preview.pages), /^ {2}convert \[\[links\]\] to Markdown links in A\.md \(2 links\)$/m);
  assert.equal(await read("A.md"), "See [[B]] and [[B|bee]]\n");
  assert.equal(notion.pages.size, 0);

  // The first run writes the converted note, and its page holds page links.
  const first = await sync();
  assert.deepEqual(first.plan.actions, preview.plan.actions);
  assert.equal(first.summary!.done.convertLinks, 1);
  assert.match(formatSummary(first.summary!, first.plan), /^ {2}1 × note's \[\[links\]\] converted to Markdown links$/m);
  assert.equal(await body("A.md"), "See [B](B.md) and [bee](B.md)\n");
  // Written like any vault write: the note as it was is in the run's backups.
  const [run] = await readdir(join(state, "backups"));
  assert.equal(await readFile(join(state, "backups", run!, "A.md"), "utf8"), "See [[B]] and [[B|bee]]\n");
  const url = `https://app.notion.com/p/${pageNamed("B")!.id.replace(/-/g, "")}`;
  assert.equal(pageNamed("A")!.markdown, `See [B](${url}) and [bee](${url})`);

  // Nothing is left to do.
  assert.deepEqual((await sync()).plan.actions, []);

  // A link's text edited in Obsidian is pushed as written, never "fixed" back to the title.
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("[bee]", "[the bee]"));
  const edited = await sync();
  assert.deepEqual(edited.plan.actions, [{ kind: "push", pageId: pageNamed("A")!.id }]);
  assert.equal(pageNamed("A")!.markdown, `See [B](${url}) and [the bee](${url})`);
  assert.equal(await body("A.md"), "See [B](B.md) and [the bee](B.md)\n");
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a heading link still written [[Elm#Bark|text]], on a line edited in Notion, keeps its heading", async (t) => {
  const { vault, state, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "Elm.md": "# Bark\n\nAllow\n", "Doc.md": "Read the bark notes first\n\nOther line\n" });
  await sync();
  const doc = pageNamed("Doc")!;
  const elm = `https://app.notion.com/p/${pageNamed("Elm")!.id.replace(/-/g, "")}`;
  // A note synced before conversion existed: the note and its record hold the [[ ]] form; the page a page link.
  const old = (await read("Doc.md")).replace("the bark notes", "[[Elm#Bark|the bark notes]]");
  await writeFile(join(vault, "Doc.md"), old);
  const recordFile = join(state, "records", `${doc.id}.json`);
  const record = JSON.parse(await readFile(recordFile, "utf8")) as { obsidianText: string; notionMarkdown: string };
  record.obsidianText = old;
  record.notionMarkdown = `Read [the bark notes](${elm}) first\nOther line`;
  await writeFile(recordFile, JSON.stringify(record));
  notion.edit(doc.id, { markdown: `Read [the bark notes](${elm}) first, edited in Notion\nOther line` });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual(outcome.summary!.conflicts, []);
  assert.match(await read("Doc.md"), /^Read \[the bark notes\]\(Elm\.md#Bark\) first, edited in Notion$/m);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("the note of a page too large to read is not converted either: it is left alone this run", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "Big.md": "big\n", "B.md": "Bee\n" });
  await sync();
  const typed = (await read("Big.md")).replace("big", "big, see [[B]]");
  await writeFile(join(vault, "Big.md"), typed);
  notion.edit(pageNamed("Big")!.id, { truncated: true, markdown: "partial" });
  const outcome = await sync();
  assert.deepEqual(outcome.plan.actions, []);
  assert.equal(await read("Big.md"), typed);
});

test("the note of a page too large to read is not converted even when it lost its notion-id", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "Big.md": "big\n", "B.md": "Bee\n" });
  await sync();
  await writeFile(join(vault, "Big.md"), "big, see [[B]]\n");
  notion.edit(pageNamed("Big")!.id, { truncated: true, markdown: "partial" });
  const outcome = await sync();
  assert.deepEqual(outcome.plan.actions, []);
  assert.equal(await read("Big.md"), "big, see [[B]]\n");
});

// --- Markdown links: renames rewrite link text that was the old title (design §6.4) -------------------------

test("a rename in Notion rewrites the text of links that read the old title, in the vault and on their pages, in the same run", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "A.md": "See [[B]] and [[B|bee]]\n", "B.md": "Bee\n" });
  await sync();
  const b = pageNamed("B")!;
  notion.edit(b.id, { title: "Bee note" });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { moveInVault: 1, push: 1 });
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual(outcome.summary!.rewritten, []);
  assert.equal((await read("A.md")).replace(/^---\n[\s\S]*?\n---\n/, ""), "See [Bee note](Bee%20note.md) and [bee](Bee%20note.md)\n");
  const url = `https://app.notion.com/p/${b.id.replace(/-/g, "")}`;
  assert.equal(pageNamed("A")!.markdown, `See [Bee note](${url}) and [bee](${url})`);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a rename in Notion gives links in a folder the shortest path to the note, as conversion and Obsidian write it", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "Dir/A.md": "See [[B]] and [[B#Part|part]]\n", "Dir/B.md": "Bee\n", "Other/C.md": "[[Dir/B]]\n" });
  await sync();
  notion.edit(pageNamed("B")!.id, { title: "Bee note" });
  await sync();
  const body = (path: string) => read(path).then((text) => text.replace(/^---\n[\s\S]*?\n---\n/, ""));
  assert.equal(await body("Dir/A.md"), "See [Bee note](Bee%20note.md) and [part](Bee%20note.md#Part)\n");
  assert.equal(await body("Other/C.md"), "[Bee note](Bee%20note.md)\n");
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a note moved to another project in Notion keeps the folder in the links that tell it from its twin", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t, false, true);
  await writeTree(vault, { "Dir/A.md": "See [[B]] and [[B#Part|part]]\n", "Dir/B.md": "Bee\n", "Other/C.md": "[[Dir/B]]\n" });
  await sync();
  notion.edit(pageNamed("B")!.id, { title: "Bee note" });
  await sync();
  const body = (path: string) => read(path).then((text) => text.replace(/^---\n[\s\S]*?\n---\n/, ""));
  assert.equal(await body("Dir/A.md"), "See [Bee note](Bee%20note.md) and [part](Bee%20note.md#Part)\n");
  // A note that shares its name with another one keeps the folder that tells them apart (a rename never makes a
  // shared name: it picks "Name (2)"), from every folder but its own.
  const bee = pageNamed("Bee note")!.id;
  await writeTree(vault, { "X/Bee note.md": "twin\n", "Other/D.md": "[[Dir/Bee note|Bee note]]\n" });
  await sync();
  notion.edit(bee, { projects: [notion.addProject("Aa")] });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.equal(await body("Other/D.md"), "[Bee note](Aa/Bee%20note.md)\n");
  assert.equal(await body("Dir/A.md"), "See [Bee note](Aa/Bee%20note.md) and [part](Aa/Bee%20note.md#Part)\n");
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a rename in Obsidian rewrites the text of links that read the old title, after Obsidian updated their destinations", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "A.md": "See [[B]] and [[B|bee]]\n", "B.md": "Bee\n" });
  await sync();
  const b = pageNamed("B")!;
  // Obsidian renames the file and updates the links' destinations, not their text.
  await rename(join(vault, "B.md"), join(vault, "C.md"));
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("See [B](B.md) and [bee](B.md)", "See [B](C.md) and [bee](C.md)"));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual(outcome.summary!.rewritten, []);
  assert.deepEqual(outcome.summary!.done, { push: 2, renameInNotion: 1 });
  assert.equal((await read("A.md")).replace(/^---\n[\s\S]*?\n---\n/, ""), "See [C](C.md) and [bee](C.md)\n");
  assert.equal(notion.pages.get(b.id)!.title, "C");
  const url = `https://app.notion.com/p/${b.id.replace(/-/g, "")}`;
  assert.equal(pageNamed("A")!.markdown, `See [C](${url}) and [bee](${url})`);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a note whose pull the run skipped gets its links' new text in the vault, but its page isn't pushed over Notion's edit", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "Physics.md": "Energy, see [[B]]:\n\n$$ E = mc^2 $$\n\n*   done\n", "B.md": "Bee\n" });
  await sync();
  const physics = pageNamed("Physics")!;
  // Notion's edit can't be placed on the note (a rewrite would lose its formatting), so its pull is skipped.
  const edited = physics.markdown.replace("mc^2", "mc^3");
  notion.edit(physics.id, { markdown: edited });
  notion.edit(pageNamed("B")!.id, { title: "Bee note" });
  const outcome = await sync();
  assert.deepEqual(reasons(outcome), ["not_matched"]);
  assert.deepEqual(outcome.summary!.done, { moveInVault: 1 });
  assert.match(await read("Physics.md"), /Energy, see \[Bee note\]\(Bee%20note\.md\):/);
  assert.equal(notion.pages.get(physics.id)!.markdown, edited);
});

test("a rename in Notion that keeps the file name (only its case changes) still gives links that read the old title the new one", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "A.md": "See [[target]] and [[target|it]]\n", "target.md": "target\n" });
  await sync();
  const target = pageNamed("target")!;
  notion.edit(target.id, { title: "Target" });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { moveInVault: 1, push: 1 });
  assert.match(await read("target.md"), /notion-title: Target\n/);
  assert.equal((await read("A.md")).replace(/^---\n[\s\S]*?\n---\n/, ""), "See [Target](target.md) and [it](target.md)\n");
  const url = `https://app.notion.com/p/${target.id.replace(/-/g, "")}`;
  assert.equal(pageNamed("A")!.markdown, `See [Target](${url}) and [it](${url})`);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("an edit on a line holding page links, in either app, changes only that line on the other side (Markdown links design §6.6)", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  const doc = "See [[Target]] here\n\nAlso [the other](Other.md) there\n\nThen [[Target|custom text]] and [[Other]] last\n\nPlain line\n";
  await writeTree(vault, { "Target.md": "target\n", "Other.md": "other\n", "Doc.md": doc });
  await sync();
  const page = pageNamed("Doc")!;
  const url = (title: string) => `https://app.notion.com/p/${pageNamed(title)!.id.replace(/-/g, "")}`;
  const note = await read("Doc.md");
  const lines = page.markdown.split("\n");
  assert.deepEqual(lines, [`See [Target](${url("Target")}) here`, `Also [the other](${url("Other")}) there`, `Then [custom text](${url("Target")}) and [Other](${url("Other")}) last`, "Plain line"]);

  // An Obsidian edit next to a link, and one to a link's text (visible text, so a change): only those lines change in Notion.
  await writeFile(join(vault, "Doc.md"), note.replace(" here", " here, edited in Obsidian").replace("[the other]", "[another one]"));
  notion.calls.length = 0;
  assert.deepEqual((await sync()).summary!.done, { push: 1 });
  assert.ok(notion.calls.includes(`updateContent ${page.id}`) && !notion.calls.includes(`replaceContent ${page.id}`), "placed line by line");
  const pushed = [`${lines[0]}, edited in Obsidian`, lines[1]!.replace("[the other]", "[another one]"), lines[2]!, lines[3]!];
  assert.equal(pageNamed("Doc")!.markdown, pushed.join("\n"));

  // A Notion edit next to a link, and one to a link's text: only those lines change in the note, keeping its links' forms.
  notion.edit(page.id, { markdown: [pushed[0], pushed[1], pushed[2]!.replace(" last", " last, edited in Notion").replace("[custom text]", "[new text]"), pushed[3]].join("\n") });
  assert.deepEqual((await sync()).summary!.done, { pull: 1 });
  const pulled = await read("Doc.md");
  assert.equal(pulled.replace(/^---\n[\s\S]*?\n---\n/, ""), "See [Target](Target.md) here, edited in Obsidian\n\nAlso [another one](Other.md) there\n\nThen [new text](Target.md) and [Other](Other.md) last, edited in Notion\n\nPlain line\n");
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a mention typed in Notion next to an edited line comes in as a Markdown link, and stays a mention after a later Obsidian edit (Markdown links design §6.2)", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "A.md": "first\n\nsecond\n\nthird\n", "B.md": "b\n" });
  await sync();
  const a = pageNamed("A")!;
  const mention = `Ask <mention-page url="https://app.notion.com/p/${pageNamed("B")!.id.replace(/-/g, "")}"/> now`;
  notion.edit(a.id, { markdown: a.markdown.replace("first\nsecond", `first\n${mention}\nsecond, edited in Notion`) });
  assert.deepEqual((await sync()).summary!.done, { pull: 1 });
  assert.equal((await read("A.md")).replace(/^---\n[\s\S]*?\n---\n/, ""), "first\n\nAsk [B](B.md) now\n\nsecond, edited in Notion\n\nthird\n");
  assert.deepEqual((await sync()).plan.actions, []);

  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("third", "third, edited in Obsidian"));
  notion.calls.length = 0;
  assert.deepEqual((await sync()).summary!.done, { push: 1 });
  assert.ok(notion.calls.includes(`updateContent ${a.id}`) && !notion.calls.includes(`replaceContent ${a.id}`), "placed line by line");
  assert.equal(pageNamed("A")!.markdown, `first\n${mention}\nsecond, edited in Notion\nthird, edited in Obsidian`);
  assert.deepEqual((await sync()).plan.actions, []);
});

// Notion splits such a link on the first write (confirmed live, a recorded live run).
test("a line holding a link Notion splits (text partly bold, or partly code: confirmed live) takes edits from either app line by line", async (t) => {
  for (const link of ["[a **b** c](Target.md)", "[`__slots__` attribute](Target.md)"]) {
    const { vault, notion, sync, read, pageNamed } = await setup(t);
    await writeTree(vault, { "Target.md": "target\n", "Doc.md": `See ${link} here\n\nOther line\n` });
    await sync();
    const page = pageNamed("Doc")!;
    // Notion holds the link as one link per run of its text.
    assert.match(page.markdown, /^See (\[[^\]]+\]\(https:\/\/app\.notion\.com\/p\/[0-9a-f]{32}\)){2,} here\nOther line$/, link);
    const body = async () => (await read("Doc.md")).replace(/^---\n[\s\S]*?\n---\n/, "");

    // A Notion edit on that line pulls cleanly, the note keeping its link as written.
    notion.edit(page.id, { markdown: page.markdown.replace(" here", " here, edited in Notion") });
    const pulled = await sync();
    assert.deepEqual(pulled.summary!.done, { pull: 1 }, link);
    assert.deepEqual([pulled.summary!.skipped, pulled.summary!.rewritten], [[], []], link);
    assert.equal(await body(), `See ${link} here, edited in Notion\n\nOther line\n`, link);
    assert.deepEqual((await sync()).plan.actions, [], link);

    // An Obsidian edit on that line is placed on it, line by line.
    const before = pageNamed("Doc")!.markdown;
    await writeFile(join(vault, "Doc.md"), (await read("Doc.md")).replace("edited in Notion", "edited in Notion, then in Obsidian"));
    notion.calls.length = 0;
    const pushed = await sync();
    assert.deepEqual(pushed.summary!.done, { push: 1 }, link);
    assert.deepEqual([pushed.summary!.skipped, pushed.summary!.rewritten], [[], []], link);
    assert.ok(notion.calls.includes(`updateContent ${page.id}`) && !notion.calls.includes(`replaceContent ${page.id}`), link);
    assert.equal(pageNamed("Doc")!.markdown.split("\n")[0], before.split("\n")[0]!.replace("edited in Notion", "edited in Notion, then in Obsidian"), link);
    assert.equal(await body(), `See ${link} here, edited in Notion, then in Obsidian\n\nOther line\n`, link);
    assert.deepEqual((await sync()).plan.actions, [], link);
  }
});

const pageLink = (id: string) => `[page](https://app.notion.com/p/${id.replace(/-/g, "")})`;

test("a database without the Links to property is synced as before, with one line saying so", async (t) => {
  const { vault, notion, sync } = await setup(t);
  await writeTree(vault, { "A.md": "to [[B]]\n", "B.md": "b\n" });
  const lines: string[] = [];
  const outcome = await sync({ log: (line) => lines.push(line) });
  assert.deepEqual(outcome.summary!.done, { convertLinks: 1, createPage: 2 });
  assert.deepEqual(lines, ['note: the database has no "Links to" property; the Links to relation is left alone']);
  assert.deepEqual(notion.calls.filter((c) => c.startsWith("readRelation") || c.startsWith("setRelation")), []);
  assert.equal(outcome.summary!.linksTo, 0);
});

test("a profile with linksToProperty null never touches Links to, even if the database has one", async (t) => {
  const { vault, notion, sync, config } = await setup(t);
  notion.addLinksTo();
  await writeTree(vault, { "A.md": "to [[B]]\n", "B.md": "b\n" });
  const lines: string[] = [];
  config.linksToProperty = null;
  const outcome = await sync({ log: (line) => lines.push(line) });
  assert.deepEqual(outcome.summary!.done, { convertLinks: 1, createPage: 2 });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^note: "linksToProperty" is null/);
  assert.deepEqual(notion.calls.filter((c) => c.startsWith("readRelation") || c.startsWith("setRelation") || c.startsWith("relationTarget")), []);
  assert.equal(outcome.summary!.linksTo, 0);
});

test("a Links to property that is not a relation to the database itself stops the run before anything changes", async (t) => {
  for (const make of [(n: FakeNotion) => n.schema.set("Links to", "rich_text"), (n: FakeNotion) => (n.addLinksTo(), (n.dataSourceId = "other-database"))]) {
    const { vault, notion, sync, read } = await setup(t);
    make(notion);
    await writeTree(vault, { "A.md": "text\n" });
    for (const extra of [{}, { dryRun: true }]) {
      await assert.rejects(sync(extra), /the database's "Links to" property is not a relation to the database itself: .*Nothing was changed\.$/);
    }
    assert.equal(notion.pages.size, 0);
    assert.equal(await read("A.md"), "text\n");
  }
});

test("the relation is filled after the run and kept through an Obsidian edit", async (t) => {
  const { vault, state, notion, sync, read, pageNamed } = await setup(t);
  notion.addLinksTo();
  await writeTree(vault, { "A.md": "to [[B]]\n", "B.md": "b\n" });
  // The pages are created during this run, so they are not in its listing: the next run fills them.
  const first = await sync();
  const [a, b] = [pageNamed("A")!, pageNamed("B")!];
  assert.equal(first.summary!.linksTo, 0);
  assert.equal(a.linksTo, undefined);
  const filled = await sync();
  assert.equal(filled.summary!.linksTo, 1);
  assert.deepEqual(a.linksTo, [b.id]);
  const stored = () => JSON.parse(readFileSync(join(state, "records", `${a.id}.json`), "utf8")) as { linksTo?: string[] };
  assert.deepEqual(stored().linksTo, [b.id]);

  // An Obsidian edit pushes the note; the record keeps what the sync added.
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("to ", "now to "));
  const second = await sync();
  assert.deepEqual(second.summary!.done, { push: 1 });
  assert.deepEqual(stored().linksTo, [b.id]);
  assert.deepEqual(a.linksTo, [b.id]);
  assert.equal(second.summary!.linksTo, 0);

  // Nothing changed: no relation request at all.
  notion.calls.length = 0;
  await sync();
  assert.deepEqual(notion.calls.filter((c) => c.startsWith("readRelation") || c.startsWith("setRelation")), []);
});

test("a note deleted in Obsidian, linked to by another page, is not put in that page's relation", async (t) => {
  const { vault, notion, sync, pageNamed } = await setup(t);
  notion.addLinksTo();
  await writeTree(vault, { "A.md": "to [[B]] and [[C]]\n", "B.md": "b\n", "C.md": "c\n" });
  await sync();
  await sync();
  const [a, b, c] = [pageNamed("A")!, pageNamed("B")!, pageNamed("C")!];
  assert.deepEqual(a.linksTo, [b.id, c.id]);
  notion.edit(a.id, { linksTo: [] }); // the user emptied it, so this run has to write it again
  await rm(join(vault, "B.md"));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { trashPage: 1 });
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.equal(b.inTrash, true);
  assert.deepEqual(a.linksTo, [c.id]);
});

test("a dry run lists the pages whose relation would change and writes nothing", async (t) => {
  const { vault, notion, sync, pageNamed } = await setup(t);
  notion.addLinksTo();
  await writeTree(vault, { "A.md": "to [[B]]\n", "B.md": "b\n" });
  await sync();
  const c = notion.add("C", "c");
  await sync();
  const [a, b] = [pageNamed("A")!, pageNamed("B")!];
  notion.edit(a.id, { markdown: `${pageLink(b.id)} and ${pageLink(c)}` });
  notion.calls.length = 0;
  const lines: string[] = [];
  const outcome = await sync({ dryRun: true, log: (line) => lines.push(line) });
  assert.equal(outcome.summary, null);
  // The lines go to the caller, to print after the plan; nothing is logged during the run.
  assert.deepEqual(lines, []);
  assert.deepEqual(outcome.linksToPreview, ["Links to would be set on 1 page (estimated from the text read this run):", "  A.md"]);
  assert.deepEqual(notion.calls.filter((c) => c.startsWith("setRelation")), []);
  assert.deepEqual(a.linksTo, [b.id]);
});

test("P2: a hub linking more than 25 notes: once its relation is set, a dry run says nothing would be set", async (t) => {
  const { vault, notion, sync, pageNamed } = await setup(t);
  notion.addLinksTo();
  const files: Record<string, string> = { "Hub.md": Array.from({ length: 30 }, (_, n) => `- [[N${n}]]`).join("\n") + "\n" };
  for (let n = 0; n < 30; n++) files[`N${n}.md`] = "n\n";
  await writeTree(vault, files);
  await sync();
  await sync();
  assert.equal(pageNamed("Hub")!.linksTo!.length, 30);
  assert.equal((await sync({ dryRun: true })).linksToPreview, null);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a dry run says pages when several would change, and nothing when none would", async (t) => {
  const { vault, notion, sync, pageNamed } = await setup(t);
  notion.addLinksTo();
  await writeTree(vault, { "A.md": "to [[B]]\n", "B.md": "b\n" });
  await sync();
  assert.equal((await sync({ dryRun: true })).linksToPreview?.length, 2);
  const filled = await sync();
  assert.equal(filled.summary!.linksTo, 1);
  assert.equal((await sync({ dryRun: true })).linksToPreview, null);
  const [a, b] = [pageNamed("A")!, pageNamed("B")!];
  notion.edit(a.id, { linksTo: [] });
  notion.edit(b.id, { markdown: pageLink(a.id) });
  const outcome = await sync({ dryRun: true });
  assert.deepEqual(outcome.linksToPreview, ["Links to would be set on 2 pages (estimated from the text read this run):", "  A.md", "  B.md"]);
});

test("a page the run skipped and a page too large to read get no relation request in that run", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  notion.addLinksTo();
  await writeTree(vault, { "A.md": "to [[B]]\n", "Big.md": "to [[B]]\n", "B.md": "b\n" });
  await sync();
  await sync();
  const [a, big, b] = [pageNamed("A")!, pageNamed("Big")!, pageNamed("B")!];
  assert.deepEqual([a.linksTo, big.linksTo], [[b.id], [b.id]]);
  // The user emptied both relations; A's push is refused and Big is too large to read.
  notion.edit(a.id, { linksTo: [] });
  notion.edit(big.id, { linksTo: [], truncated: true });
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("to ", "now to "));
  for (const method of ["updateContent", "replaceContent"] as const) {
    const original = notion[method].bind(notion);
    notion[method] = async (id: string, ...rest: never[]) => {
      if (id === a.id) throw new NotionPageError("validation_error", "refused");
      return (original as (id: string, ...rest: never[]) => Promise<never>)(id, ...rest);
    };
  }
  notion.calls.length = 0;
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped.map((s) => s.reason.split(":")[0]).sort(), ["truncated", "validation_error"]);
  assert.deepEqual(notion.calls.filter((c) => /^(read|set)Relation /.test(c) && (c.includes(a.id) || c.includes(big.id))), []);
  assert.deepEqual([a.linksTo, big.linksTo], [[], []]);
});

// Images pasted in Notion (spec §5.3, §5.6, §5.9, §5.11, §5.14).
const FOLDER = "Assets/pictures";
const app = { ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: FOLDER }) };
const pic = (...values: number[]) => Uint8Array.from(values);
const hostedLine = (markdown: string) => markdown.split("\n").find((l) => /^!\[[^\]]*\]\(https:\/\/prod-files-secure/.test(l))!;

/** A synced note `A` and its page, ready for an image to be pasted after "Intro". */
async function syncedWithPage(t: import("node:test").TestContext, extra: Record<string, string> = {}) {
  const env = await setup(t);
  await writeTree(env.vault, { ...app, "A.md": "Intro\n", ...extra });
  await env.sync();
  return { ...env, id: env.pageNamed("A")!.id };
}

test("an image pasted in Notion is downloaded into the attachment folder and cited by the note", async (t) => {
  const { vault, notion, sync, read, id } = await syncedWithPage(t);
  notion.pasteImage(id, "Intro", "shot.png", pic(1, 2, 3));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { pull: 1 });
  assert.deepEqual([...(await readFile(join(vault, FOLDER, "shot.png")))], [1, 2, 3]);
  assert.match(await read("A.md"), /^---\nnotion-id: \S+\n---\nIntro\n\n!\[\]\(shot\.png\)\n$/);
  assert.deepEqual(outcome.mediaPlan, ["downloaded 1 image"]);
  // Nothing changes again: no download, no write, no page request beyond the reads.
  const before = notion.calls.length;
  const text = await read("A.md");
  assert.deepEqual((await sync()).plan.actions, []);
  assert.equal(await read("A.md"), text);
  assert.deepEqual(notion.calls.slice(before).filter((c) => !/^(properties|listPages|relationTarget)/.test(c)), []);
});

test("a page holding a PDF the sync uploaded can be replaced as a whole, and keeps the PDF block: a hosted attachment is not a block a note can't hold", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { ...app, [`${FOLDER}/Manual.pdf`]: "%PDF-1", "A.md": "x\n\n![[Manual.pdf]]\n\nx\n" });
  await sync();
  const id = pageNamed("A")!.id;
  assert.equal((await notion.mediaBlocks(id)).map((b) => b.kind).join(), "pdf");
  const [block] = await notion.mediaBlocks(id);
  // The second "x" can only be told from the first by the PDF line between them, which Notion can't search for: the page is replaced whole.
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace(/x\n$/, "y\n"));
  const before = notion.calls.length;
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual(outcome.summary!.done, { push: 1 });
  assert.ok(notion.calls.slice(before).some((c) => c.startsWith("replaceContent")), "the page was replaced as a whole");
  assert.deepEqual((await notion.mediaBlocks(id)).map((b) => b.id), [block!.id], "the PDF block is the one that was there");
  assert.equal(notion.calls.slice(before).filter((c) => /^(uploadFile|attachFile)/.test(c)).length, 0);
  assert.match(pageNamed("A")!.markdown, /^x\n<pdf src="https:\/\/prod-files-secure[^"]*Manual\.pdf[^"]*">\n?<\/pdf>\ny$|^x\n<pdf src="https:\/\/prod-files-secure[^"]*Manual\.pdf[^"]*"><\/pdf>\ny$/);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a page holding a hosted PDF the sync can't take (a name with no extension) refuses a whole-page replace and a write that would drop it: the block stays", async (t) => {
  const { vault, notion, sync, read, id, pageNamed } = await syncedWithPage(t, { "A.md": "x\n\nx\n" });
  notion.pasteFile(id, "x", "pdf", "Manual", Uint8Array.from([1, 2]), "leaflet");
  await sync();
  const hostedPdf = () => pageNamed("A")!.markdown.split("\n").filter((l) => /^<pdf src="https:\/\/prod-files-secure/.test(l));
  assert.equal(hostedPdf().length, 1);
  const text = await read("A.md");
  assert.match(text, /prod-files-secure/, "the note holds Notion's link for it");
  const before = notion.calls.length;
  // 1. An edit that can only be placed by the hosted line between the two "x" lines: it needs a whole-page replace.
  await writeFile(join(vault, "A.md"), text.replace(/x\n$/, "y\n"));
  const refused = await sync();
  assert.deepEqual(refused.summary!.skipped.map((skip) => skip.reason.split(":")[0]), ["unsupported_blocks"]);
  assert.equal(hostedPdf().length, 1);
  assert.equal(notion.calls.slice(before).filter((c) => c.startsWith("replaceContent")).length, 0);
  // 2. The line removed from the note: the write would drop the block from the page.
  await writeFile(join(vault, "A.md"), text.split("\n").filter((l) => !l.includes("prod-files-secure")).join("\n"));
  const dropped = await sync();
  assert.deepEqual(dropped.summary!.skipped.map((skip) => skip.reason.split(":")[0]), ["unsupported_blocks"]);
  assert.equal(hostedPdf().length, 1, "the page still holds the block");
});

test("an image over the upload limit that Notion hosts keeps its block when the note is edited on another line: no warning, no upload, not turned into text (spec §5.10)", async (t) => {
  const { vault, notion, sync, read, id, pageNamed } = await syncedWithPage(t);
  const big = new Uint8Array(21 * 1024 * 1024);
  big[7] = 7;
  notion.pasteImage(id, "Intro", "big.png", big);
  const first = await sync();
  assert.deepEqual(first.plan.warnings, []);
  assert.equal((await readFile(join(vault, FOLDER, "big.png"))).length, big.length);
  const text = await read("A.md");
  assert.match(text, /\n!\[\]\(big\.png\)\n$/);
  const hosted = hostedLine(pageNamed("A")!.markdown);
  await writeFile(join(vault, "A.md"), text.replace("Intro", "Intro, edited"));
  const before = notion.calls.length;
  const pushed = await sync();
  assert.deepEqual(pushed.plan.warnings, [], "the citation is not reported as too large");
  assert.deepEqual(pushed.summary!.done, { push: 1 });
  assert.equal(notion.calls.slice(before).filter((c) => /^(uploadFile|attachFile)/.test(c)).length, 0);
  assert.equal(hostedLine(pageNamed("A")!.markdown).replace(/\?.*$/, ""), hosted.replace(/\?.*$/, ""), "the same hosted file, still a block");
  assert.match(pageNamed("A")!.markdown, /^Intro, edited\n/);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a new note comes in from a page holding a pasted image, citing the downloaded file", async (t) => {
  const { vault, notion, sync, read } = await setup(t);
  await writeTree(vault, { ...app, "Seed.md": "seed\n" });
  await sync();
  const id = notion.add("From Notion", "Intro");
  notion.pasteImage(id, "Intro", "new one.png", pic(9));
  await sync();
  // Notion names the pasted file with underscores for spaces.
  assert.match(await read("0-In/From Notion.md"), /\nIntro\n\n!\[\]\(new_one\.png\)\n$/);
  assert.deepEqual([...(await readFile(join(vault, FOLDER, "new_one.png")))], [9]);
});

test("a second pasted image with the same name and other bytes becomes name 1.png; with the same bytes it reuses the file", async (t) => {
  const { vault, notion, sync, read, id } = await syncedWithPage(t);
  notion.pasteImage(id, "Intro", "shot.png", pic(1));
  await sync();
  notion.pasteImage(id, "Intro", "shot.png", pic(2));
  await sync();
  assert.deepEqual((await readdir(join(vault, FOLDER))).sort(), ["shot 1.png", "shot.png"]);
  assert.deepEqual([...(await readFile(join(vault, FOLDER, "shot.png")))], [1]);
  assert.deepEqual([...(await readFile(join(vault, FOLDER, "shot 1.png")))], [2]);
  assert.match(await read("A.md"), /Intro\n\n!\[\]\(shot%201\.png\)\n\n!\[\]\(shot\.png\)\n$/);
  // The same bytes again: the citation points to the file already there and nothing is written.
  notion.pasteImage(id, "Intro", "shot.png", pic(1));
  await sync();
  assert.deepEqual((await readdir(join(vault, FOLDER))).sort(), ["shot 1.png", "shot.png"]);
  assert.match(await read("A.md"), /Intro\n\n!\[\]\(shot\.png\)\n\n!\[\]\(shot%201\.png\)\n\n!\[\]\(shot\.png\)\n$/);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a dry run writes no file and shows the download line", async (t) => {
  const { vault, state, notion, sync, read, id } = await syncedWithPage(t);
  notion.pasteImage(id, "Intro", "shot.png", pic(1, 2, 3));
  const text = await read("A.md");
  const outcome = await sync({ dryRun: true });
  assert.deepEqual(outcome.mediaPlan, ["download shot.png for A.md"]);
  assert.deepEqual(outcome.plan.actions, [{ kind: "pull", pageId: id }]);
  assert.equal(await read("A.md"), text);
  assert.deepEqual(await readdir(join(vault, "Assets")).catch(() => []), []);
  assert.equal((await readdir(state)).includes("images.json"), false);
  // The real run after it does the work.
  assert.deepEqual((await sync()).summary!.done, { pull: 1 });
  assert.deepEqual([...(await readFile(join(vault, FOLDER, "shot.png")))], [1, 2, 3]);
});

test("the preview of a first run downloads nothing", async (t) => {
  const { vault, notion, sync } = await setup(t);
  await writeTree(vault, app);
  const id = notion.add("From Notion", "Intro");
  notion.pasteImage(id, "Intro", "shot.png", pic(1));
  const outcome = await sync({ yes: false });
  assert.equal(outcome.summary, null);
  assert.deepEqual(outcome.mediaPlan, ["download shot.png for From Notion"]);
  assert.deepEqual(await readdir(vault), [".obsidian"]);
});

test("a record holding signed URLs from before plans nothing when only the signature changed", async (t) => {
  const { vault, state, notion, sync, read, id } = await syncedWithPage(t);
  const bare = "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/6b5d1c7e-0000-4000-8000-000000000001/guide.pdf";
  const link = (signature: string) => `Intro [guide](${bare}?X-Amz-Signature=${signature}&X-Amz-Expires=3600)`;
  notion.edit(id, { markdown: link("one") });
  await sync();
  // Records and note as an earlier version left them: signed, as the page was read then.
  const file = join(state, "records", `${id}.json`);
  const record = JSON.parse(await readFile(file, "utf8"));
  record.notionMarkdown = link("one");
  record.obsidianText = record.obsidianText.replace(bare, `${bare}?X-Amz-Signature=one&X-Amz-Expires=3600`);
  await writeFile(file, JSON.stringify(record));
  await writeFile(join(vault, "A.md"), record.obsidianText);
  notion.edit(id, { markdown: link("two") });
  const text = await read("A.md");
  const outcome = await sync();
  assert.deepEqual(outcome.plan.actions, []);
  assert.equal(await read("A.md"), text);
  // The record now holds the page's text without the signature, which changes at every read.
  assert.doesNotMatch(JSON.parse(await readFile(file, "utf8")).notionMarkdown, /X-Amz/);
});

test("the Recipes form: a note holding the image's signed URL ends citing the downloaded file, and the page is not touched (spec §5.6)", async (t) => {
  const { vault, state, notion, sync, read } = await setup(t);
  await writeTree(vault, app);
  const id = notion.add("Recipes", "Intro");
  notion.pasteImage(id, "Intro", "chart_2.png", pic(4, 2));
  const signed = hostedLine((await notion.getMarkdown(id)).markdown);
  const note = `---\nnotion-id: ${id}\n---\nIntro\n\n${signed}\n`;
  await writeTree(vault, { "Recipes.md": note });
  // The record an earlier version saved: both texts as read then, and the page not edited since.
  await mkdir(join(state, "records"), { recursive: true });
  await writeFile(
    join(state, "records", `${id}.json`),
    JSON.stringify({ notionId: id, path: "Recipes.md", title: "Recipes", folder: null, obsidianText: note, notionMarkdown: `Intro\n${signed}`, notionSeenAt: "2026-09-27T10:01:00.000Z", syncedAt: "2026-09-27T10:01:00.000Z" }),
  );
  const pageBefore = notion.pages.get(id)!.markdown;
  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.plan.actions, [{ kind: "convertImages", path: "Recipes.md", text: `---\nnotion-id: ${id}\n---\nIntro\n\n![](chart_2.png)\n`, images: 1 }]);
  assert.deepEqual(dry.mediaPlan, ["download chart_2.png for Recipes.md"]);
  assert.match(formatPlan(dry.plan, dry.notes, dry.pages), /turn the Notion-hosted files \(images, PDFs, audio, video, other files\) into citations in Recipes\.md \(1 file\)/);
  assert.equal(await read("Recipes.md"), note);
  notion.calls.length = 0;
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { convertImages: 1 });
  assert.equal(await read("Recipes.md"), `---\nnotion-id: ${id}\n---\nIntro\n\n![](chart_2.png)\n`);
  assert.deepEqual([...(await readFile(join(vault, FOLDER, "chart_2.png")))], [4, 2]);
  assert.equal(notion.pages.get(id)!.markdown, pageBefore);
  assert.deepEqual(notion.calls.filter((c) => /^(update|replace)Content|mediaBlocks|attachFile|uploadFile/.test(c)), []);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a block whose image the user changes in Notion brings the new file down and the note cites it (spec §5.9)", async (t) => {
  const { vault, notion, sync, read, id } = await syncedWithPage(t);
  notion.pasteImage(id, "Intro", "shot.png", pic(1));
  await sync();
  const page = notion.pages.get(id)!;
  notion.edit(id, { markdown: page.markdown.split("\n").filter((l) => !l.startsWith("![")).join("\n") });
  notion.pasteImage(id, "Intro", "shot.png", pic(2));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { pull: 1 });
  assert.match(await read("A.md"), /Intro\n\n!\[\]\(shot%201\.png\)\n$/);
  assert.deepEqual([...(await readFile(join(vault, FOLDER, "shot 1.png")))], [2]);
  // The old file is never overwritten; no note cites it now, so it goes to .trash (spec §5.9, §5.7).
  assert.deepEqual([...(await readFile(join(vault, ".trash", "shot.png")))], [1]);
  assert.deepEqual(outcome.summary!.mediaMoved, [`${FOLDER}/shot.png`]);
});

test("a known image whose file was deleted from the vault is downloaded back to its path", async (t) => {
  const { vault, notion, sync, read, id } = await syncedWithPage(t);
  notion.pasteImage(id, "Intro", "shot.png", pic(7, 7));
  await sync();
  await rm(join(vault, FOLDER, "shot.png"));
  // The page is read again when it is edited.
  notion.edit(id, { markdown: `${notion.pages.get(id)!.markdown}\nmore` });
  const outcome = await sync();
  assert.deepEqual([...(await readFile(join(vault, FOLDER, "shot.png")))], [7, 7]);
  assert.deepEqual(outcome.summary!.done, { pull: 1 });
  assert.match(await read("A.md"), /!\[\]\(shot\.png\)/);
  assert.deepEqual((await readdir(join(vault, FOLDER))).sort(), ["shot.png"]);
});

test("a refused download leaves the page's note for the next run and reports it", async (t) => {
  const { vault, notion, sync, read, id } = await syncedWithPage(t);
  notion.pasteImage(id, "Intro", "shot.png", pic(1));
  const download = notion.downloadTo.bind(notion);
  notion.downloadTo = async () => {
    throw new NotionPageError("download_failed", "downloading the file answered 403");
  };
  const text = await read("A.md");
  const failed = await sync();
  assert.deepEqual(failed.summary!.done, {});
  assert.deepEqual(failed.summary!.skipped.map((s) => [s.path, s.reason.split(":")[0]]), [["A.md", "download_failed"]]);
  assert.match(failed.summary!.skipped[0]!.reason, /shot\.png/);
  assert.equal(await read("A.md"), text);
  assert.deepEqual(await readdir(join(vault, "Assets")).catch(() => []), []);
  notion.downloadTo = download;
  assert.deepEqual((await sync()).summary!.done, { pull: 1 });
  assert.match(await read("A.md"), /!\[\]\(shot\.png\)/);
});

test("the Recipes form works for a file whose hosted name holds parentheses (probe_(1).png)", async (t) => {
  const { vault, state, notion, sync, read } = await setup(t);
  await writeTree(vault, app);
  const id = notion.add("Recipes", "Intro");
  notion.pasteImage(id, "Intro", "probe (1).png", pic(5), "a caption");
  const signed = hostedLine((await notion.getMarkdown(id)).markdown);
  assert.match(signed, /probe_\(1\)\.png\?/);
  const note = `---\nnotion-id: ${id}\n---\nIntro\n\n${signed}\n`;
  await writeTree(vault, { "Recipes.md": note });
  await mkdir(join(state, "records"), { recursive: true });
  await writeFile(
    join(state, "records", `${id}.json`),
    JSON.stringify({ notionId: id, path: "Recipes.md", title: "Recipes", folder: null, obsidianText: note, notionMarkdown: `Intro\n${signed}`, notionSeenAt: "2026-09-27T10:01:00.000Z", syncedAt: "2026-09-27T10:01:00.000Z" }),
  );
  assert.deepEqual((await sync()).summary!.done, { convertImages: 1 });
  assert.equal(await read("Recipes.md"), `---\nnotion-id: ${id}\n---\nIntro\n\n![a caption](probe_%281%29.png)\n`);
  assert.deepEqual([...(await readFile(join(vault, FOLDER, "probe_(1).png")))], [5]);
  assert.deepEqual((await sync()).plan.actions, []);
});

// The first run adds the images already synced (spec §5.11).

/** A note and page synced before images were: the note cites the image, the page and the record hold it as escaped text. */
async function syncedBeforeImages(t: import("node:test").TestContext, body: string, markdown: string, extra: Record<string, string> = {}) {
  const env = await setup(t);
  await writeTree(env.vault, { ...app, [`${FOLDER}/whisk.png`]: "PNG", ...extra });
  const id = env.notion.add("A", markdown);
  const note = `---\nnotion-id: ${id}\n---\n${body}`;
  await writeTree(env.vault, { "A.md": note });
  await mkdir(join(env.state, "records"), { recursive: true });
  const seen = "2026-09-27T10:01:00.000Z";
  await writeFile(
    join(env.state, "records", `${id}.json`),
    JSON.stringify({ notionId: id, path: "A.md", title: "A", folder: null, obsidianText: note, notionMarkdown: markdown, notionSeenAt: seen, syncedAt: seen }),
  );
  return { ...env, id, note };
}

test("a note synced before images were gets them on the first run: the page holds a hosted image and the next run has nothing to do", async (t) => {
  const { notion, sync, read, id, note } = await syncedBeforeImages(t, "Intro\n\n![[whisk.png]]\n\nOutro\n", "Intro\n!\\[\\[whisk.png\\]\\]\nOutro");
  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.plan.actions, [{ kind: "updateEmbeds", pageId: id }]);
  assert.match(formatPlan(dry.plan, dry.notes, dry.pages), /turn the attachment citations already synced into Notion blocks and drop the `!` before embedded notes in A\.md/);
  assert.equal(notion.pages.get(id)!.markdown, "Intro\n!\\[\\[whisk.png\\]\\]\nOutro");
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { updateEmbeds: 1 });
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.match(notion.pages.get(id)!.markdown, /^Intro\n!\[\]\(https:\/\/prod-files-secure[^)]*whisk\.png[^)]*\)\nOutro$/);
  assert.equal(await read("A.md"), note, "the note is not touched");
  const next = await sync();
  assert.deepEqual(next.plan.actions, []);
  assert.match(formatSummary(next.summary!, next.plan), /^Everything was already in sync\./);
});

test("an image alone in a list item, and one sharing a paragraph with text, are added too", async (t) => {
  const { notion, sync, id } = await syncedBeforeImages(
    t,
    "Intro\n![[whisk.png|a cap]]\nafter\n\n- ![[whisk.png]]\n- second\n",
    "Intro<br>!\\[\\[whisk.png\\|a cap\\]\\]<br>after\n- !\\[\\[whisk.png\\]\\]\n- second",
  );
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { updateEmbeds: 1 });
  const lines = notion.pages.get(id)!.markdown.split("\n");
  assert.deepEqual(lines.map((l) => l.replace(/\(https:[^)]*\)/, "(url)")), ["Intro", "![a cap](url)", "after", "-", "\t![](url)", "- second"]);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a note whose image line sits in a quote plans nothing", async (t) => {
  const { sync, notion, id } = await syncedBeforeImages(t, "> ![[whisk.png]]\n", "> !\\[\\[whisk.png\\]\\]");
  const outcome = await sync();
  assert.deepEqual(outcome.plan.actions, []);
  assert.equal(notion.pages.get(id)!.markdown, "> !\\[\\[whisk.png\\]\\]");
});

test("a page that changed in Notion during the run keeps its edit and gets the images next run", async (t) => {
  const { notion, sync, id } = await syncedBeforeImages(t, "Intro\n\n![[whisk.png]]\n", "Intro\n!\\[\\[whisk.png\\]\\]");
  let reads = 0;
  notion.getMarkdown = async (page) => {
    if (page === id && ++reads === 1) notion.edit(id, { markdown: "Intro\nsomething new\n!\\[\\[whisk.png\\]\\]" });
    return FakeNotion.prototype.getMarkdown.call(notion, page);
  };
  const outcome = await sync();
  assert.deepEqual(reasons(outcome), ["changed_in_notion"]);
  notion.getMarkdown = FakeNotion.prototype.getMarkdown;
  assert.equal(notion.pages.get(id)!.markdown, "Intro\nsomething new\n!\\[\\[whisk.png\\]\\]");
  assert.deepEqual((await sync()).summary!.done, { pull: 1 });
});

test("a note held back before (its record waiting, both texts empty) is pushed the ordinary way, not by updateEmbeds, and its page holds the italic caption", async (t) => {
  const { vault, state, notion, sync, read } = await setup(t);
  const dir = "Assets/pictures";
  const note = "Bread is a baked food.\n\n![[map.png|_North_ is up]]\n";
  await writeTree(vault, { ...app, [`${dir}/map.png`]: "PNG" });
  const id = notion.add("Baking Method", "");
  const text = `---\nnotion-id: ${id}\n---\n${note}`;
  await writeTree(vault, { "Baking Method.md": text });
  await mkdir(join(state, "records"), { recursive: true });
  const seen = "2026-09-27T10:01:00.000Z";
  await writeFile(
    join(state, "records", `${id}.json`),
    JSON.stringify({ notionId: id, path: "Baking Method.md", title: "Baking Method", folder: null, obsidianText: `---\nnotion-id: ${id}\n---\n`, notionMarkdown: "", notionSeenAt: seen, syncedAt: seen }),
  );
  const outcome = await sync();
  assert.deepEqual(outcome.plan.actions, [{ kind: "push", pageId: id }]);
  assert.deepEqual(outcome.summary!.done, { push: 1 });
  const markdown = notion.pages.get(id)!.markdown;
  assert.match(markdown, /^Bread is a baked food\.\n!\[\*North\* is up\]\(https:\/\/prod-files-secure[^)]*\)$/);
  assert.equal(await read("Baking Method.md"), text);
  assert.deepEqual((await sync()).plan.actions, []);
});

// An embed of a note is the mention alone in Notion; the pages synced with the `!` before it lose it on the first run.

/** Two synced notes, A embedding B, then A's page and record put back as before the `!` was dropped (and, if given, otherwise as Notion would keep them). */
async function syncedWithMarkedEmbed(t: import("node:test").TestContext, aBody = "Intro\n\n![[B]]\n\nOutro\n", notionForm = (markdown: string) => markdown) {
  const env = await setup(t);
  await writeTree(env.vault, { "A.md": aBody, "B.md": "Target\n" });
  await env.sync();
  const a = env.pageNamed("A")!;
  const b = env.pageNamed("B")!;
  const mention = `<mention-page url="https://app.notion.com/p/${b.id.replace(/-/g, "")}"/>`;
  assert.equal(a.markdown.includes(`\n${mention}\n`), true, "a new embed is the mention alone");
  // The page and the record as the older version left them.
  const marked = notionForm(a.markdown.replaceAll(mention, `!${mention}`));
  env.notion.edit(a.id, { markdown: marked });
  const file = join(env.state, "records", `${a.id}.json`);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), notionMarkdown: marked }));
  return { ...env, a, b, mention, marked };
}

test("a page synced with the ! before an embedded note loses only the ! on the first run, and the next run has nothing to do", async (t) => {
  const { notion, sync, read, a, mention, marked } = await syncedWithMarkedEmbed(t);
  const note = await read("A.md");
  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.plan.actions, [{ kind: "updateEmbeds", pageId: a.id }]);
  assert.match(formatPlan(dry.plan, dry.notes, dry.pages), /drop the `!` before embedded notes in A\.md/);
  assert.equal(notion.pages.get(a.id)!.markdown, marked, "a dry run changes nothing");
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { updateEmbeds: 1 });
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.equal(notion.pages.get(a.id)!.markdown, marked.replace(`!${mention}`, mention));
  assert.equal(await read("A.md"), note, "the note is not touched");
  const next = await sync();
  assert.deepEqual(next.plan.actions, []);
  assert.match(formatSummary(next.summary!, next.plan), /^Everything was already in sync\./);
});

test("only the ! goes: a mention that is not an embed, a section embed, Notion's own forms and the other pages stay as they are", async (t) => {
  const body = "Intro\n\n![[B]]\n\nsee ![[B]] here\n\n- ![[B]]\n\nand [[B]] linked\n\n![[B#Part]]\n\n![[Nothing]]\n\nstrike ~~text~~ end\n";
  const { notion, sync, read, a, b, mention, marked } = await syncedWithMarkedEmbed(t, body, (markdown) => markdown.replace("~~text~~", "<s>text</s>"));
  assert.equal(marked.split(`!${mention}`).length - 1, 3);
  const note = await read("A.md");
  const target = notion.pages.get(b.id)!.markdown;
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { updateEmbeds: 1 });
  assert.equal(notion.pages.get(a.id)!.markdown, marked.replaceAll(`!${mention}`, mention));
  assert.equal(notion.pages.get(b.id)!.markdown, target);
  assert.equal(await read("A.md"), note);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a note edited in Obsidian next to a marked embed is pushed first, and the ! goes on the run after", async (t) => {
  const { vault, notion, sync, a, mention } = await syncedWithMarkedEmbed(t);
  const text = (await readFile(join(vault, "A.md"), "utf8")).replace("Outro", "Outro, edited");
  await writeFile(join(vault, "A.md"), text);
  assert.deepEqual((await sync()).summary!.done, { push: 1 });
  assert.match(notion.pages.get(a.id)!.markdown, /Outro, edited$/);
  assert.deepEqual((await sync()).summary!.done, { updateEmbeds: 1 });
  assert.equal(notion.pages.get(a.id)!.markdown.includes(`!${mention}`), false);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a marked embed whose page changed in Notion during the run keeps the edit and loses the ! next run", async (t) => {
  const { notion, sync, a, mention, marked } = await syncedWithMarkedEmbed(t);
  let reads = 0;
  notion.getMarkdown = async (page) => {
    // The first read is the run's look at the page; the second is the update's own, just before it writes.
    if (page === a.id && ++reads === 2) notion.edit(a.id, { markdown: `${marked}\nsomething new` });
    return FakeNotion.prototype.getMarkdown.call(notion, page);
  };
  const outcome = await sync();
  assert.deepEqual(reasons(outcome), ["changed_in_notion"]);
  notion.getMarkdown = FakeNotion.prototype.getMarkdown;
  assert.equal(notion.pages.get(a.id)!.markdown, `${marked}\nsomething new`);
  assert.deepEqual((await sync()).summary!.done, { pull: 1 });
  assert.deepEqual((await sync()).summary!.done, { updateEmbeds: 1 });
  assert.equal(notion.pages.get(a.id)!.markdown.includes(`!${mention}`), false);
});

test("a page with embeds edited in Notion is pulled, and a deleted mention line takes the note's ![[ ]] line with it", async (t) => {
  const { notion, sync, read, a } = await syncedWithMarkedEmbed(t, "Intro\n\n![[B]]\n\nOutro\n\n![[B]]\n");
  await sync();
  notion.edit(a.id, { markdown: notion.pages.get(a.id)!.markdown.replace("Intro", "Intro, edited in Notion") });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { pull: 1 });
  assert.match(await read("A.md"), /^---\nnotion-id: [^\n]+\n---\nIntro, edited in Notion\n\n!\[\[B\]\]\n\nOutro\n\n!\[\[B\]\]\n$/);
  assert.deepEqual((await sync()).plan.actions, []);
  notion.edit(a.id, { markdown: notion.pages.get(a.id)!.markdown.replace(/\n<mention-page[^\n]*\/>(?=\nOutro)/, "") });
  assert.deepEqual((await sync()).summary!.done, { pull: 1 });
  assert.match(await read("A.md"), /^---\nnotion-id: [^\n]+\n---\nIntro, edited in Notion\n\nOutro\n\n!\[\[B\]\]\n$/);
  assert.deepEqual((await sync()).plan.actions, []);
});

// Replaced and unused images, and the run's report of them (spec §5.7, §5.8, §5.12, §5.13).

/** The hosted file a page's image line points to, downloaded from the fake. */
const hostedBytes = async (notion: FakeNotion, id: string) => [...(await notion.download((await notion.mediaBlocks(id))[0]!.hosted!))];
const count = (notion: FakeNotion, call: string) => notion.calls.filter((c) => c.startsWith(call)).length;
const imagesJson = (state: string) => readFile(join(state, "images.json"), "utf8");
const trashed = async (vault: string) => (await readdir(join(vault, ".trash")).catch(() => [] as string[])).sort();

test("a replaced file switches every block of both pages citing it, and the pages' text is unchanged", async (t) => {
  const { vault, state, notion, sync } = await setup(t);
  await writeTree(vault, { ...app, [`${FOLDER}/a.png`]: "v1", "A.md": "Intro\n\n![[a.png]]\n\nMiddle\n\n![[a.png|cap]]\n", "B.md": "![[a.png]]\n" });
  await sync();
  const [a, b] = [...notion.pages.values()];
  const texts = [a!.markdown, b!.markdown].map((m) => m.replace(/\(https:[^)]*\)/g, "(url)"));
  assert.equal(count(notion, "uploadFile"), 1, "one upload serves every block");
  const nothing = await sync();
  assert.equal(nothing.summary!.mediaUpdated.length, 0);

  await writeFile(join(vault, FOLDER, "a.png"), "v2 is longer");
  const saved = await imagesJson(state);
  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.mediaPlan, [`update file ${FOLDER}/a.png (2 pages)`]);
  assert.equal(count(notion, "uploadFile"), 1, "a dry run uploads nothing");
  assert.equal(await imagesJson(state), saved);

  const outcome = await sync();
  assert.deepEqual(outcome.summary!.mediaUpdated, [{ path: `${FOLDER}/a.png`, pages: 2 }]);
  assert.equal(outcome.summary!.mediaUploaded, 0, "the new upload of a replaced file is the 'updated file' line, not an 'uploaded' one");
  assert.match(formatSummary(outcome.summary!, outcome.plan), /\n {2}updated file Assets\/pictures\/a\.png on 2 pages(\n|$)/);
  assert.deepEqual(outcome.plan.actions, []);
  assert.equal(count(notion, "uploadFile"), 2);
  for (const page of [a!, b!]) {
    for (const block of await notion.mediaBlocks(page.id)) assert.deepEqual([...(await notion.download(block.hosted!))], [..."v2 is longer"].map((c) => c.charCodeAt(0)));
  }
  assert.deepEqual([a!.markdown, b!.markdown].map((m) => m.replace(/\(https:[^)]*\)/g, "(url)")), texts);

  // After that, nothing is left to do: no upload, no switch, nothing written.
  const before = notion.calls.length;
  const settled = await imagesJson(state);
  const again = await sync();
  assert.deepEqual(again.plan.actions, []);
  assert.match(formatSummary(again.summary!, again.plan), /^Everything was already in sync\./);
  // (The pages the switch edited are read once more, to see they are as they were.)
  assert.deepEqual(notion.calls.slice(before).filter((c) => !/^(properties|listPages|relationTarget|getMarkdown)/.test(c)), []);
  assert.equal(await imagesJson(state), settled);
});

test("a replaced file is found even when the same run attaches it to a page that was edited", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { ...app, [`${FOLDER}/a.png`]: "v1", "A.md": "Intro\n\n![[a.png]]\n", "B.md": "![[a.png]]\n" });
  await sync();
  await writeFile(join(vault, FOLDER, "a.png"), "v2 is longer");
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("Intro", "Introduction"));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { push: 1 });
  assert.deepEqual(outcome.summary!.mediaUpdated, [{ path: `${FOLDER}/a.png`, pages: 2 }]);
  const expected = [..."v2 is longer"].map((c) => c.charCodeAt(0));
  assert.deepEqual(await hostedBytes(notion, pageNamed("A")!.id), expected);
  assert.deepEqual(await hostedBytes(notion, pageNamed("B")!.id), expected, "the page this run did not push shows the new file too");
});

test("a replacement Notion refuses is tried again next run", async (t) => {
  const { vault, notion, sync, pageNamed } = await setup(t);
  await writeTree(vault, { ...app, [`${FOLDER}/a.png`]: "v1", "A.md": "![[a.png]]\n", "B.md": "![[a.png]]\n" });
  await sync();
  await writeFile(join(vault, FOLDER, "a.png"), "v2 is longer");
  const attach = notion.attachFile.bind(notion);
  let attached = 0;
  notion.attachFile = async (blockId, kind, uploadId) => {
    if (++attached === 2) throw new NotionPageError("validation_error", "refused");
    return attach(blockId, kind, uploadId);
  };
  const failed = await sync();
  assert.deepEqual(failed.summary!.mediaUpdated, []);
  assert.deepEqual(reasons(failed), ["validation_error"]);
  assert.equal(exitCode(failed.summary, failed.plan), 1);
  notion.attachFile = attach;
  const retried = await sync();
  assert.deepEqual(retried.summary!.mediaUpdated, [{ path: `${FOLDER}/a.png`, pages: 2 }]);
  const expected = [..."v2 is longer"].map((c) => c.charCodeAt(0));
  assert.deepEqual(await hostedBytes(notion, pageNamed("A")!.id), expected);
  assert.deepEqual(await hostedBytes(notion, pageNamed("B")!.id), expected);
  assert.deepEqual((await sync()).summary!.mediaUpdated, []);
});

test("a pull that removes the last citation moves the file to .trash on that run; a file never cited stays", async (t) => {
  const { vault, state, notion, sync, read, id } = await syncedWithPage(t, { [`${FOLDER}/a.png`]: "A", [`${FOLDER}/kx.png`]: "never cited" });
  await writeFile(join(vault, "A.md"), `${await read("A.md")}\n![[a.png]]\n`);
  await sync();
  assert.deepEqual(JSON.parse(await imagesJson(state)).cited, [`${FOLDER}/a.png`]);
  notion.edit(id, { markdown: "Intro" });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { pull: 1 });
  assert.deepEqual(outcome.summary!.mediaMoved, [`${FOLDER}/a.png`]);
  assert.match(formatSummary(outcome.summary!, outcome.plan), /\n {2}moved Assets\/pictures\/a\.png to \.trash(\n|$)/);
  assert.deepEqual(await readdir(join(vault, FOLDER)), ["kx.png"]);
  assert.equal(await readFile(join(vault, ".trash", "a.png"), "utf8"), "A");
  const stored = JSON.parse(await imagesJson(state));
  assert.deepEqual([stored.cited, Object.keys(stored.images)], [[], []]);
  const again = await sync();
  assert.match(formatSummary(again.summary!, again.plan), /^Everything was already in sync\./);
  assert.deepEqual(await trashed(vault), ["a.png"]);
});

test("a taken name in .trash gets a number before the extension", async (t) => {
  const { vault, notion, sync, read, id } = await syncedWithPage(t, { [`${FOLDER}/a.png`]: "A", ".trash/a.png": "older" });
  await writeFile(join(vault, "A.md"), `${await read("A.md")}\n![[a.png]]\n`);
  await sync();
  notion.edit(id, { markdown: "Intro" });
  await sync();
  assert.deepEqual(await trashed(vault), ["a (2).png", "a.png"]);
  assert.equal(await readFile(join(vault, ".trash", "a.png"), "utf8"), "older");
});

test("a note trashed in Obsidian frees its images; one in a conflict copy or a drawing keeps them", async (t) => {
  const { vault, notion, sync, pageNamed } = await setup(t);
  await writeTree(vault, { ...app, [`${FOLDER}/a.png`]: "A", [`${FOLDER}/b.png`]: "B", [`${FOLDER}/c.png`]: "C", "N.md": "![[a.png]]\n\n![[b.png]]\n\n![[c.png]]\n" });
  await sync();
  const id = pageNamed("N")!.id;
  await rm(join(vault, "N.md"));
  await writeTree(vault, { "Drawing.excalidraw.md": "## Embedded Files\nx: [[b.png]]\n", "N (Notion conflict 2026-09-27).md": "![[c.png]]" });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.mediaMoved, [`${FOLDER}/a.png`]);
  assert.deepEqual(await readdir(join(vault, FOLDER)), ["b.png", "c.png"]);
  assert.equal(notion.pages.get(id)!.inTrash, true, "the trashed note's page went to the trash too");
});

test("skip keeps images: a note left alone this run still counts the citation it last synced", async (t) => {
  const { vault, notion, sync, read, id } = await syncedWithPage(t, { [`${FOLDER}/a.png`]: "A" });
  await writeFile(join(vault, "A.md"), `${await read("A.md")}\n![[a.png]]\n`);
  await sync();
  // The citation is removed in Obsidian, but the page is too large to read this run, so the note is left alone.
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("\n![[a.png]]\n", ""));
  notion.edit(id, { truncated: true });
  const skipped = await sync();
  assert.deepEqual(reasons(skipped), ["truncated"]);
  assert.deepEqual(skipped.summary!.mediaMoved, []);
  assert.deepEqual(await readdir(join(vault, FOLDER)), ["a.png"]);
  assert.deepEqual(await trashed(vault), []);
});

test("11 freed images move none and warn; --allow-mass-trash moves them on the next run", async (t) => {
  const { vault, notion, sync, read } = await setup(t);
  const names = Array.from({ length: 11 }, (_, i) => `i${i}.png`);
  await writeTree(vault, { ...app, ...Object.fromEntries(names.map((n) => [`${FOLDER}/${n}`, n])), "N.md": `${names.map((n) => `![[${n}]]`).join("\n\n")}\n` });
  await sync();
  await writeFile(join(vault, "N.md"), "Nothing here now\n");
  const held = await sync();
  assert.deepEqual(held.summary!.mediaMoved, []);
  assert.deepEqual(held.plan.warnings, ["11 files would be moved to .trash, more than the limit of 10, so none were. Check the plan, then run again with --allow-mass-trash."]);
  assert.match(formatSummary(held.summary!, held.plan), /\nwarning: 11 files would be moved to \.trash/);
  assert.equal(exitCode(held.summary, held.plan), 1);
  assert.equal((await readdir(join(vault, FOLDER))).length, 11);
  // The warning stays until the user decides; nothing else happens.
  assert.equal((await sync()).plan.warnings.length, 1);
  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.mediaPlan ?? [], [], "the dry run says no more than the real one: nothing moves");
  assert.equal(dry.plan.warnings.length, 1);
  const allowed = await sync({ allowMassTrash: true });
  assert.equal(allowed.summary!.mediaMoved.length, 11);
  assert.deepEqual(allowed.plan.warnings, []);
  assert.equal((await readdir(join(vault, FOLDER))).length, 0);
  assert.equal((await trashed(vault)).length, 11);
  assert.equal(notion.pages.size, 1);
  assert.equal(await read("N.md").then((x) => x.includes("Nothing here")), true);
});

test("10 freed images move", async (t) => {
  const { vault, sync } = await setup(t);
  const names = Array.from({ length: 10 }, (_, i) => `i${i}.png`);
  await writeTree(vault, { ...app, ...Object.fromEntries(names.map((n) => [`${FOLDER}/${n}`, n])), "N.md": `${names.map((n) => `![[${n}]]`).join("\n\n")}\n` });
  await sync();
  await writeFile(join(vault, "N.md"), "Nothing here now\n");
  const outcome = await sync();
  assert.equal(outcome.summary!.mediaMoved.length, 10);
  assert.deepEqual(outcome.plan.warnings, []);
});

test("the first run with the feature moves nothing: files never cited are never touched, and the citations are recorded", async (t) => {
  const { vault, state, sync } = await setup(t);
  await writeTree(vault, { ...app, [`${FOLDER}/used.png`]: "U", [`${FOLDER}/kx.png`]: "G", [`${FOLDER}/old.png`]: "O", "N.md": "![[used.png]]\n" });
  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.mediaPlan, [`upload ${FOLDER}/used.png for N.md`], "nothing moves; the one cited file is the only upload");
  assert.equal(await imagesJson(state).catch(() => null), null, "a dry run saves nothing");
  const first = await sync();
  assert.deepEqual(first.summary!.mediaMoved, []);
  assert.deepEqual(JSON.parse(await imagesJson(state)).cited, [`${FOLDER}/used.png`]);
  await sync();
  assert.deepEqual(await readdir(join(vault, FOLDER)), ["kx.png", "old.png", "used.png"]);
});

test("a renamed image: its citations rewritten between runs, the page shows the new file after one run and the gone path moves nothing", async (t) => {
  const { vault, state, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { ...app, [`${FOLDER}/old.png`]: "PIXELS", "N.md": "Intro\n\n![[old.png]]\n" });
  await sync();
  await rename(join(vault, FOLDER, "old.png"), join(vault, FOLDER, "new.png"));
  await writeFile(join(vault, "N.md"), (await read("N.md")).replace("old.png", "new.png"));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { push: 1 });
  assert.deepEqual(outcome.summary!.mediaMoved, []);
  assert.deepEqual(await trashed(vault), []);
  assert.deepEqual(await hostedBytes(notion, pageNamed("N")!.id), [..."PIXELS"].map((c) => c.charCodeAt(0)));
  assert.deepEqual(JSON.parse(await imagesJson(state)).cited, [`${FOLDER}/new.png`]);
  assert.deepEqual((await sync()).plan.actions, []);
  assert.deepEqual(await readdir(join(vault, FOLDER)), ["new.png"]);
});

test("a dry run lists what it would update and move and changes nothing", async (t) => {
  const { vault, state, notion, sync, read } = await setup(t);
  await writeTree(vault, { ...app, [`${FOLDER}/a.png`]: "v1", [`${FOLDER}/b.png`]: "B", "N.md": "![[a.png]]\n\n![[b.png]]\n" });
  await sync();
  await writeFile(join(vault, FOLDER, "a.png"), "v2 is longer");
  await writeFile(join(vault, "N.md"), (await read("N.md")).replace("\n\n![[b.png]]", ""));
  const saved = await imagesJson(state);
  const before = [notion.calls.length, [...notion.pages.values()].map((p) => p.markdown)] as const;
  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.summary, null);
  assert.deepEqual(dry.mediaPlan, [`update file ${FOLDER}/a.png (1 page)`, `move to .trash ${FOLDER}/b.png`]);
  assert.deepEqual(notion.calls.slice(before[0]).filter((c) => !/^(properties|listPages|relationTarget|getMarkdown)/.test(c)), []);
  assert.deepEqual([...notion.pages.values()].map((p) => p.markdown), before[1]);
  assert.equal(await imagesJson(state), saved);
  assert.deepEqual(await readdir(join(vault, FOLDER)), ["a.png", "b.png"]);
});

test("only files of the attachment folder move: a citation recorded for another folder is left alone", async (t) => {
  const { vault, state, sync } = await setup(t);
  await writeTree(vault, { ...app, "Other/x.png": "X", "N.md": "text\n" });
  await writeTree(state, { "images.json": JSON.stringify({ images: {}, cited: ["Other/x.png"] }) });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.mediaMoved, []);
  assert.equal(await readFile(join(vault, "Other/x.png"), "utf8"), "X");
  assert.deepEqual(JSON.parse(await imagesJson(state)).cited, []);
});

test("the plan warns once per line about citations that stay text, with the reason", async (t) => {
  const { vault, sync } = await setup(t);
  await writeTree(vault, {
    ...app,
    [`${FOLDER}/oven.png`]: "B",
    "Astronomy/Oven.md": "![[oven.png]] text after\n\n![[oven.png]] text after\n\n![[nowhere.png]]\n",
  });
  const warnings = (await sync({ dryRun: true })).plan.warnings;
  assert.deepEqual(warnings, [
    'Astronomy/Oven.md: the image on the line "![[oven.png]] text after" shares its line with other text (or sits in a quote or table), so it stays text in Notion; put it on its own line to sync it as an image',
  ]);
  const real = await sync();
  assert.deepEqual(real.plan.warnings, warnings);
  assert.doesNotMatch(formatSummary(real.summary!, real.plan), /nowhere/);
});

test("a refused replacement on a run that also pushed a page citing the file is still tried again next run", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { ...app, [`${FOLDER}/a.png`]: "v1", "A.md": "Intro\n\n![[a.png]]\n", "B.md": "![[a.png]]\n" });
  await sync();
  await writeFile(join(vault, FOLDER, "a.png"), "v2 is longer");
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("Intro", "Introduction"));
  const attach = notion.attachFile.bind(notion);
  let attached = 0;
  notion.attachFile = async (blockId, kind, uploadId) => {
    // 1: the push of A (it puts the new file on A's page); 2: the switch of B's page, which still shows the old file.
    if (++attached === 2) throw new NotionPageError("validation_error", "refused");
    return attach(blockId, kind, uploadId);
  };
  const failed = await sync();
  assert.deepEqual(failed.summary!.done, { push: 1 });
  assert.deepEqual(reasons(failed), ["validation_error"]);
  notion.attachFile = attach;
  const retried = await sync();
  assert.deepEqual(retried.summary!.mediaUpdated, [{ path: `${FOLDER}/a.png`, pages: 2 }]);
  const expected = [..."v2 is longer"].map((c) => c.charCodeAt(0));
  assert.deepEqual(await hostedBytes(notion, pageNamed("A")!.id), expected);
  assert.deepEqual(await hostedBytes(notion, pageNamed("B")!.id), expected);
});

test("trashes held back by the mass-trash guard keep their notes' images where they are", async (t) => {
  const { vault, notion, sync } = await setup(t);
  const names = Array.from({ length: 11 }, (_, i) => `i${i}.png`);
  await writeTree(vault, {
    ...app,
    ...Object.fromEntries(names.map((n) => [`${FOLDER}/${n}`, n])),
    ...Object.fromEntries(names.map((n, i) => [`N${i}.md`, `![[${n}]]\n`])),
  });
  await sync();
  for (let i = 0; i < 11; i++) await rm(join(vault, `N${i}.md`));
  const held = await sync();
  assert.equal(held.plan.heldTrashes, 11);
  assert.deepEqual(held.summary!.mediaMoved, []);
  assert.equal((await readdir(join(vault, FOLDER))).length, 11);
  assert.deepEqual(await trashed(vault), []);
  assert.equal([...notion.pages.values()].filter((p) => !p.inTrash).length, 11);
  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.mediaPlan ?? [], []);
  const allowed = await sync({ allowMassTrash: true });
  assert.equal(allowed.summary!.mediaMoved.length, 11);
  assert.equal([...notion.pages.values()].filter((p) => !p.inTrash).length, 0);
});

// A placeholder image that was never switched to an upload (final review, finding 1).
for (const where of ["uploadFile", "attachFile"] as const) {
  test(`a page left with a placeholder because ${where} was refused is finished by the next run, and a run that still can't says so`, async (t) => {
    const { vault, state, notion, sync, read, pageNamed } = await setup(t);
    await writeTree(vault, { ...app, "A.md": "Intro\n\nOutro\n" });
    await sync();
    await writeTree(vault, { [`${FOLDER}/x.png`]: "x bytes" });
    await writeFile(join(vault, "A.md"), (await read("A.md")).replace("Intro\n", "Intro\n\n![[x.png]]\n"));
    const real = notion[where].bind(notion) as (...args: never[]) => Promise<unknown>;
    const refuse = async () => {
      throw new NotionPageError("internal_server_error", "boom");
    };
    (notion as unknown as Record<string, unknown>)[where] = refuse;

    const first = await sync();
    assert.deepEqual(reasons(first), ["internal_server_error"], "the push is skipped");
    assert.match(pageNamed("A")!.markdown, /nopipeline\.invalid/);
    const id = pageNamed("A")!.id;
    assert.deepEqual(JSON.parse(await imagesJson(state)).unattached, [id], "kept for the next run, which reads the page again");

    // Still refused: the page is not in sync, and the run says so (it did not skip a push this time).
    const second = await sync();
    assert.deepEqual(reasons(second), ["internal_server_error"]);
    assert.match(second.summary!.skipped[0]!.reason, /tried again next run/);
    assert.equal(exitCode(second.summary, second.plan), 1);
    assert.match(pageNamed("A")!.markdown, /nopipeline\.invalid/);

    (notion as unknown as Record<string, unknown>)[where] = real;
    const third = await sync();
    assert.deepEqual(third.summary!.skipped, []);
    assert.doesNotMatch(pageNamed("A")!.markdown, /nopipeline\.invalid/);
    assert.match(hostedLine(pageNamed("A")!.markdown), /^!\[\]\(https:\/\/prod-files-secure/);
    assert.deepEqual(JSON.parse(await imagesJson(state)).unattached, []);
    assert.deepEqual([...(await notion.download((await notion.mediaBlocks(id))[0]!.hosted!))], [..."x bytes"].map((c) => c.charCodeAt(0)));

    // Nothing is left to do afterwards: no upload, no switch.
    await sync();
    const before = notion.calls.length;
    const settled = await imagesJson(state);
    const again = await sync();
    assert.deepEqual(again.plan.actions, []);
    assert.match(formatSummary(again.summary!, again.plan), /^Everything was already in sync\./);
    assert.deepEqual(notion.calls.slice(before).filter((c) => !/^(properties|listPages|relationTarget|getMarkdown)/.test(c)), []);
    assert.equal(await imagesJson(state), settled);
  });
}

test("a placeholder whose file is gone from the vault is reported each run until the file is back", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { ...app, "A.md": "Intro\n", [`${FOLDER}/x.png`]: "x bytes" });
  await sync();
  await writeFile(join(vault, "A.md"), `${await read("A.md")}\n![[x.png]]\n`);
  // The page gets the placeholder (the file is there for the translation), then the file vanishes before the switch.
  const real = notion.updateContent.bind(notion);
  notion.updateContent = async (id, edits) => {
    const markdown = await real(id, edits);
    await rm(join(vault, FOLDER, "x.png"));
    return markdown;
  };
  const first = await sync();
  notion.updateContent = real;
  assert.ok(first.summary!.skipped.some((s) => s.reason.startsWith("image_not_switched")), JSON.stringify(first.summary!.skipped));
  assert.equal(exitCode(first.summary, first.plan), 1);
  assert.match(pageNamed("A")!.markdown, /nopipeline\.invalid/);
  assert.ok(reasons(await sync()).includes("image_not_switched"));
  await writeFile(join(vault, FOLDER, "x.png"), "x bytes");
  const back = await sync();
  assert.deepEqual(back.summary!.skipped, []);
  assert.doesNotMatch(pageNamed("A")!.markdown, /nopipeline\.invalid/);
});

// A replaced file forgotten after a stopped run (final review, finding 5).
const v2Bytes = [..."v2 is longer"].map((c) => c.charCodeAt(0));

test("a run stopped between the push of a page citing the replaced file and the refresh still finds the file replaced next run", async (t) => {
  const { vault, state, notion, sync, read, pageNamed } = await setup(t);
  notion.addLinksTo();
  await writeTree(vault, { ...app, [`${FOLDER}/a.png`]: "v1", "A.md": "Links to [[B]]\n\n![[a.png]]\n", "B.md": "![[a.png]]\n" });
  await sync();
  await writeFile(join(vault, FOLDER, "a.png"), "v2 is longer");
  // A new caption on the image line: A's page is written whole, so the replaced file is attached again by the push.
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("![[a.png]]", "![[a.png|cap]]"));
  // The run is cut short by an error that is not Notion's after the push, where it fills the "Links to" relation.
  const relation = notion.setRelation.bind(notion);
  notion.setRelation = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(sync(), TypeError);
  notion.setRelation = relation;
  assert.deepEqual(await hostedBytes(notion, pageNamed("A")!.id), v2Bytes, "A's page shows the new file");
  assert.deepEqual(await hostedBytes(notion, pageNamed("B")!.id), [..."v1"].map((c) => c.charCodeAt(0)), "B's page still shows the old one");

  const next = await sync();
  assert.deepEqual(next.summary!.mediaUpdated, [{ path: `${FOLDER}/a.png`, pages: 2 }]);
  assert.deepEqual(await hostedBytes(notion, pageNamed("B")!.id), v2Bytes);
  assert.deepEqual(await hostedBytes(notion, pageNamed("A")!.id), v2Bytes);
  const entry = JSON.parse(await imagesJson(state)).images[`${FOLDER}/a.png`];
  assert.equal(entry.sha256, entry.uploadSha);
  assert.deepEqual((await sync()).summary!.mediaUpdated, []);
});

test("a refresh that fails with an error that is not Notion's leaves the file to be replaced again next run", async (t) => {
  const { vault, notion, sync, pageNamed } = await setup(t);
  await writeTree(vault, { ...app, [`${FOLDER}/a.png`]: "v1", "A.md": "![[a.png]]\n", "B.md": "![[a.png]]\n" });
  await sync();
  await writeFile(join(vault, FOLDER, "a.png"), "v2 is longer");
  const attach = notion.attachFile.bind(notion);
  let attached = 0;
  notion.attachFile = async (blockId, kind, uploadId) => {
    if (++attached === 2) throw new TypeError("fetch failed");
    return attach(blockId, kind, uploadId);
  };
  await assert.rejects(sync(), TypeError);
  notion.attachFile = attach;
  const retried = await sync();
  assert.deepEqual(retried.summary!.mediaUpdated, [{ path: `${FOLDER}/a.png`, pages: 2 }]);
  assert.deepEqual(await hostedBytes(notion, pageNamed("A")!.id), v2Bytes);
  assert.deepEqual(await hostedBytes(notion, pageNamed("B")!.id), v2Bytes);
  assert.deepEqual((await sync()).summary!.mediaUpdated, []);
});

test("a stored images.json from before the hash was split (one sha256 for both) still works: an unchanged file is neither uploaded nor refreshed again", async (t) => {
  const { vault, state, notion, sync } = await setup(t);
  await writeTree(vault, { ...app, [`${FOLDER}/a.png`]: "v1", "A.md": "![[a.png]]\n" });
  await sync();
  const saved = JSON.parse(await imagesJson(state));
  for (const image of Object.values(saved.images) as { uploadSha?: unknown }[]) delete image.uploadSha;
  delete saved.unattached;
  await writeFile(join(state, "images.json"), JSON.stringify(saved));
  const uploads = count(notion, "uploadFile");
  const outcome = await sync();
  assert.deepEqual(outcome.plan.actions, []);
  assert.deepEqual(outcome.summary!.mediaUpdated, []);
  assert.equal(count(notion, "uploadFile"), uploads);
});

// An image pasted into a Notion callout, toggle or quote (final review, finding 2).
for (const [label, open, close, written] of [
  ["callout", '<callout icon="💡">', "</callout>", "> [!tip]\n> inside\n>\n> ![](shot.png)"],
  ["toggle", "<details>\n<summary>T</summary>", "</details>", "> [!note]- T\n> inside\n>\n> ![](shot.png)"],
  ["quote", "> inside", "", "> inside\n>\n> ![](shot.png)"],
] as const) {
  test(`an image pasted into a ${label} in Notion is downloaded and cited inside it, and nothing changes afterwards`, async (t) => {
    const { vault, notion, sync, read, pageNamed } = await setup(t);
    await writeTree(vault, { ...app, "A.md": "Intro\n" });
    await sync();
    const id = pageNamed("A")!.id;
    notion.pasteImage(id, "Intro", "shot.png", pic(1, 2));
    const lines = pageNamed("A")!.markdown.split("\n");
    const k = lines.findIndex((l) => l.startsWith("!["));
    const inside = label === "quote" ? [open, `\t${lines[k]}`] : [open, "\tinside", `\t${lines[k]}`, close];
    lines.splice(k, 1, ...inside);
    notion.edit(id, { markdown: lines.join("\n") });

    const outcome = await sync();
    assert.deepEqual(outcome.summary!.done, { pull: 1 });
    assert.deepEqual([...(await readFile(join(vault, FOLDER, "shot.png")))], [1, 2]);
    const note = await read("A.md");
    assert.ok(note.endsWith(`Intro\n\n${written}\n`), note);
    assert.doesNotMatch(note, /nopipeline\.invalid/);
    // Quiet afterwards, and an Obsidian edit elsewhere in the note leaves the image in its page.
    assert.deepEqual((await sync()).plan.actions, []);
    assert.equal(await read("A.md"), note);
    await writeFile(join(vault, "A.md"), note.replace("Intro", "Introduction"));
    const pushed = await sync();
    assert.deepEqual(pushed.summary!.done, { push: 1 });
    assert.equal(await read("A.md"), note.replace("Intro", "Introduction"));
    assert.match(pageNamed("A")!.markdown, /prod-files-secure/);
    assert.deepEqual((await sync()).plan.actions, []);
  });
}

test("a web image's line is an ordinary line to Notion's search: an edit of it on a page with Notion-only blocks goes through update_content (final review 9)", async (t) => {
  const { notion, sync, read, vault, pageNamed } = await setup(t);
  const id = notion.add("Web", "<table_of_contents/>\nIntro\n![old](https://example.com/a.png)\nOutro");
  await sync();
  const text = await read("0-In/Web.md");
  assert.match(text, /!\[old\]\(https:\/\/example\.com\/a\.png\)/);
  await writeFile(join(vault, "0-In/Web.md"), text.replace("![old]", "![new]"));
  notion.calls.length = 0;
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual(outcome.summary!.done, { push: 1 });
  assert.equal(notion.calls.filter((c) => c.startsWith("replaceContent")).length, 0);
  assert.equal(notion.calls.filter((c) => c.startsWith("updateContent")).length, 1);
  assert.match(pageNamed("Web")!.markdown, /^<table_of_contents\/>\nIntro\n!\[new\]\(https:\/\/example\.com\/a\.png\)\nOutro$/);
  assert.equal(pageNamed("Web")!.id, id);
});

test("a Notion edit beside a list-item image is pulled and the note's - ![[a.png]] line is kept as written; deleting the item takes the line with it (ledger: list-item citations)", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { ...app, [`${FOLDER}/a.png`]: "v1", "A.md": "Intro\n\n- one\n- ![[a.png]]\n- two\n\nOutro\n" });
  await sync();
  const page = pageNamed("A")!;
  const first = await read("A.md");
  notion.edit(page.id, { markdown: page.markdown.replace("- one", "- one, edited").replace("- two", "- two, edited") });
  const edited = await sync();
  assert.deepEqual(edited.summary!.skipped, []);
  assert.deepEqual(edited.summary!.done, { pull: 1 });
  assert.equal(await read("A.md"), first.replace("- one", "- one, edited").replace("- two", "- two, edited"));
  assert.deepEqual((await sync()).plan.actions, []);
  // The item and its image deleted in Notion: the note loses the list-item line, and the image's file goes to .trash.
  const now = pageNamed("A")!;
  notion.edit(now.id, { markdown: now.markdown.replace(/-\n\t!\[\]\([^)]*\)\n/, "") });
  const deleted = await sync();
  assert.deepEqual(deleted.summary!.skipped, []);
  assert.equal(await read("A.md"), first.replace("- one", "- one, edited").replace("- two", "- two, edited").replace("- ![[a.png]]\n", ""));
  assert.deepEqual(deleted.summary!.mediaMoved, [`${FOLDER}/a.png`]);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("after the records are lost, a note citing images as ![[x.png]] pairs quietly with its page that holds them as images (final review 13)", async (t) => {
  const { vault, state, notion, sync, read, pageNamed } = await setup(t);
  const note = "Intro\n\n![[a.png]]\n\n- one\n- ![[a.png|a cap]]\n\nOutro\n";
  await writeTree(vault, { ...app, [`${FOLDER}/a.png`]: "v1", "A.md": note });
  await sync();
  const text = await read("A.md");
  const markdown = pageNamed("A")!.markdown;
  await rm(join(state, "records"), { recursive: true });
  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.plan.actions, [{ kind: "pair", pageId: pageNamed("A")!.id, path: "A.md", same: true }]);
  notion.calls.length = 0;
  const paired = await sync();
  assert.deepEqual(paired.summary!.done, { pair: 1 });
  assert.deepEqual(paired.summary!.conflicts, []);
  assert.deepEqual(notion.calls.filter((call) => /^(replaceContent|updateContent|uploadFile|attachFile)/.test(call)), []);
  assert.equal(pageNamed("A")!.markdown, markdown);
  assert.equal(await read("A.md"), text);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a pasted image whose name has no extension is not downloaded, its page is not held, and the warning says what to do every run", async (t) => {
  const { vault, notion, sync, read, id } = await syncedWithPage(t);
  notion.pasteImage(id, "Intro", "scan", pic(1, 2, 3));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual(outcome.summary!.done, { pull: 1 }, "the page is not held");
  const [warning] = outcome.plan.warnings;
  assert.match(warning!, /^A\.md: .*"scan".*rename it in Notion/is);
  assert.match(await read("A.md"), /!\[\]\(https:\/\/prod-files-secure[^)\s?#]*scan\)/);
  assert.deepEqual(await readdir(join(vault, "Assets")).catch(() => []), []);
  const quiet = await sync();
  assert.deepEqual(quiet.plan.actions, []);
  assert.equal(quiet.plan.warnings.length, 1);
});

test("a pasted file whose name no note can cite (notes.md) is left as a link in the note, its page is not held, and the warning says what to do (final review 7)", async (t) => {
  const { vault, notion, sync, read, id, pageNamed } = await syncedWithPage(t);
  notion.pasteFile(id, "Intro", "file", "notes.md", pic(1, 2, 3));
  const dry = await sync({ dryRun: true });
  assert.match(dry.plan.warnings.join("\n"), /notes\.md/);
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual(outcome.summary!.done, { pull: 1 }, "the page is not held");
  assert.equal(exitCode(outcome.summary, outcome.plan), 0);
  const [warning] = outcome.plan.warnings;
  assert.match(warning!, /^A\.md: .*notes\.md.*rename.*\.pdf/is);
  assert.doesNotMatch(warning!, /next run/);
  assert.match(await read("A.md"), /^---\nnotion-id: \S+\n---\nIntro\n\n<file src="https:\/\/prod-files-secure[^"?#]*notes\.md"><\/file>\n$/);
  assert.deepEqual(await readdir(join(vault, "Assets")).catch(() => []), []);
  // Other changes keep flowing both ways, and the link stays as it is, with the warning each run.
  const text = await read("A.md");
  await writeFile(join(vault, "A.md"), text.replace("Intro", "Intro, edited"));
  const pushed = await sync();
  assert.deepEqual(pushed.summary!.done, { push: 1 });
  assert.match(pageNamed("A")!.markdown, /^Intro, edited\n<file src="https:\/\/prod-files-secure[^"]*notes\.md[^"]*"><\/file>$/);
  const quiet = await sync();
  assert.deepEqual(quiet.plan.actions, []);
  assert.equal(quiet.plan.warnings.length, 1);
  assert.match(formatSummary(quiet.summary!, quiet.plan), /^Everything was already in sync\.\nwarning: A\.md: /);
});

test("a download Notion keeps refusing holds its page with a message that promises nothing but says what to do (final review 7)", async (t) => {
  const { notion, sync, id } = await syncedWithPage(t);
  notion.pasteImage(id, "Intro", "shot.png", pic(1));
  notion.downloadTo = async () => {
    throw new NotionPageError("download_failed", "downloading the file answered 403");
  };
  const failed = await sync();
  const [skipped] = failed.summary!.skipped;
  assert.match(skipped!.reason, /^download_failed: .*shot\.png.*403/);
  assert.match(skipped!.reason, /until (the file|it) can be downloaded/);
  assert.match(skipped!.reason, /replace the file in Notion/);
  assert.doesNotMatch(skipped!.reason, /syncs next run/);
  const dry = await sync({ dryRun: true });
  assert.match(dry.mediaPlan!.join("\n"), /can't download shot\.png for A\.md.*403.*left alone until/);
});

test("a dry run lists the uploads a real run makes, once per file, and the real run's summary counts them (final review 6)", async (t) => {
  const { vault, state, notion, sync, read } = await setup(t);
  await writeTree(vault, {
    ...app,
    [`${FOLDER}/a.png`]: "A1",
    [`${FOLDER}/b.png`]: "B1",
    [`${FOLDER}/c.png`]: "C1",
    "A.md": "![[a.png]]\n\ntext\n\n![[a.png|again]]\n",
    "B.md": "- ![[a.png]]\n- ![[b.png]]\n\n![[missing.png]]\n",
  });
  const saved = await imagesJson(state).catch(() => null);
  const dry = await sync({ dryRun: true });
  assert.deepEqual(
    dry.mediaPlan!.filter((line) => line.startsWith("upload")),
    [`upload ${FOLDER}/a.png for A.md`, `upload ${FOLDER}/b.png for B.md`],
    "one line per file, for the first note that needs it; c.png is cited by no note and a missing file is no upload",
  );
  assert.equal(count(notion, "uploadFile"), 0, "a dry run uploads nothing");
  assert.equal(await imagesJson(state).catch(() => null), saved);

  const real = await sync();
  assert.equal(count(notion, "uploadFile"), 2);
  assert.equal(real.summary!.mediaUploaded, 2);
  assert.match(formatSummary(real.summary!, real.plan), /^Done:\n(?:.*\n)*? {2}uploaded 2 files$/m);

  // Quiet again: nothing to upload, nothing to count.
  const quiet = await sync({ dryRun: true });
  assert.deepEqual(quiet.mediaPlan ?? [], []);
  const nothing = await sync();
  assert.equal(nothing.summary!.mediaUploaded, 0);
  assert.match(formatSummary(nothing.summary!, nothing.plan), /^Everything was already in sync\./);

  // A new citation of a file already uploaded reuses the upload; a file never uploaded is one.
  await writeFile(join(vault, "A.md"), `${await read("A.md")}\n![[b.png]]\n\n![[c.png]]\n`);
  const next = await sync({ dryRun: true });
  assert.deepEqual(next.mediaPlan, [`upload ${FOLDER}/c.png for A.md`]);
  const again = await sync();
  assert.equal(again.summary!.mediaUploaded, 1);
  assert.match(formatSummary(again.summary!, again.plan), / {2}uploaded 1 file$/m);
});

test("a changed file that no page gets as a new block is not an upload of the dry run (it is 'update file'), and a pasted-in-Notion image cited again elsewhere is", async (t) => {
  const { vault, notion, sync } = await setup(t);
  await writeTree(vault, { ...app, "A.md": "Intro\n", "B.md": "Other\n" });
  await sync();
  const a = [...notion.pages.values()].find((p) => p.title === "A")!;
  notion.pasteImage(a.id, "Intro", "shot.png", pic(1, 2, 3));
  await sync();
  // B cites the downloaded file: its page needs a block, and the file Notion hosts was never uploaded by the sync.
  await writeFile(join(vault, "B.md"), "Other\n\n![](shot.png)\n");
  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.mediaPlan, [`upload ${FOLDER}/shot.png for B.md`]);
  assert.deepEqual((await sync()).summary!.mediaUploaded, 1);
});

test("removing an image in Obsidian on a page that holds Notion-only blocks is refused with a reason that names the images, and the page stays (final review 8)", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { ...app, [`${FOLDER}/a.png`]: "A", "A.md": "Intro\n\n![[a.png]]\n\nOutro\n" });
  await sync();
  const id = pageNamed("A")!.id;
  notion.edit(id, { markdown: `<table_of_contents/>\n${pageNamed("A")!.markdown}` });
  await sync();
  const text = await read("A.md");
  // Text beside the image still goes through update_content, whatever else the page holds.
  await writeFile(join(vault, "A.md"), text.replace("Outro", "Outro, edited"));
  const beside = await sync();
  assert.deepEqual(beside.summary!.skipped, []);
  assert.match(pageNamed("A")!.markdown, /Outro, edited$/);
  // The image itself removed: Notion can't find its line, and replacing the page would lose the contents block.
  const edited = await read("A.md");
  await writeFile(join(vault, "A.md"), edited.replace("![[a.png]]\n\n", ""));
  const markdown = pageNamed("A")!.markdown;
  notion.calls.length = 0;
  const refused = await sync();
  assert.deepEqual(reasons(refused), ["unsupported_blocks"]);
  const reason = refused.summary!.skipped[0]!.reason;
  assert.match(reason, /image/i);
  assert.match(reason, /make this edit in Notion/);
  assert.match(reason, /undo it in Obsidian/);
  assert.equal(pageNamed("A")!.markdown, markdown, "nothing was written");
  assert.equal(notion.calls.filter((c) => /^(replaceContent|updateContent)/.test(c)).length, 0, "no write was tried");
  assert.match(pageNamed("A")!.markdown, /!\[\]\(https:\/\/prod-files-secure[^)]*a\.png/, "the image is still on the page");
  assert.equal(await read("A.md"), edited.replace("![[a.png]]\n\n", ""), "the note keeps the edit");
});

// PDFs, audio, video and files pasted in Notion (attachments design §2.2, §2.4, §5.4, §5.9, §5.10).
test("a PDF pasted in Notion is downloaded with its bytes and cited as an embed; nothing changes afterwards", async (t) => {
  const { vault, notion, sync, read, id } = await syncedWithPage(t);
  notion.pasteFile(id, "Intro", "pdf", "Manual.pdf", pic(37, 80, 68, 70));
  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.mediaPlan, ["download Manual.pdf for A.md"]);
  assert.deepEqual(await readdir(join(vault, "Assets")).catch(() => []), [], "a dry run downloads nothing into the vault");
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { pull: 1 });
  assert.deepEqual([...(await readFile(join(vault, FOLDER, "Manual.pdf")))], [37, 80, 68, 70]);
  assert.match(await read("A.md"), /^---\nnotion-id: \S+\n---\nIntro\n\n!\[\]\(Manual\.pdf\)\n$/);
  assert.deepEqual(outcome.mediaPlan, ["downloaded 1 PDF"]);
  assert.deepEqual(await readdir(join(vault, FOLDER)), ["Manual.pdf"], "no temporary file is left in the folder");
  // Nothing changes again: no download, no write, no page request beyond the reads.
  const before = notion.calls.length;
  const text = await read("A.md");
  assert.deepEqual((await sync()).plan.actions, []);
  assert.equal(await read("A.md"), text);
  assert.deepEqual(notion.calls.slice(before).filter((c) => !/^(properties|listPages|relationTarget)/.test(c)), []);
});

test("a PDF block with a caption comes back as an embed with it, and the note's own edit goes back to the same block", async (t) => {
  const { vault, notion, sync, read, id, pageNamed } = await syncedWithPage(t);
  notion.pasteFile(id, "Intro", "pdf", "Manual.pdf", pic(1, 2), "the handbook");
  await sync();
  assert.match(await read("A.md"), /\n!\[the handbook\]\(Manual\.pdf\)\n$/);
  const [block] = await notion.mediaBlocks(id);
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("Intro", "Intro, edited"));
  const pushed = await sync();
  assert.deepEqual(pushed.summary!.done, { push: 1 });
  assert.deepEqual((await notion.mediaBlocks(id)).map((b) => [b.id, b.kind]), [[block!.id, "pdf"]], "the block that was there");
  assert.match(pageNamed("A")!.markdown, /^Intro, edited\n/);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a file block pasted in Notion is downloaded and cited as a link with the file's name", async (t) => {
  const { vault, notion, sync, read, id } = await syncedWithPage(t);
  notion.pasteFile(id, "Intro", "file", "x.docx", pic(80, 75, 3, 4));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { pull: 1 });
  assert.deepEqual([...(await readFile(join(vault, FOLDER, "x.docx")))], [80, 75, 3, 4]);
  assert.match(await read("A.md"), /^---\nnotion-id: \S+\n---\nIntro\n\n\[x\.docx\]\(x\.docx\)\n$/);
  assert.deepEqual(outcome.mediaPlan, ["downloaded 1 file"]);
  const text = await read("A.md");
  const before = notion.calls.length;
  assert.deepEqual((await sync()).plan.actions, []);
  assert.equal(await read("A.md"), text);
  assert.deepEqual(notion.calls.slice(before).filter((c) => !/^(properties|listPages|relationTarget)/.test(c)), []);
});

test("audio and video blocks come back as embeds, a captioned file block as a link with its caption; one run says how many files", async (t) => {
  const { vault, notion, sync, read, id } = await syncedWithPage(t);
  notion.pasteFile(id, "Intro", "audio", "song.mp3", pic(1));
  notion.pasteFile(id, "Intro", "video", "clip.mp4", pic(2), "the lecture");
  notion.pasteFile(id, "Intro", "file", "figures.xlsx", pic(3), "the figures");
  const dry = await sync({ dryRun: true });
  assert.deepEqual([...dry.mediaPlan!].sort(), ["download clip.mp4 for A.md", "download figures.xlsx for A.md", "download song.mp3 for A.md"]);
  const outcome = await sync();
  assert.deepEqual(outcome.mediaPlan, ["downloaded 3 files"]);
  assert.deepEqual((await readdir(join(vault, FOLDER))).sort(), ["clip.mp4", "figures.xlsx", "song.mp3"]);
  const text = await read("A.md");
  assert.ok(text.includes("\n![](song.mp3)\n"), text);
  assert.ok(text.includes("\n![the lecture](clip.mp4)\n"), text);
  assert.ok(text.includes("\n[the figures](figures.xlsx)\n"), text);
  assert.deepEqual((await sync()).plan.actions, []);
  assert.equal(await read("A.md"), text);
});

test("a video over the upload limit is downloaded whole (streamed), keeps its block and is not reported when the note is edited", async (t) => {
  const { vault, notion, sync, read, id, pageNamed } = await syncedWithPage(t);
  const big = new Uint8Array(21 * 1024 * 1024);
  big[5] = 5;
  notion.pasteFile(id, "Intro", "video", "big.mp4", big);
  notion.calls.length = 0;
  const first = await sync();
  assert.deepEqual(first.plan.warnings, []);
  assert.ok(notion.calls.includes("downloadTo") && !notion.calls.includes("download"), "streamed to disk");
  assert.equal((await readFile(join(vault, FOLDER, "big.mp4"))).length, big.length);
  assert.match(await read("A.md"), /\n!\[\]\(big\.mp4\)\n$/);
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("Intro", "Intro, edited"));
  const before = notion.calls.length;
  const pushed = await sync();
  assert.deepEqual(pushed.plan.warnings, []);
  assert.equal(notion.calls.slice(before).filter((c) => /^(uploadFile|attachFile)/.test(c)).length, 0);
  assert.match(pageNamed("A")!.markdown, /^Intro, edited\n<video src="https:\/\/prod-files-secure[^"]*big\.mp4/);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("an image block holding a file whose name isn't an image's (scan.avif) is downloaded as the file it is and stays quiet", async (t) => {
  const { vault, notion, sync, read, id } = await syncedWithPage(t);
  notion.pasteImage(id, "Intro", "scan.avif", pic(1, 2, 3));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual([...(await readFile(join(vault, FOLDER, "scan.avif")))], [1, 2, 3]);
  assert.match(await read("A.md"), /\n!\[\]\(scan\.avif\)\n$/);
  const text = await read("A.md");
  assert.deepEqual((await sync()).plan.actions, []);
  assert.equal(await read("A.md"), text);
});

test("a file block holding a png comes back as a link and stays a file block when the note is edited", async (t) => {
  const { vault, notion, sync, read, id } = await syncedWithPage(t);
  notion.pasteFile(id, "Intro", "file", "shot.png", pic(9, 9));
  await sync();
  assert.match(await read("A.md"), /\n\[shot\.png\]\(shot\.png\)\n$/);
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("Intro", "Intro, edited"));
  await sync();
  assert.deepEqual((await notion.mediaBlocks(id)).map((b) => b.kind), ["file"]);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a PDF the user pastes twice and a same-named file with other bytes are two files, numbered as images are", async (t) => {
  const { vault, notion, sync, read, id } = await syncedWithPage(t);
  notion.pasteFile(id, "Intro", "pdf", "Manual.pdf", pic(1));
  notion.pasteFile(id, "Intro", "pdf", "Manual.pdf", pic(1));
  notion.pasteFile(id, "Intro", "file", "Manual.pdf", pic(2));
  await sync();
  assert.deepEqual((await readdir(join(vault, FOLDER))).sort(), ["Manual 1.pdf", "Manual.pdf"]);
  const cited = (await read("A.md")).match(/\(Manual( 1)?\.pdf\)|\(Manual%201\.pdf\)/g)!;
  assert.equal(cited.length, 3);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("the Manual form: a note holding <pdf src=hosted?> twice ends citing the two downloaded PDFs, and the page is not touched (spec §2.4)", async (t) => {
  const { vault, state, notion, sync, read } = await setup(t);
  await writeTree(vault, app);
  const id = notion.add("Leaflet", "Intro");
  notion.pasteFile(id, "Intro", "pdf", "Manual.pdf", pic(1, 1));
  notion.pasteFile(id, "Intro", "pdf", "Sheet.pdf", pic(2, 2));
  const signed = (await notion.getMarkdown(id)).markdown.split("\n").filter((l) => l.startsWith("<pdf "));
  assert.equal(signed.length, 2);
  // The note line as the sync once wrote it: the signature already stripped down to `?`.
  const stripped = signed.map((l) => l.replace(/\?[^"]*"/, '?"'));
  assert.ok(stripped.every((l) => /^<pdf src="https:\/\/prod-files-secure[^"?]*\.pdf\?"><\/pdf>$/.test(l)), stripped.join("\n"));
  const note = `---\nnotion-id: ${id}\n---\nIntro\n${stripped.join("\n")}\n`;
  await writeTree(vault, { "Leaflet.md": note });
  await mkdir(join(state, "records"), { recursive: true });
  await writeFile(
    join(state, "records", `${id}.json`),
    JSON.stringify({ notionId: id, path: "Leaflet.md", title: "Leaflet", folder: null, obsidianText: note, notionMarkdown: `Intro\n${signed.join("\n")}`, notionSeenAt: "2026-09-27T10:01:00.000Z", syncedAt: "2026-09-27T10:01:00.000Z" }),
  );
  const pageBefore = notion.pages.get(id)!.markdown;
  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.plan.actions.map((a) => a.kind), ["convertImages"]);
  assert.deepEqual([...dry.mediaPlan!].sort(), ["download Manual.pdf for Leaflet.md", "download Sheet.pdf for Leaflet.md"]);
  assert.match(formatPlan(dry.plan, dry.notes, dry.pages), /\(2 images\)|\(2 files\)/);
  assert.equal(await read("Leaflet.md"), note);
  assert.deepEqual(await readdir(join(vault, "Assets")).catch(() => []), []);
  notion.calls.length = 0;
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { convertImages: 1 });
  // The page lists the PDFs last-pasted first; the note keeps that order.
  assert.equal(await read("Leaflet.md"), `---\nnotion-id: ${id}\n---\nIntro\n![](Sheet.pdf)\n![](Manual.pdf)\n`);
  assert.deepEqual([...(await readFile(join(vault, FOLDER, "Manual.pdf")))], [1, 1]);
  assert.deepEqual([...(await readFile(join(vault, FOLDER, "Sheet.pdf")))], [2, 2]);
  assert.equal(notion.pages.get(id)!.markdown, pageBefore, "the page is unchanged");
  assert.deepEqual(notion.calls.filter((c) => /^(update|replace)Content|mediaBlocks|attachFile|uploadFile/.test(c)), []);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("image-era state is quiet: a store, records and vault written by the image feature plan nothing and touch nothing", async (t) => {
  const { vault, state, notion, sync, read } = await setup(t);
  await writeTree(vault, { ...app, [`${FOLDER}/a.png`]: "A", [`${FOLDER}/b.png`]: "B", "N.md": "Intro\n\n![[a.png]]\n\nand\n\n![b](b.png)\n", "M.md": "plain\n" });
  await sync();
  await sync();
  // The store as the image feature wrote it: no `unattached` list, entries without the upload hash split.
  const file = join(state, "images.json");
  const stored = JSON.parse(await readFile(file, "utf8"));
  delete stored.unattached;
  for (const entry of Object.values(stored.images) as { uploadSha?: string }[]) delete entry.uploadSha;
  await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);
  const files = async () => Object.fromEntries(await Promise.all([...(await readdir(join(state, "records"))), ].map(async (f) => [f, await readFile(join(state, "records", f), "utf8")])));
  const storeBefore = await readFile(file, "utf8");
  const [vaultBefore, recordsBefore, pagesBefore] = [await read("N.md"), await files(), JSON.stringify([...notion.pages.values()])];
  notion.calls.length = 0;
  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.plan.actions, []);
  assert.deepEqual(dry.mediaPlan ?? [], []);
  const quiet = await sync();
  assert.deepEqual(quiet.plan.actions, []);
  assert.deepEqual(quiet.plan.warnings, []);
  assert.equal(quiet.mediaPlan, undefined);
  assert.equal(formatSummary(quiet.summary!, quiet.plan), "Everything was already in sync.");
  assert.equal(quiet.summary!.mediaUploaded, 0);
  assert.equal(await read("N.md"), vaultBefore);
  assert.deepEqual(await files(), recordsBefore);
  assert.equal(await readFile(file, "utf8"), storeBefore, "the store is not saved again");
  assert.equal(JSON.stringify([...notion.pages.values()]), pagesBefore);
  assert.deepEqual(notion.calls.filter((c) => /^(update|replace)Content|attachFile|uploadFile|download|create|trash/i.test(c)), []);
});

test("a pasted PDF or file whose name has no extension is not downloaded, its page is not held, and the page's other changes go through", async (t) => {
  const { vault, notion, sync, read, id, pageNamed } = await syncedWithPage(t);
  notion.pasteFile(id, "Intro", "pdf", "Manual", pic(1));
  notion.pasteFile(id, "Intro", "file", "NOTICE", pic(2));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual(outcome.summary!.done, { pull: 1 }, "the page is not held");
  assert.equal(outcome.plan.warnings.length, 2);
  assert.match(outcome.plan.warnings.join("\n"), /"Manual"[\s\S]*"NOTICE"|"NOTICE"[\s\S]*"Manual"/);
  for (const warning of outcome.plan.warnings) assert.match(warning, /^A\.md: .*rename it in Notion/is);
  assert.deepEqual(await readdir(join(vault, "Assets")).catch(() => []), []);
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("Intro", "Intro, edited"));
  const pushed = await sync();
  assert.deepEqual(pushed.summary!.done, { push: 1 });
  assert.match(pageNamed("A")!.markdown, /^Intro, edited\n/);
  assert.equal(pageNamed("A")!.markdown.split("\n").filter((l) => /prod-files-secure/.test(l)).length, 2, "both blocks are still there");
  // Renamed in Notion (a block with the same file under a name that has an extension), the file comes down.
  notion.edit(id, { markdown: "Intro, edited" });
  notion.pasteFile(id, "Intro, edited", "pdf", "Manual.pdf", pic(1));
  const renamed = await sync();
  assert.deepEqual(renamed.plan.warnings, []);
  assert.deepEqual(await readdir(join(vault, FOLDER)), ["Manual.pdf"]);
});

// Uploads Notion refuses (attachments design §5.11).
test("a file Notion refuses stays literal, the page's other changes go through, and the warning comes every run until the citation changes", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  notion.refusedTypes.add("audio/3gpp");
  await writeTree(vault, { ...app, [`${FOLDER}/memo.3gp`]: "3gp bytes", [`${FOLDER}/ok.mp3`]: "mp3 bytes", "A.md": "Intro\n\n![[memo.3gp]]\n\n![[ok.mp3]]\n\nOutro\n" });
  const dry = await sync({ dryRun: true });
  assert.ok(dry.mediaPlan!.includes("upload Assets/pictures/memo.3gp for A.md"), "a preview can't know it will be refused");
  const first = await sync();
  assert.deepEqual(first.summary!.skipped, []);
  assert.deepEqual((await notion.mediaBlocks(pageNamed("A")!.id)).map((b) => b.kind), ["audio"], "the accepted file is a block");
  const warning = /^can't upload Assets\/pictures\/memo\.3gp: .*audio\/3gpp.*; in Notion the line that cites it \(in A\.md\) stays text, or the file it held before, until the citation changes$/i;
  assert.equal(first.plan.warnings.filter((w) => warning.test(w)).length, 1, first.plan.warnings.join("\n"));
  assert.equal(exitCode(first.summary, first.plan), 0);
  // Quiet runs say it again: the citation hasn't changed.
  const second = await sync();
  assert.deepEqual(second.plan.actions, []);
  assert.equal(second.plan.warnings.filter((w) => warning.test(w)).length, 1, "said again on a quiet run");
  assert.match(formatSummary(second.summary!, second.plan), /^Everything was already in sync\.\nwarning: can't upload /);
  const dry2 = await sync({ dryRun: true });
  assert.equal(dry2.plan.warnings.filter((w) => warning.test(w)).length, 1, "and in a preview");
  // The page's other edits keep flowing, and the warning stays.
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("Outro", "Outro, edited"));
  const pushed = await sync();
  assert.deepEqual(pushed.summary!.done, { push: 1 });
  assert.match(pageNamed("A")!.markdown, /Outro, edited$/);
  assert.equal(pushed.plan.warnings.filter((w) => warning.test(w)).length, 1);
  // The citation removed: no more warning.
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("![[memo.3gp]]\n\n", ""));
  const removed = await sync();
  assert.deepEqual(removed.plan.warnings, []);
  assert.deepEqual((await sync()).plan.warnings, []);
});

test("a dry run lists the uploads of PDFs, audio, video and files a real run makes, once per file", async (t) => {
  const { vault, notion, sync } = await setup(t);
  await writeTree(vault, {
    ...app,
    [`${FOLDER}/Manual.pdf`]: "%PDF-1",
    [`${FOLDER}/minutes.docx`]: "docx",
    [`${FOLDER}/lecture.mp4`]: "mp4",
    "A.md": "Intro\n\n![[Manual.pdf]]\n\n[[minutes.docx]]\n\n![[lecture.mp4]]\n\n![[Manual.pdf]]\n",
  });
  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.mediaPlan, [`upload ${FOLDER}/Manual.pdf for A.md`, `upload ${FOLDER}/minutes.docx for A.md`, `upload ${FOLDER}/lecture.mp4 for A.md`]);
  assert.equal(notion.pages.size, 0);
  const real = await sync();
  assert.equal(real.summary!.mediaUploaded, 3);
  assert.deepEqual((await sync({ dryRun: true })).mediaPlan ?? [], []);
});

// A line whose kind differs from the block Notion holds (attachments design §5.9): the block is replaced by one of the new kind.
test("a Notion file block holding a PDF whose note line becomes an embed is replaced by a PDF block, and a caption edit on it goes through", async (t) => {
  const { vault, notion, sync, read, id, pageNamed } = await syncedWithPage(t);
  notion.pasteFile(id, "Intro", "file", "Manual.pdf", pic(1, 2));
  await sync();
  assert.match(await read("A.md"), /\n\[Manual\.pdf\]\(Manual\.pdf\)\n$/);
  assert.deepEqual((await notion.mediaBlocks(id)).map((b) => b.kind), ["file"]);
  // The user turns the link into an embed in Obsidian.
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("[Manual.pdf](Manual.pdf)", "![the handbook](Manual.pdf)"));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual(outcome.summary!.done, { push: 1 });
  const blocks = await notion.mediaBlocks(id);
  assert.deepEqual(blocks.map((b) => b.kind), ["pdf"], "one block, of the new kind");
  assert.deepEqual([...(await notion.download(blocks[0]!.hosted!))], [1, 2], "the same bytes");
  assert.match(pageNamed("A")!.markdown, /<pdf src="https:\/\/prod-files-secure[^"]*Manual\.pdf[^"]*">the handbook<\/pdf>/);
  assert.deepEqual((await sync()).plan.actions, []);
  // And back to a link.
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("![the handbook](Manual.pdf)", "[Manual.pdf](Manual.pdf)"));
  assert.deepEqual((await sync()).summary!.skipped, []);
  assert.deepEqual((await notion.mediaBlocks(id)).map((b) => b.kind), ["file"]);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("an image block whose file's note line becomes a link is replaced by a file block, and the image's own caption edit goes through", async (t) => {
  const { vault, notion, sync, read, id } = await syncedWithPage(t);
  notion.pasteImage(id, "Intro", "shot.png", pic(5));
  await sync();
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("![](shot.png)", "[the capture](shot.png)"));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual((await notion.mediaBlocks(id)).map((b) => b.kind), ["file"]);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("an image block holding a PDF (pasted so in Notion): a caption edit on its line replaces the block by a PDF block instead of being refused", async (t) => {
  const { vault, notion, sync, read, id, pageNamed } = await syncedWithPage(t);
  notion.pasteImage(id, "Intro", "Manual.pdf", pic(1, 2, 3));
  await sync();
  assert.match(await read("A.md"), /\n!\[\]\(Manual\.pdf\)\n$/);
  assert.deepEqual((await notion.mediaBlocks(id)).map((b) => b.kind), ["image"]);
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("![](Manual.pdf)", "![the handbook](Manual.pdf)"));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual(outcome.summary!.done, { push: 1 });
  const blocks = await notion.mediaBlocks(id);
  assert.deepEqual(blocks.map((b) => b.kind), ["pdf"]);
  assert.deepEqual([...(await notion.download(blocks[0]!.hosted!))], [1, 2, 3]);
  assert.match(pageNamed("A")!.markdown, /<pdf src="https:\/\/prod-files-secure[^"]*Manual\.pdf[^"]*">the handbook<\/pdf>/);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("an avif image block is an image: its line keeps its kind and a caption edit goes through", async (t) => {
  const { vault, notion, sync, read, id, pageNamed } = await syncedWithPage(t);
  notion.pasteImage(id, "Intro", "scan.avif", pic(1, 2, 3));
  await sync();
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("![](scan.avif)", "![a caption](scan.avif)"));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual(outcome.summary!.done, { push: 1 });
  assert.deepEqual((await notion.mediaBlocks(id)).map((b) => b.kind), ["image"]);
  assert.match(pageNamed("A")!.markdown, /!\[a caption\]\(https:\/\/prod-files-secure[^)]*scan\.avif/);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("an image block holding a docx: a caption edit on its embed replaces the block by a file block instead of being refused", async (t) => {
  const { vault, notion, sync, read, id } = await syncedWithPage(t);
  notion.pasteImage(id, "Intro", "plan.docx", pic(4, 5));
  await sync();
  assert.match(await read("A.md"), /\n!\[\]\(plan\.docx\)\n$/);
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("![](plan.docx)", "![the plan](plan.docx)"));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual(outcome.summary!.done, { push: 1 });
  const blocks = await notion.mediaBlocks(id);
  assert.deepEqual(blocks.map((b) => b.kind), ["file"]);
  assert.deepEqual([...(await notion.download(blocks[0]!.hosted!))], [4, 5]);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a refusal ends with the success that fixes it: once the file is uploaded, no run warns about it", async (t) => {
  const { vault, state, notion, sync, read, pageNamed } = await setup(t);
  notion.refusedTypes.add("audio/3gpp");
  await writeTree(vault, { ...app, [`${FOLDER}/memo.3gp`]: "3gp bytes", "A.md": "Intro\n\n![[memo.3gp]]\n" });
  const refused = await sync();
  assert.equal(refused.plan.warnings.filter((w) => /^can't upload /.test(w)).length, 1);
  assert.equal((await sync()).plan.warnings.filter((w) => /^can't upload /.test(w)).length, 1);
  // Notion takes the type now, and the citation is touched: the push uploads the file.
  notion.refusedTypes.clear();
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("![[memo.3gp]]", "![[memo.3gp|the voice]]"));
  const fixed = await sync();
  assert.deepEqual(fixed.summary!.skipped, []);
  assert.deepEqual((await notion.mediaBlocks(pageNamed("A")!.id)).map((b) => b.kind), ["audio"]);
  assert.deepEqual(fixed.plan.warnings, [], "not even on the run that fixed it");
  const quiet = await sync();
  assert.deepEqual(quiet.plan.warnings, []);
  assert.equal(formatSummary(quiet.summary!, quiet.plan), "Everything was already in sync.");
  assert.equal("refused" in JSON.parse(await readFile(join(state, "images.json"), "utf8")), false, "nothing stored");
});

// Moved and renamed attachments are recognized by their bytes (attachments design §5.6, §5.12).
const MEDIA = "Assets/attachments";
const MOVED = (from: string, to: string) => `  moved: ${from} → ${to}`;
/** Everything that a Notion write or transfer would show in the fake's calls. */
const writes = (notion: FakeNotion, since: number) => notion.calls.slice(since).filter((c) => /^(update|replace)Content|attachFile|uploadFile|download|create|trash|setTitle/i.test(c));
const recordFiles = async (state: string) =>
  Object.fromEntries(await Promise.all((await readdir(join(state, "records"))).map(async (f) => [f, await readFile(join(state, "records", f), "utf8")])));

/** Three synced images cited by one note, and a file never synced (kx.png). */
async function syncedFolder(t: import("node:test").TestContext) {
  const env = await setup(t);
  await writeTree(env.vault, {
    ...app,
    [`${FOLDER}/a.png`]: "AAA",
    [`${FOLDER}/b.png`]: "BBBB",
    [`${FOLDER}/c.png`]: "CCCCC",
    [`${FOLDER}/kx.png`]: "never synced",
    "N.md": "Intro\n\n![[a.png]]\n\n![[b.png]]\n\n- ![[c.png]]\n",
  });
  await env.sync();
  return env;
}

test("a file moved to another folder, its citation by name unchanged, is re-keyed: nothing is pushed, uploaded or downloaded", async (t) => {
  const { vault, state, notion, sync, read } = await syncedFolder(t);
  await mkdir(join(vault, "Pics"));
  await rename(join(vault, FOLDER, "a.png"), join(vault, "Pics", "a.png"));
  const [note, pages, before] = [await read("N.md"), JSON.stringify([...notion.pages.values()]), notion.calls.length];
  const outcome = await sync();
  assert.deepEqual(outcome.plan.actions, []);
  assert.equal(outcome.summary!.mediaUploaded, 0);
  assert.deepEqual(outcome.summary!.mediaMoved, []);
  assert.equal(formatSummary(outcome.summary!, outcome.plan), `Everything was already in sync.\n${MOVED(`${FOLDER}/a.png`, "Pics/a.png")}`);
  assert.deepEqual(writes(notion, before), []);
  assert.equal(await read("N.md"), note);
  assert.equal(JSON.stringify([...notion.pages.values()]), pages);
  assert.deepEqual(await trashed(vault), []);
  const stored = JSON.parse(await imagesJson(state));
  assert.equal(stored.images["Pics/a.png"].sha256.length, 64);
  assert.equal(`${FOLDER}/a.png` in stored.images, false);
  const quiet = await sync();
  assert.equal(formatSummary(quiet.summary!, quiet.plan), "Everything was already in sync.");
});

test("an image renamed in Obsidian (the note's citation rewritten by Obsidian) keeps its upload: no new upload, the page shows the same file", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await syncedFolder(t);
  await rename(join(vault, FOLDER, "a.png"), join(vault, FOLDER, "alpha.png"));
  await writeFile(join(vault, "N.md"), (await read("N.md")).replace("![[a.png]]", "![[alpha.png]]"));
  const before = notion.calls.length;
  const outcome = await sync();
  assert.equal(outcome.summary!.mediaUploaded, 0);
  assert.deepEqual(outcome.summary!.mediaMoved, []);
  assert.deepEqual(notion.calls.slice(before).filter((c) => /^(attachFile|uploadFile|download)/i.test(c)), []);
  assert.deepEqual([...(await notion.download((await notion.mediaBlocks(pageNamed("N")!.id))[0]!.hosted!))], [..."AAA"].map((c) => c.charCodeAt(0)));
  assert.match(formatSummary(outcome.summary!, outcome.plan), new RegExp(`moved: ${FOLDER}/a\\.png → ${FOLDER}/alpha\\.png`));
  assert.deepEqual((await sync()).plan.actions, []);
});

test("the attachment folder renamed (pictures to attachments, attachmentFolderPath updated): three moves, nothing else", async (t) => {
  const { vault, state, notion, sync, read } = await syncedFolder(t);
  await rename(join(vault, FOLDER), join(vault, MEDIA));
  await writeFile(join(vault, ".obsidian/app.json"), JSON.stringify({ attachmentFolderPath: MEDIA }));
  const [note, pages, records, before] = [await read("N.md"), JSON.stringify([...notion.pages.values()]), await recordFiles(state), notion.calls.length];
  const savedStore = await imagesJson(state);

  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.mediaPlan, ["a", "b", "c"].map((n) => `moved: ${FOLDER}/${n}.png → ${MEDIA}/${n}.png`));
  assert.equal(await imagesJson(state), savedStore, "a dry run saves nothing");
  assert.deepEqual(await recordFiles(state), records);
  assert.deepEqual(writes(notion, before), []);

  const outcome = await sync();
  assert.deepEqual(outcome.plan.actions, []);
  assert.deepEqual(outcome.plan.warnings, []);
  assert.equal(outcome.summary!.mediaUploaded, 0);
  assert.equal(
    formatSummary(outcome.summary!, outcome.plan),
    ["Everything was already in sync.", ...["a", "b", "c"].map((n) => MOVED(`${FOLDER}/${n}.png`, `${MEDIA}/${n}.png`))].join("\n"),
  );
  assert.deepEqual(writes(notion, before), [], "no upload, download, page or note change");
  assert.equal(await read("N.md"), note);
  assert.equal(JSON.stringify([...notion.pages.values()]), pages);
  assert.deepEqual(await trashed(vault), []);
  assert.deepEqual(await readdir(join(vault, MEDIA)), ["a.png", "b.png", "c.png", "kx.png"]);
  const stored = JSON.parse(await imagesJson(state));
  assert.deepEqual(Object.keys(stored.images).sort(), ["a", "b", "c"].map((n) => `${MEDIA}/${n}.png`));
  assert.deepEqual([...stored.cited].sort(), ["a", "b", "c"].map((n) => `${MEDIA}/${n}.png`));
  for (const text of Object.values(await recordFiles(state)) as string[]) assert.equal(text.includes("pictures"), false);
  const quiet = await sync();
  assert.deepEqual(quiet.plan.actions, []);
  assert.equal(formatSummary(quiet.summary!, quiet.plan), "Everything was already in sync.");
  assert.deepEqual(writes(notion, before), []);
});

test("a synced note inside the attachment folder is renamed in Notion by the folder rename: the plan shows it beside the moves (README, rename procedure)", async (t) => {
  const { vault, notion, sync, read } = await setup(t);
  await writeTree(vault, { ...app, [`${FOLDER}/a.png`]: "AAA", [`${FOLDER}/Final Report.md`]: "inside\n", "N.md": "Intro\n\n![[a.png]]\n" });
  await sync();
  await sync();
  await rename(join(vault, FOLDER), join(vault, MEDIA));
  await writeFile(join(vault, ".obsidian/app.json"), JSON.stringify({ attachmentFolderPath: MEDIA }));
  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.plan.actions.map((a) => a.kind), ["renameInNotion"], "not \"nothing to do\": the note's path changes");
  assert.deepEqual(dry.mediaPlan, [MOVED(`${FOLDER}/a.png`, `${MEDIA}/a.png`).trim()]);
  const before = notion.calls.length;
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { renameInNotion: 1 });
  assert.deepEqual(writes(notion, before).filter((c) => !/^setTitle/.test(c)), [], "no upload, download or page text written: the only Notion write is the property");
  assert.equal((await read("N.md")).endsWith("---\nIntro\n\n![[a.png]]\n"), true, "the note that cites the image is as it was");
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a never-synced identical copy under another name does not take the file's place: the stored name wins", async (t) => {
  const { vault, state, notion, sync } = await syncedFolder(t);
  await rename(join(vault, FOLDER), join(vault, MEDIA));
  await writeFile(join(vault, ".obsidian/app.json"), JSON.stringify({ attachmentFolderPath: MEDIA }));
  await writeFile(join(vault, MEDIA, "Screenshot copy.png"), "AAA");
  const before = notion.calls.length;
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.mediaMoved, []);
  assert.match(formatSummary(outcome.summary!, outcome.plan), new RegExp(`moved: ${FOLDER}/a\\.png → ${MEDIA}/a\\.png`));
  assert.equal(formatSummary(outcome.summary!, outcome.plan).includes("Screenshot copy"), false);
  assert.deepEqual(writes(notion, before), []);
  assert.equal(`${MEDIA}/a.png` in JSON.parse(await imagesJson(state)).images, true);
  assert.deepEqual(await trashed(vault), []);
});

/** a.png (synced, cited by N.md) and copy.png, a file never cited whose bytes are a.png's. */
async function syncedWithCopy(t: import("node:test").TestContext) {
  const env = await setup(t);
  await writeTree(env.vault, { ...app, [`${FOLDER}/a.png`]: "AAA", [`${FOLDER}/copy.png`]: "AAA", "N.md": "Intro\n\n![[a.png]]\n" });
  await env.sync();
  await env.sync();
  return env;
}

test("a synced image deleted while a note still cites it: a never-cited copy of its bytes under another name is not the image, and stays put", async (t) => {
  const { vault, state, notion, sync, pageNamed } = await syncedWithCopy(t);
  assert.deepEqual(JSON.parse(await imagesJson(state)).cited, [`${FOLDER}/a.png`]);
  await rm(join(vault, FOLDER, "a.png"));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.mediaRekeyed, []);
  assert.deepEqual(outcome.summary!.mediaMoved, []);
  assert.deepEqual(await trashed(vault), []);
  assert.equal(await readFile(join(vault, FOLDER, "copy.png"), "utf8"), "AAA");
  assert.equal(JSON.parse(await imagesJson(state)).images[`${FOLDER}/copy.png`], undefined, "copy.png is not taken into the store");
  assert.equal(formatSummary(outcome.summary!, outcome.plan).includes("copy.png"), false);
  assert.equal(count(notion, "uploadFile"), 1, "nothing is uploaded again");
  // Then as for any deleted image: it comes back from Notion when its page is read again (an edit there).
  const page = pageNamed("N")!;
  notion.edit(page.id, { markdown: `${notion.pages.get(page.id)!.markdown}\nmore` });
  await sync();
  assert.equal(await readFile(join(vault, FOLDER, "a.png"), "utf8"), "AAA");
  assert.equal(await readFile(join(vault, FOLDER, "copy.png"), "utf8"), "AAA");
  assert.deepEqual(await trashed(vault), []);
});

test("a synced image deleted and no note names it any more: a copy of its bytes takes its records, and is still not cited, so it is not moved to .trash", async (t) => {
  const { vault, state, sync } = await syncedWithCopy(t);
  await rm(join(vault, FOLDER, "a.png"));
  await writeFile(join(vault, "N.md"), "Intro\n");
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.mediaMoved, []);
  assert.deepEqual(await trashed(vault), []);
  assert.deepEqual(await readdir(join(vault, FOLDER)), ["copy.png"]);
  assert.equal(JSON.parse(await imagesJson(state)).cited.includes(`${FOLDER}/copy.png`), false);
  const again = await sync();
  assert.deepEqual(again.summary!.mediaMoved, []);
  assert.deepEqual(await readdir(join(vault, FOLDER)), ["copy.png"]);
});

test("two identical copies and neither has the stored name: the run stops, names them, and changes nothing", async (t) => {
  const { vault, state, notion, sync, read } = await syncedFolder(t);
  await rm(join(vault, FOLDER, "a.png"));
  // Obsidian rewrote the citation of a.png, so no note names it any more (while one does, a copy of another name is not taken for it).
  await writeFile(join(vault, "N.md"), (await read("N.md")).replace("![[a.png]]\n\n", ""));
  await mkdir(join(vault, "Pics"));
  await writeFile(join(vault, "Pics", "one.png"), "AAA");
  await writeFile(join(vault, "Pics", "two.png"), "AAA");
  const [note, store, records, pages, before] = [await read("N.md"), await imagesJson(state), await recordFiles(state), JSON.stringify([...notion.pages.values()]), notion.calls.length];
  for (const dryRun of [true, false]) {
    await assert.rejects(sync({ dryRun }), (error: Error) => error.message.includes(`${FOLDER}/a.png`) && error.message.includes("Pics/one.png") && error.message.includes("Pics/two.png") && error.message.includes("Nothing was changed."));
  }
  assert.equal(await read("N.md"), note);
  assert.equal(await imagesJson(state), store);
  assert.deepEqual(await recordFiles(state), records);
  assert.equal(JSON.stringify([...notion.pages.values()]), pages);
  assert.deepEqual(writes(notion, before), []);
  assert.deepEqual(await trashed(vault), []);
});

test("a re-key and a replaced file in the same run: the moved file keeps its upload, the replaced one goes onto its page", async (t) => {
  const { vault, notion, sync, pageNamed } = await syncedFolder(t);
  await mkdir(join(vault, "Pics"));
  await rename(join(vault, FOLDER, "a.png"), join(vault, "Pics", "a.png"));
  await writeFile(join(vault, FOLDER, "b.png"), "BBBB replaced");
  const before = notion.calls.length;
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.mediaUpdated, [{ path: `${FOLDER}/b.png`, pages: 1 }]);
  assert.deepEqual(notion.calls.slice(before).filter((c) => /^uploadFile/.test(c)), ["uploadFile b.png"], "only the replaced file is uploaded");
  assert.deepEqual(outcome.summary!.mediaMoved, []);
  assert.match(formatSummary(outcome.summary!, outcome.plan), new RegExp(`moved: ${FOLDER}/a\\.png → Pics/a\\.png`));
  const blocks = await notion.mediaBlocks(pageNamed("N")!.id);
  const bytes = await Promise.all(blocks.map(async (b) => String.fromCharCode(...(await notion.download(b.hosted!)))));
  assert.deepEqual(bytes, ["AAA", "BBBB replaced", "CCCCC"]);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("the store keeps each file's size (upload, download, replacement), and a store without sizes still re-keys by the bytes", async (t) => {
  const { vault, state, notion, sync, read, id } = await (async () => {
    const env = await syncedFolder(t);
    return { ...env, id: env.pageNamed("N")!.id };
  })();
  const sizes = async () => Object.fromEntries(Object.entries(JSON.parse(await imagesJson(state)).images as Record<string, { size?: number }>).map(([path, e]) => [path.split("/").pop(), e.size]));
  assert.deepEqual(await sizes(), { "a.png": 3, "b.png": 4, "c.png": 5 }, "uploaded");
  notion.pasteImage(id, "Intro", "shot.png", pic(1, 2, 3, 4, 5, 6));
  await sync();
  assert.equal((await sizes())["shot.png"], 6, "downloaded");
  await writeFile(join(vault, FOLDER, "b.png"), "BBBB replaced");
  await sync();
  assert.equal((await sizes())["b.png"], 13, "replaced");
  // A store from before sizes were kept: the folder rename still finds the files by their bytes.
  const stored = JSON.parse(await imagesJson(state));
  for (const entry of Object.values(stored.images) as { size?: number }[]) delete entry.size;
  await writeFile(join(state, "images.json"), `${JSON.stringify(stored, null, 2)}\n`);
  await rename(join(vault, FOLDER), join(vault, MEDIA));
  await writeFile(join(vault, ".obsidian/app.json"), JSON.stringify({ attachmentFolderPath: MEDIA }));
  const before = notion.calls.length;
  const outcome = await sync();
  assert.equal(outcome.summary!.mediaRekeyed.length, 4);
  assert.deepEqual(writes(notion, before), []);
  assert.equal((await read("N.md")).includes("pictures"), false);
});

// Removal, replaced files, unrelated edits and the first-run conversion for every kind of attachment (attachments design §2 goal 3, §5.8, §5.13).
const ATTACHMENTS = { [`${FOLDER}/Manual.pdf`]: "%PDF-1", [`${FOLDER}/minutes.docx`]: "docx 1", [`${FOLDER}/song.mp3`]: "mp3 1", [`${FOLDER}/lecture.mp4`]: "mp4 1" };
const ATTACHMENT_NOTE = "Intro\n\n![[Manual.pdf#page=3]]\n\n[[minutes.docx|Minutes]]\n\n![[song.mp3]]\n\n![[lecture.mp4|the lecture]]\n\nOutro\n";

test("an unrelated edit made in Notion leaves the note's PDF, audio, video and file lines byte-identical; nothing moves or is uploaded", async (t) => {
  const { vault, notion, sync, read, id } = await syncedWithPage(t, { ...ATTACHMENTS });
  await writeFile(join(vault, "A.md"), `${await read("A.md")}\n${ATTACHMENT_NOTE.replace("Intro\n\n", "")}`);
  await sync();
  const note = await read("A.md");
  const uploads = count(notion, "uploadFile");
  assert.equal(uploads, 4);
  notion.edit(id, { markdown: notion.pages.get(id)!.markdown.replace("Outro", "Outro, edited in Notion") });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { pull: 1 });
  assert.equal(await read("A.md"), note.replace("Outro", "Outro, edited in Notion"));
  assert.deepEqual(outcome.summary!.mediaMoved, []);
  assert.equal(count(notion, "uploadFile"), uploads);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a PDF, a docx, an mp3 and an mp4 removed from the note move to .trash on the run; a file never cited stays; the blocks go from the page", async (t) => {
  const { vault, state, notion, sync, read, id } = await syncedWithPage(t, { ...ATTACHMENTS, [`${FOLDER}/kx.pdf`]: "never cited" });
  await writeFile(join(vault, "A.md"), `${await read("A.md")}\n${ATTACHMENT_NOTE.replace("Intro\n\n", "")}`);
  await sync();
  assert.deepEqual((await notion.mediaBlocks(id)).map((b) => b.kind), ["pdf", "file", "audio", "video"]);
  assert.deepEqual(JSON.parse(await imagesJson(state)).cited.sort(), Object.keys(ATTACHMENTS).sort());
  await writeFile(join(vault, "A.md"), "---\n" + (await read("A.md")).split("---\n")[1] + "---\nIntro\n");
  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.mediaPlan, Object.keys(ATTACHMENTS).sort().map((path) => `move to .trash ${path}`).sort());
  assert.deepEqual(await readdir(join(vault, FOLDER)), ["Manual.pdf", "kx.pdf", "lecture.mp4", "minutes.docx", "song.mp3"], "a dry run moves nothing");
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { push: 1 });
  assert.deepEqual(outcome.summary!.mediaMoved.sort(), Object.keys(ATTACHMENTS).sort());
  assert.match(formatSummary(outcome.summary!, outcome.plan), /\n {2}moved Assets\/pictures\/Manual\.pdf to \.trash(\n|$)/);
  assert.deepEqual(await readdir(join(vault, FOLDER)), ["kx.pdf"]);
  assert.deepEqual(await trashed(vault), ["Manual.pdf", "lecture.mp4", "minutes.docx", "song.mp3"]);
  assert.equal(await readFile(join(vault, ".trash", "minutes.docx"), "utf8"), "docx 1");
  assert.deepEqual(await notion.mediaBlocks(id), []);
  const stored = JSON.parse(await imagesJson(state));
  assert.deepEqual([stored.cited, Object.keys(stored.images)], [[], []]);
  const again = await sync();
  assert.match(formatSummary(again.summary!, again.plan), /^Everything was already in sync\./);
});

test("a PDF block and a file block removed in Notion take the note's lines with them, and the files go to .trash", async (t) => {
  const { vault, notion, sync, read, id } = await syncedWithPage(t, { ...ATTACHMENTS });
  await writeFile(join(vault, "A.md"), `${await read("A.md")}\n${ATTACHMENT_NOTE.replace("Intro\n\n", "")}`);
  await sync();
  const page = notion.pages.get(id)!.markdown.split("\n").filter((line) => !/^<(pdf|file) /.test(line));
  notion.edit(id, { markdown: page.join("\n") });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { pull: 1 });
  const note = await read("A.md");
  assert.equal(note.includes("Manual.pdf"), false);
  assert.equal(note.includes("minutes.docx"), false);
  assert.ok(note.includes("![[song.mp3]]") && note.includes("![[lecture.mp4|the lecture]]"), note);
  assert.deepEqual(outcome.summary!.mediaMoved.sort(), [`${FOLDER}/Manual.pdf`, `${FOLDER}/minutes.docx`]);
  assert.deepEqual(await readdir(join(vault, FOLDER)), ["lecture.mp4", "song.mp3"]);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a replaced PDF switches the PDF block of both pages that show it, and a replaced docx its file block; the pages' text is unchanged", async (t) => {
  const { vault, notion, sync, pageNamed } = await setup(t);
  await writeTree(vault, { ...app, ...ATTACHMENTS, "A.md": "Intro\n\n![[Manual.pdf]]\n\n[[minutes.docx|Minutes]]\n", "B.md": "![[Manual.pdf#page=2]]\n\ntext\n" });
  await sync();
  const [a, b] = [pageNamed("A")!, pageNamed("B")!];
  const texts = [a, b].map((p) => p.markdown.replace(/src="[^"]*"/g, 'src="url"'));
  assert.equal(count(notion, "uploadFile"), 2, "one upload per file");
  await writeFile(join(vault, FOLDER, "Manual.pdf"), "%PDF-1 and a longer second version");
  await writeFile(join(vault, FOLDER, "minutes.docx"), "docx 2 is longer");
  const dry = await sync({ dryRun: true });
  assert.deepEqual([...dry.mediaPlan!].sort(), [`update file ${FOLDER}/Manual.pdf (2 pages)`, `update file ${FOLDER}/minutes.docx (1 page)`]);
  assert.equal(count(notion, "uploadFile"), 2, "a dry run uploads nothing");
  const outcome = await sync();
  assert.deepEqual([...outcome.summary!.mediaUpdated].sort((x, y) => x.path.localeCompare(y.path)), [{ path: `${FOLDER}/Manual.pdf`, pages: 2 }, { path: `${FOLDER}/minutes.docx`, pages: 1 }]);
  assert.equal(outcome.summary!.mediaUploaded, 0);
  assert.deepEqual(outcome.plan.actions, []);
  assert.equal(count(notion, "uploadFile"), 4);
  const text = (bytes: Uint8Array) => String.fromCharCode(...bytes);
  for (const page of [a, b]) {
    const pdf = (await notion.mediaBlocks(page.id)).find((blk) => blk.kind === "pdf")!;
    assert.equal(text(await notion.download(pdf.hosted!)), "%PDF-1 and a longer second version");
  }
  const file = (await notion.mediaBlocks(a.id)).find((blk) => blk.kind === "file")!;
  assert.equal(text(await notion.download(file.hosted!)), "docx 2 is longer");
  assert.deepEqual([a, b].map((p) => p.markdown.replace(/src="[^"]*"/g, 'src="url"')), texts);
  const before = notion.calls.length;
  const again = await sync();
  assert.deepEqual(again.plan.actions, []);
  assert.match(formatSummary(again.summary!, again.plan), /^Everything was already in sync\./);
  assert.deepEqual(notion.calls.slice(before).filter((c) => !/^(properties|listPages|relationTarget|getMarkdown)/.test(c)), []);
});

test("held attachment moves keep their paths and an allow-list releases them", async (t) => {
  const { vault, sync } = await setup(t);
  const names = Array.from({ length: 11 }, (_, i) => `i${i}.png`);
  await writeTree(vault, { ...app, ...Object.fromEntries(names.map((n) => [`${FOLDER}/${n}`, n])), "N.md": `${names.map((n) => `![[${n}]]`).join("\n\n")}\n` });
  await sync();
  await writeFile(join(vault, "N.md"), "Nothing here now\n");
  const held = await sync();
  assert.deepEqual([...held.plan.heldFiles!].sort(), names.map((n) => `${FOLDER}/${n}`).sort());
  const wrong = await sync({ allowTrashes: { pages: [], files: names.slice(1).map((n) => `${FOLDER}/${n}`) } });
  assert.equal(wrong.summary!.mediaMoved.length, 0);
  assert.match(wrong.plan.warnings.join("\n"), /The list changed since it was held; check it and confirm again\.$/m);
  const allowed = await sync({ allowTrashes: { pages: [], files: held.plan.heldFiles! } });
  assert.equal(allowed.summary!.mediaMoved.length, 11);
});

test("11 freed attachments of mixed kinds move none and warn; the limit counts every kind", async (t) => {
  const { vault, sync } = await setup(t);
  const names = [...Array.from({ length: 4 }, (_, i) => `i${i}.png`), ...Array.from({ length: 4 }, (_, i) => `d${i}.pdf`), "s.mp3", "c.mp4", "n.docx"];
  await writeTree(vault, { ...app, ...Object.fromEntries(names.map((n) => [`${FOLDER}/${n}`, n])), "N.md": `${names.map((n) => (n.endsWith(".docx") ? `[[${n}]]` : `![[${n}]]`)).join("\n\n")}\n` });
  await sync();
  await writeFile(join(vault, "N.md"), "Nothing here now\n");
  const held = await sync();
  assert.deepEqual(held.summary!.mediaMoved, []);
  assert.deepEqual(held.plan.warnings, ["11 files would be moved to .trash, more than the limit of 10, so none were. Check the plan, then run again with --allow-mass-trash."]);
  assert.equal((await readdir(join(vault, FOLDER))).length, 11);
  const allowed = await sync({ allowMassTrash: true });
  assert.equal(allowed.summary!.mediaMoved.length, 11);
  assert.equal((await trashed(vault)).length, 11);
});

test("a PDF and a docx still cited by another note or a canvas stay when the note that cited them first drops them", async (t) => {
  const { vault, sync, read } = await setup(t);
  await writeTree(vault, { ...app, ...ATTACHMENTS, "A.md": "![[Manual.pdf]]\n\n[[minutes.docx]]\n", "Board.canvas": JSON.stringify({ nodes: [{ type: "file", file: `${FOLDER}/minutes.docx` }] }), "B.md": "![[Manual.pdf]]\n" });
  await sync();
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace(/!\[\[Manual.pdf\]\]\n\n\[\[minutes.docx\]\]\n/, "gone\n"));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.mediaMoved, []);
  assert.deepEqual((await readdir(join(vault, FOLDER))).sort(), ["Manual.pdf", "lecture.mp4", "minutes.docx", "song.mp3"]);
});

test("a note synced before attachments were gets its PDF, audio, video and file blocks on the first run; the next run has nothing to do", async (t) => {
  const body = "Intro\n\n![[Manual.pdf#page=3]]\n\n[[minutes.docx|Minutes]]\n\n![[song.mp3]]\n\n[[lecture.mp4]]\n\nOutro\n";
  const markdown = "Intro\n!\\[\\[Manual.pdf#page=3\\]\\]\n\\[\\[minutes.docx\\|Minutes\\]\\]\n!\\[\\[song.mp3\\]\\]\n\\[\\[lecture.mp4\\]\\]\nOutro";
  const { notion, state, sync, read, id, note } = await syncedBeforeImages(t, body, markdown, ATTACHMENTS);
  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.plan.actions, [{ kind: "updateEmbeds", pageId: id }]);
  assert.deepEqual(dry.mediaPlan, [`upload ${FOLDER}/Manual.pdf for A.md`, `upload ${FOLDER}/minutes.docx for A.md`, `upload ${FOLDER}/song.mp3 for A.md`, `upload ${FOLDER}/lecture.mp4 for A.md`]);
  assert.equal(notion.pages.get(id)!.markdown, markdown, "a dry run writes nothing");
  assert.equal(count(notion, "uploadFile"), 0);
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { updateEmbeds: 1 });
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.equal(outcome.summary!.mediaUploaded, 4);
  assert.deepEqual((await notion.mediaBlocks(id)).map((b) => b.kind), ["pdf", "file", "audio", "file"]);
  assert.deepEqual(
    notion.pages.get(id)!.markdown.split("\n").map((l) => l.replace(/src="[^"]*"/, 'src="url"')),
    ["Intro", '<pdf src="url"></pdf>', '<file src="url">Minutes</file>', '<audio src="url"></audio>', '<file src="url"></file>', "Outro"],
  );
  assert.equal(await read("A.md"), note, "the note is not touched");
  assert.deepEqual(JSON.parse(await imagesJson(state)).cited.sort(), [`${FOLDER}/Manual.pdf`, `${FOLDER}/lecture.mp4`, `${FOLDER}/minutes.docx`, `${FOLDER}/song.mp3`].sort());
  const next = await sync();
  assert.deepEqual(next.plan.actions, []);
  assert.match(formatSummary(next.summary!, next.plan), /^Everything was already in sync\./);
  assert.deepEqual((await sync({ dryRun: true })).mediaPlan ?? [], []);
});

// --- Folders and projects (spec §3, §5 B) ---------------------------------------------------------------------------

const frontmatterless = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n/, "");

test("evicted name clash: notes of folders that mean no project land in the default folder under unique names, and links to each still resolve", async (t) => {
  const { vault, sync, read } = await setup(t, false, true);
  await writeTree(vault, {
    "Resources/Index.md": "resources index\n",
    "Resources/Sub/Deep.md": "deep\n",
    "Cards/Index.md": "zettel index\n",
    "Cards/Inner/Deep2.md": "deep2\n",
    "0-In/Index.md": "inbox index\n",
    "Links.md": "[[Resources/Index|one]] [[Cards/Index|two]] [[0-In/Index|three]]\n",
  });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.equal(outcome.summary!.done.relocate, 2);
  const inbox = (await readdir(join(vault, "0-In"))).sort();
  assert.deepEqual(inbox, ["Index (2).md", "Index (3).md", "Index.md"]);
  assert.match(await read("0-In/Index.md"), /inbox index/);
  const links = frontmatterless(await read("Links.md"));
  const targets = [...links.matchAll(/\]\(([^)]*)\)/g)].map((m) => decodeURIComponent(m[1]!));
  assert.equal(targets.length, 3);
  const texts: string[] = [];
  for (const target of targets) texts.push(frontmatterless(await read(target.includes("/") ? target : `0-In/${target}`)));
  assert.deepEqual(texts.sort(), ["inbox index\n", "resources index\n", "zettel index\n"]);
  assert.equal(new Set(targets).size, 3);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("project created, store not saved: the next run finds the project by its title and creates no second one", async (t) => {
  const { vault, state, notion, sync, projectOf, pageNamed } = await setup(t, false, true);
  await writeTree(vault, { "Cooking/A.md": "a\n" });
  await sync();
  const stored = await readFile(join(state, "projects.json"), "utf8");
  assert.match(stored, /"path": "Cooking"/);
  assert.equal(projectOf(pageNamed("A")!.id), "Cooking");
  // The run was cut short before the store was saved.
  await rm(join(state, "projects.json"));
  await writeTree(vault, { "Cooking/B.md": "b\n" });
  const second = await sync();
  assert.deepEqual(second.summary!.skipped, []);
  assert.deepEqual([...notion.projectPages.values()].map((p) => p.title), ["Cooking"]);
  assert.equal(notion.calls.filter((c) => c.startsWith("createProject")).length, 1);
  assert.equal(projectOf(pageNamed("B")!.id), "Cooking");
  assert.match(await readFile(join(state, "projects.json"), "utf8"), /"path": "Cooking"/);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("no projects relation: folders stay, new Notion pages land in the default folder, and no relation is read, written or stored", async (t) => {
  const { vault, state, notion, sync, config } = await setup(t);
  await writeTree(vault, { "Zettel/A.md": "a\n", "Resources/Sub/B.md": "b\n" });
  notion.add("FromNotion", "n", [notion.addProject("Somewhere")]);
  const lines: string[] = [];
  const log = (line: string) => void lines.push(line);
  const outcome = await runSync({ config: { ...config, ignoredKeys: ["folderProperty"] }, notion, dryRun: false, yes: true, allowMassTrash: false, log });
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.match(await readFile(join(vault, "Zettel/A.md"), "utf8"), /^---\nnotion-id/);
  await readFile(join(vault, "Resources/Sub/B.md"), "utf8");
  await readFile(join(vault, "0-In/FromNotion.md"), "utf8");
  assert.deepEqual(notion.calls.filter((c) => /roject/.test(c)), []);
  assert.equal((await readdir(state)).includes("projects.json"), false);
  assert.deepEqual(lines, ['note: "folderProperty" is no longer used; folders follow the "projectsRelation" now', 'note: the database has no "Links to" property; the Links to relation is left alone']);
  assert.deepEqual((await runSync({ config, notion, dryRun: false, yes: true, allowMassTrash: false, log: () => {} })).plan.actions, []);
});

test("a dry run creates no project and lists the ones a real run would create; nothing is stored", async (t) => {
  const { vault, state, notion, sync } = await setup(t, false, true);
  await writeTree(vault, { "Cooking/A.md": "a\n", "Cooking/B.md": "b\n", "Layouts/C.md": "c\n" });
  const outcome = await sync({ dryRun: true });
  assert.deepEqual(outcome.plan.creates, ["Cooking", "Layouts"]);
  assert.match(formatPlan(outcome.plan, outcome.notes, outcome.pages), /\n {2}create project Cooking\n {2}create project Layouts/);
  assert.equal(notion.projectPages.size, 0);
  assert.equal(notion.pages.size, 0);
  assert.deepEqual(notion.calls.filter((c) => /^(create|setProjects|renameProject)/.test(c)), []);
  assert.equal((await readdir(state)).includes("projects.json"), false);
  const real = await sync();
  assert.deepEqual(real.summary!.projectsCreated, ["Cooking", "Layouts"]);
  assert.match(formatSummary(real.summary!, real.plan), /created project Cooking\n {2}created project Layouts/);
});

test("a project renamed in Notion renames its folder; the old folder is removed only if it is completely empty", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t, false, true);
  await writeTree(vault, { "Astronomy/A.md": "a\n", "Labs/B.md": "b\n" });
  await sync();
  const project = (title: string) => [...notion.projectPages].find(([, p]) => p.title === title)![0];
  // A file that is not a note keeps its folder.
  await writeTree(vault, { "Labs/diagram.txt": "d" });
  notion.editProject(project("Astronomy"), { title: "Astronomy Club" });
  notion.editProject(project("Labs"), { title: "Labs 2" });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual(outcome.summary!.done, { moveInVault: 2 });
  assert.match(await read("Astronomy Club/A.md"), /^---\nnotion-id: /);
  assert.match(await read("Labs 2/B.md"), /^---\nnotion-id: /);
  const root = await readdir(vault);
  assert.equal(root.includes("Astronomy"), false, "the empty old folder is gone");
  assert.equal(root.includes("Labs"), true, "the folder that still holds a file stays");
  assert.deepEqual(await readdir(join(vault, "Labs")), ["diagram.txt"]);
  assert.equal(pageNamed("A")!.title, "A");
  assert.deepEqual((await sync()).plan.actions, []);
});

test("P1: the folder of a trashed project is removed once its notes have left, only when completely empty", async (t) => {
  const { vault, notion, sync, read } = await setup(t, false, true);
  await writeTree(vault, { "Shed/Backlog/A.md": "a\n", "Mat/Keep/B.md": "b\n" });
  await sync();
  const project = (title: string) => [...notion.projectPages].find(([, p]) => p.title === title)![0];
  notion.editProject(project("Backlog"), { inTrash: true });
  notion.editProject(project("Keep"), { inTrash: true });
  await writeTree(vault, { "Mat/Keep/diagram.txt": "d" });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.match(await read("0-In/A.md"), /^---\nnotion-id: /);
  assert.deepEqual((await readdir(join(vault, "Mat"))).sort(), ["Keep"], "the empty folder of the trashed project is gone, the one with a file stays");
  assert.deepEqual(await readdir(join(vault, "Mat/Keep")), ["diagram.txt"]);
});

test("a folder renamed in Obsidian renames its project in Notion", async (t) => {
  const { vault, notion, sync, projectOf, pageNamed } = await setup(t, false, true);
  await writeTree(vault, { "Astronomy/A.md": "a\n" });
  await sync();
  await rename(join(vault, "Astronomy"), join(vault, "Weaving"));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { renameProject: 1, renameInNotion: 1 });
  assert.equal(projectOf(pageNamed("A")!.id), "Weaving");
  assert.equal(notion.projectPages.size, 1);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("both apps changed a note's project: the folder the note is in in Obsidian wins, and the run says so", async (t) => {
  const { vault, notion, sync, projectOf, pageNamed } = await setup(t, false, true);
  await writeTree(vault, { "A/N.md": "n\n", "B/M.md": "m\n" });
  await sync();
  const id = pageNamed("N")!.id;
  notion.edit(id, { projects: [notion.addProject("Z")] });
  await rename(join(vault, "A/N.md"), join(vault, "B/N.md"));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual(outcome.plan.clashes, ["B/N.md"]);
  assert.match(formatSummary(outcome.summary!, outcome.plan), /1 note renamed or moved in Obsidian while the page's project also changed in Notion; the folder in Obsidian wins: B\/N\.md/);
  assert.equal(projectOf(id), "B");
  assert.equal((await readdir(vault)).includes("Z"), false, "the note stays where Obsidian put it");
  await readFile(join(vault, "B/N.md"), "utf8");
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a projects relation that is missing or unreadable stops the run before anything changes", async (t) => {
  const { vault, state, notion, sync, config } = await setup(t, false, true);
  await writeTree(vault, { "Cooking/A.md": "a\n" });
  await sync();
  await writeTree(vault, { "Cooking/B.md": "b\n", "New.md": "new\n" });
  const before = { pages: JSON.stringify([...notion.pages.values()]), files: (await readdir(vault, { recursive: true })).sort(), state: (await readdir(state)).sort() };
  const unchanged = async () => {
    assert.equal(JSON.stringify([...notion.pages.values()]), before.pages);
    assert.deepEqual((await readdir(vault, { recursive: true })).sort(), before.files);
    assert.deepEqual((await readdir(state)).sort(), before.state);
  };
  notion.projectsUnreadable = true;
  await assert.rejects(sync(), /can't read the database the "Project" relation points to.* Nothing was changed\.$/);
  await unchanged();
  notion.projectsUnreadable = false;
  notion.schema.delete("Project");
  await assert.rejects(sync(), /no "Project" property.* Nothing was changed\.$/);
  await unchanged();
  notion.schema.set("Project", "select");
  await assert.rejects(sync(), /"Project" property is a select, not a relation.* Nothing was changed\.$/);
  await unchanged();
  assert.equal(config.projectsRelation, "Project");
  notion.schema.set("Project", "relation");
  assert.deepEqual((await sync()).summary!.skipped, []);
});

test("turning projects on for a synced vault: a folder keeps its notes and gets its project, a Notion project moves its note, a non-leaf folder's notes go to the default folder", async (t) => {
  const { vault, notion, sync, config, read, projectOf, pageNamed, state } = await setup(t);
  await writeTree(vault, { "Astronomy/N.md": "n\n", "0-In/Y.md": "y\n", "Resources/R.md": "r\n", "Resources/Sub/S.md": "s\n" });
  await sync();
  assert.equal((await readdir(state)).includes("projects.json"), false);
  const astronomy = notion.addProject("Astronomy");
  const solo = notion.addProject("Solo");
  notion.edit(pageNamed("Y")!.id, { projects: [solo] });
  notion.schema.set("Project", "relation");
  config.projectsRelation = "Project";
  const preview = await sync({ dryRun: true });
  assert.equal(preview.summary, null);
  assert.deepEqual(preview.plan.creates, ["Sub"]);
  assert.equal(preview.plan.actions.filter((a) => a.kind === "relocate").length, 1);
  assert.equal(notion.projectPages.size, 2);
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual(notion.projectsOf(pageNamed("N")!.id), [astronomy]);
  assert.equal(projectOf(pageNamed("N")!.id), "Astronomy");
  assert.match(await read("Solo/Y.md"), /^---\nnotion-id: /);
  assert.equal(projectOf(pageNamed("Y")!.id), "Solo");
  assert.match(await read("0-In/R.md"), /^---\nnotion-id: /);
  assert.equal(projectOf(pageNamed("R")!.id), null);
  assert.equal(projectOf(pageNamed("S")!.id), "Sub");
  assert.deepEqual([...notion.projectPages.values()].map((p) => p.title).sort(), ["Astronomy", "Solo", "Sub"]);
  const stored = JSON.parse(await readFile(join(state, "projects.json"), "utf8")) as { projects: Record<string, { path: string }> };
  assert.deepEqual(Object.values(stored.projects).map((p) => p.path).sort(), ["Astronomy", "Resources/Sub", "Solo"]);
  assert.deepEqual((await sync()).plan.actions, []);
  // Every record has its project now, so a change in Notion moves the note instead of being undone by its folder.
  notion.edit(pageNamed("N")!.id, { projects: [solo] });
  await sync();
  assert.match(await read("Solo/N.md"), /^---\nnotion-id: /);
  assert.equal(projectOf(pageNamed("N")!.id), "Solo");
});

test("two folders claiming one project name are left alone: warned about once per run (a dry run too), nothing written for them", async (t) => {
  const { vault, notion, sync, config } = await setup(t, false, true);
  await writeTree(vault, { "A/Notes/x.md": "x\n", "B/Notes/y.md": "y\n" });
  const lines: string[] = [];
  const dry = await sync({ dryRun: true, log: (line) => void lines.push(line) });
  assert.equal(lines.filter((line) => /^warning: the folder "A\/Notes" is left alone/.test(line)).length, 1);
  assert.deepEqual(dry.plan.creates ?? [], []);
  lines.length = 0;
  const real = await sync({ log: (line) => void lines.push(line) });
  assert.equal(lines.filter((line) => /^warning: the folder "[AB]\/Notes" is left alone: the folders .* both claim the project name "Notes"/.test(line)).length, 2);
  assert.deepEqual(real.summary!.skipped, []);
  assert.equal(notion.projectPages.size, 0);
  assert.equal(notion.calls.filter((c) => /^(createProject|setProjects)/.test(c)).length, 0);
  assert.equal(config.projectsRelation, "Project");
  await readFile(join(vault, "A/Notes/x.md"), "utf8");
});

// --- Final review wave -----------------------------------------------------------------------------------------------

test("item 1: a record saved before its project was filed (a link rewrite) does not send the note to the default folder when the filing fails", async (t) => {
  const { vault, notion, sync, config, read, projectOf, pageNamed } = await setup(t);
  await writeTree(vault, { "Astronomy/A.md": "---\nrelated: \"[[Resources/E]]\"\n---\nbody\n", "Resources/E.md": "e\n", "Resources/Sub/S.md": "s\n" });
  await sync();
  const astronomy = notion.addProject("Astronomy");
  notion.schema.set("Project", "relation");
  config.projectsRelation = "Project";
  const setProjects = notion.setProjects.bind(notion);
  notion.setProjects = async (pageId, ids) => {
    if (pageId === pageNamed("A")!.id) throw new NotionPageError("validation_error", "refused for the test");
    return setProjects(pageId, ids);
  };
  const first = await sync();
  assert.deepEqual(first.summary!.done.relocate, 1);
  assert.deepEqual(first.summary!.skipped.map((s) => s.path), ["Astronomy/A.md"]);
  assert.match(await read("0-In/E.md"), /^---\nnotion-id: /);
  notion.setProjects = setProjects;
  const second = await sync();
  assert.deepEqual(second.summary!.skipped, []);
  assert.match(await read("Astronomy/A.md"), /notion-id: /, "the note stays in its folder");
  assert.deepEqual(notion.projectsOf(pageNamed("A")!.id), [astronomy]);
  assert.equal(projectOf(pageNamed("A")!.id), "Astronomy");
  assert.deepEqual((await sync()).plan.actions, []);
});

test("item 2: a note in an ambiguous folder is not moved to the default folder on the second run", async (t) => {
  const { vault, notion, sync, read } = await setup(t, false, true);
  notion.addProject("Notes");
  notion.addProject("notes");
  await writeTree(vault, { "Notes/x.md": "x\n" });
  const first = await sync();
  assert.deepEqual(first.summary!.skipped, []);
  const second = await sync();
  assert.deepEqual(second.plan.actions, []);
  assert.match(await read("Notes/x.md"), /^---\nnotion-id: /);
  assert.equal((await readdir(vault)).includes("0-In") ? (await readdir(join(vault, "0-In"))).length : 0, 0);
});

test("item 3: a paired note evicted next to a note of the same name keeps its Notion title, and no link text is retitled", async (t) => {
  const { vault, notion, sync, config, read } = await setup(t);
  await writeTree(vault, { "Resources/Index.md": "resources\n", "Resources/Sub/S.md": "s\n", "0-In/Index.md": "inbox\n", "Links.md": "[[Resources/Index]]\n" });
  await sync();
  const id = [...notion.pages.values()].find((p) => p.markdown.includes("resources"))!.id;
  notion.schema.set("Project", "relation");
  config.projectsRelation = "Project";
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  const moved = (await readdir(join(vault, "0-In"))).filter((n) => n.startsWith("Index"));
  assert.deepEqual(moved.sort(), ["Index (2).md", "Index.md"]);
  assert.match(await read("0-In/Index (2).md"), /notion-title: Index\n/);
  assert.equal(notion.pages.get(id)!.title, "Index", "the page keeps its title");
  assert.equal([...notion.pages.values()].filter((p) => p.title === "Index (2)").length, 0);
  assert.match(await read("Links.md"), /\[Index\]\(Index%20%282%29\.md\)/, "the link text is not retitled");
  assert.deepEqual((await sync()).plan.actions, []);
});

test("item 4: a connection not connected to the projects database is told to connect it, not to add the relation it cannot see", async (t) => {
  const { vault, notion, sync } = await setup(t, false, true);
  await writeTree(vault, { "Cooking/A.md": "a\n" });
  notion.projectsUnreadable = true;
  notion.schema.delete("Project");
  await assert.rejects(sync(), (error: Error) => {
    assert.match(error.message, /can't read the database the "Project" relation points to/);
    assert.doesNotMatch(error.message, /add a relation|has no "Project" property/);
    assert.match(error.message, /Nothing was changed\.$/);
    return true;
  });
});

test("item 5: a project renamed in Notion whose note could not move is not renamed back; the note moves next run", async (t) => {
  const { vault, notion, sync, read, projectOf, pageNamed } = await setup(t, false, true);
  await writeTree(vault, { "Old/A.md": "a\n" });
  await sync();
  const project = [...notion.projectPages][0]![0];
  notion.editProject(project, { title: "New" });
  // The note is edited in Obsidian while the run works, so its move waits for the next run.
  const listProjects = notion.listProjects.bind(notion);
  notion.listProjects = async () => {
    const found = await listProjects();
    await writeFile(join(vault, "Old/A.md"), `${await read("Old/A.md")}more\n`);
    return found;
  };
  const first = await sync();
  assert.deepEqual(first.summary!.skipped.map((s) => s.reason.split(":")[0]), ["changed_in_obsidian"]);
  notion.listProjects = listProjects;
  const second = await sync();
  assert.deepEqual(second.summary!.skipped, []);
  assert.equal(second.summary!.done.renameProject, undefined);
  assert.equal(notion.projectPages.get(project)!.title, "New");
  assert.match(await read("New/A.md"), /more/);
  assert.equal(projectOf(pageNamed("A")!.id), "New");
  assert.deepEqual((await sync()).plan.actions, []);
});

test("item 6: a run that stops with an error still saves the projects it created", async (t) => {
  const { vault, state, notion, sync } = await setup(t, false, true);
  await writeTree(vault, { "Cooking/A.md": "a\n", "Zed/B.md": "b\n" });
  const createPage = notion.createPage.bind(notion);
  notion.createPage = async (input) => {
    if (input.title === "B") throw new Error("the connection dropped");
    return createPage(input);
  };
  await assert.rejects(sync(), /the connection dropped/);
  const stored = JSON.parse(await readFile(join(state, "projects.json"), "utf8")) as { projects: Record<string, { path: string }> };
  assert.deepEqual(Object.values(stored.projects).map((p) => p.path).sort(), ["Cooking", "Zed"]);
  notion.createPage = createPage;
  const next = await sync();
  assert.deepEqual(next.summary!.skipped, []);
  assert.equal(notion.projectPages.size, 2, "no second project is created");
});

test("item 7: a note of a page with several projects moved to the default folder stays there, Notion keeps both projects, one warning per run; a single project is removed", async (t) => {
  const { vault, notion, sync, projectOf, pageNamed, read } = await setup(t, false, true);
  await writeTree(vault, { "Astronomy/Multi.md": "m\n", "Astronomy/Solo.md": "s\n", "Botany/Other.md": "o\n" });
  await sync();
  const multi = pageNamed("Multi")!.id;
  const botany = [...notion.projectPages].find(([, p]) => p.title === "Botany")![0];
  notion.edit(multi, { projects: [...notion.projectsOf(multi), botany] });
  await sync();
  await mkdir(join(vault, "0-In"), { recursive: true });
  await rename(join(vault, "Astronomy/Multi.md"), join(vault, "0-In/Multi.md"));
  await rename(join(vault, "Astronomy/Solo.md"), join(vault, "0-In/Solo.md"));
  const lines: string[] = [];
  const outcome = await sync({ log: (line) => void lines.push(line) });
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual(notion.projectsOf(multi).map((id) => notion.projectPages.get(id)!.title), ["Astronomy", "Botany"]);
  assert.equal(projectOf(pageNamed("Solo")!.id), null);
  assert.deepEqual(lines.filter((l) => l.startsWith("warning:")), ["warning: 0-In/Multi.md is in 0-In but its page has the projects Astronomy, Botany in Notion; they were left as they are"]);
  // Later runs leave it there.
  const later = await sync({ log: () => {} });
  assert.deepEqual(later.plan.actions, []);
  await read("0-In/Multi.md");
  assert.deepEqual(notion.projectsOf(multi).map((id) => notion.projectPages.get(id)!.title), ["Astronomy", "Botany"]);
});

test("P4: a page kept out in the default folder keeps its remaining project when Notion drops the other; moving the note into the folder of a project applies the normal rules again", async (t) => {
  const { vault, notion, sync, pageNamed, read } = await setup(t, false, true);
  await writeTree(vault, { "Astronomy/Multi.md": "m\n", "Botany/Other.md": "o\n" });
  await sync();
  const multi = pageNamed("Multi")!.id;
  const botany = [...notion.projectPages].find(([, p]) => p.title === "Botany")![0];
  const astronomy = notion.projectsOf(multi)[0]!;
  notion.edit(multi, { projects: [astronomy, botany] });
  await sync();
  await mkdir(join(vault, "0-In"), { recursive: true });
  await rename(join(vault, "Astronomy/Multi.md"), join(vault, "0-In/Multi.md"));
  await sync({ log: () => {} });
  notion.edit(multi, { projects: [astronomy] });
  const lines: string[] = [];
  const dropped = await sync({ log: (line) => void lines.push(line) });
  assert.deepEqual(dropped.plan.actions, []);
  assert.deepEqual(notion.projectsOf(multi), [astronomy], "the remaining project is untouched");
  assert.equal(lines.filter((l) => l.startsWith("warning:")).length, 1);
  await read("0-In/Multi.md");
  // Moved into a project's folder in Obsidian: the folder decides again.
  await rename(join(vault, "0-In/Multi.md"), join(vault, "Botany/Multi.md"));
  const back = await sync({ log: () => {} });
  assert.deepEqual(back.summary!.skipped, []);
  assert.deepEqual(notion.projectsOf(multi), [botany]);
});

test("item 8: filing a project writes no title, so the pages are not touched twice", async (t) => {
  const { vault, notion, sync, config } = await setup(t);
  await writeTree(vault, { "Astronomy/N.md": "n\n", "Astronomy/M.md": "m\n" });
  await sync();
  notion.addProject("Astronomy");
  notion.schema.set("Project", "relation");
  config.projectsRelation = "Project";
  const before = notion.calls.length;
  const outcome = await sync();
  assert.equal(outcome.summary!.done.fileProject, 2);
  assert.deepEqual(notion.calls.slice(before).filter((c) => c.startsWith("setTitle")), []);
});

test("item 9: the dry run says, note by note, why a note moves", async (t) => {
  const { vault, notion, sync, config, pageNamed } = await setup(t);
  await writeTree(vault, { "Resources/A.md": "a\n", "Resources/Sub/S.md": "s\n", "0-In/Y.md": "y\n" });
  await sync();
  const solo = notion.addProject("Solo");
  notion.edit(pageNamed("Y")!.id, { projects: [solo] });
  notion.schema.set("Project", "relation");
  config.projectsRelation = "Project";
  const dry = await sync({ dryRun: true });
  const text = formatPlan(dry.plan, dry.notes, dry.pages);
  assert.match(text, /move note Resources\/A\.md -> 0-In\/A\.md \(its folder has subfolders\)/);
  assert.match(text, /rename\/move note 0-In\/Y\.md -> Solo\/Y\.md \(its page has the project Solo in Notion\)/);
  await sync();
  const other = notion.addProject("Other");
  notion.edit(pageNamed("Y")!.id, { projects: [other] });
  const changed = await sync({ dryRun: true });
  assert.match(formatPlan(changed.plan, changed.notes, changed.pages), /Solo\/Y\.md -> Other\/Y\.md \(its project changed in Notion\)/);
  await sync();
  notion.editProject(other, { inTrash: true });
  const gone = await sync({ dryRun: true });
  assert.match(formatPlan(gone.plan, gone.notes, gone.pages), /Other\/Y\.md -> 0-In\/Y\.md \(its project was trashed\)/);
  notion.editProject(other, { inTrash: false, title: "Other 2" });
  const renamed = await sync({ dryRun: true });
  assert.match(formatPlan(renamed.plan, renamed.notes, renamed.pages), /Other\/Y\.md -> Other 2\/Y\.md \(its project was renamed\)/);
});

test("the status note never syncs", async (t) => {
  const { vault, notion, sync, config } = await setup(t);
  config.statusNote = "nopipeline status.md";
  const status = "# Status\n\nNothing yet.\n";
  await writeFile(join(vault, "nopipeline status.md"), status);
  await writeFile(join(vault, "A.md"), "alpha\n");
  await sync();
  assert.deepEqual([...notion.pages.values()].map((p) => p.title), ["A"]);
  assert.equal(await readFile(join(vault, "nopipeline status.md"), "utf8"), status);
});

// Notes in use (open in Obsidian or just edited) are left alone in both apps and listed as waiting.
const probe = (open: string[] | null, modified: Record<string, Date> = {}, running = true): ObsidianProbe => ({
  running: async () => running,
  openTabs: async () => (open === null ? null : new Set(open)),
  modifiedAt: async (_vault, path) => modified[path] ?? null,
});
const LONG_AGO = new Date("2020-01-01");
const OLD = { "A.md": LONG_AGO, "B.md": LONG_AGO, "Old.md": LONG_AGO, "Open.md": LONG_AGO };

test("a note open in a tab and edited in Notion is left alone until the tab closes", async (t) => {
  const { vault, state, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "A.md": "one\n", "B.md": "two\n" });
  await sync();
  const a = pageNamed("A")!.id;
  const before = await read("A.md");
  notion.edit(a, { markdown: "one\nedited in Notion\n" });
  notion.edit(pageNamed("B")!.id, { markdown: "two\nalso edited\n" });
  const recordFile = join(state, "records", `${a}.json`);
  const recordBefore = readFileSync(recordFile);
  const run = await sync({ obsidian: probe(["A.md"], OLD) });
  assert.deepEqual(readFileSync(recordFile), recordBefore);
  assert.equal(await read("A.md"), before);
  assert.match(await read("B.md"), /also edited/);
  assert.deepEqual(run.plan.waiting, ["A.md"]);
  assert.deepEqual(run.summary!.skipped, []);
  assert.equal(exitCode(run.summary, run.plan), 0);
  assert.equal(notion.pages.get(a)!.markdown, "one\nedited in Notion\n");
  await sync({ obsidian: probe([], OLD) });
  assert.match(await read("A.md"), /edited in Notion/);
});

test("a note in use and edited in Obsidian is not written to its page", async (t) => {
  const { vault, notion, sync, pageNamed } = await setup(t);
  await writeTree(vault, { "A.md": "one\n" });
  await sync();
  const a = pageNamed("A")!;
  const text = a.markdown;
  writeFileSync(join(vault, "A.md"), readFileSync(join(vault, "A.md"), "utf8").replace("one", "half-typed"));
  const run = await sync({ obsidian: probe(["A.md"], OLD) });
  assert.equal(notion.pages.get(a.id)!.markdown, text);
  assert.deepEqual(run.plan.waiting, ["A.md"]);
  await sync({ obsidian: probe([], OLD) });
  assert.match(notion.pages.get(a.id)!.markdown, /half-typed/);
});

test("a note in use whose page was trashed in Notion stays, and no page is recreated", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "A.md": "one\n" });
  await sync();
  const a = pageNamed("A")!.id;
  const before = await read("A.md");
  notion.edit(a, { inTrash: true });
  const pagesBefore = notion.pages.size;
  const run = await sync({ obsidian: probe(["A.md"], OLD) });
  assert.equal(await read("A.md"), before);
  assert.equal(notion.pages.size, pagesBefore);
  assert.deepEqual(run.plan.waiting, ["A.md"]);
});

test("a note in use, edited, whose page was trashed in Notion makes no page on any run", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "A.md": "one\n" });
  await sync();
  const a = pageNamed("A")!.id;
  notion.edit(a, { inTrash: true });
  writeFileSync(join(vault, "A.md"), `${await read("A.md")}typed since\n`);
  const before = await read("A.md");
  const pagesBefore = notion.pages.size;
  for (let i = 0; i < 2; i++) {
    const run = await sync({ obsidian: probe(["A.md"], OLD) });
    assert.equal(notion.pages.size, pagesBefore, `run ${i + 1} made a page`);
    assert.equal(await read("A.md"), before);
    assert.deepEqual(run.plan.waiting, ["A.md"]);
  }
});

test("a rename in Notion waits as a whole while a note in use links to the page", async (t) => {
  const { vault, state, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "Old.md": "text\n", "Open.md": "see [[Old]]\n" });
  await sync();
  const old = pageNamed("Old")!.id;
  const open = await read("Open.md");
  notion.edit(old, { title: "New" });
  const recordFile = join(state, "records", `${old}.json`);
  const recordBefore = readFileSync(recordFile);
  const run = await sync({ obsidian: probe(["Open.md"], OLD) });
  assert.deepEqual(readFileSync(recordFile), recordBefore, "a waiting page's record is left exactly as it was");
  assert.ok((await readdir(vault)).includes("Old.md"));
  assert.ok(!(await readdir(vault)).includes("New.md"));
  assert.equal(await read("Open.md"), open);
  assert.equal(notion.pages.get(old)!.title, "New");
  assert.deepEqual(run.plan.waiting, ["Old.md", "Open.md"]);
  await sync({ obsidian: probe([], OLD) });
  assert.ok((await readdir(vault)).includes("New.md"));
  assert.match(await read("Open.md"), /New/);
});

test("a dry run shows what would wait and writes nothing", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "A.md": "one\n" });
  await sync();
  notion.edit(pageNamed("A")!.id, { markdown: "one\nedited\n" });
  const before = await read("A.md");
  const run = await sync({ dryRun: true, obsidian: probe(["A.md"], OLD) });
  assert.deepEqual(run.plan.waiting, ["A.md"]);
  assert.equal(await read("A.md"), before);
});

test("without Obsidian running nothing waits", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "A.md": "one\n" });
  await sync();
  notion.edit(pageNamed("A")!.id, { markdown: "one\nedited\n" });
  const run = await sync({ obsidian: probe(["A.md"], {}, false) });
  assert.equal(run.plan.waiting, undefined);
  assert.match(await read("A.md"), /edited/);
});

test("unreadable tabs warn once, and a note edited a minute ago waits", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { "A.md": "one\n", "B.md": "two\n" });
  await sync();
  const page = pageNamed("A")!;
  const markdown = page.markdown;
  writeFileSync(join(vault, "A.md"), readFileSync(join(vault, "A.md"), "utf8").replace("one", "typing"));
  const text = await read("A.md");
  // The next run's clock is 5 minutes on from the last sync's.
  const recent = new Date(Date.parse("2026-09-27T10:00:00Z") + 2 * 5 * 60_000 - 60_000);
  const run = await sync({ obsidian: probe(null, { "A.md": recent, "B.md": LONG_AGO }) });
  assert.equal(run.plan.warnings.filter((w) => w.startsWith("couldn't read the notes open in Obsidian (.obsidian/workspace.json)")).length, 1);
  assert.deepEqual(run.plan.waiting, ["A.md"]);
  assert.equal(await read("A.md"), text);
  assert.equal(notion.pages.get(page.id)!.markdown, markdown);
});

// ---- tags between the frontmatter and the Notion property ----

const tagged = (tags: string[]) => (tags.length ? `---\ntags:\n${tags.map((tag) => `  - ${tag}`).join("\n")}\n---\n` : "");

/** A vault and database with tags on; note `A.md` and page "A" share their text and are paired by a first run that has no tags. */
async function tagsWorld(t: import("node:test").TestContext, note: string[], page: string[], extra: { noteTop?: string } = {}) {
  const w = await setup(t);
  w.notion.addTags();
  w.config.tagsProperty = "Tags";
  const id = w.notion.add("A", "Body");
  w.notion.edit(id, { tags: page });
  await writeTree(w.vault, { "A.md": `${tagged(note)}${extra.noteTop ?? ""}Body\n` });
  const tagCalls = () => w.notion.calls.filter((c) => c.startsWith("setTags"));
  return { ...w, id, tagCalls, pageTags: () => w.notion.pages.get(id)!.tags ?? [] };
}

const recordOf = async (state: string, id: string) => JSON.parse(await readFile(join(state, "records", `${id}.json`), "utf8")) as { tags?: string[]; obsidianText: string; notionMarkdown: string };

test("tags, first run: the note's tags go to the page and the page's to the note, other frontmatter bytes kept", async (t) => {
  const w = await tagsWorld(t, ["a"], []);
  const out = await w.sync();
  assert.deepEqual(w.pageTags(), ["a"]);
  assert.deepEqual((await recordOf(w.state, w.id)).tags, ["a"]);
  assert.equal(out.summary!.tagsSet, 1);
  assert.match(formatSummary(out.summary!, out.plan), /\n {2}1 × tags set in Notion(\n|$)/);

  const v = await tagsWorld(t, [], ["b"]);
  const text = `---\ncolor: red # keep\n---\nBody\n`;
  await writeTree(v.vault, { "A.md": text });
  const second = await v.sync();
  assert.equal(second.summary!.tagsWritten, 1);
  assert.match(formatSummary(second.summary!, second.plan), /\n {2}1 × tags written to notes(\n|$)/);
  const now = await v.read("A.md");
  assert.match(now, /^---\ncolor: red # keep\nnotion-id: [^\n]*\ntags:\n {2}- b\n---\nBody\n$/);
  assert.deepEqual((await recordOf(v.state, v.id)).tags, ["b"]);
  assert.equal((await recordOf(v.state, v.id)).obsidianText, now);
  // Next run: nothing to do.
  v.notion.calls.length = 0;
  const third = await v.sync();
  assert.deepEqual(third.plan.actions, []);
  assert.equal(third.summary!.tagsWritten, undefined);
  assert.deepEqual(v.tagCalls(), []);
});

test("tags changed on both sides since a synced [a, b] merge to [b, c]", async (t) => {
  const w = await tagsWorld(t, ["a", "b"], ["a", "b"]);
  await w.sync();
  await writeFile(join(w.vault, "A.md"), (await w.read("A.md")).replace("  - a\n  - b\n", "  - a\n  - b\n  - c\n"));
  w.notion.edit(w.id, { tags: ["b"] });
  await w.sync();
  assert.deepEqual(w.pageTags(), ["b", "c"]);
  assert.match(await w.read("A.md"), /tags:\n {2}- b\n {2}- c\n(notion-id: [^\n]*\n)?---/);
  assert.deepEqual((await recordOf(w.state, w.id)).tags, ["b", "c"]);
});

test("tags: a change of case alone writes nothing on either side", async (t) => {
  const w = await tagsWorld(t, ["A"], ["A"]);
  await w.sync();
  await writeFile(join(w.vault, "A.md"), (await w.read("A.md")).replace("  - A", "  - a"));
  const before = await w.read("A.md");
  w.notion.calls.length = 0;
  await w.sync();
  assert.deepEqual(w.tagCalls(), []);
  assert.equal(await w.read("A.md"), before);
  assert.deepEqual(w.pageTags(), ["A"]);
});

test("tags: a Notion tag a note can't hold stays in Notion, is warned once per run, and changes nothing", async (t) => {
  const w = await tagsWorld(t, ["x"], ["to do", "x"]);
  const lines: string[] = [];
  await w.sync({ log: (line) => lines.push(line) });
  assert.deepEqual(w.pageTags(), ["to do", "x"]);
  assert.equal(lines.filter((l) => l.includes('the Notion tag "to do" can\'t be an Obsidian tag')).length, 1);
  assert.match(await w.read("A.md"), /tags:\n {2}- x\n(notion-id: [^\n]*\n)?---/);
  w.notion.calls.length = 0;
  const again = await w.sync();
  assert.deepEqual(w.tagCalls(), []);
  assert.deepEqual(again.plan.actions, []);
  assert.deepEqual(w.pageTags(), ["to do", "x"]);
});

test("tags: frontmatter the sync can't edit safely is left alone, with a warning", async (t) => {
  const w = await tagsWorld(t, [], ["p"]);
  const text = "---\ntags: a # comment\n---\nBody\n";
  await writeTree(w.vault, { "A.md": text });
  const lines: string[] = [];
  await w.sync({ log: (line) => lines.push(line) });
  assert.ok(lines.some((l) => l.startsWith("warning: A.md: its frontmatter \"tags\" can't be edited safely (") && l.endsWith("; its tags are left alone")));
  assert.match(await w.read("A.md"), /tags: a # comment/);
  assert.deepEqual(w.tagCalls(), []);
  assert.deepEqual(w.pageTags(), ["p"]);
});

test("tags: a waiting note and a truncated page keep their tags and records as they were", async (t) => {
  const w = await tagsWorld(t, ["a"], ["a"]);
  await w.sync();
  const was = await recordOf(w.state, w.id);
  // The note is open in Obsidian: the page's tag edit waits.
  w.notion.edit(w.id, { tags: ["a", "b"] });
  const open: ObsidianProbe = { running: async () => true, openTabs: async () => new Set(["A.md"]), modifiedAt: async () => null };
  const waiting = await w.sync({ obsidian: open });
  assert.deepEqual(waiting.plan.waiting, ["A.md"]);
  assert.match(await w.read("A.md"), /tags:\n {2}- a\n(notion-id: [^\n]*\n)?---/);
  assert.deepEqual((await recordOf(w.state, w.id)).tags, was.tags);
  assert.deepEqual(w.pageTags(), ["a", "b"]);
  // The page is too large to read: left alone with its note.
  w.notion.edit(w.id, { truncated: true });
  await writeFile(join(w.vault, "A.md"), (await w.read("A.md")).replace("  - a\n", "  - a\n  - z\n"));
  await w.sync();
  assert.deepEqual(w.pageTags(), ["a", "b"]);
  assert.deepEqual((await recordOf(w.state, w.id)).tags, was.tags);
  assert.match(await w.read("A.md"), /- z/);
});

test("tags: an open note with only its tags edited is not pushed and is listed as waiting; the page's tags are not written into it", async (t) => {
  const w = await tagsWorld(t, ["a"], ["a"]);
  await w.sync();
  await w.sync(); // settled: nothing left to do
  const was = await recordOf(w.state, w.id);
  // Only the frontmatter tags change, in a note that is open in Obsidian.
  await writeFile(join(w.vault, "A.md"), (await w.read("A.md")).replace("  - a\n", "  - a\n  - half\n"));
  const before = await w.read("A.md");
  w.notion.calls.length = 0;
  const open = probe(["A.md"], OLD);
  const run = await w.sync({ obsidian: open });
  assert.deepEqual(w.tagCalls(), []);
  assert.deepEqual(w.pageTags(), ["a"]);
  assert.deepEqual((await recordOf(w.state, w.id)).tags, was.tags);
  assert.deepEqual(run.plan.waiting, ["A.md"]);
  assert.equal(await w.read("A.md"), before);
  // The dry run leaves it out too, and lists it as waiting.
  const dry = await w.sync({ dryRun: true, obsidian: open });
  assert.deepEqual(dry.plan.waiting, ["A.md"]);
  assert.ok(!dry.plan.actions.some((a) => JSON.stringify(a).includes("tags")));
  // Closed, the tags go through.
  await w.sync({ obsidian: probe([], OLD) });
  assert.deepEqual(w.pageTags(), ["a", "half"]);
});

test("tags: with no base yet, an open note is not written with its page's tags", async (t) => {
  const w = await setup(t);
  w.notion.addTags();
  const id = w.notion.add("A", "Body");
  w.notion.edit(id, { tags: ["p"] });
  await writeTree(w.vault, { "A.md": "Body\n" });
  await w.sync(); // tags off: the record has no tags, and the page is not edited again afterwards
  await w.sync(); // settled: nothing left to do for the note
  w.config.tagsProperty = "Tags";
  const before = await w.read("A.md");
  const run = await w.sync({ obsidian: probe(["A.md"], OLD) });
  assert.equal(await w.read("A.md"), before);
  assert.equal((await recordOf(w.state, id)).tags, undefined);
  assert.deepEqual(run.plan.waiting, ["A.md"]);
  await w.sync({ obsidian: probe([], OLD) });
  assert.match(await w.read("A.md"), /tags:\n {2}- p\n/);
});

test("tags off (no property) leaves records and output as before", async (t) => {
  const w = await setup(t);
  w.config.tagsProperty = "Tags"; // the database has no such property
  w.notion.add("A", "Body");
  await writeTree(w.vault, { "A.md": "---\ntags:\n  - a\n---\nBody\n" });
  const lines: string[] = [];
  const out = await w.sync({ log: (line) => lines.push(line) });
  assert.ok(lines.includes('note: the database has no "Tags" property; tags are left alone'));
  const id = w.pageNamed("A")!.id;
  assert.equal("tags" in (await recordOf(w.state, id)), false);
  assert.equal("tagsSet" in out.summary!, false);
  assert.doesNotMatch(formatSummary(out.summary!, out.plan), /tags/);
  assert.equal(await w.read("A.md"), `---\ntags:\n  - a\nnotion-id: ${id}\n---\nBody\n`);
});

test("tags: --dry-run lists the tag changes and writes nothing", async (t) => {
  const w = await tagsWorld(t, ["a"], []);
  await w.sync();
  await writeFile(join(w.vault, "A.md"), (await w.read("A.md")).replace("  - a\n", "  - a\n  - n\n"));
  w.notion.edit(w.id, { tags: ["a", "p"] });
  const before = await w.read("A.md");
  w.notion.calls.length = 0;
  const out = await w.sync({ dryRun: true });
  assert.deepEqual(out.tagsPreview, ["write tags to A.md", "set tags in Notion on A.md"]);
  assert.deepEqual(w.tagCalls(), []);
  assert.equal(await w.read("A.md"), before);
  assert.deepEqual(w.pageTags(), ["a", "p"]);
});

test("tags: an edit of only the tags in Notion is pulled, and one of only the frontmatter tags in the note is pushed", async (t) => {
  const w = await tagsWorld(t, ["a"], ["a"]);
  await w.sync();
  w.notion.edit(w.id, { tags: ["a", "p"] });
  const pulled = await w.sync();
  assert.equal(pulled.summary!.tagsWritten, 1);
  assert.match(await w.read("A.md"), /tags:\n {2}- a\n {2}- p\n(notion-id: [^\n]*\n)?---/);
  await writeFile(join(w.vault, "A.md"), (await w.read("A.md")).replace("  - p\n", "  - p\n  - n\n"));
  const pushed = await w.sync();
  assert.equal(pushed.summary!.tagsSet, 1);
  assert.deepEqual(w.pageTags(), ["a", "p", "n"]);
  assert.deepEqual((await recordOf(w.state, w.id)).tags, ["a", "p", "n"]);
});

// Images that end a list item or a quote are its child blocks in Notion, and the note's lines are left as they are.
const childImage = (markdown: string) => markdown.split("\n").map((l) => l.replace(/\(https:[^)]*\)/, "(url)"));

test("an image that ends a list item is the item's child in Notion, uploaded once; the next run is quiet", async (t) => {
  const { vault, notion, sync, pageNamed } = await setup(t);
  await writeTree(vault, { ...app, [`${FOLDER}/a.png`]: "v1", "A.md": "- item\n![[a.png]]\n- two\n" });
  const first = await sync();
  assert.deepEqual(first.plan.warnings, []);
  assert.deepEqual(childImage(pageNamed("A")!.markdown), ["- item", "\t![](url)", "- two"]);
  assert.deepEqual((await notion.mediaBlocks(pageNamed("A")!.id)).map((b) => b.kind), ["image"]);
  assert.equal(count(notion, "uploadFile"), 1);
  const next = await sync();
  assert.deepEqual(next.plan.actions, []);
  assert.equal(count(notion, "uploadFile"), 1);
});

test("a Notion edit of the item text pulls only that line, and the note's image line is untouched (Review Focus 4)", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { ...app, [`${FOLDER}/a.png`]: "v1", "A.md": "Intro\n\n- item\n![[a.png]]\n- two\n" });
  await sync();
  const first = await read("A.md");
  const page = pageNamed("A")!;
  notion.edit(page.id, { markdown: page.markdown.replace("- item", "- item edited") });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual(outcome.summary!.done, { pull: 1 });
  assert.equal(await read("A.md"), first.replace("- item", "- item edited"));
  assert.deepEqual((await sync()).plan.actions, []);
});

test("an image added in Notion under an existing item comes into the note one tab deeper than the item", async (t) => {
  const { vault, notion, sync, read, pageNamed } = await setup(t);
  await writeTree(vault, { ...app, [`${FOLDER}/a.png`]: "v1", [`${FOLDER}/b.png`]: "v2", "A.md": "- item\n![[a.png]]\n- two\n" });
  await sync();
  const page = pageNamed("A")!;
  const placeholder = "https://nopipeline.invalid/vault/" + FOLDER + "/b.png";
  notion.edit(page.id, { markdown: page.markdown.replace("- two", `- two\n\t![](${placeholder})`) });
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.deepEqual(outcome.summary!.done, { pull: 1 });
  assert.match(await read("A.md"), /\n- two\n\t!\[\]\(b\.png\)\n$/);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a page synced with an item's trailing image as text gets it as a child on the next run, keeping a Notion edit made before (Review Focus 5)", async (t) => {
  const { notion, sync, read, tick, id, note } = await syncedBeforeImages(t, "- item\n![[whisk.png]]\n- two\n", "- item<br>!\\[\\[whisk.png\\]\\]\n- two");
  tick(2 * 60_000);
  notion.edit(id, { markdown: "- item<br>!\\[\\[whisk.png\\]\\]\n- two edited" });
  assert.deepEqual((await sync({ dryRun: true })).plan.actions, [{ kind: "pull", pageId: id }]);
  // Notion's edit is pulled first (the page changed since the record), then the image is made a child without touching that edit.
  const done: Record<string, number>[] = [];
  for (let n = 0; n < 2; n++) done.push((await sync()).summary!.done);
  assert.deepEqual(done, [{ pull: 1 }, { updateEmbeds: 1 }]);
  assert.equal(count(notion, "replaceContent"), 0);
  assert.deepEqual(childImage(notion.pages.get(id)!.markdown), ["- item", "\t![](url)", "- two edited"]);
  assert.equal(await read("A.md"), note.replace("- two", "- two edited"));
  assert.deepEqual((await sync()).plan.actions, []);
});

test("a page synced with a quote written with a blank `>` line gets the image as the quote's child, and an edit of the quote text is placed line by line", async (t) => {
  const { vault, notion, sync, read, id } = await syncedBeforeImages(t, "> text\n>\n> ![[whisk.png]]\n", "> text<br><br>!\\[\\[whisk.png\\]\\]");
  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.plan.actions, [{ kind: "updateEmbeds", pageId: id }]);
  assert.deepEqual((await sync()).summary!.done, { updateEmbeds: 1 });
  assert.deepEqual(childImage(notion.pages.get(id)!.markdown), ["> text", "\t![](url)"]);
  assert.deepEqual((await sync()).plan.actions, []);
  const before = notion.calls.length;
  await writeFile(join(vault, "A.md"), (await read("A.md")).replace("> text\n", "> text edited\n"));
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { push: 1 });
  assert.ok(notion.calls.slice(before).some((c) => c === `updateContent ${id}`) && !notion.calls.slice(before).some((c) => c.startsWith("replaceContent")), "placed line by line");
  assert.deepEqual(childImage(notion.pages.get(id)!.markdown), ["> text edited", "\t![](url)"]);
});

test("the dry run plans the update of a page that holds an item's trailing image as text", async (t) => {
  const { sync, id } = await syncedBeforeImages(t, "- item\n![[whisk.png]]\n", "- item<br>!\\[\\[whisk.png\\]\\]");
  const dry = await sync({ dryRun: true });
  assert.deepEqual(dry.plan.actions, [{ kind: "updateEmbeds", pageId: id }]);
  assert.match(formatPlan(dry.plan, dry.notes, dry.pages), /turn the attachment citations already synced into Notion blocks/);
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { updateEmbeds: 1 });
});

test("a citation of a file that is not in the vault prints no warning and stays text", async (t) => {
  const { vault, notion, sync, pageNamed } = await setup(t);
  await writeTree(vault, { ...app, "A.md": "- item\n![[gone.png]]\n\n![[gone.png]]\n" });
  const outcome = await sync();
  assert.deepEqual(outcome.plan.warnings, []);
  assert.doesNotMatch(formatSummary(outcome.summary!, outcome.plan), /not in the vault/);
  assert.equal(count(notion, "uploadFile"), 0);
  assert.match(pageNamed("A")!.markdown, /gone\.png/);
});

test("a quote made only of citations stays text with the shared warning", async (t) => {
  const { vault, sync } = await setup(t);
  await writeTree(vault, { ...app, [`${FOLDER}/a.png`]: "v1", [`${FOLDER}/b.png`]: "v2", "A.md": "> ![[a.png]]\n> ![[b.png]]\n" });
  const outcome = await sync();
  assert.equal(outcome.plan.warnings.length, 2);
  assert.match(outcome.plan.warnings.join("\n"), /a\.png[\s\S]*b\.png/);
});

/** A note synced to a page of these lines, then the page cut in Notion at the lines `cut` (0-based, left out). */
async function syncedThenCut(t: import("node:test").TestContext, lines: string[], cut: number[], unfetchable: number[] = []) {
  const s = await setup(t);
  const id = s.notion.add("A", lines.join("\n"));
  await s.sync();
  assert.equal(s.notion.pages.get(id)!.markdown, lines.join("\n"));
  s.notion.cut(id, cut, unfetchable);
  return { ...s, id };
}
const PAGE = ["intro", "- one", "\t- child", "- two", "end"];
const calls = (notion: FakeNotion, from: number) => notion.calls.slice(from);

test("a page Notion cuts, whose left-out blocks can be fetched, takes an edit made in Notion, one inside a left-out block included, and is then quiet", async (t) => {
  const { notion, sync, read, id } = await syncedThenCut(t, PAGE, [2, 3]);
  assert.deepEqual((await sync()).plan.actions, []);
  const edited = PAGE.map((line) => line.replace("- two", "- two edited").replace("\t- child", "\t- child edited"));
  notion.edit(id, { markdown: edited.join("\n") });
  notion.cut(id, [2, 3]);
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { pull: 1 });
  assert.deepEqual(outcome.summary!.skipped, []);
  assert.equal(await read("0-In/A.md"), `---\nnotion-id: ${id}\n---\nintro\n\n- one\n\t- child edited\n- two edited\n\nend\n`);
  assert.deepEqual((await sync()).plan.actions, []);
});

test("an edit made in Obsidian on such a page goes to it line by line, and the next run is quiet", async (t) => {
  const { vault, state, notion, sync, read, id } = await syncedThenCut(t, PAGE, [2, 3]);
  await writeFile(join(vault, "0-In/A.md"), (await read("0-In/A.md")).replace("intro", "intro edited"));
  const before = notion.calls.length;
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { push: 1 });
  assert.ok(calls(notion, before).includes(`updateContent ${id}`));
  assert.ok(!calls(notion, before).some((c) => c.startsWith("replaceContent")));
  assert.equal(notion.pages.get(id)!.markdown, ["intro edited", ...PAGE.slice(1)].join("\n"));
  assert.ok(!(await recordOf(state, id)).notionMarkdown.includes("<unknown"));
  assert.deepEqual((await sync()).plan.actions, []);
});

test("both apps editing different lines of such a page merge line by line", async (t) => {
  const { vault, state, notion, sync, read, id } = await syncedThenCut(t, PAGE, [2, 3]);
  await writeFile(join(vault, "0-In/A.md"), (await read("0-In/A.md")).replace("intro", "intro mine"));
  notion.edit(id, { markdown: PAGE.map((l) => l.replace("end", "end theirs")).join("\n") });
  notion.cut(id, [2, 3]);
  const before = notion.calls.length;
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, { merge: 1 });
  assert.ok(!calls(notion, before).some((c) => c.startsWith("replaceContent")));
  assert.equal(notion.pages.get(id)!.markdown, ["intro mine", "- one", "\t- child", "- two", "end theirs"].join("\n"));
  assert.match(await read("0-In/A.md"), /intro mine\n[\s\S]*end theirs/);
  assert.ok(!(await recordOf(state, id)).notionMarkdown.includes("<unknown"));
  assert.deepEqual((await sync()).plan.actions, []);
});

test("an edit in Obsidian that would need the whole page rewritten is skipped on a page Notion cuts, and nothing is written", async (t) => {
  const lines = Array.from({ length: 204 }, (_, k) => `- item ${String(k).padStart(4, "0")}`);
  const { vault, notion, sync, read, id } = await syncedThenCut(t, lines, [1, 101]);
  // More separate edits than one-by-one edits are used for.
  const text = await read("0-In/A.md");
  await writeFile(join(vault, "0-In/A.md"), lines.reduce((acc, line, k) => (k % 2 === 0 ? acc.replace(`${line}\n`, `${line} edited\n`) : acc), text));
  const before = notion.calls.length;
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, [{ path: "0-In/A.md", reason: "truncated: the page is too large to rewrite whole; make this edit in Notion, or in Obsidian line by line" }]);
  assert.ok(!calls(notion, before).some((c) => c.startsWith("replaceContent") || c.startsWith("updateContent")));
  assert.equal(notion.pages.get(id)!.markdown, lines.join("\n"));
});

test("a page Notion cuts with a block that can't be fetched is skipped and left alone, as before", async (t) => {
  const { vault, notion, sync, read, id } = await syncedThenCut(t, PAGE, [2, 3], [3]);
  await writeFile(join(vault, "0-In/A.md"), (await read("0-In/A.md")).replace("intro", "intro edited"));
  const before = notion.calls.length;
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, {});
  assert.deepEqual(outcome.summary!.skipped, [{ path: "0-In/A.md", reason: "truncated: the page is too large to read completely; it is left alone" }]);
  assert.ok(!calls(notion, before).some((c) => c.startsWith("replaceContent") || c.startsWith("updateContent")));
  assert.equal(notion.pages.get(id)!.markdown, PAGE.join("\n"));
});

test("pairing a note with a page Notion cuts never replaces the page whole", async (t) => {
  const { vault, notion, sync } = await setup(t);
  const id = notion.add("A", PAGE.join("\n"));
  notion.cut(id, [2, 3]);
  await writeTree(vault, { "A.md": "Something else entirely\n" });
  const before = notion.calls.length;
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, [{ path: "A.md", reason: "truncated: the page is too large to rewrite whole; make this edit in Notion, or in Obsidian line by line" }]);
  assert.ok(!calls(notion, before).some((c) => c.startsWith("replaceContent")));
  assert.equal(notion.pages.get(id)!.markdown, PAGE.join("\n"));
});

const NOT_LOADED = "truncated: this edit touches a part of the page Notion doesn't load for editing; make it in Notion";

test("an edit that reaches into a left-out block is skipped before anything is sent; one in the loaded part still goes through", async (t) => {
  const { vault, notion, sync, read, id } = await syncedThenCut(t, PAGE, [2]);
  const text = await read("0-In/A.md");
  await writeFile(join(vault, "0-In/A.md"), text.replace("- one\n\t- child", "- one edited\n\t- child edited"));
  const before = notion.calls.length;
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.done, {});
  assert.deepEqual(outcome.summary!.skipped, [{ path: "0-In/A.md", reason: NOT_LOADED }]);
  assert.ok(!calls(notion, before).some((c) => c.startsWith("replaceContent") || c.startsWith("updateContent")));
  assert.equal(notion.pages.get(id)!.markdown, PAGE.join("\n"));
  // The same note with only the loaded line edited goes through.
  await writeFile(join(vault, "0-In/A.md"), text.replace("intro", "intro edited"));
  const next = await sync();
  assert.deepEqual(next.summary!.done, { push: 1 });
  assert.equal(notion.pages.get(id)!.markdown, ["intro edited", ...PAGE.slice(1)].join("\n"));
});

test("a conflicted merge on a page Notion cuts, which would need a whole rewrite, leaves no conflict copy", async (t) => {
  const lines = Array.from({ length: 204 }, (_, k) => `- item ${String(k).padStart(4, "0")}`);
  const { vault, notion, sync, read, id } = await syncedThenCut(t, lines, [1, 101]);
  const text = await read("0-In/A.md");
  await writeFile(join(vault, "0-In/A.md"), lines.reduce((acc, line, k) => (k % 2 === 0 ? acc.replace(`${line}\n`, `${line} edited\n`) : acc), text));
  notion.edit(id, { markdown: lines.map((l, k) => (k === 0 ? `${l} theirs` : l)).join("\n") });
  notion.cut(id, [1, 101]);
  const outcome = await sync();
  assert.deepEqual(outcome.summary!.skipped, [{ path: "0-In/A.md", reason: "truncated: the page is too large to rewrite whole; make this edit in Notion, or in Obsidian line by line" }]);
  assert.deepEqual(outcome.summary!.conflicts, []);
  assert.deepEqual((await readdir(join(vault, "0-In"))).filter((n) => n.includes("conflict")), []);
});
