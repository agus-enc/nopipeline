// Updating links in a note (outside code): after the note they point to was renamed or moved, and on lines
// pulled from Notion, which keep the note's own form of each link.
import { encodeSegment, encodeVaultPath, linkText, resolveLink, stem, type LinkEntry, type LinkIndex } from "./index.ts";

export interface LinkRewrite {
  /** True when a link target (without #anchor or |alias) points to the renamed note. */
  matches: (target: string) => boolean;
  /** What to write inside [[...]] now. */
  wikiText: string;
  /** The note's path to write in Markdown links (with `.md`): the shortest that resolves to it. */
  path: string;
  /** The note's title before and after a rename: a Markdown link reading `from` (or `from › Heading`) reads `to` now. */
  title?: { from: string; to: string };
}

const WIKI = /(!?)\[\[([^\]\n]+?)\]\]/g;
/** A Markdown link: its text (escaped brackets allowed), its destination and an optional "title". */
const MD_LINK = /(!?)\[((?:[^[\]\n\\]|\\.)*)\]\(([^)\s]+)((?:[ \t]+"[^"\n]*")?)\)/g;
/** A backslash escape Markdown reads as the character itself. */
const ESCAPE = /\\([!-/:-@[-`{-~])/g;

/** A Markdown link destination as the vault path it names (without `.md`) and its heading; null for a web link or a bad encoding. */
function destination(dest: string): { target: string; anchor: string | null } | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(dest)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(dest);
  } catch {
    return null;
  }
  const hash = decoded.indexOf("#");
  return { target: stem(hash === -1 ? decoded : decoded.slice(0, hash)), anchor: hash === -1 ? null : decoded.slice(hash + 1) };
}

/** A link's text (as written) with the title `from` replaced by `to`, when it reads `from` or `from › Heading`; else null. */
function retitled(label: string, from: string, to: string): string | null {
  const plain = label.replace(ESCAPE, "$1");
  if (plain === from) return linkText(to);
  const head = `${from} › `;
  if (!plain.startsWith(head)) return null;
  // The heading part keeps its bytes as written: skip as many characters of the text as the head reads.
  let at = 0;
  for (let read = 0; read < head.length; read++) at += label[at] === "\\" && /[!-/:-@[-`{-~]/.test(label[at + 1] ?? "") ? 2 : 1;
  return `${linkText(to)} › ${label.slice(at)}`;
}

function rewriteSegment(text: string, rule: LinkRewrite): string {
  return text
    .replace(WIKI, (whole, bang: string, inner: string) => {
      const split = inner.search(/\\?\||#/);
      const target = split === -1 ? inner : inner.slice(0, split);
      return rule.matches(target) ? `${bang}[[${rule.wikiText}${split === -1 ? "" : inner.slice(split)}]]` : whole;
    })
    .replace(MD_LINK, (whole, bang: string, label: string, dest: string, title: string) => {
      const found = destination(dest);
      if (found === null || !rule.matches(found.target)) return whole;
      const text = (bang === "" && rule.title && rule.title.from !== rule.title.to && retitled(label, rule.title.from, rule.title.to)) || label;
      return `${bang}[${text}](${encodeVaultPath(rule.path)}${found.anchor === null ? "" : `#${encodeSegment(found.anchor)}`}${title})`;
    });
}

/** Whether position `at` of a YAML line sits inside a single-quoted scalar (where `'` is written `''`). */
function inSingleQuotes(line: string, at: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < at; i++) {
    const c = line[i];
    if (quote === null) {
      // A quote opens a scalar only where a value starts: at the line's start or after `:`, `-`, `[`, `{` or `,`.
      if ((c === "'" || c === '"') && /(^|[:\-[{,])[ \t]*$/.test(line.slice(0, i))) quote = c;
    } else if (quote === '"') {
      if (c === "\\") i++;
      else if (c === '"') quote = null;
    } else if (c === "'") {
      if (line[i + 1] === "'") i++;
      else quote = null;
    }
  }
  return quote === "'";
}

/**
 * Rewrites the [[links]] on a frontmatter line, the way Obsidian updates link properties. The note's own
 * `notion-id` and `notion-title` are left alone, and a single-quoted YAML value stays valid.
 */
export function rewriteFrontmatterLinks(line: string, rule: LinkRewrite): string {
  if (/^notion-(id|title):/.test(line)) return line;
  return line.replace(WIKI, (whole, bang: string, inner: string, offset: number) => {
    const split = inner.search(/\\?\||#/);
    const target = split === -1 ? inner : inner.slice(0, split);
    if (!rule.matches(target)) return whole;
    const text = inSingleQuotes(line, offset) ? rule.wikiText.replace(/'/g, "''") : rule.wikiText;
    return `${bang}[[${text}${split === -1 ? "" : inner.slice(split)}]]`;
  });
}

/** A line split into text and inline code spans (text first, then alternating); a span closes at a run of the same length. */
function codeSpans(line: string): string[] {
  const parts: string[] = [];
  let text = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      text += line[i++];
      continue;
    }
    let n = 0;
    while (line[i + n] === "`") n++;
    let j = i + n;
    let close = -1;
    while (j < line.length && close === -1) {
      if (line[j] !== "`") {
        j++;
        continue;
      }
      let m = 0;
      while (line[j + m] === "`") m++;
      if (m === n) close = j;
      j += m;
    }
    if (close === -1) {
      text += line.slice(i, i + n);
      i += n;
      continue;
    }
    parts.push(text, line.slice(i, close + n));
    text = "";
    i = close + n;
  }
  parts.push(text);
  return parts;
}

/**
 * `text` with `change` applied to every part outside code blocks and inline code (either app's markdown); with
 * `math`, outside blocks of math too, read as the translator reads them: from a line starting `$$` (in a quote or a
 * list item too) to the first line ending `$$`, or that line alone when it also ends `$$`.
 */
export function outsideCode(text: string, change: (part: string) => string, math = false): string {
  let fence: string | null = null;
  let inMath = false;
  const content = (line: string) => line.replace(/^[ \t]*(?:>[ \t]?)*/, "").trim();
  return text
    .split("\n")
    .map((line) => {
      if (inMath) {
        if (content(line).endsWith("$$")) inMath = false;
        return line;
      }
      if (fence === null) {
        const open = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
        if (open) {
          fence = open;
          return line;
        }
      } else {
        const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
        if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
        return line;
      }
      if (math && content(line).startsWith("$$")) {
        const first = content(line);
        inMath = !(first.length > 4 && first.endsWith("$$"));
        return line;
      }
      return codeSpans(line)
        .map((part, k) => (k % 2 === 1 ? part : change(part)))
        .join("");
    })
    .join("\n");
}

export function rewriteLinks(body: string, rule: LinkRewrite): string {
  return outsideCode(body, (part) => rewriteSegment(part, rule));
}

/**
 * The body with the text of each Markdown link (outside code, not an embed) whose target `matches` and whose text
 * reads `from`, or `from › Heading`, reading `to` instead. Destinations are left as they are.
 */
export function retitleLinks(body: string, matches: (target: string) => boolean, from: string, to: string): string {
  if (from === to) return body;
  return outsideCode(body, (part) =>
    part.replace(MD_LINK, (whole, bang: string, label: string, dest: string, title: string) => {
      const found = destination(dest);
      if (bang !== "" || found === null || !matches(found.target)) return whole;
      const text = retitled(label, from, to);
      return text === null ? whole : `[${text}](${dest}${title})`;
    }),
  );
}

/** An Obsidian link on a line: where it is, the note it points to, and the text a reader sees. */
interface LinkOnLine {
  start: number;
  end: number;
  text: string;
  embed: boolean;
  entry: LinkEntry | null;
  visible: string;
}

const ANY_LINK = /(!?)\[\[([^\]\n]+?)\]\]|(!?)\[((?:[^[\]\n]|\\[[\]])*)\]\((<[^>\n]*>|[^)\s]+)(?:[ \t]+"[^"\n]*")?\)/g;

function linksOn(line: string, index: LinkIndex, fromPath: string): LinkOnLine[] {
  const found: LinkOnLine[] = [];
  let offset = 0;
  codeSpans(line).forEach((part, k) => {
    if (k % 2 === 0) {
      for (const m of part.matchAll(ANY_LINK)) {
        const at = { start: offset + m.index, end: offset + m.index + m[0].length, text: m[0] };
        if (m[2] !== undefined) {
          const inner = m[2].replace(/\\\|/g, "|");
          const pipe = inner.indexOf("|");
          const target = pipe === -1 ? inner : inner.slice(0, pipe);
          const hash = target.indexOf("#");
          const entry = resolveLink(index, hash === -1 ? target : target.slice(0, hash), fromPath);
          found.push({ ...at, embed: m[1] === "!", entry, visible: pipe === -1 ? target : inner.slice(pipe + 1) });
        } else {
          const raw = m[5]!.startsWith("<") ? m[5]!.slice(1, -1) : m[5]!;
          if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
          let dest = raw;
          try {
            dest = decodeURIComponent(raw);
          } catch {
            // keep the raw destination
          }
          const hash = dest.indexOf("#");
          const entry = resolveLink(index, hash === -1 ? dest : dest.slice(0, hash), fromPath);
          found.push({ ...at, embed: m[3] === "!", entry, visible: m[4]! });
        }
      }
    }
    offset += part.length;
  });
  return found;
}

/** A `[[link]]` the vault writes as a Markdown link now: not an embed, and not a block link (`[[Note#^id]]`). */
const convertible = (link: LinkOnLine) => !link.embed && link.text.startsWith("[[") && !/^\[\[[^\]|]*#\^/.test(link.text);

/**
 * `line` with each link that points to the same note, with the same visible text, as a link on `old` written
 * the way `old` wrote it: a line pulled from Notion keeps the note's Markdown links (their text and destination
 * path), its embeds and its `#^block` links. A `[[link]]` on `old` is not brought back: it comes back as a
 * Markdown link.
 */
export function keepLinkForms(line: string, old: string, index: LinkIndex, fromPath: string): string {
  const before = linksOn(old, index, fromPath).filter((link) => !convertible(link));
  if (before.length === 0) return line;
  const used = new Set<LinkOnLine>();
  let out = "";
  let at = 0;
  for (const link of linksOn(line, index, fromPath)) {
    const same = before.find((o) => !used.has(o) && o.entry !== null && o.entry === link.entry && o.embed === link.embed && o.visible === link.visible);
    if (!same) continue;
    used.add(same);
    out += line.slice(at, link.start) + same.text;
    at = link.end;
  }
  return out + line.slice(at);
}
