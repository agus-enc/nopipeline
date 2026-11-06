import { test } from "node:test";
import assert from "node:assert/strict";
import { rereadByNotion, rereadLines } from "../../src/translate/rereads.ts";
import { linkTextRereads } from "../../src/translate/inline.ts";
import { toNotion } from "../../src/translate/index.ts";
import { testContext } from "../helpers/context.ts";

const ctx = testContext();

test("lines Notion holds as written but reads as something else the next time the page is written (live probe)", () => {
  // As the translator writes them: escapes that keep a line from being a heading, a list, a divider or italics.
  for (const note of ["\\# Not a heading", "\\- not a list", "\\+ not a list", "1\\. not a list", "\\---", "an \\_escaped\\_ word", "x _a **b** c_ y", "- \\# an item's text", "![[x.png|a _b_ c]]"]) {
    assert.deepEqual(rereadByNotion(toNotion(note, ctx)).length, 1, note);
  }
  // As Notion writes them back: underscores that pair, italics around bold, a `+` list marker, a code span with a backtick.
  for (const page of ["_literal_ here", "x *a **b** c* y", "+ literal plus", "x `a \\` b` y"]) assert.deepEqual(rereadByNotion(page), [page], page);
  // What Notion reads back as itself.
  for (const fine of ["# Heading", "- item", "1) not a list", "snake_case and a_b", "*italic* and **bold**", "x **a *b* c** y", "x ***a*** y", "x _**a**_ y", "2 \\* 3", "`code_with_underscores`", "a \\~ b", "```python\n_x_\n```", "$$\n\\# x\n$$"]) {
    assert.deepEqual(rereadByNotion(toNotion(fine, ctx).includes("\n") ? fine : toNotion(fine, ctx)), [], fine);
  }
});

test("a line's reason names what Notion would make of it: italics around bold, which it can't hold", () => {
  assert.deepEqual(rereadLines(toNotion("x _a **b** c_ y", ctx)).map((r) => r.as), ["other emphasis (Notion can't hold italics around bold)"]);
  assert.deepEqual(rereadLines("_literal_ here").map((r) => r.as), ["italics"]);
  assert.deepEqual(rereadLines("# x\n\\# x").map((r) => r.as), ["a heading, a list item or a divider"]);
});

test("a URL or a link's text whose underscores pair: Notion cuts the link short or reads them as emphasis (live probes)", () => {
  // Notion made `see https://github.com/x/blob/main/__init__.py now` a link to `…/main/` and a bold "init".
  for (const note of ["see https://github.com/x/blob/main/__init__.py now", "see www.x.com/_a_ now", "see <https://x.com/_a_> now", "[a \\_b\\_ c](https://x.com)"]) {
    assert.equal(rereadByNotion(toNotion(note, ctx)).length, 1, note);
  }
  assert.deepEqual(rereadLines(toNotion("see https://x.com/__init__.py", ctx)).map((r) => r.as), ["a link cut short where its underscores or stars pair"]);
  // Underscores inside a word, a link's target, and emphasis written in a link's text are fine.
  for (const fine of ["see https://a.com/x_y_z now", "[a](https://x.com/__init__.py)", "[a _b_ c](https://x.com)", "see <https://x.com/a_b_c> now", "`https://x.com/__init__.py`"]) {
    assert.deepEqual(rereadByNotion(toNotion(fine, ctx)), [], fine);
  }
});

test("italics around bold with its own italics: Notion holds `*a ***b*** c*` with \"b\" bold but not italic (live probe)", () => {
  assert.deepEqual(rereadLines("x *a ***b*** c* y").map((r) => r.as), ["other emphasis (Notion can't hold italics around bold)"]);
  assert.deepEqual(rereadLines(toNotion("x _a ***b*** c_ y", ctx)).map((r) => r.as), ["other emphasis (Notion can't hold italics around bold)"]);
  // Each run of its own, which Notion holds right.
  assert.deepEqual(rereadByNotion("x *a* ***b*** *c* y"), []);
});

test("linkTextRereads: a link's text, as the translator writes it, whose underscores pair once Notion drops their backslashes", () => {
  assert.equal(linkTextRereads("a \\_x\\_ b"), true);
  assert.equal(linkTextRereads("Elm"), false);
});
