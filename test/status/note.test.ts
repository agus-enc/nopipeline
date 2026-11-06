import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { adviceFor } from "../../src/status/advice.ts";
import { notionUrl, obsidianLink, renderStatusNote, STATUS_MARKER, writeStatusNote, type StatusInput } from "../../src/status/note.ts";
import { tempDir } from "../helpers/tmp.ts";

const ID = "a50245e9-8e6a-41aa-8ccf-d8795ed0dead";

function outcome(over: { skipped?: { path: string; reason: string }[]; conflicts?: string[]; held?: { pageId: string; path: string; side: "notion" | "vault" }[]; heldFiles?: string[]; notes?: { path: string; notionId: string | null }[]; done?: Record<string, number>; summary?: boolean }): any {
  return {
    plan: { actions: [], warnings: ["a warning"].slice(0, 0), heldTrashes: over.held?.length ?? 0, held: over.held, heldFiles: over.heldFiles },
    summary:
      over.summary === false
        ? null
        : { done: over.done ?? { updatePage: 3 }, conflicts: over.conflicts ?? [], skipped: over.skipped ?? [], rewritten: [], linksTo: 0, skippedPages: [], trashedPages: [], mediaUploaded: 0, mediaUpdated: [], mediaMoved: [], mediaRekeyed: [] },
    notes: (over.notes ?? []).map((n) => ({ ...n, text: "", body: "", notionTitle: null })),
    pages: [],
  };
}

const base = (over: Partial<StatusInput>): StatusInput => ({
  kind: "sync",
  at: new Date(2026, 10, 5, 21, 10),
  profile: "config",
  stateDir: "/state",
  notePath: "nopipeline status.md",
  report: "Done:\n  3 × x",
  exitCode: 0,
  ...over,
});

test("a clean sync", () => {
  const text = renderStatusNote(base({ outcome: outcome({}) }));
  assert.match(text, /^---\nnopipeline: status\n---\n# nopipeline status\n/);
  assert.match(text, /^Synced \d{4}-\d\d-\d\d \d\d:\d\d — 3 changes\.$/m);
  assert.doesNotMatch(text, /## Needs a look/);
  assert.match(text, /## What changed/);
  assert.match(text, /\/state\/last-run\.log/);
});

test("waiting notes get their own section, each as a link; without any the note has none", () => {
  const withWaiting = outcome({});
  withWaiting.plan.waiting = ["Folder/My note.md"];
  const text = renderStatusNote(base({ outcome: withWaiting }));
  assert.doesNotMatch(text, /## Needs a look/, "waiting notes need no look");
  assert.match(text, /\n## Waiting\n\n.*\n\n- \[Folder\/My note\.md\]\(Folder\/My%20note\.md\)/);
  assert.doesNotMatch(renderStatusNote(base({ outcome: outcome({}) })), /## Waiting/);
});

test("skips link to the note and the page, with advice", () => {
  const reason = "not_matched: Obsidian's edit …";
  const text = renderStatusNote(base({ outcome: outcome({ skipped: [{ path: "Folder/My note #1.md", reason }], notes: [{ path: "Folder/My note #1.md", notionId: ID }] }) }));
  assert.match(text, /## Needs a look/);
  assert.ok(text.includes("[Folder/My note #1.md](Folder/My%20note%20%231.md)"));
  assert.ok(text.includes("[Open in Notion](https://app.notion.com/p/a50245e98e6a41aa8ccfd8795ed0dead)"));
  assert.ok(text.includes(`What to do: ${adviceFor("not_matched: x")}`));
  assert.ok(text.includes(reason));
});

test("no Notion link when the page id is unknown", () => {
  const text = renderStatusNote(base({ outcome: outcome({ skipped: [{ path: "A.md", reason: "truncated: big" }] }) }));
  assert.doesNotMatch(text, /Open in Notion/);
});

test("links are relative to the status note's folder", () => {
  const text = renderStatusNote(base({ notePath: "Meta/status.md", outcome: outcome({ skipped: [{ path: "A/B.md", reason: "path_taken: x" }] }) }));
  assert.ok(text.includes("](../A/B.md)"));
  assert.equal(obsidianLink("Meta/status.md", "Meta/C.md"), "[Meta/C.md](C.md)");
  assert.equal(obsidianLink("s.md", "a [b].md"), "[a \\[b\\].md](a%20%5Bb%5D.md)");
  assert.equal(notionUrl(ID), "https://app.notion.com/p/a50245e98e6a41aa8ccfd8795ed0dead");
});

test("conflicts link the note and the copy", () => {
  const copy = "Dir/Memo (Notion conflict 2026-11-05).md";
  const text = renderStatusNote(base({ outcome: outcome({ conflicts: [copy] }) }));
  assert.ok(text.includes("[Dir/Memo.md](Dir/Memo.md)"));
  assert.ok(text.includes("(Dir/Memo%20%28Notion%20conflict%202026-11-05%29.md)"));
});

test("held trashes list each item and how to go ahead", () => {
  const held = [
    { pageId: "p1", path: "A/gone.md", side: "notion" as const },
    { pageId: "p2", path: "B/x.md", side: "vault" as const },
  ];
  const text = renderStatusNote(base({ outcome: outcome({ held, heldFiles: ["img/a.png"] }) }));
  assert.match(text, /^Stopped — 2 notes would be trashed and 1 attachment moved to \.trash\. Nothing was trashed or moved\.$/m);
  assert.ok(text.includes("- trash the Notion page of A/gone.md (deleted in Obsidian)"));
  assert.ok(text.includes("- move [B/x.md](B/x.md) to .trash (its page was trashed in Notion)"));
  assert.ok(text.includes("- move [img/a.png](img/a.png) to .trash (no note cites it)"));
  assert.ok(text.includes("To go ahead: right-click the launcher → Confirm held changes, or run `nopipeline confirm`."));
});

test("a preview's held section doesn't send the user to Confirm", () => {
  const held = [{ pageId: "p1", path: "A/gone.md", side: "notion" as const }];
  const preview = renderStatusNote(base({ kind: "preview", outcome: outcome({ held, summary: false }) }));
  assert.ok(preview.includes("A real sync would stop here. To go ahead: run the sync (click the launcher), then right-click → Confirm held changes, or run `nopipeline confirm`."));
  assert.doesNotMatch(preview, /^To go ahead:/m);
  const real = renderStatusNote(base({ outcome: outcome({ held }) }));
  assert.match(real, /^To go ahead: right-click the launcher/m);
  assert.doesNotMatch(real, /A real sync would stop here/);
});

test("held attachments alone, or with notes, make the headline say it stopped", () => {
  const files = Array.from({ length: 11 }, (_, i) => `img/${i}.png`);
  const only = renderStatusNote(base({ outcome: outcome({ heldFiles: files }) }));
  assert.match(only, /^Stopped — 11 attachments would be moved to \.trash\. Nothing was moved\.$/m);
  assert.doesNotMatch(only, /^Synced/m);
  const one = renderStatusNote(base({ outcome: outcome({ heldFiles: ["img/a.png"] }) }));
  assert.match(one, /^Stopped — 1 attachment would be moved to \.trash\. Nothing was moved\.$/m);
  const both = renderStatusNote(base({ outcome: outcome({ heldFiles: files, held: [{ pageId: "p1", path: "A.md", side: "notion" }] }) }));
  assert.match(both, /^Stopped — 1 note would be trashed and 11 attachments moved to \.trash\. Nothing was trashed or moved\.$/m);
});

test("preview and first run", () => {
  const preview = renderStatusNote(base({ kind: "preview", outcome: outcome({ summary: false }) }));
  assert.match(preview, /^Preview — 0 changes, nothing was written\.$/m);
  assert.match(preview, /## Plan/);
  const first = renderStatusNote(base({ kind: "first-run", outcome: outcome({ summary: false }) }));
  assert.match(first, /^First run of this profile — preview only\.$/m);
  assert.match(first, /To go ahead:/);
});

test("failed", () => {
  const text = renderStatusNote(base({ kind: "failed", error: "Notion said 401", exitCode: 2 }));
  assert.match(text, /^Failed — Notion said 401\.$/m);
});

test("every README skip code has advice", () => {
  const fallback = adviceFor("nope: x");
  assert.equal(fallback, 'See "When a note is skipped" in the README.');
  for (const code of ["not_matched", "unsupported_blocks", "changed_in_obsidian", "changed_in_notion", "path_taken", "still_in_notion", "truncated", "unreadable_mention", "notion_rereads", "download_failed", "validation_error", "conflict_error", "object_not_found", "restricted_resource"]) {
    const line = adviceFor(`${code}: whatever`);
    assert.notEqual(line, fallback, code);
    assert.doesNotMatch(line, /\n/);
  }
});

test("writeStatusNote never overwrites a note of the user's", async (t) => {
  const vault = await tempDir(t);
  const path = "nopipeline status.md";
  await writeFile(join(vault, path), "Hello", "utf8");
  assert.equal(await writeStatusNote(vault, path, `---\n${STATUS_MARKER}\n---\nx`), "taken");
  assert.equal(await readFile(join(vault, path), "utf8"), "Hello");
  await writeFile(join(vault, path), `---\n${STATUS_MARKER}\n---\nold`, "utf8");
  assert.equal(await writeStatusNote(vault, path, `---\n${STATUS_MARKER}\n---\nnew`), "written");
  assert.match(await readFile(join(vault, path), "utf8"), /new$/);
  assert.equal(await writeStatusNote(vault, "Sub/dir/s.md", "t"), "written");
  assert.equal(await readFile(join(vault, "Sub/dir/s.md"), "utf8"), "t");
  await mkdir(join(vault, "x"));
});
