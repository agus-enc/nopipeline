import { test } from "node:test";
import assert from "node:assert/strict";
import { PHASES, plan, type PlanInput } from "../../src/plan/planner.ts";
import type { PageMeta, SyncRecord, VaultNote } from "../../src/types.ts";
import { splitFrontmatter } from "../../src/vault/frontmatter.ts";

const T0 = "2026-09-27T04:00:00.000Z";

function note(path: string, body: string, notionId: string | null = null, notionTitle: string | null = null): VaultNote {
  const text = notionId ? `---\nnotion-id: ${notionId}\n---\n${body}` : body;
  return { path, text, body: splitFrontmatter(text).body, notionId, notionTitle };
}
const page = (id: string, title: string, folder: string | null = null): PageMeta => ({ id, title, folder, lastEditedTime: T0 });
function record(id: string, path: string, body: string, markdown: string, title = path.replace(/^.*\//, "").replace(/\.md$/, ""), folder: string | null = null): SyncRecord {
  return { notionId: id, path, title, folder, obsidianText: `---\nnotion-id: ${id}\n---\n${body}`, notionMarkdown: markdown, notionSeenAt: T0, syncedAt: T0 };
}
function input(parts: Partial<PlanInput>): PlanInput {
  return {
    notes: [],
    drawings: [],
    pages: [],
    fetched: new Map(),
    records: new Map(),
    inboxFolder: "0-In",
    massTrashLimit: 10,
    allowMassTrash: false,
    same: () => true,
    conversions: [],
    holdsOldEmbeds: () => false,
    ...parts,
  };
}
const records = (...rs: SyncRecord[]) => new Map(rs.map((r) => [r.notionId, r]));

test("new notes get pages; new pages get notes in their project folder or the inbox, with unique names", () => {
  const result = plan(
    input({
      notes: [note("Cloud/Elm.md", "x"), note("Other/Draft.md", "p")],
      pages: [page("p1", "Idées Brouillon"), page("p2", "Draft", "Archive"), page("p3", "Soup: Tomato", "Work")],
      fetched: new Map([["p1", "a"], ["p2", "b"], ["p3", "c"]]),
    }),
  );
  assert.deepEqual(result.actions, [
    { kind: "createPage", path: "Cloud/Elm.md" },
    { kind: "createNote", pageId: "p1", path: "0-In/Idées Brouillon.md" },
    { kind: "createNote", pageId: "p3", path: "Work/Soup- Tomato.md" },
    { kind: "pair", pageId: "p2", path: "Other/Draft.md", same: true },
  ]);
});

test("content changes on one or both sides", () => {
  const recs = records(record("a", "A.md", "same", "same"), record("b", "B.md", "old", "old"), record("c", "C.md", "old", "old"), record("d", "D.md", "old", "old"));
  const result = plan(
    input({
      notes: [note("A.md", "same", "a"), note("B.md", "new", "b"), note("C.md", "old", "c"), note("D.md", "new", "d")],
      pages: [page("a", "A"), page("b", "B"), page("c", "C"), page("d", "D")],
      fetched: new Map([["a", "same"], ["c", "edited in notion"], ["d", "edited in notion"]]),
      records: recs,
    }),
  );
  assert.deepEqual(result.actions, [
    { kind: "push", pageId: "b" },
    { kind: "pull", pageId: "c" },
    { kind: "merge", pageId: "d" },
  ]);
});

test("a frontmatter-only edit is not a content change", () => {
  const n = note("A.md", "body", "a");
  n.text = `---\nnotion-id: a\ntags: [x]\n---\nbody`;
  assert.deepEqual(plan(input({ notes: [n], pages: [page("a", "A")], records: records(record("a", "A.md", "body", "body")) })).actions, []);
});

test("deletions: an edit on the other side wins over a delete", () => {
  const recs = records(record("a", "A.md", "x", "x"), record("b", "B.md", "x", "x"), record("c", "C.md", "x", "x"), record("d", "D.md", "x", "x"), record("e", "E.md", "x", "x"));
  const result = plan(
    input({
      notes: [note("C.md", "x", "c"), note("D.md", "edited", "d")],
      pages: [page("a", "A"), page("b", "B")],
      fetched: new Map([["b", "edited in notion"]]),
      records: recs,
    }),
  );
  assert.deepEqual(result.actions, [
    { kind: "recreatePage", oldId: "d", path: "D.md" },
    { kind: "restoreNote", pageId: "b", path: "B.md" },
    { kind: "trashPage", pageId: "a" },
    { kind: "trashNote", pageId: "c", path: "C.md" },
    { kind: "forget", pageId: "e" },
  ]);
  // A restored note takes the page's current title and project folder.
  const renamed = plan(
    input({
      pages: [page("f", "New Name", "New")],
      fetched: new Map([["f", "edited in notion"]]),
      records: records(record("f", "Old/Old Name.md", "x", "x", "Old Name", "Old")),
    }),
  );
  assert.deepEqual(renamed.actions, [{ kind: "restoreNote", pageId: "f", path: "New/New Name.md" }]);
});

test("renames and moves: Obsidian's wins when both sides changed", () => {
  const recs = records(record("a", "Old/A.md", "x", "x", "A", "Old"), record("b", "B.md", "x", "x"), record("c", "C.md", "x", "x"));
  const result = plan(
    input({
      notes: [note("New/A.md", "x", "a"), note("B.md", "x", "b"), note("C.md", "x", "c")],
      pages: [page("a", "A renamed in Notion", "Old"), page("b", "B: renamed", "Folder"), page("c", "C")],
      records: recs,
    }),
  );
  assert.deepEqual(result.actions, [
    { kind: "renameInNotion", pageId: "a" },
    { kind: "moveInVault", pageId: "b", from: "B.md", to: "Folder/B- renamed.md" },
  ]);
});

test("editing notion-title in Obsidian renames the page", () => {
  const n = note("A.md", "x", "a", "A: better title");
  assert.deepEqual(plan(input({ notes: [n], pages: [page("a", "A")], records: records(record("a", "A.md", "x", "x")) })).actions, [{ kind: "renameInNotion", pageId: "a" }]);
});

test("a note that lost its notion-id at its recorded path gets it back", () => {
  const result = plan(input({ notes: [note("A.md", "x")], pages: [page("a", "A")], records: records(record("a", "A.md", "x", "x")) }));
  assert.deepEqual(result.actions, [{ kind: "writeId", pageId: "a", path: "A.md" }]);
});

test("first run pairs notes and pages by title, and reports differences", () => {
  const result = plan(
    input({
      notes: [note("Cloud/Elm.md", "a"), note("Cloud/Oak.md", "b"), note("x/Draft.md", "c")],
      pages: [page("i", "Elm"), page("e", "oak"), page("p1", "Draft"), page("p2", "Draft")],
      fetched: new Map([["i", "a"], ["e", "different"], ["p1", ""], ["p2", ""]]),
      same: (n, md) => n.body === md,
    }),
  );
  assert.deepEqual(
    result.actions.filter((a) => a.kind === "pair"),
    [
      { kind: "pair", pageId: "i", path: "Cloud/Elm.md", same: true },
      { kind: "pair", pageId: "e", path: "Cloud/Oak.md", same: false },
    ],
  );
  assert.deepEqual(
    result.actions.filter((a) => a.kind !== "pair"),
    [
      { kind: "createPage", path: "x/Draft.md" },
      { kind: "createNote", pageId: "p1", path: "0-In/Draft (2).md" },
      { kind: "createNote", pageId: "p2", path: "0-In/Draft (3).md" },
    ],
  );
  assert.match(result.warnings[0]!, /share the title "Draft"/);
});

test("a note whose id has a page but no record is paired by id", () => {
  const result = plan(input({ notes: [note("A.md", "x", "a")], pages: [page("a", "Other title")], fetched: new Map([["a", "x"]]), same: () => true }));
  assert.deepEqual(result.actions, [{ kind: "pair", pageId: "a", path: "A.md", same: true }]);
});

test("stale and duplicated ids get new pages with a warning", () => {
  const result = plan(input({ notes: [note("A.md", "x", "gone"), note("B.md", "y", "dup"), note("C.md", "z", "dup")], pages: [page("dup", "B")], fetched: new Map([["dup", "y"]]) }));
  assert.deepEqual(result.actions, [
    { kind: "createPage", path: "A.md" },
    { kind: "createPage", path: "C.md" },
    { kind: "pair", pageId: "dup", path: "B.md", same: true },
  ]);
  assert.equal(result.warnings.length, 2);
  // A copy made in Obsidian carries the same notion-id: the note at the recorded path keeps the page.
  const copied = plan(
    input({
      notes: [note("A copy.md", "x", "p1"), note("X.md", "x", "p1")],
      pages: [page("p1", "X")],
      fetched: new Map([["p1", "x"]]),
      records: records(record("p1", "X.md", "x", "x")),
    }),
  );
  assert.deepEqual(copied.actions, [{ kind: "createPage", path: "A copy.md" }]);
  assert.deepEqual(copied.warnings, ["A copy.md has the same notion-id as X.md; it will get its own Notion page."]);
});

test("more trashes than the limit are held back", () => {
  const recs = records(...Array.from({ length: 3 }, (_, k) => record(`r${k}`, `N${k}.md`, "x", "x")));
  const held = plan(input({ records: recs, massTrashLimit: 2, pages: [page("r0", "N0"), page("r1", "N1"), page("r2", "N2")] }));
  assert.deepEqual(held.actions, []);
  assert.equal(held.heldTrashes, 3);
  const allowed = plan(input({ records: recs, massTrashLimit: 2, allowMassTrash: true, pages: [page("r0", "N0"), page("r1", "N1"), page("r2", "N2")] }));
  assert.equal(allowed.actions.length, 3);
});

function trashCase(count: number) {
  // Even indexes: the note was deleted in Obsidian (trashPage); odd: the page was deleted in Notion (trashNote).
  const ids = Array.from({ length: count }, (_, k) => `r${k}`);
  const recs = records(...ids.map((id, k) => record(id, `N${k}.md`, "x", "x")));
  const notes = ids.flatMap((id, k) => (k % 2 ? [note(`N${k}.md`, "x", id)] : []));
  const pages = ids.flatMap((id, k) => (k % 2 ? [] : [page(id, `N${k}`)]));
  return { ids, recs, notes, pages, fetched: new Map(pages.map((p) => [p.id, "x"])) };
}

test("held trashes are listed with path and side", () => {
  const c = trashCase(12);
  const held = plan(input({ records: c.recs, notes: c.notes, pages: c.pages, fetched: c.fetched }));
  assert.equal(held.heldTrashes, 12);
  assert.equal(held.held!.length, 12);
  assert.deepEqual(held.held![0], { pageId: "r0", path: "N0.md", side: "notion" });
  assert.deepEqual(held.held![1], { pageId: "r1", path: "N1.md", side: "vault" });
  assert.equal(held.held!.filter((h) => h.side === "notion").length, 6);
});

test("an allow-list that covers every trash lets them through", () => {
  const c = trashCase(12);
  const result = plan(input({ records: c.recs, notes: c.notes, pages: c.pages, fetched: c.fetched, allowedTrashes: new Set(c.ids) }));
  assert.equal(result.held, undefined);
  assert.equal(result.heldTrashes, 0);
  assert.equal(result.actions.filter((a) => a.kind === "trashPage" || a.kind === "trashNote").length, 12);
});

test("a subset of the allow-list goes ahead", () => {
  const c = trashCase(12);
  const result = plan(input({ records: c.recs, notes: c.notes, pages: c.pages.slice(0, -1), fetched: c.fetched, allowedTrashes: new Set(c.ids) }));
  const kept = result.actions.filter((a) => a.kind === "trashPage" || a.kind === "trashNote");
  assert.equal(kept.length, 11);
  assert.equal(result.heldTrashes, 0);
});

test("one trash outside the allow-list holds them all", () => {
  const c = trashCase(12);
  const result = plan(input({ records: c.recs, notes: c.notes, pages: c.pages, fetched: c.fetched, allowedTrashes: new Set(c.ids.slice(0, 11)) }));
  assert.equal(result.heldTrashes, 12);
  assert.equal(result.held!.length, 12);
  assert.match(result.warnings.join("\n"), /list changed since it was held/);
});

test("a project folder that can't be a vault folder never places a note: new pages go to the inbox, notes stay put", () => {
  const result = plan(
    input({
      notes: [note("Kept.md", "k", "k"), note("Titled.md", "t", "t")],
      pages: [page("e", "Escapee", "../outside"), page("h", "Hidden", ".hidden"), page("k", "Kept", "../../moved-out"), page("t", "Titled anew", "a:b")],
      fetched: new Map([["e", "x"], ["h", "y"]]),
      records: records(record("k", "Kept.md", "k", "k"), record("t", "Titled.md", "t", "t")),
    }),
  );
  assert.deepEqual(result.actions, [
    { kind: "createNote", pageId: "e", path: "0-In/Escapee.md" },
    { kind: "createNote", pageId: "h", path: "0-In/Hidden.md" },
    { kind: "moveInVault", pageId: "t", from: "Titled.md", to: "Titled anew.md" },
  ]);
  assert.deepEqual(result.warnings, [
    'Notion page "Kept" belongs in the folder "../../moved-out", which can\'t be a vault folder; Kept.md stays where it is.',
    'Notion page "Titled anew" belongs in the folder "a:b", which can\'t be a vault folder; Titled.md stays in its folder.',
    'Notion page "Escapee" belongs in the folder "../outside", which can\'t be a vault folder; its note goes to 0-In.',
    'Notion page "Hidden" belongs in the folder ".hidden", which can\'t be a vault folder; its note goes to 0-In.',
  ]);
  // A note restored from a page with such a folder goes to the inbox too.
  const restored = plan(input({ pages: [page("r", "Gone", "../x")], fetched: new Map([["r", "edited"]]), records: records(record("r", "Gone.md", "g", "g")) }));
  assert.deepEqual(restored.actions, [{ kind: "restoreNote", pageId: "r", path: "0-In/Gone.md" }]);
});

test("a [[link]] Notion holds as text is planned to become a Notion link once its note or page exists", () => {
  const literal = "See \\[\\[B\\]\\] and \\[\\[Gone\\]\\] and \\[\\[Drawing\\]\\]";
  const a = record("a", "A.md", "See [[B]] and [[Gone]] and [[Drawing]]", literal);
  const base = { notes: [note("A.md", "See [[B]] and [[Gone]] and [[Drawing]]", "a")], drawings: ["Drawing.md"], pages: [page("a", "A")], records: records(a) };
  // Nothing named B yet, a drawing is no page: nothing to do.
  assert.deepEqual(plan(input(base)).actions, []);
  // B is a new note (it gets its page this run), or a new Notion page (it gets its note this run).
  assert.deepEqual(plan(input({ ...base, notes: [...base.notes, note("B.md", "b")] })).actions, [
    { kind: "createPage", path: "B.md" },
    { kind: "relink", pageId: "a" },
  ]);
  assert.deepEqual(plan(input({ ...base, pages: [...base.pages, page("b", "B")], fetched: new Map([["b", "b"]]) })).actions, [
    { kind: "createNote", pageId: "b", path: "0-In/B.md" },
    { kind: "relink", pageId: "a" },
  ]);
  // A link the note writes as a Markdown link (as every run converts [[links]]) is found by its literal too.
  const markdown = { ...base, notes: [note("A.md", "See [B](B.md) and [Gone](Gone.md)", "a"), note("B.md", "b")], records: records(record("a", "A.md", "See [B](B.md) and [Gone](Gone.md)", "See \\[\\[B\\]\\] and \\[\\[Gone\\]\\]")) };
  assert.deepEqual(plan(input(markdown)).actions, [
    { kind: "createPage", path: "B.md" },
    { kind: "relink", pageId: "a" },
  ]);
  // Text the note itself writes as literal brackets stays literal.
  const escaped = { ...base, notes: [note("A.md", "See \\[\\[B\\]\\]", "a"), note("B.md", "b")], records: records(record("a", "A.md", "See \\[\\[B\\]\\]", "See \\[\\[B\\]\\]")) };
  assert.deepEqual(plan(input(escaped)).actions, [{ kind: "createPage", path: "B.md" }]);
  // This run's text from Notion decides when the page changed.
  const fetched = plan(input({ ...base, notes: [...base.notes, note("B.md", "b")], fetched: new Map([["a", "See B and [[Gone]] and [[Drawing]]"]]) }));
  assert.deepEqual(fetched.actions.filter((action) => action.kind === "relink"), []);
});

test("a note with [[links]] to convert is converted first, then planned as edited in Obsidian", () => {
  const converted = `---\nnotion-id: a\n---\nSee [B](B.md)`;
  const synced = plan(
    input({
      notes: [note("A.md", "See [[B]]", "a"), note("B.md", "b", "b")],
      pages: [page("a", "A"), page("b", "B")],
      records: records(record("a", "A.md", "See [[B]]", "See [B](https://app.notion.com/p/b)"), record("b", "B.md", "b", "b")),
      conversions: [{ path: "A.md", text: converted, links: 1 }],
    }),
  );
  assert.deepEqual(synced.actions, [
    { kind: "convertLinks", path: "A.md", text: converted, links: 1 },
    { kind: "push", pageId: "a" },
  ]);
  const fresh = plan(input({ notes: [note("New.md", "See [[B]] and [[C]]")], conversions: [{ path: "New.md", text: "See [B](B.md) and [C](C.md)", links: 2 }] }));
  assert.deepEqual(fresh.actions, [
    { kind: "convertLinks", path: "New.md", text: "See [B](B.md) and [C](C.md)", links: 2 },
    { kind: "createPage", path: "New.md" },
  ]);
  // Pairing compares the page with the note as converted.
  const seen: string[] = [];
  plan(
    input({
      notes: [note("P.md", "See [[B]]")],
      pages: [page("p", "P")],
      fetched: new Map([["p", "x"]]),
      conversions: [{ path: "P.md", text: "See [B](B.md)", links: 1 }],
      same: (n) => (seen.push(n.body), true),
    }),
  );
  assert.deepEqual(seen, ["See [B](B.md)"]);
});

test("a note with Notion-hosted images to cite is converted right after its [[links]], then planned as edited in Obsidian", () => {
  const linked = `---\nnotion-id: a\n---\nSee [B](B.md)\n![](pic.png)`;
  const converted = { path: "A.md", text: linked, images: 1 };
  const result = plan(
    input({
      notes: [note("A.md", "See [[B]]\n![](https://prod-files-secure.s3.us-west-2.amazonaws.com/w/f/pic.png)", "a"), note("B.md", "b", "b")],
      pages: [page("a", "A"), page("b", "B")],
      records: records(record("a", "A.md", "See [B](B.md)\n![](pic.png)", "See [B](https://app.notion.com/p/b)\n![](https://nopipeline.invalid/vault/pic.png)"), record("b", "B.md", "b", "b")),
      conversions: [{ path: "A.md", text: `---\nnotion-id: a\n---\nSee [B](B.md)\n![](https://prod-files-secure.s3.us-west-2.amazonaws.com/w/f/pic.png)`, links: 1 }],
      imageConversions: [converted],
    }),
  );
  // The record already holds the converted text, so nothing is pushed.
  assert.deepEqual(result.actions.map((a) => a.kind), ["convertLinks", "convertImages"]);
  assert.deepEqual(result.actions[1], { kind: "convertImages", ...converted });
  // Pairing compares the page with the note as converted.
  const seen: string[] = [];
  plan(
    input({
      notes: [note("P.md", "![](https://prod-files-secure.s3.us-west-2.amazonaws.com/w/f/pic.png)")],
      pages: [page("p", "P")],
      fetched: new Map([["p", "x"]]),
      imageConversions: [{ path: "P.md", text: "![](pic.png)", images: 1 }],
      same: (n) => (seen.push(n.body), true),
    }),
  );
  assert.deepEqual(seen, ["![](pic.png)"]);
});

test("a synced note whose page holds image citations as escaped text gets the images added, and only when nothing else changed", () => {
  const recs = records(
    record("a", "A.md", "![[x.png]]", "!\\[\\[x.png\\]\\]"),
    record("b", "B.md", "![[x.png]]", "!\\[\\[x.png\\]\\]"),
    record("c", "C.md", "![[x.png]]", "!\\[\\[x.png\\]\\]"),
    record("d", "D.md", "plain", "plain"),
  );
  const result = plan(
    input({
      notes: [note("A.md", "![[x.png]]", "a"), note("B.md", "![[x.png]]\nedited", "b"), note("C.md", "![[x.png]]", "c"), note("D.md", "plain", "d")],
      pages: [page("a", "A"), page("b", "B"), page("c", "C"), page("d", "D")],
      fetched: new Map([["c", "edited in notion"]]),
      records: recs,
      holdsOldEmbeds: (r) => r.notionMarkdown.includes("\\[\\["),
    }),
  );
  assert.deepEqual(result.actions, [{ kind: "push", pageId: "b" }, { kind: "pull", pageId: "c" }, { kind: "updateEmbeds", pageId: "a" }]);
});

test("updateEmbeds comes right after relink in the order of a run", () => {
  assert.equal(PHASES.indexOf("updateEmbeds"), PHASES.indexOf("relink") + 1);
});

test("the order of a run: relocations and project renames come right after the conversions, filing a project right after pair", () => {
  assert.equal(PHASES.indexOf("relocate"), PHASES.indexOf("convertImages") + 1);
  assert.equal(PHASES.indexOf("renameProject"), PHASES.indexOf("relocate") + 1);
  assert.equal(PHASES.indexOf("writeId"), PHASES.indexOf("renameProject") + 1);
  assert.equal(PHASES.indexOf("fileProject"), PHASES.indexOf("pair") + 1);
});

test("a relocation moves the note first, and every later decision sees the note at its new path", () => {
  const recs = records(record("a", "Resources/A.md", "x", "x", "A", "Resources"));
  const result = plan(
    input({
      notes: [note("Resources/A.md", "x", "a"), note("Resources/Loose.md", "l"), note("Fine.md", "f")],
      pages: [page("a", "A", "0-In")],
      records: recs,
      relocations: [
        { from: "Resources/A.md", to: "0-In/A.md", pageId: "a" },
        { from: "Resources/Loose.md", to: "0-In/Loose.md", pageId: null },
      ],
    }),
  );
  assert.deepEqual(result.actions, [
    { kind: "relocate", from: "Resources/A.md", to: "0-In/A.md", pageId: "a" },
    { kind: "relocate", from: "Resources/Loose.md", to: "0-In/Loose.md", pageId: null },
    { kind: "createPage", path: "0-In/Loose.md" },
    { kind: "createPage", path: "Fine.md" },
    { kind: "renameInNotion", pageId: "a" },
  ]);
});

test("a relocated note whose id was lost is still the note of its record", () => {
  const recs = records(record("a", "Resources/A.md", "x", "x", "A", "Resources"));
  const result = plan(
    input({
      notes: [note("Resources/A.md", "x")],
      pages: [page("a", "A", "0-In")],
      records: recs,
      relocations: [{ from: "Resources/A.md", to: "0-In/A.md", pageId: "a" }],
    }),
  );
  assert.deepEqual(result.actions.map((a) => a.kind), ["relocate", "writeId", "renameInNotion"]);
});

test("only a rename made in Obsidian becomes a renameProject action; the project's note is filed after pair", () => {
  const result = plan(
    input({
      renames: [
        { id: "p1", title: "Weaving", from: "Astronomy", to: "Weaving", side: "obsidian" },
        { id: "p2", title: "Astronomy Club", from: "Astronomy", to: "Astronomy Club", side: "notion" },
      ],
      notes: [note("Cooking/Draft.md", "p")],
      pages: [page("n", "Draft", "Cooking")],
      fileProject: ["n"],
    }),
  );
  assert.deepEqual(result.actions, [
    { kind: "renameProject", projectId: "p1", title: "Weaving" },
    { kind: "pair", pageId: "n", path: "Cooking/Draft.md", same: true },
    { kind: "fileProject", pageId: "n" },
  ]);
});
