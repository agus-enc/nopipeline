import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmed, mergeResult, noteKeepsAll, pageKeepsAll, pullResult, pushResult, sayTheSame, updateEmbedsResult } from "../../src/run/content.ts";
import { toNotion } from "../../src/translate/index.ts";
import type { SyncRecord } from "../../src/types.ts";
import { mediaOf } from "../../src/vault/images.ts";
import { elmUrl, OUTSIDE, soupUrl, testContext } from "../helpers/context.ts";
import { asNotionKeeps } from "../helpers/fake-notion.ts";

const ctx = testContext();
const record = (body: string, markdown: string): SyncRecord => ({
  notionId: "n",
  path: "Notes/Current.md",
  title: "Current",
  folder: "Notes",
  obsidianText: `---\nnotion-id: n\n---\n${body}`,
  notionMarkdown: markdown,
  notionSeenAt: "2026-09-27T04:00:00.000Z",
  syncedAt: "2026-09-27T04:00:00.000Z",
});

test("a push rewrites only the edited line and keeps Notion-only layout", () => {
  const r = record("# Title\n\n- one\n- two\n", "# Title\n- one\n- two");
  const current = '# Title {color="blue"}\n<columns>\n\t<column>\n\t\t- one\n\t\t- two\n\t</column>\n</columns>';
  assert.equal(pushResult(r, "# Title\n\n- one\n- two, edited\n", current, ctx), '# Title {color="blue"}\n<columns>\n\t<column>\n\t\t- one\n\t\t- two, edited\n\t</column>\n</columns>');
});

test("a push turns new wikilinks into page links", () => {
  const r = record("Intro\n", "Intro");
  assert.equal(pushResult(r, "Intro\n\nSee [[Elm]]\n", "Intro", ctx), `Intro\nSee [Elm](${elmUrl})`);
});

test("a pull keeps Obsidian-only syntax and formatting on lines Notion didn't touch", () => {
  const body = "Paragraph with a block id ^keep1\n\n*   bullet written with a star\n\nLast line\n";
  const r = record(body, "Paragraph with a block id \\^keep1\n- bullet written with a star\nLast line");
  assert.equal(pullResult(r, body, "Paragraph with a block id \\^keep1\n- bullet written with a star\nLast line, edited in Notion", ctx), "Paragraph with a block id ^keep1\n\n*   bullet written with a star\n\nLast line, edited in Notion\n");
  // A note saved with Windows line endings gets the same lines back.
  const crlf = body.replace(/\n/g, "\r\n");
  assert.equal(pullResult(record(crlf, r.notionMarkdown), crlf, "Paragraph with a block id \\^keep1\n- bullet written with a star\nLast line, edited in Notion", ctx), "Paragraph with a block id ^keep1\n\n*   bullet written with a star\n\nLast line, edited in Notion\n");
});

test("a merge takes edits from both sides when they touch different lines", () => {
  const r = record("A\n\nB\n\nC\n", "A\nB\nC");
  const result = mergeResult(r, "A, from Obsidian\n\nB\n\nC\n", "A\nB\nC, from Notion", ctx);
  assert.deepEqual(result, { body: "A, from Obsidian\n\nB\n\nC, from Notion\n", conflicted: false, notionVersion: "A\n\nB\n\nC, from Notion\n", whole: false });
  assert.deepEqual(mergeResult(r, "A, from Obsidian\r\n\r\nB\r\n\r\nC\r\n", "A\nB\nC, from Notion", ctx), result);
});

test("a merge keeps Obsidian's text when both sides edited the same line", () => {
  const r = record("A\n\nB\n", "A\nB");
  const result = mergeResult(r, "A\n\nB from Obsidian\n", "A\nB from Notion", ctx);
  assert.equal(result.body, "A\n\nB from Obsidian\n");
  assert.equal(result.conflicted, true);
  assert.equal(result.notionVersion, "A\n\nB from Notion\n");
});

test("a line pulled from Notion keeps the note's own form of its links", () => {
  const body = "See [the bark notes](Elm.md#Bark) and [[Elm#^abc123|that block]] now\n\n[x](Grove/Elm.md#Bark), [Elm](Grove/Elm.md) and [Elm](Elm.md) here\n\n![[Grove/Elm|Elm]] and [Elm](Elm.md) stay\n";
  const r = record(body, toNotion(body, ctx));
  const edited = r.notionMarkdown.replace(" now", " today").replace(" here", " there").replace(" stay", " stay put");
  // An embed of a note on a line edited in Notion comes back as the link its mention reads as (the page holds no `!` before it).
  const pulled = body.replace(" now", " today").replace(" here", " there").replace("![[Grove/Elm|Elm]] and [Elm](Elm.md) stay", "[Elm](Elm.md) and [Elm](Elm.md) stay put");
  assert.equal(pullResult(r, body, edited, ctx), pulled);
  // A link whose visible text Notion changed takes Notion's form.
  const renamed = r.notionMarkdown.replace("[the bark notes]", "[its bark notes]");
  assert.equal(pullResult(r, body, renamed, ctx), body.replace("[the bark notes](Elm.md#Bark)", "[its bark notes](Elm.md)"));
  // A [[link]] on the note's line comes back as a Markdown link.
  const wiki = "See [[Grove/Elm|Elm]] and [[Elm|shadowed]] now\n";
  const w = record(wiki, toNotion(wiki, ctx));
  assert.equal(pullResult(w, wiki, w.notionMarkdown.replace(" now", " today"), ctx), "See [Elm](Elm.md) and [shadowed](Elm.md) today\n");
  // The same holds for Notion's version in a merge.
  assert.equal(mergeResult(r, body, edited, ctx).notionVersion, pulled);
});

test("a placed edit is kept only when the other app reads it as the edited text", () => {
  const view = (text: string) => text;
  // Placed on its own line: confirmed. Placed on another line that says the same before the edit: refused.
  assert.equal(confirmed("A\nB\nA", "A\nB\nA2", "A\nB\nA", "A\nB\nA2", view), true);
  assert.equal(confirmed("A\nB\nA", "A\nB\nA2", "A\nB\nA", "A2\nB\nA", view), false);
  // A difference the target already had stays, next to the edit too; overlapping ones refuse.
  assert.equal(confirmed("x\nA\nB", "x\nA\nB2", "y\nA\nB", "y\nA\nB2", view), true);
  assert.equal(confirmed("A\nB", "A\nB2", "A\nB3", "A\nB2", view), false);
});

test("a whole rewrite is allowed only when that side has nothing the other app can't hold", () => {
  // The page as Notion keeps it for the note.
  const page = (body: string) => asNotionKeeps(toNotion(body, ctx));
  assert.equal(noteKeepsAll("# Title\n\n- one\n- two\n\n```python\nx = 1\n```\n", page("# Title\n\n- one\n- two\n\n```python\nx = 1\n```\n"), ctx), true);
  for (const body of ["* star bullet\n", "Hard  \nbreak\n", "$$ E = mc^2 $$\n", "See [[Elm#Bark|the bark notes]]\n", "> [!recipe]+ Soup\n> Stir\n", "##### Five\n", "| a |\n|:--|\n| b |\n"]) {
    assert.equal(noteKeepsAll(body, page(body), ctx), false, body);
  }
  assert.equal(pageKeepsAll("Title\n- one\n- two\n>\n\t```python\nx = 1\n\t```", ctx), true);
  // Notion writes a table's rows and cells flush left; the translator indents them.
  assert.equal(pageKeepsAll('<table header-row="true">\n<tr>\n<td>a</td>\n<td>b</td>\n</tr>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</table>', ctx), true);
  for (const page of [
    'Text {color="blue"}',
    '<mention-date start="2026-09-01"/> started',
    "Ask <mention-user url=\"user://a\">Ana</mention-user>",
    '<callout icon="🚀">\n\tText\n</callout>',
    '## Details {toggle="true"}\n\tHidden',
    "<columns>\n\t<column>\n\t\tLeft\n\t</column>\n</columns>",
    "<table_of_contents/>",
    '<video src="https://example.com/v.mp4">Demo</video>',
    '<unknown url="https://example.com" alt="bookmark"/>',
    // A blank line typed in Notion: a note has no place for it (final review, third round N4).
    "Title\n<empty-block/>\nText",
  ]) {
    assert.equal(pageKeepsAll(page, ctx), false, page);
  }
});

test("a note and a page that say the same thing are recognized whatever form each app writes it in", () => {
  // Plain text, star bullets, a quoted code block in Notion's own form, a date mention, an anchored alias.
  assert.equal(sayTheSame("Alpha\n\nBeta, edited\n", "Alpha\nBeta, edited", ctx), true);
  assert.equal(sayTheSame("* one\n* two, edited\n", "- one\n- two, edited", ctx), true);
  assert.equal(sayTheSame("> ```python\n> i = 0\n>     i += 2\n> ```\n", ">\n\t```python\ni = 0\n    i += 2\n\t```", ctx), true);
  assert.equal(sayTheSame("- 2026-09-01 started late\n", '- <mention-date start="2026-09-01"/> started late', ctx), true);
  assert.equal(sayTheSame("See [[Elm#Bark|the bark notes]] now\n", `See [the bark notes](${elmUrl}) now`, ctx), true);
  // A one-line formula reads as the formula; Notion-only layout holds no text.
  assert.equal(sayTheSame("$$ E = mc^3 $$\n", "$$\nE = mc^3\n$$", ctx), true);
  assert.equal(sayTheSame("Text\n", 'Text {color="red"}\n<empty-block/>\n<table_of_contents/>', ctx), true);
  // Any difference in what they say counts.
  assert.equal(sayTheSame("Alpha\n", "Alpha, edited", ctx), false);
  assert.equal(sayTheSame("> ```python\n>     i += 2\n> ```\n", ">\n\t```python\ni += 2\n\t```", ctx), false);
  assert.equal(sayTheSame("Text\n", 'Text\n<video src="https://example.com/v.mp4">Demo</video>', ctx), false);
});

test("a note and a page say the same only when their nesting, escapes, code lines and blocks agree too (final review, third round N1)", () => {
  // Nesting: the same lines nested differently say something else.
  assert.equal(sayTheSame("- a\n\t- b\n- c\n", "- a\n- b\n- c", ctx), false);
  assert.equal(sayTheSame("- a\n- b\n- c\n", "- a\n- b\n\t- c", ctx), false);
  assert.equal(sayTheSame("- a\n\t- b\n- c\n", "- a\n- b\n\t- c", ctx), false);
  assert.equal(sayTheSame("- a\n\t- b\n- c\n", "- a\n\t- b\n- c", ctx), true);
  // Notion's own nesting a note can't hold (columns, a toggle heading's lines) still reads as the note shows it.
  assert.equal(sayTheSame("Left\n\nRight\n", "<columns>\n\t<column>\n\t\tLeft\n\t</column>\n\t<column>\n\t\tRight\n\t</column>\n</columns>", ctx), true);
  assert.equal(sayTheSame("## Details\n\nHidden\n", '## Details {toggle="true"}\n\tHidden', ctx), true);
  assert.equal(sayTheSame("- step\n\t```go\n\tfunc f() {\n\t\treturn\n\t}\n\t```\n", "- step\n\t```go\nfunc f() {\n\treturn\n}\n\t```", ctx), true);
  // Code lines count exactly: a prompt marker is code, not a quote marker.
  assert.equal(sayTheSame("```python\n>>> print(x)\n```\n", "```python\nprint(x)\n```", ctx), false);
  assert.equal(sayTheSame("> ```python\n> >>> print(x)\n> ```\n", ">\n\t```python\nprint(x)\n\t```", ctx), false);
  assert.equal(sayTheSame("> ```python\n> >>> print(x)\n> ```\n", ">\n\t```python\n>>> print(x)\n\t```", ctx), true);
  // An escape that keeps text from being emphasis, a heading or a list says something else.
  assert.equal(sayTheSame("\\*not italic\\*\n", "*not italic*", ctx), false);
  assert.equal(sayTheSame("\\# Not a heading\n", "# Not a heading", ctx), false);
  assert.equal(sayTheSame("1\\. Not a list\n", "1. Not a list", ctx), false);
  // One paragraph of two lines is not two paragraphs.
  assert.equal(sayTheSame("Alpha\nBeta\n", "Alpha\nBeta", ctx), false);
  assert.equal(sayTheSame("Alpha\nBeta\n", "Alpha<br>Beta", ctx), true);
});

test("forms only Notion writes, or writes its own way, read as the note shows them (final review, third round N2)", () => {
  // Code block languages under Notion's names (live probe).
  for (const info of ["js", "", "Build log, part 2", "zsh"]) assert.equal(sayTheSame(`\`\`\`${info}\nlet x = 1\n\`\`\`\n`, "```javascript\nlet x = 1\n```", ctx), true, info);
  assert.equal(sayTheSame("```Bash\necho\n```\n", "```bash\necho\n```", ctx), true);
  assert.equal(sayTheSame("```js\nlet x = 1\n```\n", "```python\nlet x = 1\n```", ctx), false);
  // Literal `*`, `_` and `~`, `_` emphasis, and backslashes that change nothing, written Notion's way.
  assert.equal(sayTheSame("2 * 3 and x ~ y\n", "2 \\* 3 and x \\~ y", ctx), true);
  assert.equal(sayTheSame("snake\\_case and C\\# here\n", "snake_case and C# here", ctx), true);
  assert.equal(sayTheSame("_italic_ and __bold__\n", "*italic* and **bold**", ctx), true);
  // Notion-only blocks and mentions read as the note shows them; a callout's own icon is Notion's.
  const titles = new Map([[OUTSIDE, "Outside page"]]);
  const outside = `https://app.notion.com/p/${OUTSIDE.replace(/-/g, "")}`;
  assert.equal(sayTheSame(`See [Outside page](${outside}) here\n`, `See <mention-page url="${outside}"/> here`, { ...ctx, titles }), true);
  assert.equal(sayTheSame("[bookmark](https://example.com)\n", '<unknown url="https://example.com" alt="bookmark"/>', ctx), true);
  assert.equal(sayTheSame(`[📄 Sub page](${outside})\n`, `<page url="${outside}">Sub page</page>`, ctx), true);
  assert.equal(sayTheSame(`[🗃 Tasks](${outside})\n`, `<database url="${outside}">Tasks</database>`, ctx), true);
  assert.equal(sayTheSame(`[🔁 Synced block](${outside})\n`, `<synced_block url="${outside}">\n\tShared text\n</synced_block>`, ctx), true);
  assert.equal(sayTheSame("> [!note]\n> Text\n", '<callout icon="🚀">\n\tText\n</callout>', ctx), true);
  // A nested code block whose every line starts with a tab, which Notion keeps flush left.
  assert.equal(sayTheSame("- step\n\t```python\n\t\treturn y\n\t\tpass\n\t```\n", "- step\n\t```python\n\treturn y\n\tpass\n\t```", ctx), true);
});

test("a note and a page agree only when Notion would hold the same thing too (final review, fourth round P1)", () => {
  // Nested code one tab deeper on every line than Notion holds it, under a list item, in a quote and in a callout.
  assert.equal(sayTheSame("- step\n\t```python\n\t\treturn x\n\t\tpass\n\t```\n", "- step\n\t```python\nreturn x\npass\n\t```", ctx), false);
  assert.equal(sayTheSame("> ```python\n> \tx = 1\n> \ty = 2\n> ```\n", ">\n\t```python\nx = 1\ny = 2\n\t```", ctx), false);
  assert.equal(sayTheSame("> [!note] T\n> ```python\n> \tx = 1\n> ```\n", '<callout icon="📝">\n\t**T**\n\t```python\nx = 1\n\t```\n</callout>', ctx), false);
  assert.equal(sayTheSame("- install\n\t```bash\n\tnpm install\n\t```\n", "- install\n\t```bash\n\tnpm install\n\t```", ctx), false);
  // The same code is the same, a block Notion keeps with every line tab-led included (third round N3).
  assert.equal(sayTheSame("- step\n\t```python\n\t\treturn y\n\t\tpass\n\t```\n", "- step\n\t```python\n\treturn y\n\tpass\n\t```", ctx), true);
  assert.equal(sayTheSame("> ```python\n> x = 1\n> ```\n", ">\n\t```python\nx = 1\n\t```", ctx), true);
  // A link's text written as text is not the link: escaped against a mention, and against a link.
  assert.equal(sayTheSame("See \\[\\[Elm\\]\\] here\n", `See <mention-page url="${elmUrl}"/> here`, ctx), false);
  assert.equal(sayTheSame("See \\[the bark notes\\](https://example.com) here\n", "See [the bark notes](https://example.com) here", ctx), false);
  // A [[link]] to a note that doesn't exist yet is the escaped text Notion holds for it.
  assert.equal(sayTheSame("See [[Missing note]] here\n", "See \\[\\[Missing note\\]\\] here", ctx), true);
  // Pipes Notion holds escaped are text, not a table.
  const table = 'Text\n<table header-row="true">\n<tr>\n<td>Name</td>\n<td>Value</td>\n</tr>\n<tr>\n<td>a</td>\n<td>b</td>\n</tr>\n</table>';
  assert.equal(sayTheSame("Text\n\n\t| Name | Value |\n| --- | --- |\n| a | b |\n", table, ctx), false);
  assert.equal(sayTheSame("Text\n\n| Name | Value |\n| --- | --- |\n| a | b |\n", table, ctx), true);
});

test("a link Notion makes of a bare URL, an email or a domain-like word reads as the word (live probe)", () => {
  assert.equal(sayTheSame("See https://example.com/path, me@example.com and script.py here\n", "See [https://example.com/path](https://example.com/path), [me@example.com](mailto:me@example.com) and [script.py](http://script.py) here", ctx), true);
  assert.equal(sayTheSame("See www.example.com/~user\n", "See [www.example.com/\\~user](http://www.example.com/~user)", ctx), true);
  // A link with other text, or another target, is a link.
  assert.equal(sayTheSame("See script.py here\n", "See [script.py](http://other.py) here", ctx), false);
  assert.equal(sayTheSame("See script here\n", "See [script](http://script) here", ctx), false, "not a word Notion links");
});

test("a note's Markdown link to a note and the page's link to its page say the same (Markdown links design §6.6)", () => {
  // Any path that resolves to the note is the same link; the text is what shows, so other text is another line.
  assert.equal(sayTheSame("See [Elm](Grove/Elm.md) here\n", `See [Elm](${elmUrl}) here`, ctx), true);
  assert.equal(sayTheSame("See [Elm](Elm.md) here\n", `See [Elm](${elmUrl}) here`, ctx), true);
  assert.equal(sayTheSame("See [Elm](Grove/Elm.md) here\n", `See [Shadowed](${elmUrl}) here`, ctx), false);
  assert.equal(sayTheSame("See [Elm](Grove/Elm.md) here\n", `See [Elm](${soupUrl}) here`, ctx), false);
});

test("a link Notion holds as one link per run of its text says what the note's one link says, and nothing else does", () => {
  const split = `See [a ](${elmUrl})[**b**](${elmUrl})[ c](${elmUrl}) here`;
  assert.equal(sayTheSame("See [a **b** c](Elm.md) here\n", split, ctx), true);
  assert.equal(sayTheSame("See [`__slots__` attribute](Elm.md) here\n", `See [\`__slots__\`](${elmUrl})[ attribute](${elmUrl}) here`, ctx), true);
  // Read exactly, the join merges nothing else: other formatting, literal stars or backticks, a space between the
  // links, another page, or a link's text Notion holds as text each say something else.
  assert.equal(sayTheSame("See [a b c](Elm.md) here\n", split, ctx), false);
  assert.equal(sayTheSame("See [a \\*\\*b\\*\\* c](Elm.md) here\n", split, ctx), false);
  assert.equal(sayTheSame("See [\\`__slots__\\` attribute](Elm.md) here\n", `See [\`__slots__\`](${elmUrl})[ attribute](${elmUrl}) here`, ctx), false);
  assert.equal(sayTheSame("See [a **b** c](Elm.md) here\n", `See [a ](${elmUrl}) [**b**](${elmUrl})[ c](${elmUrl}) here`, ctx), false);
  assert.equal(sayTheSame("See [a ](Elm.md) [**b** c](Elm.md) here\n", `See [a ](${elmUrl}) [**b**](${elmUrl})[ c](${elmUrl}) here`, ctx), true);
  assert.equal(sayTheSame("See [a **b** c](Elm.md) here\n", `See [a ](${elmUrl})[**b**](${soupUrl})[ c](${elmUrl}) here`, ctx), false);
  assert.equal(sayTheSame("See [ab](Elm.md) here\n", `See \\[a\\](${elmUrl})[b](${elmUrl}) here`, ctx), false);
});

// The first run adds the images already synced (spec §5.11).
const DIR = "Assets/pictures";
const BASE = `https://nopipeline.invalid/vault/${DIR}`;
const imageCtx = { ...testContext("Cookbook/x.md"), media: mediaOf([`${DIR}/whisk.png`, `${DIR}/oven.png`], DIR) };
const old = (body: string, markdown: string): SyncRecord => ({ ...record(body, markdown), path: "Cookbook/x.md" });

test("updateEmbedsResult turns the record's escaped citations into image lines and touches nothing else", () => {
  const r = old("Intro\n\n![[whisk.png]]\n\nOutro, with a * star\n", "Intro\n!\\[\\[whisk.png\\]\\]\nOutro, with a \\* star");
  assert.equal(updateEmbedsResult(r, imageCtx), `Intro\n![](${BASE}/whisk.png)\nOutro, with a \\* star`);
});

test("updateEmbedsResult keeps the caption, handles list items and an image sharing a paragraph with text", () => {
  const r = old(
    "Text\n![[whisk.png|a _cap_]]\nmore\n\n- ![[oven.png]]\n1. ![](oven.png)\n",
    "Text<br>!\\[\\[whisk.png\\|a \\_cap\\_\\]\\]<br>more\n- !\\[\\[oven.png\\]\\]\n1. !\\[\\[oven.png\\]\\]",
  );
  assert.equal(updateEmbedsResult(r, imageCtx), `Text\n![a *cap*](${BASE}/whisk.png)\nmore\n-\n\t![](${BASE}/oven.png)\n1.\n\t![](${BASE}/oven.png)`);
});

test("updateEmbedsResult makes the image that ends an item or a quote its child and leaves the rest of the page as Notion holds it", () => {
  const item = old("- item\n![[whisk.png]]\n- two\n", "- item<br>!\\[\\[whisk.png\\]\\]\n- two edited");
  assert.equal(updateEmbedsResult(item, imageCtx), `- item\n\t![](${BASE}/whisk.png)\n- two edited`);
  const quote = old("> text\n> ![[whisk.png]]\n\nOutro\n", "> text<br>!\\[\\[whisk.png\\]\\]\nOutro, edited");
  assert.equal(updateEmbedsResult(quote, imageCtx), `> text\n\t![](${BASE}/whisk.png)\nOutro, edited`);
  // A quote written with a blank `>` line keeps the empty part beside the citation: it still gets its image.
  const blank = old("> text\n>\n> ![[whisk.png]]\n", "> text<br><br>!\\[\\[whisk.png\\]\\]");
  assert.equal(updateEmbedsResult(blank, imageCtx), `> text\n\t![](${BASE}/whisk.png)`);
  // An image that doesn't end the item, a quote of only images, and a file that isn't in the vault change nothing.
  assert.equal(updateEmbedsResult(old("- item\n![[whisk.png]]\nmore\n", "- item<br>!\\[\\[whisk.png\\]\\]<br>more"), imageCtx), null);
  assert.equal(updateEmbedsResult(old("> ![[whisk.png]]\n> ![[oven.png]]\n", "> !\\[\\[whisk.png\\]\\]<br>!\\[\\[oven.png\\]\\]"), imageCtx), null);
  assert.equal(updateEmbedsResult(old("- item\n![[gone.png]]\n", "- item<br>!\\[\\[gone.png\\]\\]"), imageCtx), null);
});

test("updateEmbedsResult leaves out the changes that are not image citations becoming images", () => {
  // Notion wrote the second line differently than the translator does; that difference is not ours to apply.
  const r = old("Intro\n\n![[whisk.png]]\n\nsee ~~a~~ b\n", "Intro\n!\\[\\[whisk.png\\]\\]\nsee <s>a</s> b");
  assert.equal(updateEmbedsResult(r, imageCtx), `Intro\n![](${BASE}/whisk.png)\nsee <s>a</s> b`);
});

test("updateEmbedsResult is null where no citation becomes an image", () => {
  // Already an image line, a quote (Notion holds no image there), a citation sharing a line with text, a file that isn't in the vault, and an empty record.
  assert.equal(updateEmbedsResult(old("![[whisk.png]]\n", `![](${BASE}/whisk.png)`), imageCtx), null);
  assert.equal(updateEmbedsResult(old("> ![[whisk.png]]\n", "> !\\[\\[whisk.png\\]\\]"), imageCtx), null);
  assert.equal(updateEmbedsResult(old("see ![[whisk.png]] here\n", "see !\\[\\[whisk.png\\]\\] here"), imageCtx), null);
  assert.equal(updateEmbedsResult(old("![[missing.png]]\n", "!\\[\\[missing.png\\]\\]"), imageCtx), null);
  assert.equal(updateEmbedsResult(old("", ""), imageCtx), null);
  assert.equal(updateEmbedsResult(old("![[whisk.png]]\n", "!\\[\\[whisk.png\\]\\]"), testContext("Cookbook/x.md")), null);
});

// A note that writes its images as `![[x.png]]` keeps them that way (spec §5.4); the page's line reads `![](x.png)`.
const PIC = "Assets/pictures";
const pullCtx = { ...testContext(), media: mediaOf([`${PIC}/x.png`, `${PIC}/y.png`], PIC) };
const PH = `https://nopipeline.invalid/vault/${PIC}`;

test("a pull of an image removed in Notion drops the note's ![[x.png]] line", () => {
  const body = "Intro\n\n![[x.png]]\n\nOutro\n";
  const r = record(body, `Intro\n![](${PH}/x.png)\nOutro`);
  assert.equal(pullResult(r, body, "Intro\nOutro", pullCtx), "Intro\n\nOutro\n");
});

test("a pull of a caption changed in Notion brings the edited line in, the other embeds keep their form", () => {
  const body = "Intro\n\n![[x.png|300]]\n\nMiddle\n\n![[y.png]]\n";
  const r = record(body, `Intro\n![](${PH}/x.png)\nMiddle\n![](${PH}/y.png)`);
  assert.equal(pullResult(r, body, `Intro\n![a new caption](${PH}/x.png)\nMiddle\n![](${PH}/y.png)`, pullCtx), "Intro\n\n![a new caption](x.png)\n\nMiddle\n\n![[y.png]]\n");
});

test("an unrelated edit made in Notion leaves the note's ![[x.png|300]] line byte-identical", () => {
  const body = "Intro\n\n![[x.png|300]]\n\n![cap](y.png)\n\nOutro\n";
  const r = record(body, `Intro\n![](${PH}/x.png)\n![cap](${PH}/y.png)\nOutro`);
  assert.equal(pullResult(r, body, `Intro, edited\n![](${PH}/x.png)\n![cap](${PH}/y.png)\nOutro`, pullCtx), "Intro, edited\n\n![[x.png|300]]\n\n![cap](y.png)\n\nOutro\n");
});

test("code that holds an embed is not read as an image", () => {
  const body = "Intro\n\n```\n![[x.png]]\n```\n";
  const r = record(body, "Intro\n```\n![[x.png]]\n```");
  assert.equal(pullResult(r, body, "Intro, edited\n```\n![[x.png]]\n```", pullCtx), "Intro, edited\n\n```\n![[x.png]]\n```\n");
});

test("when two citations written differently read alike and one goes, the pull is not guessed", () => {
  const body = "![[x.png]]\n\ntext\n\n![[x.png|300]]\n";
  const r = record(body, `![](${PH}/x.png)\ntext\n![](${PH}/x.png)`);
  assert.equal(pullResult(r, body, `text\n![](${PH}/x.png)`, pullCtx), null);
  assert.equal(pullResult(r, body, `![](${PH}/x.png)\ntext, edited\n![](${PH}/x.png)`, pullCtx), "![[x.png]]\n\ntext, edited\n\n![[x.png|300]]\n");
});

// A list item holding only an image: the note's `- ![[x.png]]` is the page's empty item with the image one tab deeper, which reads `- ![](x.png)`.
const ITEM_PAGE = `Intro\n- one\n-\n\t![](${PH}/x.png)\n- two\n\t- deeper\n\t-\n\t\t![cap](${PH}/y.png)\n1.\n\t![](${PH}/x.png)\nOutro`;
const ITEM_NOTE = "Intro\n\n- one\n- ![[x.png]]\n- two\n\t- deeper\n\t- ![[y.png|cap]]\n1. ![[x.png|300]]\n\nOutro\n";

test("an unrelated edit made in Notion leaves the note's list-item ![[x.png]] lines byte-identical (ledger: list-item citations)", () => {
  const r = record(ITEM_NOTE, ITEM_PAGE);
  assert.equal(
    pullResult(r, ITEM_NOTE, ITEM_PAGE.replace("- one", "- one, edited"), pullCtx),
    ITEM_NOTE.replace("- one", "- one, edited"),
  );
  assert.equal(pullResult(r, ITEM_NOTE, ITEM_PAGE.replace("Outro", "Outro, edited"), pullCtx), ITEM_NOTE.replace("Outro", "Outro, edited"));
});

test("an item next to a list-item citation edited in Notion is pulled; the citation's own lines stay as written", () => {
  const body = "- one\n- ![[x.png]]\n- two\n";
  const page = `- one\n-\n\t![](${PH}/x.png)\n- two`;
  const r = record(body, page);
  assert.equal(pullResult(r, body, page.replace("- two", "- two, edited"), pullCtx), "- one\n- ![[x.png]]\n- two, edited\n");
  assert.equal(pullResult(r, body, page.replace("- one", "- one, edited"), pullCtx), "- one, edited\n- ![[x.png]]\n- two\n");
});

test("an item deleted in Notion with its image takes the note's list-item citation line with it; only the image deleted leaves the empty item", () => {
  const body = "- one\n- ![[x.png]]\n- two\n";
  const page = `- one\n-\n\t![](${PH}/x.png)\n- two`;
  const r = record(body, page);
  assert.equal(pullResult(r, body, "- one\n- two", pullCtx), "- one\n- two\n");
  assert.equal(pullResult(r, body, "- one\n-\n- two", pullCtx), "- one\n-\n- two\n");
});

test("a list-item image's caption changed in Notion arrives; a pull that would guess between two list-item citations that read alike does not", () => {
  const body = "- ![[x.png]]\n- ![[y.png|300]]\n- text\n";
  const page = `-\n\t![](${PH}/x.png)\n-\n\t![](${PH}/y.png)\n- text`;
  const r = record(body, page);
  assert.equal(pullResult(r, body, page.replace("![](" + PH + "/x.png)", "![new](" + PH + "/x.png)"), pullCtx), "- ![new](x.png)\n- ![[y.png|300]]\n- text\n");
  const alike = "- ![[x.png]]\n- ![[x.png|300]]\n- text\n";
  const alikePage = `-\n\t![](${PH}/x.png)\n-\n\t![](${PH}/x.png)\n- text`;
  assert.equal(pullResult(record(alike, alikePage), alike, `-\n\t![](${PH}/x.png)\n- text`, pullCtx), null);
});

// A note that embeds another note keeps `![[Elm]]`; the page holds the mention alone, which reads as `[Elm](Elm.md)`.
const MENTION = `<mention-page url="${elmUrl}"/>`;

test("an unrelated edit made in Notion leaves the note's embed of a note byte-identical", () => {
  const body = "Intro\n\n![[Elm]]\n\nSee ![[Elm|the bark notes]] here\n\n- ![[Elm]]\n\nOutro\n";
  const r = record(body, `Intro\n${MENTION}\nSee ${MENTION} here\n- ${MENTION}\nOutro`);
  assert.equal(pullResult(r, body, `Intro\n${MENTION}\nSee ${MENTION} here\n- ${MENTION}\nOutro, edited`, ctx), "Intro\n\n![[Elm]]\n\nSee ![[Elm|the bark notes]] here\n\n- ![[Elm]]\n\nOutro, edited\n");
  assert.equal(pullResult(r, body, `Intro, edited\n${MENTION}\nSee ${MENTION} here\n- ${MENTION}\nOutro`, ctx), "Intro, edited\n\n![[Elm]]\n\nSee ![[Elm|the bark notes]] here\n\n- ![[Elm]]\n\nOutro\n");
});

test("deleting the mention line in Notion removes the note's embed line", () => {
  const body = "Intro\n\n![[Elm]]\n\nOutro\n";
  const r = record(body, `Intro\n${MENTION}\nOutro`);
  assert.equal(pullResult(r, body, "Intro\nOutro", ctx), "Intro\n\nOutro\n");
});

test("an embed line edited in Notion comes back as a link, the other embeds keep their form", () => {
  const body = "![[Elm]]\n\nMiddle\n\n![[Soup- Tomato]]\n";
  const phase = `<mention-page url="${soupUrl}"/>`;
  const r = record(body, `${MENTION}\nMiddle\n${phase}`);
  assert.equal(pullResult(r, body, `${MENTION} and more\nMiddle\n${phase}`, ctx), "[Elm](Elm.md) and more\n\nMiddle\n\n![[Soup- Tomato]]\n");
});

test("a page still holding the embed's old marked mention pulls the same way", () => {
  const body = "Intro\n\n![[Elm]]\n\nOutro\n";
  const r = record(body, `Intro\n!${MENTION}\nOutro`);
  assert.equal(pullResult(r, body, `Intro\n!${MENTION}\nOutro, edited`, ctx), "Intro\n\n![[Elm]]\n\nOutro, edited\n");
  assert.equal(pullResult(r, body, "Intro\nOutro", ctx), "Intro\n\nOutro\n");
});

test("a section embed and an embed in code are not touched", () => {
  const body = "Intro\n\n![[Elm#Bark]]\n\n```\n![[Elm]]\n```\n\nand `![[Elm]]` inline\n";
  const r = record(body, `Intro\n[📎 Elm › Bark](${elmUrl})\n\`\`\`\n![[Elm]]\n\`\`\`\nand \`![[Elm]]\` inline`);
  assert.equal(pullResult(r, body, `Intro, edited\n[📎 Elm › Bark](${elmUrl})\n\`\`\`\n![[Elm]]\n\`\`\`\nand \`![[Elm]]\` inline`, ctx), "Intro, edited\n\n![[Elm#Bark]]\n\n```\n![[Elm]]\n```\n\nand `![[Elm]]` inline\n");
});

test("when an embed and a link read alike and one goes, the pull is not guessed", () => {
  const body = "[Elm](Elm.md)\n\ntext\n\n![[Elm]]\n";
  const r = record(body, `[Elm](${elmUrl})\ntext\n${MENTION}`);
  assert.equal(pullResult(r, body, `[Elm](${elmUrl})\ntext`, ctx), null);
  assert.equal(pullResult(r, body, `[Elm](${elmUrl})\ntext, edited\n${MENTION}`, ctx), "[Elm](Elm.md)\n\ntext, edited\n\n![[Elm]]\n");
});

// The first run drops the `!` before the embedded notes already synced; nothing else on those lines changes.
const OLD = `!${MENTION}`;
const soupMention = `<mention-page url="${soupUrl}"/>`;

test("updateEmbedsResult drops the ! before an embedded note's mention and touches nothing else", () => {
  const r = old("Intro\n\n![[Elm]]\n\nSee ![[Elm]] here\n\n- ![[Soup- Tomato]]\n\nOutro, with a * star\n", `Intro\n${OLD}\nSee ${OLD} here\n- !${soupMention}\nOutro, with a \\* star`);
  assert.equal(updateEmbedsResult(r, ctx), `Intro\n${MENTION}\nSee ${MENTION} here\n- ${soupMention}\nOutro, with a \\* star`);
});

test("updateEmbedsResult does both at once where an image and an embedded note sit next to each other", () => {
  const r = old("![[whisk.png]]\n![[Elm]]\n", `!\\[\\[whisk.png\\]\\]<br>${OLD}`);
  assert.equal(updateEmbedsResult(r, imageCtx), `![](${BASE}/whisk.png)\n${MENTION}`);
  const lines = old("![[whisk.png]]\n\n![[Elm]]\n", `!\\[\\[whisk.png\\]\\]\n${OLD}`);
  assert.equal(updateEmbedsResult(lines, imageCtx), `![](${BASE}/whisk.png)\n${MENTION}`);
});

test("updateEmbedsResult leaves out the changes that are not a dropped ! and keeps Notion's own forms", () => {
  const r = old("![[Elm]]\n\nsee ~~a~~ b\n", `${OLD}\nsee <s>a</s> b`);
  assert.equal(updateEmbedsResult(r, ctx), `${MENTION}\nsee <s>a</s> b`);
});

test("updateEmbedsResult is null where there is no marked mention to unmark", () => {
  // Already without the !, a link and a plain mention (not embeds), a section embed, an embed of a note without a page, an embed in code, and an empty record.
  assert.equal(updateEmbedsResult(old("![[Elm]]\n", MENTION), ctx), null);
  assert.equal(updateEmbedsResult(old("[[Elm]]\n", `[Elm](${elmUrl})`), ctx), null);
  assert.equal(updateEmbedsResult(old("[Elm](Elm.md)\n", MENTION), ctx), null);
  assert.equal(updateEmbedsResult(old("![[Elm#Bark]]\n", `[📎 Elm › Bark](${elmUrl})`), ctx), null);
  assert.equal(updateEmbedsResult(old("![[Floor Plan]]\n", "!\\[\\[Floor Plan\\]\\]"), ctx), null);
  assert.equal(updateEmbedsResult(old("```\n![[Elm]]\n```\n", `\`\`\`\n${OLD}\n\`\`\``), ctx), null);
  assert.equal(updateEmbedsResult(old("", ""), ctx), null);
  // A marked mention the note does not embed (a line Notion made) is not ours to change.
  assert.equal(updateEmbedsResult(old("Text\n", `Text\n${OLD}`), ctx), null);
});

test("a link or mention of the embedded note added in Notion is not taken for the embed: the pull is refused, not misplaced", () => {
  const body = "Intro\n\n![[Elm]]\n\nOutro\n";
  const r = record(body, `Intro\n${MENTION}\nOutro`);
  assert.equal(pullResult(r, body, `Intro\n[Elm](${elmUrl})\n${MENTION}\nOutro`, ctx), null);
  assert.equal(pullResult(r, body, `Intro\n${MENTION}\n[Elm](${elmUrl})\nOutro`, ctx), null);
  assert.equal(pullResult(r, body, `Intro\n${MENTION}\n${MENTION}\nOutro`, ctx), null);
  // The same edits on a line that is not the embed's form are placed.
  assert.equal(pullResult(r, body, `Intro\nsee [Elm](${elmUrl}) now\n${MENTION}\nOutro`, ctx), "Intro\n\nsee [Elm](Elm.md) now\n\n![[Elm]]\n\nOutro\n");
});

test("an image line added in Notion that reads like an image citation of the note is not taken for it", () => {
  const body = "Intro\n\n![[x.png]]\n\nOutro\n";
  const r = record(body, `Intro\n![](${PH}/x.png)\nOutro`);
  assert.equal(pullResult(r, body, `Intro\n![](${PH}/x.png)\n![](${PH}/x.png)\nOutro`, pullCtx), null);
  assert.equal(pullResult(r, body, `Intro\n![](${PH}/x.png)\nOutro, edited`, pullCtx), "Intro\n\n![[x.png]]\n\nOutro, edited\n");
});

// Attachments of every kind (spec §2 goal 3, §5.8): the page's `<pdf>`/`<file>` lines against the note's own `![[Manual.pdf#page=3]]` / `[[minutes.docx|Minutes]]`.
const ATT = "Assets/attachments";
const AH = `https://nopipeline.invalid/vault/${ATT}`;
const attCtx = { ...testContext(), media: mediaOf([`${ATT}/Manual.pdf`, `${ATT}/minutes.docx`, `${ATT}/song.mp3`, `${ATT}/lecture.mp4`, `${ATT}/x.png`], ATT) };
const ATT_NOTE = "Intro\n\n![[Manual.pdf#page=3]]\n\nMiddle\n\n[[minutes.docx|Minutes]]\n\n![[song.mp3]]\n\n![[lecture.mp4|the lecture]]\n\nOutro\n";
const ATT_PAGE = `Intro\n<pdf src="${AH}/Manual.pdf"></pdf>\nMiddle\n<file src="${AH}/minutes.docx">Minutes</file>\n<audio src="${AH}/song.mp3"></audio>\n<video src="${AH}/lecture.mp4">the lecture</video>\nOutro`;

test("an unrelated edit made in Notion leaves the note's ![[Manual.pdf#page=3]] and [[minutes.docx|Minutes]] lines byte-identical", () => {
  const r = record(ATT_NOTE, ATT_PAGE);
  assert.equal(pullResult(r, ATT_NOTE, ATT_PAGE.replace("Middle", "Middle, edited"), attCtx), ATT_NOTE.replace("Middle", "Middle, edited"));
  assert.equal(pullResult(r, ATT_NOTE, ATT_PAGE.replace("Outro", "Outro, edited"), attCtx), ATT_NOTE.replace("Outro", "Outro, edited"));
});

test("a block removed in Notion removes the note's line for it, whatever its kind", () => {
  const r = record(ATT_NOTE, ATT_PAGE);
  const page = (without: string) => ATT_PAGE.split("\n").filter((line) => !line.includes(without)).join("\n");
  assert.equal(pullResult(r, ATT_NOTE, page("Manual.pdf"), attCtx), ATT_NOTE.replace("![[Manual.pdf#page=3]]\n\n", ""));
  assert.equal(pullResult(r, ATT_NOTE, page("minutes.docx"), attCtx), ATT_NOTE.replace("[[minutes.docx|Minutes]]\n\n", ""));
  assert.equal(pullResult(r, ATT_NOTE, page("song.mp3"), attCtx), ATT_NOTE.replace("![[song.mp3]]\n\n", ""));
  assert.equal(pullResult(r, ATT_NOTE, page("lecture.mp4"), attCtx), ATT_NOTE.replace("![[lecture.mp4|the lecture]]\n\n", ""));
});

test("a caption changed in Notion brings the edited line in; the other attachments keep their form", () => {
  const r = record(ATT_NOTE, ATT_PAGE);
  assert.equal(
    pullResult(r, ATT_NOTE, ATT_PAGE.replace(`<file src="${AH}/minutes.docx">Minutes</file>`, `<file src="${AH}/minutes.docx">My minutes</file>`), attCtx),
    ATT_NOTE.replace("[[minutes.docx|Minutes]]", "[My minutes](minutes.docx)"),
  );
});

test("a list item holding only a PDF embed or a file link keeps its line when Notion edits another; deleting the item takes the line", () => {
  const body = "- one\n- ![[Manual.pdf#page=2]]\n- [[minutes.docx]]\n- two\n";
  const page = `- one\n-\n\t<pdf src="${AH}/Manual.pdf"></pdf>\n-\n\t<file src="${AH}/minutes.docx"></file>\n- two`;
  const r = record(body, page);
  assert.equal(pullResult(r, body, page.replace("- two", "- two, edited"), attCtx), "- one\n- ![[Manual.pdf#page=2]]\n- [[minutes.docx]]\n- two, edited\n");
  assert.equal(pullResult(r, body, `- one\n-\n\t<file src="${AH}/minutes.docx"></file>\n- two`, attCtx), "- one\n- [[minutes.docx]]\n- two\n");
});

test("a link and an embed of one file written differently, with one gone in Notion, are not guessed", () => {
  const body = "![[Manual.pdf]]\n\ntext\n\n[[Manual.pdf]]\n";
  const page = `<pdf src="${AH}/Manual.pdf"></pdf>\ntext\n<file src="${AH}/Manual.pdf"></file>`;
  const r = record(body, page);
  assert.equal(pullResult(r, body, page.replace("text", "text, edited"), attCtx), "![[Manual.pdf]]\n\ntext, edited\n\n[[Manual.pdf]]\n");
  assert.equal(pullResult(r, body, `text\n<file src="${AH}/Manual.pdf"></file>`, attCtx), "text\n\n[[Manual.pdf]]\n");
});

// A page synced before attachments held the citation as escaped text (spec §5.8): the first run turns it into its block.
test("updateEmbedsResult turns escaped citations of PDFs, audio, video and files into their blocks and touches nothing else", () => {
  const body = "Intro\n\n![[Manual.pdf#page=3]]\n\n[[minutes.docx|Minutes]]\n\n![[song.mp3]]\n\n[[minutes.docx]]\n\nOutro, with a * star\n";
  const r = record(body, "Intro\n!\\[\\[Manual.pdf#page=3\\]\\]\n\\[\\[minutes.docx\\|Minutes\\]\\]\n!\\[\\[song.mp3\\]\\]\n\\[\\[minutes.docx\\]\\]\nOutro, with a \\* star");
  assert.equal(
    updateEmbedsResult(r, attCtx),
    `Intro\n<pdf src="${AH}/Manual.pdf"></pdf>\n<file src="${AH}/minutes.docx">Minutes</file>\n<audio src="${AH}/song.mp3"></audio>\n<file src="${AH}/minutes.docx"></file>\nOutro, with a \\* star`,
  );
});

test("updateEmbedsResult handles a link or an embed of a file in a list item or sharing a paragraph, and an image next to them", () => {
  const body = "- [[minutes.docx]]\n- ![[Manual.pdf]]\n\nText\n[[minutes.docx|a]]\nmore\n\n![[x.png]]\n";
  const r = record(body, "- \\[\\[minutes.docx\\]\\]\n- !\\[\\[Manual.pdf\\]\\]\nText<br>\\[\\[minutes.docx\\|a\\]\\]<br>more\n!\\[\\[x.png\\]\\]");
  assert.equal(
    updateEmbedsResult(r, attCtx),
    `-\n\t<file src="${AH}/minutes.docx"></file>\n-\n\t<pdf src="${AH}/Manual.pdf"></pdf>\nText\n<file src="${AH}/minutes.docx">a</file>\nmore\n![](${AH}/x.png)`,
  );
});

test("updateEmbedsResult is null where no citation of a file becomes a block", () => {
  // Already a block, a link inside a sentence, a quote, a file that isn't in the vault, a link to a note, and a context with no attachments.
  assert.equal(updateEmbedsResult(record("![[Manual.pdf]]\n", `<pdf src="${AH}/Manual.pdf"></pdf>`), attCtx), null);
  assert.equal(updateEmbedsResult(record("see [[minutes.docx]] here\n", "see \\[\\[minutes.docx\\]\\] here"), attCtx), null);
  assert.equal(updateEmbedsResult(record("> [[minutes.docx]]\n", "> \\[\\[minutes.docx\\]\\]"), attCtx), null);
  assert.equal(updateEmbedsResult(record("[[missing.docx]]\n", "\\[\\[missing.docx\\]\\]"), attCtx), null);
  assert.equal(updateEmbedsResult(record("[[Elm]]\n", "\\[\\[Elm\\]\\]"), attCtx), null);
  assert.equal(updateEmbedsResult(record("[[minutes.docx]]\n", "\\[\\[minutes.docx\\]\\]"), testContext()), null);
});

test("updateEmbedsResult converts an escaped embed that shares a paragraph with the escaped link of a note that doesn't exist", () => {
  // Notion holds `[[Missing]]` (no such note) as literal text, like an attachment link; it is no citation of a file and stays as it is.
  const cases: [string, string, string][] = [
    ["see\n[[Missing]]\n![[x.png]]\n", "see<br>\\[\\[Missing\\]\\]<br>!\\[\\[x.png\\]\\]", `see<br>\\[\\[Missing\\]\\]<br>![](${AH}/x.png)`],
    ["[[Missing]]\n![[x.png]]\n", "\\[\\[Missing\\]\\]<br>!\\[\\[x.png\\]\\]", `\\[\\[Missing\\]\\]<br>![](${AH}/x.png)`],
    ["see\n![[x.png]]\n[[Missing|a]]\n[[minutes.docx]]\n", "see<br>!\\[\\[x.png\\]\\]<br>\\[\\[Missing\\|a\\]\\]<br>\\[\\[minutes.docx\\]\\]", `see<br>![](${AH}/x.png)<br>\\[\\[Missing\\|a\\]\\]<br><file src="${AH}/minutes.docx"></file>`],
  ];
  for (const [body, page, expected] of cases) {
    const result = updateEmbedsResult(record(body, page), attCtx);
    assert.equal(result?.split("<br>").join("\n"), expected.split("<br>").join("\n"), body);
  }
});

test("a trailing image of an item or quote reads back as the same note, whatever layout the note uses, and a Notion edit beside it is placed", () => {
  const notes = [
    "- item\n![[oven.png]]\n- next",
    "- item\n  ![[oven.png]]\n- next",
    "- item\n\t![[oven.png]]\n- next",
    "1. item\n![[oven.png]]",
    "- [ ] item\n![[oven.png]]",
    "> item\n>\n> ![[oven.png]]",
    "> item\n> ![[oven.png]]",
  ];
  for (const note of notes) {
    const page = toNotion(note, imageCtx);
    assert.equal(sayTheSame(note, page, imageCtx), true, note);
    const record = { notionMarkdown: page } as SyncRecord;
    assert.equal(pullResult(record, note, page.replace("item", "item, edited"), imageCtx), note.replace("item", "item, edited"), note);
  }
});
