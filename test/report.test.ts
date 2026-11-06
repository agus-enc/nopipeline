import { test } from "node:test";
import assert from "node:assert/strict";
import type { Plan } from "../src/plan/planner.ts";
import { exitCode, formatMediaPlan, formatPlan, formatSummary } from "../src/report.ts";
import type { VaultNote } from "../src/types.ts";

const notes: VaultNote[] = [{ path: "Notes/N.md", text: "", body: "", notionId: "p1", notionTitle: null }];

test("formatPlan lists each change with the note it touches", () => {
  const plan: Plan = {
    actions: [
      { kind: "createPage", path: "A.md" },
      { kind: "push", pageId: "p1" },
      { kind: "moveInVault", pageId: "p2", from: "B.md", to: "C/B.md" },
      { kind: "pair", pageId: "p3", path: "D.md", same: false },
      { kind: "relink", pageId: "p1" },
    ],
    warnings: ["careful"],
    heldTrashes: 0,
  };
  assert.equal(
    formatPlan(plan, notes, []),
    [
      "Plan (5 changes):",
      "  create Notion page for A.md",
      "  update Notion from Notes/N.md",
      "  rename/move note B.md -> C/B.md",
      "  pair D.md with its Notion page (texts differ: conflict copy)",
      "  turn links to notes that now exist into Notion links in Notes/N.md",
      "warning: careful",
    ].join("\n"),
  );
  const a: VaultNote[] = [{ path: "A.md", text: "", body: "", notionId: "pa", notionTitle: null }];
  assert.match(formatPlan({ actions: [{ kind: "relink", pageId: "pa" }], warnings: [], heldTrashes: 0 }, a, []), /\n {2}turn links to notes that now exist into Notion links in A\.md$/);
  assert.equal(formatPlan({ actions: [], warnings: [], heldTrashes: 0 }, [], []), "Plan (0 changes):\n  nothing to do");
});

test("formatSummary reports what was done, conflicts and skipped notes", () => {
  const plan: Plan = { actions: [], warnings: [], heldTrashes: 0 };
  assert.equal(formatSummary({ done: {}, conflicts: [], skipped: [], rewritten: [], linksTo: 0, skippedPages: [], trashedPages: [], mediaUpdated: [], mediaMoved: [], mediaUploaded: 0, mediaRekeyed: [] }, plan), "Everything was already in sync.");
  assert.equal(
    formatSummary({ done: { push: 2, pull: 1 }, conflicts: ["B (Notion conflict 2026-09-27).md"], skipped: [{ path: "C.md", reason: "validation_error: refused" }], rewritten: [], linksTo: 0, skippedPages: [], trashedPages: [], mediaUpdated: [], mediaMoved: [], mediaUploaded: 0, mediaRekeyed: [] }, plan),
    [
      "Done:",
      "  2 × Notion page updated from its note",
      "  1 × note updated from its Notion page",
      "Conflicts (Obsidian's text was kept; merge these copies by hand):",
      "  B (Notion conflict 2026-09-27).md",
      "Skipped:",
      "  C.md: validation_error: refused",
    ].join("\n"),
  );
});

test("formatSummary and formatPlan list the waiting notes; only waiting notes leave exit code 0", () => {
  const plan: Plan = { actions: [], warnings: [], heldTrashes: 0, waiting: ["A.md"] };
  const empty = { done: {}, conflicts: [], skipped: [], rewritten: [], linksTo: 0, skippedPages: [], trashedPages: [], mediaUpdated: [], mediaMoved: [], mediaUploaded: 0, mediaRekeyed: [] };
  const header = "Waiting (open in Obsidian or edited in the last 5 minutes; they sync on a later run):";
  assert.equal(formatSummary(empty, plan), `Everything was already in sync.\n${header}\n  A.md`);
  assert.ok(formatPlan(plan, [], []).endsWith(`${header}\n  A.md`));
  assert.equal(exitCode(empty, plan), 0);
});

test("formatSummary lists the files updated on pages, of any kind, and the unused ones moved to .trash", () => {
  const plan: Plan = { actions: [], warnings: ["N files would be moved"], heldTrashes: 0 };
  const empty = { done: {}, conflicts: [], skipped: [], rewritten: [], linksTo: 0, skippedPages: [], trashedPages: [], mediaUploaded: 0, mediaRekeyed: [] };
  assert.equal(
    formatSummary({ ...empty, done: { push: 1 }, mediaUpdated: [{ path: "M/a.png", pages: 2 }, { path: "M/Manual.pdf", pages: 1 }], mediaMoved: ["M/c.docx"] }, plan),
    ["Done:", "  1 × Notion page updated from its note", "  updated file M/a.png on 2 pages", "  updated file M/Manual.pdf on 1 page", "  moved M/c.docx to .trash", "warning: N files would be moved"].join("\n"),
  );
  assert.match(formatSummary({ ...empty, mediaUpdated: [], mediaMoved: ["M/c.png"] }, { ...plan, warnings: [] }), /^Done:\n {2}moved M\/c\.png to \.trash$/);
});

test("formatSummary counts the files uploaded, whatever their kind", () => {
  const plan: Plan = { actions: [], warnings: [], heldTrashes: 0 };
  const empty = { done: {}, conflicts: [], skipped: [], rewritten: [], linksTo: 0, skippedPages: [], trashedPages: [], mediaUpdated: [], mediaMoved: [], mediaRekeyed: [] };
  assert.equal(formatSummary({ ...empty, mediaUploaded: 1 }, plan), "Done:\n  uploaded 1 file");
  assert.equal(formatSummary({ ...empty, mediaUploaded: 3 }, plan), "Done:\n  uploaded 3 files");
});

test("formatSummary says the files found at a new path, and a run with only those is still 'already in sync'", () => {
  const plan: Plan = { actions: [], warnings: [], heldTrashes: 0 };
  const empty = { done: {}, conflicts: [], skipped: [], rewritten: [], linksTo: 0, skippedPages: [], trashedPages: [], mediaUpdated: [], mediaMoved: [], mediaUploaded: 0 };
  assert.equal(formatSummary({ ...empty, mediaRekeyed: [{ from: "A/a.png", to: "B/a.png" }] }, plan), "Everything was already in sync.\n  moved: A/a.png → B/a.png");
  assert.equal(
    formatMediaPlan(["moved: A/a.png → B/a.png", "upload B/n.png for N.md"], true),
    ["Attachments (1 moved file, 1 upload):", "  moved: A/a.png → B/a.png", "  upload B/n.png for N.md"].join("\n"),
  );
});

test("exit code is 1 when something needs a look", () => {
  const plan: Plan = { actions: [], warnings: [], heldTrashes: 0 };
  assert.equal(exitCode({ done: {}, conflicts: [], skipped: [], rewritten: [], linksTo: 0, skippedPages: [], trashedPages: [], mediaUpdated: [], mediaMoved: [], mediaUploaded: 0, mediaRekeyed: [] }, plan), 0);
  assert.equal(exitCode(null, plan), 0);
  assert.equal(exitCode({ done: {}, conflicts: ["x"], skipped: [], rewritten: [], linksTo: 0, skippedPages: [], trashedPages: [], mediaUpdated: [], mediaMoved: [], mediaUploaded: 0, mediaRekeyed: [] }, plan), 1);
  assert.equal(exitCode(null, { ...plan, heldTrashes: 11 }), 1);
  assert.equal(exitCode(null, plan, true), 1);
  assert.equal(exitCode({ done: { pull: 1 }, conflicts: [], skipped: [], rewritten: ["N.md"], linksTo: 0, skippedPages: [], trashedPages: [], mediaUpdated: [], mediaMoved: [], mediaUploaded: 0, mediaRekeyed: [] }, plan), 1);
});

test("formatSummary lists the notes rewritten whole and where their old text is", () => {
  const plan: Plan = { actions: [], warnings: [], heldTrashes: 0 };
  assert.equal(
    formatSummary({ done: { pull: 1 }, conflicts: [], skipped: [], rewritten: ["Notes/N.md"], linksTo: 0, skippedPages: [], trashedPages: [], mediaUpdated: [], mediaMoved: [], mediaUploaded: 0, mediaRekeyed: [] }, plan),
    [
      "Done:",
      "  1 × note updated from its Notion page",
      "Rewritten whole (an edit couldn't be matched line by line, so one side was rewritten from the other in its own app's form; that side had nothing the other can't hold, so nothing was lost; the old note is in backups, the old page in Notion's page history):",
      "  Notes/N.md",
    ].join("\n"),
  );
});

test("the plan and the summary list the notes whose [[links]] are converted", () => {
  const plan: Plan = { actions: [{ kind: "convertLinks", path: "A.md", text: "x", links: 2 }, { kind: "convertLinks", path: "B.md", text: "y", links: 1 }], warnings: [], heldTrashes: 0 };
  assert.equal(
    formatPlan(plan, notes, []),
    ["Plan (2 changes):", "  convert [[links]] to Markdown links in A.md (2 links)", "  convert [[links]] to Markdown links in B.md (1 link)"].join("\n"),
  );
  assert.equal(formatSummary({ done: { convertLinks: 1 }, conflicts: [], skipped: [], rewritten: [], linksTo: 0, skippedPages: [], trashedPages: [], mediaUpdated: [], mediaMoved: [], mediaUploaded: 0, mediaRekeyed: [] }, plan), ["Done:", "  1 × note's [[links]] converted to Markdown links"].join("\n"));
});

test("formatSummary counts the pages whose Links to was set, before the skipped ones", () => {
  const plan: Plan = { actions: [], warnings: [], heldTrashes: 0 };
  assert.equal(
    formatSummary({ done: { push: 1 }, conflicts: [], skipped: [{ path: "C.md", reason: "validation_error: refused" }], rewritten: [], linksTo: 3, skippedPages: [], trashedPages: [], mediaUpdated: [], mediaMoved: [], mediaUploaded: 0, mediaRekeyed: [] }, plan),
    ["Done:", "  1 × Notion page updated from its note", "  3 × page's Links to set", "Skipped:", "  C.md: validation_error: refused"].join("\n"),
  );
  assert.equal(
    formatSummary({ done: {}, conflicts: [], skipped: [], rewritten: [], linksTo: 2, skippedPages: [], trashedPages: [], mediaUpdated: [], mediaMoved: [], mediaUploaded: 0, mediaRekeyed: [] }, plan),
    ["Done:", "  2 × page's Links to set"].join("\n"),
  );
});

test("formatMediaPlan counts what a preview would do under its header, and leaves a real run's header plain", () => {
  const lines = ["upload M/a.png for N.md", "upload M/b.png for N.md", "download c.png for N.md", "update file M/Manual.pdf (2 pages)", "move to .trash M/d.png", "can't download e.png for N.md (403); left alone"];
  assert.equal(
    formatMediaPlan(lines, true),
    ["Attachments (2 uploads, 1 download, 1 file update, 1 move to .trash):", ...lines.map((line) => `  ${line}`)].join("\n"),
  );
  assert.equal(formatMediaPlan(["upload M/a.png for N.md"], true).split("\n")[0], "Attachments (1 upload):");
  assert.equal(formatMediaPlan(["downloaded 2 images"], false), "Attachments:\n  downloaded 2 images");
  assert.equal(formatMediaPlan(["can't download e.png for N.md (403)"], true).split("\n")[0], "Attachments:");
});

test("projects: relocations and project moves are listed note by note with the reason, projects to create and filed notes are said, in a plan and a summary", () => {
  const plan: Plan = {
    actions: [
      { kind: "relocate", from: "Resources/A.md", to: "0-In/A.md", pageId: "a", reason: "its folder has subfolders" },
      { kind: "relocate", from: "Assets/attachments/B.md", to: "0-In/B.md", pageId: null, reason: "the attachment folder can't be a project" },
      { kind: "moveInVault", pageId: "c", from: "Old/C.md", to: "New/C.md", reason: "its project was renamed" },
      { kind: "renameProject", projectId: "p", title: "Weaving" },
      { kind: "fileProject", pageId: "a" },
      { kind: "fileProject", pageId: "b" },
    ],
    warnings: [],
    heldTrashes: 0,
    creates: ["Cooking", "Layouts"],
    clashes: ["Moved.md"],
  };
  assert.equal(
    formatPlan(plan, notes, []),
    [
      "Plan (8 changes):",
      "  move note Resources/A.md -> 0-In/A.md (its folder has subfolders)",
      "  move note Assets/attachments/B.md -> 0-In/B.md (the attachment folder can't be a project)",
      "  rename/move note Old/C.md -> New/C.md (its project was renamed)",
      "  rename the Notion project of a renamed folder to Weaving",
      "  set the Notion project of 2 notes from their folder",
      "  create project Cooking",
      "  create project Layouts",
      "  1 note renamed or moved in Obsidian while the page's project also changed in Notion; the folder in Obsidian wins: Moved.md",
    ].join("\n"),
  );
  const summary = { done: { relocate: 2, renameProject: 1, moveInVault: 1, fileProject: 2 }, conflicts: [], skipped: [], rewritten: [], linksTo: 0, skippedPages: [], trashedPages: [], mediaUpdated: [], mediaMoved: [], mediaUploaded: 0, mediaRekeyed: [], projectsCreated: ["Cooking"] };
  assert.equal(
    formatSummary(summary, plan),
    [
      "Done:",
      "  2 × note moved out of a folder that means no project",
      "  1 × project renamed after its folder",
      "  1 × note renamed or moved",
      "  2 × Notion project set from the note's folder",
      "  created project Cooking",
      "1 note renamed or moved in Obsidian while the page's project also changed in Notion; the folder in Obsidian wins: Moved.md",
    ].join("\n"),
  );
});
