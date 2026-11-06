// An in-memory notes database that behaves like the real API for everything the sync uses (what Notion keeps of the
// markdown it is sent is modelled in notion-model.ts).
import { createHash, randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { pieceTogether, NotionPageError, ProjectsUnreadable, type MediaBlock, type NotionGateway, type RawMarkdown } from "../../src/notion/gateway.ts";
import { contentType, hostedFile, isUnsearchableMediaLine, mediaLine, mediaText, type MediaKind } from "../../src/notion/hosted.ts";
import { idFromUrl } from "../../src/notion/ids.ts";
import type { MentionTarget } from "../../src/notion/search.ts";
import { asNotionKeeps } from "./notion-model.ts";
import type { ContentEdit, PageId, PageMeta, ProjectMeta } from "../../src/types.ts";

export { asNotionKeeps } from "./notion-model.ts";

interface FakePage {
  id: PageId;
  title: string;
  /** The page's projects relation, in the order written (checked live); entries to trashed projects stay here but Notion no longer shows them. */
  projects: PageId[];
  markdown: string;
  lastEditedTime: string;
  inTrash: boolean;
  truncated?: boolean;
  /**
   * Set by `cut`: the lines of `markdown` (0-based) Notion leaves out of the page with the block ids they get, and the
   * blocks it won't give when asked for. A left-out block is its line and the more deeply indented lines after it.
   */
  cut?: { blocks: Map<number, string>; unfetchable: Set<string> };
  /** The page's "Links to" relation, as written (entries to trashed pages stay here but Notion no longer shows them). */
  linksTo?: PageId[];
  /** The page's tags; listed only when the database has the tags property. */
  tags?: string[];
  /** The page's image, PDF, audio, video and file blocks, in the order of the media lines of `markdown`. */
  media: FakeMediaBlock[];
}

/** A page of the projects database. `template` is how it was created: from the database's default template, or blank. */
interface FakeProject {
  id: PageId;
  title: string;
  inTrash: boolean;
  template: "default" | "none";
}

/** A media block: an external URL (empty for a block with none), or a hosted file. Its caption is the text of its line. */
interface FakeMediaBlock {
  id: string;
  kind: MediaKind;
  external: string | null;
  fileKey: string | null;
}

/** The workspace in the URLs of hosted files (a made-up id). */
const WORKSPACE = "4f1c2a9e-0000-4000-8000-123456789abc";
const FILE_HOST = "https://prod-files-secure.s3.us-west-2.amazonaws.com";

/**
 * The name Notion gives an uploaded file in its URL (live: `probe (1).png` came back as `probe_(1).png`):
 * spaces become underscores, and parentheses stay literal, unencoded. Other characters are not checked; they are
 * percent-encoded as `encodeURIComponent` does.
 */
const hostedName = (name: string) => name.replace(/ /g, "_");

/**
 * Which lines of `lines` are media blocks: an image alone on its line, or a PDF, file, audio or video tag alone on its line
 * (spec §6), outside a code block. A list item holding only one is not one: Notion makes that an empty item with the block
 * as its child (`inListItems`).
 */
function mediaLineIndexes(lines: string[]): number[] {
  const found: number[] = [];
  let fence: string | null = null;
  lines.forEach((line, k) => {
    const open = /^\t*(`{3,})[^`]*$/.exec(line);
    if (fence !== null || open) {
      if (fence === null) fence = open![1]!;
      else if (line.trim() === fence) fence = null;
    } else if (mediaLine(line) !== null) found.push(k);
  });
  return found;
}

/** `- ![c](u)` as Notion keeps it (live, result 4; `- <pdf src>c</pdf>` assumed alike, checked by the live test): an empty item, then the block one tab deeper. */
function inListItems(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const open = /^\t*(`{3,})[^`]*$/.exec(line);
    if (fence !== null || open) {
      if (fence === null) fence = open![1]!;
      else if (line.trim() === fence) fence = null;
      out.push(line);
      continue;
    }
    const item = /^(\t*)([-+*]) (.*)$/.exec(line);
    if (item && mediaLine(item[3]!) !== null) out.push(`${item[1]}${item[2]}`, `${item[1]}\t${item[3]}`);
    else out.push(line);
  }
  return out.join("\n");
}

/** How many relation entries a database query lists for a page (live: 25, with `has_more` when there are others). */
const QUERY_RELATION_LIMIT = 25;
const LINKS_TO = "Links to";
const TAGS = "Tags";

/** A run of a page's text as Notion's search reads it: a mention is one piece, `shown` with its title or as it is. */
interface Piece {
  text: string;
  shown: string;
  mention: boolean;
}

const SELF_CLOSING = /<mention-page\s+url="([^"]*)"\s*\/>/g;
const CODE_SPAN = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

/**
 * A page's markdown as `update_content` searches it (live probes): a page mention outside code shows
 * the page's current title, `<mention-page url="…">Title</mention-page>`, where `title` gives one, and stays
 * self-closing, as `retrieveMarkdown` returns it, where it gives null. Mentions in code are text.
 */
export function searchPieces(markdown: string, title: (id: PageId | null) => string | null): Piece[] {
  const pieces: Piece[] = [];
  const text = (t: string) => t && pieces.push({ text: t, shown: t, mention: false });
  let fence: string | null = null;
  markdown.split("\n").forEach((line, k) => {
    if (k > 0) text("\n");
    const open = /^\t*(`{3,})[^`]*$/.exec(line);
    if (fence !== null || open) {
      if (fence === null) fence = open![1]!;
      else if (line.trim() === fence) fence = null;
      text(line);
      return;
    }
    let at = 0;
    const mentions = (part: string) => {
      let last = 0;
      for (const m of part.matchAll(SELF_CLOSING)) {
        text(part.slice(last, m.index));
        const shown = title(idFromUrl(m[1]!));
        pieces.push({ text: m[0], shown: shown === null ? m[0] : `<mention-page url="${m[1]}">${shown}</mention-page>`, mention: true });
        last = m.index! + m[0].length;
      }
      text(part.slice(last));
    };
    for (const span of line.matchAll(CODE_SPAN)) {
      mentions(line.slice(at, span.index));
      text(span[0]);
      at = span.index! + span[0].length;
    }
    mentions(line.slice(at));
  });
  return pieces;
}

/**
 * `markdown` with the one place Notion's search finds `old` replaced by `replacement`, or a refusal worded as
 * Notion words it: the search must find it exactly once, in the text as `searchPieces` shows it, never starting or
 * ending inside a mention (a title's text alone is not found).
 */
export function searchAndReplace(markdown: string, old: string, replacement: string, title: (id: PageId | null) => string | null): string {
  const pieces = searchPieces(markdown, title);
  const shown = pieces.map((p) => p.shown).join("");
  const bounds: { from: number; to: number; text: number; same: boolean }[] = [];
  let x = 0;
  let y = 0;
  for (const p of pieces) {
    bounds.push({ from: x, to: x + p.shown.length, text: y, same: !p.mention });
    x += p.shown.length;
    y += p.text.length;
  }
  const cuts = (at: number) => bounds.some((b) => !b.same && at > b.from && at < b.to);
  const found: number[] = [];
  for (let at = shown.indexOf(old); at !== -1; at = shown.indexOf(old, at + 1)) if (!cuts(at) && !cuts(at + old.length)) found.push(at);
  if (found.length === 0) throw new NotionPageError("validation_error", `No matches found for ${old}.`);
  if (found.length > 1) throw new NotionPageError("validation_error", `Multiple matches found for "${old}". Found ${found.length} matches.`);
  const toText = (at: number) => {
    const b = bounds.find((b) => at >= b.from && at <= b.to && (b.same || at === b.from || at === b.to))!;
    return b.same || at === b.from ? b.text + (at - b.from) : b.text + pieces[bounds.indexOf(b)]!.text.length;
  };
  // Notion keeps a mention written in an edit and returns it self-closing, whatever title it was written with.
  const kept = replacement.replace(/<mention-page\s+url="([^"]*)"[^>]*>[\s\S]*?<\/mention-page>/g, '<mention-page url="$1"/>');
  return markdown.slice(0, toText(found[0]!)) + kept + markdown.slice(toText(found[0]! + old.length));
}

export class FakeNotion implements NotionGateway {
  readonly pages = new Map<PageId, FakePage>();
  /** Pages outside the database that notes may mention: id -> title. */
  readonly outside = new Map<PageId, string>();
  readonly calls: string[] = [];
  /**
   * Pages Notion refuses to say anything about (`restricted_resource`): `mentionTargets` leaves them out. A page
   * that isn't shared with the connection is something else: Notion answers that it doesn't exist (`object_not_found`).
   */
  readonly restricted = new Set<PageId>();
  /**
   * How Notion's search shows a mention of a page in the trash: live probes saw it found by its titled form in
   * some runs and only self-closing in others. `trashedForms` sets it for one page ("neither": two probe runs saw
   * searches refused that are otherwise found, unexplained).
   */
  trashedMentions: "self-closing" | "titled" = "self-closing";
  readonly trashedForms = new Map<PageId, "self-closing" | "titled" | "neither">();
  /** The database's properties: name -> type. */
  readonly schema = new Map<string, string>([["Name", "title"]]);
  /** The data source the database and its relation point to. */
  dataSourceId = "a50245e9-8e6a-41aa-8ccf-d8795ed0dead";
  /** The pages of the projects database. */
  readonly projectPages = new Map<PageId, FakeProject>();
  /** The projects database's data source. */
  projectsDataSourceId = "9af15f91-6806-40cc-8b99-91c7627acd6c";
  /** The profile's projects relation; null: the profile has none (pages list no `projects`, `projectsSource` is null). */
  projectsRelation: string | null = "Project";
  /** The connection can't read the projects database (or the relation is missing): `projectsSource` throws `ProjectsUnreadable`. */
  projectsUnreadable = false;
  /** Whether the projects database has a default template; a project created meanwhile records it (without one, Notion refuses `template: default`, so the gateway asks for `none`). */
  defaultTemplate = false;
  /** Files Notion holds, by the uuid in their URL; an upload gets its uuid when it is first attached. */
  private readonly files = new Map<string, { name: string; bytes: Uint8Array }>();
  private readonly uploads = new Map<string, { name: string; bytes: Uint8Array; fileKey: string | null; expired?: boolean }>();
  /** Counts the signatures given out: no two reads of a hosted file show the same one. */
  private signatures = 0;
  private readonly clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  private stamp(): string {
    return new Date(Math.floor(this.clock().getTime() / 60_000) * 60_000).toISOString();
  }

  private live(id: PageId): FakePage {
    const page = this.pages.get(id);
    if (!page || page.inTrash) throw new NotionPageError("object_not_found", `Could not find page with ID: ${id}.`);
    return page;
  }

  /** A page someone created in Notion. */
  add(title: string, markdown: string, projects: PageId[] = []): PageId {
    const id = randomUUID();
    const page: FakePage = { id, title, projects: [...projects], markdown: "", lastEditedTime: this.stamp(), inTrash: false, media: [] };
    Object.assign(page, this.settle(page, markdown, "update"));
    this.pages.set(id, page);
    return id;
  }

  /** Gives the database the "Links to" relation (to itself), as a typical notes database has. */
  addLinksTo(): void {
    this.schema.set(LINKS_TO, "relation");
  }

  /** Gives the database the multi-select "Tags" property. */
  addTags(): void {
    this.schema.set(TAGS, "multi_select");
  }

  /** The entries of a page's relation that Notion shows: those whose page is not in the trash or gone (live). */
  private shownLinks(page: FakePage): PageId[] {
    return (page.linksTo ?? []).filter((id) => this.pages.get(id)?.inTrash === false);
  }

  /** A project someone created in Notion. */
  addProject(title: string): PageId {
    const id = randomUUID();
    this.projectPages.set(id, { id, title, inTrash: false, template: "none" });
    return id;
  }

  /** The entries of a page's projects relation that Notion shows: those whose project is not in the trash (checked live). */
  private shownProjects(page: FakePage): PageId[] {
    return page.projects.filter((id) => this.projectPages.get(id)?.inTrash === false);
  }

  /** The projects a page shows, in order. */
  projectsOf(id: PageId): PageId[] {
    const page = this.pages.get(id);
    if (!page) throw new Error(`no page ${id}`);
    return this.shownProjects(page);
  }

  /** An edit someone made to a project in Notion. */
  editProject(id: PageId, change: { title?: string; inTrash?: boolean }): void {
    const project = this.projectPages.get(id);
    if (!project) throw new Error(`no project ${id}`);
    Object.assign(project, change);
  }

  /** The live projects, as `listProjects` shows them. */
  projectList(): ProjectMeta[] {
    return [...this.projectPages.values()].filter((p) => !p.inTrash).map(({ id, title }) => ({ id, title }));
  }

  /** An edit someone made in Notion. */
  edit(id: PageId, change: Partial<Pick<FakePage, "title" | "projects" | "markdown" | "inTrash" | "truncated" | "linksTo" | "tags">>): void {
    const page = this.live(id);
    Object.assign(page, change, { lastEditedTime: this.stamp() });
    if (change.markdown !== undefined) Object.assign(page, this.settle(page, change.markdown, "update"));
  }

  /**
   * Notion cuts the page at the lines `at` (0-based, of its markdown): each line and the more deeply indented lines after it
   * are left out, shown as a tag line, and listed in `unknown_block_ids` (probe 2026-11-06). The blocks starting at the
   * lines `unfetchable` can't be fetched (`object_not_found`). A line inside a left-out block is left out of that block's own answer.
   * The lines are those at the time of the call; set it after the markdown is final.
   */
  cut(id: PageId, at: number[], unfetchable: number[] = []): void {
    const page = this.live(id);
    const blocks = new Map(at.map((line) => [line, randomUUID()] as const));
    page.cut = { blocks, unfetchable: new Set(unfetchable.map((line) => blocks.get(line) ?? randomUUID())) };
  }

  /** Where the block starting at `lines[start]` ends (exclusive): after the more deeply indented lines that follow it. */
  private blockEnd(lines: string[], start: number): number {
    const depth = /^\t*/.exec(lines[start]!)![0].length;
    let end = start + 1;
    while (end < lines.length && lines[end] !== "" && /^\t*/.exec(lines[end]!)![0].length > depth) end++;
    return end;
  }

  /** The page (`root` null), or the block starting at line `root`, as Notion's markdown endpoint answers: left-out blocks as tag lines. */
  private view(page: FakePage, root: number | null): RawMarkdown {
    const lines = this.shown(page).split("\n");
    const cut = page.cut;
    if (!cut || (root === null && cut.blocks.size === 0)) return { markdown: lines.join("\n"), truncated: page.truncated ?? false, unknown_block_ids: [] };
    const indent = (line: string) => /^\t*/.exec(line)![0].length;
    const strip = root === null ? 0 : indent(lines[root]!);
    const end = root === null ? lines.length : this.blockEnd(lines, root);
    const shown: string[] = [];
    const ids: string[] = [];
    for (let k = root ?? 0; k < end; ) {
      const block = k === root ? undefined : cut.blocks.get(k);
      if (block === undefined) {
        shown.push(lines[k]!.slice(strip));
        k++;
        continue;
      }
      shown.push(`${"\t".repeat(indent(lines[k]!) - strip)}<unknown url="https://app.notion.com/p/${page.id.replace(/-/g, "")}#${block.replace(/-/g, "")}"/>`);
      ids.push(block);
      k = this.blockEnd(lines, k);
    }
    return { markdown: shown.join("\n"), truncated: ids.length > 0 || (root === null && (page.truncated ?? false)), unknown_block_ids: ids };
  }

  /** What the endpoint answers for a page, before any left-out block is fetched. */
  rawMarkdown(id: PageId): RawMarkdown {
    return this.view(this.live(id), null);
  }

  /** What the endpoint answers when asked with a left-out block's id: that block's subtree (itself cut where `cut` leaves nested blocks out). */
  blockMarkdown(blockId: string): RawMarkdown {
    const bare = blockId.replace(/-/g, "").toLowerCase();
    for (const page of this.pages.values()) {
      for (const [line, id] of page.cut?.blocks ?? []) {
        if (id.replace(/-/g, "") !== bare || page.inTrash || page.cut!.unfetchable.has(id)) continue;
        return this.view(page, line);
      }
    }
    throw new NotionPageError("object_not_found", `Could not find block with ID: ${blockId}.`);
  }

  private commit(page: FakePage, settled: { markdown: string; media: FakeMediaBlock[] }): void {
    Object.assign(page, settled, { lastEditedTime: this.stamp() });
  }

  /** The URL of a hosted file as Notion's markdown writes it, without the signature; `record` adds the block it belongs to. */
  private hostedUrl(key: string, record?: string): string {
    return `${FILE_HOST}/${WORKSPACE}/${key}/${encodeURIComponent(hostedName(this.files.get(key)!.name))}${record ? `#notion_record=block.${record}.${WORKSPACE}` : ""}`;
  }

  /**
   * `markdown` with its media lines settled as Notion settles them (spec §7 results 2 and 3 of the image design, §6 of the
   * attachments design), and the blocks they stand for. A hosted line of a file this page holds keeps that file's block
   * (`also`: files pasted just now), whatever its signature or record; one of another page's file becomes a block of its
   * kind with no URL; any other URL is an external block (in an `update` the page's own external block with that URL stays,
   * a `replace` makes new ones).
   */
  private settle(page: FakePage, markdown: string, mode: "update" | "replace", also: string[] = []): { markdown: string; media: FakeMediaBlock[] } {
    const lines = markdown.split("\n");
    const own = new Set([...page.media.flatMap((b) => (b.fileKey ? [b.fileKey] : [])), ...also]);
    const used = new Set<FakeMediaBlock>();
    const media: FakeMediaBlock[] = [];
    for (const k of mediaLineIndexes(lines)) {
      const { indent, kind, caption, url } = mediaLine(lines[k]!)!;
      const file = hostedFile(url);
      let block: FakeMediaBlock;
      if (file && own.has(file.key) && this.files.has(file.key)) {
        block = page.media.find((b) => !used.has(b) && b.kind === kind && b.fileKey === file.key) ?? { id: randomUUID(), kind, external: null, fileKey: file.key };
        lines[k] = mediaText(kind, indent, caption, this.hostedUrl(file.key, block.id));
      } else if (file) {
        // Another page's file becomes an empty block of its kind (image: live; pdf and file: live, attachments
        // probe-foreign.ts). Held for the URL as the sync sends it, signature and fragment stripped; Notion reads back a signed foreign
        // PDF line with its URL, which the fake does not model.
        block = { id: randomUUID(), kind, external: "", fileKey: null };
        lines[k] = mediaText(kind, indent, caption, "");
      } else {
        block = (mode === "update" ? page.media.find((b) => !used.has(b) && b.kind === kind && b.external === url) : undefined) ?? { id: randomUUID(), kind, external: url, fileKey: null };
      }
      used.add(block);
      media.push(block);
    }
    return { markdown: lines.join("\n"), media };
  }

  /** The page's markdown as a read gives it: each hosted file's URL carries a signature no other read has. */
  private shown(page: FakePage): string {
    const lines = page.markdown.split("\n");
    for (const k of mediaLineIndexes(lines)) lines[k] = lines[k]!.replace("#notion_record=", () => `?X-Amz-Signature=${++this.signatures}#notion_record=`);
    return lines.join("\n");
  }

  /** The file of a signed or bare hosted URL, or a refusal like the one a download gets. */
  private file(url: string): { name: string; bytes: Uint8Array } {
    const found = hostedFile(url);
    const file = found && this.files.get(found.key);
    if (!file) throw new NotionPageError("download_failed", "downloading the file answered 403");
    return file;
  }

  async listPages(): Promise<PageMeta[]> {
    this.calls.push("listPages");
    const relation = this.schema.get(LINKS_TO) === "relation";
    return [...this.pages.values()].filter((p) => !p.inTrash).map((page) => {
      const { id, title, lastEditedTime } = page;
      const folder = null;
      // The query lists the first 25 stored entries, then hides trashed ones, like "Links to" (below).
      const projects = this.projectsRelation === null ? {} : { projects: { ids: this.shownProjects({ ...page, projects: page.projects.slice(0, QUERY_RELATION_LIMIT) }), more: page.projects.length > QUERY_RELATION_LIMIT } };
      const tags = this.schema.get(TAGS) === "multi_select" ? { tags: [...(page.tags ?? [])] } : {};
      if (!relation) return { id, title, folder, lastEditedTime, ...projects, ...tags };
      // Notion takes the first 25 stored entries and then hides those whose page is trashed (probe-relation-20261103.txt,
      // check 4: 24 entries shown in the query, 29 in the property item), so a trashed target shortens the list.
      const stored = page.linksTo ?? [];
      const ids = this.shownLinks({ ...page, linksTo: stored.slice(0, QUERY_RELATION_LIMIT) });
      return { id, title, folder, lastEditedTime, ...projects, ...tags, linksTo: { ids, more: stored.length > QUERY_RELATION_LIMIT } };
    });
  }

  async getMarkdown(id: PageId) {
    this.calls.push(`getMarkdown ${id}`);
    return pieceTogether(this.rawMarkdown(id), async (blockId) => {
      this.calls.push(`getMarkdown block ${blockId}`);
      return this.blockMarkdown(blockId);
    });
  }

  async createPage(input: { title: string; projects?: PageId[] }): Promise<PageId> {
    this.calls.push(`createPage ${input.title}`);
    return this.add(input.title, "", input.projects ?? []);
  }

  async updateContent(id: PageId, edits: ContentEdit[]): Promise<string> {
    this.calls.push(`updateContent ${id}`);
    const page = this.live(id);
    let text = page.markdown;
    // Notion searches only the part of a cut page it loads (live probe: "No matches found" for text in a left-out block).
    const loaded = page.cut && page.cut.blocks.size > 0 ? this.view(page, null).markdown : null;
    for (const edit of edits) {
      if (edit.old_str === "") throw new NotionPageError("validation_error", "old_str is empty");
      if (loaded !== null) searchAndReplace(loaded, edit.old_str, edit.new_str, (id) => this.searchTitle(id));
      // Notion never finds a search text holding a hosted image or PDF line, whatever its signature (live, result 2; spec §6); a web URL's line is text.
      if (edit.old_str.split("\n").some(isUnsearchableMediaLine)) throw new NotionPageError("validation_error", `No matches found for ${edit.old_str}.`);
      text = searchAndReplace(text, edit.old_str, edit.new_str, (id) => this.searchTitle(id));
    }
    this.commit(page, this.settle(page, asNotionKeeps(inListItems(text), page.markdown), "update"));
    // A cut page answers an edit with the page as Notion cuts it (its `cut` lines are the ones from when it was set: edits must keep them valid).
    return page.cut ? this.view(page, null).markdown : this.shown(page);
  }

  /** The title Notion's search shows in a mention of `id`, or null where it leaves the mention self-closing. */
  searchTitle(id: PageId | null): string | null {
    const page = id === null ? undefined : this.pages.get(id);
    if (page && page.inTrash) {
      const form = this.trashedForms.get(page.id) ?? this.trashedMentions;
      return form === "titled" ? page.title : form === "neither" ? `\u0000${page.title}` : null;
    }
    if (page) return page.title;
    return id === null || this.restricted.has(id) ? null : (this.outside.get(id) ?? null);
  }

  async replaceContent(id: PageId, markdown: string): Promise<string> {
    this.calls.push(`replaceContent ${id}`);
    const page = this.live(id);
    this.commit(page, this.settle(page, asNotionKeeps(inListItems(markdown)), "replace"));
    return this.shown(page);
  }

  async setTitle(id: PageId, title: string): Promise<void> {
    this.calls.push(`setTitle ${id}`);
    this.edit(id, { title });
  }

  async trash(id: PageId): Promise<void> {
    this.calls.push(`trash ${id}`);
    this.edit(id, { inTrash: true });
  }

  async pageStatus(id: PageId): Promise<"live" | "trashed" | "gone"> {
    this.calls.push(`pageStatus ${id}`);
    const page = this.pages.get(id);
    return page === undefined ? "gone" : page.inTrash ? "trashed" : "live";
  }

  async properties(): Promise<Record<string, string>> {
    this.calls.push("properties");
    return Object.fromEntries(this.schema);
  }

  async readProjects(id: PageId): Promise<PageId[]> {
    this.calls.push(`readProjects ${id}`);
    return this.shownProjects(this.live(id));
  }

  /** Replaces the page's whole relation, like `setRelation`. */
  async setProjects(id: PageId, ids: PageId[]): Promise<void> {
    this.calls.push(`setProjects ${id}`);
    this.edit(id, { projects: [...ids] });
  }

  async projectsSource(): Promise<{ dataSourceId: string; titleProperty: string } | null> {
    this.calls.push("projectsSource");
    if (this.projectsRelation === null) return null;
    if (this.projectsUnreadable) throw new ProjectsUnreadable(`the connection can't read the database the "${this.projectsRelation}" relation points to`);
    return { dataSourceId: this.projectsDataSourceId, titleProperty: "Name" };
  }

  async listProjects(): Promise<ProjectMeta[]> {
    this.calls.push("listProjects");
    return this.projectList();
  }

  async createProject(title: string): Promise<PageId> {
    this.calls.push(`createProject ${title}`);
    const id = this.addProject(title);
    this.projectPages.get(id)!.template = this.defaultTemplate ? "default" : "none";
    return id;
  }

  async renameProject(id: PageId, title: string): Promise<void> {
    this.calls.push(`renameProject ${id}`);
    this.editProject(id, { title });
  }

  async relationTarget(): Promise<string | null> {
    this.calls.push("relationTarget");
    return this.schema.get(LINKS_TO) === "relation" ? this.dataSourceId : null;
  }

  async readRelation(id: PageId): Promise<PageId[]> {
    this.calls.push(`readRelation ${id}`);
    return this.shownLinks(this.live(id));
  }

  /** Replaces the page's relation. Only this page's edit time moves (the pages added keep theirs), and its markdown stays. */
  async setRelation(id: PageId, ids: PageId[]): Promise<void> {
    this.calls.push(`setRelation ${id}`);
    this.edit(id, { linksTo: [...ids] });
  }

  /** Replaces the page's tags. Only this page's edit time moves, and its markdown stays. */
  async setTags(id: PageId, names: string[]): Promise<void> {
    if (this.schema.get(TAGS) !== "multi_select") throw new Error("setTags: the database has no Tags property");
    this.calls.push(`setTags ${id}`);
    this.edit(id, { tags: [...names] });
  }

  /**
   * Notion refuses some content types at upload (live: `.3gp`, "The content type audio/3gpp is not supported for the File
   * Upload API", a `validation_error`). Which ones is not modelled; a test lists the ones to refuse.
   */
  readonly refusedTypes = new Set<string>();

  async uploadFile(name: string, bytes: Uint8Array): Promise<string> {
    this.calls.push(`uploadFile ${name}`);
    const type = contentType(name);
    if (this.refusedTypes.has(type)) throw new NotionPageError("validation_error", `The content type ${type} is not supported for the File Upload API`);
    const id = randomUUID();
    this.uploads.set(id, { name, bytes: Uint8Array.from(bytes), fileKey: null });
    return id;
  }

  /**
   * Time passing: every upload not attached yet expires (Notion takes an upload for an hour; live, one attached
   * 1 to 2.5 hours earlier still attached to new blocks fine, so an attached upload does not).
   */
  expireUploads(): void {
    for (const upload of this.uploads.values()) if (upload.fileKey === null) upload.expired = true;
  }

  async mediaBlocks(id: PageId): Promise<MediaBlock[]> {
    this.calls.push(`mediaBlocks ${id}`);
    const page = this.live(id);
    const lines = page.markdown.split("\n");
    return mediaLineIndexes(lines).map((k, n) => {
      const block = page.media[n]!;
      const caption = mediaLine(lines[k]!)!.caption.replace(/\\(.)/g, "$1");
      // The block API's file URL has no record fragment.
      const hosted = block.fileKey ? `${this.hostedUrl(block.fileKey)}?X-Amz-Signature=${++this.signatures}` : null;
      return { id: block.id, kind: block.kind, external: block.external, hosted, caption };
    });
  }

  /**
   * The block keeps its place and caption (the caption is its line's text); the upload gets its file on the first attach and the
   * same file in every block after. The API names the field after the block's type, so an upload goes to a block of that kind only.
   * Not checked here: the upload's own content type against the block's kind. A `file` block takes a png, a PDF or an mp3 upload (spec
   * §5.9) and an image block an avif here, but whether Notion does is recorded by the live tests "a file block takes a png, a PDF and an mp3
   * upload" and "an avif upload into an image block" in test/live/gateway.test.ts; if either shows a refusal, refuse the same pairing here.
   */
  async attachFile(blockId: string, kind: MediaKind, uploadId: string): Promise<void> {
    this.calls.push(`attachFile ${blockId}`);
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new NotionPageError("validation_error", `Could not find file upload with ID: ${uploadId}.`);
    if (upload.expired) throw new NotionPageError("validation_error", `File upload ${uploadId} has an invalid status of expired. Only uploaded files are expected.`);
    for (const page of this.pages.values()) {
      const n = page.media.findIndex((b) => b.id === blockId);
      if (n < 0 || page.inTrash) continue;
      const block = page.media[n]!;
      if (block.kind !== kind) throw new NotionPageError("validation_error", `Block ${blockId} is a ${block.kind} block, not a ${kind} block.`);
      upload.fileKey ??= randomUUID();
      if (!this.files.has(upload.fileKey)) this.files.set(upload.fileKey, { name: upload.name, bytes: upload.bytes });
      block.external = null;
      block.fileKey = upload.fileKey;
      const lines = page.markdown.split("\n");
      const k = mediaLineIndexes(lines)[n]!;
      const { indent, caption } = mediaLine(lines[k]!)!;
      lines[k] = mediaText(kind, indent, caption, this.hostedUrl(upload.fileKey, block.id));
      this.commit(page, { markdown: lines.join("\n"), media: page.media });
      return;
    }
    throw new NotionPageError("object_not_found", `Could not find block with ID: ${blockId}.`);
  }

  async download(url: string): Promise<Uint8Array> {
    this.calls.push("download");
    return Uint8Array.from(this.file(url).bytes);
  }

  async downloadTo(url: string, fullPath: string): Promise<{ sha256: string; size: number }> {
    this.calls.push("downloadTo");
    const { bytes } = this.file(url);
    const handle = await open(fullPath, "wx");
    try {
      await handle.writeFile(bytes);
    } catch (error) {
      await handle.close();
      await unlink(fullPath).catch(() => undefined);
      throw error;
    }
    await handle.close();
    return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  }

  /** A file the user pastes into the page in Notion (an image, PDF, audio, video or file block), on a line of its own after the first line equal to `afterLine`: a hosted file with the pasted file's name. */
  pasteFile(pageId: PageId, afterLine: string, kind: MediaKind, name: string, bytes: Uint8Array, caption = ""): void {
    const page = this.live(pageId);
    const lines = page.markdown.split("\n");
    const at = lines.indexOf(afterLine);
    if (at < 0) throw new Error(`the page has no line ${JSON.stringify(afterLine)}`);
    const key = randomUUID();
    this.files.set(key, { name, bytes: Uint8Array.from(bytes) });
    lines.splice(at + 1, 0, mediaText(kind, "", caption, this.hostedUrl(key)));
    this.commit(page, this.settle(page, lines.join("\n"), "update", [key]));
  }

  /** An image the user pastes into the page in Notion (`pasteFile` of an image). */
  pasteImage(pageId: PageId, afterLine: string, name: string, bytes: Uint8Array, caption = ""): void {
    this.pasteFile(pageId, afterLine, "image", name, bytes, caption);
  }

  async mentionTargets(ids: PageId[]): Promise<Map<PageId, MentionTarget>> {
    this.calls.push(`mentionTargets ${ids.length}`);
    const targets = new Map<PageId, MentionTarget>();
    for (const id of ids) {
      const page = this.pages.get(id);
      if (page) targets.set(id, { title: page.title, trashed: page.inTrash });
      else if (this.outside.has(id) && !this.restricted.has(id)) targets.set(id, { title: this.outside.get(id)!, trashed: false });
      else if (!this.restricted.has(id)) targets.set(id, null);
    }
    return targets;
  }

  async pageTitles(ids: PageId[]): Promise<Map<PageId, string>> {
    this.calls.push(`pageTitles ${ids.length}`);
    return new Map(ids.flatMap((id) => (this.outside.has(id) && !this.restricted.has(id) ? [[id, this.outside.get(id)!] as const] : [])));
  }
}
