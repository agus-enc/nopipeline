// Runs the real client against the scratch database. Skipped unless NOPIPELINE_LIVE=1.
// Needs NOTION_TOKEN and NOPIPELINE_SCRATCH_DATA_SOURCE (the scratch copy's data source id, never a real notes database).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildLinkIndex } from "../../src/links/index.ts";
import { contentUpdates } from "../../src/merge/edits.ts";
import { lineKey } from "../../src/merge/lines.ts";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, LogLevel, isFullPage } from "@notionhq/client";
import type { Config } from "../../src/config.ts";
import { canonicalMarkdown, hostedFile, mediaLine, placeholderUrl, stripSignatures, type MediaKind } from "../../src/notion/hosted.ts";
import { createSdkGateway, NOTION_VERSION, NotionPageError, type NotionGateway } from "../../src/notion/gateway.ts";
import { runSync } from "../../src/sync.ts";
import { tempDir, writeTree } from "../helpers/tmp.ts";
import { idFromUrl, pageUrl } from "../../src/notion/ids.ts";
import { searchTexts } from "../../src/notion/search.ts";
import { pushResult } from "../../src/run/content.ts";
import { toNotion, toObsidian } from "../../src/translate/index.ts";
import { mediaOf } from "../../src/vault/images.ts";
import type { SyncRecord } from "../../src/types.ts";

const live = process.env.NOPIPELINE_LIVE === "1";
const skip = live ? false : "set NOPIPELINE_LIVE=1, NOTION_TOKEN and NOPIPELINE_SCRATCH_DATA_SOURCE to run against the scratch database";

test("the real API: create, write, edit, rename, refuse and trash a page", { skip }, async () => {
  const notion = createSdkGateway({
    token: process.env.NOTION_TOKEN!,
    dataSourceId: process.env.NOPIPELINE_SCRATCH_DATA_SOURCE!,
    titleProperty: "Name",
  });
  const id = await notion.createPage({ title: `live test ${Date.now()}` });
  try {
    assert.match(await notion.replaceContent(id, "Alpha\nBravo"), /Alpha\nBravo/);
    const edited = await notion.updateContent(id, [{ old_str: "Bravo", new_str: "Bravo, edited" }]);
    assert.match(edited, /Bravo, edited/);
    assert.equal((await notion.getMarkdown(id)).markdown, edited);
    await notion.setTitle(id, "live test, renamed");
    const listed = (await notion.listPages()).find((p) => p.id === id);
    assert.equal(listed?.title, "live test, renamed");
    await assert.rejects(notion.updateContent(id, [{ old_str: "not on the page", new_str: "x" }]), NotionPageError);
  } finally {
    await notion.trash(id);
  }
  assert.equal((await notion.listPages()).some((p) => p.id === id), false);
});

// Notion sometimes adds the page title inside a mention tag; lineKey treats both forms as the same line.
test("the real API: the forms the translator writes come back as sent", { skip }, async () => {
  const notion = createSdkGateway({
    token: process.env.NOTION_TOKEN!,
    dataSourceId: process.env.NOPIPELINE_SCRATCH_DATA_SOURCE!,
    titleProperty: "Name",
  });
  const id = await notion.createPage({ title: `live forms ${Date.now()}` });
  try {
    const url = `https://app.notion.com/p/${id.replace(/-/g, "")}`;
    const sent = [
      `See <mention-page url="${url}"/> and [its alias](${url})`,
      "Math $`x^2`$ and a literal embed !\\[\\[diagram.png\\|300\\]\\]",
      "A link Notion can't hold: \\[list\\](obsidian://open?vault=A&file=B)",
      "- item with ==no highlight== and <span color=\"yellow_bg\">a highlight</span>",
    ].join("\n");
    const back = await notion.replaceContent(id, sent);
    assert.deepEqual(back.split("\n").map(lineKey), sent.split("\n").map(lineKey));
  } finally {
    await notion.trash(id);
  }
});

test("the real API: the database's properties, and a page's status when live, trashed and missing", { skip }, async () => {
  const notion = createSdkGateway({
    token: process.env.NOTION_TOKEN!,
    dataSourceId: process.env.NOPIPELINE_SCRATCH_DATA_SOURCE!,
    titleProperty: "Name",
  });
  const properties = await notion.properties();
  assert.equal(properties.Name, "title");
  const id = await notion.createPage({ title: `live status ${Date.now()}` });
  let trashed = false;
  try {
    assert.equal(await notion.pageStatus(id), "live");
    await notion.trash(id);
    trashed = true;
    assert.equal(await notion.pageStatus(id), "trashed");
  } finally {
    if (!trashed) await notion.trash(id);
  }
  assert.equal(await notion.pageStatus(randomUUID()), "gone", "an id no page has");
});

// A code block inside a quote is a code block nested in the Notion quote (fix plan E): written as the
// translator writes it, read back as Notion writes it, and edited line by line the way a push edits it.
test("the real API: code blocks nested in a quote and a list item come back as the same note, and take line edits", { skip }, async () => {
  const notion = createSdkGateway({
    token: process.env.NOTION_TOKEN!,
    dataSourceId: process.env.NOPIPELINE_SCRATCH_DATA_SOURCE!,
    titleProperty: "Name",
  });
  const ctx = { index: buildLinkIndex([]), fromPath: "Live.md", vaultName: "Live" };
  const note = ["> Example:", "> ```python", "> i = 0", "> while i < 3:", ">     i += 1", ">", "> print(i)", "> ```", "", "- step", "\t```go", "\tfunc f() {", "\t\treturn", "\t}", "\t```", ""].join("\n");
  const id = await notion.createPage({ title: `live quoted code ${Date.now()}` });
  try {
    const written = await notion.replaceContent(id, toNotion(note, ctx));
    assert.equal(toObsidian(written, ctx), note, "the page reads back as the note");
    const record: SyncRecord = { notionId: id, path: "Live.md", title: "Live", folder: null, obsidianText: note, notionMarkdown: written, notionSeenAt: "", syncedAt: "" };
    const edited = note.replace("i += 1", "i += 2").replace("\t\treturn", "\t\treturn nil");
    const result = pushResult(record, edited, written, ctx);
    assert.ok(result !== null, "the edits are placed on the page");
    let markdown = written;
    for (const edit of contentUpdates(written, result!) ?? []) markdown = await notion.updateContent(id, [edit]);
    assert.equal(toObsidian(markdown, ctx), edited, "the edited page reads back as the edited note, tabs and all");
  } finally {
    await notion.trash(id);
  }
});

// Notion finds a page mention in a search text only in the form that holds the page's current title:
// an edit to a line with mentions, sent as the tool sends it, is found, for a renamed, an untitled, a missing and
// a trashed page alike.
test("the real API: an edit to a line with page mentions is found by the search text the tool sends", { skip }, async () => {
  const notion = createSdkGateway({
    token: process.env.NOTION_TOKEN!,
    dataSourceId: process.env.NOPIPELINE_SCRATCH_DATA_SOURCE!,
    titleProperty: "Name",
  });
  const made: string[] = [];
  const page = async (title: string) => {
    const id = await notion.createPage({ title });
    made.push(id);
    return id;
  };
  try {
    const target = await page(`live mention target ${Date.now()}`);
    const untitled = await page("");
    const trashed = await page("live mention, trashed");
    const p = await page(`live mentions ${Date.now()}`);
    const m = (id: string) => `<mention-page url="${pageUrl(id)}"/>`;
    await notion.replaceContent(p, ["Before", `- see ${m(target)} and ${m(untitled)} here`, "Middle one", `${m(randomUUID())} gone`, "Middle two", `> quoted ${m(trashed)} line`, "After"].join("\n"));
    await notion.setTitle(target, "live mention target, renamed");
    await notion.trash(trashed);
    const current = (await notion.getMarkdown(p)).markdown;
    const result = current.replace(" here", " there").replace(" gone", " went").replace(" line", " line, edited");
    const edits = contentUpdates(current, result)!;
    assert.equal(edits.length, 3);
    const ids = [...new Set(edits.flatMap((e) => [...e.old_str.matchAll(/<mention-page url="([^"]*)"/g)].map((x) => idFromUrl(x[1]!)!)))];
    const targets = await notion.mentionTargets(ids);
    assert.deepEqual(targets.get(target), { title: "live mention target, renamed", trashed: false });
    assert.deepEqual(targets.get(trashed), { title: "live mention, trashed", trashed: true });
    let markdown = current;
    for (const edit of edits) {
      const texts = searchTexts(current, edit.old_str, (id) => targets.get(id))!;
      let sent = false;
      for (const old_str of texts) {
        try {
          markdown = await notion.updateContent(p, [{ old_str, new_str: edit.new_str }]);
          sent = true;
          break;
        } catch (error) {
          if (!(error instanceof NotionPageError)) throw error;
        }
      }
      assert.ok(sent, `Notion found ${JSON.stringify(edit.old_str)}`);
    }
    assert.equal(markdown, result);
  } finally {
    for (const id of made.reverse()) if ((await notion.pageStatus(id)) === "live") await notion.trash(id);
  }
});

// What a later round found Notion doing, checked again live: the whole page read
// again on any write, links of bare words, an empty code block, escaped stars, trashing a trashed page.
test("the real API: Notion reads a page again on any write, links bare words, and keeps what the translator writes for stars and empty code", { skip }, async () => {
  const notion = createSdkGateway({ token: process.env.NOTION_TOKEN!, dataSourceId: process.env.NOPIPELINE_SCRATCH_DATA_SOURCE!, titleProperty: "Name", linksToProperty: "Links to" });
  const ctx = { index: buildLinkIndex([]), fromPath: "Live.md", vaultName: "Live" };
  const id = await notion.createPage({ title: `live rereads ${Date.now()}` });
  try {
    const sent = toNotion(["An \\_escaped\\_ word", "", "See script.py and https://example.com/a", "", "2 * 3 * 4", "", "```python", "```", "", "Tail"].join("\n"), ctx);
    const kept = await notion.replaceContent(id, sent);
    assert.equal(kept, ["An _escaped_ word", "See [script.py](http://script.py) and [https://example.com/a](https://example.com/a)", "2 \\* 3 \\* 4", "```python", "", "```", "Tail"].join("\n"));
    // One edit to the last line: the literal underscores become italics.
    const after = await notion.updateContent(id, [{ old_str: "Tail", new_str: "Tail edited" }]);
    assert.equal(after.split("\n")[0], "An *escaped* word");
    assert.equal(after.split("\n").slice(1).join("\n"), kept.split("\n").slice(1).join("\n").replace("Tail", "Tail edited"));
  } finally {
    await notion.trash(id);
  }
  // Trashing it again counts as done.
  await notion.trash(id);
  assert.equal(await notion.pageStatus(id), "trashed");
});

/**
 * The executor against the real API, on pages a test makes and nothing else: the listing is limited to the pages
 * this sync created. Its own vault and state, cleaned up with the test; `mine` holds the pages to trash.
 */
async function ownSync(t: import("node:test").TestContext) {
  const real = createSdkGateway({ token: process.env.NOTION_TOKEN!, dataSourceId: process.env.NOPIPELINE_SCRATCH_DATA_SOURCE!, titleProperty: "Name", linksToProperty: "Links to" });
  const client = new Client({ auth: process.env.NOTION_TOKEN!, notionVersion: NOTION_VERSION, logLevel: LogLevel.ERROR });
  const mine = new Set<string>();
  const notion: NotionGateway = {
    ...real,
    async createPage(input) {
      const id = await real.createPage(input);
      mine.add(id);
      return id;
    },
    async listPages() {
      const pages = [];
      for (const id of mine) {
        const page = await client.pages.retrieve({ page_id: id });
        if (!isFullPage(page) || page.in_trash) continue;
        const title = page.properties.Name;
        pages.push({ id, title: title?.type === "title" ? title.title.map((x) => x.plain_text).join("") : "", folder: null, lastEditedTime: page.last_edited_time });
      }
      return pages;
    },
  };
  const vault = await tempDir(t);
  const state = await tempDir(t);
  const config: Config = { profile: "live", vaultPath: vault, vaultName: "Live", dataSourceId: process.env.NOPIPELINE_SCRATCH_DATA_SOURCE!, titleProperty: "Name", linksToProperty: "Links to", projectsRelation: null, pageIcon: null, ignoredKeys: [], inboxFolder: "0-In", massTrashLimit: 10, tokenFile: null, stateDir: state };
  const sync = () => runSync({ config, notion, dryRun: false, yes: true, allowMassTrash: false, log: () => {} });
  /** The block types and plain text of a page's top-level blocks, as Notion holds them. */
  const blocks = async (id: string) => {
    const list = await client.blocks.children.list({ block_id: id });
    return list.results.map((b) => {
      const block = b as unknown as Record<string, { rich_text?: { plain_text: string }[] }> & { type: string };
      return `${block.type} ${(block[block.type]?.rich_text ?? []).map((r) => r.plain_text).join("")}`;
    });
  };
  return { real, notion, mine, vault, state, sync, blocks };
}

// The executor against the real API, on pages this test makes and nothing else (the listing is limited to them): a
// push to a line with a link, the same bold line edited in both apps, and a write refused
// for a line Notion would read back as a heading. The `[[link]]` is converted to a Markdown link first, and is a page
// link on the page (Markdown links design).
test("the real API: a sync pushes and merges lines with links and bold, and refuses a write Notion would change", { skip }, async (t) => {
  const { real, notion, mine, vault, sync } = await ownSync(t);
  const stamp = Date.now();
  const target = `Live Target ${stamp}`;
  const note = `Live Note ${stamp}.md`;
  const read = () => readFile(join(vault, note), "utf8");
  try {
    await writeTree(vault, { [`${target}.md`]: "Target note\n", [note]: `- __Step__: [[${target}]] is linked here\n- second line\n` });
    const first = await sync();
    assert.deepEqual(first.summary!.done, { convertLinks: 1, createPage: 2 });
    const pages = await notion.listPages();
    const pageId = pages.find((p) => p.title === `Live Note ${stamp}`)!.id;
    const targetId = pages.find((p) => p.title === target)!.id;
    const page = () => real.getMarkdown(pageId).then((p) => p.markdown);
    assert.equal(await page(), `- **Step**: [${target}](${pageUrl(targetId)}) is linked here\n- second line`);
    // A push to the line with the link.
    await writeFile(join(vault, note), (await read()).replace("is linked here", "is linked there"));
    const pushed = await sync();
    assert.deepEqual(pushed.summary!.skipped, []);
    assert.deepEqual(pushed.summary!.done, { push: 1 });
    assert.match(await page(), /is linked there\n- second line$/);
    // Scenario 3: the same bold line edited in both apps.
    const current = await page();
    const line = current.split("\n")[0]!;
    // A line holding a page link and no mention is found as it is returned (Markdown links design §7, check 3).
    assert.deepEqual(searchTexts(current, line, () => undefined), [line]);
    await real.updateContent(pageId, [{ old_str: line, new_str: line.replace("there", "there (Notion)") }]);
    await writeFile(join(vault, note), (await read()).replace("is linked there", "is linked there (Obsidian)"));
    const merged = await sync();
    assert.deepEqual(merged.summary!.skipped, []);
    assert.deepEqual(merged.summary!.done, { merge: 1 });
    assert.equal(merged.summary!.conflicts.length, 1);
    assert.match(await page(), /is linked there \(Obsidian\)\n- second line$/);
    assert.match(await read(), new RegExp(`- __Step__: \\[${target}\\]\\(${encodeURIComponent(target)}\\.md\\) is linked there \\(Obsidian\\)\\n- second line\\n$`));
    // A line Notion would read back as a heading: nothing is written.
    const before = await page();
    await writeFile(join(vault, note), `${await read()}\n\\# Not a heading\n`);
    const refused = await sync();
    assert.deepEqual(refused.summary!.skipped.map((x) => x.reason.split(":")[0]), ["notion_rereads"]);
    assert.equal(await page(), before);
  } finally {
    for (const id of mine) await real.trash(id);
  }
});

// The writes the second re-review found unchecked (V1, V2), against the real API: a relink of a page holding a literal
// `# x` paragraph (as a version before the guard could leave it) is refused and the paragraph stays one; a new note
// holding a URL Notion would cut gets an empty page that waits with a record, and its text is pushed once the URL is
// written another way.
test("the real API: a relink and a page creation are refused where Notion would change a line", { skip }, async (t) => {
  const { real, notion, mine, vault, state, sync, blocks } = await ownSync(t);
  const stamp = Date.now();
  const linker = `Live Linker ${stamp}.md`;
  const created = `Live Create ${stamp}.md`;
  const later = `Live Later ${stamp}`;
  try {
    await writeTree(vault, { [linker]: `Placeholder\n\nSee [[${later}]] here\n`, [created]: "see https://github.com/x/blob/main/__init__.py now\n" });
    const first = await sync();
    assert.deepEqual(first.summary!.done, { convertLinks: 1, createPage: 2 });
    assert.deepEqual(first.summary!.skipped.map((x) => `${x.path} ${x.reason.split(":")[0]}`), [`${created} notion_rereads`]);
    const pages = await notion.listPages();
    const createdId = pages.find((p) => p.title === `Live Create ${stamp}`)!.id;
    const linkerId = pages.find((p) => p.title === `Live Linker ${stamp}`)!.id;
    assert.equal((await real.getMarkdown(createdId)).markdown, "");
    // The linker's page and note as a version before the guard could leave them: a literal `# x` paragraph.
    const held = await real.updateContent(linkerId, [{ old_str: "Placeholder", new_str: "\\# Not a heading" }]);
    assert.equal(held, `# Not a heading\nSee \\[\\[${later}\\]\\] here`);
    assert.equal((await blocks(linkerId))[0], "paragraph # Not a heading");
    const note = (await readFile(join(vault, linker), "utf8")).replace("Placeholder", "\\# Not a heading");
    await writeFile(join(vault, linker), note);
    const file = join(state, "records", `${linkerId}.json`);
    const record = JSON.parse(await readFile(file, "utf8")) as SyncRecord;
    await writeFile(file, `${JSON.stringify({ ...record, obsidianText: note, notionMarkdown: held }, null, 2)}\n`);
    // The linked note appears: the relink is refused, and the paragraph is still a paragraph.
    await writeTree(vault, { [`${later}.md`]: "Later\n" });
    const relinked = await sync();
    assert.deepEqual(relinked.summary!.done, { createPage: 1 });
    assert.deepEqual(relinked.summary!.skipped.map((x) => `${x.path} ${x.reason.split(":")[0]}`).sort(), [`${created} notion_rereads`, `${linker} notion_rereads`].sort());
    assert.equal((await real.getMarkdown(linkerId)).markdown, held);
    assert.equal((await blocks(linkerId))[0], "paragraph # Not a heading");
    // The URL written as a link: the note's text is pushed onto its waiting empty page.
    await writeFile(join(vault, created), (await readFile(join(vault, created), "utf8")).replace("https://github.com/x/blob/main/__init__.py", "[init](https://github.com/x/blob/main/__init__.py)"));
    const pushed = await sync();
    assert.equal(pushed.summary!.done.push, 1);
    assert.equal((await real.getMarkdown(createdId)).markdown, "see [init](https://github.com/x/blob/main/__init__.py) now");
  } finally {
    for (const id of mine) await real.trash(id);
  }
});

// Markdown links design §7, and the live checks carried from the plan's reviews: page links as the translator writes
// them, on the first write and on the writes after it (Notion reads the whole page again on any write). A text holding
// `[`, `]`, `|` and `*` through the translator's escaping; texts partly bold, italic, struck through or code, which the
// fake splits into one link per run (`linkRuns` in test/helpers/notion-model.ts); and a vault's `` `__slots__` attribute ``.
// First run (recorded live): the escaped text comes back as sent on every
// write, and Notion splits a partly styled text into one link per run on the first write already, then keeps it.
test("the real API: page links as the translator writes them, on the first write and the writes after it", { skip }, async (t) => {
  const notion = createSdkGateway({ token: process.env.NOTION_TOKEN!, dataSourceId: process.env.NOPIPELINE_SCRATCH_DATA_SOURCE!, titleProperty: "Name", linksToProperty: "Links to" });
  const stamp = Date.now();
  const title = `Live link target ${stamp}`;
  const odd = `Odd [x] | a*b* c ${stamp}`;
  const mine: string[] = [];
  const page = async (name: string) => {
    const id = await notion.createPage({ title: name });
    mine.push(id);
    return id;
  };
  try {
    const target = await page(title);
    const oddId = await page(odd);
    const linker = await page(`Live page links ${stamp}`);
    const ctx = { index: buildLinkIndex([{ path: "Target.md", pageId: target, title }, { path: "Odd.md", pageId: oddId, title: odd }]), fromPath: "Linker.md", vaultName: "Live" };
    const u = pageUrl(target);
    const note = ["Plain [[Target]] here", "Odd [[Odd]] here", "Bold [a **b** c](Target.md) here", "Italic [a *b* c](Target.md) here", "Strike [a ~~b~~ c](Target.md) here", "Code [a `b` c](Target.md) here", "DemoVault [`__slots__` attribute](Target.md) here", "Other line"];
    const sent = toNotion(`${note.join("\n\n")}\n`, ctx);
    assert.equal(sent, [`Plain [${title}](${u}) here`, `Odd [Odd \\[x\\] \\| a\\*b\\* c ${stamp}](${pageUrl(oddId)}) here`, `Bold [a **b** c](${u}) here`, `Italic [a *b* c](${u}) here`, `Strike [a ~~b~~ c](${u}) here`, `Code [a \`b\` c](${u}) here`, `DemoVault [\`__slots__\` attribute](${u}) here`, "Other line"].join("\n"));
    const first = await notion.replaceContent(linker, sent);
    const second = await notion.updateContent(linker, [{ old_str: "Other line", new_str: "Other line, edited" }]);
    const third = await notion.updateContent(linker, [{ old_str: "Other line, edited", new_str: "Other line, edited twice" }]);
    const show = (x: string) => x.replaceAll(u, "U").replaceAll(pageUrl(oddId), "O");
    t.diagnostic(`sent: ${JSON.stringify(show(sent))}`);
    t.diagnostic(`first write: ${JSON.stringify(show(first))}`);
    t.diagnostic(`second write: ${JSON.stringify(show(second))}`);
    t.diagnostic(`third write: ${JSON.stringify(show(third))}`);
    const split = [
      `Plain [${title}](U) here`,
      `Odd [Odd \\[x\\] \\| a\\*b\\* c ${stamp}](O) here`,
      "Bold [a ](U)[**b**](U)[ c](U) here",
      "Italic [a ](U)[*b*](U)[ c](U) here",
      "Strike [a ](U)[~~b~~](U)[ c](U) here",
      "Code [a ](U)[`b`](U)[ c](U) here",
      "DemoVault [`__slots__`](U)[ attribute](U) here",
    ];
    assert.deepEqual(show(first).split("\n"), [...split, "Other line"], "the first write");
    assert.deepEqual(show(second).split("\n"), [...split, "Other line, edited"], "the second write");
    assert.deepEqual(show(third).split("\n"), [...split, "Other line, edited twice"], "the third write");
    // Each page link reads back as the note's Markdown link, the runs of a split one as one link.
    const back = toObsidian(third, ctx).split("\n\n");
    assert.deepEqual(back.slice(2, 7), note.slice(2, 7));
    assert.deepEqual(back.slice(0, 2), [`Plain [${title}](Target.md) here`, `Odd [Odd \\[x\\] | a\\*b\\* c ${stamp}](Odd.md) here`]);
  } finally {
    for (const id of mine) await notion.trash(id);
  }
});

// A real sync over its own vault (live run): `[[links]]` are converted and reach Notion as page links, a link to no
// note stays text; a rename in Notion rewrites the link text that read the old title, in the note and on the page, in
// the same run; and once the missing note appears, a relink makes it a page link.
test("the real API: a sync converts [[links]] to page links, rewrites their text after a rename, and relinks a note that appears", { skip }, async (t) => {
  const { real, notion, mine, vault, sync } = await ownSync(t);
  const stamp = Date.now();
  const a = `Live A ${stamp}`;
  const b = `Live B ${stamp}`;
  const missing = `Live Missing ${stamp}`;
  const dest = (name: string) => `${encodeURIComponent(name)}.md`;
  const body = async (name: string) => (await readFile(join(vault, `${name}.md`), "utf8")).replace(/^---\n[\s\S]*?\n---\n/, "");
  try {
    await writeTree(vault, { [`${a}.md`]: `See [[${b}]] and [[${b}|bee]], not [[${missing}]]\n`, [`${b}.md`]: "Bee\n" });
    const first = await sync();
    assert.deepEqual(first.summary!.skipped, []);
    assert.deepEqual(first.summary!.done, { convertLinks: 1, createPage: 2 });
    assert.equal(await body(a), `See [${b}](${dest(b)}) and [bee](${dest(b)}), not [${missing}](${dest(missing)})\n`);
    const pages = await notion.listPages();
    const aId = pages.find((p) => p.title === a)!.id;
    const bId = pages.find((p) => p.title === b)!.id;
    const page = () => real.getMarkdown(aId).then((p) => p.markdown);
    assert.equal(await page(), `See [${b}](${pageUrl(bId)}) and [bee](${pageUrl(bId)}), not \\[\\[${missing}\\]\\]`);
    assert.deepEqual((await sync()).plan.actions, [], "nothing left to do");

    // B's page renamed in Notion: the note moves, and the link that read the old title reads the new one.
    const renamed = `Live Bee ${stamp}`;
    await real.setTitle(bId, renamed);
    const moved = await sync();
    assert.deepEqual(moved.summary!.skipped, []);
    assert.deepEqual(moved.summary!.done, { moveInVault: 1, push: 1 });
    assert.equal(await body(a), `See [${renamed}](${dest(renamed)}) and [bee](${dest(renamed)}), not [${missing}](${dest(missing)})\n`);
    assert.equal(await page(), `See [${renamed}](${pageUrl(bId)}) and [bee](${pageUrl(bId)}), not \\[\\[${missing}\\]\\]`);

    // The missing note appears: it gets a page, and A's page links it.
    await writeTree(vault, { [`${missing}.md`]: "Found\n" });
    const relinked = await sync();
    assert.deepEqual(relinked.summary!.skipped, []);
    assert.deepEqual(relinked.summary!.done, { createPage: 1, relink: 1 });
    const missingId = (await notion.listPages()).find((p) => p.title === missing)!.id;
    assert.equal(await page(), `See [${renamed}](${pageUrl(bId)}) and [bee](${pageUrl(bId)}), not [${missing}](${pageUrl(missingId)})`);
    assert.equal(await body(a), `See [${renamed}](${dest(renamed)}) and [bee](${dest(renamed)}), not [${missing}](${dest(missing)})\n`);
    assert.deepEqual((await sync()).plan.actions, [], "nothing left to do");
  } finally {
    for (const id of mine) await real.trash(id);
  }
});

test("the real API: a page's Links to relation is written, listed and read back, and its markdown stays", { skip }, async () => {
  const notion = createSdkGateway({
    token: process.env.NOTION_TOKEN!,
    dataSourceId: process.env.NOPIPELINE_SCRATCH_DATA_SOURCE!,
    titleProperty: "Name",
    linksToProperty: "Links to",
  });
  const stamp = Date.now();
  const [a, b, c] = [await notion.createPage({ title: `live relation A ${stamp}` }), await notion.createPage({ title: `live relation B ${stamp}` }), await notion.createPage({ title: `live relation C ${stamp}` })];
  try {
    assert.ok(await notion.relationTarget(), "the scratch database has a Links to relation");
    await notion.replaceContent(a, "Alpha body");
    const markdown = (await notion.getMarkdown(a)).markdown;
    await notion.setRelation(a, [b, c]);
    assert.deepEqual((await notion.listPages()).find((p) => p.id === a)!.linksTo, { ids: [b, c], more: false });
    assert.deepEqual(await notion.readRelation(a), [b, c]);
    assert.equal((await notion.getMarkdown(a)).markdown, markdown);
  } finally {
    for (const id of [a, b, c]) await notion.trash(id);
  }
});

// Spec §6-§7: the fake's rules for hosted images rest on these. One upload goes in several blocks (a top-level image and a
// list item's child), the block switch keeps the blocks, the read-back URL is parseable and downloads to the uploaded
// bytes, and a write that resends the lines as read (signatures stripped) keeps the blocks.
test("the real API: upload an image, switch placeholder blocks to it, read it back, download it, and keep the blocks through replace_content", { skip }, async () => {
  const notion = createSdkGateway({
    token: process.env.NOTION_TOKEN!,
    dataSourceId: process.env.NOPIPELINE_SCRATCH_DATA_SOURCE!,
    titleProperty: "Name",
  });
  const bytes = new Uint8Array(await readFile(new URL("../fixtures/probe.png", import.meta.url)));
  const id = await notion.createPage({ title: `live images ${Date.now()}` });
  try {
    const top = placeholderUrl("Live/probe.png");
    const parens = placeholderUrl("Live/probe (1).png");
    await notion.replaceContent(id, `Alpha\n\n![top](${top})\n\n- ![item](${top})\n\n![paren](${parens})`);
    const placeholders = await notion.mediaBlocks(id);
    assert.deepEqual(placeholders.map((b) => [b.external, b.hosted, b.caption]), [[top, null, "top"], [top, null, "item"], [parens, null, "paren"]], "document order, the list item's child included");

    const upload = await notion.uploadFile("probe.png", bytes);
    const parenUpload = await notion.uploadFile("probe (1).png", bytes);
    await notion.attachFile(placeholders[0]!.id, "image", upload);
    await notion.attachFile(placeholders[1]!.id, "image", upload);
    await notion.attachFile(placeholders[2]!.id, "image", parenUpload);

    const blocks = await notion.mediaBlocks(id);
    assert.deepEqual(blocks.map((b) => b.id), placeholders.map((b) => b.id), "the switch keeps the blocks");
    assert.deepEqual(blocks.map((b) => b.caption), ["top", "item", "paren"], "and their captions");
    assert.ok(blocks.every((b) => b.external === null && b.hosted !== null));

    const markdown = (await notion.getMarkdown(id)).markdown;
    const urls = markdown.split("\n").flatMap((line) => /^\t*!\[[^\]]*\]\((.*)\)$/.exec(line)?.[1] ?? []);
    assert.equal(urls.length, 3, markdown);
    const files = urls.map((url) => hostedFile(url));
    assert.ok(files.every((f) => f !== null), `hostedFile reads every URL:\n${urls.join("\n")}`);
    assert.equal(files[0]!.key, files[1]!.key, "one upload, one file, in both blocks");
    assert.notEqual(files[0]!.key, files[2]!.key);
    assert.deepEqual(files.map((f) => f!.name), ["probe.png", "probe.png", "probe_(1).png"], "Notion turns the upload's spaces into underscores and leaves parentheses as they are");
    assert.deepEqual(blocks.map((b) => hostedFile(b.hosted!)?.key), files.map((f) => f!.key), "the block API's URL names the same files");

    assert.deepEqual(await notion.download(blocks[0]!.hosted!), bytes);
    assert.deepEqual(await notion.download(blocks[2]!.hosted!), bytes);

    // The page as read, signatures off, sent back whole: the blocks stay.
    await notion.replaceContent(id, stripSignatures(markdown));
    assert.deepEqual((await notion.mediaBlocks(id)).map((b) => b.id), placeholders.map((b) => b.id));
    assert.equal(stripSignatures((await notion.getMarkdown(id)).markdown), stripSignatures(markdown));
  } finally {
    await notion.trash(id);
  }
});

// Final review, finding 15: the shape the translator sends through update_content for a list item holding only an image
// (`-` and the image one tab deeper, used by `updateEmbeds` and by every push of one), checked live: what Notion makes of it,
// that `mediaBlocks` finds the child, and that the switch works and reads back as the same shape.
test("the real API: a list item's image as the translator sends it through update_content is found by mediaBlocks, switched, and read back", { skip }, async () => {
  const notion = createSdkGateway({
    token: process.env.NOTION_TOKEN!,
    dataSourceId: process.env.NOPIPELINE_SCRATCH_DATA_SOURCE!,
    titleProperty: "Name",
  });
  const bytes = new Uint8Array(await readFile(new URL("../fixtures/probe.png", import.meta.url)));
  const ctx = { index: buildLinkIndex([]), fromPath: "Live.md", vaultName: "Live", media: mediaOf(["probe.png"], "") };
  const id = await notion.createPage({ title: `live item image ${Date.now()}` });
  try {
    await notion.replaceContent(id, "- one\n- two");
    const sent = toNotion("- one\n- ![[probe.png]]\n- two", ctx);
    assert.equal(sent, `- one\n-\n\t![](${placeholderUrl("probe.png")})\n- two`, "the translator's shape");
    // Only the lines that change go in an edit, as the executor sends them.
    const markdown = await notion.updateContent(id, [{ old_str: "- one", new_str: "- one\n-\n\t![](" + placeholderUrl("probe.png") + ")" }]);
    assert.equal(markdown, sent, "Notion keeps the empty item with the image one tab deeper");
    const found = await notion.mediaBlocks(id);
    assert.deepEqual(found.map((b) => [b.external, b.hosted]), [[placeholderUrl("probe.png"), null]], "mediaBlocks finds the item's child");
    await notion.attachFile(found[0]!.id, "image", await notion.uploadFile("probe.png", bytes));
    const switched = await notion.mediaBlocks(id);
    assert.deepEqual(switched.map((b) => b.id), [found[0]!.id]);
    assert.notEqual(switched[0]!.hosted, null);
    assert.deepEqual(await notion.download(switched[0]!.hosted!), bytes);
    const after = stripSignatures((await notion.getMarkdown(id)).markdown);
    assert.match(after, /^- one\n-\n\t!\[\]\(https:\/\/prod-files-secure[^)]*\)\n- two$/);
  } finally {
    await notion.trash(id);
  }
});

// Final review, finding 2: an image written inside a callout, a toggle (and a quote) is an image block there; it is found by
// mediaBlocks, can be switched, and its line reads back (with the known file as the placeholder) where `imagesToObsidian`
// and the safety net in `toObsidian` expect it: as a citation inside the callout, never as the placeholder URL.
test("the real API: an image inside a callout and a toggle can be switched and reads back as a citation inside it", { skip }, async () => {
  const notion = createSdkGateway({
    token: process.env.NOTION_TOKEN!,
    dataSourceId: process.env.NOPIPELINE_SCRATCH_DATA_SOURCE!,
    titleProperty: "Name",
  });
  const bytes = new Uint8Array(await readFile(new URL("../fixtures/probe.png", import.meta.url)));
  const ctx = { index: buildLinkIndex([]), fromPath: "Live.md", vaultName: "Live", media: mediaOf(["probe.png"], "") };
  const ph = placeholderUrl("probe.png");
  const id = await notion.createPage({ title: `live nested images ${Date.now()}` });
  try {
    await notion.replaceContent(id, `Alpha\n\n<callout icon="💡">\n\tinside\n\t![c](${ph})\n</callout>\n\n<details>\n<summary>T</summary>\n\t![t](${ph})\n</details>`);
    const found = await notion.mediaBlocks(id);
    assert.deepEqual(found.map((b) => [b.external, b.caption]), [[ph, "c"], [ph, "t"]], "both blocks are found, in order");
    const upload = await notion.uploadFile("probe.png", bytes);
    for (const block of found) await notion.attachFile(block.id, "image", upload);
    const raw = (await notion.getMarkdown(id)).markdown;
    const keys = raw.split("\n").flatMap((line) => {
      const url = /^\t*!\[[^\]]*\]\((.*)\)$/.exec(line)?.[1];
      return url === undefined ? [] : [hostedFile(url)?.key ?? "not hosted"];
    });
    assert.equal(keys.length, 2, raw);
    assert.equal(new Set(keys).size, 1, "one upload, one file, in both blocks");
    assert.notEqual(keys[0], "not hosted", raw);
    // As the sync reads it: the known file is the placeholder; the note then cites it inside the callout and the toggle.
    const canonical = canonicalMarkdown(raw, (key) => (key === keys[0] ? "probe.png" : null));
    assert.match(canonical, new RegExp(`!\\[c\\]\\(${ph.replace(/[.]/g, "\\.")}\\)`));
    const note = toObsidian(canonical, ctx);
    assert.doesNotMatch(note, /nopipeline\.invalid/);
    assert.match(note, /^> \[!\w+\]\n> inside\n>\n> !\[c\]\(probe\.png\)$/m);
    assert.match(note, /^> \[!note\]- T\n> !\[t\]\(probe\.png\)$/m);
  } finally {
    await notion.trash(id);
  }
});

test("the real API: an image child of a quote can be found and switched, and reads back as a citation inside the quote", { skip }, async () => {
  const notion = createSdkGateway({
    token: process.env.NOTION_TOKEN!,
    dataSourceId: process.env.NOPIPELINE_SCRATCH_DATA_SOURCE!,
    titleProperty: "Name",
  });
  const bytes = new Uint8Array(await readFile(new URL("../fixtures/probe.png", import.meta.url)));
  const ctx = { index: buildLinkIndex([]), fromPath: "Live.md", vaultName: "Live", media: mediaOf(["probe.png"], "") };
  const ph = placeholderUrl("probe.png");
  const id = await notion.createPage({ title: `live quote image ${Date.now()}` });
  try {
    await notion.replaceContent(id, `> quoted\n\t![q](${ph})`);
    const found = await notion.mediaBlocks(id);
    assert.deepEqual(found.map((b) => [b.external, b.caption]), [[ph, "q"]], "the quote's child is an image block");
    await notion.attachFile(found[0]!.id, "image", await notion.uploadFile("probe.png", bytes));
    const raw = (await notion.getMarkdown(id)).markdown;
    const key = raw.split("\n").flatMap((line) => hostedFile(/^\t*!\[[^\]]*\]\((.*)\)$/.exec(line)?.[1] ?? "")?.key ?? [])[0];
    assert.notEqual(key, undefined, raw);
    const note = toObsidian(canonicalMarkdown(raw, (k) => (k === key ? "probe.png" : null)), ctx);
    assert.doesNotMatch(note, /nopipeline\.invalid/);
    assert.match(note, /^> quoted\n>\n> !\[q\]\(probe\.png\)$/m);
  } finally {
    await notion.trash(id);
  }
});

// Minors round, finding 9: a web image's line (`![x](https://example.com/a.png)`) is searchable text, as it was before images were
// synced: update_content finds a search text holding it (alone, and with the lines around it) and edits it, while the other
// lines stay. Only hosted and placeholder lines are left out of search texts (spec §7). Controller-run, scratch database.
test("the real API: update_content finds a search text holding a web image line", { skip }, async () => {
  const notion = createSdkGateway({
    token: process.env.NOTION_TOKEN!,
    dataSourceId: process.env.NOPIPELINE_SCRATCH_DATA_SOURCE!,
    titleProperty: "Name",
  });
  const id = await notion.createPage({ title: `live web image ${Date.now()}` });
  try {
    const web = "https://example.com/a.png";
    await notion.replaceContent(id, `Alpha\n\n![old](${web})\n\nOmega`);
    // The image line alone, with its caption changed.
    // Notion keeps the blocks and returns them without the blank lines the text was sent with.
    const flat = (markdown: string) => markdown.split("\n").filter((line) => line.trim() !== "").join("\n");
    let markdown = await notion.updateContent(id, [{ old_str: `![old](${web})`, new_str: `![new](${web})` }]);
    assert.equal(flat(markdown), `Alpha\n![new](${web})\nOmega`);
    // The line with the lines around it (what a nearby edit grows its search text into).
    const [first, second] = markdown.split("\n").filter((line) => line.trim() !== "");
    markdown = await notion.updateContent(id, [{ old_str: `${first}\n${second}`, new_str: `Alpha two\n${second}` }]);
    assert.equal(flat(markdown), `Alpha two\n![new](${web})\nOmega`);
    assert.equal((await notion.mediaBlocks(id)).length, 1, "still one image block");
  } finally {
    await notion.trash(id);
  }
});

// Attachments (spec §6 and §7.1, §7.2, §7.4 of the attachments design): tiny files of every kind made here, written as their placeholder
// tags, switched to uploads, read back, downloaded, and kept through replace_content with the signatures off.
const ZIP_EMPTY = Uint8Array.from([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);
/** The `ftyp` box that starts an MP4-family file, with the brand's four letters. */
const ftyp = (brand: string) => Uint8Array.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, ...[...brand].map((c) => c.charCodeAt(0)), 0, 0, 0, 0]);
const TINY: Record<string, Uint8Array> = {
  mp3: Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0]),
  mp4: ftyp("isom"),
  docx: ZIP_EMPTY,
  zip: ZIP_EMPTY,
  pdf: new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"),
  m4a: ftyp("M4A "),
  mov: ftyp("qt  "),
  "3gp": ftyp("3gp4"),
  xlsx: ZIP_EMPTY,
};
const liveGateway = () =>
  createSdkGateway({ token: process.env.NOTION_TOKEN!, dataSourceId: process.env.NOPIPELINE_SCRATCH_DATA_SOURCE!, titleProperty: "Name" });
const tagLine = (kind: Exclude<MediaKind, "image">, path: string, caption: string) => `<${kind} src="${placeholderUrl(path)}">${caption}</${kind}>`;

test("the real API: an mp3, an mp4, a docx, a zip and a PDF in a list item, as placeholder tags, are found, switched, read back, downloaded and kept through replace_content", { skip }, async () => {
  const notion = liveGateway();
  const id = await notion.createPage({ title: `live attachments ${Date.now()}` });
  const dir = await mkdtemp(join(tmpdir(), "nopipeline-live-"));
  try {
    const files = [
      { path: "Live/song.mp3", kind: "audio", caption: "song" },
      { path: "Live/clip.mp4", kind: "video", caption: "clip" },
      { path: "Live/memo.docx", kind: "file", caption: "memo" },
      { path: "Live/bundle (1).zip", kind: "file", caption: "bundle" },
      { path: "Live/paper.pdf", kind: "pdf", caption: "paper" },
    ] as const;
    const ext = (path: string) => path.slice(path.lastIndexOf(".") + 1);
    const tags = files.map((f) => tagLine(f.kind, f.path, f.caption));
    await notion.replaceContent(id, `Alpha\n\n${[...tags.slice(0, 4), `- ${tags[4]}`].join("\n\n")}`);

    const placeholders = await notion.mediaBlocks(id);
    assert.deepEqual(
      placeholders.map((b) => [b.kind, b.external, b.hosted, b.caption]),
      files.map((f) => [f.kind, placeholderUrl(f.path), null, f.caption]),
      "document order, the list item's PDF included (spec §7.4)",
    );

    // Each file is uploaded and attached; a content type Notion refuses ends the test here, naming it (spec §7.1, §7.2).
    const refused: string[] = [];
    for (const [n, f] of files.entries()) {
      try {
        await notion.attachFile(placeholders[n]!.id, f.kind, await notion.uploadFile(f.path.slice(f.path.lastIndexOf("/") + 1), TINY[ext(f.path)]!));
      } catch (error) {
        refused.push(`${ext(f.path)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    assert.deepEqual(refused, [], "Notion refused these");

    const blocks = await notion.mediaBlocks(id);
    assert.deepEqual(blocks.map((b) => [b.id, b.kind, b.caption]), placeholders.map((b) => [b.id, b.kind, b.caption]), "the switch keeps the blocks, their kinds and captions");
    assert.ok(blocks.every((b) => b.external === null && b.hosted !== null));

    const markdown = (await notion.getMarkdown(id)).markdown;
    const read = markdown.split("\n").flatMap((line) => (mediaLine(line) ? [{ line, media: mediaLine(line)! }] : []));
    assert.equal(read.length, files.length, markdown);
    assert.deepEqual(read.map((r) => [r.media.kind, r.media.caption]), files.map((f) => [f.kind, f.caption]), markdown);
    const hosted = read.map((r) => hostedFile(r.media.url));
    assert.ok(hosted.every((h) => h !== null), `hostedFile reads every URL:\n${read.map((r) => r.media.url).join("\n")}`);
    assert.deepEqual(hosted.map((h) => h!.name), ["song.mp3", "clip.mp4", "memo.docx", "bundle_(1).zip", "paper.pdf"]);
    assert.deepEqual(blocks.map((b) => hostedFile(b.hosted!)?.key), hosted.map((h) => h!.key), "the block API's URL names the same files");
    const lines = markdown.split("\n");
    const at = lines.indexOf(read[4]!.line);
    assert.equal(lines[at - 1], "-", "the PDF in a list item reads back as an empty item with the PDF one tab deeper");
    assert.match(read[4]!.line, /^\t<pdf /);

    // Downloads stream to disk; the hash and size are those of the bytes sent.
    for (const [n, f] of files.entries()) {
      const bytes = TINY[ext(f.path)]!;
      const path = join(dir, `${n}.${ext(f.path)}`);
      assert.deepEqual(await notion.downloadTo(blocks[n]!.hosted!, path), { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length }, f.path);
      assert.deepEqual(new Uint8Array(await readFile(path)), bytes);
      assert.deepEqual(await notion.download(blocks[n]!.hosted!), bytes);
    }
    await assert.rejects(notion.downloadTo(blocks[0]!.hosted!, join(dir, "0.mp3")), (e: unknown) => (e as NodeJS.ErrnoException).code === "EEXIST");

    // update_content of another line keeps the blocks; a search text holding a hosted line is never found (spec §6).
    await notion.updateContent(id, [{ old_str: "Alpha", new_str: "Alpha, edited" }]);
    assert.deepEqual((await notion.mediaBlocks(id)).map((b) => b.id), placeholders.map((b) => b.id));
    for (const r of read) await assert.rejects(notion.updateContent(id, [{ old_str: r.line.trim(), new_str: "x" }]), NotionPageError, r.line);

    // The page as read, signatures off, sent back whole: every block stays (same ids, still hosted).
    const bare = stripSignatures((await notion.getMarkdown(id)).markdown);
    await notion.replaceContent(id, bare);
    const kept = await notion.mediaBlocks(id);
    assert.deepEqual(kept.map((b) => b.id), placeholders.map((b) => b.id));
    assert.ok(kept.every((b) => b.hosted !== null));
    assert.equal(stripSignatures((await notion.getMarkdown(id)).markdown), bare);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await notion.trash(id);
  }
});

// Spec §7.1 and §7.2: which extensions Notion's upload takes for each kind. Never fails on a refusal: the results are the output.
// Live: m4a, mov and xlsx accepted; 3gp refused ("The content type audio/3gpp is not supported for the File Upload API").
test("the real API: which extensions Notion takes for audio, video and file blocks (recorded, not asserted)", { skip }, async (t) => {
  const notion = liveGateway();
  const id = await notion.createPage({ title: `live types ${Date.now()}` });
  try {
    const cases = [
      ["audio", "m4a"],
      ["audio", "3gp"],
      ["video", "mov"],
      ["file", "xlsx"],
    ] as const;
    await notion.replaceContent(id, cases.map(([kind, ext]) => tagLine(kind, `Live/probe.${ext}`, ext)).join("\n\n"));
    const blocks = await notion.mediaBlocks(id);
    assert.equal(blocks.length, cases.length);
    for (const [n, [kind, ext]] of cases.entries()) {
      try {
        await notion.attachFile(blocks[n]!.id, kind, await notion.uploadFile(`probe.${ext}`, TINY[ext]!));
        t.diagnostic(`${ext} as ${kind}: accepted`);
      } catch (error) {
        t.diagnostic(`${ext} as ${kind}: REFUSED ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await notion.trash(id);
  }
});

// What the fake assumes beyond spec §6, checked here: an upload of one kind is refused by a block of another, and a hosted PDF line
// of another page's file becomes an empty PDF block (as an image's does).
test("the real API: an upload is refused by a block of another type, and another page's hosted PDF line becomes an empty PDF block", { skip }, async () => {
  const notion = liveGateway();
  const one = await notion.createPage({ title: `live pdf one ${Date.now()}` });
  const two = await notion.createPage({ title: `live pdf two ${Date.now()}` });
  try {
    await notion.replaceContent(one, `${tagLine("pdf", "Live/a.pdf", "a")}\n\n![i](${placeholderUrl("Live/a.png")})`);
    const [pdf, image] = await notion.mediaBlocks(one);
    const upload = await notion.uploadFile("a.pdf", TINY.pdf!);
    await assert.rejects(notion.attachFile(pdf!.id, "image", upload), (e: unknown) => e instanceof NotionPageError && e.code === "validation_error", "a PDF block takes no image upload");
    await assert.rejects(notion.attachFile(image!.id, "pdf", upload), (e: unknown) => e instanceof NotionPageError && e.code === "validation_error", "an image block takes no PDF upload");
    await notion.attachFile(pdf!.id, "pdf", upload);
    // As the sync sends a hosted line: signature and fragment off (a signed one of another page's file is read back with its URL, live).
    const foreign = hostedFile(/<pdf src="([^"]*)">/.exec((await notion.getMarkdown(one)).markdown)![1]!)!.bare;

    const back = await notion.replaceContent(two, `<pdf src="${foreign}">f</pdf>`);
    assert.equal(back.trim(), '<pdf src="">f</pdf>');
    const [empty] = await notion.mediaBlocks(two);
    assert.deepEqual([empty!.kind, empty!.external, empty!.hosted, empty!.caption], ["pdf", "", null, "f"]);
  } finally {
    await notion.trash(one);
    await notion.trash(two);
  }
});

// Review of the whole attachments branch, finding 4: three pairings the fake accepts and nothing else has shown Notion to accept.
// 1. Spec §5.9 sends a link alone on its line as a `<file>` block for every kind, so an image, a PDF or an audio file is uploaded with its own
//    content type and attached to a FILE block (`attachFile(block, "file", upload)`); the fake checks the block's kind against the argument only.
// 2. A line whose kind changes (an image block whose note citation became a link) is sent through replace_content as a new placeholder in the
//    other kind, and the old hosted block is dropped by the replace; then the new one is switched.
// 3. `.avif` is an image by extension (image/avif): its upload goes into an IMAGE block.
// What the sync relies on is asserted, after everything is recorded (t.diagnostic): a refusal would be handled (spec §5.11, the line stays
// text with a warning), but a pairing the sync sends has to work, and the block must read back in the kind it was sent in.
const PNG = () => readFile(new URL("../fixtures/probe.png", import.meta.url)).then((b) => new Uint8Array(b));
const AVIF = ftyp("avif");

test("the real API: a file block takes a png, a PDF and an mp3 upload (recorded; the sync relies on it: switched, kept as a file block, downloadable)", { skip }, async (t) => {
  const notion = liveGateway();
  const id = await notion.createPage({ title: `live file blocks ${Date.now()}` });
  try {
    const cases = [
      { path: "Live/shot.png", name: "shot.png", bytes: await PNG() },
      { path: "Live/paper.pdf", name: "paper.pdf", bytes: TINY.pdf! },
      { path: "Live/song.mp3", name: "song.mp3", bytes: TINY.mp3! },
    ];
    await notion.replaceContent(id, cases.map((c) => tagLine("file", c.path, c.name)).join("\n\n"));
    const placeholders = await notion.mediaBlocks(id);
    assert.deepEqual(placeholders.map((b) => [b.kind, b.external, b.caption]), cases.map((c) => ["file", placeholderUrl(c.path), c.name]));

    const refused: string[] = [];
    const attached: number[] = [];
    for (const [n, c] of cases.entries()) {
      try {
        await notion.attachFile(placeholders[n]!.id, "file", await notion.uploadFile(c.name, c.bytes));
        attached.push(n);
        t.diagnostic(`${c.name} (${c.bytes.length} bytes) as a file block: accepted`);
      } catch (error) {
        refused.push(c.name);
        t.diagnostic(`${c.name} as a file block: REFUSED ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const markdown = (await notion.getMarkdown(id)).markdown;
    t.diagnostic(`read back:\n${markdown}`);
    const blocks = await notion.mediaBlocks(id);
    t.diagnostic(`blocks: ${blocks.map((b) => `${b.kind} ${b.hosted ? "hosted" : "placeholder"} "${b.caption}"`).join("; ")}`);

    for (const n of attached) {
      const block = blocks[n]!;
      assert.equal(block.id, placeholders[n]!.id, `${cases[n]!.name}: the switch keeps the block`);
      assert.equal(block.kind, "file", `${cases[n]!.name}: still a file block, not retyped to its content`);
      assert.ok(block.hosted !== null && block.external === null, `${cases[n]!.name}: hosted`);
      assert.equal(block.caption, cases[n]!.name);
      assert.deepEqual(await notion.download(block.hosted!), cases[n]!.bytes, `${cases[n]!.name}: downloads as sent`);
    }
    const read = markdown.split("\n").flatMap((line) => mediaLine(line) ?? []);
    for (const n of attached) {
      assert.equal(read[n]?.kind, "file", `${cases[n]!.name}: reads back as a <file> line`);
      assert.equal(hostedFile(read[n]!.url)?.key, hostedFile(blocks[n]!.hosted!)?.key, `${cases[n]!.name}: the line names the block's file`);
    }
    // The page as read, signatures off, sent back whole: the blocks stay.
    await notion.replaceContent(id, stripSignatures(markdown));
    assert.deepEqual((await notion.mediaBlocks(id)).map((b) => b.id), placeholders.map((b) => b.id));
    assert.deepEqual(refused, [], "Notion refused these pairings; make the fake refuse them too (FakeNotion.attachFile) and let the sync handle the refusal");
  } finally {
    await notion.trash(id);
  }
});

test("the real API: an image block's line re-sent as a <file> placeholder through replace_content drops the hosted image block, and the new block switches (recorded; the sync relies on it)", { skip }, async (t) => {
  const notion = liveGateway();
  const id = await notion.createPage({ title: `live kind switch ${Date.now()}` });
  try {
    const bytes = await PNG();
    await notion.replaceContent(id, `Alpha\n\n![cap](${placeholderUrl("Live/shot.png")})\n\nOmega`);
    const [image] = await notion.mediaBlocks(id);
    await notion.attachFile(image!.id, "image", await notion.uploadFile("shot.png", bytes));
    const hostedImage = (await notion.mediaBlocks(id))[0]!;
    assert.equal(hostedImage.kind, "image");
    assert.ok(hostedImage.hosted !== null);

    // As the sync sends a line whose kind changed: the new kind, the file's placeholder, the same caption, the rest of the page as it is.
    await notion.replaceContent(id, `Alpha\n\n${tagLine("file", "Live/shot.png", "cap")}\n\nOmega`);
    const swapped = await notion.mediaBlocks(id);
    t.diagnostic(`after the replace: ${swapped.map((b) => `${b.kind} ${b.hosted ? "hosted" : "placeholder"} "${b.caption}" id ${b.id === image!.id ? "kept" : "new"}`).join("; ")}`);
    assert.equal(swapped.length, 1, "the old hosted image block is gone");
    assert.deepEqual([swapped[0]!.kind, swapped[0]!.external, swapped[0]!.hosted, swapped[0]!.caption], ["file", placeholderUrl("Live/shot.png"), null, "cap"]);

    await notion.attachFile(swapped[0]!.id, "file", await notion.uploadFile("shot.png", bytes));
    const [switched] = await notion.mediaBlocks(id);
    assert.equal(switched!.kind, "file");
    assert.ok(switched!.hosted !== null && switched!.external === null);
    assert.deepEqual(await notion.download(switched!.hosted!), bytes);
    const markdown = (await notion.getMarkdown(id)).markdown;
    t.diagnostic(`read back:\n${markdown}`);
    const line = markdown.split("\n").flatMap((l) => mediaLine(l) ?? []);
    assert.deepEqual(line.map((l) => [l.kind, l.caption]), [["file", "cap"]]);
    assert.equal(hostedFile(line[0]!.url)?.key, hostedFile(switched!.hosted!)?.key);
  } finally {
    await notion.trash(id);
  }
});

test("the real API: an avif upload into an image block (recorded; the sync relies on a refusal being a validation_error, which it handles)", { skip }, async (t) => {
  const notion = liveGateway();
  const id = await notion.createPage({ title: `live avif ${Date.now()}` });
  try {
    await notion.replaceContent(id, `![a](${placeholderUrl("Live/pic.avif")})`);
    const [block] = await notion.mediaBlocks(id);
    let refusal: unknown = null;
    try {
      await notion.attachFile(block!.id, "image", await notion.uploadFile("pic.avif", AVIF));
      t.diagnostic("pic.avif (a bare ftyp box, content type image/avif) into an image block: accepted");
    } catch (error) {
      refusal = error;
      t.diagnostic(`pic.avif into an image block: REFUSED ${error instanceof Error ? error.message : String(error)}`);
    }
    // The upload itself may be refused too (the file type); both are what the sync's refusal path catches.
    if (refusal !== null) {
      assert.ok(refusal instanceof NotionPageError && refusal.code === "validation_error", "a refusal is a validation_error, which the sync reports as a refused upload");
      return;
    }
    const [after] = await notion.mediaBlocks(id);
    t.diagnostic(`after: ${after!.kind} ${after!.hosted ? "hosted" : "placeholder"}; read back: ${(await notion.getMarkdown(id)).markdown.trim()}`);
    assert.equal(after!.kind, "image", "still an image block");
    assert.ok(after!.hosted !== null);
    assert.deepEqual(await notion.download(after!.hosted!), AVIF);
  } finally {
    await notion.trash(id);
  }
});

// Projects: the scratch notes database has a two-way relation `Project` to a scratch projects database, which has no
// default template, so a project made here is blank. Each test trashes what it creates.
const projectsGateway = () =>
  createSdkGateway({
    token: process.env.NOTION_TOKEN!,
    dataSourceId: process.env.NOPIPELINE_SCRATCH_DATA_SOURCE!,
    titleProperty: "Name",
    projectsRelation: "Project",
  });

test("the real API: the projects database is found through the relation, a project is created blank, listed, renamed and trashed", { skip }, async () => {
  const notion = projectsGateway();
  const source = await notion.projectsSource();
  assert.ok(source, "the scratch notes database has a Project relation to a readable database");
  const title = `live project ${Date.now()}`;
  const id = await notion.createProject(title);
  try {
    assert.deepEqual((await notion.listProjects()).filter((p) => p.id === id), [{ id, title }]);
    await notion.renameProject(id, `${title}, renamed`);
    assert.equal((await notion.listProjects()).find((p) => p.id === id)?.title, `${title}, renamed`);
  } finally {
    await notion.trash(id);
  }
  assert.equal((await notion.listProjects()).some((p) => p.id === id), false);
});

test("the real API: a page's projects are written and read back in order, the first replaced, and removed", { skip }, async () => {
  const notion = projectsGateway();
  const stamp = Date.now();
  const [p1, p2, p3] = [await notion.createProject(`live project A ${stamp}`), await notion.createProject(`live project B ${stamp}`), await notion.createProject(`live project C ${stamp}`)];
  const page = await notion.createPage({ title: `live project page ${stamp}`, projects: [p3, p1] });
  try {
    assert.deepEqual(await notion.readProjects(page), [p3, p1]);
    await notion.setProjects(page, [p2, p1, p3]);
    assert.deepEqual(await notion.readProjects(page), [p2, p1, p3]);
    await notion.setProjects(page, []);
    assert.deepEqual(await notion.readProjects(page), []);
  } finally {
    await notion.trash(page);
    for (const id of [p1, p2, p3]) await notion.trash(id);
  }
});
