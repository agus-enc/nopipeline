// A Notion gateway that keeps the vault's attachments (images, PDFs, audio, video, other files) in step with the pages: placeholder
// lines are uploaded and switched to hosted files, and hosted files read back as the placeholders the executor works with (the image
// design §5–§7, the attachments design §5.9–§5.11, §6).
import { createHash } from "node:crypto";
import type { ImageStore } from "../state/images.ts";
import { escapeNotionText } from "../translate/context.ts";
import type { ContentEdit, PageId } from "../types.ts";
import { UPLOAD_LIMIT } from "../vault/images.ts";
import { NotionPageError, type NotionGateway } from "./gateway.ts";
import { canonicalMarkdown, hostedFile, mediaKind, mediaLine, mediaText, placeholderPath, type MediaKind } from "./hosted.ts";

/**
 * An image, PDF, audio, video or file block of a page whose file the sync doesn't know (a new one), or knows but no longer has in
 * the vault; `url` is signed. `kind` is the block's own type (a file block holding a png is `file`).
 */
export interface PendingImage {
  pageId: PageId;
  key: string;
  name: string;
  url: string;
  kind: MediaKind;
}

/** A hosted file of a page that can't be cited in a note by its name (no extension, or a note's, canvas's, base's or drawing's), so it is never downloaded (spec §5.9). */
export interface UnsupportedFile {
  pageId: PageId;
  key: string;
  name: string;
  kind: MediaKind;
}

/** A vault file Notion refused to take, and why (a phrase to follow "can't upload <path>"). */
export interface RefusedFile {
  path: string;
  reason: string;
}

export interface ImageGateway extends NotionGateway {
  /** Hosted files (of any kind) seen in pages read so far that need downloading, once per file uuid. */
  pending(): PendingImage[];
  /** Hosted files seen that can't be downloaded and cited (spec §5.9), once per file uuid; their pages are not held. */
  unsupported(): UnsupportedFile[];
  /**
   * The files Notion refused to take in an upload (a content type or a size it refuses, spec §5.11), once per file: the citation
   * stays literal text on the page (or, for a replaced file whose block is there, the block stays as it is), and the page is not held.
   */
  refused(): RefusedFile[];
  /** The page's last read markdown as the executor sees it, or null before any read. */
  canonical(id: PageId): string | null;
  /** For a file whose bytes changed: one new upload for every block of `pages` that shows an old one (of any kind); returns how many blocks it switched. Only a switch that reached every block records the new file as the one the pages show. A refused upload switches none (`refused`). */
  refreshImage(path: string, pages: PageId[]): Promise<number>;
  /** The pages last read or written that still hold a placeholder block (one no upload has replaced), in the order they were seen. */
  unattached(): PageId[];
  /** Switches every placeholder block of the page to a hosted file (what a write of one does at once); throws what Notion refuses, except an upload it refuses (`refused`), which leaves that block as it is. */
  attach(id: PageId): Promise<void>;
  /** How many files this gateway has uploaded so far for new blocks (what a dry run lists as `upload`); the new upload of a replaced file (`refreshImage`) is not counted. */
  uploaded(): number;
}

export interface ImageDeps {
  store: ImageStore;
  /** A preview: reads only. The pages still holding a placeholder are not written to the store. */
  readOnly?: boolean;
  /** The bytes of a vault file, or null when it isn't there. */
  readFile: (path: string) => Promise<Uint8Array | null>;
  /** Whether a vault file is there, without reading it (a video can be large). Without it, `readFile` is asked. */
  exists?: (path: string) => Promise<boolean>;
  /** The SHA-256 (hex) of a vault file, or null when it isn't there, for comparing a file with the one a page shows without holding it in memory. Without it, `readFile`'s bytes are hashed. */
  sha256?: (path: string) => Promise<string | null>;
  log: (line: string) => void;
}

/** A list marker the translator may put before a lone media line (`- ![c](url)`; Notion reads it back as an empty item holding the block). */
const LIST_MARKER = /^\t*(?:[-+*]|\d+[.)]) /;
/** The record a hosted file's URL ends with: which block holds the file. */
const RECORD = /#notion_record=block\.([0-9a-f-]+)\./i;
const plainId = (id: string) => id.replace(/-/g, "").toLowerCase();

/** A media line (an image, or a PDF, file, audio or video tag), with a list marker before it if it has one: `prefix` + the line's text is the line. */
function mediaIn(line: string): { prefix: string; kind: MediaKind; caption: string; url: string } | null {
  const head = LIST_MARKER.exec(line)?.[0] ?? "";
  const found = mediaLine(line.slice(head.length));
  return found ? { prefix: head + found.indent, kind: found.kind, caption: found.caption, url: found.url } : null;
}

const holdsPlaceholder = (text: string) => text.split("\n").some((line) => {
  const found = mediaIn(line);
  return found !== null && placeholderPath(found.url) !== null;
});

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * What a page shows in place of a block whose file Notion refused: the citation as Obsidian shows the block (`![caption](name)`, a
 * link for a file block), as escaped text so Notion keeps it a line of text. Read back, it is the block's own line in a note.
 */
function literalOf(kind: MediaKind, caption: string, path: string): string {
  const name = nameOf(path);
  const text = escapeNotionText(name);
  return kind === "file" ? `\\[${caption === "" ? text : caption}\\](${text})` : `!\\[${caption}\\](${text})`;
}

/** Notion won't take this file in an upload: why, as a phrase. Internal: the callers turn it into a literal line or a report. */
class UploadRefused extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "UploadRefused";
    this.reason = reason;
  }
}

export function withImages(notion: NotionGateway, deps: ImageDeps): ImageGateway {
  const { store, readFile, log, readOnly = false } = deps;
  /** The last markdown Notion gave for each page, as it gave it (signed URLs and all). */
  const lastRaw = new Map<PageId, string>();
  const queue: PendingImage[] = [];
  const unsupported: UnsupportedFile[] = [];
  const reported = new Set<string>();
  /** The files Notion refused in this run, by vault path: the hash refused (a changed file is asked again) and why. */
  const refusals = new Map<string, { sha: string; reason: string }>();
  let uploads = 0;
  /** The uploads a write made ahead of itself and is about to attach: a refusal of one of them is not the expiry of a kept upload, so it is not made again. */
  const ahead = new Set<string>();
  /** The pages that hold a placeholder block (an external block no upload has replaced yet); persisted, so a run that stops before the switch is finished by the next. */
  const unattached = new Set<PageId>(store.unattached());
  /** Makes the store's list the gateway's, when they differ (the store is saved as soon as it changes, so a stopped run keeps it). */
  const keepUnattached = async () => {
    if (readOnly) return;
    const saved = store.unattached();
    if (saved.size === unattached.size && [...unattached].every((id) => saved.has(id))) return;
    store.setUnattached(unattached);
    await store.save();
  };

  const loadFile = async (path: string) => {
    const bytes = await readFile(path);
    return bytes === null ? null : { bytes, sha: createHash("sha256").update(bytes).digest("hex") };
  };
  const isThere = async (path: string) => (deps.exists ? deps.exists(path) : (await readFile(path)) !== null);
  const shaOf = async (path: string) => (deps.sha256 ? deps.sha256(path) : ((await loadFile(path))?.sha ?? null));

  /** Takes note of a page's markdown and returns it as the executor sees it. */
  async function see(id: PageId, raw: string): Promise<string> {
    lastRaw.set(id, raw);
    if (holdsPlaceholder(raw)) unattached.add(id);
    else unattached.delete(id);
    await keepUnattached();
    const there = new Map<string, boolean>();
    for (const line of raw.split("\n")) {
      const media = mediaLine(line);
      const file = media && hostedFile(media.url);
      if (!media || !file || reported.has(file.key)) continue;
      const path = store.pathOf(file.key);
      if (path !== null) {
        if (!there.has(path)) there.set(path, await isThere(path));
        if (there.get(path)) continue;
      }
      reported.add(file.key);
      // A file the sync knows comes back to its own path whatever its name; a new one needs a name a note can cite (spec §5.9).
      if (path === null && mediaKind(file.name) === null) unsupported.push({ pageId: id, key: file.key, name: file.name, kind: media.kind });
      else queue.push({ pageId: id, key: file.key, name: file.name, url: media.url, kind: media.kind });
    }
    return canonicalMarkdown(raw, store.pathOf);
  }

  /** The hosted blocks in a page's last markdown, in order: the file uuid of each and its kind. */
  function hostedBlocks(id: PageId): { key: string; kind: MediaKind }[] {
    return (lastRaw.get(id) ?? "").split("\n").flatMap((line) => {
      const media = mediaLine(line);
      const file = media && hostedFile(media.url);
      return media && file ? [{ key: file.key, kind: media.kind }] : [];
    });
  }

  /**
   * Notion refuses the upload: its content type (the file upload API takes only some, `validation_error`), or a size over the
   * single-part limit, which is not asked. Remembered for the run, so a file cited twice is asked once.
   */
  function refuse(path: string, file: { sha: string }, reason: string): never {
    refusals.set(path, { sha: file.sha, reason });
    throw new UploadRefused(reason);
  }

  /**
   * Uploads `path`'s file and records the upload, keeping the keys already known. The hash of what the pages show moves
   * only when no block shows the file yet: while some do, they show the old bytes until `refreshImage` has switched them all.
   * Throws `UploadRefused` for a file Notion won't take.
   */
  async function upload(path: string, file: { bytes: Uint8Array; sha: string }, counted = true): Promise<string> {
    const refused = refusals.get(path);
    if (refused?.sha === file.sha) throw new UploadRefused(refused.reason);
    if (file.bytes.length > UPLOAD_LIMIT) refuse(path, file, `over ${UPLOAD_LIMIT / 1024 / 1024} MB, the most Notion takes in one upload`);
    let uploadId: string;
    try {
      uploadId = await notion.uploadFile(nameOf(path), file.bytes);
    } catch (error) {
      if (error instanceof NotionPageError && error.code === "validation_error") refuse(path, file, error.message);
      throw error;
    }
    if (counted) uploads++;
    const known = store.get(path);
    const shown = known !== undefined && known.keys.length > 0 ? known.sha256 : file.sha;
    const size = shown === file.sha ? file.bytes.length : known?.size;
    store.set(path, { sha256: shown, ...(size === undefined ? {} : { size }), uploadId, uploadSha: file.sha, keys: known?.keys ?? [], urls: known?.urls ?? {} });
    return uploadId;
  }

  /** The upload kept for the file as it is now, if any. */
  function keptUpload(path: string, file: { sha: string }): string | null {
    const known = store.get(path);
    return known?.uploadId != null && known.uploadSha === file.sha ? known.uploadId : null;
  }

  /**
   * Switches one placeholder block to the hosted file: the upload kept for the file as it is, else a new one. An upload kept from an
   * earlier run that Notion no longer takes (one never attached expires after an hour: `validation_error`, "invalid status of
   * expired") is made again, once, whatever the refusal says. False when Notion refuses the file itself.
   */
  async function switchBlock(blockId: string, kind: MediaKind, path: string, file: { bytes: Uint8Array; sha: string }): Promise<boolean> {
    const reusable = keptUpload(path, file);
    try {
      try {
        await notion.attachFile(blockId, kind, reusable ?? (await upload(path, file)));
      } catch (error) {
        if (!(reusable !== null && !ahead.has(reusable) && error instanceof NotionPageError)) throw error;
        await notion.attachFile(blockId, kind, await upload(path, file));
      }
      return true;
    } catch (error) {
      if (error instanceof UploadRefused) return false;
      throw error;
    }
  }

  /**
   * Reads the page again and records the file uuid each switched block now shows; returns the page as the executor sees it.
   * A read cut short still gives the uuids of the blocks it holds, but it is no record of the page: it throws `truncated`
   * after them, and the page stays as it was last seen (still looked at again if it holds a placeholder).
   */
  async function record(id: PageId, switched: { blockId: string; path: string }[]): Promise<string> {
    const { markdown: raw, truncated } = await notion.getMarkdown(id);
    const wanted = new Map(switched.map((s) => [plainId(s.blockId), s.path]));
    for (const line of raw.split("\n")) {
      const media = mediaLine(line);
      const block = media && RECORD.exec(media.url)?.[1];
      const path = block ? wanted.get(plainId(block)) : undefined;
      const file = media && hostedFile(media.url);
      const entry = path === undefined ? undefined : store.get(path);
      if (!file || !entry || entry.keys.includes(file.key)) continue;
      store.set(path!, { ...entry, keys: [...entry.keys, file.key], urls: { ...entry.urls, [file.key]: file.bare } });
    }
    await store.save();
    if (truncated) throw new NotionPageError("truncated", "the page is too large to read completely");
    return see(id, raw);
  }

  /** Switches every placeholder block of the page to a hosted file and returns the page as the executor sees it. */
  async function attach(id: PageId): Promise<string> {
    const todo = (await notion.mediaBlocks(id)).flatMap((block) => {
      const path = block.external === null ? null : placeholderPath(block.external);
      return path === null ? [] : [{ blockId: block.id, kind: block.kind, path }];
    });
    const files = new Map<string, Awaited<ReturnType<typeof loadFile>>>();
    const switched: { blockId: string; path: string }[] = [];
    let failure: unknown;
    try {
      for (const { blockId, kind, path } of todo) {
        if (!files.has(path)) files.set(path, await loadFile(path));
        const file = files.get(path)!;
        if (file === null) {
          log(`can't upload ${path}: the file isn't in the vault, so its place in the page stays an empty ${kind === "image" ? "image" : "file"}`);
          continue;
        }
        // A file Notion refuses (`refused`) leaves its block as it is, and the others are switched: the page is not held.
        if (await switchBlock(blockId, kind, path, file)) switched.push({ blockId, path });
      }
    } catch (error) {
      failure = error;
    }
    // Even after a failure: a block that now shows a file the store doesn't know would be read as a new file.
    let markdown: string | null = null;
    let unread: unknown;
    if (switched.length > 0) {
      try {
        markdown = await record(id, switched);
      } catch (error) {
        unread = error;
      }
    }
    // The refusal that stopped the switching is the one to report, not a read that failed after it.
    if (failure !== undefined) throw failure;
    if (unread !== undefined) throw unread;
    return markdown ?? canonicalMarkdown(lastRaw.get(id) ?? "", store.pathOf);
  }

  /**
   * `markdown` (a page's, or an edit's new text) as it goes to Notion. A placeholder line that stands for a block the page already
   * holds (`held`, for a whole-page write) goes as that block's bare hosted URL, so Notion keeps the block. One that needs an upload
   * is uploaded now, ahead of the write, so that a file Notion refuses never reaches the page as a block: its line is written as
   * literal text instead (and the block that was there, if any, stays when the file was only replaced). Any other failure of the
   * upload is left for the switch after the write, which meets it again.
   */
  async function sendable(markdown: string, held: { key: string; kind: MediaKind }[] | null): Promise<string> {
    const shas = new Map<string, string | null>();
    const lines: string[] = [];
    for (const text of markdown.split("\n")) {
      const media = mediaIn(text);
      const path = media && placeholderPath(media.url);
      if (!media || !path) {
        lines.push(text);
        continue;
      }
      const known = store.get(path);
      const at = held && known ? held.findIndex((block) => block.kind === media.kind && known.keys.includes(block.key)) : -1;
      const bare = (): string => {
        const url = known!.urls[held![at]!.key];
        held!.splice(at, 1);
        return mediaText(media.kind, media.prefix, media.caption, url!);
      };
      let sent = text;
      if (at >= 0 && known!.urls[held![at]!.key] !== undefined) {
        if (!shas.has(path)) shas.set(path, await shaOf(path));
        if (shas.get(path) === known!.sha256) sent = bare();
      }
      if (sent === text) {
        const file = await loadFile(path);
        const refused = file === null ? null : await uploadAhead(path, file);
        if (refused !== null) sent = at >= 0 && known!.urls[held![at]!.key] !== undefined ? bare() : media.prefix + literalOf(media.kind, media.caption, path);
      }
      lines.push(sent);
    }
    return lines.join("\n");
  }

  /** Uploads `path`'s file ahead of a write unless an upload of it as it is is kept; the refusal's reason, or null. */
  async function uploadAhead(path: string, file: { bytes: Uint8Array; sha: string }): Promise<string | null> {
    if (keptUpload(path, file) !== null) return null;
    try {
      ahead.add(await upload(path, file));
      return null;
    } catch (error) {
      return error instanceof UploadRefused ? error.reason : null;
    }
  }

  /** `work`, a write that may make uploads ahead of itself. */
  async function writing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } finally {
      ahead.clear();
    }
  }

  return {
    async listPages() {
      const pages = await notion.listPages();
      // A page that is gone (deleted, or trashed from Notion) has nothing left to switch.
      const listed = new Set(pages.map((p) => p.id));
      for (const id of [...unattached]) if (!listed.has(id)) unattached.delete(id);
      await keepUnattached();
      return pages;
    },
    createPage: (input) => notion.createPage(input),
    setTitle: (id, title) => notion.setTitle(id, title),
    async trash(id) {
      await notion.trash(id);
      unattached.delete(id);
      await keepUnattached();
    },
    pageStatus: (id) => notion.pageStatus(id),
    properties: () => notion.properties(),
    readProjects: (id) => notion.readProjects(id),
    setProjects: (id, ids) => notion.setProjects(id, ids),
    projectsSource: () => notion.projectsSource(),
    listProjects: () => notion.listProjects(),
    createProject: (title) => notion.createProject(title),
    renameProject: (id, title) => notion.renameProject(id, title),
    pageTitles: (ids) => notion.pageTitles(ids),
    mentionTargets: (ids) => notion.mentionTargets(ids),
    relationTarget: () => notion.relationTarget(),
    readRelation: (id) => notion.readRelation(id),
    setRelation: (id, ids) => notion.setRelation(id, ids),
    setTags: (id, names) => notion.setTags(id, names),
    uploadFile: (name, bytes) => notion.uploadFile(name, bytes),
    mediaBlocks: (id) => notion.mediaBlocks(id),
    attachFile: (blockId, kind, uploadId) => notion.attachFile(blockId, kind, uploadId),
    download: (url) => notion.download(url),
    downloadTo: (url, fullPath) => notion.downloadTo(url, fullPath),

    async getMarkdown(id) {
      const page = await notion.getMarkdown(id);
      return { ...page, markdown: await see(id, page.markdown) };
    },

    updateContent: (id: PageId, edits: ContentEdit[]) =>
      writing(async () => {
        // Only the new text can hold a placeholder: Notion finds no search text that does.
        const sent: ContentEdit[] = [];
        for (const edit of edits) sent.push({ ...edit, new_str: await sendable(edit.new_str, null) });
        const markdown = await see(id, await notion.updateContent(id, sent));
        return sent.some((edit) => holdsPlaceholder(edit.new_str)) ? attach(id) : markdown;
      }),

    replaceContent: (id, markdown) =>
      writing(async () => {
        const sent = await sendable(markdown, hostedBlocks(id));
        const seen = await see(id, await notion.replaceContent(id, sent));
        return holdsPlaceholder(sent) ? attach(id) : seen;
      }),

    unattached: () => [...unattached],
    uploaded: () => uploads,
    refused: () => [...refusals].map(([path, { reason }]) => ({ path, reason })),
    attach: async (id) => void (await attach(id)),
    pending: () => [...queue],
    unsupported: () => [...unsupported],
    canonical: (id) => {
      const raw = lastRaw.get(id);
      return raw === undefined ? null : canonicalMarkdown(raw, store.pathOf);
    },

    async refreshImage(path, pages) {
      const known = store.get(path);
      if (!known) return 0;
      const file = await loadFile(path);
      if (file === null) {
        log(`can't replace ${path} in Notion: the file isn't in the vault`);
        return 0;
      }
      const targets: { pageId: PageId; blockId: string; kind: MediaKind }[] = [];
      for (const pageId of pages) {
        for (const block of await notion.mediaBlocks(pageId)) {
          const key = block.hosted === null ? undefined : hostedFile(block.hosted)?.key;
          if (key !== undefined && known.keys.includes(key)) targets.push({ pageId, blockId: block.id, kind: block.kind });
        }
      }
      if (targets.length === 0) return 0;
      // Not counted in `uploaded()`: a replaced file is reported as "updated image", the dry run's "update image".
      let uploadId: string;
      try {
        uploadId = await upload(path, file, false);
      } catch (error) {
        // Notion won't take the new file: the pages keep showing the old one (the hash stays), and the next run asks again.
        if (error instanceof UploadRefused) return 0;
        throw error;
      }
      const done: typeof targets = [];
      let failure: unknown;
      try {
        for (const target of targets) {
          await notion.attachFile(target.blockId, target.kind, uploadId);
          done.push(target);
        }
      } catch (error) {
        failure = error;
      }
      // Every page is recorded, even after one whose read failed: a block that shows a file the store doesn't know would be read as a new file.
      let unread: unknown;
      for (const pageId of new Set(done.map((t) => t.pageId))) {
        try {
          await record(pageId, done.filter((t) => t.pageId === pageId).map((t) => ({ blockId: t.blockId, path })));
        } catch (error) {
          unread ??= error;
        }
      }
      // Only now do the pages show the file as it is: a stop or a refusal before this leaves the old hash, and the next run finds the file replaced again.
      if (failure === undefined && unread === undefined) store.set(path, { ...store.get(path)!, sha256: file.sha, size: file.bytes.length });
      await store.save();
      if (failure !== undefined) throw failure;
      if (unread !== undefined) throw unread;
      return done.length;
    },
  };
}
