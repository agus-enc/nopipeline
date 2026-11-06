// Carrying out a plan: one note at a time, state saved after each, Notion refusals reported per note.
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { conversionIndex, convertBody } from "../links/convert.ts";
import { baseName, buildLinkIndex, linkTextFor, resolveLink, type LinkEntry, type LinkIndex } from "../links/index.ts";
import { relink } from "../links/relink.ts";
import { retitleLinks, rewriteFrontmatterLinks, rewriteLinks } from "../links/rewrite.ts";
import { contentUpdates } from "../merge/edits.ts";
import { NotionPageError, type NotionGateway } from "../notion/gateway.ts";
import type { FolderGateway } from "./projects.ts";
import { isUnsearchableMediaLine } from "../notion/hosted.ts";
import { idFromUrl } from "../notion/ids.ts";
import { searchTexts, type MentionTarget } from "../notion/search.ts";
import { PHASES, folderOf, titleOf, type Action, type ActionKind, type Plan } from "../plan/planner.ts";
import type { RecordStore } from "../state/records.ts";
import { notionOnlyBlocks } from "../translate/blocks.ts";
import { rereadLines } from "../translate/rereads.ts";
import { toNotion, toObsidian, type TranslateContext } from "../translate/index.ts";
import { toNotionInline } from "../translate/inline.ts";
import type { ContentEdit, PageId, PageMeta, SyncRecord, VaultNote } from "../types.ts";
import { mapFrontmatter, readNotionProps, replaceBody, setProp, splitFrontmatter } from "../vault/frontmatter.ts";
import { titleToFileName, usableFolder } from "../vault/filenames.ts";
import { conflictCopyPath, PathTakenError, type VaultFs } from "../vault/fs.ts";
import type { VaultMedia } from "../vault/images.ts";
import { updateEmbedsResult, mergeResult, noteKeepsAll, pageKeepsAll, placeOnPage, pullResult, pushResult, recordBody, sayTheSame } from "./content.ts";

export interface RunContext {
  vault: VaultFs;
  notion: FolderGateway;
  records: RecordStore;
  vaultName: string;
  now: () => Date;
  /** The vault's attachments, for the translator: without them, citations of them travel as text. */
  media?: VaultMedia;
  /** Vault paths of notes in use (open in Obsidian or just edited): a write, move or trash of one is not done; it waits. */
  inUse?: ReadonlySet<string>;
}

export interface Snapshot {
  notes: VaultNote[];
  drawings: string[];
  pages: PageMeta[];
  fetched: ReadonlyMap<PageId, string>;
  /** Titles of mentioned pages outside the database. */
  titles: ReadonlyMap<PageId, string>;
  /** When each fetched page was read; it becomes the record's notionSeenAt. */
  readAt?: ReadonlyMap<PageId, string>;
}

export interface Summary {
  done: Partial<Record<ActionKind, number>>;
  conflicts: string[];
  skipped: { path: string; reason: string }[];
  /** Notes whose edits couldn't be placed line by line, so one side took the other's text as a whole. */
  rewritten: string[];
  /** Pages whose "Links to" relation the pass after the run wrote. */
  linksTo: number;
  /** Pages whose tags property the tags pass set, and notes whose frontmatter tags it wrote (present only when some were). */
  tagsSet?: number;
  tagsWritten?: number;
  /** Pages one of whose actions this run skipped (their notes and relations are left for the next run). */
  skippedPages: PageId[];
  /** Pages this run moved to the trash or replaced with a new page: still in the listing it started from, but no longer live. */
  trashedPages: PageId[];
  /** Attachments (of any kind) whose changed file the run put on the pages that show it (spec §5.8), with how many pages. */
  mediaUpdated: { path: string; pages: number }[];
  /** Attachments no note cites any more, moved to the vault's `.trash` (spec §5.7, attachments §5.13). */
  mediaMoved: string[];
  /** Files the run uploaded to Notion (spec §5.15). */
  mediaUploaded: number;
  /** Attachments found at a new path by their bytes, the sync's records moved with them (attachments design §5.6). */
  mediaRekeyed: { from: string; to: string }[];
  /** Titles of the projects the run created in Notion (set by the sync from the folder layer). */
  projectsCreated?: string[];
  /** Vault paths the run left alone because their notes are in use (present only when some were). Not a skip: it does not make the run need a look. */
  waiting?: string[];
}

/** A note left for the next run because one of its sides changed while this run was working on it. */
class Skip extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "Skip";
    this.code = code;
  }
}

/** A write, move or trash of a note in use: not done, and not a skip (the note waits until it is no longer in use). */
class Wait extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`${path} is in use`);
    this.name = "Wait";
    this.path = path;
  }
}

/** Where a record says a note lives, and the page's title and folder as the record knows them. */
interface Identity {
  path: string;
  title: string;
  folder: string | null;
}

/** `body` (LF line endings) with CRLF put back if the note `text` used it. */
function withLineEndings(text: string, body: string): string {
  return text.includes("\r\n") ? body.replace(/\r?\n/g, "\r\n") : body;
}

/** The blocks a note can't hold, as the refusals name them. */
const NOTION_ONLY = "bookmarks, embeds, files, videos, audio, PDFs, child pages, databases, synced blocks, columns, tables of contents";

/** True when `result` has fewer of a block a note can't hold than `current` has. */
function dropsNotionOnly(current: string, result: string): boolean {
  const left = new Map<string, number>();
  for (const tag of notionOnlyBlocks(result)) left.set(tag, (left.get(tag) ?? 0) + 1);
  for (const tag of notionOnlyBlocks(current)) {
    const n = left.get(tag) ?? 0;
    if (n === 0) return true;
    left.set(tag, n - 1);
  }
  return false;
}

/** Whether a file name is the file name of `title`, or that with the ` (2)`, ` (3)`… that makes it unique. */
function isUniqueVariant(name: string, title: string): boolean {
  const wanted = titleToFileName(title).toLowerCase();
  const lower = name.toLowerCase();
  return lower === wanted || (lower.startsWith(`${wanted} (`) && /^ \(\d+\)$/.test(lower.slice(wanted.length)));
}

function noteFrom(path: string, text: string): VaultNote {
  const { frontmatter, body } = splitFrontmatter(text);
  const props = readNotionProps(frontmatter);
  return { path, text, body, notionId: props.notionId, notionTitle: props.notionTitle };
}

/**
 * Why an edit wasn't carried over, and what to do: making the same edit in the other app (the run then finds the
 * two say the same and records them as synced), or, where the two apps can't be made to say exactly the same,
 * undoing it.
 */
const NOT_LOADED_FOR_EDITING = "this edit touches a part of the page Notion doesn't load for editing; make it in Notion";
const TOO_LARGE_TO_REWRITE = "the page is too large to rewrite whole; make this edit in Notion, or in Obsidian line by line";
const PUSH_NOT_MATCHED =
  "Obsidian's edit couldn't be matched to the page line by line, and rewriting the page would lose what Obsidian can't hold; make the same edit in Notion (the next run then records both as synced), or undo it in Obsidian";
const PULL_NOT_MATCHED =
  "Notion's edit couldn't be matched to the note line by line, and rewriting the note would lose its formatting; make the same edit in Obsidian (the next run then records both as synced), or undo it in Notion";
const BOTH_CHANGED_NOTE =
  "both apps changed it, and Notion's edits couldn't be matched to the note line by line (rewriting the note would lose its formatting); make the note and the page say the same thing by hand (the next run then records them as synced), or undo the edits in one of the two apps";
const BOTH_CHANGED_PAGE =
  "both apps changed it, and the merged edits couldn't be matched to the page line by line (rewriting the page would lose what Obsidian can't hold); make the note and the page say the same thing by hand (the next run then records them as synced), or undo the edits in one of the two apps";
const EMPTY_PAGE = "; until then its page stays empty, with its title and project, so links to it work";
const UNREADABLE_MENTION =
  "Notion refused to say what it holds of a page that line mentions (restricted_resource), and Notion finds a line with a mention only by that page's title; check the connection's access to that page in Notion, or make the edit in Notion too (the next run then records both as synced)";

export async function execute(plan: Plan, snapshot: Snapshot, run: RunContext): Promise<Summary> {
  const summary: Summary = { done: {}, conflicts: [], skipped: [], rewritten: [], linksTo: 0, skippedPages: [], trashedPages: [], mediaUpdated: [], mediaMoved: [], mediaUploaded: 0, mediaRekeyed: [] };
  const notes = new Map(snapshot.notes.map((n) => [n.path, n]));
  const pages = new Map(snapshot.pages.map((p) => [p.id, p]));
  const records = run.records.all();
  const planned = new Map<string, PageId>();
  const moves = plan.actions.flatMap((a) => (a.kind === "moveInVault" && a.from !== a.to ? [a] : []));
  for (const a of plan.actions) if (a.kind === "createNote" || a.kind === "restoreNote" || a.kind === "pair" || a.kind === "writeId") planned.set(a.path, a.pageId);
  const created = new Map<PageId, string>();
  /** What Notion knows of mentioned pages outside the listing, looked up once per run. */
  const targets = new Map<PageId, MentionTarget | undefined>();
  const stamp = () => run.now().toISOString();
  /** Pages whose notes a rename gave new link text: they show the old text until pushed, after the plan's actions. */
  const stale = new Set<PageId>();
  /** Pages one of whose actions this run skipped: left for the next run, so never pushed after the plan. */
  const skipped = new Set<PageId>();
  const readAt = (id: PageId) => snapshot.readAt?.get(id);
  /** Notes in use that an action tried to change: they wait. */
  const waited = new Set<string>();
  const unlessInUse = (...paths: string[]) => {
    for (const path of paths) if (run.inUse?.has(path)) throw new Wait(path);
  };

  const pathOf = (id: PageId): string | undefined => {
    for (const [path, note] of notes) if (note.notionId === id) return path;
    for (const [path, pid] of planned) if (pid === id) return path;
    return undefined;
  };
  /** The link index of the vault as `from` holds it (the notes now, unless given), without the names `without`'s page is known by until it moves. */
  const index = (from: ReadonlyMap<string, VaultNote> = notes, without?: PageId): LinkIndex => {
    const entries = new Map<string, LinkEntry>();
    const owned = new Set<PageId>();
    for (const note of from.values()) {
      const id = note.notionId ?? planned.get(note.path) ?? null;
      if (id) owned.add(id);
      entries.set(note.path, { path: note.path, pageId: id, title: (id && pages.get(id)?.title) || titleOf(note) });
    }
    // A planned path whose page already has its note (it got its id back, then moved) is no entry of its own.
    for (const [path, id] of planned) if (!entries.has(path) && !owned.has(id)) entries.set(path, { path, pageId: id, title: pages.get(id)?.title ?? baseName(path) });
    for (const path of snapshot.drawings) entries.set(path, { path, pageId: null, title: baseName(path) });
    // Until a note moves to its new name from Notion, a link that already uses that name finds its page too:
    // this run's moves, and the names a run that stopped before its move had rewritten links to (kept in the
    // record). Listed first, so the page's own entry stays the note's; a note or drawing a link can mean wins.
    const upcoming = moves.filter((move) => !entries.has(move.to)).map((move) => ({ path: move.to, pageId: move.pageId, title: pages.get(move.pageId)?.title ?? baseName(move.to), alias: true }));
    const pending = [...records.values()]
      .filter((record) => record.notionId !== without)
      .flatMap((record) =>
        (record.aliases ?? []).filter((path) => !entries.has(path)).map((path) => ({ path, pageId: record.notionId, title: pages.get(record.notionId)?.title ?? baseName(path), alias: true })),
      );
    return buildLinkIndex([...upcoming, ...pending, ...entries.values()]);
  };
  let links = index();
  let converting: LinkIndex | undefined;
  /** The index this run converted the vault's [[links]] against (the notes as scanned). */
  const conversion = () => (converting ??= conversionIndex(snapshot.notes, snapshot.drawings));
  const translation = (path: string): TranslateContext => ({
    index: links,
    fromPath: path,
    vaultName: run.vaultName,
    titles: snapshot.titles,
    ...(run.media ? { media: run.media } : {}),
  });

  /** Writes a note, unless the file changed on disk since the scan (then the note waits for the next run). */
  async function writeNote(path: string, text: string): Promise<VaultNote> {
    const known = notes.get(path);
    if (known?.text !== text) {
      unlessInUse(path);
      if (known) {
        const onDisk = await run.vault.read(path).catch(() => null);
        if (onDisk !== known.text) throw new Skip("changed_in_obsidian", `${path} changed in Obsidian during this run; it syncs next run`);
      } else if (await run.vault.exists(path)) {
        throw new Skip("changed_in_obsidian", `${path} appeared in Obsidian during this run; it syncs next run`);
      }
      await run.vault.write(path, text);
    }
    const note = noteFrom(path, text);
    notes.set(path, note);
    return note;
  }
  /**
   * The record of a note whose page is made but holds none of its text yet (it was refused: `notion_rereads`): both
   * texts empty, the note's frontmatter kept. The note is then one whose whole body is an edit made in Obsidian since
   * the last sync: once Notion would keep every line, a push writes it into the empty page; deleting the note trashes
   * the page, which holds nothing of it; text typed into the page meanwhile is merged as an edit made in Notion.
   */
  async function waiting(id: PageId, noteText: string, identity: Identity, seenAt: string): Promise<void> {
    await save(id, { obsidianText: replaceBody(noteText, ""), notionMarkdown: "", seenAt, syncsProject: true }, identity);
  }

  /**
   * Saves a note's record. Content actions change only the two texts: the path, title and folder stay as the
   * record had them, so a rename or move still pending is carried out by its own action (now or next run).
   */
  async function save(
    id: PageId,
    texts: { obsidianText: string; notionMarkdown: string; seenAt?: string | undefined; aliases?: string[]; aliasTitles?: string[]; syncsProject?: true },
    identity?: Identity,
  ): Promise<void> {
    const previous = records.get(id);
    const place = identity ?? (previous ? { path: previous.path, title: previous.title, folder: previous.folder } : undefined);
    if (!place) throw new Error(`no record to update for page ${id}`);
    const aliases = texts.aliases ?? previous?.aliases ?? [];
    const aliasTitles = aliases.length ? (texts.aliasTitles ?? previous?.aliasTitles ?? []) : [];
    // The record's project is what both sides last agreed on: only an action that carried the folder over to or from the page
    // (`syncsProject`) takes the page's first project as Notion has it now (undefined: the gateway doesn't know it, so the
    // record's stays). Any other save keeps it, or a later run would see the folder as unsynced.
    const now = run.notion.projectOf(id);
    const project = texts.syncsProject ? (now === undefined ? previous?.project : now) : previous?.project;
    const record: SyncRecord = {
      notionId: id,
      path: place.path,
      title: place.title,
      folder: place.folder,
      ...(previous?.keptOut ? { keptOut: true as const } : {}),
      ...(project !== undefined ? { project } : {}),
      obsidianText: texts.obsidianText,
      notionMarkdown: texts.notionMarkdown,
      notionSeenAt: texts.seenAt ?? previous?.notionSeenAt ?? stamp(),
      syncedAt: stamp(),
      ...(aliases.length ? { aliases } : {}),
      ...(aliasTitles.length ? { aliasTitles } : {}),
      ...(previous?.linksTo ? { linksTo: previous.linksTo } : {}),
      ...(previous?.tags ? { tags: previous.tags } : {}),
    };
    await run.records.put(record);
    records.set(id, record);
  }
  /**
   * The texts Notion finds each edit's search text by (`searchTexts`), its mentions holding the pages' current
   * titles: a page in the database as listed, any other as Notion says, looked up once. Refuses, before anything is
   * written, an edit whose search text mentions a page the connection can't read. (Content is written before this
   * run renames or trashes any page, so the listing's titles are Notion's.)
   */
  async function searchesFor(current: string, edits: { old_str: string }[]): Promise<string[][]> {
    const ids = [...new Set(edits.flatMap((edit) => [...edit.old_str.matchAll(/<mention-page\s+url="([^"]*)"/g)].map((m) => idFromUrl(m[1]!)).filter((id) => id !== null)))];
    const unknown = ids.filter((id) => !pages.has(id) && !targets.has(id));
    if (unknown.length) {
      const found = await run.notion.mentionTargets(unknown);
      for (const id of unknown) targets.set(id, found.get(id));
    }
    const target = (id: PageId): MentionTarget | undefined => (pages.has(id) ? { title: pages.get(id)!.title, trashed: false } : targets.get(id));
    return edits.map((edit) => {
      const texts = searchTexts(current, edit.old_str, target);
      if (texts === null) throw new NotionPageError("unreadable_mention", UNREADABLE_MENTION);
      return texts;
    });
  }
  /**
   * Refuses a write to a page (`notion_rereads`) when the page would hold a line Notion reads back as something else.
   * Notion reads every line of a page again whenever it is written (live probe), so such a line would
   * change in Notion, at this write or the next. It shows in the note's own text (`meant`, as the translator writes
   * it: `\# x`, which Notion returns as `# x`, the same text a heading has), or in the page's (`_x_`). Every write
   * to a page is checked: a push, a merge, a whole rewrite, a relink, the first write of a created page, a pairing.
   */
  function refuseRereads(meant: string, result: string, after = ""): void {
    const fromNote = rereadLines(meant);
    const rereads = [...fromNote, ...rereadLines(result).filter((r) => !fromNote.some((m) => m.line === r.line))];
    if (rereads.length === 0) return;
    const [first] = rereads;
    const more = rereads.length > 1 ? ` (and ${rereads.length - 1} more line${rereads.length > 2 ? "s" : ""})` : "";
    throw new NotionPageError(
      "notion_rereads",
      `Notion would read the line "${first!.line.trim()}"${more} back as ${first!.as} the next time this page is written, changing it in Notion; write it another way, in Obsidian or Notion (without the backslash if the syntax is meant, or in a code span), and the note syncs${after}`,
    );
  }

  /**
   * Pages whose last read had to be completed by fetching blocks Notion left out: never rewritten whole (Notion times out on a huge page).
   * Each maps to the markdown Notion first gave (with the tag lines): Notion's edits search only that loaded part (live probe).
   */
  const pieced = new Map<PageId, string>();
  /** The edits that write `result` over `current`, each with the forms of its search text, or null when only a whole rewrite does. */
  type WritePlan = { edits: ContentEdit[]; searches: string[][] } | null;
  /**
   * Everything that can refuse a write to the page, checked before anything is sent (or kept: a conflict copy), and the plan to carry it out.
   * A hosted or placeholder image line is never in a search text (Notion doesn't find one), so a write that needs it goes through
   * `replaceContent`. A web image's line is text like any other. On a page read in pieces, no write goes whole, and every edit's search
   * text must lie in the part Notion loads: it finds nothing in a left-out block, and the edits before would already be written.
   */
  async function planWrite(id: PageId, current: string, result: string, meant: string): Promise<WritePlan> {
    refuseRereads(meant, result, current.trim() === "" ? EMPTY_PAGE : "");
    if (dropsNotionOnly(current, result)) {
      throw new NotionPageError(
        "unsupported_blocks",
        `this edit would delete blocks a note can't hold (${NOTION_ONLY}) from the page; make that edit in Notion and undo it in Obsidian`,
      );
    }
    const edits = contentUpdates(current, result, undefined, isUnsearchableMediaLine);
    if (edits !== null) {
      const searches = await searchesFor(current, edits);
      const loaded = pieced.get(id);
      if (loaded !== undefined && !edits.every((edit, k) => loaded.includes(edit.old_str) || searches[k]!.some((form) => loaded.includes(form)))) {
        throw new NotionPageError("truncated", NOT_LOADED_FOR_EDITING);
      }
      return { edits, searches };
    }
    if (pieced.has(id)) throw new NotionPageError("truncated", TOO_LARGE_TO_REWRITE);
    if (notionOnlyBlocks(current).length) {
      // Whether it is the images that rule out the small edits: without the rule against their lines, the edit could be placed.
      const images = contentUpdates(current, result) !== null;
      throw new NotionPageError(
        "unsupported_blocks",
        `the page has blocks a note can't hold (${NOTION_ONLY}), so it can't be replaced as a whole${images ? ", and this edit removes, changes or sits between images or other files that Notion hosts, which Notion can't find to edit in place" : ""}; make this edit in Notion (the next run then records both as synced), or undo it in Obsidian`,
      );
    }
    return null;
  }
  /**
   * Writes `result` to the page with the smallest possible edits and returns the page's markdown (`plan`: what `planWrite` made of it).
   * One edit per request: inside a batch, Notion silently skips an edit that no longer matches. Each edit's search
   * text is sent in the form Notion finds it by; where that can be one of two (a mention of a page in the trash),
   * the second is sent if Notion refuses the first.
   */
  async function writePage(id: PageId, current: string, result: string, meant = result, made?: WritePlan): Promise<string> {
    if (result === current) return current;
    const plan = made === undefined ? await planWrite(id, current, result, meant) : made;
    if (plan !== null) {
      const { edits, searches } = plan;
      let markdown = current;
      for (const [k, edit] of edits.entries()) {
        const forms = searches[k]!;
        for (const [n, old_str] of forms.entries()) {
          try {
            markdown = await run.notion.updateContent(id, [{ old_str, new_str: edit.new_str }]);
            break;
          } catch (error) {
            if (!(error instanceof NotionPageError && error.code === "validation_error")) throw error;
            if (n === forms.length - 1 && forms.length > 1) {
              throw new NotionPageError(
                "validation_error",
                `Notion found the line by none of the ${forms.length} forms tried for its mentions of pages in the trash (${error.message}); the next run tries again`,
              );
            }
            if (n === forms.length - 1) throw error;
          }
        }
      }
      // Notion answers an edit with the page as it cuts it; a page read in pieces is read again, whole.
      return pieced.has(id) ? currentMarkdown(id) : markdown;
    }
    return run.notion.replaceContent(id, result);
  }
  async function currentMarkdown(id: PageId): Promise<string> {
    const page = await run.notion.getMarkdown(id);
    if (page.truncated) throw new NotionPageError("truncated", "the page is too large to read completely");
    if (page.pieced) pieced.set(id, page.loaded ?? "");
    else pieced.delete(id);
    return page.markdown;
  }
  /** The conflict copy of this note holding exactly `body`, if one is already there (from a run that stopped). */
  async function existingCopy(path: string, body: string): Promise<string | null> {
    const folder = dirname(path);
    const prefix = `${baseName(path)} (Notion conflict `;
    const names = await readdir(join(run.vault.root, folder)).catch(() => [] as string[]);
    for (const name of names.sort()) {
      if (!name.startsWith(prefix) || !name.endsWith(").md")) continue;
      const copy = folder === "." ? name : `${folder}/${name}`;
      if ((await run.vault.read(copy).catch(() => null)) === body) return copy;
    }
    return null;
  }
  /** Keeps Notion's side of a conflict beside the note (reusing an identical copy) and reports it. */
  async function conflictCopy(path: string, body: string): Promise<void> {
    const existing = await existingCopy(path, body);
    const copy = existing ?? (await conflictCopyPath(run.vault, path, run.now()));
    if (!existing) await run.vault.write(copy, body);
    summary.conflicts.push(copy);
  }
  /**
   * Merges both sides against `current` (the page as just read) and writes the result to both. When the two
   * already say the same thing (an edit made by hand on both sides), only the record is saved.
   */
  async function mergeInto(id: PageId, path: string, current: string, seenAt: string): Promise<void> {
    const note = notes.get(path)!;
    const record = records.get(id)!;
    const ctx = translation(path);
    // The base and the note both as this run's conversion leaves them, so a [[link]] either still holds is no edit of
    // the note's own and never conflicts with an edit made in Notion on its line. The note is converted too because
    // its conversion may have been skipped (the file changed on disk); for a converted note that is a no-op, and a
    // merged text it changes can't be written over the newer file (writeNote checks the disk).
    const asConverted = (text: string) => convertBody(text, conversion(), path).body;
    const body = asConverted(note.body.replace(/\r\n/g, "\n"));
    if (sayTheSame(body, current, ctx)) {
      await save(id, { obsidianText: note.text, notionMarkdown: current, seenAt });
      return;
    }
    const base = { ...record, obsidianText: replaceBody(record.obsidianText, asConverted(recordBody(record))) };
    const merged = mergeResult(base, body, current, ctx);
    if (merged.whole && !noteKeepsAll(recordBody(base), record.notionMarkdown, ctx)) throw new Skip("not_matched", BOTH_CHANGED_NOTE);
    // Only the edits Notion lacks go to the page: from Notion's version to the merged text. Edits a stopped
    // run already wrote are in both, so they are not written twice.
    const placed = placeOnPage(toNotion(merged.notionVersion, ctx), toNotion(merged.body, ctx), current, ctx);
    if (placed === null && !pageKeepsAll(current, ctx)) throw new Skip("not_matched", BOTH_CHANGED_PAGE);
    // Checked before the conflict copy: a refused merge leaves both apps, and the vault's files, as they are.
    if (placed !== current) refuseRereads(toNotion(merged.body, ctx), placed ?? toNotion(merged.body, ctx), current.trim() === "" ? EMPTY_PAGE : "");
    const result = placed ?? toNotion(merged.body, ctx);
    // Planned before the conflict copy too: a write refused (a whole rewrite of a page read in pieces) leaves no copy behind.
    const plan = result === current ? null : await planWrite(id, current, result, toNotion(merged.body, ctx));
    if (merged.conflicted) await conflictCopy(path, merged.notionVersion);
    const markdown = await writePage(id, current, result, toNotion(merged.body, ctx), plan);
    const written = await writeNote(path, replaceBody(note.text, withLineEndings(note.text, merged.body)));
    await save(id, { obsidianText: written.text, notionMarkdown: markdown, seenAt });
    if (merged.whole || placed === null) summary.rewritten.push(path);
  }

  /**
   * After a rename rewrote links in `other` (now `updated`): a note that was in sync is recorded as synced when its
   * page needs no change (only destinations changed, which a Notion page link doesn't hold). When link text changed,
   * the page shows the old text: the record keeps `kept`, the note with only its destinations rewritten (when Notion
   * holds the same for it), and the page is pushed after the plan's actions (`stale`). A note that wasn't in sync is
   * left to its own action, or to the next run.
   */
  async function afterRewrite(other: VaultNote, updated: VaultNote, kept: string): Promise<void> {
    const id = updated.notionId;
    const record = id ? records.get(id) : undefined;
    if (!id || !record || recordBody(record) !== other.body) return;
    const ctx = translation(other.path);
    const page = toNotion(other.body, ctx);
    if (toNotion(updated.body, ctx) === page) {
      await save(id, { obsidianText: updated.text, notionMarkdown: record.notionMarkdown });
      return;
    }
    if (kept !== other.text && toNotion(splitFrontmatter(kept).body, ctx) === page) await save(id, { obsidianText: kept, notionMarkdown: record.notionMarkdown });
    stale.add(id);
  }

  /** A note rewritten for a move, as it was before, to undo the rewrite. */
  interface Rewritten {
    path: string;
    before: string;
    after: string;
    record: SyncRecord | undefined;
  }
  /**
   * Rewrites the links to a moved note in every note (its own self-links too, as Obsidian does), in the body
   * and in frontmatter properties: links that resolve to the note (`entry`, unless null), or to a name its page
   * is known by until it moves. A Markdown link whose text reads the note's old title (`titles.from`, or one a
   * rename cut short gave links, `titles.also`) reads the new one. Returns what it rewrote.
   */
  async function rewriteLinksTo(
    id: PageId,
    entry: LinkEntry | null,
    before: LinkIndex,
    after: LinkIndex,
    to: string,
    titles: { from: string; also: string[]; to: string },
  ): Promise<Rewritten[]> {
    const done: Rewritten[] = [];
    for (const other of [...notes.values()]) {
      const wikiText = linkTextFor(after, id, other.path)!;
      const rule = {
        matches: (target: string) => {
          const found = resolveLink(before, target, other.path);
          return (entry !== null && found === entry) || (found !== null && found.pageId === id && !notes.has(found.path));
        },
        wikiText,
        // Markdown links get the same shortest path, as conversion and Obsidian write them.
        path: `${wikiText}.md`,
      };
      const rewrite = (body: string) => mapFrontmatter(replaceBody(other.text, body), (line) => rewriteFrontmatterLinks(line, rule));
      let body = rewriteLinks(other.body, { ...rule, title: { from: titles.from, to: titles.to } });
      const linked = (target: string) => resolveLink(after, target, other.path)?.pageId === id;
      for (const from of titles.also) body = retitleLinks(body, linked, from, titles.to);
      const text = rewrite(body);
      if (text === other.text) continue;
      let updated: VaultNote;
      try {
        updated = await writeNote(other.path, text);
      } catch (error) {
        if (error instanceof Wait) {
          // The whole rewrite waits: nothing it changed stays changed.
          await undoRewrite(done);
          throw error;
        }
        if (!(error instanceof Skip)) throw error;
        summary.skipped.push({ path: other.path, reason: `${error.code}: its links to ${to} were not updated; update them in Obsidian` });
        continue;
      }
      const otherRecord = updated.notionId ? records.get(updated.notionId) : undefined;
      done.push({ path: other.path, before: other.text, after: updated.text, record: otherRecord });
      await afterRewrite(other, updated, rewrite(rewriteLinks(other.body, rule)));
    }
    return done;
  }
  /**
   * Rewrites, in every other note, the text of Markdown links to the page's note (at `path`) that read its old title
   * `from`, to `to`: a rename made in Obsidian, which updates links' destinations but not their text.
   */
  async function retitleLinksTo(id: PageId, path: string, from: string, to: string): Promise<void> {
    const now = index();
    const done: Rewritten[] = [];
    for (const other of [...notes.values()]) {
      if (other.path === path) continue;
      const body = retitleLinks(other.body, (target) => resolveLink(now, target, other.path)?.pageId === id, from, to);
      if (body === other.body) continue;
      let updated: VaultNote;
      try {
        updated = await writeNote(other.path, replaceBody(other.text, body));
      } catch (error) {
        if (error instanceof Wait) {
          await undoRewrite(done);
          throw error;
        }
        if (!(error instanceof Skip)) throw error;
        summary.skipped.push({ path: other.path, reason: `${error.code}: its links to ${path} still read "${from}"; give them the new title in Obsidian` });
        continue;
      }
      const otherRecord = updated.notionId ? records.get(updated.notionId) : undefined;
      done.push({ path: other.path, before: other.text, after: updated.text, record: otherRecord });
      await afterRewrite(other, updated, other.text);
    }
  }
  /** Puts back what `rewriteLinksTo` changed, where nothing else changed it since. */
  async function undoRewrite(done: Rewritten[]): Promise<void> {
    for (const { path, before, after, record } of [...done].reverse()) {
      if (notes.get(path)?.text !== after) continue;
      await writeNote(path, before).catch((error: unknown) => {
        if (!(error instanceof Skip)) throw error;
      });
      if (record) {
        await run.records.put(record);
        records.set(record.notionId, record);
        stale.delete(record.notionId);
      }
    }
  }

  /**
   * Moves a note's file, rewriting the links to it first, as they will read after the move (a run cut short before the move leaves
   * the note where it was, and the next run's move rewrites the links still left). `pageId` is null for a note that has no page
   * (and so no record): its links are still found and rewritten. `hooks.recorded` runs once the move is sure to be tried, before
   * any link changes; `hooks.undone` when another file took the name meanwhile and the links went back.
   */
  async function moveNoteFile(
    pageId: PageId | null,
    from: string,
    to: string,
    titles: { from: string; also: string[]; to: string },
    hooks: { recorded?: () => Promise<void>; undone?: () => Promise<void> } = {},
  ): Promise<void> {
    unlessInUse(from, to);
    const known = notes.get(from)!;
    if ((await run.vault.read(from).catch(() => null)) !== known.text) {
      throw new Skip("changed_in_obsidian", `${from} changed in Obsidian during this run; it moves next run`);
    }
    if (await run.vault.exists(to)) throw new Skip("path_taken", `${to} already exists, so the note can't move there; rename one of the two`);
    await hooks.recorded?.();
    // A note without a page is found in the index by a name of its own.
    const key = pageId ?? `unpaired:${from}`;
    const keyed = (found: LinkIndex, path: string) => (pageId !== null ? found : buildLinkIndex(found.entries.map((entry) => (entry.path === path ? { ...entry, pageId: key } : entry))));
    const before = keyed(index(), from);
    const oldEntry = before.byPageId.get(key);
    const after = keyed(index(new Map([...notes].map(([path, note]) => (path === from ? [to, { ...note, path: to }] : [path, note])))), to);
    let rewritten: Rewritten[];
    try {
      rewritten = oldEntry ? await rewriteLinksTo(key, oldEntry, before, after, to, titles) : [];
    } catch (error) {
      if (error instanceof Wait) await hooks.undone?.();
      throw error;
    }
    try {
      await run.vault.move(from, to);
    } catch (error) {
      if (!(error instanceof PathTakenError)) throw error;
      // Another file took the name: the links go back to the note where it still is, and the name ends.
      await undoRewrite(rewritten);
      await hooks.undone?.();
      throw new Skip("path_taken", `${to} appeared during this run, so the note can't move there; rename one of the two`);
    }
    notes.set(to, { ...notes.get(from)!, path: to });
    notes.delete(from);
  }

  /** A page's markdown with each mention as its page id alone (Notion sometimes writes the page's title into it). */
  const asRecorded = (markdown: string) => markdown.replace(/<mention-page\s+url="([^"]*)"[^>]*?(?:\/>|>[\s\S]*?<\/mention-page>)/g, (_m, url: string) => `<mention-page url="${idFromUrl(url) ?? url}"/>`);

  /** Carries out one action; false when it turned out to have nothing to do. */
  async function perform(action: Action): Promise<boolean | void> {
    switch (action.kind) {
      case "convertLinks":
      case "convertImages":
        // An Obsidian edit, written like any other: skipped when the note changed on disk since the scan.
        await writeNote(action.path, action.text);
        break;
      case "relocate": {
        // A note leaving a folder that means no project: moved like any other, its links rewritten. The page (if any) follows
        // through the rename that the plan holds for the new path.
        const moving = notes.get(action.from);
        if (moving === undefined) return false;
        // A new file name (a clash in the folder it goes to) is not a new title: the page keeps its title through the note's
        // `notion-title`, and the links to it keep their text.
        const record = action.pageId === null ? undefined : records.get(action.pageId);
        let titleKept = baseName(action.to);
        if (record !== undefined && baseName(action.to) !== baseName(action.from)) {
          const title = moving.notionTitle ?? record.title;
          if (title !== baseName(action.to)) {
            titleKept = title;
            if (moving.notionTitle === null) await writeNote(action.from, setProp(moving.text, "notion-title", title));
          }
        }
        await moveNoteFile(action.pageId, action.from, action.to, { from: baseName(action.from), also: [], to: titleKept });
        break;
      }
      case "renameProject":
        await run.notion.renameProject(action.projectId, action.title);
        break;
      case "fileProject": {
        // The vault decides this page's project: written from the folder its note is in now.
        const path = pathOf(action.pageId);
        const page = pages.get(action.pageId);
        if (path === undefined || page === undefined) return false;
        await run.notion.setProperties(action.pageId, { title: page.title, folder: folderOf(path) || null, sameTitle: true });
        const record = records.get(action.pageId);
        if (record) await save(action.pageId, { obsidianText: record.obsidianText, notionMarkdown: record.notionMarkdown, syncsProject: true });
        break;
      }
      case "writeId": {
        const note = notes.get(action.path)!;
        await writeNote(action.path, setProp(note.text, "notion-id", action.pageId));
        break;
      }
      case "createPage":
      case "recreatePage": {
        unlessInUse(action.path);
        const note = notes.get(action.path)!;
        const folder = folderOf(action.path) || null;
        const id = await run.notion.createPage({ title: titleOf(note), folder });
        pages.set(id, { id, title: titleOf(note), folder, lastEditedTime: stamp() });
        await writeNote(action.path, setProp(note.text, "notion-id", id));
        if (action.kind === "recreatePage") {
          await run.records.remove(action.oldId);
          summary.trashedPages.push(action.oldId);
        }
        created.set(id, action.path);
        break;
      }
      case "createNote":
      case "restoreNote": {
        const page = pages.get(action.pageId)!;
        const seenAt = readAt(action.pageId) ?? stamp();
        const markdown = snapshot.fetched.get(action.pageId) ?? (await currentMarkdown(action.pageId));
        let text = setProp(toObsidian(markdown, translation(action.path)), "notion-id", action.pageId);
        if (page.title !== baseName(action.path)) text = setProp(text, "notion-title", page.title);
        const folder = folderOf(action.path) || null;
        // Notion first: only local work sits between writing the file and saving its record.
        // Always written, the title included: the write moves the page's edit time, so the next run reads the page again (a page
        // with dates or mentions of outside pages is otherwise compared in a form its record doesn't hold).
        await run.notion.setProperties(action.pageId, { title: page.title, folder });
        if (page.folder !== folder) pages.set(action.pageId, { ...page, folder });
        await writeNote(action.path, text);
        await save(action.pageId, { obsidianText: text, notionMarkdown: markdown, seenAt, syncsProject: true }, { path: action.path, title: page.title, folder });
        break;
      }
      case "pair": {
        const page = pages.get(action.pageId)!;
        const original = notes.get(action.path)!;
        const ctx = translation(action.path);
        const seenAt = stamp();
        const current = await currentMarkdown(action.pageId);
        const read = snapshot.fetched.get(action.pageId);
        if (read !== undefined && current !== read) {
          throw new Skip("changed_in_notion", "the page changed in Notion during this run; it pairs next run");
        }
        // A note that already carries this page's id and says the same thing was written by a run that stopped
        // before saving (or the records were lost): link it as it is, so the page keeps its Notion-only layout.
        const carriesId = original.notionId === action.pageId;
        const linked = carriesId && action.same;
        if (!linked && dropsNotionOnly(current, toNotion(original.body, ctx))) {
          // Only a note carrying the page's id is linked as it is once the two say the same; a pair by title
          // always replaces the page.
          const way = carriesId
            ? "make the note and the page say the same thing (a note shows such a block as a link or as its text; the next run then pairs them as they are), or remove those blocks from the page in Notion"
            : "remove those blocks from the page in Notion, or rename the note or the page so the two sync as separate notes";
          throw new NotionPageError("unsupported_blocks", `the page has blocks a note can't hold (${NOTION_ONLY}), so it can't be replaced by the note; ${way}`);
        }
        if (!linked && pieced.has(action.pageId)) throw new NotionPageError("truncated", TOO_LARGE_TO_REWRITE);
        // Replacing the page is a write like any other: nothing changes, on either side, if Notion would change a line.
        if (!linked) {
          try {
            refuseRereads(toNotion(original.body, ctx), toNotion(original.body, ctx), current.trim() === "" ? EMPTY_PAGE : "");
          } catch (error) {
            // The empty page of a note refused at its creation, left without a record (by a run cut short, or by a
            // version before records waited): recorded as waiting now, so the note's later edits, a delete
            // included, reach its page.
            if (carriesId && current.trim() === "") await waiting(action.pageId, original.text, { path: action.path, title: page.title, folder: page.folder }, seenAt);
            throw error;
          }
        }
        // The Notion text is saved before the page is replaced.
        const theirs = toObsidian(current, ctx);
        if (!action.same && theirs.trim() !== "") await conflictCopy(action.path, theirs);
        const folder = folderOf(action.path) || null;
        if (page.folder !== folder) {
          await run.notion.setProperties(action.pageId, { title: page.title, folder });
          pages.set(action.pageId, { ...page, folder });
        }
        const markdown = linked ? current : await run.notion.replaceContent(action.pageId, toNotion(original.body, ctx));
        let text = setProp(original.text, "notion-id", action.pageId);
        text = setProp(text, "notion-title", page.title !== baseName(action.path) ? page.title : null);
        const note = await writeNote(action.path, text);
        await save(action.pageId, { obsidianText: note.text, notionMarkdown: markdown, seenAt, syncsProject: true }, { path: action.path, title: page.title, folder });
        break;
      }
      case "push": {
        const path = pathOf(action.pageId)!;
        const note = notes.get(path)!;
        const record = records.get(action.pageId)!;
        const seenAt = stamp();
        const current = await currentMarkdown(action.pageId);
        if (current !== record.notionMarkdown) {
          // The page changed after it was planned (an edit during this run, or a mention now showing a renamed
          // page's title, which doesn't move the edit time): merge both sides instead of writing over it.
          await mergeInto(action.pageId, path, current, seenAt);
          break;
        }
        const ctx = translation(path);
        const placed = pushResult(record, note.body, current, ctx);
        if (placed === null && !pageKeepsAll(current, ctx)) throw new Skip("not_matched", PUSH_NOT_MATCHED);
        const markdown = await writePage(action.pageId, current, placed ?? toNotion(note.body, ctx), toNotion(note.body, ctx));
        await save(action.pageId, { obsidianText: note.text, notionMarkdown: markdown, seenAt });
        if (placed === null) summary.rewritten.push(path);
        break;
      }
      case "pull": {
        const path = pathOf(action.pageId)!;
        const note = notes.get(path)!;
        const markdown = snapshot.fetched.get(action.pageId)!;
        const ctx = translation(path);
        const record = records.get(action.pageId)!;
        const placed = pullResult(record, note.body.replace(/\r\n/g, "\n"), markdown, ctx);
        if (placed === null && !noteKeepsAll(note.body.replace(/\r\n/g, "\n"), record.notionMarkdown, ctx)) throw new Skip("not_matched", PULL_NOT_MATCHED);
        const body = withLineEndings(note.text, placed ?? toObsidian(markdown, ctx));
        const written = await writeNote(path, replaceBody(note.text, body));
        await save(action.pageId, { obsidianText: written.text, notionMarkdown: markdown, seenAt: readAt(action.pageId) });
        if (placed === null) summary.rewritten.push(path);
        break;
      }
      case "merge": {
        const path = pathOf(action.pageId)!;
        const seenAt = stamp();
        // Merged against the page as it is now, so an edit made in Notion during this run is merged too.
        await mergeInto(action.pageId, path, await currentMarkdown(action.pageId), seenAt);
        break;
      }
      case "relink": {
        const path = pathOf(action.pageId)!;
        const record = records.get(action.pageId)!;
        const seenAt = stamp();
        const current = await currentMarkdown(action.pageId);
        // Only a mention may differ (Notion sometimes writes the page's title into it): anything else is an
        // edit this run hasn't pulled, and the record must never claim it was synced.
        if (asRecorded(current) !== asRecorded(record.notionMarkdown)) {
          throw new Skip("changed_in_notion", "the page changed in Notion during this run; its links become Notion links next run");
        }
        const ctx = translation(path);
        const result = relink(current, recordBody(record), (link) => toNotionInline(link, ctx));
        // Nothing resolves yet (the linked note's page was refused this run): the next run tries again.
        if (result === current) return false;
        // What the page is meant to hold is the note's translation: Notion returns a literal `\# x` as `# x`, so
        // only the note shows that line would turn into a heading at this write.
        const markdown = await writePage(action.pageId, current, result, toNotion(recordBody(record), ctx));
        await save(action.pageId, { obsidianText: record.obsidianText, notionMarkdown: markdown, seenAt });
        break;
      }
      case "updateEmbeds": {
        const path = pathOf(action.pageId)!;
        const record = records.get(action.pageId)!;
        const seenAt = stamp();
        const current = await currentMarkdown(action.pageId);
        // As for a relink: anything but a mention differing is an edit this run hasn't pulled, and the record must never claim it was synced.
        if (asRecorded(current) !== asRecorded(record.notionMarkdown)) {
          throw new Skip("changed_in_notion", "the page changed in Notion during this run; its images and embeds are updated next run");
        }
        const ctx = translation(path);
        const result = updateEmbedsResult(record, ctx);
        // The image or a file of the vault is gone since the plan was made: the next run decides again.
        if (result === null) return false;
        const placed = placeOnPage(record.notionMarkdown, result, current, ctx);
        if (placed === null) throw new Skip("not_matched", "the images and embeds couldn't be placed in the page line by line; they are updated next run");
        const markdown = await writePage(action.pageId, current, placed, toNotion(recordBody(record), ctx));
        await save(action.pageId, { obsidianText: record.obsidianText, notionMarkdown: markdown, seenAt });
        break;
      }
      case "renameInNotion": {
        const path = pathOf(action.pageId)!;
        const record = records.get(action.pageId)!;
        let note = notes.get(path)!;
        // A renamed file takes its title back from its name; a `notion-title` stays when the new name is only the title's file name made
        // unique (`Index (2)` for "Index": a note evicted next to one of the same name), which is no rename.
        if (baseName(path) !== baseName(record.path) && note.notionTitle !== null && !isUniqueVariant(baseName(path), note.notionTitle)) {
          note = await writeNote(path, setProp(note.text, "notion-title", null));
        }
        const title = titleOf(note);
        const folder = folderOf(path) || null;
        await run.notion.setProperties(action.pageId, { title, folder });
        pages.set(action.pageId, { ...pages.get(action.pageId)!, title, folder });
        // Before the record: a run cut short here renames again next run, and finds the links it rewrote unsynced.
        if (record.title !== title) await retitleLinksTo(action.pageId, path, record.title, title);
        const obsidianText = recordBody(record) === note.body ? note.text : record.obsidianText;
        await save(action.pageId, { obsidianText, notionMarkdown: record.notionMarkdown, syncsProject: true }, { path, title, folder });
        break;
      }
      case "endRename": {
        // The names a rename from Notion had rewritten links to before a run stopped (record aliases), when no move
        // to them will happen: links still using them are rewritten to the note's own name, as the move would have
        // rewritten them, and the names are dropped.
        const path = pathOf(action.pageId);
        const ending = records.get(action.pageId)!;
        if (path !== undefined) {
          const titles = { from: ending.title, also: ending.aliasTitles ?? [], to: titleOf(notes.get(path) ?? { path, notionTitle: null }) };
          await rewriteLinksTo(action.pageId, null, index(), index(notes, action.pageId), path, titles);
        }
        const record = records.get(action.pageId)!;
        await save(action.pageId, { obsidianText: record.obsidianText, notionMarkdown: record.notionMarkdown, aliases: [] });
        links = index();
        break;
      }
      case "moveInVault": {
        const page = pages.get(action.pageId)!;
        if (action.from !== action.to) {
          const pending = records.get(action.pageId)!;
          await moveNoteFile(action.pageId, action.from, action.to, { from: pending.title, also: pending.aliasTitles ?? [], to: page.title }, {
            // The new name is recorded before any link uses it, so links rewritten by a run cut short before the
            // move still find the page, even if Notion renames it again before the next run.
            // The title links get is kept too, so they follow the note again if this rename ends another way.
            recorded: () =>
              save(action.pageId, {
                obsidianText: pending.obsidianText,
                notionMarkdown: pending.notionMarkdown,
                aliases: [...new Set([...(pending.aliases ?? []), action.to])],
                aliasTitles: [...new Set([...(pending.aliasTitles ?? []), page.title])],
              }),
            undone: async () => {
              const undone = records.get(action.pageId)!;
              await save(action.pageId, {
                obsidianText: undone.obsidianText,
                notionMarkdown: undone.notionMarkdown,
                aliases: (undone.aliases ?? []).filter((path) => path !== action.to),
                aliasTitles: pending.aliasTitles ?? [],
              });
            },
          });
        }
        const note = await writeNote(action.to, setProp(notes.get(action.to)!.text, "notion-title", page.title !== baseName(action.to) ? page.title : null));
        links = index();
        // A new title that keeps the file name (it differs only in case, or in what a file name can't hold): no link
        // was rewritten, so the text of those reading the old title follows here.
        const retitled = records.get(action.pageId)!.title;
        if (action.from === action.to && retitled !== page.title) await retitleLinksTo(action.pageId, action.to, retitled, page.title);
        const record = records.get(action.pageId)!;
        const obsidianText = recordBody(record) === note.body ? note.text : record.obsidianText;
        // A folder that can't be a vault folder isn't recorded as seen, so the plan keeps warning about it.
        const folder = page.folder === null || usableFolder(page.folder) ? page.folder : record.folder;
        await save(action.pageId, { obsidianText, notionMarkdown: record.notionMarkdown, aliases: [], syncsProject: true }, { path: action.to, title: page.title, folder });
        break;
      }
      case "trashPage":
        await run.notion.trash(action.pageId);
        await run.records.remove(action.pageId);
        summary.trashedPages.push(action.pageId);
        break;
      case "trashNote": {
        unlessInUse(action.path);
        // Missing from the listing isn't proof enough: only a page Notion says is in the trash or gone.
        if ((await run.notion.pageStatus(action.pageId)) === "live") {
          throw new Skip(
            "still_in_notion",
            "its page still exists in Notion but isn't in the database listing (maybe moved out of the database); the note is kept: move the page back into the database, or delete the note by hand if it should go",
          );
        }
        const known = notes.get(action.path);
        if (known && (await run.vault.read(action.path).catch(() => null)) !== known.text) {
          throw new Skip("changed_in_obsidian", `${action.path} changed in Obsidian during this run; it is kept`);
        }
        await run.vault.trash(action.path);
        notes.delete(action.path);
        await run.records.remove(action.pageId);
        break;
      }
      case "forget":
        await run.records.remove(action.pageId);
        break;
    }
  }

  async function attempt(path: string, work: () => Promise<boolean | void>, id?: PageId): Promise<boolean> {
    try {
      return (await work()) !== false;
    } catch (error) {
      if (error instanceof Wait) {
        if (id) skipped.add(id);
        waited.add(error.path);
        return false;
      }
      if (!(error instanceof NotionPageError || error instanceof Skip)) throw error;
      if (id) skipped.add(id);
      summary.skipped.push({ path, reason: `${error.code}: ${error.message}` });
      return false;
    }
  }
  const label = (action: Action): string => {
    if (action.kind === "relocate") return action.from;
    if (action.kind === "renameProject") return action.title;
    return "path" in action ? action.path : (pathOf(action.pageId) ?? pages.get(action.pageId)?.title ?? action.pageId);
  };
  /** The page an action is about, if it has one yet. */
  const pageOf = (action: Action): PageId | undefined => {
    if (action.kind === "renameProject") return undefined;
    if (action.kind === "relocate") return action.pageId ?? undefined;
    return "pageId" in action ? action.pageId : (notes.get(action.path)?.notionId ?? planned.get(action.path));
  };

  async function pushCreated(): Promise<void> {
    for (const [id, path] of created) {
      await attempt(path, async () => {
        const note = notes.get(path)!;
        const page = pages.get(id)!;
        const seenAt = stamp();
        const body = toNotion(note.body, translation(path));
        // The page was made with its title and project, so links to the note are page links in Notion; its text waits
        // (a record with both texts empty), and a later run pushes it once Notion would keep every line.
        try {
          refuseRereads(body, body, EMPTY_PAGE);
        } catch (error) {
          await waiting(id, note.text, { path, title: page.title, folder: page.folder }, seenAt);
          throw error;
        }
        const markdown = body === "" ? "" : await run.notion.replaceContent(id, body);
        await save(id, { obsidianText: note.text, notionMarkdown: markdown, seenAt, syncsProject: true }, { path, title: page.title, folder: page.folder });
      }, id);
    }
  }

  /** The paths a relocation was meant to give notes and didn't. */
  const unmoved = new Set<string>();
  const creation: ActionKind[] = ["convertLinks", "convertImages", "relocate", "renameProject", "writeId", "createPage", "recreatePage"];
  let indexed = false;
  let createdPushed = false;
  for (const action of plan.actions) {
    if (!indexed && !creation.includes(action.kind)) {
      links = index();
      indexed = true;
    }
    if (!createdPushed && PHASES.indexOf(action.kind) > PHASES.indexOf("pair")) {
      await pushCreated();
      createdPushed = true;
    }
    // A note that could not leave its folder is not at the path the plan gives it: what the plan does at that path waits for the next run.
    if ("path" in action && unmoved.has(action.path)) continue;
    if (await attempt(label(action), () => perform(action), pageOf(action))) summary.done[action.kind] = (summary.done[action.kind] ?? 0) + 1;
    else if (action.kind === "relocate") unmoved.add(action.to);
  }
  if (!indexed) links = index();
  if (!createdPushed) await pushCreated();
  // The pages whose link text a rename changed in their notes (design §6.4), pushed now so none keeps showing the
  // old title. Not a page whose note this run skipped, nor one whose rewrite was put back (it says what its record says).
  links = index();
  for (const id of stale) {
    const path = pathOf(id);
    const record = records.get(id);
    if (skipped.has(id) || path === undefined || !record || notes.get(path)?.body === recordBody(record)) continue;
    if (await attempt(path, () => perform({ kind: "push", pageId: id }), id)) summary.done.push = (summary.done.push ?? 0) + 1;
  }
  summary.skippedPages = [...skipped];
  if (waited.size > 0) summary.waiting = [...waited].sort();
  return summary;
}
