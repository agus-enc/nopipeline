// Turning a note's `[[links]]` into Markdown links, `[Title](Path.md)`, the form the vault keeps (the conversion
// itself is part of every run; this is the pure text step).
import { isAttachment, MATH } from "../translate/context.ts";
import { plainLinkText } from "../translate/inline.ts";
import { splitFrontmatter, replaceBody } from "../vault/frontmatter.ts";
import type { VaultNote } from "../types.ts";
import { baseName, buildLinkIndex, encodeSegment, encodeVaultPath, linkPathFor, resolveLink, type LinkEntry, type LinkIndex } from "./index.ts";
import { outsideCode } from "./rewrite.ts";

const WIKI = /\[\[([^\]\n]+?)\]\]/y;
const EMBED = /!\[\[([^\]\n]+?)\]\]/y;
const PUNCTUATION = /[!-/:-@[-`{-~]/;

function at(re: RegExp, text: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(text);
}

/** `target.md#anchor` as a Markdown link destination; the target is a vault path without `.md`. */
export function markdownDestination(target: string, anchor: string | null): string {
  return `${encodeVaultPath(target)}.md${anchor ? `#${encodeSegment(anchor)}` : ""}`;
}

/** `[text](target.md#anchor)`: the text as `plainLinkText` writes it, the target a vault path without `.md`. */
export function markdownLink(text: string, target: string, anchor: string | null): string {
  return `[${plainLinkText(text)}](${markdownDestination(target, anchor)})`;
}

/**
 * The Markdown link for the inside of one `[[...]]`, or null when it stays as it is (an embed's inside, a block link,
 * an attachment): in the vault, and for the literal `[[link]]` Notion holds as text.
 */
export function convertWiki(rawInner: string, index: LinkIndex, fromPath: string, onLink?: (toNote: boolean) => void): string | null {
  const inner = rawInner.replace(/\\\|/g, "|");
  const pipe = inner.indexOf("|");
  const targetPart = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  const alias = pipe === -1 ? "" : inner.slice(pipe + 1).trim();
  const hash = targetPart.indexOf("#");
  const target = (hash === -1 ? targetPart : targetPart.slice(0, hash)).trim();
  const anchor = hash === -1 ? "" : targetPart.slice(hash + 1).trim();
  if (target === "" || anchor.startsWith("^")) return null;
  // A name that looks like a file (`ISO 8601`) is a note when one resolves; otherwise it is an attachment.
  const entry = resolveLink(index, target, fromPath);
  if (!entry && isAttachment(target)) return null;
  onLink?.(entry !== null);
  // A link to no note reads the target's base name, as the literal Notion holds for it reads back.
  const name = entry ? entry.title : baseName(target);
  const text = alias !== "" ? alias : anchor !== "" ? `${name} › ${anchor}` : name;
  return markdownLink(text, entry ? linkPathFor(index, entry, fromPath) : stemOf(target), anchor === "" ? null : anchor);
}

const stemOf = (target: string) => target.replace(/\.md$/i, "");

/**
 * The body with each `[[link]]` outside code and math written as a Markdown link; `links` counts them. Text is read
 * as the translator reads it: an escaped `\[[x]]`, an embed and inline math (`$[[x]]$`) stay as they are. Known gap:
 * a `[[x]]` inside the text of an existing Markdown link is converted too.
 */
export function convertBody(body: string, index: LinkIndex, fromPath: string, onLink?: (toNote: boolean) => void): { body: string; links: number } {
  let links = 0;
  const convertPart = (part: string) => {
    let out = "";
    let i = 0;
    while (i < part.length) {
      const ch = part[i]!;
      let m: RegExpExecArray | null = null;
      if (ch === "\\") {
        const n = i + 1 < part.length && PUNCTUATION.test(part[i + 1]!) ? 2 : 1;
        out += part.slice(i, i + n);
        i += n;
      } else if ((ch === "$" && part[i + 1] !== "$" && (m = at(MATH, part, i))) || (ch === "!" && (m = at(EMBED, part, i)))) {
        out += m[0];
        i += m[0].length;
      } else if (ch === "[" && (m = at(WIKI, part, i))) {
        const link = convertWiki(m[1]!, index, fromPath, onLink);
        if (link !== null) links++;
        out += link ?? m[0];
        i += m[0].length;
      } else {
        out += ch;
        i += 1;
      }
    }
    return out;
  };
  return { body: outsideCode(body, convertPart, true), links };
}

/** A note whose body holds `[[links]]` to convert: its whole new text, frontmatter kept byte for byte. */
export interface Conversion {
  path: string;
  text: string;
  links: number;
}

const titleOf = (note: VaultNote) => note.notionTitle ?? baseName(note.path);

/** The index a run converts `[[links]]` against: every note and drawing of the vault as scanned. */
export function conversionIndex(notes: VaultNote[], drawings: string[]): LinkIndex {
  const entries: LinkEntry[] = [
    ...notes.map((note) => ({ path: note.path, pageId: note.notionId, title: titleOf(note) })),
    ...drawings.map((path) => ({ path, pageId: null, title: baseName(path) })),
  ];
  return buildLinkIndex(entries);
}

/** The notes that have `[[links]]` to convert, against an index of every note and drawing. */
export function convertNotes(notes: VaultNote[], drawings: string[], onLink?: (toNote: boolean) => void): Conversion[] {
  const index = conversionIndex(notes, drawings);
  const out: Conversion[] = [];
  for (const note of notes) {
    const { body, links } = convertBody(splitFrontmatter(note.text).body, index, note.path, onLink);
    if (links > 0) out.push({ path: note.path, text: replaceBody(note.text, body), links });
  }
  return out;
}
