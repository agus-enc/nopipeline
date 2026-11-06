import { test } from "node:test";
import assert from "node:assert/strict";
import { keepLinkForms, retitleLinks, rewriteLinks } from "../../src/links/rewrite.ts";
import { testContext } from "../helpers/context.ts";

const rule = {
  matches: (target: string) => ["old name", "folder/old name", "folder/old name.md"].includes(target.toLowerCase()),
  wikiText: "New Name",
  path: "Folder/New Name.md",
};

test("wikilinks, embeds, anchors and aliases are rewritten", () => {
  assert.equal(
    rewriteLinks("See [[Old Name]], ![[Folder/Old Name]], [[old name#Part|alias]] and [[Other]].", rule),
    "See [[New Name]], ![[New Name]], [[New Name#Part|alias]] and [[Other]].",
  );
});

test("Markdown links get the new encoded path", () => {
  assert.equal(rewriteLinks("[text](Folder/Old%20Name.md#Part) [web](https://x.com/Old%20Name)", rule), "[text](Folder/New%20Name.md#Part) [web](https://x.com/Old%20Name)");
  assert.equal(rewriteLinks('[text](Folder/Old%20Name.md "a title")', rule), '[text](Folder/New%20Name.md "a title")');
});

test("a rename rewrites the text of a link that reads the old title, or the old title and a heading; other text stays", () => {
  const bee = { matches: (target: string) => target.toLowerCase() === "b", wikiText: "Bee note", path: "Bee note.md", title: { from: "B", to: "Bee note" } };
  assert.equal(rewriteLinks("[B](B.md) [bee](B.md) [B › H](B.md#H)", bee), "[Bee note](Bee%20note.md) [bee](Bee%20note.md) [Bee note › H](Bee%20note.md#H)");
  // Text with brackets is matched unescaped and written escaped; an embed's text is not a link's text.
  const brackets = { ...bee, title: { from: "B [1]", to: "Bee [2]" } };
  assert.equal(rewriteLinks("[B \\[1\\]](B.md) ![B \\[1\\]](B.md)", brackets), "[Bee \\[2\\]](Bee%20note.md) ![B \\[1\\]](Bee%20note.md)");
});

test("a destination with parentheses is written encoded, so a later rewrite finds it again", () => {
  const plan = { matches: (target: string) => target.toLowerCase() === "draft", wikiText: "Draft (2)", path: "x/Draft (2).md" };
  const once = rewriteLinks("[Draft](Draft.md#Step%201)", plan);
  assert.equal(once, "[Draft](x/Draft%20%282%29.md#Step%201)");
  const later = { matches: (target: string) => target.toLowerCase() === "x/draft (2)", wikiText: "Draft 3", path: "Draft 3.md" };
  assert.equal(rewriteLinks(once, later), "[Draft](Draft%203.md#Step%201)");
});

test("retitleLinks changes only the text of links to the note that read the old title", () => {
  assert.equal(retitleLinks("[B](C.md) [b](C.md)", (t) => t === "C", "B", "C"), "[C](C.md) [b](C.md)");
  assert.equal(retitleLinks("[B › H](C.md#H) [B](D.md) `[B](C.md)` [B](https://x.com/C)", (t) => t === "C", "B", "C"), "[C › H](C.md#H) [B](D.md) `[B](C.md)` [B](https://x.com/C)");
});

test("code is left alone", () => {
  const body = "`[[Old Name]]` and [[Old Name]]\n```\n[[Old Name]]\n```";
  assert.equal(rewriteLinks(body, rule), "`[[Old Name]]` and [[New Name]]\n```\n[[Old Name]]\n```");
  // A fence closes only on a line holding nothing but the fence; a code span closes at a run of the same length.
  const nested = "```\n```md example with [[Old Name]]\nstill code: [[Old Name]]\n```\nafter [[Old Name]]";
  assert.equal(rewriteLinks(nested, rule), "```\n```md example with [[Old Name]]\nstill code: [[Old Name]]\n```\nafter [[New Name]]");
  assert.equal(rewriteLinks("See ``code ` here [[Old Name]] end`` and [[Old Name]]", rule), "See ``code ` here [[Old Name]] end`` and [[New Name]]");
  assert.equal(rewriteLinks("a ` lone [[Old Name]]", rule), "a ` lone [[New Name]]");
});

test("a line pulled from Notion keeps the note's Markdown links, but not its [[links]]", () => {
  const { index, fromPath } = testContext();
  assert.equal(keepLinkForms("See [Elm](Elm.md) now", "See [Elm](Grove/Elm.md)", index, fromPath), "See [Elm](Grove/Elm.md) now");
  assert.equal(keepLinkForms("See [Elm](Elm.md) now", "See [[Elm]]", index, fromPath), "See [Elm](Elm.md) now");
  assert.equal(keepLinkForms("See [shadowed](Elm.md) now", "See [[Grove/Elm|shadowed]]", index, fromPath), "See [shadowed](Elm.md) now");
  // Embeds and block links, which stay [[ ]] in the vault, keep their form.
  assert.equal(keepLinkForms("![[Elm]] and [Elm › Bark](Elm.md#Bark)", "![[Grove/Elm|Elm]] and [Elm › Bark](Elm.md#Bark)", index, fromPath), "![[Grove/Elm|Elm]] and [Elm › Bark](Elm.md#Bark)");
  assert.equal(keepLinkForms("See [the block](Elm.md) now", "See [[Elm#^abc123|the block]]", index, fromPath), "See [[Elm#^abc123|the block]] now");
});
