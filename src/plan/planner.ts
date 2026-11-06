// Deciding what to do with every note. Pure: no I/O, so every case is easy to test.
import { posix } from "node:path";
import type { Conversion } from "../links/convert.ts";
import { baseName, buildLinkIndex, resolveLink } from "../links/index.ts";
import { literalLinks, noteLiterals } from "../links/relink.ts";
import type { PageId, PageMeta, SyncRecord, VaultNote } from "../types.ts";
import { titleToFileName, uniqueName, usableFolder } from "../vault/filenames.ts";
import { splitFrontmatter } from "../vault/frontmatter.ts";

export type Action =
  | { kind: "convertLinks"; path: string; text: string; links: number }
  | { kind: "convertImages"; path: string; text: string; images: number }
  | { kind: "relocate"; from: string; to: string; pageId: PageId | null; reason?: string }
  | { kind: "renameProject"; projectId: PageId; title: string }
  | { kind: "writeId"; pageId: PageId; path: string }
  | { kind: "createPage"; path: string }
  | { kind: "recreatePage"; oldId: PageId; path: string }
  | { kind: "createNote"; pageId: PageId; path: string }
  | { kind: "restoreNote"; pageId: PageId; path: string }
  | { kind: "pair"; pageId: PageId; path: string; same: boolean }
  | { kind: "fileProject"; pageId: PageId }
  | { kind: "push"; pageId: PageId }
  | { kind: "pull"; pageId: PageId }
  | { kind: "merge"; pageId: PageId }
  | { kind: "relink"; pageId: PageId }
  | { kind: "updateEmbeds"; pageId: PageId }
  | { kind: "renameInNotion"; pageId: PageId }
  | { kind: "endRename"; pageId: PageId }
  | { kind: "moveInVault"; pageId: PageId; from: string; to: string; reason?: string }
  | { kind: "trashPage"; pageId: PageId }
  | { kind: "trashNote"; pageId: PageId; path: string }
  | { kind: "forget"; pageId: PageId };

export type ActionKind = Action["kind"];

/**
 * The order actions run in: the vault's [[links]] converted first, then its Notion-hosted files (images, PDFs, audio, video, other files) written as citations
 * (every later action works on the converted notes), then the notes that leave a folder meaning nothing, the projects an Obsidian folder rename renamed
 * (later actions see the notes where they now are), then ids, creations, links still using the name of a rename from Notion that won't
 * happen, content, links that can become Notion links, citations that can become Notion blocks, renames, and trashes last.
 */
export const PHASES: ActionKind[] = [
  "convertLinks",
  "convertImages",
  "relocate",
  "renameProject",
  "writeId",
  "createPage",
  "recreatePage",
  "endRename",
  "createNote",
  "restoreNote",
  "pair",
  "fileProject",
  "push",
  "pull",
  "merge",
  "relink",
  "updateEmbeds",
  "renameInNotion",
  "moveInVault",
  "trashPage",
  "trashNote",
  "forget",
];

export interface HeldTrash {
  pageId: PageId;
  path: string;
  /** "notion": the page goes to Notion's trash (the note was deleted in Obsidian); "vault": the note goes to the vault's .trash. */
  side: "notion" | "vault";
}

export interface Plan {
  actions: Action[];
  warnings: string[];
  /** Trashes held back by the mass-trash guard. */
  heldTrashes: number;
  /** The pages of the trashes held back (present only when some were): their notes and images count as still there. */
  heldPages?: PageId[];
  /** The trashes held back, by page, with the path of the note and the side that lost it (present only when some were). */
  held?: HeldTrash[];
  /** Attachment paths held back by the move limit (set by the sync). */
  heldFiles?: string[];
  /** Titles of the projects the vault's folders need created (set by the sync, from the resolver). */
  creates?: string[];
  /** Notes whose first project both apps changed since the last run; the Obsidian side was kept (set by the sync). */
  clashes?: string[];
  /** Vault paths of notes left alone this run because they are in use (open in Obsidian or just edited), sorted (set by the sync). */
  waiting?: string[];
}

export interface PlanInput {
  notes: VaultNote[];
  drawings: string[];
  pages: PageMeta[];
  /** Markdown fetched this run: pages without a record, and pages edited since we last looked. */
  fetched: ReadonlyMap<PageId, string>;
  records: ReadonlyMap<PageId, SyncRecord>;
  inboxFolder: string;
  massTrashLimit: number;
  allowMassTrash: boolean;
  /** Pages whose trashes a person confirmed after they were held: all the trashes go ahead when every one is in it (a subset of it is fine). */
  allowedTrashes?: ReadonlySet<PageId>;
  /** Whether a note and a page hold the same text; decides quiet pairing vs. conflict copy. Given the note as converted. */
  same: (note: VaultNote, markdown: string) => boolean;
  /**
   * The notes whose [[links]] this run converts to Markdown links. A conversion is an Obsidian edit: every decision
   * is made on the converted note, so a synced note is pushed and a new one gets its page with the converted text.
   */
  conversions: readonly Conversion[];
  /** Notes that move out of a folder that means nothing (spec §3 B1), with the page they belong to; every decision is made on the note at its new path, as for conversions. */
  relocations?: readonly { from: string; to: string; pageId: PageId | null; reason?: string }[];
  /** Why a page's note goes to another folder with its project, by page (the dry run says it). */
  moveReasons?: ReadonlyMap<PageId, string>;
  /** Project renames; only those Obsidian made become actions, a rename from Notion reaches the notes through their pages' folders. */
  renames?: readonly { id: PageId; title: string; from: string; to: string; side: "obsidian" | "notion" }[];
  /** Pages whose project the vault decides: written from their notes' folders. */
  fileProject?: readonly PageId[];
  /**
   * The notes whose Notion-hosted file lines (images, PDFs, audio, video, files) this run writes as citations of the downloaded files (spec §5.6), each
   * with the whole text it ends as: the text after the `[[links]]` conversion, when that note has one. Converted the
   * same way: every decision is made on the converted note.
   */
  imageConversions?: readonly { path: string; text: string; images: number }[];
  /**
   * Whether the page of a synced note still holds, as escaped text, a citation of an attachment that the translator now writes as a block
   * (spec §5.11, attachments §5.8): the pages synced before images, PDFs and files were; or a note embedded with a `!` before its mention, which the
   * translator now writes without it (2026-11-03). Given the note as converted.
   */
  holdsOldEmbeds: (record: SyncRecord, note: VaultNote) => boolean;
}

export function folderOf(path: string): string {
  const dir = posix.dirname(path);
  return dir === "." ? "" : dir;
}

/** The Notion title a note should have. */
export function titleOf(note: Pick<VaultNote, "path" | "notionTitle">): string {
  return note.notionTitle ?? baseName(note.path);
}

const nameKey = (title: string) => titleToFileName(title).toLowerCase();

function group<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

export function plan(given: PlanInput): Plan {
  const actions: Action[] = [];
  const warnings: string[] = [];
  const conversions = new Map(given.conversions.map((c) => [c.path, c]));
  const imageConversions = new Map((given.imageConversions ?? []).map((c) => [c.path, c]));
  const relocations = new Map((given.relocations ?? []).map((r) => [r.from, r]));
  /** The path each relocated note was scanned at, by its new path: its record still names the old one. */
  const scannedAt = new Map<string, string>();
  const input: PlanInput = {
    ...given,
    notes: given.notes.map((note) => {
      const conversion = imageConversions.get(note.path) ?? conversions.get(note.path);
      const converted = conversion ? { ...note, text: conversion.text, body: splitFrontmatter(conversion.text).body } : note;
      const move = relocations.get(note.path);
      if (move === undefined) return converted;
      scannedAt.set(move.to, note.path);
      return { ...converted, path: move.to };
    }),
  };
  for (const note of given.notes) {
    const conversion = conversions.get(note.path);
    if (conversion) actions.push({ kind: "convertLinks", path: conversion.path, text: conversion.text, links: conversion.links });
    const images = imageConversions.get(note.path);
    if (images) actions.push({ kind: "convertImages", path: images.path, text: images.text, images: images.images });
  }
  for (const move of relocations.values()) actions.push({ kind: "relocate", from: move.from, to: move.to, pageId: move.pageId, ...(move.reason !== undefined ? { reason: move.reason } : {}) });
  for (const rename of given.renames ?? []) if (rename.side === "obsidian") actions.push({ kind: "renameProject", projectId: rename.id, title: rename.title });
  const pagesById = new Map(input.pages.map((p) => [p.id, p]));
  /** By the path a note was scanned at: that is the path a record names. */
  const notesByPath = new Map(input.notes.map((n) => [scannedAt.get(n.path) ?? n.path, n]));
  const taken = new Set([...input.notes, ...input.drawings.map((path) => ({ path }))].map((n) => baseName(n.path).toLowerCase()));
  const notesById = new Map<PageId, VaultNote>();
  const duplicates = new Set<VaultNote>();
  for (const note of input.notes) {
    if (!note.notionId) continue;
    const first = notesById.get(note.notionId);
    if (!first) notesById.set(note.notionId, note);
    else if (input.records.get(note.notionId)?.path === (scannedAt.get(note.path) ?? note.path)) {
      // The copy at the recorded path keeps the id; the other one is the duplicate.
      duplicates.add(first);
      notesById.set(note.notionId, note);
    } else duplicates.add(note);
  }
  const claimedNotes = new Set<string>();
  /** Notes with a record and a page: their Notion text may hold [[links]] as text that can become Notion links. */
  const synced: { note: VaultNote; record: SyncRecord }[] = [];
  const claimedPages = new Set<PageId>();
  const pageChanged = (id: PageId, record: SyncRecord) => input.fetched.has(id) && input.fetched.get(id) !== record.notionMarkdown;

  /** The page's project folder when it can be a vault folder (empty for none); otherwise a warning and `fallback`. */
  const folderFor = (page: PageMeta, fallback: string, outcome: string): string => {
    if (!page.folder || usableFolder(page.folder)) return page.folder ?? "";
    warnings.push(`Notion page "${page.title}" belongs in the folder ${JSON.stringify(page.folder)}, which can't be a vault folder; ${outcome}.`);
    return fallback;
  };

  const place = (folder: string, title: string, current?: string): string => {
    const wanted = titleToFileName(title);
    let name = current ?? wanted;
    if (current === undefined || wanted.toLowerCase() !== current.toLowerCase()) {
      if (current !== undefined) taken.delete(current.toLowerCase());
      name = uniqueName(wanted, taken);
    }
    taken.add(name.toLowerCase());
    return `${folder ? `${folder}/` : ""}${name}.md`;
  };

  for (const record of input.records.values()) {
    let note = notesById.get(record.notionId);
    if (!note) {
      const atPath = notesByPath.get(record.path);
      if (atPath && atPath.notionId === null) note = atPath;
    }
    const page = pagesById.get(record.notionId);
    if (note) claimedNotes.add(note.path);
    if (page) claimedPages.add(page.id);
    if (!note && !page) {
      actions.push({ kind: "forget", pageId: record.notionId });
      continue;
    }
    if (!note) {
      if (pageChanged(record.notionId, record)) {
        const folder = folderFor(page!, input.inboxFolder, `its note goes to ${input.inboxFolder}`);
        actions.push({ kind: "restoreNote", pageId: record.notionId, path: place(folder, page!.title) });
      } else {
        actions.push({ kind: "trashPage", pageId: record.notionId });
      }
      continue;
    }
    const noteChanged = note.body !== splitFrontmatter(record.obsidianText).body;
    if (!page) {
      actions.push(noteChanged ? { kind: "recreatePage", oldId: record.notionId, path: note.path } : { kind: "trashNote", pageId: record.notionId, path: note.path });
      continue;
    }
    synced.push({ note, record });
    if (note.notionId !== record.notionId) actions.push({ kind: "writeId", pageId: record.notionId, path: note.path });
    const notionChanged = pageChanged(page.id, record);
    if (noteChanged && notionChanged) actions.push({ kind: "merge", pageId: page.id });
    else if (noteChanged) actions.push({ kind: "push", pageId: page.id });
    else if (notionChanged) actions.push({ kind: "pull", pageId: page.id });
    // Both sides as last synced: only now does the page's escaped citation (or marked embed) not come from an edit still to be carried over.
    else if (input.holdsOldEmbeds(record, note)) actions.push({ kind: "updateEmbeds", pageId: page.id });
    let moves = false;
    if (note.path !== record.path || titleOf(note) !== record.title) {
      actions.push({ kind: "renameInNotion", pageId: page.id });
    } else if (page.title !== record.title || page.folder !== record.folder) {
      // A folder that can't be a vault folder leaves the note where it is; a new title still renames it.
      const retitled = page.title !== record.title;
      const folder = folderFor(page, folderOf(note.path), retitled ? `${note.path} stays in its folder` : `${note.path} stays where it is`);
      if (retitled || folder === (page.folder ?? "")) {
        const to = place(folder, page.title, baseName(note.path));
        const reason = !retitled && page.folder !== record.folder ? input.moveReasons?.get(page.id) : undefined;
        actions.push({ kind: "moveInVault", pageId: page.id, from: note.path, to, ...(reason !== undefined ? { reason } : {}) });
        moves = to !== note.path;
      }
    }
    // A rename from Notion that a run stopped before moving the note, and that won't happen now (the note was renamed
    // in Obsidian, or Notion's title went back): links already using its name go back to the note's.
    if (record.aliases?.length && !moves) actions.push({ kind: "endRename", pageId: page.id });
  }

  const newNotes: VaultNote[] = [];
  for (const note of input.notes) {
    if (claimedNotes.has(note.path)) continue;
    const id = note.notionId;
    if (duplicates.has(note)) {
      warnings.push(`${note.path} has the same notion-id as ${notesById.get(id!)!.path}; it will get its own Notion page.`);
    } else if (id && pagesById.has(id) && !claimedPages.has(id)) {
      claimedPages.add(id);
      actions.push({ kind: "pair", pageId: id, path: note.path, same: input.same(note, input.fetched.get(id) ?? "") });
      continue;
    } else if (id) {
      warnings.push(`${note.path} has a notion-id that matches no page in the database; it will get a new page.`);
    }
    newNotes.push(note);
  }
  const newPages = input.pages.filter((p) => !claimedPages.has(p.id) && !input.records.has(p.id));

  const notesByKey = group(newNotes, (n) => nameKey(titleOf(n)));
  const pagesByKey = group(newPages, (p) => nameKey(p.title));
  const paired = new Set<VaultNote | PageId>();
  for (const [key, notes] of notesByKey) {
    const pages = pagesByKey.get(key) ?? [];
    if (notes.length === 1 && pages.length === 1) {
      const [note, page] = [notes[0]!, pages[0]!];
      actions.push({ kind: "pair", pageId: page.id, path: note.path, same: input.same(note, input.fetched.get(page.id) ?? "") });
      paired.add(note).add(page.id);
    } else if (pages.length > 0) {
      warnings.push(`${notes.map((n) => n.path).join(", ")} and ${pages.length} Notion page(s) share the title "${pages[0]!.title}"; they sync as separate notes.`);
    }
  }
  for (const pageId of given.fileProject ?? []) if (pagesById.has(pageId)) actions.push({ kind: "fileProject", pageId });
  for (const note of newNotes) if (!paired.has(note)) actions.push({ kind: "createPage", path: note.path });
  for (const page of newPages) {
    if (paired.has(page.id)) continue;
    const folder = folderFor(page, input.inboxFolder, `its note goes to ${input.inboxFolder}`) || input.inboxFolder;
    actions.push({ kind: "createNote", pageId: page.id, path: place(folder, page.title) });
  }

  // A link Notion holds as [[link]] text (its note had no page when it was written) becomes a Notion link once its
  // target resolves to a note or page: every note has or gets a page this run, drawings never do. The note may write
  // it as a [[link]] or, as every run converts them, a Markdown link.
  const resolver = buildLinkIndex([
    ...input.notes.map((n) => ({ path: n.path, pageId: n.notionId ?? "new", title: titleOf(n) })),
    ...input.drawings.map((path) => ({ path, pageId: null, title: baseName(path) })),
    ...actions.flatMap((a) => (a.kind === "createNote" || a.kind === "restoreNote" ? [{ path: a.path, pageId: a.pageId, title: baseName(a.path) }] : [])),
  ]);
  for (const { note, record } of synced) {
    const markdown = input.fetched.get(record.notionId) ?? record.notionMarkdown;
    if (!markdown.includes("\\[\\[")) continue;
    const links = noteLiterals(note.body);
    if (literalLinks(markdown, (link) => links.has(link)).some((l) => resolveLink(resolver, l.target, note.path)?.pageId)) actions.push({ kind: "relink", pageId: record.notionId });
  }

  let heldTrashes = 0;
  const isTrash = (a: Action) => a.kind === "trashPage" || a.kind === "trashNote";
  const trashActions = actions.filter(isTrash) as Extract<Action, { kind: "trashPage" | "trashNote" }>[];
  const trashes = trashActions.length;
  if (trashes > input.massTrashLimit && !input.allowMassTrash && !(input.allowedTrashes && trashActions.every((a) => input.allowedTrashes!.has(a.pageId)))) {
    heldTrashes = trashes;
    const changed = input.allowedTrashes ? " The list changed since it was held; check it and confirm again." : "";
    warnings.push(`${trashes} notes would be trashed, more than the limit of ${input.massTrashLimit}, so none were. Check the plan, then run again with --allow-mass-trash.${changed}`);
  }
  const kept = heldTrashes ? actions.filter((a) => !isTrash(a)) : actions;
  const sorted = kept.sort((a, b) => PHASES.indexOf(a.kind) - PHASES.indexOf(b.kind));
  const heldPages = heldTrashes
    ? {
        heldPages: trashActions.map((a) => a.pageId),
        held: trashActions.map((a): HeldTrash => (a.kind === "trashNote" ? { pageId: a.pageId, path: a.path, side: "vault" } : { pageId: a.pageId, path: input.records.get(a.pageId)?.path ?? "", side: "notion" })),
      }
    : {};
  return { actions: sorted, warnings, heldTrashes, ...heldPages };
}
