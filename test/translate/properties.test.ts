// Randomized notes built from the constructs DemoVault uses: translating to Notion and back keeps
// every word, and a second round trip gives exactly the same Notion text.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { convertBody } from "../../src/links/convert.ts";
import { toNotion, toObsidian, words } from "../../src/translate/index.ts";
import { testContext } from "../helpers/context.ts";

const ctx = testContext();
const word = fc.constantFrom("alpha", "beta", "gamma", "delta", "numéro", "Elm", "x2", "value");
const text = fc.array(word, { minLength: 1, maxLength: 5 }).map((w) => w.join(" "));
const inline = fc.oneof(
  text,
  text.map((t) => `**${t}**`),
  text.map((t) => `*${t}*`),
  text.map((t) => `\`${t}\``),
  text.map((t) => `==${t}==`),
  fc.constantFrom("[[Elm]]", "[[Soup- Tomato|Soup: Tomato]]", "[[Elm|shadowed]]", "[[Missing note]]", "![[Floor Plan]]", "a < b", "{x}", "1 | 2", "^tag"),
  // [[links]] that conversion must leave alone (math) or write so they read as before (final review).
  fc.constantFrom("$[[Elm]]$", "$x^2$", "costs $5", "[[Elm|a *b* c]]", "[[Elm|__dict__ keys]]", "[[Elm|kv_store]]", "[[Missing note|a *b*]]"),
  // Markdown links, the form the vault keeps (design §8): to notes with pages, with a heading, to a drawing, and to
  // no note (with and without their own text and a heading); text with escaped brackets, and text bold or code in part.
  // Two links to the same page side by side read back as one: that pair has a test of its own below.
  fc.constantFrom(
    "[Elm](Elm.md)",
    "[shadowed](Grove/Elm.md)",
    "[Soup: Tomato](Soup-%20Tomato.md)",
    "[Draft](Draft%20%282%29.md)",
    "[Elm › Bark](Elm.md#Bark)",
    "[x](Floor%20Plan.md)",
    "[Not written yet](Not%20written%20yet.md)",
    "[later](Not%20written%20yet.md)",
    "[Not written yet › Some heading](Not%20written%20yet.md#Some%20heading)",
    "[later](Not%20written%20yet.md#Some%20heading)",
    "[Missing](Folder/Missing.md)",
    "[Folder/Missing](Folder/Missing.md)",
    "[Folder/Missing › H](Folder/Missing.md#H)",
    "[\\[draft\\] x](Elm.md)",
    "[a **b** c](Elm.md)",
    "[`code` word](Elm.md)",
  ),
);
const sentence = fc.array(inline, { minLength: 1, maxLength: 4 }).map((parts) => parts.join(" "));
const block = fc.oneof(
  sentence,
  fc.tuple(fc.integer({ min: 1, max: 4 }), text).map(([level, t]) => `${"#".repeat(level)} ${t}`),
  fc.array(sentence, { minLength: 1, maxLength: 3 }).map((items) => items.map((s) => `- ${s}`).join("\n")),
  fc.array(sentence, { minLength: 1, maxLength: 3 }).map((items) => items.map((s, k) => `${k + 1}. ${s}`).join("\n")),
  fc.tuple(fc.boolean(), sentence).map(([done, s]) => `- [${done ? "x" : " "}] ${s}`),
  fc.tuple(sentence, sentence).map(([a, b]) => `- ${a}\n\t- ${b}`),
  text.map((t) => `> ${t}`),
  fc.tuple(fc.constantFrom("note", "warning", "tip"), text, sentence).map(([kind, title, body]) => `> [!${kind}] ${title}\n> ${body}`),
  text.map((t) => `\`\`\`\n${t} | <raw>\n\`\`\``),
  text.map((t) => `$$\n${t} [[Elm]]\n$$`),
  fc.tuple(text, text).map(([a, b]) => `| ${a} | ${b} |\n| --- | --- |\n| ${b} | ${a} |`),
);
const note = fc.array(block, { minLength: 1, maxLength: 6 }).map((blocks) => `${blocks.join("\n\n")}\n`);

const visibleWords = (s: string) => words(s.replace(/\]\([^)]*\)/g, "]").replace(/\[\[([^\]|]*)\|/g, "[[").replace(/\[![\w-]+\][+-]?/g, ""));

test("a round trip through Notion keeps every word of a note", () => {
  fc.assert(
    fc.property(note, (body) => {
      assert.equal(visibleWords(toObsidian(toNotion(body, ctx), ctx)), visibleWords(body));
    }),
  );
});

test("translating a translated note again gives the same Notion text", () => {
  fc.assert(
    fc.property(note, (body) => {
      const once = toNotion(body, ctx);
      assert.equal(toNotion(toObsidian(once, ctx), ctx), once);
    }),
  );
});

test("converting a note's [[links]] leaves its Notion text as it was", () => {
  fc.assert(
    fc.property(note, (body) => {
      assert.equal(toNotion(convertBody(body, ctx.index, ctx.fromPath).body, ctx), toNotion(body, ctx));
    }),
  );
});

test("two links to the same page side by side read back as one link, their texts joined", () => {
  // Notion writes a link whose text is formatted in part as one link per run, so it can't tell such a pair apart.
  const body = "See [Elm](Elm.md)[Elm](Elm.md) here\n";
  const once = toNotion(body, ctx);
  assert.equal(toObsidian(once, ctx), "See [ElmElm](Elm.md) here\n");
  assert.equal(toNotion(toObsidian(once, ctx), ctx), "See [ElmElm](https://app.notion.com/p/cb56bbf0dc78488685536285651b9f5d) here");
});
