// Everything the sync needs from Notion, behind one small interface.
import { APIResponseError, Client, LogLevel, collectPaginatedAPI, isFullPage, isHTTPResponseError } from "@notionhq/client";
import type { ContentEdit, PageId, PageMeta, ProjectMeta } from "../types.ts";
import type { PageIcon } from "../config.ts";
import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { contentType, type MediaKind } from "./hosted.ts";
import { normalizeId } from "./ids.ts";
import type { MentionTarget } from "./search.ts";

export const NOTION_VERSION = "2026-03-11";

/**
 * An image, PDF, audio, video or file block of a page: `external` is its URL when it points elsewhere, `hosted` the Notion-hosted file's
 * URL as Notion gives it (signed, so it expires).
 */
export interface MediaBlock {
  id: string;
  kind: MediaKind;
  external: string | null;
  hosted: string | null;
  caption: string;
}

export interface NotionGateway {
  listPages(): Promise<PageMeta[]>;
  /**
   * The page as markdown. Notion cuts a page at about 20,000 blocks; a cut page is completed by fetching each left-out block
   * (`pieced: true`, `truncated: false`, `loaded` the markdown as Notion first gave it, with the tag lines: the part of the page it loads
   * for editing). `truncated: true` (no `pieced`) when it couldn't be completed. No `pieced` key for a page that wasn't cut.
   */
  getMarkdown(id: PageId): Promise<{ markdown: string; truncated: boolean; pieced?: true; loaded?: string }>;
  /** Creates an empty page in the database, with the profile's page icon if it has one and the projects given, and returns its id. */
  createPage(input: { title: string; projects?: PageId[] }): Promise<PageId>;
  /** Applies search-and-replace edits and returns the page's markdown afterwards. */
  updateContent(id: PageId, edits: ContentEdit[]): Promise<string>;
  /** Replaces the whole page content and returns the page's markdown afterwards. */
  replaceContent(id: PageId, markdown: string): Promise<string>;
  /** Renames a page. */
  setTitle(id: PageId, title: string): Promise<void>;
  trash(id: PageId): Promise<void>;
  /** Whether a page is still there, in the trash, or gone; a page the connection can't read throws NotionPageError. */
  pageStatus(id: PageId): Promise<"live" | "trashed" | "gone">;
  /** The database's properties: name -> type (`title`, `select`, …). */
  properties(): Promise<Record<string, string>>;
  /** Every entry of a page's projects relation (the query lists only 25), in order. */
  readProjects(id: PageId): Promise<PageId[]>;
  /** Replaces a page's whole projects relation. */
  setProjects(id: PageId, ids: PageId[]): Promise<void>;
  /**
   * The projects database (its data source and title property), or null when the profile has no projects relation. Throws
   * `ProjectsUnreadable` when the relation is missing, is not a relation, or its target can't be read.
   */
  projectsSource(): Promise<{ dataSourceId: string; titleProperty: string } | null>;
  /** The live pages of the projects database (trashed ones are not listed). */
  listProjects(): Promise<ProjectMeta[]>;
  /** Creates a project from the projects database's default template if it has one, else blank; never tried again. */
  createProject(title: string): Promise<PageId>;
  /** Renames a project. */
  renameProject(id: PageId, title: string): Promise<void>;
  /** Titles of pages outside the database (for mentions); pages the connection can't read are left out. */
  pageTitles(ids: PageId[]): Promise<Map<PageId, string>>;
  /**
   * What Notion knows of each mentioned page, to search for a line that mentions it: its current title and whether
   * it is in the trash, or null for a page Notion can't find. A page the connection may not read is left out.
   */
  mentionTargets(ids: PageId[]): Promise<Map<PageId, MentionTarget>>;
  /** The data source the "Links to" relation points to (dashed id); null if the database has no such relation. */
  relationTarget(): Promise<string | null>;
  /** Every entry of a page's "Links to" relation (the query lists only 25), in order. */
  readRelation(id: PageId): Promise<PageId[]>;
  /** Replaces a page's whole "Links to" relation. */
  setRelation(id: PageId, ids: PageId[]): Promise<void>;
  /** Replaces a page's tags (the multi-select property) with these names; Notion creates the options that are missing. */
  setTags(id: PageId, names: string[]): Promise<void>;
  /** Uploads a file in one request, with the content type of its extension, and returns the upload's id; an upload not attached within an hour expires. */
  uploadFile(name: string, bytes: Uint8Array): Promise<string>;
  /** Every image, PDF, audio, video and file block of a page in document order, those inside list items too. */
  mediaBlocks(id: PageId): Promise<MediaBlock[]>;
  /** Makes a block of that kind show an upload (one upload can go in many blocks); the block keeps its id, place and caption. */
  attachFile(blockId: string, kind: MediaKind, uploadId: string): Promise<void>;
  /** The bytes behind a signed file URL; a refusal (an expired signature) is a NotionPageError with code `download_failed`. For small files: `downloadTo` for any other. */
  download(url: string): Promise<Uint8Array>;
  /**
   * Streams the file behind a signed URL to `fullPath`, which must not exist (the error is Node's `EEXIST`, and that file stays), and
   * gives the SHA-256 (hex) and size of what was written. A refusal is a `download_failed` NotionPageError; a download that breaks
   * halfway leaves no file.
   */
  downloadTo(url: string, fullPath: string): Promise<{ sha256: string; size: number }>;
}

/** What Notion's markdown endpoint answers for a page or for a block's id. */
export interface RawMarkdown {
  markdown: string;
  truncated: boolean;
  unknown_block_ids: string[];
}

/** How many levels of left-out blocks are fetched: a block fetched at the fourth level that is itself cut is given up on. */
const PIECE_DEPTH = 3;

/**
 * Completes a page Notion cut: every id in `unknown_block_ids` has its own line `<unknown url="…#<id without hyphens>"/>` at the block's
 * place and indentation (tabs); `fetch` gives that block's markdown, which replaces the line, each line indented like it. A fetched block that
 * is cut is completed the same way. Tags of blocks Notion doesn't list (ones markdown can't express) stay. Gives up (`truncated: true`, the
 * markdown as Notion gave it) if an id has no tag line, a block can't be fetched, or the cut lies deeper than three levels.
 */
export async function pieceTogether(raw: RawMarkdown, fetch: (blockId: string) => Promise<RawMarkdown>): Promise<{ markdown: string; truncated: boolean; pieced?: true; loaded?: string }> {
  if (!raw.truncated) return { markdown: raw.markdown, truncated: false };
  // Only a page-level refusal or a cut that can't be completed gives up; a failure that should end the run (a bad token, a lost connection, an outage) is thrown.
  const whole = await complete(raw, fetch, 1).catch((error: unknown) => {
    if (error instanceof NotionPageError || error instanceof CutGaveUp) return null;
    throw error;
  });
  return whole === null ? { markdown: raw.markdown, truncated: true } : { markdown: whole, truncated: false, pieced: true, loaded: raw.markdown };
}

/** A cut that can't be completed (an id with no tag line, no ids listed, too deep). */
class CutGaveUp extends Error {}

async function complete(raw: RawMarkdown, fetch: (blockId: string) => Promise<RawMarkdown>, level: number): Promise<string> {
  if (!raw.truncated) return raw.markdown;
  if (raw.unknown_block_ids.length === 0) throw new CutGaveUp("cut with no left-out blocks listed");
  if (level > PIECE_DEPTH) throw new CutGaveUp("the cut is too deep");
  const lines = raw.markdown.split("\n");
  for (const id of raw.unknown_block_ids) {
    const bare = id.replace(/-/g, "").toLowerCase();
    const at = lines.findIndex((line) => {
      const found = /^\t*<unknown url="[^"]*#([0-9a-fA-F]+)"\/>$/.exec(line);
      return found !== null && found[1]!.toLowerCase() === bare;
    });
    if (at < 0) throw new CutGaveUp(`no tag line for ${id}`);
    const indent = /^\t*/.exec(lines[at]!)![0];
    const block = await fetch(id);
    const text = await complete(block, fetch, level + 1);
    lines.splice(at, 1, ...text.split("\n").map((line) => (line === "" ? line : indent + line)));
  }
  return lines.join("\n");
}

/** A request Notion refused for this page only (the run can go on with other notes). */
export class NotionPageError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NotionPageError";
    this.code = code;
  }
}

/** The projects database can't be used: the relation is missing, is not a relation, or the connection can't read its target. */
export class ProjectsUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectsUnreadable";
  }
}

const PAGE_LEVEL = new Set(["validation_error", "object_not_found", "conflict_error", "restricted_resource"]);
/** Refusals that mean "this page can't be read"; anything else (a bad token, an outage) stops the run. */
const UNREADABLE = new Set(["object_not_found", "restricted_resource"]);

/** Notion's answer to a page lookup of a block id (a link-preview's `#fragment` is stored as a mention of the block): not a page we can read. */
function isBlockNotPage(error: unknown): boolean {
  return error instanceof APIResponseError && error.code === "validation_error" && /is a block, not a page/i.test(error.message);
}

async function guard<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof APIResponseError && PAGE_LEVEL.has(error.code)) throw new NotionPageError(error.code, error.message);
    throw error;
  }
}

/** Statuses of a passing failure in Notion or its edge proxy (bad gateway, unavailable, gateway timeout). */
const TRANSIENT = new Set([502, 503, 504]);
/** How long to wait before each new try after a passing failure; the SDK itself handles rate limits (429). */
const RETRY_DELAYS_MS = [1000, 2000, 4000];

/**
 * `call`, tried again after a 502, 503 or 504, waiting longer each time; the last failure ends the run as before.
 * Only for requests that give the same result when repeated: one Notion carried out before its answer was lost is
 * then carried out again harmlessly.
 */
export async function retrying<T>(call: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length || !isHTTPResponseError(error) || !TRANSIENT.has(error.status)) throw error;
      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }
}

/** The block types `mediaBlocks` lists. */
const MEDIA_KINDS: ReadonlySet<string> = new Set<MediaKind>(["image", "pdf", "audio", "video", "file"]);

/** What an image, PDF, audio, video or file block holds under its type's name. */
type MediaBody = { caption?: { plain_text: string }[] } & ({ type: "external"; external: { url: string } } | { type: "file"; file: { url: string } });

type ClientOptions = NonNullable<ConstructorParameters<typeof Client>[0]>;

export interface SdkGatewayOptions {
  token: string;
  dataSourceId: string;
  titleProperty: string;
  /** The relation property that holds a note's projects; unset, the project methods act as if the profile had none. */
  projectsRelation?: string | null;
  /** The icon new pages get; unset or null, they get none. */
  pageIcon?: PageIcon | null;
  /** The relation property that lists the pages a page links to; unset, the relation methods act as if it were missing. */
  linksToProperty?: string;
  /** The multi-select property that holds a page's tags; unset, pages list no tags and `setTags` refuses. */
  tagsProperty?: string;
  /** Replaces the HTTP client (and the one that downloads files); tests use it to answer without the network. */
  fetch?: ClientOptions["fetch"];
  /** Waits between tries after a passing failure; tests replace it. */
  sleep?: (ms: number) => Promise<void>;
}

export function createSdkGateway(options: SdkGatewayOptions): NotionGateway {
  const client = new Client({
    auth: options.token,
    notionVersion: NOTION_VERSION,
    logLevel: LogLevel.ERROR,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  // The same HTTP client as the API calls (tests replace it); what it answers is a full `Response`, whatever the SDK's type says.
  const fetchFile = (options.fetch ?? fetch) as unknown as typeof fetch;
  const { dataSourceId, titleProperty, linksToProperty, tagsProperty, projectsRelation } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /** A request that gives the same result when repeated, tried again after a passing failure. */
  const again = <T>(call: () => Promise<T>) => retrying(call, sleep);
  const titleOf = (name: string, title: string) => ({ [name]: { title: [{ type: "text" as const, text: { content: title } }] } });
  const relationOf = (ids: PageId[]) => ({ relation: ids.map((id) => ({ id })) });

  /** The relation property in the data source (kept after the first read), or null if there is none. */
  let relationProperty: { id: string; target: string | null } | null | undefined;
  async function relationInfo() {
    if (relationProperty !== undefined) return relationProperty;
    if (linksToProperty === undefined) return (relationProperty = null);
    const source = await again(() => client.dataSources.retrieve({ data_source_id: dataSourceId }));
    const property = source.properties[linksToProperty];
    return (relationProperty = property?.type === "relation" ? { id: property.id, target: normalizeId(property.relation.data_source_id) } : null);
  }

  /** The projects relation and its target (kept after the first read), or null without `projectsRelation`. */
  let projectsInfo: { id: string; source: { dataSourceId: string; titleProperty: string } } | null | undefined;
  async function projectsLookup() {
    if (projectsInfo !== undefined) return projectsInfo;
    if (projectsRelation == null) return (projectsInfo = null);
    const connect = "connect the nopipeline connection to the projects database in Notion (the page's ••• menu, Connections)";
    const source = await again(() => client.dataSources.retrieve({ data_source_id: dataSourceId }));
    const property = source.properties[projectsRelation];
    // A relation whose target the connection can't read is missing from the properties altogether (checked live).
    if (property === undefined) throw new ProjectsUnreadable(`the database has no "${projectsRelation}" relation the connection can read: rename it back in Notion, set "projectsRelation" in the profile's config file, or ${connect}`);
    if (property.type !== "relation") throw new ProjectsUnreadable(`the database's "${projectsRelation}" property is a ${property.type}, not a relation: change it back to a relation to the projects database in Notion, or set "projectsRelation" in the profile's config file`);
    const target = normalizeId(property.relation.data_source_id)!;
    let titleProperty: string | undefined;
    try {
      const projects = await again(() => client.dataSources.retrieve({ data_source_id: target }));
      titleProperty = Object.entries(projects.properties).find(([, p]) => p.type === "title")?.[0];
    } catch (error) {
      if (!(error instanceof APIResponseError && UNREADABLE.has(error.code))) throw error;
    }
    if (titleProperty === undefined) throw new ProjectsUnreadable(`the connection can't read the database the "${projectsRelation}" relation points to: ${connect}`);
    return (projectsInfo = { id: property.id, source: { dataSourceId: target, titleProperty } });
  }

  async function pageStatus(id: PageId): Promise<"live" | "trashed" | "gone"> {
    try {
      const page = await again(() => client.pages.retrieve({ page_id: id }));
      return isFullPage(page) && page.in_trash ? "trashed" : "live";
    } catch (error) {
      if (error instanceof APIResponseError && error.code === "object_not_found") return "gone";
      if (error instanceof APIResponseError && PAGE_LEVEL.has(error.code)) throw new NotionPageError(error.code, error.message);
      throw error;
    }
  }

  return {
    async listPages() {
      const query = (args: Parameters<typeof client.dataSources.query>[0]) => again(() => client.dataSources.query(args));
      const rows = await collectPaginatedAPI(query, { data_source_id: dataSourceId, page_size: 100 });
      return rows.filter(isFullPage).filter((page) => !page.in_trash).map((page) => {
        const title = page.properties[titleProperty];
        const projects = projectsRelation == null ? undefined : page.properties[projectsRelation];
        const links = linksToProperty === undefined ? undefined : page.properties[linksToProperty];
        const tags = tagsProperty === undefined ? undefined : page.properties[tagsProperty];
        return {
          id: normalizeId(page.id)!,
          title: title?.type === "title" ? title.title.map((t) => t.plain_text).join("") : "",
          folder: null,
          lastEditedTime: page.last_edited_time,
          ...(projects?.type === "relation" ? { projects: { ids: projects.relation.map((entry) => normalizeId(entry.id)!), more: (projects as { has_more?: boolean }).has_more === true } } : {}),
          ...(tags?.type === "multi_select" ? { tags: tags.multi_select.map((option) => option.name) } : {}),
          ...(links?.type === "relation" ? { linksTo: { ids: links.relation.map((entry) => normalizeId(entry.id)!), more: (links as { has_more?: boolean }).has_more === true } } : {}),
        };
      });
    },
    async getMarkdown(id) {
      const read = async (pageId: string): Promise<RawMarkdown> => {
        const page = await guard(() => again(() => client.pages.retrieveMarkdown({ page_id: pageId })));
        return { markdown: page.markdown, truncated: page.truncated, unknown_block_ids: page.unknown_block_ids };
      };
      return pieceTogether(await read(id), read);
    },
    // Not tried again: a page Notion created before its answer was lost would be created twice.
    async createPage(input) {
      if (input.projects?.length && projectsRelation == null) throw new Error('the profile has no "projectsRelation", so a page can\'t be given a project');
      const projects = input.projects?.length && projectsRelation != null ? { [projectsRelation]: relationOf(input.projects) } : {};
      const page = await guard(() =>
        client.pages.create({ parent: { data_source_id: dataSourceId }, properties: { ...titleOf(titleProperty, input.title), ...projects }, ...(options.pageIcon ? { icon: options.pageIcon as NonNullable<Parameters<typeof client.pages.create>[0]["icon"]> } : {}), template: { type: "none" } }),
      );
      return normalizeId(page.id)!;
    },
    // Not tried again: an edit Notion applied before its answer was lost could apply twice (one that adds a line
    // after its search text matches again).
    async updateContent(id, edits) {
      const page = await guard(() => client.pages.updateMarkdown({ page_id: id, type: "update_content", update_content: { content_updates: edits } }));
      return page.markdown;
    },
    async replaceContent(id, markdown) {
      const page = await guard(() => again(() => client.pages.updateMarkdown({ page_id: id, type: "replace_content", replace_content: { new_str: markdown } })));
      return page.markdown;
    },
    async setTitle(id, title) {
      await guard(() => again(() => client.pages.update({ page_id: id, properties: titleOf(titleProperty, title) })));
    },
    async trash(id) {
      try {
        await guard(() => again(() => client.pages.update({ page_id: id, in_trash: true })));
      } catch (error) {
        // Notion refuses to trash a page already in the trash (live probe): a try whose answer was lost and
        // was tried again, or a page trashed meanwhile. Done either way, once Notion says it is in the trash.
        if (!(error instanceof NotionPageError && error.code === "validation_error")) throw error;
        if ((await pageStatus(id)) !== "trashed") throw error;
      }
    },
    pageStatus,
    async properties() {
      const source = await again(() => client.dataSources.retrieve({ data_source_id: dataSourceId }));
      return Object.fromEntries(Object.entries(source.properties).map(([name, property]) => [name, property.type]));
    },
    async projectsSource() {
      return (await projectsLookup())?.source ?? null;
    },
    async readProjects(id) {
      const info = await projectsLookup();
      if (!info) throw new Error('the profile has no "projectsRelation"');
      const ids: PageId[] = [];
      for (let cursor: string | undefined; ; ) {
        const from = cursor;
        const result = await guard(() => again(() => client.pages.properties.retrieve({ page_id: id, property_id: info.id, ...(from ? { start_cursor: from } : {}) })));
        if (!("results" in result)) throw new Error(`Notion answered the "${projectsRelation}" property with a single item, not a list`);
        for (const item of result.results) if (item.type === "relation") ids.push(normalizeId(item.relation.id)!);
        if (!result.has_more || !result.next_cursor) return ids;
        cursor = result.next_cursor;
      }
    },
    async setProjects(id, ids) {
      if (projectsRelation == null) throw new Error('the profile has no "projectsRelation"');
      await guard(() => again(() => client.pages.update({ page_id: id, properties: { [projectsRelation]: relationOf(ids) } })));
    },
    async listProjects() {
      const info = await projectsLookup();
      if (!info) throw new Error('the profile has no "projectsRelation"');
      const query = (args: Parameters<typeof client.dataSources.query>[0]) => again(() => client.dataSources.query(args));
      const rows = await collectPaginatedAPI(query, { data_source_id: info.source.dataSourceId, page_size: 100 });
      return rows.filter(isFullPage).filter((page) => !page.in_trash).map((page) => {
        const title = page.properties[info.source.titleProperty];
        return { id: normalizeId(page.id)!, title: title?.type === "title" ? title.title.map((t) => t.plain_text).join("") : "" };
      });
    },
    // Not tried again, like createPage. The default template is asked for only when the database lists one: Notion refuses
    // it otherwise (checked live); it is applied a few seconds later, and the page is blank until then.
    async createProject(title) {
      const info = await projectsLookup();
      if (!info) throw new Error('the profile has no "projectsRelation"');
      const { dataSourceId: target, titleProperty: name } = info.source;
      let hasDefault = false;
      for (let cursor: string | undefined; ; ) {
        const from = cursor;
        const list = await again(() => client.dataSources.listTemplates({ data_source_id: target, ...(from ? { start_cursor: from } : {}) }));
        if (list.templates.some((t) => t.is_default)) hasDefault = true;
        if (hasDefault || !list.has_more || !list.next_cursor) break;
        cursor = list.next_cursor;
      }
      const page = await guard(() => client.pages.create({ parent: { data_source_id: target }, properties: titleOf(name, title), template: { type: hasDefault ? "default" : "none" } }));
      return normalizeId(page.id)!;
    },
    async renameProject(id, title) {
      const info = await projectsLookup();
      if (!info) throw new Error('the profile has no "projectsRelation"');
      await guard(() => again(() => client.pages.update({ page_id: id, properties: titleOf(info.source.titleProperty, title) })));
    },
    async relationTarget() {
      return (await relationInfo())?.target ?? null;
    },
    async readRelation(id) {
      const property = await relationInfo();
      if (!property) throw new Error(`the database has no "${linksToProperty}" relation`);
      const ids: PageId[] = [];
      for (let cursor: string | undefined; ; ) {
        const from = cursor;
        const result = await guard(() => again(() => client.pages.properties.retrieve({ page_id: id, property_id: property.id, ...(from ? { start_cursor: from } : {}) })));
        // The property item of a relation is always a list; Notion's types also allow a single item.
        if (!("results" in result)) throw new Error(`Notion answered the "${linksToProperty}" property with a single item, not a list`);
        for (const item of result.results) if (item.type === "relation") ids.push(normalizeId(item.relation.id)!);
        if (!result.has_more || !result.next_cursor) return ids;
        cursor = result.next_cursor;
      }
    },
    async setRelation(id, ids) {
      if (linksToProperty === undefined) throw new Error("no relation property is configured");
      await guard(() => again(() => client.pages.update({ page_id: id, properties: { [linksToProperty]: { relation: ids.map((id) => ({ id })) } } })));
    },
    async setTags(id, names) {
      if (tagsProperty === undefined) throw new Error("no tags property is configured");
      await guard(() => again(() => client.pages.update({ page_id: id, properties: { [tagsProperty]: { multi_select: names.map((name) => ({ name })) } } })));
    },
    async uploadFile(name, bytes) {
      const type = contentType(name);
      // Tried again like any request: a lost answer to the create leaves an upload that expires unused.
      return guard(() =>
        again(async () => {
          const upload = await client.fileUploads.create({ mode: "single_part", filename: name, content_type: type });
          await client.fileUploads.send({ file_upload_id: upload.id, file: { filename: name, data: new Blob([new Uint8Array(bytes)], { type }) } });
          return upload.id;
        }),
      );
    },
    async mediaBlocks(id) {
      const found: MediaBlock[] = [];
      // Depth first, so the blocks come in the order the page shows them.
      const walk = async (blockId: string): Promise<void> => {
        const list = (args: Parameters<typeof client.blocks.children.list>[0]) => again(() => client.blocks.children.list(args));
        for (const block of await guard(() => collectPaginatedAPI(list, { block_id: blockId, page_size: 100 }))) {
          if (!("type" in block)) continue;
          if (MEDIA_KINDS.has(block.type)) {
            // Every one of these has the same body under its own type's name: `external` or `file` (`name` too, in a file block), and a caption.
            const media = (block as unknown as Record<string, MediaBody>)[block.type]!;
            found.push({
              id: block.id,
              kind: block.type as MediaKind,
              external: media.type === "external" ? media.external.url : null,
              hosted: media.type === "file" ? media.file.url : null,
              caption: (media.caption ?? []).map((t) => t.plain_text).join(""),
            });
          }
          // A child page or database is not this page's content (its blocks are its own), and listing one may be refused.
          if (block.has_children && block.type !== "child_page" && block.type !== "child_database") await walk(block.id);
        }
      };
      await walk(id);
      return found;
    },
    // Only the upload: a `caption` here would replace the one the markdown gave the block (checked live).
    async attachFile(blockId, kind, uploadId) {
      await guard(() => again(() => client.blocks.update({ block_id: blockId, [kind]: { file_upload: { id: uploadId } } } as Parameters<typeof client.blocks.update>[0])));
    },
    async download(url) {
      // No Authorization: the signature in the URL is the credential, and Notion's token must not go to S3.
      const response = await fetchFile(url);
      if (!response.ok) throw new NotionPageError("download_failed", `downloading the file answered ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async downloadTo(url, fullPath) {
      const response = await fetchFile(url);
      if (!response.ok) throw new NotionPageError("download_failed", `downloading the file answered ${response.status}`);
      // `wx` fails on a file that exists, before anything is written, and the cleanup below then only follows a file this call made.
      const handle = await open(fullPath, "wx");
      const hash = createHash("sha256");
      let size = 0;
      try {
        const body = response.body ? Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]) : Readable.from([]);
        await pipeline(
          body,
          async function* (chunks: AsyncIterable<Buffer>) {
            for await (const chunk of chunks) {
              hash.update(chunk);
              size += chunk.length;
              yield chunk;
            }
          },
          handle.createWriteStream(),
        );
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(fullPath).catch(() => undefined);
        throw error;
      }
      return { sha256: hash.digest("hex"), size };
    },
    async mentionTargets(ids) {
      const targets = new Map<PageId, MentionTarget>();
      for (const id of ids) {
        try {
          const page = await again(() => client.pages.retrieve({ page_id: id }));
          if (!isFullPage(page)) continue;
          const title = Object.values(page.properties).find((p) => p.type === "title");
          targets.set(id, { title: title?.type === "title" ? title.title.map((t) => t.plain_text).join("") : "", trashed: page.in_trash === true });
        } catch (error) {
          if (error instanceof APIResponseError && error.code === "object_not_found") targets.set(id, null);
          else if (!(error instanceof APIResponseError && PAGE_LEVEL.has(error.code))) throw error;
        }
      }
      return targets;
    },
    async pageTitles(ids) {
      const titles = new Map<PageId, string>();
      for (const id of ids) {
        try {
          const page = await again(() => client.pages.retrieve({ page_id: id }));
          if (!isFullPage(page)) continue;
          const title = Object.values(page.properties).find((p) => p.type === "title");
          if (title?.type === "title") titles.set(id, title.title.map((t) => t.plain_text).join(""));
        } catch (error) {
          if (!(error instanceof APIResponseError && UNREADABLE.has(error.code)) && !isBlockNotPage(error)) throw error;
        }
      }
      return titles;
    },
  };
}
