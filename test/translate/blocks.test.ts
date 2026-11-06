import { test } from "node:test";
import assert from "node:assert/strict";
import { sayTheSame } from "../../src/run/content.ts";
import { notionOnlyBlocks } from "../../src/translate/blocks.ts";
import { keptByNotion, toNotion, toObsidian } from "../../src/translate/index.ts";
import { elmUrl, testContext } from "../helpers/context.ts";

const ctx = testContext();
const lines = (...l: string[]) => l.join("\n");

test("paragraphs, soft line breaks and headings", () => {
  const obsidian = lines("# Title", "", "First line", "second line", "", "##### Deep", "", "Setext", "---");
  assert.equal(toNotion(obsidian, ctx), lines("# Title", "First line<br>second line", "#### Deep", "## Setext"));
  assert.equal(toObsidian(lines("# Title", "First line<br>second line"), ctx), lines("# Title", "", "First line", "second line", ""));
});

test("nested lists, tasks and ordered items, indented with tabs or spaces", () => {
  const obsidian = lines("- one", "    - child with [[Elm]]", "\t\t- grandchild", "* star", "- [x] done", "- [ ] todo", "1. first", "2) second");
  const notion = lines(
    "- one",
    `\t- child with [Elm](${elmUrl})`,
    "\t\t- grandchild",
    "- star",
    "- [x] done",
    "- [ ] todo",
    "1. first",
    "2. second",
  );
  assert.equal(toNotion(obsidian, ctx), notion);
  assert.equal(toObsidian(notion, ctx), lines("- one", "\t- child with [Elm](Elm.md)", "\t\t- grandchild", "- star", "- [x] done", "- [ ] todo", "1. first", "2. second", ""));
});

test("list item continuation lines and child paragraphs", () => {
  assert.equal(toNotion(lines("- item", "  continued", "", "  child paragraph", "- next"), ctx), lines("- item<br>continued", "\tchild paragraph", "- next"));
});

test("code fences are copied verbatim, including inside lists", () => {
  const obsidian = lines("```python", "x = a[1] | b  # not escaped", "```", "- step", "\t```bash", "\techo $HOME", "\t```");
  const notion = lines("```python", "x = a[1] | b  # not escaped", "```", "- step", "\t```bash", "\techo $HOME", "\t```");
  assert.equal(toNotion(obsidian, ctx), notion);
  assert.equal(toObsidian(notion, ctx), lines("```python", "x = a[1] | b  # not escaped", "```", "", "- step", "\t```bash", "\techo $HOME", "\t```", ""));
});

test("math blocks", () => {
  assert.equal(toNotion(lines("$$", "x^2 + y^2", "$$", "", "$$a = b$$"), ctx), lines("$$", "x^2 + y^2", "$$", "$$", "a = b", "$$"));
  assert.equal(toObsidian(lines("$$", "x^2", "$$"), ctx), lines("$$", "x^2", "$$", ""));
});

test("pipe tables become Notion tables and back", () => {
  const obsidian = lines("| Name | Link |", "| --- | :-: |", "| a \\| b | [[Elm\\|shadowed]] |");
  const notion = lines(
    '<table header-row="true">',
    "\t<tr>",
    "\t\t<td>Name</td>",
    "\t\t<td>Link</td>",
    "\t</tr>",
    "\t<tr>",
    "\t\t<td>a \\| b</td>",
    `\t\t<td>[shadowed](${elmUrl})</td>`,
    "\t</tr>",
    "</table>",
  );
  assert.equal(toNotion(obsidian, ctx), notion);
  assert.equal(toObsidian(notion, ctx), lines("| Name | Link |", "| --- | --- |", "| a \\| b | [shadowed](Elm.md) |", ""));
});

test("quotes join their lines with <br>", () => {
  assert.equal(toNotion(lines("> line 1", "> line 2"), ctx), "> line 1<br>line 2");
  assert.equal(toObsidian("> line 1<br>line 2", ctx), lines("> line 1", "> line 2", ""));
});

test("a code block inside a quote becomes a code block nested in the Notion quote, and comes back as the same lines", () => {
  const obsidian = lines("> ```python", "> i = 0", "> while i < 3:", ">     i += 1", ">", "> print(i)", "> ```");
  const notion = lines(">", "\t```python", "\ti = 0", "\twhile i < 3:", "\t    i += 1", "\t", "\tprint(i)", "\t```");
  assert.equal(toNotion(obsidian, ctx), notion);
  assert.equal(toObsidian(notion, ctx), `${obsidian}\n`);
  // With the quote's own text before it, and more after it.
  const told = lines("> Example:", "> ```", "> x = 1", "> ```", "> Then more.");
  assert.equal(toNotion(told, ctx), lines("> Example:", "\t```", "\tx = 1", "\t```", "\tThen more."));
  assert.equal(toObsidian(toNotion(told, ctx), ctx), lines("> Example:", "> ```", "> x = 1", "> ```", ">", "> Then more.", ""));
  // A quote without a fence is still one block of text.
  // (A triple-backtick code span is written with one backtick each side, as Notion reads one back.)
  assert.equal(toNotion(lines("> a", "> ```inline``` b"), ctx), "> a<br>`inline` b");
});

test("Notion's own form of a nested code block, its lines flush left, reads as the same note", () => {
  // As the live probe recorded it: the fences keep their tabs, the code lines are written as they are.
  const notion = lines(">", "\t```python", "i = 0", "while i < 3:", "    i += 1", "", "print(i)", "\t```");
  assert.equal(toObsidian(notion, ctx), lines("> ```python", "> i = 0", "> while i < 3:", ">     i += 1", ">", "> print(i)", "> ```", ""));
  // Code that starts with tabs keeps them; a list item's code block reads the same way.
  assert.equal(toObsidian(lines("- step", "\t```go", "func f() {", "\treturn", "}", "\t```", "- next"), ctx), lines("- step", "\t```go", "\tfunc f() {", "\t\treturn", "\t}", "\t```", "- next", ""));
});

test("callouts keep their type through the icon, and titles as bold first lines", () => {
  const obsidian = lines(">[!Warning] Careful", "> Body with **bold**", ">", "> - a list");
  const notion = lines('<callout icon="⚠️">', "\t**Careful**", "\tBody with **bold**", "\t- a list", "</callout>");
  assert.equal(toNotion(obsidian, ctx), notion);
  assert.equal(toObsidian(notion, ctx), lines("> [!warning] Careful", "> Body with **bold**", ">", "> - a list", ""));
  assert.equal(toNotion("> [!ed]\n> text", ctx), lines('<callout icon="📝">', "\ttext", "</callout>"));
});

test("foldable callouts and Notion toggles map to each other", () => {
  const notion = lines("<details>", "<summary>Show more</summary>", "\tHidden text", "</details>");
  assert.equal(toObsidian(notion, ctx), lines("> [!note]- Show more", "> Hidden text", ""));
  assert.equal(toNotion(lines("> [!note]- Show more", "> Hidden text"), ctx), notion);
});

test("Notion-only layout is simplified for Obsidian", () => {
  const notion = lines(
    'Weather {color="blue"}',
    '<database url="https://app.notion.com/p/1e77056a8fe247b5807293d77b23e695" inline="true"></database>',
    "<columns>",
    '\t<column ratio="50">',
    "\t\t- Rain after noon",
    "\t</column>",
    '\t<column ratio="50">',
    "\t\t### Étoiles Filantes",
    "\t\t- Clear by night",
    "\t</column>",
    "</columns>",
    "---",
    '## Réglages Généraux {toggle="true"}',
    "\tWind from the west",
    "<table_of_contents/>",
    '<unknown url="https://www.notion.so/abc#def" alt="bookmark"/>',
    "<empty-block/>",
  );
  assert.equal(
    toObsidian(notion, ctx),
    lines(
      "Weather",
      "",
      "[🗃 Notion database](https://app.notion.com/p/1e77056a8fe247b5807293d77b23e695)",
      "",
      "- Rain after noon",
      "",
      "### Étoiles Filantes",
      "",
      "- Clear by night",
      "",
      "---",
      "",
      "## Réglages Généraux",
      "",
      "Wind from the west",
      "",
      "[bookmark](https://www.notion.so/abc#def)",
      "",
    ),
  );
  // Synced blocks are shared with other pages, so Obsidian gets a link instead of editable text.
  const synced = lines(
    "Before",
    '<synced_block url="https://app.notion.com/p/4b67472be663442a8076cb604d8ff8b2#fb239a247bd344488c41f8646452c40e">',
    "\tShared text",
    "</synced_block>",
    "<synced_block_reference>",
    "\tMirrored text",
    "</synced_block_reference>",
    "After",
  );
  assert.equal(
    toObsidian(synced, ctx),
    lines(
      "Before",
      "",
      "[🔁 Synced block](https://app.notion.com/p/4b67472be663442a8076cb604d8ff8b2#fb239a247bd344488c41f8646452c40e)",
      "",
      "🔁 Synced block",
      "",
      "After",
      "",
    ),
  );
});

test("empty input gives empty output", () => {
  assert.equal(toNotion("", ctx), "");
  assert.equal(toObsidian("", ctx), "");
});

test("a heading nested under a list item stays nested", () => {
  const obsidian = lines("- Attempted solution", "", "    ### Analyze logs", "    ```bash", "    tail log", "    ```");
  const notion = toNotion(obsidian, ctx);
  assert.equal(notion, lines("- Attempted solution", "\t### Analyze logs", "\t```bash", "\ttail log", "\t```"));
  assert.equal(toNotion(toObsidian(notion, ctx), ctx), notion);
});

test("the blocks a note can't hold are every block tag the translator doesn't carry both ways, outside code", () => {
  const page = lines(
    '<unknown url="https://example.com" alt="bookmark"/>',
    '<page url="https://app.notion.com/p/1">Child</page>',
    '<database url="https://app.notion.com/p/2">Tasks</database>',
    '<synced_block url="https://app.notion.com/p/3">',
    "\tShared",
    "</synced_block>",
    '<video src="https://example.com/v.mp4">Demo</video>',
    '<audio src="https://example.com/a.mp3">Talk</audio>',
    '<file src="https://example.com/f.zip">Archive</file>',
    '<pdf src="https://example.com/p.pdf">Spec</pdf>',
    '<embed src="https://example.com/e">Map</embed>',
    "<table_of_contents/>",
    "<columns>",
    '\t<column ratio="50">',
    "\t\tLeft",
    "\t</column>",
    "</columns>",
    "<meeting-notes>Weekly</meeting-notes>",
    '<table header-row="true">',
    "\t<tr>",
    "\t\t<td>a</td>",
    "\t</tr>",
    "</table>",
    '<callout icon="🚀">',
    "\tText",
    "</callout>",
    "<details>",
    "<summary>More</summary>",
    "</details>",
    '<span color="red">Red</span> text',
    '<mention-date start="2026-09-01"/> started',
    "<empty-block/>",
    "- item",
    "\t```html",
    "<video src=\"in code\"></video>",
    "\t```",
  );
  assert.deepEqual(
    notionOnlyBlocks(page).map((tag) => /^<([a-z_-]+)/.exec(tag)![1]),
    ["unknown", "page", "database", "synced_block", "video", "audio", "file", "pdf", "embed", "table_of_contents", "columns", "column", "meeting-notes"],
  );
});

test("notionOnlyBlocks does not count a placeholder PDF, file, audio or video line (a known attachment), but counts a hosted one the sync has not taken and a web one", () => {
  const hosted = "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/6b5d1c7e-0000-4000-8000-000000000001/Manual.pdf";
  const placeholder = "https://nopipeline.invalid/vault/Assets/attachments";
  const page = lines(
    "text",
    `<pdf src="${placeholder}/Manual.pdf"></pdf>`,
    `<file src="${placeholder}/minutes.docx">Minutes</file>`,
    `<video src="${placeholder}/lecture.mp4"></video>`,
    "- item",
    `\t<audio src="${placeholder}/in-list.mp3">c</audio>`,
    `<pdf src="${hosted}">Unknown hosted</pdf>`,
    `<audio src="${hosted.replace("Manual.pdf", "lecture.mp3")}?X-Amz-Signature=1#notion_record=block.x.ws">Lecture</audio>`,
    '<video src="https://youtu.be/abc">Lecture on YouTube</video>',
    '<pdf src="https://example.com/p.pdf">Web</pdf>',
    `<file src="${placeholder}/minutes.docx">Minutes</file> trailing text`,
  );
  assert.deepEqual(notionOnlyBlocks(page), [
    `<pdf src="${hosted}">`,
    `<audio src="${hosted.replace("Manual.pdf", "lecture.mp3")}?X-Amz-Signature=1#notion_record=block.x.ws">`,
    '<video src="https://youtu.be/abc">',
    '<pdf src="https://example.com/p.pdf">',
    `<file src="${placeholder}/minutes.docx">`,
  ]);
  // So a write that drops a hosted tag the sync hasn't taken is one that drops a block a note can't hold.
  assert.equal(notionOnlyBlocks(`a\n<pdf src="${hosted}">x</pdf>`).length, 1);
  assert.equal(notionOnlyBlocks(`a\n<pdf src="${placeholder}/Manual.pdf">x</pdf>`).length, 0);
});

test("a code fence opens and closes only where CommonMark, and Obsidian, reads one (final review, third round N8)", () => {
  // A fence indented a tab after a paragraph is that paragraph's text: the rest of the note stays as it is.
  assert.equal(toNotion(lines("Para", "\t```", "more", "", "After", "", "- item"), ctx), lines("Para<br>\\`\\`\\`<br>more", "After", "- item"));
  // A backtick fence's info string has no backticks: a line of inline code is text.
  assert.equal(toNotion(lines("Before", "", "```inline``` text", "", "After"), ctx), lines("Before", "`inline` text", "After"));
  // A fence indented four columns doesn't close the block.
  assert.equal(toNotion(lines("```", "code", "    ```", "still code", "```"), ctx), lines("````", "code", "    ```", "still code", "````"));
  // In a list item, indentation counts from the item's text: two columns in, a fence; four or more, the item's text.
  assert.equal(toNotion(lines("- step", "  ```bash", "  echo", "  ```"), ctx), lines("- step", "\t```bash", "\techo", "\t```"));
  assert.equal(toNotion(lines("- step", "      ```bash", "      echo"), ctx), "- step<br>\\`\\`\\`bash<br>echo");
  // In a quote or a callout, a fence may follow the tab after `>`, and the code keeps its tabs.
  assert.equal(toNotion(lines(">\t```python", ">\tx = 1", ">\t\ty", ">\t```", "", "After"), ctx), lines(">", "\t```python", "\tx = 1", "\t\ty", "\t```", "After"));
  assert.equal(toNotion(lines("> [!note] T", ">\t```python", ">\tx = 1", ">\t```", "", "After"), ctx), lines('<callout icon="📝">', "\t**T**", "\t```python", "\tx = 1", "\t```", "</callout>", "After"));
});

test("a line that starts with a triple-backtick code span is text on the Notion side too (final review, fourth round P2)", () => {
  const note = lines("Before", "", "```inline``` text", "", "After", "");
  const page = toNotion(note, ctx);
  // Written with one backtick each side, the only form Notion reads back as code (live probe).
  assert.equal(page, lines("Before", "`inline` text", "After"));
  // Notion keeps it as it is, and it reads back as the same paragraph, with nothing after it taken for code.
  assert.equal(keptByNotion(page), page);
  assert.equal(toObsidian(page, ctx), note.replace("```inline```", "`inline`"));
  assert.equal(sayTheSame(note, page, ctx), true);
  // Notion's side: such a line typed in Notion is text, never a fence.
  assert.deepEqual(notionOnlyBlocks(lines("```inline``` text", "<video src=\"https://example.com/v.mp4\">Demo</video>")), ['<video src="https://example.com/v.mp4">']);
  // Inside a nested block's lines too.
  assert.equal(toObsidian(lines("- item", "\t```inline``` text", "- next"), ctx), lines("- item", "\t```inline``` text", "- next", ""));
});

test("a fence opened after a list marker in a callout is a code block, closed where the callout ends", () => {
  // A form some notes use: the fence follows `- `, the code lines follow without the
  // item's indentation, and no fence closes it. The translator wrote it as the item's text, with escaped
  // backticks, which Notion took for the start of a code span running into the next callouts.
  const note = lines("> [!memo]", "> - ```python", "> total = 3", "> total += 4", "", "> [!note] Next", "> More text.");
  const page = lines(
    '<callout icon="📝">',
    "\t-",
    "\t\t```python",
    "\t\ttotal = 3",
    "\t\ttotal += 4",
    "\t\t```",
    "</callout>",
    '<callout icon="📝">',
    "\t**Next**",
    "\tMore text.",
    "</callout>",
  );
  assert.equal(toNotion(note, ctx), page);
  // It reads back as the same blocks, and translates the same way again.
  assert.equal(toNotion(toObsidian(page, ctx), ctx), page);
  // A fence that closes ends the block there; what follows stays in the item, or in the callout.
  assert.equal(
    toNotion(lines("> [!example]", "> - ```js", ">   x = 1", ">   ```", ">   after", "> outside"), ctx),
    lines('<callout icon="📑">', "\t-", "\t\t```js", "\t\tx = 1", "\t\t```", "\t\tafter", "\toutside", "</callout>"),
  );
  // Outside a callout too. In a quote whose first line isn't a callout type, the quote's text comes first, then
  // the code block (the translator's quotes hold text and code blocks, no lists).
  assert.equal(toNotion(lines("- ```bash", "  echo", "  ```", "", "After"), ctx), lines("-", "\t```bash", "\techo", "\t```", "After"));
  const quoted = toNotion(lines(">[!If - else]", ">Text before.", ">- ```python", ">x = 1", ">\tprint(x)"), ctx);
  assert.equal(quoted, lines("> \\[!If - else\\]<br>Text before.", "\t```python", "\tx = 1", "\t\tprint(x)", "\t```"));
  assert.equal(toNotion(toObsidian(quoted, ctx), ctx), quoted);
  // A task box stays a task's text.
  assert.equal(toNotion("- [ ] ```not code```", ctx), "- [ ] `not code`");
});

test("a note and its page agree on lines whose escapes Notion drops", () => {
  const note = lines("![[diagram.png|a _b_ c]]", "", "x \\# y and snake\\_case", "");
  // The translator drops the escapes that change nothing itself; in literal text it escapes `_`, which Notion drops.
  assert.equal(toNotion(note, ctx), lines("!\\[\\[diagram.png\\|a \\_b\\_ c\\]\\]", "x # y and snake_case"));
  const page = lines("!\\[\\[diagram.png\\|a _b_ c\\]\\]", "x # y and snake_case");
  assert.equal(sayTheSame(note, page, ctx), true);
  // But not where the text differs.
  assert.equal(sayTheSame(note, page.replace("a _b_ c", "a *b* c"), ctx), false);
});

test("code a list item's fence opens keeps its relative indentation: the item's width comes off only where every line has it", () => {
  // A common style: the code follows without the item's indentation, a loop body indented two spaces.
  const flush = toNotion(lines("> [!example]", "> - ```python", "> for x in xs:", ">   print(x)", ">   total += x", "> ```"), ctx);
  assert.equal(flush, lines('<callout icon="📑">', "\t-", "\t\t```python", "\t\tfor x in xs:", "\t\t  print(x)", "\t\t  total += x", "\t\t```", "</callout>"));
  assert.equal(toNotion(toObsidian(flush, ctx), ctx), flush);
  // Code indented less than the item's width on one line only: every line as written, tabs included.
  assert.equal(toNotion(lines("- ```python", "def f():", "\treturn 1", "```"), ctx), lines("-", "\t```python", "\tdef f():", "\t\treturn 1", "\t```"));
  // CommonMark's style, every line under the item's text: the width comes off, a deeper line keeps the rest.
  assert.equal(toNotion(lines("- ```python", "  def f():", "      return 1", "  ```"), ctx), lines("-", "\t```python", "\tdef f():", "\t    return 1", "\t```"));
});

test("an empty code block is written as Notion writes one: with an empty line (live probe)", () => {
  assert.equal(toNotion(lines("```python", "```", "", "- item", "\t```", "\t```"), ctx), lines("```python", "", "```", "- item", "\t```", "\t", "\t```"));
  assert.equal(keptByNotion(toNotion(lines("```python", "```"), ctx)), lines("```python", "", "```"));
});
