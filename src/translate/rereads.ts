// Lines Notion holds as written but reads back as something else the next time the page is written.
import { emphasisSpans, linkTextRereads } from "./inline.ts";

/** The characters Notion keeps a backslash before; it drops any other when it writes a page back as markdown. */
const KEPT_ESCAPES = "\\*~`$[]<>{}|^";

/** `text` as Notion writes it back: without the backslashes it drops. */
const dropped = (text: string) => text.replace(/\\([\s\S])/g, (whole, c: string) => (KEPT_ESCAPES.includes(c) ? whole : c));

/** What starts a heading, a list item or a divider in markdown. */
const BLOCK = /^(?:#{1,6}(?:[ \t]|$)|[-+*](?:[ \t]|$)|\d{1,9}\.(?:[ \t]|$)|(?:-[ \t]*){3,}$|(?:_[ \t]*){3,}$)/;

/** `text` with its code spans, inline math and tags blanked out: no link is read inside them. */
const blankCode = (text: string) => text.replace(/(?<!\\)(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|<[^>\n]*>/g, (m) => " ".repeat(m.length));

/** A link: its text and target. */
const LINK = /(?<![\\!])\[((?:[^\]\\\n]|\\.)+)\]\(([^)\s]+)\)/g;

/**
 * What Notion would make of the links of `text` (live probe): a bare URL it links only up to where
 * underscores or stars in it pair as emphasis (`…/main/__init__.py` as a link to `…/main/` and a bold "init"), and a
 * link's text whose underscores pair it reads as italics or bold (its markdown drops their backslashes). Null when
 * neither.
 */
function linkRereads(text: string): string | null {
  const plain = blankCode(text);
  for (const m of plain.matchAll(LINK)) if (linkTextRereads(m[1]!)) return "italics or bold in a link's text";
  const bare = plain.replace(LINK, (m) => " ".repeat(m.length));
  for (const m of bare.matchAll(/(?<![\p{L}\p{N}_])(?:https?:\/\/|www\.)[^\s<>]+/giu)) {
    if (emphasisSpans(m[0].replace(/^(?:https?:\/\/|www\.)/i, "")).length) return "a link cut short where its underscores or stars pair";
  }
  return null;
}

/** Why Notion would read `line` (a line of text, its indentation off) back as something else, or null. */
function rereads(line: string): string | null {
  // A list item's or a quote's own marker, and the text after it.
  const marker = /^(?:-[ \t]+(?:\[[ x]\][ \t]+)?|\d{1,9}\.[ \t]+|>[ \t]?)/.exec(line)?.[0] ?? "";
  const text = line.slice(marker.length);
  if (BLOCK.test(dropped(text)) && !BLOCK.test(text)) return "a heading, a list item or a divider";
  if (/^\+[ \t]/.test(line)) return "a list item";
  // A code span holding a backtick: Notion has no form for it.
  for (const m of text.matchAll(/(?<!\\)(`+)((?:[^`]|[^`][\s\S]*?[^`]))\1(?!`)/g)) if (m[1]!.length > 1 && m[2]!.includes("`")) return "a code span holding a backtick";
  if (/(?<!\\)`[^`\n]*\\`[^`\n]*`/.test(text)) return "a code span holding a backtick";
  // Underscores that pair (Notion writes italics with `*`, so in its text they are literal), and italics around bold
  // (Notion writes them `*a **b** c*` and reads that back as italics only).
  const spans = emphasisSpans(dropped(text));
  // (Bold and italics over the same words, `***x***`, Notion reads back as they are.)
  const around = (s: { open: number; close: number }, t: { open: number; close: number }) => t.open > s.open && t.close < s.close && (t.open > s.open + 1 || t.close + 2 < s.close);
  if (spans.some((s) => s.use === 1 && spans.some((t) => t.use === 2 && around(s, t)))) return "other emphasis (Notion can't hold italics around bold)";
  if (spans.some((s) => s.char === "_")) return "italics";
  return linkRereads(text);
}

/**
 * The lines of `markdown` (a page's markdown, the translator's or Notion's) that Notion holds as they are written but
 * reads back as something else the next time the page is written (live probe: one `update_content` edit
 * reads every line of the page again from its markdown, and Notion's markdown drops escapes): a paragraph holding a
 * literal `# x`, `- x`, `+ x`, `1. x` or `---`, underscores that pair, italics around bold, a code span holding a
 * backtick. Code blocks and block equations are left out.
 */
export function rereadByNotion(markdown: string): string[] {
  return rereadLines(markdown).map((r) => r.line);
}

/** `rereadByNotion`, each line with what Notion would read it back as. */
export function rereadLines(markdown: string): { line: string; as: string }[] {
  const found: { line: string; as: string }[] = [];
  let fence: string | null = null;
  let math = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.replace(/^\t+/, "");
    const open = /^(`{3,})[^`]*$/.exec(line);
    if (fence !== null) {
      if (line.trim() === fence) fence = null;
      continue;
    }
    if (open) {
      fence = open[1]!;
      continue;
    }
    if (line.trim() === "$$") {
      math = !math;
      continue;
    }
    const as = math ? null : rereads(line);
    if (as !== null) found.push({ line: raw, as });
  }
  return found;
}
