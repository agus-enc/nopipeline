// Edits carried between notes and pages that write the same lines in other forms, including forms the
// translator writes as more lines or fewer (final review C1, second round): each edit lands on its own line,
// or it isn't placed at all. Seeded, so a failure always reproduces.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { transplant } from "../../src/merge/lines.ts";
import { pullResult, pushResult } from "../../src/run/content.ts";
import { toNotion, toObsidian } from "../../src/translate/index.ts";
import type { SyncRecord } from "../../src/types.ts";
import { testContext } from "../helpers/context.ts";
import { asNotionKeeps } from "../helpers/fake-notion.ts";
import { edit, sampleNote, inNotion, inObsidian, notionPage, reshapedNote, type EditKind } from "../helpers/notes.ts";

const ctx = testContext();
const lines = (text: string) => text.split("\n");
const record = (body: string, markdown: string): SyncRecord => ({
  notionId: "n",
  path: "Notes/Current.md",
  title: "Current",
  folder: "Notes",
  obsidianText: body,
  notionMarkdown: markdown,
  notionSeenAt: "2026-09-27T04:00:00.000Z",
  syncedAt: "2026-09-27T04:00:00.000Z",
});

/** The page Notion keeps for a note: nested code flush left, code languages under Notion's names. */
const kept = (note: string) => asNotionKeeps(toNotion(note, ctx));

/**
 * A Notion edit to the page as Notion keeps it, pulled into `body`, gives a note that Notion would keep as
 * exactly its new text, or nothing (final review, third round N7: the pages are in Notion's kept form).
 */
function pulledRightOrNot(body: string, change: { at: number; kind: EditKind }): void {
  const before = kept(body);
  const after = inNotion(before, change);
  // Only edits the translator writes back as they are: a sync can carry those line by line.
  fc.pre(after !== null && after !== before && kept(toObsidian(after, ctx)) === after);
  const raw = transplant(lines(toObsidian(before, ctx)), lines(toObsidian(after!, ctx)), lines(body));
  if (raw !== null) assert.equal(kept(raw.join("\n")), after, "the line matching places the edit on its own line");
  const pulled = pullResult(record(body, before), body, after!, ctx);
  if (pulled !== null) assert.equal(kept(pulled), after, "the pull places the edit on its own line");
}

test("r4: a Notion edit pulled into a note like a typical vault's, with code blocks inside quotes, lands on its own line or isn't placed", () => {
  fc.assert(fc.property(sampleNote, edit, pulledRightOrNot), { seed: 4, numRuns: 400 });
});

test("r3: a Notion edit pulled into a note the translator writes in more lines or fewer lands on its own line or isn't placed", () => {
  fc.assert(fc.property(reshapedNote, edit, pulledRightOrNot), { seed: 3, numRuns: 400 });
});

test("r7: an Obsidian edit pushed onto a page written in Notion changes only the edited block, or nothing", () => {
  fc.assert(
    fc.property(notionPage, edit, (page, change) => {
      const body = toObsidian(page, ctx);
      const edited = inObsidian(body, change);
      fc.pre(edited !== null && toNotion(edited, ctx) !== toNotion(body, ctx));
      const want = toObsidian(toNotion(edited!, ctx), ctx);
      const check = (result: string | null, by: string) => {
        if (result === null) return;
        assert.equal(toObsidian(result, ctx), want, `${by}: Obsidian reads the page as the edited note`);
        // Outside the edited block (a callout that became a quote is three lines), the page is as it was.
        const [p, r] = [lines(page), lines(result)];
        let head = 0;
        while (head < p.length && head < r.length && p[head] === r[head]) head++;
        let tail = 0;
        while (tail < p.length - head && tail < r.length - head && p[p.length - 1 - tail] === r[r.length - 1 - tail]) tail++;
        assert.ok(p.length - head - tail <= 3, `${by}: the page changed in one place`);
      };
      check(transplant(lines(toNotion(body, ctx)), lines(toNotion(edited!, ctx)), lines(page), undefined, "page")?.join("\n") ?? null, "the line matching");
      check(pushResult(record(body, page), edited!, page, ctx), "the push");
    }),
    { seed: 7, numRuns: 400 },
  );
});
