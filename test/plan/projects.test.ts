import { test } from "node:test";
import assert from "node:assert/strict";
import { folderForNewProject, folderMeaning, isLeaf, resolveProjects, type FolderContext } from "../../src/plan/projects.ts";
import type { StoredProject } from "../../src/state/projects.ts";
import { titleToFileName } from "../../src/vault/filenames.ts";
import type { PageId, PageMeta, SyncRecord, VaultNote } from "../../src/types.ts";

const id = (s: string) => s as PageId;
const SUBS = "its folder has subfolders";
const VAULT = [
  "0-In", "0-In/Drafts", "Library", "Library/Owls", "Library/Wrens", "Attic", "Attic/Maps", "Attic/Maps/Backlog",
  "Assets", "Assets/attachments", "Cards", "Cards/Deck", "Grove", "Astronomy", "Botany", "Cookbook", "Layouts", "Hiking",
];
function ctx(over: Partial<Omit<FolderContext, "stored">> & { stored?: Record<string, StoredProject>; extra?: string[] } = {}): FolderContext {
  return {
    inboxFolder: "0-In",
    attachmentFolder: "Assets/attachments",
    folders: new Set([...VAULT, ...(over.extra ?? [])]),
    projects: [{ id: id("astronomy"), title: "Astronomy" }],
    ...over,
    stored: new Map(Object.entries(over.stored ?? {}).map(([k, v]) => [id(k), v])),
  };
}

test("folder meanings of a sample layout", () => {
  const c = ctx();
  assert.deepEqual(folderMeaning("Astronomy", c), { kind: "project", id: id("astronomy") });
  assert.deepEqual(folderMeaning("Library", c), { kind: "evict" });
  assert.deepEqual(folderMeaning("Assets", c), { kind: "evict" });
  assert.deepEqual(folderMeaning("Assets/attachments", c), { kind: "evict" });
  assert.deepEqual(folderMeaning("0-In", c), { kind: "none" });
  assert.deepEqual(folderMeaning("", c), { kind: "none" });
  assert.deepEqual(folderMeaning("Attic/Maps", c), { kind: "evict" });
  assert.deepEqual(folderMeaning("Attic/Maps/Backlog", c), { kind: "new", title: "Backlog" });
});

test("a stored project's folder stays that project after it gains subfolders", () => {
  const c = ctx({ stored: { astronomy: { path: "Astronomy", title: "Astronomy" } }, extra: ["Astronomy/Labs"] });
  assert.deepEqual(folderMeaning("Astronomy", c), { kind: "project", id: id("astronomy") });
  assert.deepEqual(folderMeaning("Astronomy/Labs", c), { kind: "new", title: "Labs" });
});

test("two projects with one name make the folder ambiguous", () => {
  const c = ctx({ projects: [{ id: id("a"), title: "astronomy" }, { id: id("b"), title: "Astronomy" }] });
  assert.equal(folderMeaning("Astronomy", c).kind, "ambiguous");
});

test("two leaf folders claiming one new name are both ambiguous; a stored one is not", () => {
  const c = ctx({ extra: ["A", "A/Notes", "B", "B/Notes"] });
  assert.equal(folderMeaning("A/Notes", c).kind, "ambiguous");
  assert.equal(folderMeaning("B/Notes", c).kind, "ambiguous");
  const s = ctx({ extra: ["A", "A/Notes", "B", "B/Notes"], stored: { n: { path: "A/Notes", title: "Notes" } } });
  assert.deepEqual(folderMeaning("A/Notes", s), { kind: "project", id: id("n") });
  assert.deepEqual(folderMeaning("B/Notes", s), { kind: "new", title: "Notes" });
});

test("NFD folder matches NFC title", () => {
  const nfd = "Été Indien".normalize("NFD");
  const c = ctx({ projects: [{ id: id("eco"), title: "Été Indien" }], extra: [nfd] });
  assert.deepEqual(folderMeaning(nfd, c), { kind: "project", id: id("eco") });
  const s = ctx({ stored: { eco: { path: "Été Indien", title: "Été Indien" } }, extra: [nfd] });
  assert.deepEqual(folderMeaning(nfd, s), { kind: "project", id: id("eco") });
});

test("isLeaf ignores hidden subfolders", () => {
  assert.equal(isLeaf("A", new Set(["A", "A/.git"])), true);
  assert.equal(isLeaf("A", new Set(["A", "A/B"])), false);
  assert.equal(isLeaf("A", new Set(["A", "AB"])), true);
});

test("unsafe project title", () => {
  assert.equal(folderForNewProject("C/C++: notes?", ctx(), new Set()), titleToFileName("C/C++: notes?"));
});

test("a new project's folder collides with existing folders", () => {
  const c = ctx();
  assert.equal(folderForNewProject("Library", c, new Set()), "Library (2)");
  assert.equal(folderForNewProject("0-In", c, new Set()), "0-In (2)");
  assert.equal(folderForNewProject("Astronomy", c, new Set()), "Astronomy");
  assert.equal(folderForNewProject("astronomy", c, new Set()), "astronomy");
  assert.equal(folderForNewProject("Solo", c, new Set()), "Solo");
  const stored = ctx({ stored: { x: { path: "Astronomy", title: "Other" } } });
  assert.equal(folderForNewProject("Astronomy", stored, new Set()), "Astronomy (2)");
  assert.equal(folderForNewProject("Assets", c, new Set()), "Assets (2)");
});

test("attachment folder at the root is never reused; claimed names count", () => {
  const c = ctx({ attachmentFolder: "Files", extra: ["Files"] });
  assert.equal(folderForNewProject("Files", c, new Set()), "Files (2)");
  assert.equal(folderForNewProject("Name", c, new Set()), "Name");
  assert.equal(folderForNewProject("Name", c, new Set(["Name"])), "Name (2)");
  assert.equal(folderForNewProject("Name", c, new Set(["Name", "Name (2)"])), "Name (3)");
});

// --- resolveProjects (pure, sample-layout) ---

const note = (path: string, notionId: string | null = null): VaultNote => ({ path, text: "", body: "", notionId, notionTitle: null });
const page = (pid: string, projects: string[] = []): PageMeta => ({
  id: id(pid), title: pid, folder: null, lastEditedTime: "t", projects: { ids: projects.map(id), more: false },
});
const rec = (pid: string, path: string, folder: string | null, project?: string | null): SyncRecord => ({
  notionId: id(pid), path, title: pid, folder, ...(project === undefined ? {} : { project: project === null ? null : id(project) }),
  obsidianText: "", notionMarkdown: "", notionSeenAt: "t", syncedAt: "t",
});
function resolve(over: { notes?: VaultNote[]; pages?: PageMeta[]; records?: SyncRecord[]; context?: FolderContext; enabled?: boolean }) {
  return resolveProjects({
    enabled: over.enabled ?? true,
    notes: over.notes ?? [],
    pages: over.pages ?? [],
    records: new Map((over.records ?? []).map((r) => [r.notionId, r])),
    context: over.context ?? ctx({ projects: [{ id: id("astronomy"), title: "Astronomy" }, { id: id("solo"), title: "Solo" }, { id: id("botany"), title: "Botany" }] }),
  });
}

test("migration: a note in a project folder keeps it and files it in Notion", () => {
  const r = resolve({ notes: [note("Astronomy/a.md", "a")], pages: [page("a")], records: [rec("a", "Astronomy/a.md", "Astronomy")] });
  assert.equal(r.pageFolders.get(id("a")), "Astronomy");
  assert.deepEqual(r.fileProject, [id("a")]);
  assert.deepEqual(r.stored.get(id("astronomy")), { path: "Astronomy", title: "Astronomy" });
  assert.deepEqual(r.relocations, []);
  assert.deepEqual(r.creates, []);
});

test("migration: a 0-In note whose page has a project goes to a new root folder", () => {
  const r = resolve({ notes: [note("0-In/y.md", "y")], pages: [page("y", ["solo"])], records: [rec("y", "0-In/y.md", "0-In")] });
  assert.equal(r.pageFolders.get(id("y")), "Solo");
  assert.deepEqual(r.stored.get(id("solo")), { path: "Solo", title: "Solo" });
  assert.deepEqual(r.fileProject, []);
  assert.deepEqual(r.relocations, []);
});

test("migration: an evicted note goes to the page's project folder, else to 0-In", () => {
  const without = resolve({ notes: [note("Library/x.md", "x")], pages: [page("x")], records: [rec("x", "Library/x.md", "Library")] });
  assert.deepEqual(without.relocations, [{ from: "Library/x.md", to: "0-In/x.md", pageId: id("x"), reason: SUBS }]);
  assert.equal(without.pageFolders.get(id("x")), "0-In");
  const withProject = resolve({ notes: [note("Library/x.md", "x")], pages: [page("x", ["solo"])], records: [rec("x", "Library/x.md", "Library")] });
  assert.deepEqual(withProject.relocations, [{ from: "Library/x.md", to: "Solo/x.md", pageId: id("x"), reason: SUBS }]);
  assert.equal(withProject.pageFolders.get(id("x")), "Solo");
});

test("a root note without a project stays at the root", () => {
  const r = resolve({ notes: [note("r.md", "r")], pages: [page("r")], records: [rec("r", "r.md", null)] });
  assert.equal(r.pageFolders.get(id("r")), null);
  assert.deepEqual(r.relocations, []);
  assert.deepEqual(r.fileProject, []);
});

test("after migration Notion's new first project decides the folder", () => {
  const r = resolve({ notes: [note("Astronomy/a.md", "a")], pages: [page("a", ["botany", "astronomy"])], records: [rec("a", "Astronomy/a.md", "Astronomy", "astronomy")], context: ctx({ projects: [{ id: id("astronomy"), title: "Astronomy" }, { id: id("botany"), title: "Botany" }], stored: { astronomy: { path: "Astronomy", title: "Astronomy" }, botany: { path: "Botany", title: "Botany" } } }) });
  assert.equal(r.pageFolders.get(id("a")), "Botany");
  assert.deepEqual(r.fileProject, []);
});

test("after migration, when both sides changed nothing is filed or moved: the planner sees the note's own path change and the vault wins", () => {
  const context = ctx({ projects: [{ id: id("astronomy"), title: "Astronomy" }, { id: id("solo"), title: "Solo" }, { id: id("botany"), title: "Botany" }], stored: { astronomy: { path: "Astronomy", title: "Astronomy" }, botany: { path: "Botany", title: "Botany" } } });
  // The record says Astronomy/a.md with project astronomy; the note is now in Botany, and Notion's first project is Solo.
  const r = resolve({ notes: [note("Botany/a.md", "a")], pages: [page("a", ["solo"])], records: [rec("a", "Astronomy/a.md", "Astronomy", "astronomy")], context });
  assert.equal(r.pageFolders.get(id("a")), "Solo");
  assert.deepEqual(r.fileProject, []);
  assert.deepEqual(r.relocations, []);
});

test("an Obsidian folder rename renames the project", () => {
  const context = ctx({
    folders: new Set(["0-In", "Weaving", "Botany"]),
    projects: [{ id: id("astronomy"), title: "Astronomy" }, { id: id("botany"), title: "Botany" }],
    stored: { astronomy: { path: "Astronomy", title: "Astronomy" }, botany: { path: "Botany", title: "Botany" } },
  });
  const r = resolve({
    notes: [note("Weaving/a.md", "a"), note("Weaving/b.md", "b")],
    pages: [page("a", ["astronomy"]), page("b", ["astronomy"])],
    records: [rec("a", "Astronomy/a.md", "Astronomy", "astronomy"), rec("b", "Astronomy/b.md", "Astronomy", "astronomy")],
    context,
  });
  assert.deepEqual(r.renames, [{ id: id("astronomy"), title: "Weaving", from: "Astronomy", to: "Weaving", side: "obsidian" }]);
  assert.deepEqual(r.stored.get(id("astronomy")), { path: "Weaving", title: "Weaving" });
  assert.equal(r.pageFolders.get(id("a")), "Weaving");
  assert.deepEqual(r.creates, []);
  assert.deepEqual(r.relocations, []);
});

test("P8: a folder renamed in Obsidian onto the project's new Notion title stores the live title, and renames nothing", () => {
  const context = ctx({
    folders: new Set(["0-In", "weaving", "Botany"]),
    projects: [{ id: id("astronomy"), title: "Weaving" }],
    stored: { astronomy: { path: "Astronomy", title: "Astronomy" } },
  });
  const r = resolve({
    notes: [note("weaving/a.md", "a")],
    pages: [page("a", ["astronomy"])],
    records: [rec("a", "Astronomy/a.md", "Astronomy", "astronomy")],
    context,
  });
  assert.deepEqual(r.renames, []);
  assert.deepEqual(r.stored.get(id("astronomy")), { path: "weaving", title: "Weaving" }, "the live title, not the folder's spelling");
  assert.equal(r.pageFolders.get(id("a")), "weaving");
});

test("a folder that only some of a project's notes moved to is not a rename", () => {
  const context = ctx({ folders: new Set(["0-In", "Astronomy", "Weaving"]), projects: [{ id: id("astronomy"), title: "Astronomy" }], stored: { astronomy: { path: "Astronomy", title: "Astronomy" } } });
  const r = resolve({
    notes: [note("Weaving/a.md", "a"), note("Astronomy/b.md", "b")],
    pages: [page("a", ["astronomy"]), page("b", ["astronomy"])],
    records: [rec("a", "Astronomy/a.md", "Astronomy", "astronomy"), rec("b", "Astronomy/b.md", "Astronomy", "astronomy")],
    context,
  });
  assert.deepEqual(r.renames, []);
  assert.deepEqual(r.creates, ["Weaving"]);
});

test("a Notion title change renames the stored folder and its notes follow", () => {
  const context = ctx({ projects: [{ id: id("astronomy"), title: "Astronomy Club" }], stored: { astronomy: { path: "Astronomy", title: "Astronomy" } } });
  const r = resolve({ notes: [note("Astronomy/a.md", "a")], pages: [page("a", ["astronomy"])], records: [rec("a", "Astronomy/a.md", "Astronomy", "astronomy")], context });
  assert.deepEqual(r.renames, [{ id: id("astronomy"), title: "Astronomy Club", from: "Astronomy", to: "Astronomy Club", side: "notion" }]);
  assert.deepEqual(r.stored.get(id("astronomy")), { path: "Astronomy Club", title: "Astronomy Club" });
  assert.equal(r.pageFolders.get(id("a")), "Astronomy Club");
  assert.deepEqual(r.creates, []);
  assert.deepEqual(r.relocations, []);
});

test("a nested stored path keeps its parent when the title changes", () => {
  const context = ctx({ folders: new Set(["0-In", "Boxes", "Boxes/Ete"]), projects: [{ id: id("eco"), title: "Été Indien" }], stored: { eco: { path: "Boxes/Ete", title: "Ete" } } });
  const r = resolve({ notes: [note("Boxes/Ete/a.md", "a")], pages: [page("a", ["eco"])], records: [rec("a", "Boxes/Ete/a.md", "Boxes/Ete", "eco")], context });
  assert.equal(r.renames[0]?.to, "Boxes/Été Indien");
  assert.equal(r.pageFolders.get(id("a")), "Boxes/Été Indien");
});

test("a trashed project's notes go to 0-In and nothing is created", () => {
  const context = ctx({ folders: new Set(["0-In", "Gone"]), projects: [], stored: { gone: { path: "Gone", title: "Gone" } } });
  const r = resolve({ notes: [note("Gone/a.md", "a")], pages: [page("a")], records: [rec("a", "Gone/a.md", "Gone", "gone")], context });
  assert.equal(r.pageFolders.get(id("a")), "0-In");
  assert.equal(r.stored.has(id("gone")), false);
  assert.deepEqual(r.creates, []);
  assert.deepEqual(r.fileProject, []);
  assert.deepEqual(r.renames, []);
});

test("notes evicted into 0-In get unique names against every note", () => {
  const r = resolve({
    notes: [note("Library/Index.md", "i1"), note("Cards/Index.md", "i2"), note("Library/Solo.md"), note("0-In/Solo copy.md")],
    pages: [page("i1"), page("i2")],
    records: [rec("i1", "Library/Index.md", "Library"), rec("i2", "Cards/Index.md", "Cards")],
  });
  assert.deepEqual(r.relocations, [
    { from: "Library/Index.md", to: "0-In/Index.md", pageId: id("i1"), reason: SUBS },
    { from: "Cards/Index.md", to: "0-In/Index (2).md", pageId: id("i2"), reason: SUBS },
    { from: "Library/Solo.md", to: "0-In/Solo.md", pageId: null, reason: SUBS },
  ]);
  const clash = resolve({ notes: [note("Library/Index.md"), note("0-In/index.md")] });
  assert.deepEqual(clash.relocations, [{ from: "Library/Index.md", to: "0-In/Index (2).md", pageId: null, reason: SUBS }]);
});

test("new folders holding notes are to be created; empty or ambiguous ones are not", () => {
  const context = ctx({ extra: ["A", "A/Notes", "B", "B/Notes"], projects: [] });
  const r = resolve({ notes: [note("Layouts/a.md"), note("Layouts/b.md"), note("A/Notes/n.md")], context });
  assert.deepEqual(r.creates, ["Layouts"]);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /A\/Notes/);
  assert.match(r.warnings[0]!, /both claim/);
});

test("a stored project folder that gained subfolders warns once and keeps its notes", () => {
  const context = ctx({ stored: { astronomy: { path: "Astronomy", title: "Astronomy" } }, extra: ["Astronomy/Labs"] });
  const r = resolve({ notes: [note("Astronomy/a.md", "a")], pages: [page("a", ["astronomy"])], records: [rec("a", "Astronomy/a.md", "Astronomy", "astronomy")], context });
  assert.deepEqual(r.warnings, ["Astronomy now has subfolders; its notes keep the project Astronomy"]);
  assert.deepEqual(r.relocations, []);
  assert.equal(r.pageFolders.get(id("a")), "Astronomy");
});

test("projects born in Notion get distinct folders that avoid existing ones", () => {
  const context = ctx({ projects: [{ id: id("p1"), title: "Library" }, { id: id("p2"), title: "New" }, { id: id("p3"), title: "new" }] });
  const r = resolve({ pages: [page("a", ["p1"]), page("b", ["p2"]), page("c", ["p3"]), page("d")], context });
  assert.equal(r.pageFolders.get(id("a")), "Library (2)");
  assert.equal(r.pageFolders.get(id("b")), "New");
  assert.equal(r.pageFolders.get(id("c")), "new (2)");
  assert.equal(r.pageFolders.get(id("d")), "0-In");
  assert.deepEqual(r.stored.get(id("p1")), { path: "Library (2)", title: "Library" });
});

test("disabled: every page keeps its record's folder and nothing else happens", () => {
  const r = resolve({ enabled: false, notes: [note("Library/x.md", "x")], pages: [page("x", ["solo"]), page("n")], records: [rec("x", "Library/x.md", "Library")] });
  assert.deepEqual([...r.pageFolders], [[id("x"), "Library"], [id("n"), null]]);
  assert.deepEqual([r.relocations, r.fileProject, r.renames, r.creates, r.warnings], [[], [], [], [], []]);
  assert.equal(r.stored.size, 0);
});

test("two unstored folders matching one project are both left alone", () => {
  const context = ctx({ extra: ["Old", "Old/Astronomy"], projects: [{ id: id("astronomy"), title: "Astronomy" }] });
  const r = resolve({
    notes: [note("Astronomy/a.md", "a"), note("Old/Astronomy/b.md", "b")],
    pages: [page("a"), page("b")],
    records: [rec("a", "Astronomy/a.md", "Astronomy"), rec("b", "Old/Astronomy/b.md", "Old/Astronomy")],
    context,
  });
  assert.equal(r.stored.has(id("astronomy")), false);
  assert.deepEqual(r.fileProject, []);
  assert.deepEqual(r.relocations, []);
  assert.deepEqual(r.creates, []);
  assert.equal(r.pageFolders.get(id("a")), "Astronomy");
  assert.equal(r.pageFolders.get(id("b")), "Old/Astronomy");
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0]!, /both match/);
});

test("a name matching two projects leaves the notes alone", () => {
  const context = ctx({ projects: [{ id: id("c1"), title: "Astronomy" }, { id: id("c2"), title: "astronomy" }] });
  const r = resolve({ notes: [note("Astronomy/a.md", "a")], pages: [page("a")], records: [rec("a", "Astronomy/a.md", "Astronomy")], context });
  assert.equal(r.pageFolders.get(id("a")), "Astronomy");
  assert.deepEqual([r.fileProject, r.relocations, r.creates], [[], [], []]);
  assert.match(r.warnings[0]!, /2 projects are named/);
});

test("a folder matching a project stored at another path is ambiguous", () => {
  const context = ctx({ extra: ["Old", "Old/Astronomy"], stored: { astronomy: { path: "Astronomy", title: "Astronomy" } } });
  const r = resolve({ notes: [note("Old/Astronomy/b.md", "b")], pages: [page("b", ["astronomy"])], records: [rec("b", "Old/Astronomy/b.md", "Old/Astronomy")], context });
  assert.deepEqual(r.fileProject, []);
  assert.match(r.warnings[0]!, /already has the folder "Astronomy"/);
});

test("attachment-folder notes are evicted, also with a defined record project", () => {
  const unpaired = resolve({ notes: [note("Assets/attachments/n.md")] });
  assert.deepEqual(unpaired.relocations, [{ from: "Assets/attachments/n.md", to: "0-In/n.md", pageId: null, reason: "the attachment folder can't be a project" }]);
  const r = resolve({ notes: [note("Library/x.md", "x")], pages: [page("x", ["solo"])], records: [rec("x", "Library/x.md", "Library", "solo")] });
  assert.deepEqual(r.relocations, [{ from: "Library/x.md", to: "0-In/x.md", pageId: id("x"), reason: SUBS }]);
  assert.deepEqual(r.fileProject, []);
});

test("subfolder warning survives an NFD folder on disk", () => {
  const nfd = "Été".normalize("NFD");
  const context = ctx({ folders: new Set(["0-In", nfd, `${nfd}/Sub`]), projects: [{ id: id("eco"), title: "Été" }], stored: { eco: { path: "Été", title: "Été" } } });
  const r = resolve({ context });
  assert.equal(r.warnings.length, 1);
});

test("an Obsidian rename keeps the new title when Notion's changed too", () => {
  const context = ctx({
    folders: new Set(["0-In", "Weaving"]),
    projects: [{ id: id("astronomy"), title: "Astronomy Club" }],
    stored: { astronomy: { path: "Astronomy", title: "Astronomy" } },
  });
  const r = resolve({ notes: [note("Weaving/a.md", "a")], pages: [page("a", ["astronomy"])], records: [rec("a", "Astronomy/a.md", "Astronomy", "astronomy")], context });
  assert.deepEqual(r.renames.map((x) => x.side), ["obsidian"]);
  assert.deepEqual(r.stored.get(id("astronomy")), { path: "Weaving", title: "Weaving" });
});

// --- final review wave ---

const withStoredAstronomy = () => ctx({ projects: [{ id: id("astronomy"), title: "Astronomy" }, { id: id("solo"), title: "Solo" }], stored: { astronomy: { path: "Astronomy", title: "Astronomy" } } });

test("item 1: a record whose project is null while the page has none and the note sits in a project folder: the vault decides and files it", () => {
  const r = resolve({ notes: [note("Astronomy/a.md", "a")], pages: [page("a")], records: [rec("a", "Astronomy/a.md", "Astronomy", null)], context: withStoredAstronomy() });
  assert.equal(r.pageFolders.get(id("a")), "Astronomy");
  assert.deepEqual(r.fileProject, [id("a")]);
  assert.deepEqual(r.relocations, []);
});

test("item 1: Notion unchanged and the note moved: the planner's rename writes it, nothing extra is filed", () => {
  const r = resolve({ notes: [note("Astronomy/a.md", "a")], pages: [page("a", ["solo"])], records: [rec("a", "Solo/a.md", "Solo", "solo")], context: ctx({ projects: [{ id: id("astronomy"), title: "Astronomy" }, { id: id("solo"), title: "Solo" }], stored: { astronomy: { path: "Astronomy", title: "Astronomy" }, solo: { path: "Solo", title: "Solo" } } }) });
  assert.equal(r.pageFolders.get(id("a")), "Astronomy");
  assert.deepEqual(r.fileProject, []);
});

test("item 1: Notion unchanged and the note in the default folder with a project in the record: the vault's none wins", () => {
  const r = resolve({ notes: [note("0-In/a.md", "a")], pages: [page("a", ["astronomy"])], records: [rec("a", "0-In/a.md", "0-In", "astronomy")], context: withStoredAstronomy() });
  assert.equal(r.pageFolders.get(id("a")), "0-In");
  assert.deepEqual(r.fileProject, [id("a")]);
});

test("item 2: a note in an ambiguous folder stays put, also with a defined record project", () => {
  const context = ctx({ projects: [{ id: id("c1"), title: "Astronomy" }, { id: id("c2"), title: "astronomy" }] });
  const r = resolve({ notes: [note("Astronomy/a.md", "a")], pages: [page("a")], records: [rec("a", "Astronomy/a.md", "Astronomy", null)], context });
  assert.equal(r.pageFolders.get(id("a")), "Astronomy");
  assert.deepEqual([r.fileProject, r.relocations], [[], []]);
});

test("item 5: a Notion rename whose notes could not move is not renamed back as an Obsidian folder rename, and the note's move is planned", () => {
  // Run 1 renamed Old to New in Notion and saved the store as New; the note's move was skipped, so it is still in Old.
  const context = ctx({ folders: new Set(["0-In", "Old"]), projects: [{ id: id("p"), title: "New" }], stored: { p: { path: "New", title: "New" } } });
  const r = resolve({ notes: [note("Old/a.md", "a")], pages: [page("a", ["p"])], records: [rec("a", "Old/a.md", "Old", "p")], context });
  assert.deepEqual(r.renames, []);
  assert.equal(r.pageFolders.get(id("a")), "New");
  assert.deepEqual(r.stored.get(id("p")), { path: "New", title: "New" });
  assert.deepEqual([r.fileProject, r.relocations, r.creates], [[], [], []]);
});

test("item 7: a note of a page with several projects left in the default folder or at the root stays, with one warning and nothing filed", () => {
  const context = ctx({ projects: [{ id: id("astronomy"), title: "Astronomy" }, { id: id("solo"), title: "Solo" }], stored: { astronomy: { path: "Astronomy", title: "Astronomy" }, solo: { path: "Solo", title: "Solo" } } });
  // Moved in Obsidian since the last run.
  const moved = resolve({ notes: [note("0-In/a.md", "a")], pages: [page("a", ["astronomy", "solo"])], records: [rec("a", "Astronomy/a.md", "Astronomy", "astronomy")], context });
  assert.equal(moved.pageFolders.get(id("a")), "0-In");
  assert.deepEqual([moved.fileProject, moved.relocations], [[], []]);
  assert.deepEqual(moved.warnings, ["0-In/a.md is in 0-In but its page has the projects Astronomy, Solo in Notion; they were left as they are"]);
  // On a later run, where its record keeps it.
  const later = resolve({ notes: [note("a.md", "a")], pages: [page("a", ["astronomy", "solo"])], records: [rec("a", "a.md", null, "astronomy")], context });
  assert.equal(later.pageFolders.get(id("a")), null);
  assert.deepEqual([later.fileProject, later.relocations], [[], []]);
  assert.equal(later.warnings.length, 1);
  assert.match(later.warnings[0]!, /^a\.md is in the vault root but its page has the projects Astronomy, Solo/);
  // A single project is removed: filed.
  const single = resolve({ notes: [note("0-In/a.md", "a")], pages: [page("a", ["astronomy"])], records: [rec("a", "0-In/a.md", "0-In", "astronomy")], context });
  assert.deepEqual(single.fileProject, [id("a")]);
  assert.deepEqual(single.warnings, []);
});

test("P4: a kept-out page stays kept whatever Notion does to its projects, until its note leaves the folder or the page has no project", () => {
  const context = ctx({ projects: [{ id: id("astronomy"), title: "Astronomy" }, { id: id("solo"), title: "Solo" }], stored: { astronomy: { path: "Astronomy", title: "Astronomy" }, solo: { path: "Solo", title: "Solo" } } });
  const keptRecord = { ...rec("a", "0-In/a.md", "0-In", "astronomy"), keptOut: true as const };
  // The item-7 path marks the page.
  const first = resolve({ notes: [note("0-In/a.md", "a")], pages: [page("a", ["astronomy", "solo"])], records: [rec("a", "Astronomy/a.md", "Astronomy", "astronomy")], context });
  assert.equal(first.keptOut.get(id("a")), true);
  // Notion drops the second project: the page is still kept, nothing is filed, the remaining project is untouched.
  const dropped = resolve({ notes: [note("0-In/a.md", "a")], pages: [page("a", ["astronomy"])], records: [keptRecord], context });
  assert.deepEqual([dropped.fileProject, dropped.relocations], [[], []]);
  assert.equal(dropped.pageFolders.get(id("a")), "0-In");
  assert.equal(dropped.keptOut.get(id("a")), true);
  assert.equal(dropped.warnings.length, 1);
  // The note moves to a project's folder in Obsidian: the normal rules apply again.
  const away = resolve({ notes: [note("Solo/a.md", "a")], pages: [page("a", ["astronomy"])], records: [keptRecord], context });
  assert.equal(away.keptOut.get(id("a")), false);
  assert.equal(away.pageFolders.get(id("a")), "Solo");
  // The page has no project any more: the flag ends.
  const none = resolve({ notes: [note("0-In/a.md", "a")], pages: [page("a")], records: [keptRecord], context });
  assert.equal(none.keptOut.get(id("a")), false);
  assert.deepEqual(none.fileProject, []);
});

test("P7: a stored path that is now the default folder or the attachment folder gets a folder by the collision rule, not the inbox", () => {
  for (const path of ["0-In", "Assets/attachments"]) {
    // The leaf folder Astronomy exists and is nobody's: it is used.
    const context = ctx({ projects: [{ id: id("astronomy"), title: "Astronomy" }], stored: { astronomy: { path, title: "Astronomy" } } });
    const r = resolve({ pages: [page("a", ["astronomy"])], context });
    assert.equal(r.pageFolders.get(id("a")), "Astronomy", path);
    assert.deepEqual(r.stored.get(id("astronomy")), { path: "Astronomy", title: "Astronomy" }, path);
    // Another project has that folder: a unique name.
    const taken = ctx({ projects: [{ id: id("astronomy"), title: "Astronomy" }, { id: id("other"), title: "Other" }], stored: { astronomy: { path, title: "Astronomy" }, other: { path: "Astronomy", title: "Other" } } });
    const second = resolve({ pages: [page("a", ["astronomy"])], context: taken });
    assert.equal(second.pageFolders.get(id("a")), "Astronomy (2)", path);
  }
  // A path that is neither stays.
  const fine = resolve({ pages: [page("a", ["astronomy"])], context: ctx({ stored: { astronomy: { path: "Astronomy", title: "Astronomy" } } }) });
  assert.equal(fine.pageFolders.get(id("a")), "Astronomy");
});

test("item 11: name matching ignores the spaces around a name", () => {
  const c = ctx({ projects: [{ id: id("r"), title: "Hiking " }, { id: id("l"), title: " moss" }], extra: ["MOSS"] });
  assert.deepEqual(folderMeaning("Hiking", c), { kind: "project", id: id("r") });
  assert.deepEqual(folderMeaning("MOSS", c), { kind: "project", id: id("l") });
});

test("item 12: evicted names are unique in NFC and against drawings", () => {
  const r = resolveProjects({
    enabled: true,
    notes: [note("Library/Été.md"), note("0-In/Été.md".normalize("NFD")), note("Library/Board.md")],
    drawings: ["0-In/Board.md"],
    pages: [],
    records: new Map(),
    context: ctx(),
  });
  assert.deepEqual(r.relocations.map((m) => m.to), ["0-In/Été (2).md", "0-In/Board (2).md"]);
});

test("item 10: a new folder is created as a project only when a note is filed in it", () => {
  const context = ctx({ extra: ["Foo"], projects: [{ id: id("astronomy"), title: "Astronomy" }, { id: id("solo"), title: "Solo" }], stored: { astronomy: { path: "Astronomy", title: "Astronomy" }, solo: { path: "Solo", title: "Solo" } } });
  // Notion changed the project, so Notion wins and nothing is filed in Foo.
  const notFiled = resolve({ notes: [note("Foo/a.md", "a")], pages: [page("a", ["solo"])], records: [rec("a", "Foo/a.md", "Foo", "astronomy")], context });
  assert.deepEqual(notFiled.creates, []);
  // An unpaired note's page is created from its folder.
  assert.deepEqual(resolve({ notes: [note("Foo/b.md")], context }).creates, ["Foo"]);
});

test("R2: both apps changed the project and the note moved to a new folder: that folder's project is created", () => {
  const context = ctx({ extra: ["Foo"], projects: [{ id: id("astronomy"), title: "Astronomy" }, { id: id("solo"), title: "Solo" }], stored: { astronomy: { path: "Astronomy", title: "Astronomy" }, solo: { path: "Solo", title: "Solo" } } });
  // Another Astronomy note stays, so this is no folder rename.
  const r = resolve({ notes: [note("Foo/a.md", "a"), note("Astronomy/b.md", "b")], pages: [page("a", ["solo"]), page("b", ["astronomy"])], records: [rec("a", "Astronomy/a.md", "Astronomy", "astronomy"), rec("b", "Astronomy/b.md", "Astronomy", "astronomy")], context });
  assert.deepEqual(r.creates, ["Foo"]);
});

test("P4 minor: the kept warning reads well when the project titles are not all known", () => {
  const context = ctx({ projects: [{ id: id("astronomy"), title: "Astronomy" }], stored: { astronomy: { path: "Astronomy", title: "Astronomy" } } });
  const some = resolve({ notes: [note("0-In/a.md", "a")], pages: [page("a", ["astronomy", "gone"])], records: [rec("a", "Astronomy/a.md", "Astronomy", "astronomy")], context });
  assert.match(some.warnings[0]!, /has the projects Astronomy and others in Notion/);
  const none = resolve({ notes: [note("0-In/a.md", "a")], pages: [page("a", ["astronomy", "gone"])], records: [{ ...rec("a", "0-In/a.md", "0-In", "astronomy"), keptOut: true }], context: ctx({ projects: [] }) });
  assert.match(none.warnings[0] ?? "", /has other projects in Notion/);
});

test("a dropped project whose stored path is the default folder is not listed for removal", () => {
  const context = ctx({ projects: [], stored: { x: { path: "0-In", title: "X" }, y: { path: "Backlog", title: "Y" } } });
  assert.deepEqual(resolve({ context }).droppedFolders, ["Backlog"]);
});
