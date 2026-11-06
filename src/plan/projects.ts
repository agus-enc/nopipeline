// What each vault folder means for projects: a project's folder, a place its notes move out of, or a project to create.
import { baseName } from "../links/index.ts";
import { titleToFileName, uniqueName } from "../vault/filenames.ts";
import type { StoredProject } from "../state/projects.ts";
import type { PageId, PageMeta, ProjectMeta, SyncRecord, VaultNote } from "../types.ts";

export interface FolderContext {
  inboxFolder: string;
  attachmentFolder: string;
  /** Every visible vault folder path. */
  folders: ReadonlySet<string>;
  projects: readonly ProjectMeta[];
  stored: ReadonlyMap<PageId, StoredProject>;
}

export type FolderMeaning =
  | { kind: "none" }
  | { kind: "evict" }
  | { kind: "project"; id: PageId }
  | { kind: "new"; title: string }
  | { kind: "ambiguous"; reason: string };

const nfc = (text: string) => text.normalize("NFC");
/** The project name match: equal after NFC, ignoring case and the spaces around the name. */
const sameName = (a: string, b: string) => nfc(a).trim().toLowerCase() === nfc(b).trim().toLowerCase();
const lastSegment = (folder: string) => folder.slice(folder.lastIndexOf("/") + 1);
const visible = (folder: string) => folder.split("/").every((name) => !name.startsWith("."));

/** A visible folder with no visible subfolder. */
export function isLeaf(folder: string, folders: ReadonlySet<string>): boolean {
  if (!visible(folder)) return false;
  const prefix = `${nfc(folder)}/`;
  for (const other of folders) if (visible(other) && nfc(other).startsWith(prefix)) return false;
  return true;
}

function storedId(folder: string, stored: ReadonlyMap<PageId, StoredProject>): PageId | null {
  for (const [id, project] of stored) if (nfc(project.path) === nfc(folder)) return id;
  return null;
}

export function folderMeaning(folder: string, ctx: FolderContext): FolderMeaning {
  if (folder === "" || nfc(folder) === nfc(ctx.inboxFolder)) return { kind: "none" };
  const id = storedId(folder, ctx.stored);
  if (id !== null) return { kind: "project", id };
  if (nfc(folder) === nfc(ctx.attachmentFolder)) return { kind: "evict" };
  if (!isLeaf(folder, ctx.folders)) return { kind: "evict" };

  const name = lastSegment(folder);
  const matches = ctx.projects.filter((project) => sameName(project.title, name));
  if (matches[0] !== undefined && matches.length === 1) return { kind: "project", id: matches[0].id };
  if (matches.length > 1) return { kind: "ambiguous", reason: `${matches.length} projects are named "${name}"` };

  const rivals = [...ctx.folders].filter(
    (other) =>
      nfc(other) !== nfc(folder) &&
      sameName(lastSegment(other), name) &&
      nfc(other) !== nfc(ctx.inboxFolder) &&
      nfc(other) !== nfc(ctx.attachmentFolder) &&
      storedId(other, ctx.stored) === null &&
      isLeaf(other, ctx.folders),
  );
  if (rivals.length > 0) return { kind: "ambiguous", reason: `the folders ${[folder, ...rivals].map((f) => `"${f}"`).join(" and ")} both claim the project name "${name}"` };
  return { kind: "new", title: nfc(name) };
}

/**
 * The root folder for a project born in Notion: the file-name form of its title, used when no such folder exists or it is a
 * leaf that is nobody's stored path; otherwise `Name (2)`, `Name (3)`, ... (spec §5 B9). `claimed` holds the folders already
 * chosen this run for other new projects.
 */
export function folderForNewProject(title: string, ctx: FolderContext, claimed: ReadonlySet<string>): string {
  const base = titleToFileName(title);
  const key = (name: string) => nfc(name).toLowerCase();
  const roots = new Set([...ctx.folders].filter((f) => !f.includes("/")).map(key));
  const stored = new Set([...ctx.stored.values()].map((p) => key(p.path)));
  const taken = new Set([...roots, ...[...claimed].map(key), ...stored, key(ctx.inboxFolder), key(ctx.attachmentFolder)]);
  const existing = [...ctx.folders].find((f) => key(f) === key(base));
  const usable =
    ![...claimed].some((c) => key(c) === key(base)) &&
    (existing === undefined
      ? !taken.has(key(base))
      : isLeaf(existing, ctx.folders) && !stored.has(key(existing)) && key(existing) !== key(ctx.inboxFolder) && key(existing) !== key(ctx.attachmentFolder));
  if (usable) return base;
  return uniqueName(nfc(base), taken);
}

export interface ProjectResolution {
  /** The folder each page belongs in (null: the vault root), to be set as `page.folder`. */
  pageFolders: Map<PageId, string | null>;
  /** Notes to move out of a folder that means nothing (not a leaf, the attachment folder); `pageId` is null for a note without a page. */
  relocations: { from: string; to: string; pageId: PageId | null; reason: string }[];
  /** Pages whose project the vault decides (a record with no `project` yet): the executor writes it from the note's folder. */
  fileProject: PageId[];
  /** Why a page's note goes to another folder because of its project (for the dry run to say). */
  moveReasons: Map<PageId, string>;
  renames: { id: PageId; title: string; from: string; to: string; side: "obsidian" | "notion" }[];
  /** The project store as it should be after the run. */
  stored: Map<PageId, StoredProject>;
  /** Titles of the projects a vault folder holding notes needs created at execution. */
  creates: string[];
  /** The stored folders of projects that are no longer live (trashed or gone): emptied by the run, they are removed when completely empty. */
  droppedFolders: string[];
  /** Pages whose record should carry (true) or lose (false) `keptOut` after the run; a page not listed keeps its record as it is. */
  keptOut: Map<PageId, boolean>;
  /** The folders holding notes that are left alone because they are ambiguous: no relation is written for a note in one. */
  ambiguous: string[];
  warnings: string[];
}

const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
const key = (text: string) => nfc(text).toLowerCase();

/**
 * Which folder every page belongs in and which notes must move out of folders that mean nothing (spec §3 B1–B3, §5 B3, B6,
 * B9). Pure: it reads, it does not write. A record with `project` defined takes the folder of the page's current first
 * project (a note moved in Obsidian shows as a changed path, and the planner lets the vault win); a record without it is
 * the migration, where the vault's folder wins when it means a project and Notion's project wins when it doesn't.
 */
export function resolveProjects(input: {
  enabled: boolean;
  notes: VaultNote[];
  pages: PageMeta[];
  records: ReadonlyMap<PageId, SyncRecord>;
  context: FolderContext;
  /** The vault's Excalidraw drawings: their names are taken too when notes move. */
  drawings?: readonly string[];
}): ProjectResolution {
  const { enabled, notes, pages, records, context } = input;
  const result: ProjectResolution = { pageFolders: new Map(), relocations: [], fileProject: [], moveReasons: new Map(), renames: [], stored: new Map(), creates: [], droppedFolders: [], keptOut: new Map(), ambiguous: [], warnings: [] };
  if (!enabled) {
    for (const page of pages) result.pageFolders.set(page.id, records.get(page.id)?.folder ?? null);
    return result;
  }

  const live = new Map(context.projects.map((p) => [p.id, p]));
  // A stored project that is trashed or gone is forgotten; its notes follow Notion (no project).
  const stored0 = new Map<PageId, StoredProject>();
  const droppedPaths = new Set<string>();
  for (const [id, project] of context.stored) {
    // A stored path that is now the default folder or the attachment folder is no project's folder: the project gets one by the collision rule (§5 B9).
    const taken = nfc(project.path) === nfc(context.inboxFolder) || nfc(project.path) === nfc(context.attachmentFolder);
    if (live.has(id)) {
      if (!taken) stored0.set(id, { ...project });
    } else {
      droppedPaths.add(nfc(project.path));
      if (!taken) result.droppedFolders.push(project.path);
    }
  }
  const c0: FolderContext = { ...context, stored: stored0 };
  const stored = result.stored;
  for (const [id, project] of stored0) stored.set(id, { ...project });

  for (const [id, project] of stored0) {
    if ([...context.folders].some((f) => nfc(f) === nfc(project.path)) && !isLeaf(project.path, context.folders)) {
      result.warnings.push(`${project.path} now has subfolders; its notes keep the project ${live.get(id)!.title}`);
    }
  }

  const pageById = new Map(pages.map((p) => [p.id, p]));
  const notesById = new Map(notes.filter((n) => n.notionId).map((n) => [n.notionId!, n]));
  const notesByPath = new Map(notes.map((n) => [n.path, n]));
  const recordsByPath = new Map([...records.values()].map((r) => [r.path, r]));
  const noteOfRecord = (record: SyncRecord): VaultNote | undefined => {
    const byId = notesById.get(record.notionId);
    if (byId) return byId;
    const atPath = notesByPath.get(record.path);
    return atPath && atPath.notionId === null ? atPath : undefined;
  };

  // B6, Obsidian side: all of a project's recorded notes now sit in one unstored folder and its old folder has no notes left.
  const override = new Map<string, PageId>();
  for (const [id, project] of stored0) {
    const folders = new Set<string>();
    let unmoved = false;
    for (const record of records.values()) {
      if (record.project !== id) continue;
      const found = noteOfRecord(record);
      if (!found) continue;
      folders.add(nfc(folderOf(found.path)));
      // A note still in the folder its record names did not move: it is not Obsidian that renamed the folder (a move to a project
      // renamed in Notion may just not have happened yet).
      if (nfc(folderOf(found.path)) === nfc(record.folder ?? "")) unmoved = true;
    }
    const target = folders.size === 1 && !unmoved ? [...folders][0]! : undefined;
    if (target === undefined || target === "" || target === nfc(project.path)) continue;
    const oldPrefix = `${nfc(project.path)}/`;
    if (notes.some((n) => nfc(n.path).startsWith(oldPrefix))) continue;
    const meaning = folderMeaning(target, c0);
    if (meaning.kind === "project" && meaning.id === id) {
      stored.set(id, { path: target, title: live.get(id)!.title });
      override.set(key(target), id);
    } else if (meaning.kind === "new") {
      result.renames.push({ id, title: meaning.title, from: project.path, to: target, side: "obsidian" });
      stored.set(id, { path: target, title: meaning.title });
      override.set(key(target), id);
    }
  }

  // B6, Notion side: a project's title changed, so its stored path's last name follows.
  const renamedHere = new Set(result.renames.map((r) => r.id));
  for (const [id, project] of stored0) {
    const title = live.get(id)!.title;
    if (renamedHere.has(id) || stored.get(id)!.path !== project.path || nfc(title) === nfc(project.title)) continue;
    const parent = folderOf(project.path);
    const base = titleToFileName(title);
    const taken = new Set([...context.folders, ...[...stored.values()].map((p) => p.path), context.inboxFolder, context.attachmentFolder].map(key));
    taken.delete(key(project.path));
    const pathFor = (name: string) => (parent === "" ? name : `${parent}/${name}`);
    let to = pathFor(nfc(base));
    for (let n = 2; taken.has(key(to)); n++) to = pathFor(`${nfc(base)} (${n})`);
    if (nfc(to) !== nfc(project.path)) result.renames.push({ id, title, from: project.path, to, side: "notion" });
    stored.set(id, { path: to, title });
  }

  // What each folder holding notes means. Two or more unstored folders matching one project are all ambiguous: no guessing.
  const meanings = new Map<string, FolderMeaning>();
  const folderList = [...new Set(notes.map((n) => folderOf(n.path)))].sort();
  const claimants = new Map<PageId, string[]>();
  for (const folder of folderList) {
    const forced = override.get(key(folder));
    let meaning: FolderMeaning = forced !== undefined ? { kind: "project", id: forced } : folderMeaning(folder, c0);
    if (meaning.kind === "new" && droppedPaths.has(nfc(folder))) meaning = { kind: "none" };
    if (meaning.kind === "project" && forced === undefined) {
      const was = stored0.get(meaning.id);
      if (was !== undefined && nfc(was.path) !== nfc(folder)) {
        meaning = { kind: "ambiguous", reason: `the project "${live.get(meaning.id)!.title}" already has the folder "${was.path}"` };
      } else if (was === undefined) {
        claimants.set(meaning.id, [...(claimants.get(meaning.id) ?? []), folder]);
      }
    }
    meanings.set(folder, meaning);
  }
  for (const [id, folders] of claimants) {
    if (folders.length > 1) {
      const reason = `the folders ${folders.map((f) => `"${f}"`).join(" and ")} both match the project "${live.get(id)!.title}"`;
      for (const folder of folders) meanings.set(folder, { kind: "ambiguous", reason });
    } else {
      stored.set(id, { path: folders[0]!, title: live.get(id)!.title });
    }
  }
  for (const [folder, meaning] of meanings) {
    if (meaning.kind === "ambiguous") {
      result.warnings.push(`the folder "${folder}" is left alone: ${meaning.reason}`);
      result.ambiguous.push(folder);
    }
  }

  const claimedFolders = new Set<string>();
  /** The folder of a project: its stored one, else a new root folder (spec §5 B9) that is then remembered. */
  const folderOfProject = (id: PageId): string => {
    const known = stored.get(id);
    if (known) return known.path;
    const title = live.get(id)!.title;
    const folder = folderForNewProject(title, { ...context, stored }, claimedFolders);
    claimedFolders.add(folder);
    stored.set(id, { path: folder, title });
    return folder;
  };
  /** The page's first project when it is a live one. */
  const firstProject = (page: PageMeta): PageId | null => {
    const first = page.projects?.ids[0];
    return first !== undefined && live.has(first) ? first : null;
  };
  /** No project: stay at the root or in the default folder, otherwise the default folder. */
  const noneFolder = (record: SyncRecord | undefined): string | null =>
    record !== undefined && (record.folder === null || record.folder === "" || nfc(record.folder) === nfc(context.inboxFolder)) ? record.folder : context.inboxFolder;

  /** Whether the page has more than one project. */
  const several = (page: PageMeta) => (page.projects?.ids.length ?? 0) > 1;
  const creates = new Map<string, string>();
  const moving: { note: VaultNote; folder: string; pageId: PageId | null; reason: string }[] = [];
  /** Why a note leaves a folder that means no project. */
  const evictReason = (folder: string) => (nfc(folder) === nfc(context.attachmentFolder) ? "the attachment folder can't be a project" : "its folder has subfolders");
  const decided = new Set<PageId>();
  for (const note of notes) {
    const folder = folderOf(note.path);
    const meaning = meanings.get(folder)!;
    let record = note.notionId ? records.get(note.notionId) : undefined;
    if (!record && note.notionId === null) record = recordsByPath.get(note.path);
    const page = pageById.get(record?.notionId ?? note.notionId ?? "");
    if (record && !page) continue; // the planner trashes or recreates it
    /** A new folder is created as a project only when a note is actually filed in it. */
    const needsProject = () => {
      if (meaning.kind === "new") creates.set(key(meaning.title), meaning.title);
    };
    if (!page) {
      if (meaning.kind === "evict") moving.push({ note, folder: context.inboxFolder, pageId: null, reason: evictReason(folder) });
      else if (!record) needsProject(); // its page is created from its folder
      continue;
    }

    const first = firstProject(page);
    let pageFolder: string | null;
    /** Why the page's note changes folder with its project, as the dry run says it. */
    let why: string | undefined;
    if (meaning.kind === "ambiguous") {
      // Nothing is written and the note is not moved, whatever the record says (spec §3 B5).
      pageFolder = record?.folder ?? (folder || null);
    } else if (record?.project !== undefined) {
      // A three-way merge (spec §5 B3): the record's project is what both sides last agreed on.
      const notionChanged = first !== (record.project ?? null);
      result.keptOut.set(page.id, false);
      if (meaning.kind === "evict") {
        pageFolder = first !== null ? folderOfProject(first) : noneFolder(record);
        moving.push({ note, folder: context.inboxFolder, pageId: page.id, reason: evictReason(folder) });
      } else if (meaning.kind === "none" && ((first !== null && several(page) && (note.path !== record.path || !notionChanged)) || (record.keptOut === true && (page.projects?.ids.length ?? 0) > 0))) {
        // A page with several projects whose note was put in the default folder or at the root: the note stays where Obsidian put it
        // and Notion is left as it is (spec §3 B3). The record remembers it (`keptOut`), so that
        // the page stays alone even after Notion drops all but one of its projects, until the note leaves or the page has none.
        pageFolder = folder || null;
        result.keptOut.set(page.id, true);
        const titles = page.projects!.ids.flatMap((p) => live.get(p)?.title ?? []);
        result.warnings.push(
          `${note.path} is in ${folder || "the vault root"} but its page has ${titles.length > 0 ? `the projects ${titles.join(", ")}${titles.length < page.projects!.ids.length ? " and others" : ""}` : "other projects"} in Notion; they were left as they are`,
        );
      } else if (notionChanged) {
        // Notion's side changed: it wins unless the note moved in Obsidian too, which the planner sees as a changed path.
        pageFolder = first !== null ? folderOfProject(first) : noneFolder(record);
        // Both changed: the note's rename writes its folder's project, creating it if the folder is new.
        if (note.path !== record.path) needsProject();
        why = record.project !== null && !live.has(record.project) ? "its project was trashed" : first === null ? "its project was removed in Notion" : "its project changed in Notion";
      } else {
        // Notion is as it was, so the vault's folder decides. A note that moved is written by its rename; one that did not
        // and whose project differs from Notion's is filed.
        const moved = note.path !== record.path;
        if (meaning.kind === "project") {
          pageFolder = stored.get(meaning.id)!.path;
          why = "its project was renamed";
          if (!moved && meaning.id !== first) result.fileProject.push(page.id);
        } else if (meaning.kind === "new" && !moved && first !== null) {
          // The note is where its record has it and the folder is nobody's: the folder is the old name of the project's, whose
          // move (a rename from Notion that was skipped) the planner makes now.
          pageFolder = folderOfProject(first);
          why = "its project was renamed";
        } else if (meaning.kind === "new") {
          pageFolder = folder;
          needsProject();
          if (!moved) result.fileProject.push(page.id);
        } else {
          pageFolder = folder || null;
          if (!moved && first !== null) result.fileProject.push(page.id);
        }
      }
    } else if (meaning.kind === "project") {
      pageFolder = stored.get(meaning.id)!.path;
      result.fileProject.push(page.id);
    } else if (meaning.kind === "new") {
      pageFolder = folder;
      needsProject();
      result.fileProject.push(page.id);
    } else {
      pageFolder = first !== null ? folderOfProject(first) : noneFolder(record);
      if (first !== null) why = `its page has the project ${live.get(first)!.title} in Notion`;
      if (meaning.kind === "evict") moving.push({ note, folder: first !== null ? pageFolder! : context.inboxFolder, pageId: page.id, reason: evictReason(folder) });
    }
    if (why !== undefined && record !== undefined && nfc(pageFolder ?? "") !== nfc(record.folder ?? "")) result.moveReasons.set(page.id, why);
    result.pageFolders.set(page.id, pageFolder);
    decided.add(page.id);
  }

  for (const page of pages) {
    if (decided.has(page.id)) continue;
    const first = firstProject(page);
    result.pageFolders.set(page.id, first !== null ? folderOfProject(first) : noneFolder(records.get(page.id)));
  }

  // Unique names against every note staying put and the ones already placed (as the planner's `place` does).
  const movingNotes = new Set(moving.map((m) => m.note));
  const taken = new Set([...notes.filter((n) => !movingNotes.has(n)).map((n) => n.path), ...(input.drawings ?? [])].map((path) => key(baseName(path))));
  for (const { note, folder, pageId, reason } of moving) {
    // Compared in NFC (a name that differs only in Unicode form is the same name); the file keeps the form it has.
    const base = baseOf(note.path);
    let name = base;
    for (let n = 2; taken.has(key(name)); n++) name = `${base} (${n})`;
    taken.add(key(name));
    result.relocations.push({ from: note.path, to: `${folder ? `${folder}/` : ""}${name}.md`, pageId, reason });
  }
  result.creates = [...creates.values()];
  return result;
}
