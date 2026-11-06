// Edits land on their own line whatever form each app writes the lines in (final review C1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { exitCode } from "../src/report.ts";
import { runSync } from "../src/sync.ts";
import { FakeNotion } from "./helpers/fake-notion.ts";
import { tempDir, writeTree } from "./helpers/tmp.ts";

async function setup(t: import("node:test").TestContext, projects = false) {
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
    massTrashLimit: 10,
    tokenFile: null,
    stateDir: state,
  };
  const sync = () => {
    clock += 5 * 60_000;
    return runSync({ config, notion, dryRun: false, yes: true, allowMassTrash: false, now, log: () => {} });
  };
  const read = (path: string) => readFile(join(vault, path), "utf8");
  const body = async (path: string) => (await read(path)).replace(/^---\n[\s\S]*?\n---\n/, "");
  const pageNamed = (title: string) => [...notion.pages.values()].find((p) => p.title === title && !p.inTrash)!;
  return { vault, state, notion, sync, read, body, pageNamed };
}

/** A note synced once, then edited in Notion; returns the note's body after the pull. */
async function pullInto(t: import("node:test").TestContext, note: string, edit: (markdown: string) => string) {
  const s = await setup(t);
  await writeTree(s.vault, { "Note.md": note });
  await s.sync();
  const page = s.pageNamed("Note");
  const edited = edit(page.markdown);
  assert.notEqual(edited, page.markdown, "the edit changes the page");
  s.notion.edit(page.id, { markdown: edited });
  const outcome = await s.sync();
  assert.deepEqual(outcome.summary!.done, { pull: 1 });
  assert.deepEqual(outcome.summary!.rewritten, []);
  assert.deepEqual((await s.sync()).plan.actions, [], "the next run has nothing to do");
  return s.body("Note.md");
}

test("a Notion edit lands on its own line of a note written in other forms", async (t) => {
  // Hard line breaks (trailing spaces).
  assert.equal(await pullInto(t, "Address  \nStreet 1  \nCity 2  \nCountry\n", (md) => md.replace("City 2", "City 3")), "Address  \nStreet 1  \nCity 3  \nCountry\n");
  // Extra spaces after list markers.
  assert.equal(await pullInto(t, "Shopping\n\n-   milk\n-   eggs\n-   bread\n", (md) => md.replace("- bread", "- rye bread")), "Shopping\n\n-   milk\n-   eggs\n-   rye bread\n");
  // Upper-case task boxes.
  assert.equal(await pullInto(t, "- [X] one\n- [X] two\n- [X] three\n", (md) => md.replace("- [x] three", "- [ ] three")), "- [X] one\n- [X] two\n- [ ] three\n");
  // `*` bullets and `1)` lists.
  assert.equal(await pullInto(t, "Intro\n\n* alpha\n* beta\n* gamma\n\nEnd\n", (md) => md.replace("- gamma", "- gamma, edited in Notion")), "Intro\n\n* alpha\n* beta\n* gamma, edited in Notion\n\nEnd\n");
  assert.equal(await pullInto(t, "Steps\n\n1) first\n2) second\n3) third\n", (md) => md.replace("third", "third, edited in Notion")), "Steps\n\n1) first\n2) second\n3) third, edited in Notion\n");
  // A padded table: a cell edited, then a row deleted, in Notion.
  const table = "Intro\n\n| Species | Use        |\n| ------- | ---------- |\n| Elm     | shadowed   |\n| Oak     | knotted    |\n| Yew     | timbers    |\n\nEnd\n";
  assert.equal(
    await pullInto(t, table, (md) => md.replace("<td>timbers</td>", "<td>split timbers</td>")),
    "Intro\n\n| Species | Use        |\n| ------- | ---------- |\n| Elm     | shadowed   |\n| Oak     | knotted    |\n| Yew | split timbers |\n\nEnd\n",
  );
  assert.equal(
    await pullInto(t, table, (md) => md.replace(/\t<tr>\n\t\t<td>Yew<\/td>\n\t\t<td>timbers<\/td>\n\t<\/tr>\n/, "")),
    "Intro\n\n| Species | Use        |\n| ------- | ---------- |\n| Elm     | shadowed   |\n| Oak     | knotted    |\n\nEnd\n",
  );
});

for (const projects of [false, true]) test(`an Obsidian edit lands on its own line of a page with date and outside-page mentions${projects ? " (projects on)" : ""}`, async (t) => {
  for (const [markdown, from, to] of [
    ['Log\n- <mention-date start="2026-09-01"/> started\n- <mention-date start="2026-09-02"/> continued\n- <mention-date start="2026-09-03"/> finished\nEnd', "finished", "finished late"],
    [
      'Areas\n- <mention-page url="https://app.notion.com/p/f81667b8032f4c488b1ec45e19085615"/> first\n- <mention-page url="https://app.notion.com/p/f81667b8032f4c488b1ec45e19085615"/> second\n- <mention-page url="https://app.notion.com/p/f81667b8032f4c488b1ec45e19085615"/> third\nEnd',
      "third",
      "third, edited in Obsidian",
    ],
  ] as const) {
    const s = await setup(t, projects);
    s.notion.outside.set("f81667b8-032f-4c48-8b1e-c45e19085615", "Grove");
    const id = s.notion.add("Log", markdown);
    await s.sync();
    await writeFile(join(s.vault, "0-In/Log.md"), (await s.read("0-In/Log.md")).replace(from, to));
    const outcome = await s.sync();
    assert.deepEqual(outcome.summary!.done, { push: 1 });
    assert.deepEqual(outcome.summary!.rewritten, []);
    const before = markdown.split("\n");
    const after = s.notion.pages.get(id)!.markdown.split("\n");
    assert.equal(after.length, before.length);
    const differ = before.flatMap((line, k) => (line === after[k] ? [] : [k]));
    assert.deepEqual(differ, [3], "only the edited line changed");
    assert.match(after[3]!, new RegExp(`${to}$`));
    assert.deepEqual((await s.sync()).plan.actions, []);
  }
});

test("an edit pulled into a note in another form, then a line deleted in Obsidian, leaves both apps the same", async (t) => {
  const s = await setup(t);
  await writeTree(s.vault, { "Note.md": "Intro\n\n* alpha\n* beta\n* gamma\n\nEnd\n" });
  await s.sync();
  const page = s.pageNamed("Note");
  s.notion.edit(page.id, { markdown: page.markdown.replace("- gamma", "- gamma, edited in Notion") });
  await s.sync();
  assert.equal(await s.body("Note.md"), "Intro\n\n* alpha\n* beta\n* gamma, edited in Notion\n\nEnd\n");
  await writeFile(join(s.vault, "Note.md"), (await s.read("Note.md")).replace("* beta\n", ""));
  assert.deepEqual((await s.sync()).summary!.done, { push: 1 });
  assert.equal(s.notion.pages.get(page.id)!.markdown, "Intro\n- alpha\n- gamma, edited in Notion\nEnd");
  assert.equal(await s.body("Note.md"), "Intro\n\n* alpha\n* gamma, edited in Notion\n\nEnd\n");
  assert.deepEqual((await s.sync()).plan.actions, []);
});

// A one-line `$$ … $$` formula is written on three lines on the way back, so an edit inside it can't be placed
// on the note's line, and rewriting the note from the page would lose the note's own form of the formula.
const formula = "Energy:\n\n$$ E = mc^2 $$\n\n*   done\n";
const calls = (notion: FakeNotion, from: number) => notion.calls.slice(from).filter((call) => /^(updateContent|replaceContent)/.test(call));

test("a pull that can't be placed on a note whose formatting a rewrite would lose is skipped with instructions, until the note says the same", async (t) => {
  const s = await setup(t);
  await writeTree(s.vault, { "Physics.md": formula });
  await s.sync();
  const page = s.pageNamed("Physics");
  const edited = page.markdown.replace("mc^2", "mc^3");
  s.notion.edit(page.id, { markdown: edited });
  const note = await s.read("Physics.md");
  for (let run = 0; run < 2; run++) {
    const outcome = await s.sync();
    assert.deepEqual(outcome.summary!.done, {});
    assert.deepEqual(outcome.summary!.rewritten, []);
    assert.deepEqual(outcome.summary!.skipped.map((skip) => skip.reason), [
      "not_matched: Notion's edit couldn't be matched to the note line by line, and rewriting the note would lose its formatting; make the same edit in Obsidian (the next run then records both as synced), or undo it in Notion",
    ]);
    assert.equal(exitCode(outcome.summary, outcome.plan), 1);
    assert.equal(await s.read("Physics.md"), note);
    assert.equal(s.notion.pages.get(page.id)!.markdown, edited);
  }
  // The same edit made in Obsidian: both sides say the same, so the run records them and writes nothing.
  await writeFile(join(s.vault, "Physics.md"), note.replace("mc^2", "mc^3"));
  const before = s.notion.calls.length;
  const agreed = await s.sync();
  assert.deepEqual(agreed.summary!.done, { merge: 1 });
  assert.deepEqual(agreed.summary!.conflicts, []);
  assert.deepEqual(calls(s.notion, before), []);
  assert.equal(await s.body("Physics.md"), formula.replace("mc^2", "mc^3"));
  assert.equal(s.notion.pages.get(page.id)!.markdown, edited);
  assert.deepEqual((await s.sync()).plan.actions, []);
});

test("a merge whose Notion edits can't be placed on a note whose formatting a rewrite would lose is skipped, until both sides say the same", async (t) => {
  const s = await setup(t);
  await writeTree(s.vault, { "Physics.md": formula });
  await s.sync();
  const page = s.pageNamed("Physics");
  s.notion.edit(page.id, { markdown: page.markdown.replace("mc^2", "mc^3") });
  const mine = (await s.read("Physics.md")).replace("Energy:", "Energy, edited in Obsidian:");
  await writeFile(join(s.vault, "Physics.md"), mine);
  const outcome = await s.sync();
  assert.deepEqual(outcome.summary!.done, {});
  assert.deepEqual(outcome.summary!.conflicts, []);
  assert.match(outcome.summary!.skipped[0]!.reason, /^not_matched: both apps changed it, .*make the note and the page say the same thing by hand/);
  assert.equal(await s.read("Physics.md"), mine);
  assert.deepEqual(await readdir(s.vault), ["Physics.md"]);
  // Made the same by hand on both sides: recorded as synced, nothing written.
  await writeFile(join(s.vault, "Physics.md"), mine.replace("mc^2", "mc^3"));
  s.notion.edit(page.id, { markdown: s.notion.pages.get(page.id)!.markdown.replace("Energy:", "Energy, edited in Obsidian:") });
  const before = s.notion.calls.length;
  assert.deepEqual((await s.sync()).summary!.done, { merge: 1 });
  assert.deepEqual(calls(s.notion, before), []);
  assert.deepEqual((await s.sync()).plan.actions, []);
});

// Notion keeps a code block's language under its own name (`js` as javascript, live probe): the note's
// fence line is matched under that name, so edits to it and next to it are placed line by line (final review,
// third round N2).
async function jsNote(t: import("node:test").TestContext) {
  const s = await setup(t);
  await writeTree(s.vault, { "Code.md": "Intro\n\n```js\nlet x = 1\n```\n" });
  await s.sync();
  return { ...s, page: s.pageNamed("Code") };
}

test("a code block whose language Notion names its own way takes edits line by line both ways", async (t) => {
  // Pull: Notion changes the language.
  const pull = await jsNote(t);
  assert.equal(pull.page.markdown, "Intro\n```javascript\nlet x = 1\n```");
  pull.notion.edit(pull.page.id, { markdown: pull.page.markdown.replace("```javascript", "```python") });
  const pulled = await pull.sync();
  assert.deepEqual(pulled.summary!.done, { pull: 1 });
  assert.deepEqual(pulled.summary!.rewritten, []);
  assert.equal(await pull.body("Code.md"), "Intro\n\n```python\nlet x = 1\n```\n");
  assert.deepEqual((await pull.sync()).plan.actions, []);
  // Push: Obsidian changes the language, and Notion keeps it under its own name.
  const push = await jsNote(t);
  await writeFile(join(push.vault, "Code.md"), (await push.read("Code.md")).replace("```js", "```ts"));
  const pushed = await push.sync();
  assert.deepEqual(pushed.summary!.done, { push: 1 });
  assert.deepEqual(pushed.summary!.rewritten, []);
  assert.equal(push.notion.pages.get(push.page.id)!.markdown, "Intro\n```typescript\nlet x = 1\n```");
  assert.deepEqual((await push.sync()).plan.actions, []);
  // Merge: Notion's language and Obsidian's edit next to it.
  const merge = await jsNote(t);
  merge.notion.edit(merge.page.id, { markdown: merge.page.markdown.replace("```javascript", "```python") });
  await writeFile(join(merge.vault, "Code.md"), (await merge.read("Code.md")).replace("Intro", "Intro, edited in Obsidian"));
  const merged = await merge.sync();
  assert.deepEqual(merged.summary!.done, { merge: 1 });
  assert.deepEqual(merged.summary!.conflicts, []);
  assert.deepEqual(merged.summary!.rewritten, []);
  assert.equal(await merge.body("Code.md"), "Intro, edited in Obsidian\n\n```python\nlet x = 1\n```\n");
  assert.equal(merge.notion.pages.get(merge.page.id)!.markdown, "Intro, edited in Obsidian\n```python\nlet x = 1\n```");
  assert.deepEqual((await merge.sync()).plan.actions, []);
});

// A code block under a list item whose every line starts with a tab: Notion keeps its lines flush left, so they
// read with one tab fewer than the note writes them (README, Known limitations) and an edit to them has no
// counterpart on the other side.
const tabbed = "Steps\n\n- step\n\t```python\n\t\treturn x\n\t\tpass\n\t```\n";
const tabbedPage = "Steps\n- step\n\t```python\n\treturn x\n\tpass\n\t```";

test("an edit that can't be placed rewrites the page whole only when it loses nothing, and says so", async (t) => {
  // Push: the page takes the note's text, with the smallest edits.
  const push = await setup(t);
  await writeTree(push.vault, { "Code.md": tabbed });
  await push.sync();
  const page = push.pageNamed("Code");
  assert.equal(page.markdown, tabbedPage);
  await writeFile(join(push.vault, "Code.md"), (await push.read("Code.md")).replace("return x", "return y"));
  const pushed = await push.sync();
  assert.deepEqual(pushed.summary!.done, { push: 1 });
  assert.deepEqual(pushed.summary!.rewritten, ["Code.md"]);
  assert.equal(exitCode(pushed.summary, pushed.plan), 1);
  assert.equal(push.notion.pages.get(page.id)!.markdown, tabbedPage.replace("return x", "return y"));
  assert.deepEqual((await push.sync()).plan.actions, []);
  // Merge: Notion's edit is placed on the note, and the page takes the merged text whole.
  const merge = await setup(t);
  await writeTree(merge.vault, { "Code.md": tabbed });
  await merge.sync();
  const both = merge.pageNamed("Code");
  merge.notion.edit(both.id, { markdown: both.markdown.replace("Steps", "Steps, edited in Notion") });
  await writeFile(join(merge.vault, "Code.md"), (await merge.read("Code.md")).replace("return x", "return y"));
  const merged = await merge.sync();
  assert.deepEqual(merged.summary!.done, { merge: 1 });
  assert.deepEqual(merged.summary!.conflicts, []);
  assert.deepEqual(merged.summary!.rewritten, ["Code.md"]);
  assert.equal(await merge.body("Code.md"), tabbed.replace("Steps", "Steps, edited in Notion").replace("return x", "return y"));
  assert.equal(merge.notion.pages.get(both.id)!.markdown, tabbedPage.replace("Steps", "Steps, edited in Notion").replace("return x", "return y"));
  const [run] = await readdir(join(merge.state, "backups"));
  assert.match(await readFile(join(merge.state, "backups", run!, "Code.md"), "utf8"), /return x/);
  assert.deepEqual((await merge.sync()).plan.actions, []);
});

test("a Notion edit to such a block is skipped, never rewritten into the note with a tab fewer on every line, until the note says the same (final review, third round N3)", async (t) => {
  const s = await setup(t);
  await writeTree(s.vault, { "Code.md": tabbed });
  await s.sync();
  const page = s.pageNamed("Code");
  const edited = page.markdown.replace("return x", "return y");
  s.notion.edit(page.id, { markdown: edited });
  const note = await s.read("Code.md");
  const skipped = await s.sync();
  assert.deepEqual(skipped.summary!.rewritten, []);
  assert.deepEqual(skipped.summary!.skipped.map((skip) => skip.reason.split(";")[0]), ["not_matched: Notion's edit couldn't be matched to the note line by line, and rewriting the note would lose its formatting"]);
  assert.equal(await s.read("Code.md"), note);
  // The same edit made in Obsidian: recorded as synced, nothing written, every line keeps its tabs.
  await writeFile(join(s.vault, "Code.md"), note.replace("return x", "return y"));
  const before = s.notion.calls.length;
  assert.deepEqual((await s.sync()).summary!.done, { merge: 1 });
  assert.deepEqual(calls(s.notion, before), []);
  assert.equal(await s.body("Code.md"), tabbed.replace("return x", "return y"));
  assert.equal(s.notion.pages.get(page.id)!.markdown, edited);
  assert.deepEqual((await s.sync()).plan.actions, []);
});

// A page written in Notion: dates and people mentioned, an empty block, a bookmark, a toggle heading, a video.
const plan = [
  "Draft",
  '- <mention-date start="2026-09-01"/> started with <mention-user url="user://u1">Ana</mention-user>',
  "<empty-block/>",
  '<unknown url="https://example.com/a" alt="bookmark"/>',
  '## Details {toggle="true"}',
  "\tHidden detail",
  '<video src="https://example.com/v.mp4">Demo video</video>',
  "End",
].join("\n");

test("an Obsidian edit next to a date mention and an empty block changes only that line of the page", async (t) => {
  const s = await setup(t);
  const id = s.notion.add("Draft", plan);
  await s.sync();
  await writeFile(join(s.vault, "0-In/Draft.md"), (await s.read("0-In/Draft.md")).replace("started", "started late"));
  const outcome = await s.sync();
  assert.deepEqual(outcome.summary!.done, { push: 1 });
  assert.deepEqual(outcome.summary!.rewritten, []);
  const before = plan.split("\n");
  const after = s.notion.pages.get(id)!.markdown.split("\n");
  assert.deepEqual(after.filter((line, k) => line !== before[k]), ["- 2026-09-01 started late with @Ana"]);
  assert.equal(after.length, before.length);
  assert.deepEqual((await s.sync()).plan.actions, []);
});

test("a push that can't be placed on a page that has what Obsidian can't hold is skipped with instructions, until the page says the same", async (t) => {
  const s = await setup(t);
  const id = s.notion.add("Draft", plan);
  await s.sync();
  // Deleting the toggle heading would leave its line nested under the bookmark.
  const note = (await s.read("0-In/Draft.md")).replace("## Details\n\n", "");
  await writeFile(join(s.vault, "0-In/Draft.md"), note);
  for (let run = 0; run < 2; run++) {
    const outcome = await s.sync();
    assert.deepEqual(outcome.summary!.skipped.map((skip) => skip.reason), [
      "not_matched: Obsidian's edit couldn't be matched to the page line by line, and rewriting the page would lose what Obsidian can't hold; make the same edit in Notion (the next run then records both as synced), or undo it in Obsidian",
    ]);
    assert.equal(s.notion.pages.get(id)!.markdown, plan);
    assert.equal(await s.read("0-In/Draft.md"), note);
  }
  // The same edit made in Notion.
  s.notion.edit(id, { markdown: plan.replace('## Details {toggle="true"}\n\tHidden detail', "Hidden detail") });
  const before = s.notion.calls.length;
  assert.deepEqual((await s.sync()).summary!.done, { merge: 1 });
  assert.deepEqual(calls(s.notion, before), []);
  assert.equal(await s.read("0-In/Draft.md"), note);
  assert.deepEqual((await s.sync()).plan.actions, []);
});

test("a push that would delete a block a note can't hold, such as a video, is refused and reported every run", async (t) => {
  const s = await setup(t);
  const id = s.notion.add("Draft", plan);
  await s.sync();
  const note = (await s.read("0-In/Draft.md")).replace('<video src="https://example.com/v.mp4">Demo video</video>\n\n', "");
  await writeFile(join(s.vault, "0-In/Draft.md"), note);
  for (let run = 0; run < 2; run++) {
    const outcome = await s.sync();
    assert.deepEqual(outcome.summary!.skipped.map((skip) => skip.reason.split(":")[0]), ["unsupported_blocks"]);
    assert.match(outcome.summary!.skipped[0]!.reason, /this edit would delete blocks a note can't hold \(.*videos.*\) from the page; make that edit in Notion and undo it in Obsidian/);
    assert.equal(s.notion.pages.get(id)!.markdown, plan);
  }
});

/** The page with its last quoted block deleted in Notion: the `>` line and, in Notion's form, the code nested under it. */
function withoutQuote(markdown: string, which: "first" | "last"): string {
  const lines = markdown.split("\n");
  const at = which === "first" ? lines.findIndex((l) => l.startsWith(">")) : lines.findLastIndex((l) => l.startsWith(">"));
  let end = at + 1;
  const fence = /^\t(`{3,})/.exec(lines[end] ?? "")?.[1];
  if (fence) {
    end++;
    while (end < lines.length && lines[end]!.trim() !== fence) end++;
    end++;
  }
  return [...lines.slice(0, at), ...lines.slice(end)].join("\n");
}

test("r5: Notion deleting one of two quoted code blocks deletes that block from the note, never lines of the other", async (t) => {
  const s = await setup(t);
  const note = "> ```\n>     i = 0\n> x = i + 1\n> ```\n\n> ```\n>     i = 0\n> ```\n";
  await writeTree(s.vault, { "Note.md": note });
  await s.sync();
  const page = s.pageNamed("Note");
  s.notion.edit(page.id, { markdown: withoutQuote(page.markdown, "first") });
  const outcome = await s.sync();
  const after = await s.body("Note.md");
  if (outcome.summary!.skipped.length) assert.equal(after, note);
  else assert.equal(after, "> ```\n>     i = 0\n> ```\n");
});

test("r6: a Notion edit inside one quoted code block lands in that block, never in another holding the same line", async (t) => {
  const s = await setup(t);
  const note = "> ```python\n> x = i + 1\n> i += 1\n> ```\n\n> ```\n> x = i + 1\n> ```\n";
  await writeTree(s.vault, { "Note.md": note });
  await s.sync();
  const page = s.pageNamed("Note");
  const at = page.markdown.lastIndexOf("x = i + 1");
  s.notion.edit(page.id, { markdown: `${page.markdown.slice(0, at)}x = i + 2${page.markdown.slice(at + "x = i + 1".length)}` });
  const outcome = await s.sync();
  const after = await s.body("Note.md");
  if (outcome.summary!.skipped.length) assert.equal(after, note);
  else assert.equal(after, "> ```python\n> x = i + 1\n> i += 1\n> ```\n\n> ```\n> x = i + 2\n> ```\n");
  assert.deepEqual((await s.sync()).plan.actions, []);
});

// Agreement sees nesting (final review, third round N1): a list item nested on one side is carried to the other,
// whatever else the other side changed, and never recorded as synced while the two differ.
test("a nesting edit on one side is carried across while the other side changes something else", async (t) => {
  // An embed: Notion writes a mention's page title into it (a note's link is a page link, which it doesn't touch).
  const note = "See ![[B]] here\n\n- a\n- b\n- c\n";
  const nestB = (text: string) => text.replace("- b\n", "\t- b\n");
  const titled = (md: string) => md.replace(/<mention-page url="([^"]+)"\/>/, '<mention-page url="$1">B</mention-page>');
  const cases: { name: string; notion: (md: string) => string; quiet?: boolean; obsidian: (text: string) => string; note: string; page: (md: string) => string }[] = [
    { name: "Notion adds an empty block", notion: (md) => md.replace("\n- a", "\n<empty-block/>\n- a"), obsidian: nestB, note: nestB(note), page: (md) => md.replace("\n- a", "\n<empty-block/>\n- a").replace("- b", "\t- b") },
    { name: "Notion colors an item", notion: (md) => md.replace("- c", '- c {color="red"}'), obsidian: nestB, note: nestB(note), page: (md) => md.replace("- c", '- c {color="red"}').replace("- b", "\t- b") },
    // Notion writes the linked page's title into the mention: the page's text changes, its edit time doesn't.
    { name: "the mention shows its page's title", notion: titled, quiet: true, obsidian: nestB, note: nestB(note), page: (md) => titled(md).replace("- b", "\t- b") },
    { name: "Notion nests an item, Obsidian changes a marker", notion: (md) => md.replace("- c", "\t- c"), obsidian: (text) => text.replace("- a\n", "* a\n"), note: note.replace("- a\n", "* a\n").replace("- c", "\t- c"), page: (md) => md.replace("- c", "\t- c") },
    { name: "each side nests another item", notion: (md) => md.replace("- c", "\t- c"), obsidian: nestB, note: nestB(note).replace("- c", "\t- c"), page: (md) => md.replace("- b", "\t- b").replace("- c", "\t- c") },
  ];
  for (const c of cases) {
    const s = await setup(t);
    await writeTree(s.vault, { "B.md": "The B note\n", "A.md": note });
    await s.sync();
    const page = s.pageNamed("A");
    const before = page.markdown;
    if (c.quiet) page.markdown = c.notion(before);
    else s.notion.edit(page.id, { markdown: c.notion(before) });
    await writeFile(join(s.vault, "A.md"), c.obsidian(await s.read("A.md")));
    const outcome = await s.sync();
    assert.deepEqual(outcome.summary!.done, { merge: 1 }, c.name);
    assert.deepEqual(outcome.summary!.skipped, [], c.name);
    assert.deepEqual(outcome.summary!.conflicts, [], c.name);
    assert.equal(await s.body("A.md"), c.note, c.name);
    assert.equal(s.notion.pages.get(page.id)!.markdown, c.page(before), c.name);
    assert.deepEqual((await s.sync()).plan.actions, [], c.name);
  }
});

// Every skip resolves by doing what its reason says (final review, third round N2): once the note says what the
// page says, the run records both as synced, whatever Notion writes its own way (a code language, a mention of a
// page outside the database, bookmarks, child pages, databases, synced blocks, a callout's own icon).
test("a skipped pull resolves once the note says what the page says, whatever forms only Notion writes", async (t) => {
  const outside = "f81667b8-032f-4c48-8b1e-c45e19085615";
  const outsideUrl = `https://app.notion.com/p/${outside.replace(/-/g, "")}`;
  const unplaced = "not_matched: Notion's edit couldn't be matched to the note line by line, and rewriting the note would lose its formatting; make the same edit in Obsidian (the next run then records both as synced), or undo it in Notion";
  /** Notion edits the formula, which the note writes on one line: skipped; then the same edit in Obsidian, or undone in Notion. */
  async function resolve(s: Awaited<ReturnType<typeof setup>>, path: string, id: string, how: "same edit" | "undo") {
    const before = s.notion.pages.get(id)!.markdown;
    s.notion.edit(id, { markdown: before.replace("mc^2", "mc^3") });
    const note = await s.read(path);
    const skipped = await s.sync();
    assert.deepEqual(skipped.summary!.skipped.map((skip) => skip.reason), [unplaced], path);
    assert.equal(await s.read(path), note);
    if (how === "same edit") await writeFile(join(s.vault, path), note.replace("mc^2", "mc^3"));
    else s.notion.edit(id, { markdown: before });
    const calls = s.notion.calls.length;
    const resolved = await s.sync();
    assert.deepEqual(resolved.summary!.skipped, [], path);
    assert.deepEqual(resolved.summary!.conflicts, [], path);
    assert.deepEqual(s.notion.calls.slice(calls).filter((call) => /^(updateContent|replaceContent)/.test(call)), [], `${path}: nothing written`);
    assert.equal(await s.read(path), how === "same edit" ? note.replace("mc^2", "mc^3") : note);
    assert.deepEqual((await s.sync()).plan.actions, [], path);
  }
  // A code language Notion names its own way (`js` is javascript), and the same undone in Notion.
  for (const how of ["same edit", "undo"] as const) {
    const s = await setup(t);
    await writeTree(s.vault, { "Code.md": "Intro\n\n```js\nlet x = 1\n```\n\nEnergy:\n\n$$ E = mc^2 $$\n" });
    await s.sync();
    await resolve(s, "Code.md", s.pageNamed("Code").id, how);
  }
  // A link the note holds to a page outside the database, which Notion holds as a mention.
  {
    const s = await setup(t);
    s.notion.outside.set(outside, "Outside page");
    await writeTree(s.vault, { "Ref.md": `See [Outside page](${outsideUrl}) here\n\nEnergy:\n\n$$ E = mc^2 $$\n` });
    await s.sync();
    const page = s.pageNamed("Ref");
    s.notion.edit(page.id, { markdown: page.markdown.replace(/\[Outside page\]\(([^)]+)\)/, '<mention-page url="$1"/>') });
    assert.deepEqual((await s.sync()).summary!.done, { pull: 1 });
    await resolve(s, "Ref.md", page.id, "same edit");
  }
  // A page written in Notion with a bookmark, a child page, an inline database, a synced block and a callout with
  // its own icon; the note then writes the formula on one line.
  {
    const s = await setup(t);
    const id = s.notion.add(
      "Mixed",
      [
        "Intro",
        '<unknown url="https://example.com/a" alt="bookmark"/>',
        `<page url="${outsideUrl}">Sub page</page>`,
        `<database url="${outsideUrl}">Tasks</database>`,
        `<synced_block url="${outsideUrl}">`,
        "\tShared text",
        "</synced_block>",
        '<callout icon="🚀">',
        "\tLaunch notes",
        "</callout>",
        "Energy:",
        "$$",
        "E = mc^2",
        "$$",
      ].join("\n"),
    );
    await s.sync();
    await writeFile(join(s.vault, "0-In/Mixed.md"), (await s.read("0-In/Mixed.md")).replace("$$\nE = mc^2\n$$", () => "$$ E = mc^2 $$"));
    assert.deepEqual((await s.sync()).summary!.done, { push: 1 });
    await resolve(s, "0-In/Mixed.md", id, "same edit");
  }
});

// Final review, third round N4: a code line added or re-indented inside a nested code block is written the way
// Notion writes that block (flush left), so it is placed; and a page with a blank line typed in Notion (an empty
// block) is never rewritten whole, since the note's form has no place for it.
test("a line added at the start of a nested code block, or re-indented in one, is placed in Notion's form", async (t) => {
  const s = await setup(t);
  await writeTree(s.vault, { "Code.md": "Intro\n\n> ```python\n> i = 0\n> print(i)\n> ```\n\n- step\n\t```bash\n\techo one\n\t```\n\nEnd\n" });
  await s.sync();
  const page = s.pageNamed("Code");
  assert.equal(page.markdown, "Intro\n>\n\t```python\ni = 0\nprint(i)\n\t```\n- step\n\t```bash\necho one\n\t```\nEnd");
  const note = (await s.read("Code.md")).replace("> ```python\n", "> ```python\n> # first\n").replace("\techo one\n", "\t    echo one\n");
  await writeFile(join(s.vault, "Code.md"), note);
  const outcome = await s.sync();
  assert.deepEqual(outcome.summary!.done, { push: 1 });
  assert.deepEqual(outcome.summary!.rewritten, []);
  assert.equal(s.notion.pages.get(page.id)!.markdown, "Intro\n>\n\t```python\n# first\ni = 0\nprint(i)\n\t```\n- step\n\t```bash\n    echo one\n\t```\nEnd");
  assert.deepEqual((await s.sync()).plan.actions, []);
  assert.equal(await s.read("Code.md"), note);
});

test("a page with a blank line typed in Notion is skipped rather than rewritten whole, until it says what the note says", async (t) => {
  const s = await setup(t);
  await writeTree(s.vault, { "Code.md": tabbed });
  await s.sync();
  const page = s.pageNamed("Code");
  const spaced = tabbedPage.replace("Steps\n", "Steps\n<empty-block/>\n");
  s.notion.edit(page.id, { markdown: spaced });
  assert.deepEqual((await s.sync()).summary!.done, { pull: 1 });
  // An Obsidian edit that can't be placed (see above): rewriting the page would delete the empty block.
  const note = (await s.read("Code.md")).replace("return x", "return y");
  await writeFile(join(s.vault, "Code.md"), note);
  for (let run = 0; run < 2; run++) {
    const outcome = await s.sync();
    assert.deepEqual(outcome.summary!.rewritten, []);
    assert.deepEqual(outcome.summary!.skipped.map((skip) => skip.reason.split(";")[0]), ["not_matched: Obsidian's edit couldn't be matched to the page line by line, and rewriting the page would lose what Obsidian can't hold"]);
    assert.equal(s.notion.pages.get(page.id)!.markdown, spaced);
  }
  // The same edit made in Notion.
  s.notion.edit(page.id, { markdown: spaced.replace("return x", "return y") });
  const before = s.notion.calls.length;
  assert.deepEqual((await s.sync()).summary!.done, { merge: 1 });
  assert.deepEqual(calls(s.notion, before), []);
  assert.equal(await s.read("Code.md"), note);
  assert.deepEqual((await s.sync()).plan.actions, []);
});

// Final review, fourth round P1 and P3: an Obsidian edit that Notion would hold differently is written, never recorded
// as synced, while Notion changes something Obsidian doesn't show; and a push that leaves every line of a nested
// code block tab-led is placed line by line.
test("an Obsidian edit to nested code or to a link reaches Notion while Notion changes what Obsidian doesn't show", async (t) => {
  const code = "Steps\n\n- step\n\t```python\n\treturn x\n\tpass\n\t```\n\nEnd\n";
  const indent = (text: string) => text.replace("\treturn x\n\tpass\n", "\t\treturn x\n\t\tpass\n");
  const linked = "See [B](B.md) here\n\nEnd\n";
  const escape = (text: string) => text.replace("[B](B.md)", "\\[\\[B\\]\\]");
  const cases: { name: string; note: string; obsidian: (text: string) => string; notion: ((md: string) => string) | null; done: string; page: (md: string) => string }[] = [
    { name: "every code line one tab deeper; Notion adds an empty block", note: code, obsidian: indent, notion: (md) => md.replace("\nEnd", "\n<empty-block/>\nEnd"), done: "merge", page: (md) => md.replace("return x\npass", "\treturn x\n\tpass").replace("\nEnd", "\n<empty-block/>\nEnd") },
    { name: "every code line one tab deeper; Notion colors a line", note: code, obsidian: indent, notion: (md) => md.replace("End", 'End {color="red"}'), done: "merge", page: (md) => md.replace("return x\npass", "\treturn x\n\tpass").replace("End", 'End {color="red"}') },
    { name: "every code line one tab deeper, pushed alone", note: code, obsidian: indent, notion: null, done: "push", page: (md) => md.replace("return x\npass", "\treturn x\n\tpass") },
    { name: "a link turned into text; Notion colors a line", note: linked, obsidian: escape, notion: (md) => md.replace("End", 'End {color="red"}'), done: "merge", page: (md) => md.replace(/\[B\]\(https:\/\/app\.notion\.com\/p\/[^)]+\)/, "\\[\\[B\\]\\]").replace("End", 'End {color="red"}') },
  ];
  for (const c of cases) {
    const s = await setup(t);
    await writeTree(s.vault, { "B.md": "The B note\n", "A.md": c.note });
    await s.sync();
    const page = s.pageNamed("A");
    const before = page.markdown;
    if (c.notion) s.notion.edit(page.id, { markdown: c.notion(before) });
    await writeFile(join(s.vault, "A.md"), c.obsidian(await s.read("A.md")));
    const outcome = await s.sync();
    assert.deepEqual(outcome.summary!.done, { [c.done]: 1 }, c.name);
    assert.deepEqual(outcome.summary!.skipped, [], c.name);
    assert.deepEqual(outcome.summary!.rewritten, [], c.name);
    assert.equal(s.notion.pages.get(page.id)!.markdown, c.page(before), c.name);
    assert.equal(await s.body("A.md"), c.obsidian(c.note), c.name);
    assert.deepEqual((await s.sync()).plan.actions, [], c.name);
  }
});

test("a code block a list item opens in a callout takes edits line by line both ways", async (t) => {
  const note = '> [!example]\n> - ```python\n> a = 1\n> b = 2\n> c = a + b\n\nAfter\n';
  // Pull: Notion changes a line of the code; the note's line changes in the note's own form.
  const pull = await setup(t);
  await writeTree(pull.vault, { "Code.md": note });
  await pull.sync();
  const page = pull.pageNamed("Code");
  assert.equal(page.markdown, '<callout icon="📑">\n\t-\n\t\t```python\na = 1\nb = 2\nc = a + b\n\t\t```\n</callout>\nAfter');
  pull.notion.edit(page.id, { markdown: page.markdown.replace("c = a + b\n\t\t```", "c = a * b\n\t\t```") });
  const pulled = await pull.sync();
  assert.deepEqual(pulled.summary!.done, { pull: 1 });
  assert.deepEqual(pulled.summary!.rewritten, []);
  assert.equal(await pull.body("Code.md"), note.replace("> c = a + b", "> c = a * b"));
  assert.deepEqual((await pull.sync()).plan.actions, []);
  // Push: Obsidian changes a line of the code; only that line changes in Notion.
  const push = await setup(t);
  await writeTree(push.vault, { "Code.md": note });
  await push.sync();
  const before = push.pageNamed("Code").markdown;
  await writeFile(join(push.vault, "Code.md"), (await push.read("Code.md")).replace("b = 2", "b = 5"));
  const pushed = await push.sync();
  assert.deepEqual(pushed.summary!.done, { push: 1 });
  assert.deepEqual(pushed.summary!.rewritten, []);
  assert.equal(push.pageNamed("Code").markdown, before.replace("b = 2", "b = 5"));
  assert.deepEqual((await push.sync()).plan.actions, []);
});

test("an edit to a line with a link reaches Notion, in a push and a merge, before and after the linked page is renamed", async (t) => {
  const s = await setup(t);
  await writeTree(s.vault, { "Timetable.md": "- Ferries leave at six; see [[River Path]] for the road.\n- Second line\n", "River Path.md": "Path note\n" });
  await s.sync();
  const walk = s.pageNamed("Timetable");
  const river = s.pageNamed("River Path");
  const url = `https://app.notion.com/p/${river.id.replace(/-/g, "")}`;
  const link = `[River Path](${url})`;
  assert.equal(walk.markdown, `- Ferries leave at six; see ${link} for the road.\n- Second line`);
  // Push: Notion finds the line by the page link as it returns it.
  await writeFile(join(s.vault, "Timetable.md"), (await s.read("Timetable.md")).replace("the road", "the bridge"));
  const pushed = await s.sync();
  assert.deepEqual(pushed.summary!.done, { push: 1 });
  assert.deepEqual(pushed.summary!.skipped, []);
  assert.equal(s.notion.pages.get(walk.id)!.markdown, `- Ferries leave at six; see ${link} for the bridge.\n- Second line`);
  // Merge: the same line edited in Obsidian, another in Notion.
  await writeFile(join(s.vault, "Timetable.md"), (await s.read("Timetable.md")).replace("the bridge", "the bridge or the ferry"));
  s.notion.edit(walk.id, { markdown: s.notion.pages.get(walk.id)!.markdown.replace("Second line", "Second line, edited in Notion") });
  const merged = await s.sync();
  assert.deepEqual(merged.summary!.done, { merge: 1 });
  assert.deepEqual(merged.summary!.skipped, []);
  assert.equal(s.notion.pages.get(walk.id)!.markdown, `- Ferries leave at six; see ${link} for the bridge or the ferry.\n- Second line, edited in Notion`);
  assert.equal(await s.body("Timetable.md"), "- Ferries leave at six; see [River Path](River%20Path.md) for the bridge or the ferry.\n- Second line, edited in Notion\n");
  // The linked page renamed in Notion: the next edit's search text holds its new title.
  s.notion.edit(river.id, { title: "River Path v3" });
  const moved = await s.sync();
  // The link's destination and its text, the old title, follow the rename, and the page gets the new text.
  assert.deepEqual(moved.summary!.done, { moveInVault: 1, push: 1 });
  assert.equal(await s.body("Timetable.md"), "- Ferries leave at six; see [River Path v3](River%20Path%20v3.md) for the bridge or the ferry.\n- Second line, edited in Notion\n");
  assert.equal(s.notion.pages.get(walk.id)!.markdown, `- Ferries leave at six; see [River Path v3](${url}) for the bridge or the ferry.\n- Second line, edited in Notion`);
  await writeFile(join(s.vault, "Timetable.md"), (await s.read("Timetable.md")).replace("or the ferry", "or a ferry"));
  const renamed = await s.sync();
  assert.deepEqual(renamed.summary!.done, { push: 1 });
  assert.equal(s.notion.pages.get(walk.id)!.markdown, `- Ferries leave at six; see [River Path v3](${url}) for the bridge or a ferry.\n- Second line, edited in Notion`);
  assert.deepEqual((await s.sync()).plan.actions, []);
});

test("a mention of a page in the trash is searched one way, then the other; one of a page Notion won't tell about (restricted_resource) stops the edit before anything is written", async (t) => {
  for (const form of ["self-closing", "titled"] as const) {
    const s = await setup(t);
    s.notion.trashedMentions = form;
    const gone = s.notion.add("Old note", "");
    await s.notion.trash(gone);
    const page = s.notion.add("Index", `Intro\nSee <mention-page url="https://app.notion.com/p/${gone.replace(/-/g, "")}"/> here\nEnd`);
    await s.sync();
    await writeFile(join(s.vault, "0-In/Index.md"), (await s.read("0-In/Index.md")).replace("Intro", "Intro, edited").replace(" here", " there"));
    const before = s.notion.calls.length;
    const pushed = await s.sync();
    assert.deepEqual(pushed.summary!.done, { push: 1 }, form);
    assert.match(s.notion.pages.get(page)!.markdown, /^Intro, edited\nSee .* there\nEnd$/);
    assert.equal(s.notion.calls.slice(before).filter((call) => call.startsWith("updateContent")).length, form === "self-closing" ? 1 : 2, "one edit, tried a second time when Notion finds the titled form");
  }
  // Notion answers `restricted_resource` when asked about this page: what it shows in the search can't be known.
  const s = await setup(t);
  const restricted = "f81667b8-032f-4c48-8b1e-c45e19085615";
  s.notion.outside.set(restricted, "Private");
  s.notion.restricted.add(restricted);
  const page = s.notion.add("Index", `Intro\nSee <mention-page url="https://app.notion.com/p/${restricted.replace(/-/g, "")}"/> here\nEnd`);
  await s.sync();
  await writeFile(join(s.vault, "0-In/Index.md"), (await s.read("0-In/Index.md")).replace("Intro", "Intro, edited").replace(" here", " there"));
  const before = s.notion.calls.length;
  const refused = await s.sync();
  assert.deepEqual(refused.summary!.skipped.map((x) => x.reason.split(":")[0]), ["unreadable_mention"]);
  assert.match(refused.summary!.skipped[0]!.reason, /Notion refused to say what it holds of a page that line mentions/);
  assert.deepEqual(s.notion.calls.slice(before).filter((call) => /^(updateContent|replaceContent)/.test(call)), []);
  assert.equal(s.notion.pages.get(page)!.markdown.split("\n")[0], "Intro");
});

// A note with bold written with `__`, and links on the bold lines.
const elm =
  "Notes from the stall.\n\n1. __Rye__ loaves come from [[Rye]], baked in the stone oven; they sell out by noon.\n2. Cheese ages a year at the [[Seed Catalog]] farms, __slowly__.\n\n- __Bakers__: Up before dawn.\n";

/** The note as the vault holds it after a run: its [[links]] converted to Markdown links. */
const elmInVault = elm.replace("[[Rye]]", "[Rye](Rye.md)").replace("[[Seed Catalog]]", "[Seed Catalog](Seed%20Catalog.md)");

async function elmVault(t: import("node:test").TestContext) {
  const s = await setup(t);
  await writeTree(s.vault, { "Market.md": elm, "Rye.md": "Rye note\n", "Seed Catalog.md": "Catalog note\n" });
  await s.sync();
  return { ...s, page: s.pageNamed("Market") };
}

test("a one-line edit on a bold line is placed both ways, and Notion keeps the bold as it writes it", async (t) => {
  // Notion holds `__bold__` as `**bold**`: the translator writes it so.
  const pull = await elmVault(t);
  assert.match(pull.page.markdown, /^- \*\*Bakers\*\*: Up before dawn\.$/m);
  pull.notion.edit(pull.page.id, { markdown: pull.page.markdown.replace("Up before dawn.", "Up before dawn, daily.") });
  const pulled = await pull.sync();
  assert.deepEqual(pulled.summary!.done, { pull: 1 });
  assert.deepEqual(pulled.summary!.rewritten, []);
  // The edited line keeps the note's own form of its bold.
  assert.equal(await pull.body("Market.md"), elmInVault.replace("Up before dawn.", "Up before dawn, daily."));
  assert.deepEqual((await pull.sync()).plan.actions, []);
  const push = await elmVault(t);
  const before = push.notion.pages.get(push.page.id)!.markdown;
  await writeFile(join(push.vault, "Market.md"), (await push.read("Market.md")).replace("Up before dawn.", "Up before dawn, daily."));
  const pushed = await push.sync();
  assert.deepEqual(pushed.summary!.done, { push: 1 });
  assert.deepEqual(pushed.summary!.rewritten, []);
  assert.equal(push.notion.pages.get(push.page.id)!.markdown, before.replace("Up before dawn.", "Up before dawn, daily."));
  assert.deepEqual((await push.sync()).plan.actions, []);
});

test("the same bold line with a link edited in both apps keeps Obsidian's text on both sides and Notion's in a conflict copy", async (t) => {
  const s = await elmVault(t);
  const page = s.notion.pages.get(s.page.id)!;
  s.notion.edit(s.page.id, { markdown: page.markdown.replace("they sell out by noon", "they sell out by ten (Notion)") });
  await writeFile(join(s.vault, "Market.md"), (await s.read("Market.md")).replace("they sell out by noon", "they sell out by nine (Obsidian)"));
  const merged = await s.sync();
  assert.deepEqual(merged.summary!.done, { merge: 1 });
  assert.deepEqual(merged.summary!.skipped, []);
  assert.equal(merged.summary!.conflicts.length, 1);
  const obsidian = elmInVault.replace("they sell out by noon", "they sell out by nine (Obsidian)");
  assert.equal(await s.body("Market.md"), obsidian);
  assert.match(s.notion.pages.get(s.page.id)!.markdown, /^1\. \*\*Rye\*\* loaves come from \[Rye\]\(https:\/\/app\.notion\.com\/p\/[^)]+\), baked in the stone oven; they sell out by nine \(Obsidian\)\.$/m);
  assert.match(await s.read(merged.summary!.conflicts[0]!), /they sell out by ten \(Notion\)/);
  assert.deepEqual((await s.sync()).plan.actions, []);
});

test("a code line pulled into a quoted block whose `>` has no space after it keeps its own indentation", async (t) => {
  const note = ">```python\n>if ok:\n>  print(\"yes\")\n>```\n";
  // The space right after `>` is the quote marker's: the code line is ` print("yes")`.
  assert.equal(await pullInto(t, note, (md) => md.replace(' print("yes")', ' print("no")')), note.replace('"yes"', '"no"'));
});

test("an edit made in Notion to code a list item's fence opens comes back at its own depth, both ways", async (t) => {
  // A common style: a loop body edited in Notion stays in the loop.
  const flush = "> [!example]\n> - ```python\n> for x in xs:\n>   print(x)\n>   total += x\n> ```\n\nEnd\n";
  assert.equal(await pullInto(t, flush, (md) => md.replace("print(x)", "print(x, end='')")), flush.replace("print(x)", "print(x, end='')"));
  // CommonMark's style: an edited line and an added one keep the item's indentation.
  const steps = "Steps\n\n- step one\n- ```bash\n  echo hi\n  echo there\n  ```\n- step three\n";
  assert.equal(await pullInto(t, steps, (md) => md.replace("echo hi", "echo hello\necho added")), steps.replace("  echo hi\n", "  echo hello\n  echo added\n"));
  // Obsidian's edit to a loop body reaches Notion at its depth.
  const s = await setup(t);
  await writeTree(s.vault, { "Loop.md": flush });
  await s.sync();
  const before = s.pageNamed("Loop").markdown;
  assert.match(before, /\n {2}print\(x\)\n/);
  await writeFile(join(s.vault, "Loop.md"), (await s.read("Loop.md")).replace("total += x", "total += 2 * x"));
  assert.deepEqual((await s.sync()).summary!.done, { push: 1 });
  assert.equal(s.pageNamed("Loop").markdown, before.replace("total += x", "total += 2 * x"));
});

test("a pulled line keeps the note's `_` emphasis only outside code spans and link targets", async (t) => {
  // A code span and a link target that hold `*b*`, on a line whose text also writes `_b_`.
  assert.equal(await pullInto(t, "Use _b_ and more\n\nOther\n", (md) => md.replace("and more", "and `a*b*c` more")), "Use _b_ and `a*b*c` more\n\nOther\n");
  assert.equal(
    await pullInto(t, "Use _b_ and more\n\nOther\n", (md) => md.replace("and more", "and [this](https://example.com/*b*/x) more")),
    "Use _b_ and [this](https://example.com/*b*/x) more\n\nOther\n",
  );
});

test("a line that mentions two pages in the trash is searched in every mix of their forms", async (t) => {
  const s = await setup(t);
  const one = s.notion.add("Old one", "");
  const two = s.notion.add("Old two", "");
  await s.notion.trash(one);
  await s.notion.trash(two);
  // Notion finds one by its titled form and the other self-closing.
  s.notion.trashedForms.set(one, "titled");
  s.notion.trashedForms.set(two, "self-closing");
  const url = (id: string) => `https://app.notion.com/p/${id.replace(/-/g, "")}`;
  const page = s.notion.add("Index", `Intro\nSee <mention-page url="${url(one)}"/> and <mention-page url="${url(two)}"/> here\nEnd`);
  await s.sync();
  await writeFile(join(s.vault, "0-In/Index.md"), (await s.read("0-In/Index.md")).replace(" here", " there"));
  const before = s.notion.calls.length;
  const pushed = await s.sync();
  assert.deepEqual(pushed.summary!.done, { push: 1 });
  assert.match(s.notion.pages.get(page)!.markdown, / there\nEnd$/);
  // Found by its second form: the first mention titled, the second as returned.
  assert.equal(s.notion.calls.slice(before).filter((call) => call.startsWith("updateContent")).length, 2);
});

test("a line whose mentions of pages in the trash Notion finds by none of the forms tried is skipped with a clear reason", async (t) => {
  const s = await setup(t);
  const gone = s.notion.add("Old one", "");
  await s.notion.trash(gone);
  s.notion.trashedForms.set(gone, "neither");
  s.notion.add("Index", `Intro\nSee <mention-page url="https://app.notion.com/p/${gone.replace(/-/g, "")}"/> here\nEnd`);
  await s.sync();
  await writeFile(join(s.vault, "0-In/Index.md"), (await s.read("0-In/Index.md")).replace(" here", " there"));
  const refused = await s.sync();
  assert.deepEqual(refused.summary!.skipped.map((x) => x.reason.split(":")[0]), ["validation_error"]);
  assert.match(refused.summary!.skipped[0]!.reason, /Notion found the line by none of the 2 forms tried for its mentions of pages in the trash/);
});

test("lines with words Notion makes links of (bare URLs, file names it takes for domains) take edits both ways (live probe)", async (t) => {
  const note = "See https://example.com/path and script.py here\n\nOther line\n";
  // Pull: the edited line keeps the note's bare forms.
  assert.equal(await pullInto(t, note, (md) => md.replace(" here", " there")), note.replace(" here", " there"));
  // Push: placed on its line, and Notion links the words again.
  const s = await setup(t);
  await writeTree(s.vault, { "Links.md": note });
  await s.sync();
  const page = s.pageNamed("Links");
  assert.equal(page.markdown, "See [https://example.com/path](https://example.com/path) and [script.py](http://script.py) here\nOther line");
  await writeFile(join(s.vault, "Links.md"), (await s.read("Links.md")).replace(" here", " there"));
  const pushed = await s.sync();
  assert.deepEqual(pushed.summary!.done, { push: 1 });
  assert.deepEqual(pushed.summary!.rewritten, []);
  assert.equal(s.notion.pages.get(page.id)!.markdown, page.markdown.replace(" here", " there"));
  assert.deepEqual((await s.sync()).plan.actions, []);
});

test("a page holding a line Notion would read back as something else isn't written, and the reason names the line (live probe)", async (t) => {
  const s = await setup(t);
  await writeTree(s.vault, { "Escapes.md": "A heading line\n\nAn escaped word\n\nOther line\n" });
  await s.sync();
  const page = s.pageNamed("Escapes");
  await writeFile(join(s.vault, "Escapes.md"), (await s.read("Escapes.md")).replace("A heading line", "\\# Not a heading").replace("An escaped word", "An \\_escaped\\_ word"));
  const before = s.notion.calls.length;
  const refused = await s.sync();
  assert.deepEqual(refused.summary!.skipped.map((x) => x.reason.split(":")[0]), ["notion_rereads"]);
  assert.match(refused.summary!.skipped[0]!.reason, /\\# Not a heading.*a heading, a list item or a divider/);
  assert.deepEqual(s.notion.calls.slice(before).filter((call) => /^(updateContent|replaceContent)/.test(call)), []);
  assert.equal(s.notion.pages.get(page.id)!.markdown, page.markdown);
  // Written another way, the note syncs again.
  await writeFile(join(s.vault, "Escapes.md"), (await s.read("Escapes.md")).replace("\\# Not a heading", "Not a heading: #").replace("\\_escaped\\_", "`_escaped_`"));
  assert.deepEqual((await s.sync()).summary!.done, { push: 1 });
  assert.equal(s.notion.pages.get(page.id)!.markdown, "Not a heading: #\nAn `_escaped_` word\nOther line");
});

/** A note's sync record, rewritten as an earlier version of the tool could have saved it. */
async function rewriteRecord(state: string, id: string, change: (record: { obsidianText: string; notionMarkdown: string }) => void) {
  const file = join(state, "records", `${id}.json`);
  const record = JSON.parse(await readFile(file, "utf8"));
  change(record);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
}

test("a relink is refused like a push when the note holds a line Notion would read back as something else", async (t) => {
  const s = await setup(t);
  await writeTree(s.vault, { "A.md": "Placeholder\n\nSee [[B]] here\n" });
  await s.sync();
  const a = s.pageNamed("A");
  // The page and the note as a version before the re-read guard left them: Notion holds the paragraph's text
  // literally and returns it as `# Not a heading`, the same text as a heading.
  const note = (await s.read("A.md")).replace("Placeholder", "\\# Not a heading");
  await writeFile(join(s.vault, "A.md"), note);
  s.notion.edit(a.id, { markdown: a.markdown.replace("Placeholder", "# Not a heading") });
  await rewriteRecord(s.state, a.id, (record) => {
    record.obsidianText = note;
    record.notionMarkdown = s.notion.pages.get(a.id)!.markdown;
  });
  assert.deepEqual((await s.sync()).plan.actions, [], "both apps as recorded");
  await writeTree(s.vault, { "B.md": "The B note\n" });
  const before = s.notion.calls.length;
  const outcome = await s.sync();
  assert.deepEqual(outcome.summary!.done, { createPage: 1 });
  assert.deepEqual(outcome.summary!.skipped.map((x) => `${x.path} ${x.reason.split(":")[0]}`), ["A.md notion_rereads"]);
  assert.match(outcome.summary!.skipped[0]!.reason, /\\# Not a heading.*a heading, a list item or a divider/);
  assert.deepEqual(s.notion.calls.slice(before).filter((call) => /^updateContent/.test(call)), []);
  assert.equal(s.notion.pages.get(a.id)!.markdown, "# Not a heading\nSee \\[\\[B\\]\\] here");
});

test("a new note holding a line Notion would change gets an empty page with its title and Folder, and its text once the line is written another way", async (t) => {
  const s = await setup(t);
  const lines: Record<string, string> = {
    "Hash.md": "\\# Not a heading\n\nSecond line\n",
    "Ticks.md": "x ``a ` b`` y\n\nnext line\n\nlast `code` line\n",
    "Init.md": "see https://github.com/x/blob/main/__init__.py now\n",
    "Link.md": "A link to [[Hash]]\n",
  };
  await writeTree(s.vault, lines);
  const outcome = await s.sync();
  assert.deepEqual(outcome.summary!.done, { convertLinks: 1, createPage: 4 });
  assert.deepEqual(outcome.summary!.skipped.map((x) => `${x.path} ${x.reason.split(":")[0]}`).sort(), ["Hash.md notion_rereads", "Init.md notion_rereads", "Ticks.md notion_rereads"]);
  for (const title of ["Hash", "Ticks", "Init"]) assert.equal(s.pageNamed(title).markdown, "", title);
  assert.match(outcome.summary!.skipped.find((x) => x.path === "Hash.md")!.reason, /\\# Not a heading.*its page stays empty, with its title and project/);
  // The page exists, so links to it are page links in Notion.
  const hash = s.pageNamed("Hash");
  assert.equal(s.pageNamed("Link").markdown, `A link to [Hash](https://app.notion.com/p/${hash.id.replace(/-/g, "")})`);
  assert.match(await s.read("Hash.md"), new RegExp(`notion-id: ${hash.id}`));
  // Every run says so until the line is written another way; then the note pairs with its page.
  const again = await s.sync();
  assert.deepEqual(again.summary!.skipped.map((x) => `${x.path} ${x.reason.split(":")[0]}`).sort(), ["Hash.md notion_rereads", "Init.md notion_rereads", "Ticks.md notion_rereads"]);
  assert.equal(hash.markdown, "");
  assert.match(again.summary!.skipped.find((x) => x.path === "Hash.md")!.reason, /its page stays empty/);
  await writeFile(join(s.vault, "Hash.md"), (await s.read("Hash.md")).replace("\\# Not a heading", "Not a heading: #"));
  // Its record waits with both texts empty, so the fixed note is pushed into its page.
  const filled = await s.sync();
  assert.deepEqual(filled.summary!.done, { push: 1 });
  assert.deepEqual(filled.summary!.rewritten, []);
  assert.equal(s.notion.pages.get(hash.id)!.markdown, "Not a heading: #\nSecond line");
  assert.deepEqual((await readdir(s.vault)).filter((name) => name.includes("conflict")), []);
});

test("first-run pairing doesn't replace a page with a note holding a line Notion would change", async (t) => {
  const s = await setup(t);
  const id = s.notion.add("Paired", "Notion text");
  await writeTree(s.vault, { "Paired.md": "see https://github.com/x/blob/main/__init__.py now\n" });
  const before = s.notion.calls.length;
  const outcome = await s.sync();
  assert.deepEqual(outcome.summary!.skipped.map((x) => `${x.path} ${x.reason.split(":")[0]}`), ["Paired.md notion_rereads"]);
  assert.deepEqual(s.notion.calls.slice(before).filter((call) => /^(updateContent|replaceContent|setProperties)/.test(call)), []);
  assert.equal(s.notion.pages.get(id)!.markdown, "Notion text");
  assert.deepEqual((await readdir(s.vault)).filter((name) => name.includes("conflict")), []);
});

// --- the empty page of a refused new note ------------------------------------------------

const refusedNote = "Intro\n\n\\# literal hash\n\nEnd\n";
const reasons = (outcome: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["sync"]>>) => outcome.summary!.skipped.map((x) => `${x.path} ${x.reason.split(":")[0]}`);
const conflictCopies = async (vault: string) => (await readdir(join(vault, "F"))).filter((name) => name.includes("conflict"));

/** A new note refused with `notion_rereads` (its page made empty), and a note linking to it. */
async function refusedNew(t: import("node:test").TestContext) {
  const s = await setup(t);
  await writeTree(s.vault, { "F/A.md": refusedNote, "L.md": "see [[A]]\n" });
  const first = await s.sync();
  assert.deepEqual(first.summary!.done, { convertLinks: 1, createPage: 2 });
  assert.deepEqual(reasons(first), ["F/A.md notion_rereads"]);
  const page = s.pageNamed("A");
  assert.equal(page.markdown, "");
  return { ...s, page };
}

test("a refused new note deleted in Obsidian takes its empty page to the trash, and nothing comes back", async (t) => {
  const s = await refusedNew(t);
  await rm(join(s.vault, "F/A.md"));
  const deleted = await s.sync();
  assert.deepEqual(deleted.summary!.done, { trashPage: 1 });
  assert.deepEqual(reasons(deleted), []);
  assert.equal(s.notion.pages.get(s.page.id)!.inTrash, true);
  assert.deepEqual(await readdir(join(s.vault, "F")), []);
  const next = await s.sync();
  assert.deepEqual(next.plan.actions, []);
  assert.deepEqual(await readdir(join(s.vault, "F")), []);
});

test("a refused new note fixed later fills its empty page, with nothing rewritten whole and no conflict copy (W1)", async (t) => {
  const s = await refusedNew(t);
  const again = await s.sync();
  assert.deepEqual(reasons(again), ["F/A.md notion_rereads"]);
  assert.match(again.summary!.skipped[0]!.reason, /its page stays empty/);
  assert.equal(s.page.markdown, "");
  await writeFile(join(s.vault, "F/A.md"), (await s.read("F/A.md")).replace("\\# literal", "# literal"));
  const fixed = await s.sync();
  assert.deepEqual(reasons(fixed), []);
  assert.deepEqual(fixed.summary!.rewritten, []);
  assert.deepEqual(fixed.summary!.conflicts, []);
  assert.equal(s.notion.pages.get(s.page.id)!.markdown, "Intro\n# literal hash\nEnd");
  assert.deepEqual(await conflictCopies(s.vault), []);
  assert.deepEqual((await s.sync()).plan.actions, []);
});

test("text typed into a refused note's empty page in Notion is kept, and saved as a conflict copy once the note is fixed (W1)", async (t) => {
  const s = await refusedNew(t);
  s.notion.edit(s.page.id, { markdown: "typed in Notion" });
  const refused = await s.sync();
  assert.deepEqual(reasons(refused), ["F/A.md notion_rereads"]);
  assert.equal(await s.body("F/A.md"), refusedNote);
  assert.equal(s.notion.pages.get(s.page.id)!.markdown, "typed in Notion");
  assert.deepEqual(await conflictCopies(s.vault), [], "nothing written while the note is refused");
  await writeFile(join(s.vault, "F/A.md"), (await s.read("F/A.md")).replace("\\# literal", "# literal"));
  const fixed = await s.sync();
  assert.deepEqual(reasons(fixed), []);
  assert.equal(s.notion.pages.get(s.page.id)!.markdown, "Intro\n# literal hash\nEnd");
  const copies = await conflictCopies(s.vault);
  assert.equal(copies.length, 1);
  assert.match(await s.read(`F/${copies[0]}`), /typed in Notion/);
  assert.deepEqual((await s.sync()).plan.actions, []);
});

test("a refused new note whose empty page is trashed in Notion keeps the note and gets one new empty page (W1)", async (t) => {
  const s = await refusedNew(t);
  await s.notion.trash(s.page.id);
  const trashed = await s.sync();
  assert.deepEqual(reasons(trashed), ["F/A.md notion_rereads"]);
  assert.equal(await s.body("F/A.md"), refusedNote);
  const fresh = s.pageNamed("A");
  assert.notEqual(fresh.id, s.page.id);
  assert.equal(fresh.markdown, "");
  const next = await s.sync();
  assert.deepEqual(reasons(next), ["F/A.md notion_rereads"]);
  assert.equal([...s.notion.pages.values()].filter((p) => p.title === "A" && !p.inTrash).length, 1, "no page made twice");
});

test("a refused new note renamed in Obsidian renames its empty page, and one renamed in Notion renames the note (W1)", async (t) => {
  const s = await refusedNew(t);
  await rename(join(s.vault, "F/A.md"), join(s.vault, "F/A2.md"));
  await s.sync();
  assert.equal(s.notion.pages.get(s.page.id)!.title, "A2");
  s.notion.edit(s.page.id, { title: "A in Notion" });
  await s.sync();
  assert.deepEqual(await readdir(join(s.vault, "F")), ["A in Notion.md"]);
  assert.equal(await s.body("F/A in Notion.md"), refusedNote);
});

test("a refused new note left by an earlier version (no record) is recorded as waiting at its next run, so its delete sticks too (W1)", async (t) => {
  const s = await refusedNew(t);
  await rm(join(s.state, "records", `${s.page.id}.json`), { force: true });
  const legacy = await s.sync();
  assert.deepEqual(reasons(legacy), ["F/A.md notion_rereads"]);
  await rm(join(s.vault, "F/A.md"));
  const deleted = await s.sync();
  assert.deepEqual(deleted.summary!.done, { trashPage: 1 });
  assert.deepEqual(await readdir(join(s.vault, "F")), []);
  assert.deepEqual((await s.sync()).plan.actions, []);
});
