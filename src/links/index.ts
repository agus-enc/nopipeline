// Which note an Obsidian link points to, and how to write a link to a Notion page.
import { posix } from "node:path";
import type { PageId } from "../types.ts";

export interface LinkEntry {
  /** Vault path with `.md`. */
  path: string;
  /** Null for notes that are not synced (Excalidraw drawings) or not created in Notion yet. */
  pageId: PageId | null;
  /** The Notion title (the file name unless `notion-title` says otherwise). */
  title: string;
  /** A name the page is known by until its note moves there (a rename from Notion): never chosen over a real note. */
  alias?: boolean;
}

export interface LinkIndex {
  entries: LinkEntry[];
  byName: Map<string, LinkEntry[]>;
  byPageId: Map<PageId, LinkEntry>;
}

export function stem(path: string): string {
  return path.replace(/\.md$/i, "");
}

export function baseName(path: string): string {
  return posix.basename(stem(path));
}

function folderOf(path: string): string {
  const dir = posix.dirname(path);
  return dir === "." ? "" : dir;
}

export function buildLinkIndex(entries: LinkEntry[]): LinkIndex {
  const byName = new Map<string, LinkEntry[]>();
  const byPageId = new Map<PageId, LinkEntry>();
  for (const entry of entries) {
    const key = baseName(entry.path).normalize("NFC").toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), entry]);
    if (entry.pageId) byPageId.set(entry.pageId, entry);
  }
  return { entries, byName, byPageId };
}

/** Resolves a link target the way Obsidian does: a vault path, a path suffix, or a bare name. */
export function resolveLink(index: LinkIndex, target: string, fromPath: string): LinkEntry | null {
  let t = target.trim().normalize("NFC");
  if (t === "") return null;
  if (t.startsWith("./") || t.startsWith("../")) t = posix.normalize(posix.join(folderOf(fromPath), t));
  t = stem(t).replace(/^\/+/, "");
  const wanted = t.toLowerCase();
  const name = posix.basename(wanted);
  const matching = (index.byName.get(name) ?? []).filter((e) => {
    const s = stem(e.path).normalize("NFC").toLowerCase();
    return s === wanted || s.endsWith(`/${wanted}`);
  });
  const real = matching.filter((e) => !e.alias);
  const candidates = real.length ? real : matching;
  if (candidates.length <= 1) return candidates[0] ?? null;
  const exact = candidates.find((e) => stem(e.path).normalize("NFC").toLowerCase() === wanted);
  if (exact) return exact;
  const sameFolder = candidates.find((e) => folderOf(e.path) === folderOf(fromPath));
  if (sameFolder) return sameFolder;
  return [...candidates].sort((a, b) => a.path.length - b.path.length || (a.path < b.path ? -1 : 1))[0]!;
}

/** Plain words as a Markdown link's text: `[`, `]` and `\` escaped. */
export function linkText(text: string): string {
  return text.replace(/[[\]\\]/g, "\\$&");
}

/** One path segment, or a heading, as part of a Markdown link destination: `encodeURIComponent`, and `(`/`)` as `%28`/`%29`. */
export function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** A vault path as a Markdown link destination: each segment encoded as `encodeSegment` does. */
export function encodeVaultPath(path: string): string {
  return path.split("/").map(encodeSegment).join("/");
}

/** The shortest path (without `.md`) that resolves to `entry` from `fromPath`: its file name, or more of its folders when that is ambiguous. */
export function linkPathFor(index: LinkIndex, entry: LinkEntry, fromPath: string): string {
  const parts = stem(entry.path).split("/");
  for (let n = 1; n <= parts.length; n++) {
    const candidate = parts.slice(-n).join("/");
    if (resolveLink(index, candidate, fromPath) === entry) return candidate;
  }
  return stem(entry.path);
}

/** The text to put inside `[[...]]` for a page: its file name, or the shortest path that is unambiguous. */
export function linkTextFor(index: LinkIndex, pageId: PageId, fromPath: string): string | null {
  const entry = index.byPageId.get(pageId);
  return entry ? linkPathFor(index, entry, fromPath) : null;
}
