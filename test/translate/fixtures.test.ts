// Real Notion output recorded by scripts/probe.ts. For every fixture: its Obsidian form translates the
// same way twice (once the translator has written it: Notion's own text can hold a `*` the translator writes
// escaped); an edit to one line in Notion changes exactly one line of the note; and an edit to one line in
// Obsidian changes exactly one line of the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pullResult, pushResult } from "../../src/run/content.ts";
import { toNotion, toObsidian } from "../../src/translate/index.ts";
import type { SyncRecord } from "../../src/types.ts";
import { testContext } from "../helpers/context.ts";

const DIR = "test/fixtures/notion";
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".md")) : [];

/** Appends " edited" to the last word of the first line that has one outside tags and URLs; -1 if none. */
function editOneLine(lines: string[]): [string[], number] {
  for (let k = 0; k < lines.length; k++) {
    const visible = lines[k]!.replace(/<[^>]*>/g, "").replace(/\]\([^)]*\)/g, "]").replace(/\{[^}]*\}/g, "");
    const words = [...visible.matchAll(/[\p{L}\p{N}]+/gu)];
    if (!words.length) continue;
    const last = words[words.length - 1]![0];
    const at = lines[k]!.lastIndexOf(last);
    if (at === -1) continue;
    const edited = lines[k]!.slice(0, at + last.length) + " edited" + lines[k]!.slice(at + last.length);
    return [lines.map((l, i) => (i === k ? edited : l)), k];
  }
  return [lines, -1];
}

const changedLines = (a: string[], b: string[]) => a.filter((l, i) => l !== b[i]).length;

for (const file of files) {
  test(`recorded Notion output: ${file}`, () => {
    const ctx = testContext();
    const markdown = readFileSync(join(DIR, file), "utf8");
    const body = toObsidian(markdown, ctx);
    const written = toObsidian(toNotion(body, ctx), ctx);
    assert.equal(toObsidian(toNotion(written, ctx), ctx), written, "the Obsidian form translates the same way twice");
    const record: SyncRecord = {
      notionId: "fixture",
      path: "Notes/Current.md",
      title: "Current",
      folder: "Notes",
      obsidianText: body,
      notionMarkdown: markdown,
      notionSeenAt: "2026-09-27T00:00:00.000Z",
      syncedAt: "2026-09-27T00:00:00.000Z",
    };
    const [notionEdit, n] = editOneLine(markdown.split("\n"));
    assert.notEqual(n, -1, "the fixture has a line to edit");
    const pulled = pullResult(record, body, notionEdit.join("\n"), ctx)!.split("\n");
    assert.equal(pulled.length, body.split("\n").length);
    assert.equal(changedLines(pulled, body.split("\n")), 1, "a one-line edit in Notion changes one line of the note");
    const [obsidianEdit, o] = editOneLine(body.split("\n"));
    assert.notEqual(o, -1, "the note has a line to edit");
    const after = pushResult(record, obsidianEdit.join("\n"), markdown, ctx)!.split("\n");
    assert.equal(after.length, markdown.split("\n").length);
    assert.equal(changedLines(after, markdown.split("\n")), 1, "a one-line edit in Obsidian changes one line of the page");
  });
}
