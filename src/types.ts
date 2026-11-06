// Shared data shapes. Page ids are always dashed lowercase UUIDs.

export type PageId = string;

/** A note found in the vault. `path` is vault-relative with forward slashes. */
export interface VaultNote {
  path: string;
  text: string;
  body: string;
  notionId: PageId | null;
  notionTitle: string | null;
}

/** One row of the Notion database, as listed (no content). */
export interface PageMeta {
  id: PageId;
  title: string;
  /** The vault folder the page belongs in; set by the resolver (`src/plan/projects.ts`), always null from the gateway. */
  folder: string | null;
  lastEditedTime: string;
  /** The page's projects relation as the database query lists it (at most 25 entries; `more` when it has others); absent when the profile has no projects relation. */
  projects?: { ids: PageId[]; more: boolean };
  /** The page's "Links to" relation as the database query lists it (at most 25 entries; `more` when it has others). */
  linksTo?: { ids: PageId[]; more: boolean };
  /** The names of the page's tags (its multi-select property); present only when tags are on. */
  tags?: string[];
}

/** A page of the projects database. */
export interface ProjectMeta {
  id: PageId;
  title: string;
}

/** What both sides looked like the last time a note was synced. */
export interface SyncRecord {
  notionId: PageId;
  path: string;
  title: string;
  folder: string | null;
  /**
   * The note was deliberately left in the default folder or the root while its page keeps several projects in Notion (spec §3 B3):
   * while the note stays there and the page has a project, nothing is filed or moved for it, whatever Notion does to the projects.
   */
  keptOut?: true;
  /** The page's first project when the note was last synced: undefined = never synced with projects, null = synced with no project. */
  project?: PageId | null;
  obsidianText: string;
  notionMarkdown: string;
  notionSeenAt: string;
  syncedAt: string;
  /**
   * Vault paths other notes' links may already use for this page: the names a rename from Notion was
   * rewriting links to when a run stopped before moving the note. Cleared once the note has moved.
   */
  aliases?: string[];
  /**
   * The titles that rename gave the text of links it rewrote (a link reading the old title reads the new one), so
   * those links follow the note again when the rename ends another way. Cleared with `aliases`.
   */
  aliasTitles?: string[];
  /**
   * The "Links to" entries the sync added to the page (the rest of the relation is the user's). Written only by the
   * pass after the run; a record without it has not had that pass yet.
   */
  linksTo?: PageId[];
  /** The tags both sides held when they last agreed; absent: never synced with tags. */
  tags?: string[];
}

/** One `update_content` replacement. */
export interface ContentEdit {
  old_str: string;
  new_str: string;
}
