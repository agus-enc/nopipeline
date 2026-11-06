import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLinkIndex } from "../../src/links/index.ts";
import { literalLinks, noteLinks, noteLiterals, relink } from "../../src/links/relink.ts";
import { toNotionInline } from "../../src/translate/inline.ts";

test("noteLiterals: the [[links]] a note's links are written as while their notes have no page", () => {
  assert.deepEqual(noteLiterals("See [Later](Later.md) and [soon](Later.md) and [[Other]]"), new Set(["[[Later]]", "[[Later|soon]]", "[[Other]]"]));
  // Web links add nothing.
  assert.deepEqual(noteLiterals("See [the site](https://example.com) and <https://x.org> and [mail](mailto:a@b.c)"), new Set());
});

test("noteLiterals reads a Markdown link's destination and text as the translator writes its literal", () => {
  // A folder path, an encoded name, a heading, and text the translator collapses (the base name, or `name › heading`);
  // text with the folder is kept (final review).
  assert.deepEqual(
    noteLiterals("[Draft](Archive/Draft%20%282%29.md) [x](Sub/Note.md#Part%20one) [Note › Part](Note.md#Part) [Sub/Note](Sub/Note.md) [a \\[b\\] c](N.md)"),
    new Set(["[[Archive/Draft (2)|Draft]]", "[[Sub/Note#Part one|x]]", "[[Note#Part]]", "[[Sub/Note|Sub/Note]]", "[[N|a [b] c]]"]),
  );
  // Not read: links in code, escaped links, images, attachments, and same-note heading links.
  assert.deepEqual(noteLiterals("`[A](A.md)` \\[B](B.md) ![C](C.md) [pic](img.png) [top](#Top)\n\n```\n[D](D.md)\n```\n"), new Set());
});

test("noteLiterals finds each literal relink looks for in the translator's output", () => {
  // The literal toNotionInline writes for a link to a note without a page reads back as the same [[link]], text
  // with brackets (`]]` too), a pipe or underscores included, and a destination without `.md` naming such a note.
  const ctx = { index: buildLinkIndex([{ path: "Later.md", pageId: null, title: "Later" }]), fromPath: "A.md", vaultName: "DemoVault" };
  const bodies = ["[Later](Later.md)", "[soon](Later.md)", "[x](Later)", "[a \\[b\\] c](N.md)", "[a \\]\\] b](N.md)", "[Draft \\[2\\]](Draft%20%5B2%5D.md)", "[x | _y_](Soup-%20Tomato.md#Part)", "[Folder/Missing](Folder/Missing.md)", "[Missing](Folder/Missing.md)", "[[Other]]"];
  for (const body of bodies) {
    const page = toNotionInline(body, ctx);
    assert.match(page, /^\\\[\\\[/, body);
    const literals = noteLiterals(body);
    assert.deepEqual(literalLinks(page, (link) => literals.has(link)).map((l) => l.link), [...literals], body);
  }
});

test("noteLinks keeps each literal's links as the note writes them", () => {
  assert.deepEqual(
    noteLinks("[Note › Part](Sub/Note.md#Part) and [[Sub/Note#Part]] and [Note › Part](<Sub/Note.md#Part>)"),
    new Map([["[[Sub/Note#Part]]", ["[[Sub/Note#Part]]", "[Note › Part](Sub/Note.md#Part)", "[Note › Part](<Sub/Note.md#Part>)"]]]),
  );
});

test("relink replaces a literal the note writes as a link by the translation of the note's link", () => {
  const translate = (link: string) => (/^\[[^\]]*\]\(Later\.md|^\[\[Later/.test(link) ? `<${link}>` : `\\[\\[${link}\\]\\]`);
  assert.equal(relink("See \\[\\[Later\\]\\]", "See [Later](Later.md)", translate), "See <[Later](Later.md)>");
  assert.equal(relink("See \\[\\[Later|soon\\]\\] and \\[\\[Draft \\[2\\]\\]\\]", "See [soon](Later.md) and [Draft \\[2\\]](Draft%20%5B2%5D.md)", translate), "See <[soon](Later.md)> and \\[\\[Draft \\[2\\]\\]\\]");
  // A literal the note doesn't write as a link, or one that still has no page, stays.
  assert.equal(relink("See \\[\\[Later\\]\\] and \\[\\[Gone\\]\\]", "See \\[\\[Later\\]\\] and [Gone](Gone.md)", translate), "See \\[\\[Later\\]\\] and \\[\\[Gone\\]\\]");
  // Two links the note writes as one literal whose translations differ: which one it was can't be told, so it stays.
  assert.equal(relink("See \\[\\[Later\\]\\]", "See [Later](Later.md) and [[Later]]", translate), "See \\[\\[Later\\]\\]");
  // The same link written twice is one translation.
  assert.equal(relink("See \\[\\[Later\\]\\]", "See [Later](Later.md) and [Later](Later.md)", translate), "See <[Later](Later.md)>");
});
