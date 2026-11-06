// Block structure: parse either dialect into one shape, write it out in the other.
// Text fields hold inline markdown in the dialect the block was parsed from.
import { mediaLine, placeholderPath, type MediaKind } from "../notion/hosted.ts";

export type Block =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "item"; marker: string; task: " " | "x" | null; text: string; children: Block[] }
  | { type: "code"; info: string; lines: string[] }
  | { type: "math"; lines: string[] }
  | { type: "table"; rows: string[][] }
  | { type: "quote"; text: string; children: Block[] }
  | { type: "callout"; kind: string; fold: "" | "+" | "-"; title: string; children: Block[] }
  | { type: "divider" }
  /**
   * A file on a line of its own (see `images.ts`): `caption` is inline markdown in the dialect the block was parsed from,
   * `target` the destination as the block is written. Toward Notion `kind` picks the block (an image line, or a PDF, audio,
   * video or file tag); toward Obsidian `link` says whether the note cites the file as a link, `[c](path)`, or as an embed, `![c](path)`.
   */
  | { type: "media"; kind: MediaKind; link: boolean; caption: string; target: string };

// --- Obsidian parser -------------------------------------------------------

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const DIVIDER = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TASK = /^\[([ xX])\](?:[ \t]+(.*))?$/;
const QUOTE = /^ {0,3}>/;
const TABLE_ROW = /^ {0,3}\|/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
/** A fence and its info string (a backtick fence's info string has no backticks, as in CommonMark). */
const FENCE = /^(?:(`{3,})([^`]*)|(~{3,})(.*))$/;

function columns(whitespace: string): number {
  let width = 0;
  for (const c of whitespace) width += c === "\t" ? 4 - (width % 4) : 1;
  return width;
}

function indentOf(line: string): number {
  return columns(/^[ \t]*/.exec(line)![0]);
}

/**
 * The fence and info string of a line that opens a fenced code block, read as CommonMark (and Obsidian) reads it:
 * at most three columns of indentation past `column`, where the block the line sits in starts its content.
 * Indented further, the line is a paragraph's text or an indented code block's. Inside a quote or callout,
 * `column` is 1: a quote line keeps the tab that may follow its `>`, which CommonMark counts as two columns.
 */
function opensFence(line: string, column = 0): { fence: string; info: string } | null {
  if (indentOf(line) > column + 3) return null;
  const m = FENCE.exec(line.trim());
  return m ? { fence: m[1] ?? m[3]!, info: (m[2] ?? m[4]!).trim() } : null;
}

/** Whether `line` closes a code block opened by `fence`: indented as a fence may be, a fence as long or longer of the same character, then only spaces. */
function closesFence(line: string, fence: string, column: number): boolean {
  if (indentOf(line) > column + 3) return false;
  const m = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
  return m !== null && m[1]![0] === fence[0] && m[1]!.length >= fence.length;
}

/** `line` without its first `cols` columns of indentation, as far as it has them (a tab counts to the next multiple of four). */
export function dedent(line: string, cols: number): string {
  let width = 0;
  let i = 0;
  while (i < line.length && width < cols && (line[i] === " " || line[i] === "\t")) {
    width += line[i] === "\t" ? 4 - (width % 4) : 1;
    i++;
  }
  return (width > cols ? " ".repeat(width - cols) : "") + line.slice(i);
}

const blank = (line: string) => line.trim() === "";
const isTableStart = (lines: string[], i: number) => TABLE_ROW.test(lines[i]!) && i + 1 < lines.length && TABLE_DELIMITER.test(lines[i + 1]!);

/** Whether line `i` starts a block, so it ends the paragraph before it; `column` is where that paragraph's content starts. */
function startsBlock(lines: string[], i: number, column = 0): boolean {
  const line = lines[i]!.trimStart();
  const next = lines[i + 1]?.trimStart();
  return (
    opensFence(lines[i]!, column) !== null ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    ITEM.test(line) ||
    DIVIDER.test(line) ||
    line.startsWith("$$") ||
    (TABLE_ROW.test(line) && next !== undefined && TABLE_DELIMITER.test(next))
  );
}

export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cell += "\\|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += s[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * The fence a list item opens on its own line (`- ```python`): CommonMark reads the item's text as a fenced code
 * block. Not a task's text, nor text indented five or more columns past the marker (an indented code block's).
 */
export function itemFence(line: string): { fence: string; info: string; shift: number } | null {
  const m = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/.exec(line);
  if (!m) return null;
  const gap = columns(m[1]! + m[2]! + m[3]!) - columns(m[1]!) - m[2]!.length;
  const open = gap <= 4 ? opensFence(m[4]!) : null;
  return open && !TASK.test(m[4]!) ? { ...open, shift: columns(m[1]!) + m[2]!.length + gap } : null;
}

/**
 * The code of a block a list item's fence opens, from its lines as the note writes them: without the item's
 * indentation (`shift` columns) when every line that holds something has it, as CommonMark reads code inside a
 * list item; otherwise as written, so a line indented less than the item, and every line's depth against the
 * others, stay as they are.
 */
export function itemCode(body: string[], shift: number): string[] {
  return body.every((l) => blank(l) || indentOf(l) >= shift) ? body.map((l) => dedent(l, shift)) : body;
}

function parseItem(lines: string[], start: number, out: Block[], column: number): number {
  const m = ITEM.exec(lines[start]!)!;
  const indent = columns(m[1]!);
  const marker = m[2]!;
  // Where the item's text starts: after the marker and the spaces after it (one, when there are five or more).
  const gap = columns(/^[ \t]*(?:[-*+]|\d{1,9}[.)])([ \t]*)/.exec(lines[start]!)![0]) - indent - marker.length;
  const content = column + indent + marker.length + (gap >= 1 && gap <= 4 ? gap : 1);
  let first = (m[3] ?? "").trimEnd();
  let task: " " | "x" | null = null;
  const t = /^[-*+]$/.test(marker) ? TASK.exec(first) : null;
  if (t) {
    task = t[1]!.toLowerCase() === "x" ? "x" : " ";
    first = t[2] ?? "";
  }
  const text = [first];
  let i = start + 1;
  // A fence on the item's line opens a code block in the item. It runs to its closing fence or, left open, to the
  // end of the block the list is in (a callout, a quote, the note), taking the lines after it even where they lack
  // the item's indentation, as the notes that write one mean them. Its lines lose the item's indentation
  // only where every one of them has it (`itemCode`), so code keeps its depth.
  const fenced = itemFence(lines[start]!);
  const code: Block[] = [];
  if (fenced) {
    const body: string[] = [];
    while (i < lines.length && !closesFence(lines[i]!, fenced.fence, content)) body.push(lines[i++]!);
    if (i < lines.length) i++;
    code.push({ type: "code", info: fenced.info, lines: itemCode(body, fenced.shift) });
    text.length = 0;
  }
  while (!fenced && i < lines.length && !blank(lines[i]!) && !startsBlock(lines, i, content)) {
    text.push(lines[i]!.trim());
    i++;
  }
  const childLines: string[] = [];
  while (i < lines.length) {
    if (blank(lines[i]!)) {
      let j = i;
      while (j < lines.length && blank(lines[j]!)) j++;
      if (j < lines.length && indentOf(lines[j]!) > indent) {
        while (i < j) {
          childLines.push("");
          i++;
        }
        continue;
      }
      break;
    }
    if (indentOf(lines[i]!) <= indent) break;
    childLines.push(lines[i]!);
    i++;
  }
  const depth = Math.min(...childLines.filter((l) => !blank(l)).map(indentOf));
  out.push({
    type: "item",
    marker,
    task,
    text: text.join("\n"),
    children: [...code, ...(childLines.length ? parseObsidian(childLines.map((l) => dedent(l, depth))) : [])],
  });
  return i;
}

/** Blocks of Obsidian markdown; `column` is where their content starts (1 inside a quote or callout, see `opensFence`). */
export function parseObsidian(lines: string[], column = 0): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;
    let open: { fence: string; info: string } | null;
    if (blank(line)) {
      i++;
    } else if ((open = opensFence(line, column))) {
      const { fence, info } = open;
      const indent = indentOf(line);
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        if (closesFence(lines[i++]!, fence, column)) break;
        body.push(dedent(lines[i - 1]!, indent));
      }
      blocks.push({ type: "code", info, lines: body });
    } else if (line.trim().startsWith("$$")) {
      const first = line.trim();
      if (first.length > 4 && first.endsWith("$$")) {
        blocks.push({ type: "math", lines: [first.slice(2, -2).trim()] });
        i++;
        continue;
      }
      const body: string[] = first.slice(2).trim() ? [first.slice(2).trim()] : [];
      i++;
      while (i < lines.length) {
        const l = lines[i]!.trim();
        i++;
        if (l.endsWith("$$")) {
          if (l.slice(0, -2).trim()) body.push(l.slice(0, -2).trim());
          break;
        }
        body.push(lines[i - 1]!);
      }
      blocks.push({ type: "math", lines: body });
    } else if ((m = HEADING.exec(line))) {
      blocks.push({ type: "heading", level: m[1]!.length, text: (m[2] ?? "").trim() });
      i++;
    } else if (DIVIDER.test(line)) {
      blocks.push({ type: "divider" });
      i++;
    } else if (isTableStart(lines, i)) {
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) rows.push(splitRow(lines[i++]!));
      blocks.push({ type: "table", rows });
    } else if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) inner.push(lines[i++]!.replace(/^ {0,3}> ?/, ""));
      const c = /^\[!([^\]\s]+)\]([+-]?)[ \t]*(.*)$/.exec(inner[0]!);
      if (c) {
        blocks.push({ type: "callout", kind: c[1]!, fold: c[2] as "" | "+" | "-", title: c[3]!.trim(), children: parseObsidian(inner.slice(1), 1) });
      } else {
        // A fenced code block inside the quote (one a list item opens too) is a block of its own nested in the
        // quote, so its lines keep their indentation; the quote's text is what comes before it.
        const fence = inner.findIndex((l) => opensFence(l, 1) !== null || itemFence(l) !== null);
        const text = fence === -1 ? inner : inner.slice(0, fence);
        if (fence !== -1) while (text.length && blank(text[text.length - 1]!)) text.pop();
        const children = fence === -1 ? [] : parseObsidian(inner.slice(fence), 1);
        // A quote's own text comes before its blocks: a list item that only opens a code block there gives the quote
        // that block (a quote holds no list).
        const [opened] = children;
        if (opened?.type === "item" && opened.text === "" && opened.children[0]?.type === "code") children.splice(0, 1, ...opened.children);
        blocks.push({ type: "quote", text: text.map((l) => l.trim()).join("\n"), children });
      }
    } else if (ITEM.test(line)) {
      i = parseItem(lines, i, blocks, column);
    } else {
      const text = [line.trim()];
      i++;
      let setext = 0;
      while (i < lines.length && !blank(lines[i]!)) {
        const s = SETEXT.exec(lines[i]!);
        if (s) {
          setext = s[1]![0] === "=" ? 1 : 2;
          i++;
          break;
        }
        if (startsBlock(lines, i, column)) break;
        text.push(lines[i++]!.trim());
      }
      blocks.push(setext ? { type: "heading", level: setext, text: text.join(" ") } : { type: "paragraph", text: text.join("\n") });
    }
  }
  return blocks;
}

// --- Notion parser ---------------------------------------------------------

const ATTRIBUTES = /[ \t]*\{(?:[a-z_-]+="[^"]*"[ \t]*)+\}[ \t]*$/i;

function tabsOf(line: string): number {
  return /^\t*/.exec(line)![0].length;
}

function attr(name: string, tag: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
}

/** Index of the line closing the container opened at `from` (same tag, nesting aware). */
function closingLine(lines: string[], from: number, tag: string): number {
  const open = new RegExp(`^<${tag}(\\s|>|$)`);
  let depth = 0;
  for (let j = from; j < lines.length; j++) {
    const t = lines[j]!.trim();
    if (open.test(t) && !t.endsWith("/>")) depth++;
    if (t.endsWith(`</${tag}>`)) depth--;
    if (depth <= 0) return j;
  }
  return lines.length - 1;
}

/** Lines inside a container; a one-line container yields the text between its tags. */
function innerLines(lines: string[], from: number, end: number, tag: string): string[] {
  if (end > from) return lines.slice(from + 1, end);
  const one = lines[from]!.trim().replace(/^<[^>]*>/, "").replace(new RegExp(`</${tag}>$`), "");
  return one.trim() ? ["\t".repeat(tabsOf(lines[from]!) + 1) + one.trim()] : [];
}

const CALLOUT_ICONS: Record<string, string> = {
  note: "📝",
  abstract: "📋",
  info: "ℹ️",
  todo: "☑️",
  tip: "💡",
  success: "✅",
  question: "❓",
  warning: "⚠️",
  failure: "❌",
  danger: "⚡",
  bug: "🐛",
  example: "📑",
  quote: "💬",
};

const CALLOUT_ALIASES: Record<string, string> = {
  summary: "abstract",
  tldr: "abstract",
  hint: "tip",
  important: "tip",
  check: "success",
  done: "success",
  help: "question",
  faq: "question",
  caution: "warning",
  attention: "warning",
  fail: "failure",
  missing: "failure",
  error: "danger",
  cite: "quote",
};

export function calloutIcon(kind: string): string {
  const k = kind.toLowerCase();
  return CALLOUT_ICONS[CALLOUT_ALIASES[k] ?? k] ?? "📝";
}

export function calloutKind(icon: string | null): string {
  const found = Object.entries(CALLOUT_ICONS).find(([, emoji]) => emoji === icon);
  return found ? found[0] : "note";
}

function notionTable(inner: string): string[][] {
  return [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map((cell) => cell[1]!.trim()),
  );
}

/**
 * Blocks of Notion markdown. `kept`: the text is as Notion keeps it, so a nested code block's lines are read exactly as
 * they are (Notion writes them flush left); otherwise they may be the translator's, indented like their fence.
 */
export function parseNotion(lines: string[], depth = 0, kept = false): Block[] {
  const out: Block[] = [];
  let i = 0;
  const own = (line: string) => line.slice(Math.min(tabsOf(line), depth)).replace(/^\t+/, "");
  const children = (from: number): [string[], number] => {
    const kids: string[] = [];
    let j = from;
    while (j < lines.length && !blank(lines[j]!) && tabsOf(lines[j]!) > depth) {
      const fence = /^\t*(`{3,})[^`]*$/.exec(lines[j]!)?.[1];
      kids.push(lines[j++]!);
      // Notion writes the lines of a nested code block flush left: they are the block's up to its closing fence.
      if (fence) {
        while (j < lines.length) {
          const line = lines[j++]!;
          kids.push(line);
          if (line.trim() === fence) break;
        }
      }
    }
    return [kids, j];
  };
  while (i < lines.length) {
    const raw = lines[i]!;
    if (blank(raw)) {
      i++;
      continue;
    }
    const line = own(raw);
    let m: RegExpExecArray | null;
    if ((m = /^(`{3,})([^`]*)$/.exec(line))) {
      const fence = m[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && own(lines[i]!).trim() !== fence) body.push(lines[i++]!);
      i++;
      // Notion writes a nested code block's lines as they are, flush left; the translator indents them like
      // the fence (Notion takes both). Unless the text is known to be Notion's, a block whose every line is
      // indented that far is read as the translator's (the one form the two can't be told apart in).
      const indented = !kept && depth > 0 && body.every((l) => tabsOf(l) >= depth);
      out.push({ type: "code", info: m[2]!.trim(), lines: indented ? body.map((l) => l.slice(depth)) : body });
    } else if (line.trim() === "$$") {
      const body: string[] = [];
      i++;
      while (i < lines.length && own(lines[i]!).trim() !== "$$") body.push(own(lines[i++]!));
      i++;
      out.push({ type: "math", lines: body });
    } else if (/^<table\b/.test(line)) {
      const end = closingLine(lines, i, "table");
      out.push({ type: "table", rows: notionTable(lines.slice(i, end + 1).join("\n")) });
      i = end + 1;
    } else if (/^\|/.test(line) && i + 1 < lines.length && TABLE_DELIMITER.test(own(lines[i + 1]!))) {
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && /^\|/.test(own(lines[i]!))) rows.push(splitRow(own(lines[i++]!)));
      out.push({ type: "table", rows });
    } else if (/^<callout\b/.test(line)) {
      const end = closingLine(lines, i, "callout");
      const inner = innerLines(lines, i, end, "callout");
      const first = inner.findIndex((l) => !blank(l));
      const heading = first === -1 ? null : /^\*\*(.+)\*\*$/.exec(own(inner[first]!).trim());
      out.push({
        type: "callout",
        kind: calloutKind(attr("icon", line)),
        fold: "",
        title: heading ? heading[1]! : "",
        children: parseNotion(heading ? inner.slice(first + 1) : inner, depth + 1, kept),
      });
      i = end + 1;
    } else if (/^<details\b/.test(line)) {
      const end = closingLine(lines, i, "details");
      const inner = innerLines(lines, i, end, "details");
      const s = inner.findIndex((l) => /<summary>/.test(l));
      const title = s === -1 ? "" : (/<summary>([\s\S]*?)<\/summary>/.exec(inner[s]!)?.[1] ?? "");
      out.push({ type: "callout", kind: "note", fold: "-", title, children: parseNotion(s === -1 ? inner : inner.slice(s + 1), depth + 1, kept) });
      i = end + 1;
    } else if ((m = /^<(columns|column)\b/.exec(line))) {
      const end = closingLine(lines, i, m[1]!);
      out.push(...parseNotion(innerLines(lines, i, end, m[1]!), depth + 1, kept));
      i = end + 1;
    } else if ((m = /^<(synced_block|synced_block_reference)\b([^>]*)>/.exec(line))) {
      // Shared with other pages: a link, so an edit in Obsidian can't reach the other pages.
      const url = attr("url", m[2]!);
      out.push({ type: "paragraph", text: url ? `[🔁 Synced block](${url})` : "🔁 Synced block" });
      i = closingLine(lines, i, m[1]!) + 1;
    } else if ((m = /^<(page|database)\b([^>]*)>([\s\S]*?)<\/\1>/.exec(line))) {
      const url = attr("url", m[2]!) ?? "";
      const label = m[3]!.trim() || (m[1] === "page" ? "Notion page" : "Notion database");
      out.push({ type: "paragraph", text: `[${m[1] === "page" ? "📄" : "🗃"} ${label}](${url})` });
      i++;
    } else if ((m = /^<unknown\b([^>]*)\/?>/.exec(line))) {
      out.push({ type: "paragraph", text: `[${attr("alt", m[1]!) ?? "Notion block"}](${attr("url", m[1]!) ?? ""})` });
      i++;
    } else if (/^<(table_of_contents|empty-block)\b[^>]*\/?>\s*$/.test(line)) {
      i++;
    } else if ((m = /^(#{1,6})[ \t]+(.*)$/.exec(line))) {
      out.push({ type: "heading", level: m[1]!.length, text: m[2]!.replace(ATTRIBUTES, "") });
      const [kids, next] = children(i + 1);
      out.push(...parseNotion(kids, depth + 1, kept));
      i = next;
    } else if ((m = /^([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/.exec(line))) {
      let text = (m[2] ?? "").replace(ATTRIBUTES, "");
      let task: " " | "x" | null = null;
      const t = /^[-*+]$/.test(m[1]!) ? TASK.exec(text) : null;
      if (t) {
        task = t[1]!.toLowerCase() === "x" ? "x" : " ";
        text = t[2] ?? "";
      }
      const [kids, next] = children(i + 1);
      out.push({ type: "item", marker: m[1]!, task, text, children: parseNotion(kids, depth + 1, kept) });
      i = next;
    } else if ((m = /^>(?:[ \t](.*))?$/.exec(line))) {
      const [kids, next] = children(i + 1);
      out.push({ type: "quote", text: (m[1] ?? "").replace(ATTRIBUTES, ""), children: parseNotion(kids, depth + 1, kept) });
      i = next;
    } else if (/^---[ \t]*$/.test(line)) {
      out.push({ type: "divider" });
      i++;
    } else {
      out.push({ type: "paragraph", text: line.replace(ATTRIBUTES, "") });
      const [kids, next] = children(i + 1);
      out.push(...parseNotion(kids, depth + 1, kept));
      i = next;
    }
  }
  return out;
}

/** Block tags the translator carries both ways (tables, callouts, toggles), inline tags that may start a line, and empty blocks, which hold nothing. */
const CARRIED = new Set(["table", "tr", "td", "th", "thead", "tbody", "colgroup", "col", "callout", "details", "summary", "span", "br", "empty-block"]);

/** A PDF, file, audio or video line (or an image's) that points at a vault file's placeholder. */
const isPlaceholderLine = (line: string) => {
  const media = mediaLine(line);
  return media !== null && placeholderPath(media.url) !== null;
};

/**
 * The opening tags of the blocks a note can't hold, outside code: every block `parseNotion` turns into a link,
 * plain text or nothing (bookmarks and embeds, child pages, inline databases, synced blocks, files, videos,
 * audio, PDFs, tables of contents, column layouts, and any block tag it doesn't know). A write that loses one
 * would delete it from the page. Not a vault file's placeholder (`<pdf src="https://nopipeline.invalid/vault/…">`): it is an attachment
 * the sync carries, and every file it knows reads that way in a page's canonical text. A hosted tag still written with Notion's URL is a
 * file the sync has not taken (an unsupported name, one not downloaded yet), and a web one (`<video src="https://youtu.be/…">`) is
 * Notion's own: both stay blocks a note can't hold.
 */
export function notionOnlyBlocks(markdown: string): string[] {
  const tags: string[] = [];
  let fence: string | null = null;
  for (const raw of markdown.split("\n")) {
    const line = raw.replace(/^\t+/, "");
    if (fence !== null) {
      if (line.trim() === fence) fence = null;
      continue;
    }
    const open = /^(`{3,})[^`]*$/.exec(line);
    if (open) fence = open[1]!;
    else {
      const tag = /^<([a-z][a-z0-9_-]*)\b[^>]*>/i.exec(line);
      const name = tag?.[1]!.toLowerCase();
      if (tag && !CARRIED.has(name!) && !name!.startsWith("mention-") && !isPlaceholderLine(line)) tags.push(tag[0]);
    }
  }
  return tags;
}

// --- Writers ---------------------------------------------------------------

export type Inline = (text: string) => string;

function fenceFor(lines: string[]): string {
  const longest = Math.max(2, ...lines.map((l) => /^\s*(`+)/.exec(l)?.[1]!.length ?? 0));
  return "`".repeat(longest + 1);
}

export function writeNotion(blocks: Block[], inline: Inline, depth = 0): string[] {
  const tab = "\t".repeat(depth);
  const text = (s: string) => inline(s).replace(/\n/g, "<br>");
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "paragraph":
        if (b.text.trim() !== "") out.push(tab + text(b.text));
        break;
      case "heading":
        out.push(`${tab}${"#".repeat(Math.min(b.level, 4))} ${text(b.text)}`);
        break;
      case "item": {
        const marker = /^\d/.test(b.marker) ? `${b.marker.slice(0, -1)}.` : "-";
        const task = b.task === null ? "" : `[${b.task}] `;
        out.push(`${tab}${marker} ${task}${text(b.text)}`.trimEnd());
        out.push(...writeNotion(b.children, inline, depth + 1));
        break;
      }
      case "code": {
        // An empty block with the empty line Notion writes in one (live probe).
        const fence = fenceFor(b.lines);
        out.push(tab + fence + b.info, ...(b.lines.length ? b.lines : [""]).map((l) => tab + l), tab + fence);
        break;
      }
      case "math":
        out.push(`${tab}$$`, ...b.lines.map((l) => tab + l), `${tab}$$`);
        break;
      case "table":
        out.push(`${tab}<table header-row="true">`);
        const width = Math.max(...b.rows.map((r) => r.length));
        for (const row of b.rows) {
          const cells = Array.from({ length: width }, (_, k) => row[k] ?? "");
          out.push(`${tab}\t<tr>`, ...cells.map((cell) => `${tab}\t\t<td>${text(cell)}</td>`), `${tab}\t</tr>`);
        }
        out.push(`${tab}</table>`);
        break;
      case "quote":
        out.push(`${tab}> ${text(b.text)}`.trimEnd(), ...writeNotion(b.children, inline, depth + 1));
        break;
      case "callout":
        if (b.fold === "") {
          out.push(`${tab}<callout icon="${calloutIcon(b.kind)}">`);
          if (b.title) out.push(`${tab}\t**${text(b.title)}**`);
          out.push(...writeNotion(b.children, inline, depth + 1), `${tab}</callout>`);
        } else {
          const title = b.title || b.kind.charAt(0).toUpperCase() + b.kind.slice(1);
          out.push(`${tab}<details>`, `${tab}<summary>${text(title)}</summary>`, ...writeNotion(b.children, inline, depth + 1), `${tab}</details>`);
        }
        break;
      case "divider":
        out.push(`${tab}---`);
        break;
      case "media":
        out.push(b.kind === "image" ? `${tab}![${text(b.caption)}](${b.target})` : `${tab}<${b.kind} src="${b.target}">${text(b.caption)}</${b.kind}>`);
        break;
    }
  }
  return out;
}

function tableCell(cell: string): string {
  return cell.replace(/\n/g, "<br>").replace(/(^|[^\\])\|/g, "$1\\|");
}

export function writeObsidian(blocks: Block[], inline: Inline): string[] {
  const out: string[] = [];
  blocks.forEach((b, n) => {
    const previous = blocks[n - 1];
    if (previous && !(previous.type === "item" && b.type === "item")) out.push("");
    switch (b.type) {
      case "paragraph":
        out.push(...inline(b.text).split("\n"));
        break;
      case "heading":
        out.push(`${"#".repeat(b.level)} ${inline(b.text)}`);
        break;
      case "item": {
        // An item that holds nothing but a file first is written with the citation on its line (`- ![c](path)`).
        const [head, ...after] = b.children;
        const lead = b.text === "" && b.task === null && head?.type === "media" ? head : null;
        const [first = "", ...rest] = lead ? writeObsidian([lead], inline) : inline(b.text).split("\n");
        const task = b.task === null ? "" : `[${b.task}] `;
        out.push(`${b.marker} ${task}${first}`.trimEnd(), ...rest.map((l) => `\t${l}`));
        out.push(...writeObsidian(lead ? after : b.children, inline).map((l) => (l === "" ? "" : `\t${l}`)));
        break;
      }
      case "code": {
        const fence = fenceFor(b.lines);
        out.push(fence + b.info, ...b.lines, fence);
        break;
      }
      case "math":
        out.push("$$", ...b.lines, "$$");
        break;
      case "table": {
        const width = Math.max(...b.rows.map((r) => r.length));
        const row = (cells: string[]) => `| ${Array.from({ length: width }, (_, k) => tableCell(inline(cells[k] ?? ""))).join(" | ")} |`;
        out.push(row(b.rows[0] ?? []), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...b.rows.slice(1).map(row));
        break;
      }
      case "quote": {
        if (b.text !== "" || b.children.length === 0) out.push(...inline(b.text).split("\n").map((l) => `> ${l}`.trimEnd()));
        const inner = writeObsidian(b.children, inline);
        // A code fence may follow the quote's text directly; any other block needs a blank quote line first.
        if (inner.length && b.text !== "" && b.children[0]!.type !== "code") out.push(">");
        out.push(...inner.map((l) => (l === "" ? ">" : `> ${l}`)));
        break;
      }
      case "callout": {
        out.push(`> [!${b.kind}]${b.fold}${b.title ? ` ${inline(b.title)}` : ""}`);
        out.push(...writeObsidian(b.children, inline).map((l) => (l === "" ? ">" : `> ${l}`)));
        break;
      }
      case "divider":
        out.push("---");
        break;
      case "media":
        // A caption can't be more than one line.
        out.push(`${b.link ? "" : "!"}[${inline(b.caption).replace(/\n/g, " ")}](${b.target})`);
        break;
    }
  });
  return out;
}
