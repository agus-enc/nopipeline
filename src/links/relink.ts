// Links Notion holds as `\[\[…\]\]` text because their note had no page yet, and turning them into Notion links.
import { isAttachment, unescapeMarkdown } from "../translate/context.ts";
import { MD_LINK, unresolvedLiteral } from "../translate/inline.ts";
import { stem } from "./index.ts";
import { outsideCode } from "./rewrite.ts";

/** Where a [[link]] as the translator writes it for Notion opens: escaped brackets, its text escaped too. */
const OPEN = /(!?)\\\[\\\[/g;
const CLOSE = "\\]\\]";
/** An Obsidian [[link]] that isn't escaped. */
const WIKI = /(?<!\\)(!?)\[\[([^\]\n]+?)\]\]/g;
const MARKDOWN = new RegExp(MD_LINK.source, "g");

/**
 * The `[[inner]]` (or `![[inner]]`) text each link of a note body outside code is written as in Notion while its note
 * has no page, with the links (their source, as the note writes them) written as it: each [[link]] as typed (`\|`
 * read as `|`), and each Markdown link to a note as `toNotionInline` writes it (`unresolvedLiteral`; a destination
 * without `.md` too, which the translator writes so when it names a note without a page). Web links, images,
 * attachments and same-note heading links add nothing.
 */
export function noteLinks(body: string): Map<string, string[]> {
  const links = new Map<string, string[]>();
  const add = (literal: string, source: string) => {
    const sources = links.get(literal) ?? [];
    if (!sources.includes(source)) sources.push(source);
    links.set(literal, sources);
  };
  outsideCode(body, (part) => {
    for (const m of part.matchAll(WIKI)) add(`${m[1]}[[${m[2]!.replace(/\\\|/g, "|")}]]`, m[0]);
    for (const m of part.matchAll(MARKDOWN)) {
      const [source, bang, label, rawDest] = m as unknown as [string, string, string, string];
      if (bang || part[m.index - 1] === "\\") continue;
      const dest = rawDest.startsWith("<") ? rawDest.slice(1, -1) : rawDest;
      if (/^[a-z][a-z0-9+.-]*:/i.test(dest)) continue;
      let decoded = dest;
      try {
        decoded = decodeURIComponent(dest);
      } catch {
        // kept as written, as the translator keeps it
      }
      const hash = decoded.indexOf("#");
      const target = hash === -1 ? decoded : decoded.slice(0, hash);
      if (target === "" || isAttachment(target)) continue;
      const note = stem(target);
      add(`[[${unresolvedLiteral(unescapeMarkdown(label) || note, note, hash === -1 ? null : decoded.slice(hash + 1))}]]`, source);
    }
    return part;
  });
  return links;
}

/** The literals of `noteLinks`. */
export function noteLiterals(body: string): Set<string> {
  return new Set(noteLinks(body).keys());
}

/**
 * The text [[links]] of one part of a line (outside code) that `wanted` accepts, left to right. A link's text may
 * hold `]]` itself (`[[N|a ]] b]]`, `[[Draft [2]]]`), so each opening is read up to each closing after it on the
 * line in turn, and the first reading `wanted` accepts is the link.
 */
function literalsIn(part: string, wanted: (link: string) => boolean): { start: number; end: number; link: string }[] {
  const found: { start: number; end: number; link: string }[] = [];
  OPEN.lastIndex = 0;
  for (let m = OPEN.exec(part); m; m = OPEN.exec(part)) {
    const from = m.index + m[0].length;
    const lineEnd = part.indexOf("\n", from);
    const limit = lineEnd === -1 ? part.length : lineEnd;
    for (let close = part.indexOf(CLOSE, from + 1); close !== -1 && close + CLOSE.length <= limit; close = part.indexOf(CLOSE, close + 1)) {
      const link = `${m[1]}[[${unescapeMarkdown(part.slice(from, close))}]]`;
      if (!wanted(link)) continue;
      found.push({ start: m.index, end: close + CLOSE.length, link });
      OPEN.lastIndex = close + CLOSE.length;
      break;
    }
  }
  return found;
}

/** The text [[links]] in Notion markdown that `wanted` accepts (see `literalsIn`), each with its target, outside code. */
export function literalLinks(markdown: string, wanted: (link: string) => boolean): { link: string; target: string }[] {
  const found: { link: string; target: string }[] = [];
  outsideCode(markdown, (part) => {
    for (const { link } of literalsIn(part, wanted)) found.push({ link, target: link.replace(/^!?\[\[/, "").slice(0, -2).split(/[|#]/)[0]! });
    return part;
  });
  return found;
}

/**
 * Notion markdown with each text [[link]] that the note (`body`) holds as a real link (a [[link]] or a Markdown link)
 * replaced by the translation of the note's link, where that is no longer text: a link to a note that has its page
 * now becomes a Notion link, the same as the note's line translates to. A literal two of the note's links are
 * written as, whose translations differ, stays text: which one it was can't be told.
 */
export function relink(markdown: string, body: string, translate: (link: string) => string): string {
  const links = noteLinks(body);
  return outsideCode(markdown, (part) => {
    let out = "";
    let at = 0;
    for (const { start, end, link } of literalsIn(part, (l) => links.has(l))) {
      const translations = new Set(links.get(link)!.map(translate));
      const [translated] = translations;
      out += part.slice(at, start) + (translations.size === 1 && !/^!?\\\[\\\[/.test(translated!) ? translated : part.slice(start, end));
      at = end;
    }
    return out + part.slice(at);
  });
}
