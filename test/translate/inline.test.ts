import { test } from "node:test";
import assert from "node:assert/strict";
import { convertBody } from "../../src/links/convert.ts";
import { buildLinkIndex } from "../../src/links/index.ts";
import { mentionedPageIds, toNotionInline, toObsidianInline, unresolvedLiteral } from "../../src/translate/inline.ts";
import { rereadByNotion } from "../../src/translate/rereads.ts";
import { elmUrl, soupUrl, testContext } from "../helpers/context.ts";

const ctx = testContext();
const toN = (s: string) => toNotionInline(s, ctx);
const toO = (s: string) => toObsidianInline(s, ctx);

test("wikilinks to synced notes become page links; page links and mentions come back as Markdown links", () => {
  assert.equal(toN("See [[Elm]]."), `See [Elm](${elmUrl}).`);
  assert.equal(toO(`See [Elm](${elmUrl}).`), "See [Elm](Elm.md).");
  assert.equal(toO(`<mention-page url="${elmUrl}"/>`), "[Elm](Elm.md)");
  assert.equal(toO(`See <mention-page url="${elmUrl}"/>.`), "See [Elm](Elm.md).");
  assert.equal(toO(`<mention-page url="https://www.notion.so/cb56bbf0dc78488685536285651b9f5d">Elm</mention-page>`), "[Elm](Elm.md)");
});

test("a note whose file name differs from its title links with the title as display text", () => {
  assert.equal(toN("[[Soup- Tomato|Soup: Tomato]]"), `[Soup: Tomato](${soupUrl})`);
  assert.equal(toO(`<mention-page url="${soupUrl}"/>`), "[Soup: Tomato](Soup-%20Tomato.md)");
  // A page link keeps its own text, whatever it is.
  assert.equal(toO(`[Soup: Tomato](${soupUrl})`), "[Soup: Tomato](Soup-%20Tomato.md)");
  assert.equal(toO(`[Soup- Tomato](${soupUrl})`), "[Soup- Tomato](Soup-%20Tomato.md)");
});

test("aliases and heading links keep their wording as Notion links", () => {
  assert.equal(toN("[[Elm|shadowed]]"), `[shadowed](${elmUrl})`);
  assert.equal(toO(`[shadowed](${elmUrl})`), "[shadowed](Elm.md)");
  assert.equal(toN("[[Elm#Bark]]"), `[Elm › Bark](${elmUrl})`);
  assert.equal(toO(`[Elm › Bark](${elmUrl})`), "[Elm › Bark](Elm.md#Bark)");
  assert.equal(toO(`[Elm › Bark (2)](${elmUrl})`), "[Elm › Bark (2)](Elm.md#Bark%20%282%29)");
  // Text with formatting keeps it.
  assert.equal(toO(`[**Elm** and \\*more\\*](${elmUrl})`), "[**Elm** and \\*more\\*](Elm.md)");
  assert.equal(toN("[[Elm#^abc123]]"), `[Elm › \\^abc123](${elmUrl})`);
  assert.equal(toO(`[Elm › \\^abc123](${elmUrl})`), "[[Elm#^abc123]]");
});

test("an embed of a note becomes the page mention alone, with no !", () => {
  assert.equal(toN("![[Elm]]"), `<mention-page url="${elmUrl}"/>`);
  assert.equal(toN("![[Elm|a label]]"), `<mention-page url="${elmUrl}"/>`);
  assert.equal(toN("- ![[Elm]]"), `- <mention-page url="${elmUrl}"/>`);
  // A lone mention reads as any mention does: a Markdown link. An embed edited in Notion comes back as a link.
  assert.equal(toO(`<mention-page url="${elmUrl}"/>`), "[Elm](Elm.md)");
  assert.equal(toO(`<mention-page url="${soupUrl}"/>`), "[Soup: Tomato](Soup-%20Tomato.md)");
  // The marked mention that pages synced before this change hold still reads as the embed, until the first run drops its !.
  assert.equal(toO(`!<mention-page url="${elmUrl}"/>`), "![[Elm]]");
  assert.equal(toO(`!<mention-page url="${soupUrl}"/>`), "![[Soup- Tomato]]");
});

test("what is not an embed of a note with a page is written as before", () => {
  // A note without a page and a file keep their literal [[ ]]; the Markdown form of an embed stays escaped text.
  assert.equal(toN("![[Floor Plan]]"), "!\\[\\[Floor Plan\\]\\]");
  assert.equal(toN("![[diagram.png]]"), "!\\[\\[diagram.png\\]\\]");
  assert.equal(toN("![x](Elm.md)"), "!\\[x\\](Elm.md)");
  assert.equal(toO("!\\[x\\](Elm.md)"), "![x](Elm.md)");
});

test("embeds of a section keep the section", () => {
  assert.equal(toN("![[Elm#Bark]]"), `[📎 Elm › Bark](${elmUrl})`);
  assert.equal(toO(`[📎 Elm › Bark](${elmUrl})`), "![[Elm#Bark]]");
});

test("ambiguous names resolve by folder and are written unambiguously", () => {
  assert.equal(toO(`<mention-page url="https://app.notion.com/p/e8ed47c353ba41308efd802761b1339b"/>`), "[Draft](Draft%20%282%29.md)");
  assert.equal(toO(`<mention-page url="https://app.notion.com/p/1273de38b3ab4c538cc53c4a76c06f7a"/>`), "[Draft](Draft.md)");
  assert.equal(toN("[[Draft (2)|Draft]]"), "[Draft](https://app.notion.com/p/e8ed47c353ba41308efd802761b1339b)");
});

test("links to notes that don't exist stay literal and come back as Markdown links", () => {
  assert.equal(toN("[[Not written yet]]"), "\\[\\[Not written yet\\]\\]");
  assert.equal(toO("\\[\\[Not written yet\\]\\]"), "[Not written yet](Not%20written%20yet.md)");
  assert.equal(toO("\\[\\[Not written yet\\|later\\]\\]"), "[later](Not%20written%20yet.md)");
  assert.equal(toO("\\[\\[Not written yet#H\\]\\]"), "[Not written yet › H](Not%20written%20yet.md#H)");
  assert.equal(toO("\\[\\[Not written yet#H\\|later\\]\\]"), "[later](Not%20written%20yet.md#H)");
  assert.equal(toO("- \\[\\[Elm\\]\\]"), "- [Elm](Elm.md)");
  // A block link stays a [[link]].
  assert.equal(toO("\\[\\[Not written yet#\\^abc\\]\\]"), "[[Not written yet#^abc]]");
  // Read exactly as Notion holds it, a literal stays escaped.
  assert.equal(toObsidianInline("\\[\\[Not written yet\\]\\]", ctx, true), "\\[\\[Not written yet\\]\\]");
  assert.equal(toObsidianInline("\\[\\[Not written yet\\|later\\]\\]", ctx, true), "\\[\\[Not written yet\\|later\\]\\]");
});

test("a literal to a note in a folder reads the note's title, or the target's base name, never the folder path", () => {
  // Floor Plan resolves: its title, and the shortest path.
  assert.equal(toO("\\[\\[Layouts/Floor Plan\\]\\]"), "[Floor Plan](Floor%20Plan.md)");
  assert.equal(toO("\\[\\[Layouts/Floor Plan\\|the map\\]\\]"), "[the map](Floor%20Plan.md)");
  // Without the note: the target's base name, and the target as written.
  const bare = { ...ctx, index: buildLinkIndex([{ path: ctx.fromPath, pageId: "11111111-1111-1111-1111-111111111111", title: "Current" }]) };
  assert.equal(toObsidianInline("\\[\\[Layouts/Floor Plan\\]\\]", bare), "[Floor Plan](Layouts/Floor%20Plan.md)");
  assert.equal(toObsidianInline("\\[\\[Layouts/Floor Plan#Part\\]\\]", bare), "[Floor Plan › Part](Layouts/Floor%20Plan.md#Part)");
});

test("attachments, drawings and canvases travel as literal text and come back unchanged", () => {
  assert.equal(toN("![[diagram.png|300]]"), "!\\[\\[diagram.png\\|300\\]\\]");
  assert.equal(toO("!\\[\\[diagram.png\\|300\\]\\]"), "![[diagram.png|300]]");
  assert.equal(toN("![[Floor Plan]]"), "!\\[\\[Floor Plan\\]\\]");
  assert.equal(toO("!\\[\\[Floor Plan\\]\\]"), "![[Floor Plan]]");
  assert.equal(toN("[[Board.canvas]]"), "\\[\\[Board.canvas\\]\\]");
  assert.equal(toO("\\[\\[Board.canvas\\]\\]"), "[[Board.canvas]]");
  // Markdown-style links to attachments come back in the vault's wikilink style, to the same file.
  assert.equal(toN("![](Assets/x.png)"), "!\\[\\[Assets/x.png\\]\\]");
  assert.equal(toO("!\\[\\[Assets/x.png\\]\\]"), "![[Assets/x.png]]");
  assert.equal(toN("[the slides](docs/talk.pdf)"), "\\[\\[docs/talk.pdf\\|the slides\\]\\]");
  assert.equal(toO("\\[\\[docs/talk.pdf\\|the slides\\]\\]"), "[[docs/talk.pdf|the slides]]");
});

test("Markdown links to notes and the web", () => {
  assert.equal(toN("[the Elm note](Grove/Elm.md)"), `[the Elm note](${elmUrl})`);
  assert.equal(toN("[Elm](Elm.md)"), `[Elm](${elmUrl})`);
  assert.equal(toN("[Elm](../Grove/Elm.md)"), `[Elm](${elmUrl})`);
  assert.equal(toN("[docs](https://example.com/a_(b))"), "[docs](https://example.com/a_(b))");
  assert.equal(toO("[docs](https://example.com)"), "[docs](https://example.com)");
});

test("Markdown links to notes without a page travel as the literal [[link]] a note without a page has", () => {
  assert.equal(toN("[Not written yet](Not%20written%20yet.md)"), "\\[\\[Not written yet\\]\\]");
  assert.equal(toN("[later](Not%20written%20yet.md)"), "\\[\\[Not written yet\\|later\\]\\]");
  assert.equal(toN("[x](Floor%20Plan.md)"), "\\[\\[Floor Plan\\|x\\]\\]");
  // A heading link keeps its heading.
  assert.equal(toN("[Not written yet › H](Not%20written%20yet.md#H)"), "\\[\\[Not written yet#H\\]\\]");
  assert.equal(toN("[later](Not%20written%20yet.md#H)"), "\\[\\[Not written yet#H\\|later\\]\\]");
  // An obsidian:// link into this vault, to a note without a page.
  assert.equal(toN("[Floor Plan](obsidian://open?vault=DemoVault&file=Layouts%2FFloor%20Plan)"), "\\[\\[Layouts/Floor Plan\\]\\]");
  assert.equal(toN("[the map](obsidian://open?vault=DemoVault&file=Layouts%2FFloor%20Plan)"), "\\[\\[Layouts/Floor Plan\\|the map\\]\\]");
});

test("Markdown links to notes come back from Notion to the same note with the same text", () => {
  const dunder = "82ed30a6-f541-463c-8b32-67e48136d2bc";
  const odd = "cd6568df-cc94-44f4-8b91-6ade36bd54d9";
  const local = {
    ...ctx,
    index: buildLinkIndex([
      ...ctx.index.entries,
      { path: "Lamp __glow__ mode.md", pageId: dunder, title: "Lamp __glow__ mode" },
      { path: "5-Odd/Odd (1) 100%.md", pageId: odd, title: "[Draft] #1 (x) 5%" },
    ]),
  };
  const floorPlan = "obsidian://open?vault=DemoVault&file=Layouts%2FFloor%20Plan";
  for (const [note, back] of [
    ["[the Elm note](Grove/Elm.md)", "[the Elm note](Elm.md)"],
    ["[Elm](Elm.md)", "[Elm](Elm.md)"],
    ["[Elm](../Grove/Elm.md)", "[Elm](Elm.md)"],
    ["[Elm › Bark](Elm.md#Bark)", "[Elm › Bark](Elm.md#Bark)"],
    ["[2 * 3 = $6 | a\\[1\\] {x} ^y](Elm.md)", "[2 * 3 = $6 | a\\[1\\] {x} ^y](Elm.md)"],
    ["[Soup: Tomato](Soup-%20Tomato.md)", "[Soup: Tomato](Soup-%20Tomato.md)"],
    ["[Draft](Draft%20%282%29.md)", "[Draft](Draft%20%282%29.md)"],
    ["[Draft](0-In/Draft.md)", "[Draft](Draft.md)"],
    // A mention shows the title as it is: it comes back as text both apps show as it is, as conversion writes it.
    ["[Lamp __glow__ mode](Lamp%20__glow__%20mode.md)", "[Lamp \\_\\_glow\\_\\_ mode](Lamp%20__glow__%20mode.md)"],
    ["[Lamp \\_\\_glow\\_\\_ mode](Lamp%20__glow__%20mode.md)", "[Lamp \\_\\_glow\\_\\_ mode](Lamp%20__glow__%20mode.md)"],
    ["[\\[Draft\\] #1 (x) 5%](Odd%20%281%29%20100%25.md)", "[\\[Draft\\] #1 (x) 5%](Odd%20%281%29%20100%25.md)"],
    ["[Not written yet](Not%20written%20yet.md)", "[Not written yet](Not%20written%20yet.md)"],
    ["[later](Not%20written%20yet.md)", "[later](Not%20written%20yet.md)"],
    ["[x](Floor%20Plan.md)", "[x](Floor%20Plan.md)"],
    ["[Not written yet › H](Not%20written%20yet.md#H)", "[Not written yet › H](Not%20written%20yet.md#H)"],
    ["[later](Not%20written%20yet.md#H)", "[later](Not%20written%20yet.md#H)"],
    [`[Floor Plan](${floorPlan})`, "[Floor Plan](Floor%20Plan.md)"],
    [`[the map](${floorPlan})`, "[the map](Floor%20Plan.md)"],
    ["[[Elm]]", "[Elm](Elm.md)"],
    ["[[Elm|shadowed]]", "[shadowed](Elm.md)"],
    ["[[Elm#Bark]]", "[Elm › Bark](Elm.md#Bark)"],
    ["[[Draft (2)|Draft]]", "[Draft](Draft%20%282%29.md)"],
    ["[[Not written yet]]", "[Not written yet](Not%20written%20yet.md)"],
  ]) {
    assert.equal(toObsidianInline(toNotionInline(note!, local), local), back, note);
  }
});

test("read exactly, two page link texts Notion holds differently never read alike; a mention reads as the title's link", () => {
  const odd = "e62614cc-1d97-4abf-8aad-765017432ff3";
  const local = { ...ctx, index: buildLinkIndex([...ctx.index.entries, { path: "Odd.md", pageId: odd, title: "a|b * c" }]) };
  const exactO = (s: string) => toObsidianInline(s, local, true);
  assert.notEqual(exactO(`[a\\*b](${elmUrl})`), exactO(`[a*b](${elmUrl})`));
  assert.notEqual(exactO(`[a\\|b](${elmUrl})`), exactO(`[a|b](${elmUrl})`));
  assert.notEqual(exactO(`[a\\<b](${elmUrl})`), exactO(`[a<b](${elmUrl})`));
  // Not read exactly, the plain words come back as the vault wrote them.
  assert.equal(toObsidianInline(`[a\\|b \\* c](${elmUrl})`, local), "[a|b * c](Elm.md)");
  // A mention of a page reads as the page link the translator writes for its title.
  const mention = `<mention-page url="https://app.notion.com/p/${odd.replace(/-/g, "")}"/>`;
  assert.equal(exactO(mention), exactO(toNotionInline("[a|b * c](Odd.md)", local)));
  assert.equal(toObsidianInline(mention, local), "[a|b * c](Odd.md)");
});

test("a converted link to no note, in a folder, comes back from Notion as it was converted", () => {
  for (const [wiki, link, literal] of [
    ["[[Folder/Missing]]", "[Missing](Folder/Missing.md)", "\\[\\[Folder/Missing\\]\\]"],
    ["[[Folder/Missing#H]]", "[Missing › H](Folder/Missing.md#H)", "\\[\\[Folder/Missing#H\\]\\]"],
    ["[[Folder/Missing|later]]", "[later](Folder/Missing.md)", "\\[\\[Folder/Missing\\|later\\]\\]"],
  ]) {
    const converted = convertBody(wiki!, ctx.index, ctx.fromPath).body;
    assert.equal(converted, link);
    assert.equal(toN(converted), literal);
    assert.equal(toO(toN(converted)), link);
  }
});

test("a converted link whose text would be formatting reads in Notion as before, and comes back as it was converted (final review)", () => {
  const dunder = "82ed30a6-f541-463c-8b32-67e48136d2bc";
  const local = { ...ctx, index: buildLinkIndex([...ctx.index.entries, { path: "Lamp __glow__ mode.md", pageId: dunder, title: "Lamp __glow__ mode" }]) };
  for (const wiki of [
    "[[Elm|a *b* c]]",
    "[[Elm|__dict__ keys]]",
    "[[Elm|x ~~y~~ and z]]",
    "[[Elm|costs $5$ now]]",
    "[[Elm|a <b>c</b> < d]]",
    "[[Elm|kv_store *x*]]",
    "[[Elm|2 * 3 = $6, a < b, sorted_by_size]]",
    "[[Missing note|a *b* <c>]]",
    "[[Lamp __glow__ mode]]",
    "[[Lamp __glow__ mode#Usage]]",
  ]) {
    const converted = convertBody(`x ${wiki} end`, local.index, local.fromPath).body;
    const page = toNotionInline(converted, local);
    assert.equal(page, toNotionInline(`x ${wiki} end`, local), wiki);
    assert.equal(toObsidianInline(page, local), converted, wiki);
  }
  // `==` the translator writes `\==`, as it does in any text (Notion shows `==`): the text reads as before, in other words.
  const highlight = convertBody("[[Elm|a ==h== b]]", local.index, local.fromPath).body;
  assert.equal(toNotionInline(highlight, local), `[a \\==h\\== b](${elmUrl})`);
  assert.equal(toObsidianInline(toNotionInline(highlight, local), local), highlight);
  // A link to the page whose title Notion would re-read is still a mention (live probe).
  const converted = convertBody("[[Lamp __glow__ mode]]", local.index, local.fromPath).body;
  assert.equal(converted, "[Lamp \\_\\_glow\\_\\_ mode](Lamp%20__glow__%20mode.md)");
  assert.equal(toNotionInline(converted, local), `<mention-page url="https://app.notion.com/p/82ed30a6f541463c8b3267e48136d2bc"/>`);
});

test("a hand-written link to no note, its text the path with the folder, comes back from Notion as it was (final review)", () => {
  for (const link of ["[Folder/Missing](Folder/Missing.md)", "[Folder/Missing › H](Folder/Missing.md#H)"]) {
    const line = `x ${link} end`;
    assert.equal(toO(toN(line)), line);
  }
});

test("unresolvedLiteral: the target alone when the text is the target's base name (› the heading), else target|text", () => {
  assert.equal(unresolvedLiteral("Floor Plan", "Layouts/Floor Plan", null), "Layouts/Floor Plan");
  assert.equal(unresolvedLiteral("Bread Proofing › Second rise", "Bread Proofing", "Second rise"), "Bread Proofing#Second rise");
  assert.equal(unresolvedLiteral("Missing › H", "Folder/Missing", "H"), "Folder/Missing#H");
  // Text with the folder is the note's own: the literal reads back as the base name, so it keeps the text.
  assert.equal(unresolvedLiteral("Layouts/Floor Plan", "Layouts/Floor Plan", null), "Layouts/Floor Plan|Layouts/Floor Plan");
  assert.equal(unresolvedLiteral("Folder/Missing › H", "Folder/Missing", "H"), "Folder/Missing#H|Folder/Missing › H");
  assert.equal(unresolvedLiteral("later", "Not written yet", null), "Not written yet|later");
  assert.equal(unresolvedLiteral("later", "Bread Proofing", "Second rise"), "Bread Proofing#Second rise|later");
});

test("a link whose text is the title of a note Notion would re-read is a mention; other text stays a link (live probe)", () => {
  const dunder = "82ed30a6-f541-463c-8b32-67e48136d2bc";
  const dunderUrl = "https://app.notion.com/p/82ed30a6f541463c8b3267e48136d2bc";
  const local = {
    ...ctx,
    index: buildLinkIndex([
      { path: "Lamp __glow__ mode.md", pageId: dunder, title: "Lamp __glow__ mode" },
      { path: ctx.fromPath, pageId: "11111111-1111-1111-1111-111111111111", title: "Current" },
    ]),
  };
  const wiki = toNotionInline("[[Lamp __glow__ mode]]", local);
  const md = toNotionInline("[Lamp __glow__ mode](Lamp%20__glow__%20mode.md)", local);
  assert.equal(wiki, `<mention-page url="${dunderUrl}"/>`);
  assert.equal(md, `<mention-page url="${dunderUrl}"/>`);
  assert.deepEqual(rereadByNotion(wiki), []);
  assert.deepEqual(rereadByNotion(md), []);
  assert.equal(toNotionInline("[[Lamp __glow__ mode|dunder]]", local), `[dunder](${dunderUrl})`);
  // A heading link is a page link whatever its text: a mention would lose the heading.
  assert.equal(toNotionInline("[Lamp __glow__ mode](Lamp%20__glow__%20mode.md#Usage)", local), `[Lamp **glow** mode](${dunderUrl})`);
  assert.equal(toNotionInline("[[Lamp __glow__ mode#Usage|Lamp __glow__ mode]]", local), `[Lamp \\_\\_glow\\_\\_ mode](${dunderUrl})`);
});

test("a link's own text with escaped underscores that pair is refused; unescaped ones are bold in both apps (README, design item 70)", () => {
  // Notion would re-read `\_\_slots\_\_` as bold (live probe), so the note is refused (`notion_rereads`).
  const escaped = toN("[\\_\\_dict\\_\\_ keys](Elm.md)");
  assert.equal(escaped, `[\\_\\_dict\\_\\_ keys](${elmUrl})`);
  assert.notDeepEqual(rereadByNotion(escaped), []);
  // A [[link]] with such text is converted to that form, and is refused as it was before.
  assert.equal(convertBody("[[Elm|__dict__ keys]]", ctx.index, ctx.fromPath).body, "[\\_\\_dict\\_\\_ keys](Elm.md)");
  assert.notDeepEqual(rereadByNotion(toN("[[Elm|__dict__ keys]]")), []);
  // Unescaped, they are bold in Obsidian, and go to Notion as bold.
  const bold = toN("[__dict__ keys](Elm.md)");
  assert.equal(bold, `[**dict** keys](${elmUrl})`);
  assert.deepEqual(rereadByNotion(bold), []);
});

test("links Notion can't hold (obsidian://, file://, mailto:) travel as literal text and come back as links", () => {
  const other = "obsidian://open?vault=Other%20vault&file=Shelf%2FItems";
  assert.equal(toN(`[list](${other})`), `\\[list\\](${other})`);
  assert.equal(toO(`\\[list\\](${other})`), `[list](${other})`);
  assert.equal(toN("[mail me](mailto:ada@example.com)"), "\\[mail me\\](mailto:ada@example.com)");
  assert.equal(toO("\\[mail me\\](mailto:ada@example.com)"), "[mail me](mailto:ada@example.com)");
});

test("obsidian:// links into this vault become links to the note's page", () => {
  assert.equal(toN("[shadowed](obsidian://open?vault=DemoVault&file=Grove%2FElm)"), `[shadowed](${elmUrl})`);
});

test("mentions of pages outside the vault become links that open Notion, titled when the title is known", () => {
  const url = "https://app.notion.com/p/f81667b8032f4c488b1ec45e19085615";
  assert.equal(toO(`<mention-page url="${url}"/>`), `[Notion page](${url})`);
  const titled = { ...ctx, titles: new Map([["f81667b8-032f-4c48-8b1e-c45e19085615", "Grove"]]) };
  assert.equal(toObsidianInline(`<mention-page url="${url}"/>`, titled), `[Grove](${url})`);
});

test("mentionedPageIds lists each mentioned page once", () => {
  assert.deepEqual(mentionedPageIds(`<mention-page url="${elmUrl}"/> and <mention-page url="${elmUrl}">Elm</mention-page> and [x](${soupUrl})`), ["cb56bbf0-dc78-4886-8553-6285651b9f5d"]);
});

test("highlights, code, math and formatting", () => {
  assert.equal(toN("==key== **bold** *it* ~~no~~ `a|b` $x^2$"), '<span color="yellow_bg">key</span> **bold** *it* ~~no~~ `a|b` $`x^2`$');
  assert.equal(toO("$`x^2`$ and $`a = b`$"), "$x^2$ and $a = b$");
  assert.equal(toO('<span color="yellow_bg">key</span> <span color="red">red</span>'), "==key== red");
  assert.equal(toN("costs $5 and $10"), "costs \\$5 and \\$10");
});

test("characters Notion treats as syntax are escaped and restored", () => {
  assert.equal(toN("a < b > c {x} | y ^ z [1]"), "a \\< b \\> c \\{x\\} \\| y \\^ z \\[1\\]");
  assert.equal(toO("a \\< b \\> c \\{x\\} \\| y \\^ z \\[1\\]"), "a < b > c {x} | y ^ z \\[1\\]");
  assert.equal(toN("C:\\Users and \\*literal\\*"), "C:\\\\Users and \\*literal\\*");
  assert.equal(toN("block id ^abc-123"), "block id \\^abc-123");
  assert.equal(toO("block id \\^abc-123"), "block id ^abc-123");
  assert.equal(toN("a claim[^1] and [^my-ref]"), "a claim\\[\\^1\\] and \\[\\^my-ref\\]");
  assert.equal(toO("a claim\\[\\^1\\] and \\[\\^my-ref\\]"), "a claim[^1] and [^my-ref]");
  assert.equal(toO("\\[\\^1\\]: the source"), "[^1]: the source");
});

test("line breaks, dates and people", () => {
  assert.equal(toN("one<br>two"), "one<br>two");
  assert.equal(toO("one<br>two"), "one\ntwo");
  assert.equal(toO('<mention-date start="2026-09-27"/>'), "2026-09-27");
  assert.equal(toO('<mention-user url="user://abc">Ada</mention-user>'), "@Ada");
});

test("the translator writes Notion's own inline forms wherever they say the same", () => {
  // `_` emphasis as `*`, as CommonMark pairs it; a tilde that strikes nothing escaped; a backslash that changes nothing dropped.
  assert.equal(toN("x __bold__ y and _it_, (_a_) _a b_"), "x **bold** y and *it*, (*a*) *a b*");
  assert.equal(toN("x __bold _it_ bold__ y"), "x **bold *it* bold** y");
  assert.equal(toN("x _a_b_ y, x _a\\_b_ y, x _a__ y"), "x *a_b* y, x *a_b* y, x *a*_ y");
  assert.equal(toN("[_label_](https://example.com/a_b_c) and _see [[Elm]]_"), `[*label*](https://example.com/a_b_c) and *see [Elm](${elmUrl})*`);
  assert.equal(toN("x ~ y, x ~y~ z, a~b, ~/path and ~~struck~~"), "x \\~ y, x \\~y\\~ z, a\\~b, \\~/path and ~~struck~~");
  assert.equal(toN("x \\# y \\. z \\! w \\% v \\& u snake\\_case"), "x # y . z ! w % v & u snake_case");
  // What isn't emphasis stays as written: inside words, around spaces, in code, and next to a `*` (`*_a_*` is
  // emphasis in emphasis, which `**a**` would make strong).
  for (const same of ["foo__bar__baz", "foo_bar_baz", "x __ not bold __ y", "x _ y _ z", "`a_b_c` and `__x__`", "x *_a_* y", "x __bold__text y"]) assert.equal(toN(same), same);
  // Escapes that keep something from being syntax stay, though Notion drops them (README, Known limitations).
  for (const kept of ["\\# not heading", "1\\. not ordered", "\\_foo\\_ y", "x \\*a\\* \\~ \\` y", "!\\[x\\]"]) assert.equal(toN(kept), kept);
});

test("text written as literal text keeps its underscores from being emphasis in Notion", () => {
  // An embed's text: Notion read `_North_` there as emphasis, and wrote it back `*North*`.
  const note = "![[map.png|_North_ is up]] and [[my_note_draft]]";
  const page = toN(note);
  assert.equal(page, "!\\[\\[map.png\\|\\_North\\_ is up\\]\\] and \\[\\[my_note_draft\\]\\]");
  // Notion drops those backslashes when it writes the page back; the note reads the same from what it keeps.
  assert.equal(toO(page.replace(/\\_/g, "_")), "![[map.png|_North_ is up]] and [my_note_draft](my_note_draft.md)");
});

test("an autolink's text is the URL as Notion writes it: no backslash Notion drops", () => {
  assert.equal(toN("x <https://e.com/_a_/b_c> y"), "x [https://e.com/_a_/b_c](https://e.com/_a_/b_c) y");
  assert.equal(toN("x <https://e.com/a~b|c> y"), "x [https://e.com/a\\~b\\|c](https://e.com/a~b|c) y");
});

test("a `*` that isn't emphasis is written escaped, since Notion pairs such stars itself (live probe)", () => {
  // Notion made `2 * 3 * 4` "2 _ 3 _ 4" with an italic 3, and dropped `**` between spaces.
  for (const [note, page] of [
    ["x * y", "x \\* y"],
    ["2 * 3 * 4", "2 \\* 3 \\* 4"],
    ["a * b and c * d", "a \\* b and c \\* d"],
    ["x ** y", "x \\*\\* y"],
    ["x **a ** y", "x \\*\\*a \\*\\* y"],
    ["x *a * y", "x \\*a \\* y"],
    ["2*3", "2\\*3"],
  ]) {
    assert.equal(toN(note!), page, note);
  }
  // Emphasis stays emphasis, and code stays code.
  for (const same of ["a*b*c", "**bold** and *it*", "x ***a*** y", "`2 * 3 * 4`", "x \\* y"]) assert.equal(toN(same), same);
});

test("a bare URL is a link in Obsidian: its underscores are not emphasis", () => {
  assert.equal(toN("see https://github.com/x/blob/main/__init__.py now and __this__"), "see https://github.com/x/blob/main/__init__.py now and **this**");
  assert.equal(toN("at https://example.com/a*b*c here"), "at https://example.com/a*b*c here");
});

test("a code span is written with one backtick on each side, the only form Notion reads back as code (live probe)", () => {
  // Notion read ``a`` as plain text.
  assert.equal(toN("x ``a`` y and ```b``` and `` c `` and `d`"), "x `a` y and `b` and `c` and `d`");
  // A code span holding a backtick has no form Notion keeps: it stays as written.
  assert.equal(toN("x `` a ` b `` y"), "x `` a ` b `` y");
});

test("italics around bold keep their `_`, the form Notion reads them in (live probe)", () => {
  // Notion read `*a **b** c*` as "a b c" in italics, losing the bold; `_a **b** c_` it reads right, but writes it back
  // `*a **b** c*`, so a page holding one isn't written (`notion_rereads`).
  assert.equal(toN("x _a **b** c_ y"), "x _a **b** c_ y");
  assert.equal(toN("x _a __b__ c_ y"), "x _a **b** c_ y");
  // Other italics still take Notion's `*`, and bold around italics is fine either way.
  assert.equal(toN("x _a_ and __b _c_ d__ y"), "x *a* and **b *c* d** y");
});

test("adjacent page links to the same page read back as one link, its texts joined with their formatting", () => {
  // Notion writes a link whose text is partly bold or partly code as one link per run (confirmed live,
  // a recorded live run).
  for (const exact of [false, true]) {
    const o = (s: string) => toObsidianInline(s, ctx, exact);
    assert.equal(o(`See [a ](${elmUrl})[**b**](${elmUrl})[ c](${elmUrl}) here`), "See [a **b** c](Elm.md) here", `exact ${exact}`);
    assert.equal(o(`[\`__slots__\`](${elmUrl})[ attribute](${elmUrl})`), "[`__slots__` attribute](Elm.md)", `exact ${exact}`);
    // Anything between two links, even one space, keeps them apart; so does another target.
    assert.equal(o(`[a](${elmUrl}) [b](${elmUrl})`), "[a](Elm.md) [b](Elm.md)", `exact ${exact}`);
    assert.equal(o(`[a](${elmUrl})[b](${soupUrl})`), "[a](Elm.md)[b](Soup-%20Tomato.md)", `exact ${exact}`);
    // A link the page holds as text is not a link to join.
    assert.equal(o(`\\[a\\](${elmUrl})[b](${elmUrl})`).endsWith("[b](Elm.md)"), true, `exact ${exact}`);
  }
});
