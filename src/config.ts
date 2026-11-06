// Profile configuration and the Notion token.
import { link, readFile, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { flush, makeFolders, writeFlushed } from "./durable.ts";
import { normalizeId } from "./notion/ids.ts";
import { usableFolder } from "./vault/filenames.ts";

/** A page icon as the Notion API takes it: a native icon (name and color) or an emoji. */
export type PageIcon = { type: "icon"; icon: { name: string; color: string } } | { type: "emoji"; emoji: string };

/** Where the status note goes unless the profile says otherwise. */
export const DEFAULT_STATUS_NOTE = "nopipeline status.md";

export interface Config {
  profile: string;
  vaultPath: string;
  vaultName: string;
  dataSourceId: string;
  titleProperty: string;
  /** The relation from a note to the notes it links to; null: turned off. */
  linksToProperty: string | null;
  /** The multi-select property that mirrors a note's frontmatter tags; null: turned off. Absent counts as off. */
  tagsProperty?: string | null;
  /** The relation property that holds a note's project; null: no folder mapping. */
  projectsRelation: string | null;
  /** The icon new pages get; null: none. */
  pageIcon: PageIcon | null;
  /** Old profile keys that are accepted and ignored (today only "folderProperty"). */
  ignoredKeys: string[];
  inboxFolder: string;
  massTrashLimit: number;
  tokenFile: string | null;
  /** The vault note the tool writes its status into (vault-relative); null: off. Absent counts as off. */
  statusNote?: string | null;
  /** Hours between automatic runs (`sync --auto`); loadConfig always sets it. */
  autoSyncHours?: number;
  stateDir: string;
}

type Env = Record<string, string | undefined>;

const expand = (path: string) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);
/** What a profile file's name (without .json) may look like. */
export const PROFILE_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u;
const IGNORED = ["folderProperty"];
const KNOWN = ["vaultPath", "vaultName", "dataSourceId", "titleProperty", "linksToProperty", "tagsProperty", "projectsRelation", "pageIcon", "inboxFolder", "massTrashLimit", "tokenFile", "statusNote", "autoSyncHours"];

export function defaultConfigPath(env: Env = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "nopipeline", "config.json");
}

export async function loadConfig(path: string, env: Env = process.env): Promise<Config> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`can't read the config file ${path}: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path}: must hold a JSON object`);
  const unknown = Object.keys(raw).filter((key) => !KNOWN.includes(key) && !IGNORED.includes(key));
  if (unknown.length) throw new Error(`${path}: unknown setting ${unknown.map((key) => `"${key}"`).join(", ")} (known: ${KNOWN.join(", ")})`);
  const text = (key: string, fallback?: string): string => {
    const value = raw[key] ?? fallback;
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${path}: "${key}" must be a non-empty string`);
    return value;
  };
  const absolute = (key: string): string => {
    const full = expand(text(key));
    if (!isAbsolute(full)) throw new Error(`${path}: "${key}" must be an absolute path or start with ~/`);
    return resolve(full);
  };
  const vaultPath = absolute("vaultPath");
  const dataSourceId = normalizeId(text("dataSourceId"));
  if (!dataSourceId) throw new Error(`${path}: "dataSourceId" is not a Notion id`);
  const limit = raw.massTrashLimit ?? 10;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) throw new Error(`${path}: "massTrashLimit" must be a whole number`);
  const inboxFolder = text("inboxFolder", "0-In");
  if (!usableFolder(inboxFolder)) throw new Error(`${path}: "inboxFolder" must be a folder inside the vault, like "0-In" or "Inbox/Notion" (no "..", no names starting with ".", none of \\ : * ? " < > | # ^ [ ])`);
  const autoSyncHours = "autoSyncHours" in raw ? raw.autoSyncHours : 6;
  if (typeof autoSyncHours !== "number" || !Number.isFinite(autoSyncHours) || autoSyncHours <= 0) throw new Error(`${path}: "autoSyncHours" must be a number of hours above 0, like 6 or 0.5`);
  const statusNote = raw.statusNote === null ? null : raw.statusNote === undefined ? DEFAULT_STATUS_NOTE : raw.statusNote;
  if (statusNote !== null && !usableStatusNote(statusNote)) {
    throw new Error(`${path}: "statusNote" must be a path to a .md file inside the vault, like "nopipeline status.md" or "Meta/Sync status.md" (no "..", no names starting with ".", not absolute), or null to turn it off`);
  }
  const profile = basename(path).replace(/\.json$/, "");
  // The profile names its state folder, so it must be a plain name of its own (not "", "." or "..").
  if (!PROFILE_NAME.test(profile)) {
    throw new Error(`${path}: the file name ${JSON.stringify(profile)} can't name a profile: start it with a letter or digit, and use only letters, digits, ".", "_", "-" and spaces`);
  }
  const pageIcon = parsePageIcon(raw.pageIcon, path);
  const tokenFile = raw.tokenFile === undefined || raw.tokenFile === null ? null : absolute("tokenFile");
  return {
    profile,
    vaultPath,
    vaultName: text("vaultName", basename(vaultPath)),
    dataSourceId,
    titleProperty: text("titleProperty", "Name"),
    linksToProperty: raw.linksToProperty === null ? null : text("linksToProperty", "Links to"),
    tagsProperty: raw.tagsProperty === null ? null : text("tagsProperty", "Tags"),
    projectsRelation: raw.projectsRelation === undefined || raw.projectsRelation === null ? null : text("projectsRelation"),
    pageIcon,
    ignoredKeys: IGNORED.filter((key) => key in raw),
    inboxFolder,
    massTrashLimit: limit,
    tokenFile,
    statusNote,
    autoSyncHours,
    stateDir: join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "nopipeline", profile),
  };
}

function usableStatusNote(value: unknown): value is string {
  if (typeof value !== "string" || !value.endsWith(".md") || value.startsWith("/")) return false;
  return usableFolder(value) && value.split("/").pop() !== ".md";
}

/** The colors of Notion's native icons (`NoticonColor` in the SDK). */
const ICON_COLORS = ["gray", "lightgray", "brown", "yellow", "orange", "green", "blue", "purple", "pink", "red"];
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** One emoji: a pictograph (with its modifiers and joiners), a pair of regional indicators (a flag), or a keycap. */
const SINGLE_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)/u;

function parsePageIcon(value: unknown, path: string): PageIcon | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() !== "") {
    if ([...segments.segment(value)].length !== 1 || !SINGLE_EMOJI.test(value)) throw new Error(`${path}: "pageIcon" must be a single emoji like "📘" (got ${JSON.stringify(value)}) or an icon object like {"name": "bookmark", "color": "blue"}`);
    return { type: "emoji", emoji: value };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { name, color } = value as Record<string, unknown>;
    if (typeof name === "string" && name !== "" && typeof color === "string" && color !== "") {
      if (!ICON_COLORS.includes(color)) throw new Error(`${path}: "pageIcon" color ${JSON.stringify(color)} is not one of ${ICON_COLORS.join(", ")}`);
      return { type: "icon", icon: { name, color } };
    }
  }
  throw new Error(`${path}: "pageIcon" must be an emoji like "📘" or an object like {"name": "bookmark", "color": "blue"}`);
}

/** The state folder can't be taken for this profile (it belongs to another vault or data source, or its profile.json is unreadable): nothing may be written into it. */
export class StateClaimError extends Error {}

/**
 * Ties the state folder to this profile's vault and data source, so two config files that happen to share a
 * name can never read each other's records.
 */
export async function claimStateDir(config: Config): Promise<void> {
  await makeFolders(config.stateDir);
  const file = join(config.stateDir, "profile.json");
  const mine = { vaultPath: config.vaultPath, dataSourceId: config.dataSourceId };
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (text === null) {
    // Written in full under a unique name, then linked into place: only one first claim can win.
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFlushed(tmp, `${JSON.stringify(mine, null, 2)}\n`);
    try {
      await link(tmp, file);
      await flush(config.stateDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Awaited here, so a rejection from the retry is handled before the finally block cleans up.
      return await claimStateDir(config);
    } finally {
      await rm(tmp, { force: true });
    }
    return;
  }
  let saved: { vaultPath?: unknown; dataSourceId?: unknown } | null = null;
  try {
    saved = JSON.parse(text) as { vaultPath?: unknown; dataSourceId?: unknown } | null;
  } catch {
    // Reported below.
  }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new StateClaimError(`${file} is unreadable; fix or delete it`);
  if (saved.vaultPath !== mine.vaultPath || saved.dataSourceId !== mine.dataSourceId) {
    throw new StateClaimError(
      `the state folder ${config.stateDir} belongs to the vault ${String(saved.vaultPath)} and data source ${String(saved.dataSourceId)}; give this config file a name of its own (or, if you moved the vault, update ${file})`,
    );
  }
}

/** NOTION_TOKEN wins; otherwise the token file, which must be readable by its owner only. */
export async function readToken(config: Config, env: Env = process.env): Promise<string> {
  const fromEnv = env.NOTION_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (!config.tokenFile) throw new Error("no Notion token: set NOTION_TOKEN or \"tokenFile\" in the config");
  const info = await stat(config.tokenFile);
  if ((info.mode & 0o077) !== 0) throw new Error(`${config.tokenFile} must be private: run chmod 600 on it`);
  const token = (await readFile(config.tokenFile, "utf8")).trim();
  if (!token) throw new Error(`${config.tokenFile} is empty`);
  return token;
}
