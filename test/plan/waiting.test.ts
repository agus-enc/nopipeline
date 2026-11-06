import { test } from "node:test";
import assert from "node:assert/strict";
import { waitingFor } from "../../src/plan/waiting.ts";
import type { Action } from "../../src/plan/planner.ts";
import type { PageId, SyncRecord, VaultNote } from "../../src/types.ts";

const id = (s: string) => s as PageId;
const note = (path: string, text = "", notionId: string | null = null): VaultNote => ({ path, text, body: text, notionId: notionId ? id(notionId) : null, notionTitle: null });
const record = (pageId: string, path: string) => ({ notionId: id(pageId), path }) as SyncRecord;
const run = (actions: Action[], inUse: string[], notes: VaultNote[], records: SyncRecord[] = []) =>
  waitingFor({ actions, inUse: new Set(inUse), notes, drawings: [], records: new Map(records.map((r) => [r.notionId, r])) });

test("a push waits when its note is in use", () => {
  const w = run([{ kind: "push", pageId: id("p") }], ["Notes/P.md"], [note("Notes/P.md", "x", "p")], [record("p", "Notes/P.md")]);
  assert.deepEqual([...w.pages], ["p"]);
  assert.equal(w.paths.size, 0);
});

test("a pull waits when the note lost its id but the record's path is in use", () => {
  const w = run([{ kind: "pull", pageId: id("p") }], ["Notes/P.md"], [note("Notes/P.md")], [record("p", "Notes/P.md")]);
  assert.ok(w.pages.has(id("p")));
});

test("a page whose action path is in use waits; one not in use does not", () => {
  const w = run([{ kind: "restoreNote", pageId: id("p"), path: "N/P.md" }, { kind: "createNote", pageId: id("q"), path: "N/Q.md" }], ["N/P.md"], []);
  assert.deepEqual([...w.pages], ["p"]);
});

test("path-only actions put their path in paths", () => {
  const w = run(
    [{ kind: "createPage", path: "New.md" }, { kind: "convertLinks", path: "Other.md", text: "", links: 1 }, { kind: "relocate", from: "In/Z.md", to: "A/Z.md", pageId: null }],
    ["New.md", "In/Z.md"],
    [],
  );
  assert.deepEqual([...w.paths].sort(), ["In/Z.md", "New.md"]);
  assert.equal(w.pages.size, 0);
});

const rename: Action[] = [{ kind: "moveInVault", pageId: id("p"), from: "Old.md", to: "New.md" }];
const renameNotes = (open: string) => [note("Old.md", "", "p"), note("Open.md", open)];
const renameRun = (open: string) => run(rename, ["Open.md"], renameNotes(open), [record("p", "Old.md")]);

test("a rename waits when a note in use links to the page", () => {
  assert.ok(renameRun("see [[Old]]").pages.has(id("p")));
  assert.ok(renameRun("see [[Old|alias]] and more").pages.has(id("p")));
  assert.ok(renameRun("see [x](Old.md#h)").pages.has(id("p")));
  assert.ok(renameRun("---\nrelated: \"[[Old]]\"\n---\nbody").pages.has(id("p")));
  assert.ok(renameRun("---\nrelated: \"[x](Old.md)\"\n---\nbody").pages.has(id("p")));
});

test("a rename does not wait for links in code or to other notes", () => {
  assert.ok(!renameRun("`[[Old]]`").pages.has(id("p")));
  assert.ok(!renameRun("```\n[[Old]]\n```").pages.has(id("p")));
  assert.ok(!renameRun("[[Else]]").pages.has(id("p")));
});

test("a rename does not wait for links in notes not in use", () => {
  const w = run(rename, [], renameNotes("see [[Old]]"), [record("p", "Old.md")]);
  assert.equal(w.pages.size, 0);
});

test("a rename waits for a link that names the old path of a note no longer there", () => {
  const w = run([{ kind: "renameInNotion", pageId: id("p") }], ["Open.md"], [note("Open.md", "[[Folder/Old]]")], [record("p", "Folder/Old.md")]);
  assert.ok(w.pages.has(id("p")));
});

test("folders move as a whole", () => {
  const actions: Action[] = [
    { kind: "moveInVault", pageId: id("p"), from: "A/P.md", to: "B/P.md" },
    { kind: "moveInVault", pageId: id("q"), from: "A/Q.md", to: "B/Q.md" },
    { kind: "moveInVault", pageId: id("r"), from: "A/R.md", to: "C/R.md" },
    { kind: "relocate", from: "A/S.md", to: "B/S.md", pageId: null },
  ];
  const w = run(actions, ["A/P.md"], [note("A/P.md", "", "p"), note("A/Q.md", "", "q"), note("A/R.md", "", "r")]);
  assert.deepEqual([...w.pages].sort(), ["p", "q"]);
  assert.deepEqual([...w.paths], ["A/S.md"]);
});

test("a trash of a page whose note is gone waits for nothing", () => {
  const w = run([{ kind: "trashPage", pageId: id("p") }], ["Other.md"], [note("Other.md")], [record("p", "Gone.md")]);
  assert.equal(w.pages.size, 0);
  assert.equal(w.paths.size, 0);
});

test("endRename waits for a link to a record alias", () => {
  const r = { ...record("p", "Old.md"), aliases: ["Mid.md"] } as SyncRecord;
  const w = run([{ kind: "endRename", pageId: id("p") }], ["Open.md"], [note("Old.md", "", "p"), note("Open.md", "[[Mid]]")], [r]);
  assert.ok(w.pages.has(id("p")));
});

test("a relocate waits when a note in use links to the moved note", () => {
  const notes = [note("A/X.md", "", "p"), note("Open.md", "[[X]]")];
  const withPage = run([{ kind: "relocate", from: "A/X.md", to: "X.md", pageId: id("p") }], ["Open.md"], notes, [record("p", "A/X.md")]);
  assert.ok(withPage.pages.has(id("p")));
  const without = run([{ kind: "relocate", from: "A/X.md", to: "X.md", pageId: null }], ["Open.md"], [note("A/X.md"), note("Open.md", "[[X]]")]);
  assert.deepEqual([...without.paths], ["A/X.md"]);
});

test("endRename waits for a link to a record alias in a subfolder", () => {
  const r = { ...record("p", "Old.md"), aliases: ["Folder/Mid.md"] } as SyncRecord;
  const w = run([{ kind: "endRename", pageId: id("p") }], ["Open.md"], [note("Old.md", "", "p"), note("Open.md", "[[Mid]]")], [r]);
  assert.ok(w.pages.has(id("p")));
});

test("a move that keeps its path (a title change only) waits when a note in use links to the page", () => {
  const w = run([{ kind: "moveInVault", pageId: id("p"), from: "Old.md", to: "Old.md" }], ["Open.md"], [note("Old.md", "", "p"), note("Open.md", "[[Old]]")], [record("p", "Old.md")]);
  assert.ok(w.pages.has(id("p")));
});
