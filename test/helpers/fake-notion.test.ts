import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { NotionPageError } from "../../src/notion/gateway.ts";
import { hostedFile } from "../../src/notion/hosted.ts";
import { asNotionKeeps, FakeNotion } from "./fake-notion.ts";

test("the fake refuses an edit that doesn't match exactly once and leaves the page as it was", async () => {
  const notion = new FakeNotion();
  const id = notion.add("Note", "a\nb\na");
  await assert.rejects(notion.updateContent(id, [{ old_str: "b", new_str: "B" }, { old_str: "a", new_str: "A" }]), NotionPageError);
  assert.equal((await notion.getMarkdown(id)).markdown, "a\nb\na");
  await assert.rejects(notion.updateContent(id, [{ old_str: "", new_str: "X" }]), NotionPageError);
  assert.equal(await notion.updateContent(id, [{ old_str: "b\na", new_str: "B\nA" }]), "a\nB\nA");
});

test("the fake finds a search text as Notion does: in the page's markdown, any part of a line, refused when found twice (live)", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/notion/search-matches.json", import.meta.url), "utf8")) as {
    cases: { page: string; old_str: string; new_str: string; refused?: string; after?: string }[];
  };
  for (const c of fixture.cases) {
    const notion = new FakeNotion();
    const id = notion.add("Note", c.page);
    if (c.refused) {
      await assert.rejects(notion.updateContent(id, [{ old_str: c.old_str, new_str: c.new_str }]), (e: unknown) => e instanceof NotionPageError && e.message.startsWith(c.refused!), c.old_str);
      assert.equal((await notion.getMarkdown(id)).markdown, c.page);
    } else {
      assert.equal(await notion.updateContent(id, [{ old_str: c.old_str, new_str: c.new_str }]), c.after, c.old_str);
    }
  }
});

test("trashed pages disappear from the list and can't be read", async () => {
  const notion = new FakeNotion();
  const id = notion.add("Note", "x");
  await notion.trash(id);
  assert.deepEqual(await notion.listPages(), []);
  await assert.rejects(notion.getMarkdown(id), NotionPageError);
});

test("the fake keeps a nested code block the way Notion does: its lines flush left, an untagged one as javascript", async () => {
  const notion = new FakeNotion();
  const id = notion.add("Note", "");
  const sent = [">", "\t```", "\tx = 1", "\t    y", "\t", "\t```", "- item", "\t```go", "\t\treturn", "\t```"].join("\n");
  const kept = [">", "\t```javascript", "x = 1", "    y", "", "\t```", "- item", "\t```go", "\treturn", "\t```"].join("\n");
  assert.equal(await notion.replaceContent(id, sent), kept);
  // Lines Notion already wrote flush left stay as they are when the page is edited.
  assert.equal(await notion.updateContent(id, [{ old_str: "x = 1", new_str: "x = 2" }]), kept.replace("x = 1", "x = 2"));
});

test("the fake keeps a line that starts with a triple-backtick code span as text (final review, fourth round P2)", async () => {
  const notion = new FakeNotion();
  const id = notion.add("Note", "");
  // Text, not a fence; the code span comes back with one backtick each side (live probe).
  assert.equal(await notion.replaceContent(id, "Before\n```inline``` text\nAfter"), "Before\n`inline` text\nAfter");
});

test("the fake finds a line with a page mention only by the search text Notion finds it by (live probes)", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/notion/mention-search.json", import.meta.url), "utf8")) as {
    cases: { case: string; target: string; search: string; found: boolean | "either" }[];
  };
  for (const trashed of ["self-closing", "titled"] as const) {
    for (const c of fixture.cases) {
      const notion = new FakeNotion();
      notion.trashedMentions = trashed;
      const titles: Record<string, string> = { live: "Zeta Target", renamed: "Zeta Target", untitled: "", special: "Odd [x] *y* <z> title", outside: "Outside Child", trashed: "Soon Trashed" };
      let target: string;
      if (c.target === "outside") notion.outside.set((target = randomUUID()), titles.outside!);
      else if (c.target === "missing") target = randomUUID();
      else target = notion.add(titles[c.target]!, "");
      if (c.target === "renamed") notion.edit(target, { title: "Zeta Renamed" });
      if (c.target === "trashed") await notion.trash(target);
      const now = c.target === "renamed" ? "Zeta Renamed" : (titles[c.target] ?? "");
      const url = `https://app.notion.com/p/${target.replace(/-/g, "")}`;
      const line = `Line <mention-page url="${url}"/> end of line`;
      const page = notion.add("P", `Before\n${line}\nAfter`);
      const titled = (title: string) => line.replace("/>", `>${title}</mention-page>`);
      const search: Record<string, string> = {
        titled: titled(now),
        "self-closing": line,
        "other title": titled("Something else"),
        empty: titled(""),
        Untitled: titled("Untitled"),
        "old title": titled("Zeta Target"),
        "title alone": now,
        beside: " end of line",
      };
      const found = await notion.updateContent(page, [{ old_str: search[c.search]!, new_str: `${search[c.search]} +` }]).then(
        () => true,
        (error: unknown) => {
          assert.ok(error instanceof NotionPageError && error.code === "validation_error", c.case);
          return false;
        },
      );
      const expected = c.found === "either" ? (c.search === "titled") === (trashed === "titled") : c.found;
      assert.equal(found, expected, `${c.case} (a trashed page's mention found ${trashed})`);
      // What the page keeps is the mention as Notion returns it, self-closing, however the edit wrote it.
      if (found) assert.match((await notion.getMarkdown(page)).markdown, new RegExp(`<mention-page url="${url}"/>|^Before\\n[^<]*$`));
    }
  }
});

test("the fake keeps a mention written in an edit self-closing, and reads mentions in code as text", async () => {
  const notion = new FakeNotion();
  const target = notion.add("Target", "");
  const mention = `<mention-page url="https://app.notion.com/p/${target.replace(/-/g, "")}"/>`;
  const code = `\`${mention}\` in code\n\`\`\`python\n${mention}\n\`\`\``;
  const page = notion.add("P", `first line\n${code}`);
  const titled = mention.replace("/>", ">Any title</mention-page>");
  assert.equal(await notion.updateContent(page, [{ old_str: "first line", new_str: `a ${titled}` }]), `a ${mention}\n${code}`);
  // In code, a mention's tag is text: it is found as it is written.
  assert.equal(await notion.updateContent(page, [{ old_str: `\`${mention}\` in code`, new_str: "x" }]), `a ${mention}\nx\n\`\`\`python\n${mention}\n\`\`\``);
  assert.equal(await notion.updateContent(page, [{ old_str: `\n${mention}\n`, new_str: "\ny\n" }]), `a ${mention}\nx\n\`\`\`python\ny\n\`\`\``);
});

test("the fake keeps inline text the way Notion does (live probe), but for the forms it doesn't model", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/notion/inline-forms.json", import.meta.url), "utf8")) as { lines: { sent: string; kept: string }[] };
  // Italics inside italics, which Notion writes as one span; inline math, which the translator writes in Notion's
  // form; and `_a__`, whose last underscore Notion keeps as text.
  const unmodelled = ["x *a _b_ c* y", "math $a_b_c$ here", "x _a__ y"];
  const wrong = fixture.lines.filter(({ sent, kept }) => !unmodelled.includes(sent) && asNotionKeeps(sent) !== kept).map(({ sent }) => sent);
  assert.deepEqual(wrong, []);
  // A line the page already holds is read again too (live probe): `_foo_`, Notion's text for an escaped
  // `\_foo\_`, becomes italics the next time the page is written.
  assert.equal(asNotionKeeps("_foo_ escaped\nnew _it_", "_foo_ escaped"), "*foo* escaped\nnew *it*");
});

test("the fake keeps text the way Notion does in the second round's probes (live), but for the forms it doesn't model", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/notion/inline-forms-2.json", import.meta.url), "utf8")) as {
    groups: { name: string; lines?: { sent: string; kept: string }[]; sent?: string[]; kept?: string[] }[];
  };
  // Emphasis Notion mangles, a single star beside a double one, and code spans holding a backtick (`code spans`, `code escapes`).
  const unmodelled = new Set(["x * y **z**", "x _a __b__ c_ y", "x ***a** b* y", "code spans", "code escapes"]);
  const wrong: string[] = [];
  for (const group of fixture.groups) {
    if (unmodelled.has(group.name)) continue;
    // A group whose lines make one page (a merge, a code block) is compared whole.
    const sent = group.lines ? group.lines.map((l) => l.sent) : group.sent!;
    const kept = group.lines ? group.lines.map((l) => l.kept) : group.kept!;
    if (!group.lines || sent.some((l) => l.startsWith("```"))) {
      if (asNotionKeeps(sent.join("\n")) !== kept.join("\n")) wrong.push(group.name);
      continue;
    }
    for (const [k, line] of sent.entries()) if (!unmodelled.has(line) && asNotionKeeps(line) !== kept[k]) wrong.push(line);
  }
  assert.deepEqual(wrong, []);
});

test("the fake reads every line of a page again whenever it is written, as Notion does (live)", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/notion/reread.json", import.meta.url), "utf8")) as {
    cases: { case: string; sent: string; returned: string; holdsAfterAnotherLineIsEdited: string }[];
  };
  // What each block's markdown is once Notion has read it again (heading, list items and divider read alike).
  const after: Record<string, string> = { under: "*literal underscores* here", wiki: "!\\[\\[a *b* c\\]\\]", plus: "- literal plus" };
  for (const c of fixture.cases) {
    const notion = new FakeNotion();
    const id = notion.add("P", "");
    assert.equal(await notion.replaceContent(id, ["Anchor", c.sent, "Tail"].join("\n")), ["Anchor", c.returned, "Tail"].join("\n"), `${c.case}: as sent`);
    const md = await notion.updateContent(id, [{ old_str: "Tail", new_str: "Tail edited" }]);
    assert.equal(md, ["Anchor", after[c.case] ?? c.returned, "Tail edited"].join("\n"), `${c.case}: after another line is edited`);
  }
});

test("the fake keeps page links as Notion does (live probe), but for a line the probe sent unescaped", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/notion/page-links.json", import.meta.url), "utf8")) as {
    pages: Record<string, { id: string; title?: string; renamed?: string }>;
    unescaped: string[];
    steps: { step: string; what: string; replace?: string[]; old_str?: string; new_str?: string; rename?: string; trash?: string; returned: string[] }[];
  };
  const notion = new FakeNotion();
  // The probe's pages, under the fake's ids; a page no one has keeps the probe's id.
  const ids = new Map(Object.entries(fixture.pages).flatMap(([name, page]) => (page.title === undefined ? [] : [[name, notion.add(page.title, "")] as const])));
  const linker = notion.add("Probe Linker", "");
  const ours = (text: string) => Object.entries(fixture.pages).reduce((t, [name, page]) => (ids.has(name) ? t.replaceAll(page.id, ids.get(name)!.replace(/-/g, "")) : t), text);
  // A line the probe sent unescaped (Notion read it as text and a mention) says nothing of the translator's form: not modelled.
  const modelled = (lines: string[]) => lines.filter((line) => !fixture.unescaped.some((start) => line.startsWith(start))).map(ours).join("\n");
  const returned: string[] = [];
  for (const s of fixture.steps) {
    let markdown: string;
    if (s.replace) markdown = await notion.replaceContent(linker, modelled(s.replace));
    else if (s.old_str !== undefined) markdown = await notion.updateContent(linker, [{ old_str: ours(s.old_str), new_str: ours(s.new_str!) }]);
    else {
      if (s.rename) await notion.setTitle(ids.get(s.rename)!, fixture.pages[s.rename]!.renamed!);
      if (s.trash) await notion.trash(ids.get(s.trash)!);
      markdown = (await notion.getMarkdown(linker)).markdown;
    }
    assert.equal(markdown, modelled(s.returned), `step ${s.step}: ${s.what}`);
    returned.push(markdown);
  }
  // A page link reading the page's title is kept, also once the page is renamed or in the trash.
  const see = (k: number) => returned[k]!.split("\n")[0]!;
  assert.match(see(0), /^See \[Probe Target 1792470866243\]\(https:\/\/app\.notion\.com\/p\/[0-9a-f]{32}\) here$/);
  assert.match(see(fixture.steps.findIndex((s) => s.trash)), /^See \[Probe Target 1792470866243\]\(/);
  // `Probe \_\_glow\_\_ lamp …` is one link on the write that sends it, and three on the next write anywhere on the page.
  assert.match(returned[0]!, /^And \[Probe __glow__ lamp 1792470866243\]\([^)]+\) too$/m);
  assert.match(returned[2]!, /^And \[Probe \]\(([^)]+)\)\[\*\*glow\*\*\]\(\1\)\[ lamp 1792470866243\]\(\1\) too$/m);
  // A link to a page no one has is kept as written.
  assert.match(returned.at(-1)!, /^Missing \[Nope\]\(https:\/\/app\.notion\.com\/p\/85aa8dab03ac454b81f0b275a15e300b\) here$/m);
});

// The live tests' run (a recorded live run): page links as the translator writes
// them, on the first write and two later writes to another line.
test("the fake keeps page links as the live tests recorded them: an escaped text as sent, a partly styled one split on the first write", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/notion/page-links-2.json", import.meta.url), "utf8")) as {
    pages: Record<string, { title: string }>;
    steps: { step: string; what: string; replace?: string[]; old_str?: string; new_str?: string; returned: string[] }[];
  };
  const notion = new FakeNotion();
  const urls = new Map(Object.entries(fixture.pages).map(([name, page]) => [name, `https://app.notion.com/p/${notion.add(page.title, "").replace(/-/g, "")}`]));
  const linker = notion.add("Live page links", "");
  // The run recorded each page's URL as its name (`U`, `O`): put the fake's in.
  const ours = (lines: string[]) => lines.map((line) => line.replace(/\]\(([UO])\)/g, (_m, name: string) => `](${urls.get(name)!})`)).join("\n");
  for (const s of fixture.steps) {
    const markdown = s.replace ? await notion.replaceContent(linker, ours(s.replace)) : await notion.updateContent(linker, [{ old_str: s.old_str!, new_str: s.new_str! }]);
    assert.equal(markdown, ours(s.returned), `step ${s.step}: ${s.what}`);
  }
  // What the checks were about, as recorded.
  const [first, , third] = fixture.steps.map((s) => s.returned);
  for (const lines of [first!, third!]) {
    assert.ok(lines.includes(fixture.steps[0]!.replace![1]!), "the escaped [ ] | * text as sent");
    assert.ok(lines.includes("Bold [a ](U)[**b**](U)[ c](U) here") && lines.includes("Italic [a ](U)[*b*](U)[ c](U) here"));
    assert.ok(lines.includes("Strike [a ](U)[~~b~~](U)[ c](U) here") && lines.includes("Code [a ](U)[`b`](U)[ c](U) here"));
    assert.ok(lines.includes("DemoVault [`__slots__`](U)[ attribute](U) here"));
  }
});

test("the fake splits a page link whose text is partly code as it does a partly bold one (confirmed live, a recorded live run)", () => {
  const u = "https://app.notion.com/p/43fa4df3889e4107865589da9614ff6d";
  // The one case seen so far; a link that is code throughout stays one link.
  assert.equal(asNotionKeeps(`See [\`__slots__\` attribute](${u}) here`), `See [\`__slots__\`](${u})[ attribute](${u}) here`);
  assert.equal(asNotionKeeps(`See [\`__slots__\`](${u}) here`), `See [\`__slots__\`](${u}) here`);
});

test("the fake models the Links to relation as Notion does (live, spec §7)", async () => {
  let clock = Date.parse("2026-11-03T10:00:00Z");
  const notion = new FakeNotion(() => new Date(clock));
  const target = notion.add("Target", "text");
  const a = notion.add("A", "body of A");
  assert.equal(await notion.relationTarget(), null, "no relation property until a test adds it");
  assert.equal((await notion.listPages())[0]!.linksTo, undefined);
  notion.addLinksTo();
  assert.deepEqual(await notion.properties(), { Name: "title", "Links to": "relation" });
  assert.equal(await notion.relationTarget(), "a50245e9-8e6a-41aa-8ccf-d8795ed0dead");
  assert.deepEqual((await notion.listPages()).find((p) => p.id === a)!.linksTo, { ids: [], more: false });

  // A write moves the written page's edit time only, and never its markdown (§7.1, §7.3).
  clock += 5 * 60_000;
  const before = new Map((await notion.listPages()).map((p) => [p.id, p.lastEditedTime]));
  await notion.setRelation(a, [target]);
  const after = new Map((await notion.listPages()).map((p) => [p.id, p.lastEditedTime]));
  assert.notEqual(after.get(a), before.get(a));
  assert.equal(after.get(target), before.get(target));
  assert.equal((await notion.getMarkdown(a)).markdown, "body of A");
  assert.deepEqual(await notion.readRelation(a), [target]);
  assert.deepEqual(notion.calls.filter((c) => /Relation/.test(c)), [`setRelation ${a}`, `readRelation ${a}`]);

  // The query lists 25 entries and says there are more; the property item has them all (§7.2).
  const many = Array.from({ length: 30 }, (_, i) => notion.add(`T${i}`, ""));
  await notion.setRelation(a, many);
  assert.deepEqual((await notion.listPages()).find((p) => p.id === a)!.linksTo, { ids: many.slice(0, 25), more: true });
  assert.deepEqual(await notion.readRelation(a), many);

  // An entry to a trashed page is gone from both (§7.4); a hand edit sets the list.
  await notion.trash(many[0]!);
  // Notion takes the first 25 stored entries, then hides the trashed one: 24 shown, not 25 (probe-relation-20261103.txt, check 4:
  // "after trashing T2, query shows T2 false entries 24", property item 29).
  assert.deepEqual((await notion.listPages()).find((p) => p.id === a)!.linksTo, { ids: many.slice(1, 25), more: true });
  assert.deepEqual(await notion.readRelation(a), many.slice(1));
  notion.edit(a, { linksTo: [target] });
  assert.deepEqual(await notion.readRelation(a), [target]);
  await assert.rejects(notion.setRelation(many[0]!, []), NotionPageError);
});

// Hosted images (spec §6 and §7, live): the fake keeps files, blocks and signed URLs as Notion does.
const WORKSPACE = "4f1c2a9e-0000-4000-8000-123456789abc";
const HOSTED = new RegExp(`^(\\t*)!\\[([^\\]]*)\\]\\((https://prod-files-secure\\.s3\\.us-west-2\\.amazonaws\\.com/${WORKSPACE}/([0-9a-f-]{36})/([^?#]+))\\?X-Amz-Signature=(\\d+)#notion_record=block\\.([0-9a-f-]{36})\\.${WORKSPACE}\\)$`);
const bytesOf = (...n: number[]) => Uint8Array.from(n);
/** A page with a placeholder image line, its image attached to an upload; returns the page and the block. */
async function pageWithHostedImage(notion: FakeNotion, bytes = bytesOf(1, 2, 3), caption = "cap") {
  const id = notion.add("Note", `before\n![${caption}](https://nopipeline.invalid/vault/a.png)\nafter`);
  const [block] = await notion.mediaBlocks(id);
  await notion.attachFile(block!.id, "image", await notion.uploadFile("a.png", bytes));
  return { id, block: block! };
}

test("a hosted image reads back with a signature that changes on every read, and the block's record", async () => {
  const notion = new FakeNotion();
  const { id, block } = await pageWithHostedImage(notion);
  const first = (await notion.getMarkdown(id)).markdown.split("\n")[1]!;
  const second = (await notion.getMarkdown(id)).markdown.split("\n")[1]!;
  const a = HOSTED.exec(first)!;
  const b = HOSTED.exec(second)!;
  assert.ok(a && b, first);
  assert.equal(a[2], "cap");
  assert.equal(a[5], "a.png");
  assert.equal(a[7], block.id);
  assert.equal(a[3], b[3]);
  assert.notEqual(a[6], b[6]);
  assert.notEqual(first, second);
});

test("update_content refuses a search text that holds an image line, hosted or placeholder, and leaves the page alone", async () => {
  const notion = new FakeNotion();
  const { id } = await pageWithHostedImage(notion);
  const lines = (await notion.getMarkdown(id)).markdown.split("\n");
  for (const old_str of [lines[1]!, `${lines[0]}\n${lines[1]}`, "x\n![c](https://example.com/x.png)", "\t![c]()"]) {
    await assert.rejects(notion.updateContent(id, [{ old_str, new_str: "x" }]), (e: unknown) => e instanceof NotionPageError && e.code === "validation_error" && e.message.startsWith("No matches found"), old_str);
  }
  assert.equal((await notion.getMarkdown(id)).markdown.split("\n").length, 3);
  // edits of other lines work and leave the image block alone
  const [block] = await notion.mediaBlocks(id);
  const after = await notion.updateContent(id, [{ old_str: "after", new_str: "AFTER" }]);
  assert.equal(after.split("\n")[2], "AFTER");
  assert.equal((await notion.mediaBlocks(id))[0]!.id, block!.id);
});

test("update_content can insert a placeholder line, which becomes an external block at that place", async () => {
  const notion = new FakeNotion();
  const { id, block } = await pageWithHostedImage(notion);
  await notion.updateContent(id, [{ old_str: "after", new_str: "![second](https://example.com/p2.png)\nafter" }]);
  const blocks = await notion.mediaBlocks(id);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.id, block.id);
  assert.deepEqual({ external: blocks[1]!.external, hosted: blocks[1]!.hosted, caption: blocks[1]!.caption }, { external: "https://example.com/p2.png", hosted: null, caption: "second" });
});

test("replace_content keeps the block of a hosted line of this page's file, whatever its signature", async () => {
  const notion = new FakeNotion();
  const { id, block } = await pageWithHostedImage(notion);
  const read = (await notion.getMarkdown(id)).markdown;
  const url = /\((https:[^)]*)\)/.exec(read)![1]!;
  for (const sent of [url, url.replace(/X-Amz-Signature=\d+/, "X-Amz-Signature=stale"), url.split("?")[0]! + url.slice(url.indexOf("#")), url.split("?")[0]!]) {
    const back = await notion.replaceContent(id, `before\n![cap](${sent})\nafter`);
    assert.match(back.split("\n")[1]!, HOSTED, sent);
    const blocks = await notion.mediaBlocks(id);
    assert.deepEqual(blocks.map((b) => b.id), [block.id], sent);
    assert.notEqual(blocks[0]!.hosted, null);
  }
  // a changed caption changes only the caption; moving the line moves the block; leaving it out deletes it
  await notion.replaceContent(id, `![new](${url})\nbefore`);
  const [moved] = await notion.mediaBlocks(id);
  assert.equal(moved!.id, block.id);
  assert.equal(moved!.caption, "new");
  assert.equal((await notion.getMarkdown(id)).markdown.split("\n")[0]!.startsWith("![new]("), true);
  await notion.replaceContent(id, "before");
  assert.deepEqual(await notion.mediaBlocks(id), []);
});

test("replace_content turns a hosted line of another page's file into an empty image, and a placeholder or other https URL into an external block", async () => {
  const notion = new FakeNotion();
  const one = await pageWithHostedImage(notion);
  const two = await pageWithHostedImage(notion, bytesOf(9));
  const foreign = /\((https:[^)]*)\)/.exec((await notion.getMarkdown(one.id)).markdown)![1]!;
  const back = await notion.replaceContent(two.id, `![f](${foreign})\n![p](https://nopipeline.invalid/vault/b.png)\n![w](https://example.com/w.png)`);
  assert.deepEqual(back.split("\n"), ["![f]()", "![p](https://nopipeline.invalid/vault/b.png)", "![w](https://example.com/w.png)"]);
  const blocks = await notion.mediaBlocks(two.id);
  assert.deepEqual(blocks.map((b) => [b.external, b.hosted, b.caption]), [["", null, "f"], ["https://nopipeline.invalid/vault/b.png", null, "p"], ["https://example.com/w.png", null, "w"]]);
  assert.equal(new Set(blocks.map((b) => b.id)).size, 3);
  assert.ok(!blocks.some((b) => b.id === two.block.id));
});

test("an image alone in a list item is written as an empty item with the image as its child (checked live)", async () => {
  const notion = new FakeNotion();
  const id = notion.add("Note", "");
  const back = await notion.replaceContent(id, "- ![c](https://nopipeline.invalid/vault/a.png)\n- text\n\t- ![d](https://nopipeline.invalid/vault/b.png)\n- ![e](https://nopipeline.invalid/vault/c.png) text");
  assert.deepEqual(back.split("\n"), [
    "-",
    "\t![c](https://nopipeline.invalid/vault/a.png)",
    "- text",
    "\t-",
    "\t\t![d](https://nopipeline.invalid/vault/b.png)",
    "- ![e](https://nopipeline.invalid/vault/c.png) text",
  ]);
  assert.deepEqual((await notion.mediaBlocks(id)).map((b) => b.caption), ["c", "d"]);
  const sent = await notion.updateContent(id, [{ old_str: "- text", new_str: "- text\n- ![f](https://nopipeline.invalid/vault/f.png)" }]);
  assert.deepEqual(sent.split("\n").slice(2, 5), ["- text", "-", "\t![f](https://nopipeline.invalid/vault/f.png)"]);
  // an image line inside a code block is text
  await notion.replaceContent(id, "```\n![x](https://example.com/x.png)\n```");
  assert.deepEqual(await notion.mediaBlocks(id), []);
});

test("attaching an upload makes the block a hosted file and keeps its caption; one upload attaches to blocks of two pages", async () => {
  const notion = new FakeNotion();
  const one = notion.add("One", "![first](https://nopipeline.invalid/vault/a.png)");
  const two = notion.add("Two", "![second](https://nopipeline.invalid/vault/a.png)");
  const upload = await notion.uploadFile("a.png", bytesOf(7, 7));
  const [b1] = await notion.mediaBlocks(one);
  const [b2] = await notion.mediaBlocks(two);
  await notion.attachFile(b1!.id, "image", upload);
  await notion.attachFile(b2!.id, "image", upload);
  const m1 = HOSTED.exec((await notion.getMarkdown(one)).markdown)!;
  const m2 = HOSTED.exec((await notion.getMarkdown(two)).markdown)!;
  assert.deepEqual([m1[2], m2[2]], ["first", "second"]);
  assert.equal(m1[4], m2[4]);
  const [h1] = await notion.mediaBlocks(one);
  assert.deepEqual({ id: h1!.id, external: h1!.external, caption: h1!.caption }, { id: b1!.id, external: null, caption: "first" });
  assert.equal(h1!.hosted!.startsWith(`https://prod-files-secure.s3.us-west-2.amazonaws.com/${WORKSPACE}/${m1[4]}/a.png?X-Amz-Signature=`), true);
  await assert.rejects(notion.attachFile("no-such-block", "image", upload), NotionPageError);
  await assert.rejects(notion.attachFile(b1!.id, "image", "no-such-upload"), NotionPageError);
});

test("an upload not attached yet expires with time and is refused as Notion refuses it; one already attached still attaches (live)", async () => {
  const notion = new FakeNotion();
  const id = notion.add("One", "![a](https://nopipeline.invalid/vault/a.png)\n\n![b](https://nopipeline.invalid/vault/a.png)\n\n![c](https://nopipeline.invalid/vault/a.png)");
  const [b1, b2, b3] = await notion.mediaBlocks(id);
  const attached = await notion.uploadFile("a.png", bytesOf(1));
  const unattached = await notion.uploadFile("a.png", bytesOf(2));
  await notion.attachFile(b1!.id, "image", attached);
  notion.expireUploads();
  await notion.attachFile(b2!.id, "image", attached);
  await assert.rejects(
    notion.attachFile(b3!.id, "image", unattached),
    (e: unknown) => e instanceof NotionPageError && e.code === "validation_error" && /has an invalid status of expired\. Only uploaded files are expected\./.test(e.message),
  );
});

test("download gives the uploaded bytes for a hosted URL, from either form, and refuses any other", async () => {
  const notion = new FakeNotion();
  const { id } = await pageWithHostedImage(notion, bytesOf(5, 6, 7, 8));
  const [block] = await notion.mediaBlocks(id);
  assert.deepEqual(await notion.download(block!.hosted!), bytesOf(5, 6, 7, 8));
  const line = /\((https:[^)]*)\)/.exec((await notion.getMarkdown(id)).markdown)![1]!;
  assert.deepEqual(await notion.download(line), bytesOf(5, 6, 7, 8));
  await assert.rejects(notion.download("https://example.com/x.png"), (e: unknown) => e instanceof NotionPageError && e.code === "download_failed");
});

test("pasteImage puts a hosted image with the pasted file's name after a line, as a user pasting it would", async () => {
  const notion = new FakeNotion();
  const id = notion.add("Note", "one\ntwo");
  notion.pasteImage(id, "one", "chart_2.png", bytesOf(4, 2));
  const lines = (await notion.getMarkdown(id)).markdown.split("\n");
  assert.equal(lines[0], "one");
  assert.equal(lines[2], "two");
  const m = HOSTED.exec(lines[1]!)!;
  assert.deepEqual([m[2], m[5]], ["", "chart_2.png"]);
  const [block] = await notion.mediaBlocks(id);
  assert.equal(block!.id, m[7]);
  assert.deepEqual(await notion.download(block!.hosted!), bytesOf(4, 2));
  notion.pasteImage(id, "two", "b.png", bytesOf(1), "a caption");
  assert.deepEqual((await notion.mediaBlocks(id)).map((b) => b.caption), ["", "a caption"]);
  assert.throws(() => notion.pasteImage(id, "not a line", "c.png", bytesOf(1)), Error);
});

test("a page edited in Notion keeps the ids of the image blocks it still holds", async () => {
  const notion = new FakeNotion();
  const { id, block } = await pageWithHostedImage(notion);
  const read = (await notion.getMarkdown(id)).markdown;
  notion.edit(id, { markdown: read.replace("before", "BEFORE\nmore") });
  assert.deepEqual((await notion.mediaBlocks(id)).map((b) => b.id), [block.id]);
  assert.equal(HOSTED.test((await notion.getMarkdown(id)).markdown.split("\n")[2]!), true);
});

test("media calls are recorded", async () => {
  const notion = new FakeNotion();
  const { id } = await pageWithHostedImage(notion);
  const [block] = await notion.mediaBlocks(id);
  await notion.download(block!.hosted!);
  assert.deepEqual(notion.calls.filter((c) => /Blocks|File|download/.test(c)).map((c) => c.split(" ")[0]), ["mediaBlocks", "uploadFile", "attachFile", "mediaBlocks", "download"]);
});

test("a hosted file's name in its URL has underscores for spaces and literal parentheses (live)", async () => {
  const notion = new FakeNotion();
  const id = notion.add("Note", "![c](https://nopipeline.invalid/vault/a.png)");
  const [block] = await notion.mediaBlocks(id);
  await notion.attachFile(block!.id, "image", await notion.uploadFile("probe (1).png", bytesOf(3)));
  const line = (await notion.getMarkdown(id)).markdown;
  assert.match(line, /\/probe_\(1\)\.png\?X-Amz-Signature=\d+#notion_record=/);
  assert.equal(hostedFile(/\((.*)\)$/.exec(line)![1]!)!.name, "probe_(1).png");
  assert.match((await notion.mediaBlocks(id))[0]!.hosted!, /\/probe_\(1\)\.png\?X-Amz-Signature=\d+$/);
  assert.deepEqual(await notion.download((await notion.mediaBlocks(id))[0]!.hosted!), bytesOf(3));
  notion.pasteImage(id, line.replace(/\?X-Amz-Signature=\d+/, ""), "my pic.png", bytesOf(4));
  assert.match((await notion.getMarkdown(id)).markdown, /\/my_pic\.png\?/);
});

// PDF, file, audio and video blocks (spec §6 of the attachments design, §7.1, §7.2, §7.4 live): the same placeholder-then-switch path as an image.
const TAG_KINDS = ["pdf", "file", "audio", "video"] as const;
const NAMES = { pdf: "paper.pdf", file: "memo.docx", audio: "song.mp3", video: "clip.mp4" } as const;
const PLACEHOLDER = "https://nopipeline.invalid/vault/";
const tag = (kind: string, url: string, caption = "") => `<${kind} src="${url}">${caption}</${kind}>`;
/** A hosted tag line as a read gives it: tabs, caption, bare URL, signature number, the file uuid, the file name, the block id. */
const hostedTag = (kind: string) =>
  new RegExp(`^(\\t*)<${kind} src="(https://prod-files-secure\\.s3\\.us-west-2\\.amazonaws\\.com/${WORKSPACE}/([0-9a-f-]{36})/([^?#"]+))\\?X-Amz-Signature=(\\d+)#notion_record=block\\.([0-9a-f-]{36})\\.${WORKSPACE}">([^<]*)</${kind}>$`);

/** A page with a placeholder line of the kind, attached to an upload of the kind's file. */
async function pageWithHosted(notion: FakeNotion, kind: (typeof TAG_KINDS)[number], bytes = bytesOf(1, 2, 3), caption = "cap") {
  const id = notion.add("Note", `before\n${tag(kind, `${PLACEHOLDER}${NAMES[kind]}`, caption)}\nafter`);
  const [block] = await notion.mediaBlocks(id);
  await notion.attachFile(block!.id, kind, await notion.uploadFile(NAMES[kind], bytes));
  return { id, block: block! };
}

for (const kind of TAG_KINDS) {
  test(`the ${kind} placeholder line is an external ${kind} block with its caption; the switch makes it a hosted file that reads back signed (spec §6)`, async () => {
    const notion = new FakeNotion();
    const url = `${PLACEHOLDER}${NAMES[kind]}`;
    const id = notion.add("Note", `before\n${tag(kind, url, "cap")}\nafter`);
    assert.equal((await notion.getMarkdown(id)).markdown, `before\n${tag(kind, url, "cap")}\nafter`, "a placeholder reads back verbatim");
    const [placeholder] = await notion.mediaBlocks(id);
    assert.deepEqual({ kind: placeholder!.kind, external: placeholder!.external, hosted: placeholder!.hosted, caption: placeholder!.caption }, { kind, external: url, hosted: null, caption: "cap" });

    await notion.attachFile(placeholder!.id, kind, await notion.uploadFile(NAMES[kind], bytesOf(4, 5)));
    const first = (await notion.getMarkdown(id)).markdown.split("\n")[1]!;
    const second = (await notion.getMarkdown(id)).markdown.split("\n")[1]!;
    const a = hostedTag(kind).exec(first)!;
    const b = hostedTag(kind).exec(second)!;
    assert.ok(a && b, first);
    assert.deepEqual([a[4], a[6], a[7]], [NAMES[kind], placeholder!.id, "cap"]);
    assert.equal(a[3], b[3], "the file stays");
    assert.notEqual(a[5], b[5], "the signature changes at every read");

    const [hosted] = await notion.mediaBlocks(id);
    assert.deepEqual({ id: hosted!.id, kind: hosted!.kind, external: hosted!.external, caption: hosted!.caption }, { id: placeholder!.id, kind, external: null, caption: "cap" });
    assert.equal(hostedFile(hosted!.hosted!)!.key, a[3], "the block API names the same file");
    assert.deepEqual(await notion.download(hosted!.hosted!), bytesOf(4, 5));
  });

  test(`update_content can't find a search text with a ${kind} line, hosted or placeholder, but inserts one and edits other lines (spec §6)`, async () => {
    const notion = new FakeNotion();
    const { id, block } = await pageWithHosted(notion, kind);
    const lines = (await notion.getMarkdown(id)).markdown.split("\n");
    for (const old_str of [lines[1]!, `${lines[0]}\n${lines[1]}`, `x\n${tag(kind, `${PLACEHOLDER}x.bin`, "c")}`, `\t${tag(kind, "", "c")}`]) {
      await assert.rejects(notion.updateContent(id, [{ old_str, new_str: "x" }]), (e: unknown) => e instanceof NotionPageError && e.code === "validation_error" && e.message.startsWith("No matches found"), old_str);
    }
    const after = await notion.updateContent(id, [{ old_str: "after", new_str: `${tag(kind, `${PLACEHOLDER}second.bin`, "second")}\nAFTER` }]);
    assert.equal(after.split("\n")[3], "AFTER");
    const blocks = await notion.mediaBlocks(id);
    assert.equal(blocks[0]!.id, block.id, "the hosted block is untouched");
    assert.deepEqual({ kind: blocks[1]!.kind, external: blocks[1]!.external, caption: blocks[1]!.caption }, { kind, external: `${PLACEHOLDER}second.bin`, caption: "second" });
  });

  test(`replace_content keeps the ${kind} block of a hosted line of this page's file whatever its signature, and a foreign file's line becomes an empty ${kind} block`, async () => {
    const notion = new FakeNotion();
    const one = await pageWithHosted(notion, kind);
    const two = await pageWithHosted(notion, kind, bytesOf(9));
    const read = (await notion.getMarkdown(one.id)).markdown;
    const url = /src="([^"]*)"/.exec(read.split("\n")[1]!)![1]!;
    for (const sent of [url, url.replace(/X-Amz-Signature=\d+/, "X-Amz-Signature=stale"), url.split("?")[0]! + url.slice(url.indexOf("#")), url.split("?")[0]!]) {
      const back = await notion.replaceContent(one.id, `before\n${tag(kind, sent, "cap")}\nafter`);
      assert.match(back.split("\n")[1]!, hostedTag(kind), sent);
      const blocks = await notion.mediaBlocks(one.id);
      assert.deepEqual(blocks.map((b) => [b.id, b.kind]), [[one.block.id, kind]], sent);
      assert.notEqual(blocks[0]!.hosted, null);
    }
    // a changed caption changes only the caption; leaving the line out deletes the block
    await notion.replaceContent(one.id, tag(kind, url, "new"));
    const [moved] = await notion.mediaBlocks(one.id);
    assert.deepEqual([moved!.id, moved!.caption], [one.block.id, "new"]);

    const back = await notion.replaceContent(two.id, [tag(kind, url, "f"), tag(kind, `${PLACEHOLDER}b.bin`, "p"), tag(kind, "https://example.com/w.bin", "w")].join("\n"));
    assert.deepEqual(back.split("\n"), [tag(kind, "", "f"), tag(kind, `${PLACEHOLDER}b.bin`, "p"), tag(kind, "https://example.com/w.bin", "w")]);
    const blocks = await notion.mediaBlocks(two.id);
    assert.deepEqual(blocks.map((b) => [b.kind, b.external, b.hosted, b.caption]), [[kind, "", null, "f"], [kind, `${PLACEHOLDER}b.bin`, null, "p"], [kind, "https://example.com/w.bin", null, "w"]]);
    assert.ok(!blocks.some((b) => b.id === two.block.id));

    await notion.replaceContent(one.id, "nothing");
    assert.deepEqual(await notion.mediaBlocks(one.id), []);
  });

  test(`the ${kind} line alone in a list item is an empty item with the ${kind} block as its child (spec §7.4), found and switched like any`, async () => {
    const notion = new FakeNotion();
    const url = `${PLACEHOLDER}${NAMES[kind]}`;
    const id = notion.add("Note", "");
    const back = await notion.replaceContent(id, `- ${tag(kind, url, "c")}\n- text\n\t- ${tag(kind, `${PLACEHOLDER}d.bin`, "d")}\n- ${tag(kind, url, "e")} text`);
    assert.deepEqual(back.split("\n"), ["-", `\t${tag(kind, url, "c")}`, "- text", "\t-", `\t\t${tag(kind, `${PLACEHOLDER}d.bin`, "d")}`, `- ${tag(kind, url, "e")} text`]);
    const blocks = await notion.mediaBlocks(id);
    assert.deepEqual(blocks.map((b) => [b.kind, b.caption]), [[kind, "c"], [kind, "d"]]);
    await notion.attachFile(blocks[0]!.id, kind, await notion.uploadFile(NAMES[kind], bytesOf(1)));
    assert.match((await notion.getMarkdown(id)).markdown.split("\n")[1]!, hostedTag(kind));
    const edited = await notion.updateContent(id, [{ old_str: "- text", new_str: `- text\n- ${tag(kind, `${PLACEHOLDER}f.bin`, "f")}` }]);
    assert.deepEqual(edited.split("\n").slice(2, 5), ["- text", "-", `\t${tag(kind, `${PLACEHOLDER}f.bin`, "f")}`]);
  });

  test(`pasteFile puts a hosted ${kind} block with the pasted file's name after a line, as a user pasting it would`, async () => {
    const notion = new FakeNotion();
    const id = notion.add("Note", "one\ntwo");
    notion.pasteFile(id, "one", kind, "my file.bin", bytesOf(4, 2));
    notion.pasteFile(id, "two", kind, "b.bin", bytesOf(1), "a caption");
    const lines = (await notion.getMarkdown(id)).markdown.split("\n");
    assert.deepEqual([lines[0], lines[2], lines[4]], ["one", "two", undefined]);
    const m = hostedTag(kind).exec(lines[1]!)!;
    assert.deepEqual([m[4], m[7]], ["my_file.bin", ""]);
    const blocks = await notion.mediaBlocks(id);
    assert.deepEqual(blocks.map((b) => [b.kind, b.caption]), [[kind, ""], [kind, "a caption"]]);
    assert.equal(blocks[0]!.id, m[6]);
    assert.deepEqual(await notion.download(blocks[0]!.hosted!), bytesOf(4, 2));
    assert.throws(() => notion.pasteFile(id, "not a line", kind, "c.bin", bytesOf(1)), Error);
  });
}

test("the blocks of a page come in the order of its lines, whatever their kinds; a tag in a code block is text; a web URL's tag is an external block", async () => {
  const notion = new FakeNotion();
  const id = notion.add(
    "Note",
    [`![i](${PLACEHOLDER}a.png)`, tag("pdf", `${PLACEHOLDER}a.pdf`, "p"), "```", tag("video", `${PLACEHOLDER}x.mp4`), "```", tag("video", "https://youtu.be/x", "y"), tag("audio", `${PLACEHOLDER}a.mp3`), tag("file", `${PLACEHOLDER}a.zip`, "z")].join("\n"),
  );
  assert.deepEqual((await notion.mediaBlocks(id)).map((b) => [b.kind, b.external, b.caption]), [
    ["image", `${PLACEHOLDER}a.png`, "i"],
    ["pdf", `${PLACEHOLDER}a.pdf`, "p"],
    ["video", "https://youtu.be/x", "y"],
    ["audio", `${PLACEHOLDER}a.mp3`, ""],
    ["file", `${PLACEHOLDER}a.zip`, "z"],
  ]);
  // a web URL's tag line is ordinary text for a search; the placeholder's is not
  await notion.updateContent(id, [{ old_str: tag("video", "https://youtu.be/x", "y"), new_str: tag("video", "https://youtu.be/y", "y") }]);
  assert.equal((await notion.mediaBlocks(id))[2]!.external, "https://youtu.be/y");
  await assert.rejects(notion.updateContent(id, [{ old_str: tag("audio", `${PLACEHOLDER}a.mp3`), new_str: "x" }]), NotionPageError);
});

test("an upload attaches only to a block of its own kind (the API names the field after the block's type)", async () => {
  const notion = new FakeNotion();
  const id = notion.add("Note", `${tag("pdf", `${PLACEHOLDER}a.pdf`, "p")}\n![i](${PLACEHOLDER}a.png)`);
  const [pdf, image] = await notion.mediaBlocks(id);
  const upload = await notion.uploadFile("a.pdf", bytesOf(1));
  await assert.rejects(notion.attachFile(pdf!.id, "image", upload), (e: unknown) => e instanceof NotionPageError && e.code === "validation_error");
  await assert.rejects(notion.attachFile(image!.id, "pdf", upload), NotionPageError);
  assert.deepEqual((await notion.mediaBlocks(id)).map((b) => b.hosted), [null, null], "nothing changed");
  await notion.attachFile(pdf!.id, "pdf", upload);
  assert.notEqual((await notion.mediaBlocks(id))[0]!.hosted, null);
});

test("a page edited in Notion keeps the ids of the PDF, file, audio and video blocks it still holds", async () => {
  const notion = new FakeNotion();
  const { id, block } = await pageWithHosted(notion, "pdf");
  const read = (await notion.getMarkdown(id)).markdown;
  notion.edit(id, { markdown: read.replace("before", "BEFORE\nmore") });
  assert.deepEqual((await notion.mediaBlocks(id)).map((b) => b.id), [block.id]);
  assert.equal(hostedTag("pdf").test((await notion.getMarkdown(id)).markdown.split("\n")[2]!), true);
});

test("a caption with escapes reads back unescaped in the block, as Notion keeps the line", async () => {
  const notion = new FakeNotion();
  const id = notion.add("Note", tag("pdf", `${PLACEHOLDER}a.pdf`, "a \\[b\\] c"));
  assert.equal((await notion.mediaBlocks(id))[0]!.caption, "a [b] c");
});

test("downloadTo writes the hosted bytes to the path and gives their sha256 and size, refuses a path that exists, and refuses a URL that isn't a hosted file", async () => {
  const notion = new FakeNotion();
  const { id } = await pageWithHosted(notion, "video", bytesOf(5, 6, 7, 8));
  const [block] = await notion.mediaBlocks(id);
  const dir = await mkdtemp(join(tmpdir(), "nopipeline-fake-"));
  try {
    const path = join(dir, "clip.mp4");
    assert.deepEqual(await notion.downloadTo(block!.hosted!, path), { sha256: createHash("sha256").update(bytesOf(5, 6, 7, 8)).digest("hex"), size: 4 });
    assert.deepEqual(new Uint8Array(await readFile(path)), bytesOf(5, 6, 7, 8));
    await assert.rejects(notion.downloadTo(block!.hosted!, path), (e: unknown) => (e as NodeJS.ErrnoException).code === "EEXIST");
    await writeFile(join(dir, "taken"), "mine");
    await assert.rejects(notion.downloadTo("https://example.com/x.mp4", join(dir, "other.mp4")), (e: unknown) => e instanceof NotionPageError && e.code === "download_failed");
    assert.deepEqual((await readdir(dir)).sort(), ["clip.mp4", "taken"], "a refusal leaves no file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the fake refuses an upload of a content type it was told to refuse, as Notion refuses .3gp, and takes the others", async () => {
  const notion = new FakeNotion();
  notion.refusedTypes.add("audio/3gpp");
  await assert.rejects(
    notion.uploadFile("clip.3gp", bytesOf(1)),
    (e: unknown) => e instanceof NotionPageError && e.code === "validation_error" && /The content type audio\/3gpp is not supported for the File Upload API/.test(e.message),
  );
  assert.equal(typeof (await notion.uploadFile("clip.mp3", bytesOf(1))), "string");
  assert.equal(typeof (await notion.uploadFile("a.png", bytesOf(1))), "string");
  notion.refusedTypes.clear();
  assert.equal(typeof (await notion.uploadFile("clip.3gp", bytesOf(1))), "string");
});

// Projects: the fake keeps the order of the relation (checked live), hides a trashed project everywhere, and
// lists 25 entries per page like the query does for "Links to" (live).

test("the fake keeps a page's projects in the order they were written, in the listing, the reads and projectsOf", async () => {
  const notion = new FakeNotion();
  const [p1, p2, p3] = [notion.addProject("One"), notion.addProject("Two"), notion.addProject("Three")];
  const id = await notion.createPage({ title: "Note", projects: [p3, p1] });
  assert.deepEqual(notion.projectsOf(id), [p3, p1]);
  assert.deepEqual((await notion.listPages())[0]!.projects, { ids: [p3, p1], more: false });
  await notion.setProjects(id, [p2, p3, p1]);
  assert.deepEqual(await notion.readProjects(id), [p2, p3, p1]);
  assert.deepEqual(notion.projectsOf(id), [p2, p3, p1]);
  assert.deepEqual(notion.projectList().map((p) => p.title), ["One", "Two", "Three"]);
  assert.deepEqual((await notion.listPages())[0]!.folder, null);
});

test("a trashed project disappears from every page's relation and from the projects list", async () => {
  const notion = new FakeNotion();
  const [a, b] = [notion.addProject("A"), notion.addProject("B")];
  const id = notion.add("Note", "", [a, b]);
  notion.editProject(a, { inTrash: true });
  assert.deepEqual((await notion.listPages())[0]!.projects, { ids: [b], more: false });
  assert.deepEqual(await notion.readProjects(id), [b]);
  assert.deepEqual(notion.projectsOf(id), [b]);
  assert.deepEqual(await notion.listProjects(), [{ id: b, title: "B" }]);
  notion.editProject(a, { inTrash: false });
  assert.deepEqual(notion.projectsOf(id), [a, b]);
});

test("the listing shows 25 projects with more: true; readProjects returns all of them", async () => {
  const notion = new FakeNotion();
  const projects = Array.from({ length: 30 }, (_, n) => notion.addProject(`P${n}`));
  const id = notion.add("Note", "", projects);
  const [listed] = await notion.listPages();
  assert.deepEqual(listed!.projects, { ids: projects.slice(0, 25), more: true });
  assert.deepEqual(await notion.readProjects(id), projects);
});

test("createProject records the template it was created from; renameProject renames; no projects relation: no projects listed, no source", async () => {
  const notion = new FakeNotion();
  const blank = await notion.createProject("Blank");
  notion.defaultTemplate = true;
  const templated = await notion.createProject("Templated");
  assert.equal(notion.projectPages.get(blank)!.template, "none");
  assert.equal(notion.projectPages.get(templated)!.template, "default");
  await notion.renameProject(blank, "Renamed");
  assert.deepEqual(notion.projectList().map((p) => p.title), ["Renamed", "Templated"]);
  assert.deepEqual(await notion.projectsSource(), { dataSourceId: notion.projectsDataSourceId, titleProperty: "Name" });
  notion.add("Note", "");
  notion.projectsRelation = null;
  assert.equal("projects" in (await notion.listPages())[0]!, false);
  assert.equal(await notion.projectsSource(), null);
});

test("setTitle renames a page and leaves its projects alone", async () => {
  const notion = new FakeNotion();
  const p = notion.addProject("P");
  const id = notion.add("Old", "text", [p]);
  await notion.setTitle(id, "New");
  assert.equal((await notion.listPages())[0]!.title, "New");
  assert.deepEqual(notion.projectsOf(id), [p]);
});

test("the fake lists tags only once the database has the Tags property, and setTags moves the page's edit time", async () => {
  let clock = Date.parse("2026-11-06T10:00:00Z");
  const notion = new FakeNotion(() => new Date(clock));
  const a = notion.add("A", "body of A");
  const b = notion.add("B", "body of B");
  assert.equal("tags" in (await notion.listPages())[0]!, false);
  notion.addTags();
  assert.deepEqual((await notion.listPages()).map((p) => p.tags), [[], []]);
  clock += 5 * 60_000;
  const before = new Map((await notion.listPages()).map((p) => [p.id, p.lastEditedTime]));
  await notion.setTags(a, ["x", "Y"]);
  const after = await notion.listPages();
  assert.deepEqual(after.find((p) => p.id === a)!.tags, ["x", "Y"]);
  assert.notEqual(after.find((p) => p.id === a)!.lastEditedTime, before.get(a));
  assert.equal(after.find((p) => p.id === b)!.lastEditedTime, before.get(b));
  assert.equal((await notion.getMarkdown(a)).markdown, "body of A");
  notion.edit(b, { tags: ["z"] });
  assert.deepEqual((await notion.listPages()).find((p) => p.id === b)!.tags, ["z"]);
  assert.deepEqual(notion.calls.filter((c) => c.startsWith("setTags")), [`setTags ${a}`]);
});

test("a cut page reads whole, like the live API's tag lines and blocks fetched one by one (probe 2026-11-06)", async () => {
  const notion = new FakeNotion();
  const id = notion.add("Big", "p0\np1\n- item\n\t- child\n\t\t- grand\np2");
  notion.cut(id, [1, 3]);
  const raw = notion.rawMarkdown(id);
  const hex = id.replace(/-/g, "");
  assert.equal(raw.truncated, true);
  assert.equal(raw.unknown_block_ids.length, 2);
  const [one, two] = raw.unknown_block_ids.map((block) => block.replace(/-/g, ""));
  assert.match(raw.unknown_block_ids[0]!, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(raw.markdown, `p0\n<unknown url="https://app.notion.com/p/${hex}#${one}"/>\n- item\n\t<unknown url="https://app.notion.com/p/${hex}#${two}"/>\np2`);
  assert.deepEqual(notion.blockMarkdown(raw.unknown_block_ids[0]!), { markdown: "p1", truncated: false, unknown_block_ids: [] });
  assert.deepEqual(notion.blockMarkdown(raw.unknown_block_ids[1]!), { markdown: "- child\n\t- grand", truncated: false, unknown_block_ids: [] });
  // The gateway completes it.
  assert.deepEqual(await notion.getMarkdown(id), { markdown: "p0\np1\n- item\n\t- child\n\t\t- grand\np2", truncated: false, pieced: true, loaded: raw.markdown });
});

test("a cut inside a left-out block shows in its subtree only; a block that can't be fetched leaves the page truncated", async () => {
  const notion = new FakeNotion();
  const id = notion.add("Big", "- a\n\t- b\n\t\t- c\nz");
  notion.cut(id, [0, 2]);
  const raw = notion.rawMarkdown(id);
  assert.equal(raw.unknown_block_ids.length, 1, "the nested block hides under the outer one");
  const sub = notion.blockMarkdown(raw.unknown_block_ids[0]!);
  assert.equal(sub.unknown_block_ids.length, 1);
  assert.match(sub.markdown, /^- a\n\t- b\n\t\t<unknown url="https:\/\/app\.notion\.com\/p\/[0-9a-f]{32}#[0-9a-f]{32}"\/>$/);
  assert.equal((await notion.getMarkdown(id)).markdown, "- a\n\t- b\n\t\t- c\nz");
  notion.cut(id, [0, 3], [3]);
  const partial = await notion.getMarkdown(id);
  assert.equal(partial.truncated, true);
  assert.equal("pieced" in partial, false);
  assert.match(partial.markdown, /^<unknown [^\n]*\/>\n<unknown [^\n]*\/>$/, "both stay as tag lines, as Notion gave them");
  assert.throws(() => notion.blockMarkdown("00000000-0000-4000-8000-000000000000"), (e: unknown) => e instanceof NotionPageError && e.code === "object_not_found");
});

test("a page that isn't cut reads as before, with no pieced key", async () => {
  const notion = new FakeNotion();
  const id = notion.add("Small", "a\nb");
  assert.deepEqual(await notion.getMarkdown(id), { markdown: "a\nb", truncated: false });
  notion.edit(id, { truncated: true });
  assert.deepEqual(await notion.getMarkdown(id), { markdown: "a\nb", truncated: true });
});

test("a cut page's edits search only the part Notion loads, as Notion does", async () => {
  const notion = new FakeNotion();
  const id = notion.add("Big", "intro\n- one\n\t- child\nend");
  notion.cut(id, [2]);
  await assert.rejects(notion.updateContent(id, [{ old_str: "- child", new_str: "- kid" }]), (e: unknown) => e instanceof NotionPageError && e.code === "validation_error");
  assert.equal(notion.pages.get(id)!.markdown, "intro\n- one\n\t- child\nend");
  await notion.updateContent(id, [{ old_str: "intro", new_str: "start" }]);
  assert.equal(notion.pages.get(id)!.markdown, "start\n- one\n\t- child\nend");
});
