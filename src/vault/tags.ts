// A note's frontmatter `tags`: read, write and merge. Writing touches only the `tags` key's lines.
import { frontmatterBounds } from "./frontmatter.ts";

export type NoteTags = { kind: "tags"; tags: string[] } | { kind: "unsafe"; reason: string };

/** Obsidian's tag characters: letters (any script), digits, `_`, `-`, `/`; not empty, not all digits. */
export function isObsidianTag(name: string): boolean {
  return /^[\p{L}\p{N}_/-]+$/u.test(name) && !/^[0-9]+$/.test(name);
}

const KEY_LINE = /^tags:(\s|$)/;
const BLOCK_LINE = /^([ \t]|-([ \t]|\r?$))/;

const BLANK = /^[ \t]*\r?$/;

/** The index after the key's last real line: blank lines count only when a list line follows them. */
function keyEnd(lines: string[], k: number, end: number): number {
  let last = k + 1;
  for (let i = k + 1; i < end; i++) {
    if (BLANK.test(lines[i]!)) continue;
    if (!BLOCK_LINE.test(lines[i]!)) break;
    last = i + 1;
  }
  return last;
}

function unsafe(reason: string): NoteTags {
  return { kind: "unsafe", reason };
}

/** One value: plain, "double" or 'single' quoted. `null` when it carries a comment or stray text. */
function scalar(raw: string): string | null {
  const value = raw.trim();
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(value) ?? /^'((?:[^']|'')*)'$/.exec(value);
  if (quoted) {
    if (value.startsWith('"')) {
      try {
        return JSON.parse(value) as string;
      } catch {
        return null;
      }
    }
    return quoted[1]!.replace(/''/g, "'");
  }
  if (/^["']/.test(value) || /(^|\s)#/.test(value)) return null;
  return value;
}

function cleaned(items: (string | null)[]): NoteTags {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item === null) return unsafe("a tags value is not a plain or quoted word");
    const name = item.replace(/^#/, "");
    if (!isObsidianTag(name)) return unsafe(`"${item}" is not a tag Obsidian accepts`);
    if (!seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      tags.push(name);
    }
  }
  return { kind: "tags", tags };
}

export function readTags(text: string): NoteTags {
  const lines = text.split("\n");
  const b = frontmatterBounds(lines);
  if (!b) return { kind: "tags", tags: [] };
  const keys: number[] = [];
  for (let i = 1; i < b.end; i++) if (KEY_LINE.test(lines[i]!)) keys.push(i);
  if (keys.length === 0) return { kind: "tags", tags: [] };
  if (keys.length > 1) return unsafe("the tags key appears more than once");
  const k = keys[0]!;
  const inline = lines[k]!.replace(/^tags:/, "").replace(/\r$/, "").trim();
  const block: string[] = [];
  for (let i = k + 1, last = keyEnd(lines, k, b.end); i < last; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const item = /^[ \t]*-[ \t]+(.*)$/.exec(line);
    if (!item) return unsafe("tags holds something other than a list of words");
    block.push(item[1]!);
  }
  if (inline === "") return cleaned(block.map(scalar));
  if (block.length > 0) return unsafe("tags has a value and a list");
  if (inline.startsWith("[")) {
    if (!inline.endsWith("]")) return unsafe("a tags list is not closed on its line");
    const inner = inline.slice(1, -1);
    return cleaned(inner.trim() === "" ? [] : inner.split(",").map(scalar).filter((s) => s !== ""));
  }
  return cleaned(inline.split(",").map(scalar).filter((s) => s !== ""));
}

function listItem(tag: string): string {
  // Words and shapes YAML reads as something else: booleans, null, numbers, dates, indicators.
  return /^(true|false|null|yes|no|on|off|y|n|~)$/i.test(tag) || /^[\d\-+.]/.test(tag) ? JSON.stringify(tag) : tag;
}

/** The note with its `tags` key written as a block list (none: key removed). Every other byte is kept. */
export function writeTags(text: string, tags: readonly string[]): string {
  if (readTags(text).kind === "unsafe") return text;
  const crlf = text.includes("\r\n");
  const eol = crlf ? "\r\n" : "\n";
  const cr = crlf ? "\r" : "";
  const newLines = tags.length === 0 ? [] : ["tags:", ...tags.map((t) => `  - ${listItem(t)}`)].map((l) => l + cr);
  const lines = text.split("\n");
  const b = frontmatterBounds(lines);
  if (!b) {
    if (newLines.length === 0) return text;
    const block = ["---", ...newLines.map((l) => l.replace(/\r$/, "")), "---"];
    return block.join(eol) + eol + text;
  }
  let k = -1;
  for (let i = 1; i < b.end; i++) {
    if (KEY_LINE.test(lines[i]!)) {
      k = i;
      break;
    }
  }
  if (k === -1) {
    lines.splice(b.end, 0, ...newLines);
    return lines.join("\n");
  }
  const stop = keyEnd(lines, k, b.end);
  lines.splice(k, stop - k, ...newLines);
  return lines.join("\n");
}

function lower(tags: readonly string[]): Set<string> {
  return new Set(tags.map((t) => t.toLowerCase()));
}

/**
 * Three-way set merge, case-insensitive: a tag added on either side is kept, one removed on either side is dropped.
 * Without a base the result is the union. Spelling is the note's, else the page's; the note's order first.
 */
export function mergeTags(base: readonly string[] | undefined, note: readonly string[], page: readonly string[]): string[] {
  const inBase = base === undefined ? null : lower(base);
  const inNote = lower(note);
  const inPage = lower(page);
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (tag: string, keep: boolean) => {
    const key = tag.toLowerCase();
    if (!keep || seen.has(key)) return;
    seen.add(key);
    out.push(tag);
  };
  for (const tag of note) {
    const key = tag.toLowerCase();
    take(tag, inBase === null || !inBase.has(key) || inPage.has(key));
  }
  for (const tag of page) {
    const key = tag.toLowerCase();
    take(tag, inBase === null || !inBase.has(key) || inNote.has(key));
  }
  return out;
}

export function sameTags(a: readonly string[], b: readonly string[]): boolean {
  const x = lower(a);
  const y = lower(b);
  return x.size === y.size && [...x].every((t) => y.has(t));
}
