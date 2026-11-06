import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLinkIndex, resolveLink, type LinkEntry } from "../../src/links/index.ts";
import { convertBody, convertNotes, markdownLink } from "../../src/links/convert.ts";
import type { VaultNote } from "../../src/types.ts";

const entries: LinkEntry[] = [
  { path: "Grove/Elm.md", pageId: "id-elm", title: "Elm" },
  { path: "Soup- Tomato.md", pageId: "id-soup", title: "Soup: Tomato" },
  { path: "0-In/Draft.md", pageId: "id-draft-1", title: "Draft" },
  { path: "Archive/Draft (2).md", pageId: "id-draft-2", title: "Draft" },
  { path: "Layouts/Floor Plan.md", pageId: null, title: "Floor Plan" },
];
const index = buildLinkIndex(entries);
const withFiles = buildLinkIndex([
  ...entries,
  { path: "Standards/ISO 8601.md", pageId: "id-iso", title: "ISO 8601" },
  { path: "Drawings/X.excalidraw.md", pageId: null, title: "X.excalidraw" },
]);
const from = "Notes/Current.md";
const convert = (body: string) => convertBody(body, index, from);

test("a [[link]] becomes a Markdown link with the note's title as text", () => {
  assert.deepEqual(convert("See [[Elm]]."), { body: "See [Elm](Elm.md).", links: 1 });
  assert.equal(convert("[[Soup- Tomato]]").body, "[Soup: Tomato](Soup-%20Tomato.md)");
});

test("an alias is the link's text; a heading link reads Title › Heading", () => {
  assert.equal(convert("[[Elm|shadowed]]").body, "[shadowed](Elm.md)");
  assert.equal(convert("[[Elm\\|shadowed]]").body, "[shadowed](Elm.md)");
  assert.equal(convert("[[Elm#Bark]]").body, "[Elm › Bark](Elm.md#Bark)");
  assert.equal(convert("[[Elm#Bark|the bark notes]]").body, "[the bark notes](Elm.md#Bark)");
});

test("the destination is the shortest path that resolves, with parentheses encoded", () => {
  assert.equal(convert("[[Draft (2)]]").body, "[Draft](Draft%20%282%29.md)");
  assert.equal(convert("[[Draft]]").body, "[Draft](Draft.md)");
  assert.equal(convert("[[Archive/Draft (2)]]").body, "[Draft](Draft%20%282%29.md)");
});

test("a link to a note without a page, or to no note, is converted too", () => {
  assert.equal(convert("[[Floor Plan]]").body, "[Floor Plan](Floor%20Plan.md)");
  assert.equal(convert("[[Not written yet]]").body, "[Not written yet](Not%20written%20yet.md)");
  assert.equal(convert("[[Not written yet#Part]]").body, "[Not written yet › Part](Not%20written%20yet.md#Part)");
  // A link to no note reads the target's base name, as a literal from Notion reads back.
  assert.equal(convert("[[Folder/Missing]]").body, "[Missing](Folder/Missing.md)");
  assert.equal(convert("[[Folder/Missing#Part]]").body, "[Missing › Part](Folder/Missing.md#Part)");
  assert.equal(convert("[[Folder/Missing|later]]").body, "[later](Folder/Missing.md)");
});

test("brackets and # in names are escaped in the text and encoded in the destination", () => {
  assert.equal(markdownLink("[draft] x", "notes/[draft] x", null), "[\\[draft\\] x](notes/%5Bdraft%5D%20x.md)");
  assert.equal(markdownLink("C# notes", "C# notes", "Intro"), "[C# notes](C%23%20notes.md#Intro)");
  assert.equal(markdownLink("a\\b", "50%", null), "[a\\\\b](50%25.md)");
});

test("links that must not change stay byte for byte", () => {
  for (const body of [
    "![[Elm]]",
    "![[Elm#Bark]]",
    "[[#Heading]]",
    "[[Elm#^abc123]]",
    "[[diagram.png]]",
    "`[[Elm]]`",
    "text ``a [[Elm]] b`` text",
    "```\n[[Elm]]\n```",
    "~~~\n[[Elm]]\n~~~",
    "\\[[Elm]]",
    "[Elm](Elm.md)",
    "[the Elm note](Grove/Elm.md)",
  ]) {
    assert.deepEqual(convert(body), { body, links: 0 }, body);
  }
});

test("a converted link's text is escaped where either app would read it as formatting, so it reads as before (final review)", () => {
  for (const [wiki, link] of [
    ["[[Elm|a *b* c]]", "[a \\*b\\* c](Elm.md)"],
    ["[[Elm|__dict__ keys]]", "[\\_\\_dict\\_\\_ keys](Elm.md)"],
    ["[[Elm|x ~~y~~ and z]]", "[x \\~\\~y\\~\\~ and z](Elm.md)"],
    ["[[Elm|costs $5$ now]]", "[costs \\$5\\$ now](Elm.md)"],
    ["[[Elm|a ==h== b]]", "[a \\==h\\== b](Elm.md)"],
    ["[[Elm|a <b>c</b>]]", "[a \\<b>c\\</b>](Elm.md)"],
    // A `_` inside a word is no emphasis, even next to other formatting.
    ["[[Elm|kv_store *x*]]", "[kv_store \\*x\\*](Elm.md)"],
    // Text that holds no formatting is written as it is.
    ["[[Elm|2 * 3 = $6, a < b, sorted_by_size]]", "[2 * 3 = $6, a < b, sorted_by_size](Elm.md)"],
    ["[[Elm|kv_store]]", "[kv_store](Elm.md)"],
  ]) {
    assert.equal(convert(wiki!).body, link, wiki);
  }
  // A [[link]] whose text holds a code span is code to the conversion; a title can hold one.
  assert.equal(markdownLink("a `b` c", "Elm", null), "[a \\`b\\` c](Elm.md)");
});

test("links inside math stay as they are, read as the translator reads math (final review)", () => {
  for (const body of [
    "Text $[[Elm]]$ math",
    "a $x + [[Elm]]$ b",
    "a $$[[Elm]]$$ b",
    "$$[[Elm]]$$",
    "$$\n[[Elm]] and [[Draft]]\n$$",
    "$$ x\n[[Elm]] $$",
    "> $$\n> [[Elm]]\n> $$",
    "- item\n\t$$\n\t[[Elm]]\n\t$$",
  ]) {
    assert.deepEqual(convert(body), { body, links: 0 }, body);
  }
  // A `$` that opens no math, an escaped one, and the lines after a block of math leave links to convert.
  assert.equal(convert("costs $5 and [[Elm]] $6").body, "costs $5 and [Elm](Elm.md) $6");
  assert.equal(convert("\\$[[Elm]]$").body, "\\$[Elm](Elm.md)$");
  assert.equal(convert("$[[Elm]]").body, "$[Elm](Elm.md)");
  assert.equal(convert("$$\nx\n$$\n[[Elm]] $x$ [[Draft|p]]").body, "$$\nx\n$$\n[Elm](Elm.md) $x$ [p](Draft.md)");
  // A `$$` line inside a code block opens no math.
  assert.equal(convert("```\n$$\n```\n[[Elm]]").body, "```\n$$\n```\n[Elm](Elm.md)");
});

test("only the links outside code are converted, and they are counted", () => {
  const body = "a [[Elm]] and `[[Elm]]`\n```\n[[Elm]]\n```\n![[Elm]] [[Draft|p]]";
  assert.deepEqual(convert(body), { body: "a [Elm](Elm.md) and `[[Elm]]`\n```\n[[Elm]]\n```\n![[Elm]] [p](Draft.md)", links: 2 });
});

test("two notes with one name: the destination is the shortest path that resolves to the linked one", () => {
  const twins = buildLinkIndex([
    { path: "A/Ideas.md", pageId: "id-a", title: "Ideas" },
    { path: "B/Ideas.md", pageId: "id-b", title: "Ideas" },
  ]);
  assert.equal(convertBody("[[B/Ideas]]", twins, "A/x.md").body, "[Ideas](B/Ideas.md)");
  assert.equal(convertBody("[[Ideas]]", twins, "A/x.md").body, "[Ideas](Ideas.md)");
  assert.equal(resolveLink(twins, "Ideas", "A/x.md")?.path, "A/Ideas.md");
});

test("every converted destination resolves to the note the [[link]] meant", () => {
  const targets = ["Elm", "Grove/Elm", "Soup- Tomato", "Draft", "Draft (2)", "Archive/Draft (2)", "0-In/Draft", "Floor Plan", "Layouts/Floor Plan"];
  for (const fromPath of [from, "0-In/x.md", "Archive/x.md", "Layouts/x.md"]) {
    for (const target of targets) {
      for (const anchor of ["", "#H"]) {
        const { body, links } = convertBody(`[[${target}${anchor}]]`, index, fromPath);
        assert.equal(links, 1);
        const dest = /\]\(([^)]*)\)$/.exec(body)![1]!;
        const decoded = decodeURIComponent(anchor ? dest.slice(0, dest.indexOf("#")) : dest);
        const meant = resolveLink(index, target, fromPath);
        assert.ok(meant, `${target} resolves`);
        assert.equal(resolveLink(index, decoded, fromPath), meant, `${target}${anchor} from ${fromPath}`);
      }
    }
  }
});

test("a heading with parentheses is encoded so the destination stays whole", () => {
  assert.equal(convert("[[Elm#Rings (old)]]").body, "[Elm › Rings (old)](Elm.md#Rings%20%28old%29)");
  assert.equal(markdownLink("Elm", "Grove/Elm", "Step 1)"), "[Elm](Grove/Elm.md#Step%201%29)");
});

const note = (path: string, text: string, extra: Partial<VaultNote> = {}): VaultNote => {
  const lines = text.split("\n");
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  return { path, text, body: lines.slice(end + 1).join("\n"), notionId: null, notionTitle: null, ...extra };
};

test("convertNotes keeps the frontmatter byte for byte and returns only the notes with something to convert", () => {
  const withProps = note("Notes/Current.md", '---\nrelated: "[[Elm]]"\ntags: [a]\n---\nSee [[Elm]] and [[Gone]].\n');
  const plain = note("Notes/Plain.md", "---\nrelated: \"[[Elm]]\"\n---\nNothing here, `[[Elm]]`.\n");
  const elm = note("Grove/Elm.md", "Elm\n", { notionId: "id-elm" });
  const result = convertNotes([withProps, plain, elm], ["Drawings/Sketch.excalidraw.md"]);
  assert.deepEqual(result, [
    { path: "Notes/Current.md", text: '---\nrelated: "[[Elm]]"\ntags: [a]\n---\nSee [Elm](Elm.md) and [Gone](Gone.md).\n', links: 2 },
  ]);
});

test("convertNotes indexes every note by its Notion title, and the drawings", () => {
  const notes = [
    note("Notes/Current.md", "[[Renamed]] [[Other/Same]] [[Notes/Plain]]"),
    note("Notes/Renamed.md", "x", { notionTitle: "Soup: Tomato" }),
    note("Notes/Plain.md", "x"),
    note("Other/Same.md", "x"),
  ];
  const [result] = convertNotes(notes, ["D/Same.md"]);
  assert.equal(result!.text, "[Soup: Tomato](Renamed.md) [Same](Other/Same.md) [Plain](Plain.md)");
});

test("a target that looks like a file is converted when it resolves to a note or drawing, left alone otherwise", () => {
  const files = (body: string) => convertBody(body, withFiles, from);
  assert.deepEqual(files("[[ISO 8601]]"), { body: "[ISO 8601](ISO%208601.md)", links: 1 });
  assert.deepEqual(files("[[X.excalidraw]]"), { body: "[X.excalidraw](X.excalidraw.md)", links: 1 });
  for (const body of ["[[Roadmap.canvas|map]]", "[[diagram.png]]"]) assert.deepEqual(files(body), { body, links: 0 });
});
