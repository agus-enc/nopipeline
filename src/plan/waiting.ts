// Which pages and paths wait this run because a note is in use (open in Obsidian or just edited). Pure: the sync
// decides nothing here, it only asks. Renames and folder moves wait as a whole, so none is half-applied.
import { posix } from "node:path";
import { buildLinkIndex, resolveLink, stem, type LinkEntry } from "../links/index.ts";
import { outsideCode } from "../links/rewrite.ts";
import type { PageId, SyncRecord, VaultNote } from "../types.ts";
import { splitFrontmatter } from "../vault/frontmatter.ts";
import type { Action } from "./planner.ts";

export interface Waiting {
  pages: ReadonlySet<PageId>;
  paths: ReadonlySet<string>;
  /** The notes in use whose links made a rename wait (they are listed as waiting too, though nothing is done to them). */
  linking: ReadonlySet<string>;
}

const WIKI = /!?\[\[([^\]\n]+?)\]\]/g;
const MD_LINK = /!?\[(?:[^[\]\n\\]|\\.)*\]\(([^)\s]+)(?:[ \t]+"[^"\n]*")?\)/g;

/** The paths an action writes, moves or reads a note at. */
function pathsOf(action: Action): string[] {
  switch (action.kind) {
    case "relocate":
    case "moveInVault":
      return [action.from, action.to];
    case "convertLinks":
    case "convertImages":
    case "writeId":
    case "createPage":
    case "recreatePage":
    case "createNote":
    case "restoreNote":
    case "pair":
    case "trashNote":
      return [action.path];
    default:
      return [];
  }
}

/** The page an action belongs to, if any. */
function pageOf(action: Action): PageId | null {
  switch (action.kind) {
    case "renameProject":
      return action.projectId;
    case "recreatePage":
      return action.oldId;
    case "convertLinks":
    case "convertImages":
    case "createPage":
      return null;
    default:
      return action.pageId;
  }
}

/** The raw targets of the wiki and Markdown links in a note's body (outside code) and frontmatter. */
function linkTargets(text: string): string[] {
  const { frontmatter, body } = splitFrontmatter(text);
  const targets: string[] = [];
  const collect = (part: string) => {
    for (const m of part.matchAll(WIKI)) targets.push(m[1]!.replace(/\\\|/g, "|").split(/[|#]/)[0]!);
    for (const m of part.matchAll(MD_LINK)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(m[1]!)) continue;
      let dest = m[1]!;
      try {
        dest = decodeURIComponent(dest);
      } catch {
        // keep the raw destination: over-matching is fine
      }
      targets.push(dest.split("#")[0]!);
    }
    return part;
  };
  outsideCode(body, collect);
  if (frontmatter !== null) collect(frontmatter);
  return targets;
}

const key = (path: string) => stem(path).normalize("NFC").toLowerCase().replace(/^\/+/, "");
const folderOf = (path: string) => posix.dirname(path);

export function waitingFor(input: {
  actions: readonly Action[];
  inUse: ReadonlySet<string>;
  notes: readonly VaultNote[];
  drawings: readonly string[];
  records: ReadonlyMap<PageId, SyncRecord>;
}): Waiting {
  const { actions, inUse, notes, records } = input;
  const pages = new Set<PageId>();
  const paths = new Set<string>();
  const linking = new Set<string>();

  const pathOfPage = new Map<PageId, string[]>();
  const addPath = (page: PageId, path: string) => pathOfPage.set(page, [...(pathOfPage.get(page) ?? []), path]);
  for (const note of notes) if (note.notionId) addPath(note.notionId, note.path);
  for (const [page, record] of records) addPath(page, record.path);

  // Rule 1 and 2.
  for (const action of actions) {
    const page = pageOf(action);
    const touched = pathsOf(action).some((p) => inUse.has(p));
    if (page !== null) {
      if (touched || (pathOfPage.get(page) ?? []).some((p) => inUse.has(p))) pages.add(page);
    } else if (touched) {
      for (const p of pathsOf(action)) if (inUse.has(p)) paths.add(p);
    }
  }

  // Rule 3: a rename waits when a note in use links to the page's note, by its name or its old path.
  const linkingNotes = notes.filter((note) => inUse.has(note.path));
  if (linkingNotes.length > 0) {
    // The index the executor resolves links with: the notes and drawings as scanned, plus the names a page is known by until
    // its note moves there (this run's move targets, and the aliases a stopped rename left in the records).
    const real: LinkEntry[] = [
      ...notes.map((n) => ({ path: n.path, pageId: n.notionId, title: posix.basename(n.path, ".md") })),
      ...input.drawings.map((path) => ({ path, pageId: null, title: posix.basename(path, ".md") })),
    ];
    const taken = new Set(real.map((e) => e.path));
    const upcoming = actions.flatMap((a) =>
      (a.kind === "moveInVault" || a.kind === "relocate") && a.pageId !== null && !taken.has(a.to) ? [{ path: a.to, pageId: a.pageId, title: posix.basename(a.to, ".md"), alias: true }] : [],
    );
    const pending = [...records.values()].flatMap((r) =>
      (r.aliases ?? []).filter((path) => !taken.has(path)).map((path) => ({ path, pageId: r.notionId, title: posix.basename(path, ".md"), alias: true })),
    );
    const index = buildLinkIndex([...upcoming, ...pending, ...real]);
    const targets = new Map(linkingNotes.map((note) => [note.path, linkTargets(note.text)]));
    for (const action of actions) {
      let page: PageId | null;
      let moved: string | null = null;
      if (action.kind === "moveInVault") {
        page = action.pageId;
        moved = action.from;
      } else if (action.kind === "relocate") {
        page = action.pageId;
        moved = action.from;
      } else if (action.kind === "renameInNotion" || action.kind === "endRename") {
        page = action.pageId;
      } else continue;
      if (page !== null ? pages.has(page) : paths.has(moved!)) continue;
      const names = [...(page !== null ? (pathOfPage.get(page) ?? []) : []), ...(moved !== null ? [moved] : [])];
      if (page !== null) names.push(...(records.get(page)?.aliases ?? []));
      if (action.kind === "moveInVault") names.push(action.to);
      const old = new Set(names.map(key));
      const entry = (page !== null ? index.byPageId.get(page) : undefined) ?? (moved !== null ? index.entries.find((e) => e.path === moved) : undefined) ?? null;
      const linkers = linkingNotes.filter((other) =>
        targets.get(other.path)!.some((target) => {
          if (old.has(key(target))) return true;
          const found = resolveLink(index, target, other.path);
          return found !== null && (found === entry || (page !== null && found.pageId === page) || old.has(key(found.path)));
        }),
      );
      if (linkers.length === 0) continue;
      for (const other of linkers) linking.add(other.path);
      if (page !== null) pages.add(page);
      else paths.add(moved!);
    }
  }

  // Rule 4: moves between the same two folders go together, until nothing new waits.
  const moves = actions.flatMap((action) =>
    action.kind === "moveInVault" || action.kind === "relocate" ? [{ action, group: `${folderOf(action.from)}\0${folderOf(action.to)}` }] : [],
  );
  const waits = (action: Action) => {
    const page = pageOf(action);
    return page !== null ? pages.has(page) : pathsOf(action).some((p) => paths.has(p));
  };
  for (let changed = true; changed; ) {
    changed = false;
    const groups = new Set(moves.filter((m) => waits(m.action)).map((m) => m.group));
    for (const { action, group } of moves) {
      if (!groups.has(group) || waits(action)) continue;
      const page = pageOf(action);
      if (page !== null) pages.add(page);
      else paths.add(action.kind === "relocate" || action.kind === "moveInVault" ? action.from : "");
      changed = true;
    }
  }

  return { pages, paths, linking };
}
