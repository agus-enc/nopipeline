// One sync run: read both sides, plan, then (unless previewing) execute.
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readdir, readFile, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { claimStateDir, type Config } from "./config.ts";
import { convertNotes } from "./links/convert.ts";
import { baseName, buildLinkIndex } from "./links/index.ts";
import { NotionPageError, ProjectsUnreadable, type NotionGateway } from "./notion/gateway.ts";
import { checkDatabase } from "./notion/check.ts";
import { canonicalMarkdown, hostedFile, mediaLine, type MediaKind } from "./notion/hosted.ts";
import { idFromUrl, isNotionUrl } from "./notion/ids.ts";
import { folderless, withProjects, type FolderGateway } from "./run/projects.ts";
import { withImages, type PendingImage } from "./notion/images.ts";
import { plan as makePlan, type Action, type Plan } from "./plan/planner.ts";
import { waitingFor } from "./plan/waiting.ts";
import { resolveProjects } from "./plan/projects.ts";
import { movedLine } from "./report.ts";
import { convertHostedImages, fetchPending } from "./run/downloads.ts";
import { applyRekeys, planRekeys } from "./run/rekey.ts";
import { updateEmbedsResult, withMediaAsPageReads } from "./run/content.ts";
import { execute, type Summary } from "./run/execute.ts";
import { addedPlaceholders, citedMedia, inFolder, namedMedia, namesMedia, pagesShowing, replacedMedia, strandedWarning, tooManyFiles, unusedMedia } from "./run/images.ts";
import { previewLinksTo, updateLinksTo } from "./run/relation.ts";
import { previewTags, syncTags, tagChanges } from "./run/tags.ts";
import { openImageStore } from "./state/images.ts";
import { acquireLock } from "./state/lock.ts";
import { openProjectStore, type ProjectStore, type StoredProject } from "./state/projects.ts";
import { openRecordStore } from "./state/records.ts";
import { mentionedPageIds } from "./translate/inline.ts";
import { strandedMedia, toNotion, toObsidian } from "./translate/index.ts";
import type { PageId, PageMeta, VaultNote } from "./types.ts";
import { titleToFileName } from "./vault/filenames.ts";
import { createVaultFs } from "./vault/fs.ts";
import { listMedia, scanMedia, type VaultMedia } from "./vault/images.ts";
import { notesInUse, type ObsidianProbe } from "./vault/inuse.ts";
import { scanVault } from "./vault/scan.ts";

export interface SyncOptions {
  config: Config;
  notion: NotionGateway;
  dryRun: boolean;
  yes: boolean;
  allowMassTrash: boolean;
  /** Trashes a person confirmed after they were held (the held list): they go ahead when every one that would run is on it. */
  allowTrashes?: { pages: readonly PageId[]; files: readonly string[] };
  now?: () => Date;
  /** Asks whether Obsidian runs and which notes it has open; absent means it does not run (no note waits). */
  obsidian?: ObsidianProbe;
  log?: (line: string) => void;
  /**
   * Called once, inside the lock and before it is released, with the outcome (before `runSync` returns it) or with the error (before
   * it is rethrown). Not called when the lock can't be taken or `claimStateDir` fails. What it writes can't be overwritten by a run that starts next.
   */
  finish?: (result: { outcome: SyncOutcome } | { error: unknown }) => Promise<void>;
}

export interface SyncOutcome {
  plan: Plan;
  /** Null when the run only previewed the plan. */
  summary: Summary | null;
  notes: VaultNote[];
  pages: PageMeta[];
  /**
   * A dry run's estimate of the pages whose "Links to" relation a real run would write: a heading and one line per
   * page, for the caller to print after the plan. Null when there are none (or the relation is left alone).
   */
  linksToPreview?: string[] | null;
  /** A preview's lines about tags (`set tags in Notion on <path>`, `write tags to <path>`), estimated from the notes as scanned. Absent when there are none or tags are off. */
  tagsPreview?: string[];
  /**
   * The attachments (images, PDFs, audio, video, other files) the run moves, uploads, downloads, replaces or sends to `.trash`: in a
   * preview, a line for each (`download <name> for <path>`, `upload <path> for <note>`, `update file <path> (N pages)`, `move to .trash <path>`)
   * and for each download Notion would refuse; after a real run, how many were downloaded. Absent when there are none.
   */
  mediaPlan?: string[];
}

/** The noun for a count of files of one kind in the run's lines ("2 PDFs"); a mix of kinds is "files". */
const COUNTED: Record<MediaKind, [one: string, many: string]> = {
  image: ["image", "images"],
  pdf: ["PDF", "PDFs"],
  audio: ["audio file", "audio files"],
  video: ["video", "videos"],
  file: ["file", "files"],
};

/** The line a real run says about what it downloaded: `downloaded 1 image`, `downloaded 2 PDFs`, `downloaded 3 files` for a mix. */
function downloadedLine(kinds: readonly MediaKind[]): string {
  const [one, many] = COUNTED[new Set(kinds).size === 1 ? kinds[0]! : "file"];
  return `downloaded ${kinds.length} ${kinds.length === 1 ? one : many}`;
}

const minute = (iso: string) => `${iso.slice(0, 16)}:00.000Z`;
/**
 * Text as compared when pairing on the first run: whitespace collapsed, Markdown escapes of punctuation
 * dropped (they show the same), and Notion page links reduced to the page id. Everything else counts.
 */
const comparable = (text: string) =>
  text
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/\]\(([^)\s]*)\)/g, (_m, url: string) => `](${isNotionUrl(url) ? idFromUrl(url) : url})`)
    .replace(/\s+/g, " ")
    .trim();

/**
 * Stops the run, before anything changes, when the database is not what the profile names (a wrong title property would rename every
 * note; a projects relation that is missing or unreadable would lose every folder). Returns whether the run keeps the "Links to" relation and whether it keeps tags.
 */
async function checkNotes(notion: NotionGateway, config: Config, log: (line: string) => void): Promise<{ linksTo: boolean; tags: boolean }> {
  const types = await notion.properties();
  let projects: { dataSourceId: string } | null = null;
  let unreadable: string | null = null;
  if (config.projectsRelation !== null) {
    try {
      projects = await notion.projectsSource();
    } catch (error) {
      if (!(error instanceof ProjectsUnreadable)) throw error;
      unreadable = error.message;
    }
  }
  const properties: Record<string, { type: string; target?: string }> = Object.fromEntries(Object.entries(types).map(([name, type]) => [name, { type }]));
  const links = config.linksToProperty === null ? undefined : properties[config.linksToProperty];
  if (links?.type === "relation") {
    const target = await notion.relationTarget();
    if (target !== null) links.target = target;
  }
  const relation = config.projectsRelation === null ? undefined : properties[config.projectsRelation];
  if (relation?.type === "relation" && projects !== null) relation.target = projects.dataSourceId;
  const { errors, notes, linksTo, tags } = checkDatabase({ properties }, config);
  if (unreadable !== null) {
    // A connection that isn't connected to the projects database doesn't see the relation either: the check's "add a relation" would
    // send the user after one that exists, so the message that says to connect it replaces that one.
    if (relation === undefined) {
      const missing = errors.findIndex((error) => error.startsWith(`the database has no "${config.projectsRelation}" property`));
      if (missing !== -1) errors.splice(missing, 1);
    }
    if (relation === undefined || errors.length === 0) errors.push(unreadable);
  }
  if (errors.length > 0) throw new Error(`${errors.join(" ")} Nothing was changed.`);
  for (const note of notes) log(`note: ${note}`);
  return { linksTo, tags };
}

/** The SHA-256 (hex) of a vault file, read as a stream so a large file (a video) is never held in memory, or null when it isn't there. */
const vaultSha = (root: string) => async (path: string): Promise<string | null> => {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(join(root, path))) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

/** The bytes of a vault file, or null when it isn't there. */
const vaultBytes = (root: string) => async (path: string): Promise<Uint8Array | null> => {
  try {
    return new Uint8Array(await readFile(join(root, path)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

/** Whether a record's page text holds a file Notion hosts (an image, PDF, audio, video or file block) that the sync has no file for: its page is read again to download it. */
const holdsNewMedia = (markdown: string) =>
  markdown.split("\n").some((line) => {
    const media = mediaLine(line);
    return media !== null && hostedFile(media.url) !== null;
  });

export async function runSync(options: SyncOptions): Promise<SyncOutcome> {
  const { config } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.log(line));
  if (config.ignoredKeys.includes("folderProperty")) log('note: "folderProperty" is no longer used; folders follow the "projectsRelation" now');
  await claimStateDir(config);
  const release = await acquireLock(config.stateDir, (warning) => log(`warning: ${warning}`));
  try {
    let outcome: SyncOutcome;
    try {
      outcome = await syncLocked(options, now, log);
    } catch (error) {
      await options.finish?.({ error });
      throw error;
    }
    await options.finish?.({ outcome });
    return outcome;
  } finally {
    await release();
  }
}

/** The run itself, with the lock held. */
async function syncLocked(options: SyncOptions, now: () => Date, log: (line: string) => void): Promise<SyncOutcome> {
  const { config } = options;
  const store = await openRecordStore(config.stateDir);
  const imageStore = await openImageStore(config.stateDir);
  // Every read and write of the run goes through this gateway: it reads hosted images back as placeholders of vault files.
  const readVault = vaultBytes(config.vaultPath);
  const records = store.all();
  // A dry run, and a profile's first run without --yes, only preview: nothing is written, downloaded files included.
  const previewOnly = options.dryRun || (records.size === 0 && !options.yes);
  const sha = vaultSha(config.vaultPath);
  const plainVault = createVaultFs(config.vaultPath, null);
  const notion = withImages(options.notion, { store: imageStore, readFile: readVault, exists: (path) => plainVault.exists(path), sha256: sha, log, readOnly: previewOnly });
  const { linksTo, tags } = await checkNotes(notion, config, log);
  const projectsOn = config.projectsRelation !== null;
  const projectStore = projectsOn ? await openProjectStore(config.stateDir) : null;
  const scan = await scanVault(config.vaultPath, config.statusNote ?? null);
  // A file Notion already holds (the store has file uuids for it) is never over the upload limit: its line keeps its block (spec §5.10).
  const hosting = (found: VaultMedia): VaultMedia => {
    found.hosted = (path) => (imageStore.get(path)?.keys.length ?? 0) > 0;
    return found;
  };
  let media = hosting(await scanMedia(config.vaultPath));

  // A stored file that is gone and a vault file with its bytes at a path the store doesn't know are the same file, moved or
  // renamed: re-keyed first, so that nothing below (downloads, removal, replaced files, the records) sees a missing file (spec §5.6).
  const present = new Set<string>();
  for (const path of imageStore.paths()) if (await plainVault.exists(path)) present.add(path);
  const anyGone = imageStore.paths().some((path) => !present.has(path));
  const stillNamed = anyGone ? await namedMedia(config.vaultPath, imageStore.paths().filter((path) => !present.has(path)), [], true, config.statusNote ?? null) : new Set<string>();
  const rekeys = await planRekeys(imageStore, anyGone ? await listMedia(config.vaultPath) : [], async (path) => (await sha(path)) ?? "", (path) => present.has(path), (path) => stillNamed.has(path));
  if (rekeys.ambiguous.length > 0) {
    const tied = rekeys.ambiguous.map((a) => `${a.from} could be any of ${a.candidates.join(", ")}`).join("; ");
    throw new Error(`can't tell which file a moved attachment is now: ${tied}, which all hold its bytes; keep one of them, or put the file back at its old path (a copy named like the old file is taken as the file), then run again. Nothing was changed.`);
  }
  await applyRekeys(rekeys.moves, imageStore, records, previewOnly ? null : store);
  // Worked out now, before any action: the pages that show the old file are found by it (spec §5.8).
  const replaced = await replacedMedia(imageStore, sha, async (path) => {
    try {
      return (await stat(join(config.vaultPath, path))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  });

  /**
   * Each record's texts in the form the run reads pages and notes in: the page's without signatures and with its known
   * images as placeholders, the note's with the hosted images it holds written as citations of their files (as the
   * conversion below writes the note). A record that changes is saved so (not in a preview), so the pages written
   * before images were synced don't read as changed (spec §5.11).
   */
  const settleRecords = async () => {
    for (const [id, record] of records) {
      const notionMarkdown = canonicalMarkdown(record.notionMarkdown, imageStore.pathOf);
      const obsidianText = convertHostedImages(record.obsidianText, record.path, imageStore.pathOf, media)?.text ?? record.obsidianText;
      if (notionMarkdown === record.notionMarkdown && obsidianText === record.obsidianText) continue;
      const settled = { ...record, notionMarkdown, obsidianText };
      records.set(id, settled);
      if (!previewOnly) await store.put(settled);
    }
  };
  await settleRecords();

  // The notes open in Obsidian, or edited a moment ago, are left untouched in both apps this run (spec "Sync while Obsidian is open").
  const inUse = options.obsidian
    ? await notesInUse({ vaultPath: config.vaultPath, notes: scan.notes, records, probe: options.obsidian, now: now() })
    : { paths: new Set<string>(), tabsUnreadable: false };
  const pagesInUse = new Set<PageId>();
  if (inUse.paths.size > 0) {
    for (const note of scan.notes) if (note.notionId !== null && inUse.paths.has(note.path)) pagesInUse.add(note.notionId);
    for (const [id, record] of records) if (inUse.paths.has(record.path)) pagesInUse.add(id);
  }

  const leftWithPlaceholder = imageStore.unattached();
  const listed = await notion.listPages();
  // Which folder every page belongs in, and which notes leave folders that mean no project (spec §3 B1–B3).
  const projectList = projectsOn ? await notion.listProjects() : [];
  const resolution = resolveProjects({
    enabled: projectsOn,
    notes: scan.notes,
    drawings: scan.drawings,
    pages: listed,
    records,
    context: { inboxFolder: config.inboxFolder, attachmentFolder: media.folder, folders: new Set(scan.folders), projects: projectList, stored: projectStore?.all() ?? new Map() },
  });
  for (const warning of resolution.warnings) log(`warning: ${warning}`);
  const fetched = new Map<PageId, string>();
  const readAt = new Map<PageId, string>();
  const truncated = new Map<PageId, string>();
  /** Pages that would have been read but whose notes are in use: not read, so an edit made in Notion waits too. */
  const unread = new Set<PageId>();
  const pages: PageMeta[] = [];
  for (const page of listed) {
    pages.push({ ...page, folder: resolution.pageFolders.get(page.id) ?? null });
    const record = records.get(page.id);
    // Also read again: a page last seen holding a placeholder image, which a stopped or refused run left unswitched.
    if (record && page.lastEditedTime < minute(record.notionSeenAt) && !holdsNewMedia(record.notionMarkdown) && !leftWithPlaceholder.has(page.id)) continue;
    if (pagesInUse.has(page.id)) {
      unread.add(page.id);
      continue;
    }
    const read = now().toISOString();
    const { markdown, truncated: partial } = await notion.getMarkdown(page.id);
    if (partial) {
      log(`warning: "${page.title}" is too large to read completely; it is left alone this run`);
      truncated.set(page.id, page.title);
      continue;
    }
    fetched.set(page.id, markdown);
    readAt.set(page.id, read);
  }

  // The images pasted in Notion come down now, so that the pages read as placeholders of their files before planning.
  const noteOf = (id: PageId, fallback = id) => scan.notes.find((n) => n.notionId === id)?.path ?? records.get(id)?.path ?? fallback;
  const titleOf = (id: PageId) => listed.find((p) => p.id === id)?.title ?? id;
  // An image the sync knows whose file is gone comes back unless the page's note no longer names it: a note that was
  // edited to cite a renamed file, or dropped the citation, has no use for the old one (and the run would only move it to .trash).
  const wanted = (p: PendingImage) => {
    const known = imageStore.pathOf(p.key);
    const note = scan.notes.find((n) => n.notionId === p.pageId) ?? scan.notes.find((n) => n.path === records.get(p.pageId)?.path);
    return known === null || note === undefined || namesMedia(note.text, known);
  };
  const downloads = await fetchPending(
    notion.pending().filter((p) => fetched.has(p.pageId) && wanted(p)),
    { notion, store: imageStore, vault: plainVault, media, dryRun: previewOnly },
  );
  // An image the sync knows whose file is gone and that no note names (a file Obsidian renamed or the user removed) is still
  // an image in the old text of the notes that cited it, which the push of such a note compares with the page: counted
  // among the vault's images so that old text translates as it did when it was synced. No current note can cite it.
  const restored = downloads.downloaded.map((d) => d.path);
  const orphans: string[] = [];
  for (const path of imageStore.paths()) {
    if (restored.includes(path) || (await plainVault.exists(path))) continue;
    if (!scan.notes.some((n) => namesMedia(n.text, path))) orphans.push(path);
  }
  media = hosting(await scanMedia(config.vaultPath, [...restored, ...orphans]));
  for (const id of fetched.keys()) fetched.set(id, notion.canonical(id) ?? fetched.get(id)!);
  await settleRecords();
  const unchanged = [...fetched].filter(([id, markdown]) => records.get(id)?.notionMarkdown === markdown).map(([id]) => id);
  const failed = new Map<PageId, string>();
  for (const f of downloads.failed) {
    if (!failed.has(f.pageId)) failed.set(f.pageId, `download_failed: can't download ${f.name} (${f.reason}); this page and its note are left alone until the file can be downloaded (tried again every run); if Notion keeps refusing it, replace the file in Notion`);
  }
  const mediaPlan = previewOnly
    ? [
        ...rekeys.moves.map(movedLine),
        ...downloads.downloaded.map((d) => `download ${d.path.slice(d.path.lastIndexOf("/") + 1)} for ${noteOf(d.pageId, titleOf(d.pageId))}`),
        ...downloads.failed.map((f) => `can't download ${f.name} for ${noteOf(f.pageId, titleOf(f.pageId))} (${f.reason}); this page and its note are left alone until the file can be downloaded`),
      ]
    : downloads.downloaded.length > 0
      ? [downloadedLine(downloads.downloaded.map((d) => d.kind))]
      : [];

  const listedIds = new Set(listed.map((p) => p.id));
  const outside = [...new Set([...fetched.values()].flatMap(mentionedPageIds))].filter((id) => !listedIds.has(id));
  const titles = outside.length ? await notion.pageTitles(outside) : new Map<PageId, string>();

  const provisional = buildLinkIndex([
    ...scan.notes.map((n) => ({ path: n.path, pageId: n.notionId, title: n.notionTitle ?? baseName(n.path) })),
    ...pages.filter((p) => !scan.notes.some((n) => n.notionId === p.id)).map((p) => ({ path: `${titleToFileName(p.title)}.md`, pageId: p.id, title: p.title })),
    ...scan.drawings.map((path) => ({ path, pageId: null, title: baseName(path) })),
  ]);
  // The planner passes the note as this run converts it, its [[links]] as Markdown links: the form a page's links
  // read back in.
  // A note's image citations are compared as the page's image blocks read in Obsidian (`![[x.png]]` as `![](x.png)`), the way a pull matches them.
  const same = (note: VaultNote, markdown: string) => {
    const ctx = { index: provisional, fromPath: note.path, vaultName: config.vaultName, titles, media };
    if (comparable(toObsidian(markdown, ctx)) === comparable(withMediaAsPageReads(note.body, ctx))) return true;
    // A difference only in layout (__bold__ vs **bold**, indentation) is no difference: both sides alike through the translator.
    return comparable(toNotion(toObsidian(markdown, ctx), ctx)) === comparable(toNotion(note.body, ctx));
  };

  // Planned on the converted notes; execute still gets the scanned ones, so a conversion is skipped when the
  // note changed on disk since it was read. A note's hosted images are written as citations on top of its links.
  const linkConversions = convertNotes(scan.notes, scan.drawings);
  const linked = new Map(linkConversions.map((c) => [c.path, c.text]));
  const imageConversions = scan.notes.flatMap((note) => convertHostedImages(linked.get(note.path) ?? note.text, note.path, imageStore.pathOf, media) ?? []);
  const full = makePlan({
    notes: scan.notes,
    drawings: scan.drawings,
    pages,
    fetched,
    records,
    inboxFolder: config.inboxFolder,
    massTrashLimit: config.massTrashLimit,
    allowMassTrash: options.allowMassTrash,
    ...(options.allowTrashes ? { allowedTrashes: new Set(options.allowTrashes.pages) } : {}),
    same,
    holdsOldEmbeds: (record, note) => updateEmbedsResult(record, { index: provisional, fromPath: note.path, vaultName: config.vaultName, titles, media }) !== null,
    conversions: linkConversions,
    imageConversions,
    relocations: resolution.relocations,
    moveReasons: resolution.moveReasons,
    renames: resolution.renames,
    fileProject: resolution.fileProject,
  });
  // A page too large to read, or holding an image that can't be downloaded, or whose note is in use (or that waits with it:
  // a rename a note in use links to, a move beside one), is left alone: nothing is done to it or to its note this run
  // (its [[links]] and images included). Its note is the one carrying its id, or the one at its record's path that lost
  // its notion-id (as the planner pairs them).
  const waiting = waitingFor({ actions: full.actions, inUse: inUse.paths, notes: scan.notes, drawings: scan.drawings, records });
  const held = new Set([...truncated.keys(), ...failed.keys(), ...waiting.pages, ...unread]);
  const aloneNotes = new Set([...scan.notes.filter((n) => n.notionId !== null && held.has(n.notionId)).map((n) => n.path), ...waiting.paths]);
  for (const id of held) {
    const path = records.get(id)?.path;
    if (path !== undefined && scan.notes.some((n) => n.path === path && n.notionId === null)) aloneNotes.add(path);
  }
  const leftAlone = (a: Action) =>
    ("pageId" in a ? a.pageId !== null && held.has(a.pageId) : (a.kind === "convertLinks" || a.kind === "convertImages") && aloneNotes.has(a.path)) ||
    (a.kind === "recreatePage" && held.has(a.oldId)) ||
    ("path" in a && waiting.paths.has(a.path)) ||
    ("from" in a && waiting.paths.has(a.from));
  const stranded = scan.notes.flatMap((note) =>
    strandedMedia(note.body, { index: provisional, fromPath: note.path, vaultName: config.vaultName, titles, media }).map((s) => strandedWarning(note.path, s)),
  );
  const kept = held.size || waiting.paths.size ? { ...full, actions: full.actions.filter((a) => !leftAlone(a)) } : full;
  // A hosted file whose name no note can cite (no extension, or a note's, canvas's, base's or drawing's) stays a link to Notion in its
  // note, and its page goes on syncing: said every run, with what to do (spec §5.9).
  const unsupported = [...downloads.unsupported, ...notion.unsupported().filter((u) => fetched.has(u.pageId))].map(
    (u) =>
      `${noteOf(u.pageId, titleOf(u.pageId))}: the file "${u.name}" in Notion has a name a note can't cite (no extension, or one of a note, canvas, base or drawing), so it stays a link to Notion in the note; rename it in Notion with the extension of its kind (.pdf, .png, .mp3, .docx…) to have it downloaded and cited`,
  );
  // A file Notion refused in an earlier run and a note still cites is said again: its line stays text in Notion and nothing else
  // will say so (a quiet run writes nothing, so Notion is not asked again). It ends when no note cites the file any more (or the file is gone).
  /** Whether Notion holds an upload of the file as it is now: a refusal of it is over. */
  const uploadedAsItIs = async (path: string) => {
    const kept = imageStore.get(path);
    return kept?.uploadSha != null && kept.uploadSha === (await sha(path));
  };
  const refusedBefore = new Map<string, string>();
  for (const [path, reason] of imageStore.refusals()) {
    if ((await plainVault.exists(path)) && scan.notes.some((n) => namesMedia(n.text, path)) && !(await uploadedAsItIs(path))) refusedBefore.set(path, reason);
  }
  const refusedWarning = (path: string, reason: string) => {
    const citing = scan.notes.filter((n) => namesMedia(n.text, path)).map((n) => n.path);
    return `can't upload ${path}: ${reason}; in Notion the line that cites it${citing.length ? ` (in ${citing.join(", ")})` : ""} stays text, or the file it held before, until the citation changes`;
  };
  const refusedWarnings = new Map([...refusedBefore].map(([path, reason]) => [path, refusedWarning(path, reason)]));
  // A note moved in Obsidian whose page's first project also changed in Notion since the last run: the note's folder wins (spec §5 B3), and the run says so.
  const liveProjects = new Set(projectList.map((p) => p.id));
  const firstProjectOf = (id: PageId) => {
    const first = listed.find((p) => p.id === id)?.projects?.ids[0];
    return first !== undefined && liveProjects.has(first) ? first : null;
  };
  const clashes = projectsOn
    ? scan.notes.flatMap((note) => {
        const record = note.notionId ? records.get(note.notionId) : undefined;
        if (!record || record.project === undefined || held.has(record.notionId) || note.path === record.path) return [];
        if (!listedIds.has(record.notionId) || firstProjectOf(record.notionId) === record.project) return [];
        return [resolution.relocations.find((r) => r.from === note.path)?.to ?? note.path];
      })
    : [];
  // Tags are left alone, in both directions, for the pages held, for those whose notes wait, and for every note in use.
  const tagsAlone = new Set([...held, ...pagesInUse]);
  for (const [id, record] of records) if (waiting.paths.has(record.path)) tagsAlone.add(id);
  // A note in use whose tags would have changed waits for them too, though nothing else is waiting on it.
  const tagsWaiting = tags
    ? tagChanges({
        notes: new Map(scan.notes.map((n) => [n.path, n])),
        pages: new Map(pages.map((p) => [p.id, p])),
        records: new Map([...records].filter(([id]) => pagesInUse.has(id) && !held.has(id))),
        leaveAlone: new Set(),
      }).map((c) => c.path)
    : [];
  const waitingPaths = [...new Set([...[...waiting.pages, ...unread].map((id) => noteOf(id, titleOf(id))), ...waiting.paths, ...waiting.linking, ...tagsWaiting])].sort();
  const unreadable = inUse.tabsUnreadable ? ["couldn't read the notes open in Obsidian (.obsidian/workspace.json); only notes edited in the last 5 minutes wait"] : [];
  let plan: Plan = {
    ...kept,
    warnings: [...kept.warnings, ...unreadable, ...stranded, ...unsupported, ...refusedWarnings.values()],
    ...(resolution.creates.length ? { creates: resolution.creates } : {}),
    ...(clashes.length ? { clashes } : {}),
    ...(waitingPaths.length ? { waiting: waitingPaths } : {}),
  };

  /**
   * The attachments of the attachment folder cited at the end of the last run and by nothing now (spec §5.7), as the vault is
   * now. `leftAlone`: pages this run did not finish, whose notes count as still citing what they last synced.
   */
  const unusedNow = async (leftAlone: readonly PageId[], recordsNow: ReadonlyMap<PageId, { obsidianText: string }>) => {
    const previous = new Set([...imageStore.cited()].filter((path) => inFolder(path, media.folder)));
    const cited = await citedMedia(config.vaultPath, media.folder, leftAlone.flatMap((id) => recordsNow.get(id)?.obsidianText ?? []), config.statusNote ?? null);
    const vault = createVaultFs(config.vaultPath, null);
    const there = new Set<string>();
    for (const path of previous) if (await vault.exists(path)) there.add(path);
    return { cited, unused: unusedMedia(previous, cited, (path) => there.has(path)) };
  };
  /** The warning that holds the moves back, or null when they may go ahead. */
  const holdsMoves = (unused: readonly string[]) => {
    if (unused.length <= config.massTrashLimit || options.allowMassTrash) return null;
    const allowed = options.allowTrashes ? new Set(options.allowTrashes.files) : null;
    if (allowed && unused.every((path) => allowed.has(path))) return null;
    return tooManyFiles(unused.length, config.massTrashLimit) + (allowed ? " The list changed since it was held; check it and confirm again." : "");
  };
  /** The pages of `listed` that show the file at `path`, as the records have them. */
  const pagesOf = (path: string, recordsNow: ReadonlyMap<PageId, { notionMarkdown: string }>, gone: readonly PageId[] = []) =>
    pagesShowing(path, recordsNow, (id) => listedIds.has(id) && !gone.includes(id));
  let linksToPreview: string[] | null = null;
  if (options.dryRun && linksTo) {
    // Worked out from the text read this run, before any action, so it can differ from what a real run writes
    // (for pages the run creates or pushes); a page left alone is left out. A relation the listing cut short is read in full, as the pass does.
    const preview = await previewLinksTo({ pages, records, fetched, readRelation: (id) => notion.readRelation(id), leaveAlone: held });
    if (preview.length) {
      linksToPreview = [
        `Links to would be set on ${preview.length} page${preview.length === 1 ? "" : "s"} (estimated from the text read this run):`,
        ...preview.map((id) => `  ${records.get(id)!.path}`),
      ];
    }
  }
  if (previewOnly) {
    // The files a real run uploads: those the pages it writes get in new image blocks, unless an upload of the file as it is is kept.
    const uploads: string[] = [];
    const seen = new Set<string>();
    for (const action of plan.actions) {
      if (!["createPage", "recreatePage", "pair", "push", "merge", "updateEmbeds"].includes(action.kind)) continue;
      const id = "pageId" in action ? (action.pageId ?? undefined) : undefined;
      const scanned = "path" in action ? (resolution.relocations.find((r) => r.to === action.path)?.from ?? action.path) : "";
      const note = "path" in action ? scan.notes.find((n) => n.path === scanned) : scan.notes.find((n) => n.notionId === id) ?? scan.notes.find((n) => n.path === records.get(id!)?.path);
      if (!note) continue;
      const ctx = { index: provisional, fromPath: note.path, vaultName: config.vaultName, titles, media };
      const current = id === undefined ? "" : (fetched.get(id) ?? records.get(id)?.notionMarkdown ?? "");
      for (const path of addedPlaceholders(toNotion(note.body, ctx), current)) {
        if (seen.has(path)) continue;
        const bytes = await readVault(path);
        const kept = imageStore.get(path);
        if (bytes === null || (kept?.uploadId != null && kept.uploadSha === createHash("sha256").update(bytes).digest("hex"))) continue;
        seen.add(path);
        uploads.push(`upload ${path} for ${note.path}`);
      }
    }
    const updates = replaced.flatMap((path) => {
      const shown = pagesOf(path, records).length;
      return shown > 0 ? [`update file ${path} (${shown} page${shown === 1 ? "" : "s"})`] : [];
    });
    const { unused } = await unusedNow([...held, ...(plan.heldPages ?? [])], records);
    const stopped = holdsMoves(unused);
    if (stopped !== null) plan = { ...plan, warnings: [...plan.warnings, stopped], heldTrashes: plan.heldTrashes + unused.length, heldFiles: unused };
    const lines = [...mediaPlan, ...uploads, ...updates, ...(stopped === null ? unused.map((path) => `move to .trash ${path}`) : [])];
    const tagLines = tags
      ? previewTags({ notes: new Map(scan.notes.map((n) => [n.path, n])), pages: new Map(pages.map((p) => [p.id, p])), records, leaveAlone: tagsAlone })
      : [];
    return { plan, summary: null, notes: scan.notes, pages, linksToPreview, ...(tagLines.length ? { tagsPreview: tagLines } : {}), ...(lines.length ? { mediaPlan: lines } : {}) };
  }

  const backups = join(config.stateDir, "backups", now().toISOString().replace(/[:.]/g, "-"));
  // The folders of notes are written as projects through a layer over the gateway; it works on the store as the resolver left it,
  // in memory. What the project store keeps is only what is true after the run, even a cut short one (`persistProjects`).
  const working = new Map(resolution.stored);
  const before = new Map([...(projectStore?.all() ?? [])].map(([id, project]) => [id, { ...project }]));
  const renamedInNotion = new Set<PageId>();
  const trueAfterRun = (id: PageId, project: StoredProject): boolean => {
    const planned = resolution.stored.get(id);
    const was = before.get(id);
    if (was !== undefined && was.path === project.path && was.title === project.title) return true;
    // A project the layer created or matched while the run worked: it exists in Notion, and its folder holds the notes that asked for it.
    if (planned === undefined || planned.path !== project.path || planned.title !== project.title) return true;
    // A rename made in Obsidian counts once Notion's title was changed; any other new or moved folder once the folder is there
    // (a note moved into it), so a rename from Notion whose moves were skipped is not forgotten and played back.
    const obsidian = resolution.renames.some((r) => r.id === id && r.side === "obsidian");
    return obsidian ? renamedInNotion.has(id) : existsSync(join(config.vaultPath, project.path));
  };
  const persistProjects = async () => {
    if (projectStore === null) return;
    const kept = new Map<PageId, StoredProject>();
    for (const [id, project] of before) if (working.has(id)) kept.set(id, project);
    for (const [id, project] of working) if (trueAfterRun(id, project)) kept.set(id, project);
    for (const id of [...projectStore.all().keys()]) if (!kept.has(id)) projectStore.delete(id);
    for (const [id, project] of kept) projectStore.set(id, project);
    await projectStore.save();
  };
  const workingStore: ProjectStore = {
    all: () => working,
    set: (id, project) => void working.set(id, { ...project }),
    delete: (id) => void working.delete(id),
    save: persistProjects,
  };
  const folders: FolderGateway = projectsOn
    ? withProjects(
        { ...notion, renameProject: async (id, title) => (await notion.renameProject(id, title), void renamedInNotion.add(id)) },
        {
          enabled: true,
          context: { inboxFolder: config.inboxFolder, attachmentFolder: media.folder, folders: new Set(scan.folders), projects: projectList, stored: working },
          store: workingStore,
          firstProjects: new Map(listed.map((p) => [p.id, p.projects ?? { ids: [], more: false }])),
          ambiguous: new Set(resolution.ambiguous),
        },
      )
    : folderless(notion);
  let ran = false;
  let summary: Summary;
  try {
    summary = await execute(
      plan,
      { notes: scan.notes, drawings: scan.drawings, pages, fetched, titles, readAt },
      { vault: createVaultFs(config.vaultPath, backups), notion: folders, records: store, vaultName: config.vaultName, now, media, inUse: inUse.paths },
    );
    ran = true;
  } finally {
    // Also when the run stops with an error: a project it created is in Notion and must be in the store.
    try {
      await persistProjects();
    } catch (error) {
      if (ran) throw error;
    }
  }
  // The pages left in the default folder or the root with their projects untouched are remembered in their records (`keptOut`); the mark ends otherwise.
  for (const [id, kept] of resolution.keptOut) {
    const record = store.all().get(id);
    if (!record || (record.keptOut === true) === kept) continue;
    const { keptOut: _, ...rest } = record;
    await store.put(kept ? { ...rest, keptOut: true } : rest);
  }
  if (projectStore !== null) {
    // The folder of a project renamed in Notion, or trashed there, is empty once its notes have moved out; any other content keeps it.
    for (const from of [...resolution.renames.map((r) => r.from), ...resolution.droppedFolders]) {
      const names = await readdir(join(config.vaultPath, from)).catch(() => null);
      if (names !== null && names.length === 0) await rmdir(join(config.vaultPath, from));
    }
  }
  if (summary.waiting) plan = { ...plan, waiting: [...new Set([...(plan.waiting ?? []), ...summary.waiting])].sort() };
  if (folders.createdProjects().length > 0) summary.projectsCreated = folders.createdProjects();
  for (const [id, title] of truncated) {
    summary.skipped.push({ path: noteOf(id, title), reason: "truncated: the page is too large to read completely; it is left alone" });
  }
  for (const [id, reason] of failed) summary.skipped.push({ path: noteOf(id, titleOf(id)), reason });
  const touched = new Set([...plan.actions.flatMap((a) => ("pageId" in a && a.pageId !== null ? [a.pageId] : [])), ...failed.keys(), ...waiting.pages]);
  for (const id of unchanged) {
    const record = store.all().get(id);
    if (record && !touched.has(id)) await store.put({ ...record, notionSeenAt: readAt.get(id)! });
  }
  if (linksTo) {
    const leaveAlone = new Set([...summary.skippedPages, ...held]);
    await updateLinksTo({ notion, records: store, pages, leaveAlone, summary });
  }
  if (tags) {
    const leaveAlone = new Set([...summary.skippedPages, ...summary.trashedPages, ...tagsAlone]);
    const counted = await syncTags({
      pages: new Map(pages.map((p) => [p.id, p])),
      records: store,
      vault: createVaultFs(config.vaultPath, backups),
      notion,
      leaveAlone,
      skipped: summary.skipped,
      log,
    });
    if (counted.set > 0) summary.tagsSet = counted.set;
    if (counted.written > 0) summary.tagsWritten = counted.written;
  }

  // A placeholder image a write left in its page (the upload or the switch was refused, or the run stopped before it) is
  // switched now, so that no page keeps an image that never opens. One that can't be is reported and tried again next run.
  for (const id of notion.unattached()) {
    if (summary.skippedPages.includes(id)) continue;
    const left = (reason: string) => summary.skipped.push({ path: noteOf(id, titleOf(id)), reason });
    try {
      await notion.attach(id);
    } catch (error) {
      if (!(error instanceof NotionPageError)) throw error;
      left(`${error.code}: can't put the images of this page in Notion (${error.message}); it is tried again next run`);
      continue;
    }
    if (notion.unattached().includes(id)) left("image_not_switched: an image of this page is not in the vault, so it stays an empty image in Notion; it is tried again next run");
  }

  // A replaced file (of any kind) goes onto the pages that show it (the list from before the run, on the pages as the run left them).
  const gone = [...summary.trashedPages];
  for (const path of replaced) {
    const shown = pagesOf(path, store.all(), gone);
    if (shown.length === 0) continue;
    try {
      if ((await notion.refreshImage(path, shown)) > 0) summary.mediaUpdated.push({ path, pages: shown.length });
    } catch (error) {
      if (!(error instanceof NotionPageError)) throw error;
      // The store still holds the hash the pages show, so the next run finds the file replaced again.
      summary.skipped.push({ path, reason: `${error.code}: can't put the new ${path} on every page that shows it (${error.message}); it is tried again next run` });
    }
  }

  // Attachments no note cites any more go to .trash, unless that is more than the limit (then the next run asks again).
  const { cited, unused } = await unusedNow([...held, ...(plan.heldPages ?? []), ...summary.skippedPages], store.all());
  const stopped = holdsMoves(unused);
  const vault = createVaultFs(config.vaultPath, backups);
  if (stopped === null) {
    for (const path of unused) {
      await vault.trash(path);
      imageStore.delete(path);
      summary.mediaMoved.push(path);
    }
  } else {
    plan = { ...plan, warnings: [...plan.warnings, stopped], heldTrashes: plan.heldTrashes + unused.length, heldFiles: unused };
  }
  // What a held move would have freed stays cited, so the run that is allowed to move it still sees it as unused.
  const nowCited = new Set(stopped === null ? cited : [...cited, ...unused]);
  const recorded = imageStore.cited();
  if (summary.mediaMoved.length > 0 || recorded.size !== nowCited.size || [...nowCited].some((path) => !recorded.has(path))) {
    imageStore.setCited(nowCited);
    await imageStore.save();
  }
  // The uploads Notion refused in this run join the ones still standing; all are said every run until the citation changes.
  const refusedNow = new Map(refusedBefore);
  const refusedThisRun = new Map(notion.refused().map((r) => [r.path, r.reason]));
  // A refusal ends when the file, as it is, was uploaded after all (the citation changed, or Notion takes it now).
  const lifted = new Set<string>();
  for (const path of refusedBefore.keys()) if (!refusedThisRun.has(path) && (await uploadedAsItIs(path))) lifted.add(path);
  for (const path of lifted) refusedNow.delete(path);
  const newlyRefused: string[] = [];
  for (const [path, reason] of refusedThisRun) {
    if (!(await plainVault.exists(path))) continue;
    if (!refusedNow.has(path)) newlyRefused.push(refusedWarning(path, reason));
    refusedNow.set(path, reason);
  }
  const ended = new Set([...lifted].map((path) => refusedWarnings.get(path)));
  if (newlyRefused.length > 0 || ended.size > 0) plan = { ...plan, warnings: [...plan.warnings.filter((w) => !ended.has(w)), ...newlyRefused] };
  const standing = imageStore.refusals();
  if (standing.size !== refusedNow.size || [...refusedNow].some(([path, reason]) => standing.get(path) !== reason)) {
    imageStore.setRefusals(refusedNow);
    await imageStore.save();
  }
  summary.mediaUploaded = notion.uploaded();
  summary.mediaRekeyed = rekeys.moves;
  return { plan, summary, notes: scan.notes, pages, ...(mediaPlan.length ? { mediaPlan } : {}) };
}
