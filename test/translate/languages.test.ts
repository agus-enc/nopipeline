// Code block languages under Notion's names, as the live probe recorded them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keptByNotion } from "../../src/translate/index.ts";
import { notionLanguage } from "../../src/translate/languages.ts";

const probe = JSON.parse(readFileSync("test/fixtures/notion/code-languages.json", "utf8")) as { fences: { nested: boolean; sent: string; kept: string }[] };

test("every language DemoVault uses, and a few common ones, is named as Notion keeps it", () => {
  assert.ok(probe.fences.length >= 50);
  for (const { sent, kept } of probe.fences) assert.equal(notionLanguage(sent), kept, JSON.stringify(sent));
  // Anything Notion doesn't know is its default, javascript.
  assert.equal(notionLanguage("Build log, part 2"), "javascript");
  assert.equal(notionLanguage("  Python "), "python");
});

test("the page Notion keeps for the translator's markdown: languages under Notion's names, nested code flush left", () => {
  const sent = ["```js", "\tlet x = 1", "```", "- step", "\t```Bash", "\t\techo $HOME", "\t\t", "\t```", ">", "\t```", "\tplain", "\t```"].join("\n");
  const kept = ["```javascript", "\tlet x = 1", "```", "- step", "\t```bash", "\techo $HOME", "\t", "\t```", ">", "\t```javascript", "plain", "\t```"].join("\n");
  assert.equal(keptByNotion(sent), kept);
});
