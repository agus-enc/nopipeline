// Line-based merging: move one side's edits onto the other side's text, and git-style three-way merges.
import { LCS, diff3Merge, diffIndices } from "node-diff3";
import { idFromUrl } from "../notion/ids.ts";
import { itemCode, itemFence, splitRow } from "../translate/blocks.ts";
import { autolinksShown, mentionsShown } from "../translate/inline.ts";
import { notionLanguage } from "../translate/languages.ts";

const blank = (line: string) => line.trim() === "";
const range = (start: number, end: number) => Array.from({ length: Math.max(0, end - start) }, (_, k) => start + k);

// --- The layout around a line's text --------------------------------------------------------------

const ATTRIBUTES = /[ \t]*\{(?:[a-z_-]+="[^"]*"[ \t]*)+\}$/i;
const MARKER = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]+\[[ xX]\])?(?:[ \t]+|$)/;

interface Parts {
  /** Indentation. */
  lead: string;
  /** A list marker and task box, with the spaces after them. */
  marker: string;
  text: string;
  /** A Notion attribute list at the end, like ` {color="blue"}`. */
  attributes: string;
  /** Trailing spaces (two of them are a Markdown hard break). */
  trail: string;
}

function parts(line: string): Parts {
  const lead = /^[ \t]*/.exec(line)![0];
  let end = line.length;
  while (end > lead.length && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  const trail = line.slice(end);
  let rest = line.slice(lead.length, end);
  const attributes = ATTRIBUTES.exec(rest)?.[0] ?? "";
  rest = rest.slice(0, rest.length - attributes.length);
  const marker = MARKER.exec(rest)?.[0] ?? "";
  return { lead, marker, text: rest.slice(marker.length), attributes, trail };
}

/** A list marker read the same whatever its form: `*`, `+` and `-` alike, `1)` as `1.`, `[X]` as `[x]`. */
function markerKey(marker: string): string {
  const m = /^([-*+]|\d{1,9}[.)])(?:[ \t]+\[([ xX])\])?/.exec(marker)!;
  const bullet = /^[-*+]$/.test(m[1]!) ? "-" : `${m[1]!.slice(0, -1)}.`;
  return m[2] === undefined ? bullet : `${bullet} [${m[2].toLowerCase()}]`;
}

/**
 * A line's Notion forms that say the same thing in one form each: page mentions and Notion page URLs reduced
 * to page ids (with or without the title Notion sometimes puts in a mention), date, person and database mentions
 * written as Obsidian shows them, and the links Notion makes of bare URLs and domain-like words as their text.
 */
export function samePages(text: string): string {
  return mentionsShown(autolinksShown(text))
    .replace(/<mention-page\s+url="([^"]*)"[^>]*?(?:\/>|>[\s\S]*?<\/mention-page>)/g, (_m, url: string) => `<mention-page ${idFromUrl(url) ?? url}/>`)
    .replace(/\]\((https?:\/\/[^)\s]*notion\.(?:so|com|site)\/[^)\s]*)\)/g, (_m, url: string) => `](${idFromUrl(url) ?? url})`);
}

/**
 * A line without layout, read the way Markdown reads it: indentation, trailing spaces and Notion attribute
 * lists dropped, list markers, task boxes, heading and quote markers, thematic breaks and table cells in one
 * form each, Notion page URLs and mention tags reduced to page ids, and date and person mentions as text.
 */
export function lineKey(line: string): string {
  const { marker, text: raw } = parts(line.normalize("NFC"));
  if (/^([-*_])(?:[ \t]*\1){2,}$/.test(marker + raw)) return "---";
  const text = samePages(raw);
  if (marker) return text ? `${markerKey(marker)} ${text}` : markerKey(marker);
  const heading = /^(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?$/.exec(text);
  if (heading) return heading[2] ? `${heading[1]} ${heading[2]}` : heading[1]!;
  if (text.startsWith(">")) return `> ${lineKey(text.slice(1))}`.trimEnd();
  if (text.startsWith("|")) return `| ${splitRow(text).map((cell) => (/^:?-+:?$/.test(cell) ? "---" : cell)).join(" | ")} |`;
  return text;
}

/**
 * The words a reader sees on a line: link syntax reduced to its display text, tags and punctuation dropped.
 * A reference to a Notion page also counts as a word of its own (its id), whatever text shows for it.
 */
export function looseKey(line: string): string {
  const page = (id: string) => ` page${id.replace(/-/g, "")} `;
  // A callout's type shows as its icon, not as words.
  const visible = samePages(parts(line.normalize("NFC")).text.replace(/^((?:>[ \t]?)+)[ \t]*\[![^\]\s]*\][+-]?/, "$1"))
    .replace(/<mention-page ([0-9a-f-]{36})\/>/g, (_m, id: string) => page(id))
    .replace(/!?\[\[([^\]\n]+?)\]\]/g, (_m, inner: string) => {
      const plain = inner.replace(/\\\|/g, "|");
      const pipe = plain.indexOf("|");
      return pipe === -1 ? plain : plain.slice(pipe + 1);
    })
    .replace(/!?\[((?:[^[\]\n]|\\[[\]])*)\]\(([^)\n]*)\)/g, (_m, label: string, dest: string) => (/^[0-9a-f-]{36}$/.test(dest) ? `${label}${page(dest)}` : label))
    .replace(/<[^>\n]*>/g, " ");
  return (visible.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
}

const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/;
const OPENS_BLOCK = /^[ \t]*(?:[-*+][ \t]|\d{1,9}[.)][ \t]|#{1,6}(?:[ \t]|$)|>|\||`{3,}|~{3,}|\$\$)/;
const DIVIDER = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** Which app's markdown a text is in: a note's (Obsidian) or a page's (Notion). */
export type Dialect = "note" | "page";

/**
 * Obsidian forms whose syntax spans lines the translator writes differently (`~~~` fences, `$$` on a line
 * with the formula, and, in a note, headings underlined with `===` or `---`): editing such a line one for one
 * would break its block, so it is only ever matched exactly. In a page, `---` after a paragraph is a divider.
 */
function spansLines(lines: string[], i: number, dialect: Dialect): boolean {
  const line = lines[i]!;
  const t = line.trim();
  if (/^~{3,}/.test(t)) return true;
  if (t !== "$$" && (t.startsWith("$$") || t.endsWith("$$"))) return true;
  if (dialect === "page") return false;
  const paragraph = (l: string | undefined) => l !== undefined && !blank(l) && !OPENS_BLOCK.test(l) && !DIVIDER.test(l);
  if (SETEXT.test(line) && paragraph(lines[i - 1])) return true;
  return paragraph(line) && lines[i + 1] !== undefined && SETEXT.test(lines[i + 1]!);
}

/**
 * Code in either app's markdown: fenced code blocks and `$$` formulas, including their fence lines, wherever
 * they sit (after `>` quote markers, or indented by tabs as Notion nests them). For each line, whether it is
 * code, and its key: a code line's text inside its block, blank or not, so the same code compares equal in
 * every form it is written in (a note indents a block's lines like its fence, the translator's Notion markdown
 * too, and Notion writes a nested block's lines flush left).
 */
function codeShape(lines: string[]): { code: boolean[]; keys: string[]; blockOf: number[]; lead: (string | null)[]; writer: (((code: string) => string) | null)[] } {
  const code = new Array<boolean>(lines.length).fill(false);
  const keys = lines.map(lineKey);
  /** For a line inside a code block (not a fence), the line its block opens on; -1 for others. */
  const blockOf = new Array<number>(lines.length).fill(-1);
  /** For a block's opening line, what its code lines start with that isn't code: the fence's indentation where they all have it. */
  const lead = new Array<string | null>(lines.length).fill(null);
  /** For a block's opening line, how a line of code is written in that block: after its quote markers and its lead. */
  const writer = new Array<((code: string) => string) | null>(lines.length).fill(null);
  /** A line without its first `depth` quote markers: a code line inside a quote is what follows the quote's own. */
  const strip = (line: string, depth = Infinity) => {
    let rest = line;
    for (let n = 0; n < depth; n++) {
      const marker = /^[ \t]{0,3}> ?/.exec(rest);
      if (!marker) break;
      rest = rest.slice(marker[0].length);
    }
    return rest;
  };
  /** How many quote markers a line starts with: a code block inside a quote ends where the quote does. */
  const quotes = (line: string) => (/^(?:[ \t]{0,3}> ?)+/.exec(line)?.[0].match(/>/g) ?? []).length;
  for (let i = 0; i < lines.length; i++) {
    const depth = quotes(lines[i]!);
    const content = strip(lines[i]!, depth);
    const indent = /^[ \t]*/.exec(content)![0];
    const opener = content.slice(indent.length).trimEnd();
    let fence = /^(`{3,})([^`]*)$|^(~{3,})(.*)$/.exec(opener);
    const math = !fence && opener.startsWith("$$") && (opener === "$$" || !opener.endsWith("$$") || opener.length < 4);
    // A list item may open a fence on its own line (`- ```python`, see `parseObsidian`): its code lines lose the
    // item's indentation, and the block runs to its closing fence or to the end of the quote it is in.
    const item = fence || math ? null : itemFence(content.trimEnd());
    if (item) fence = /^(`{3,})([^`]*)$|^(~{3,})(.*)$/.exec(`${item.fence}${item.info}`);
    if (!fence && !math) continue;
    const mark = fence ? (fence[1] ?? fence[3]!) : "$$";
    const closes = (l: string) => (fence ? new RegExp(`^${mark[0] === "~" ? "~" : "`"}{${mark.length},}$`).test(l) : l.endsWith("$$"));
    let end = i + 1;
    while (end < lines.length && quotes(lines[end]!) >= depth && !closes(strip(lines[end]!, depth).trim())) end++;
    const closed = end < lines.length && quotes(lines[end]!) >= depth;
    const body = lines.slice(i + 1, end).map((l) => strip(l, depth));
    const indented = !item && body.every((l) => l.startsWith(indent));
    // A list item's fence: its code as the parser reads it, without the item's width only where every line has it.
    const itemLines = item ? itemCode(body, item.shift) : null;
    const carries = itemLines !== null && itemLines !== body;
    // A backtick fence is keyed by the language Notion keeps the block under (an untagged one is javascript).
    const info = fence ? (fence[2] ?? fence[4]!) : "";
    code[i] = true;
    keys[i] = `\u0001${fence ? mark + (mark[0] === "`" ? notionLanguage(info) : info.trim()) : opener}`;
    lead[i] = indented ? indent : "";
    const markers = lines[i]!.slice(0, lines[i]!.length - content.length);
    writer[i] = (line: string) => {
      // An item's code line takes the item's width only where every line of the block has it.
      const text = (item ? (carries && line !== "" ? " ".repeat(item.shift) : "") : indented ? indent : "") + line;
      // A space right after `>` belongs to the quote marker: one the code starts with needs one before it.
      return markers + (markers.endsWith(">") && text.startsWith(" ") ? " " : "") + text;
    };
    body.forEach((l, n) => {
      code[i + 1 + n] = true;
      keys[i + 1 + n] = `\u0002${(itemLines ? itemLines[n]! : indented ? l.slice(indent.length) : l).trimEnd()}`;
      blockOf[i + 1 + n] = i;
    });
    if (closed) {
      code[end] = true;
      keys[end] = `\u0001${strip(lines[end]!, depth).trim()}`;
    }
    i = closed ? end : end - 1;
  }
  return { code, keys, blockOf, lead, writer };
}

/**
 * In a note, a heading underlined with `===` or `---` is written as one `#` line by the translator: its lines
 * pair with nothing, so no edit is placed on them one for one and no other line takes them for its own.
 */
function headingKeys(lines: string[], shape: { code: boolean[]; keys: string[] }): void {
  const paragraph = (k: number) => k >= 0 && k < lines.length && !shape.code[k] && !blank(lines[k]!) && !OPENS_BLOCK.test(lines[k]!) && !DIVIDER.test(lines[k]!);
  for (let k = 1; k < lines.length; k++) {
    if (shape.code[k] || !SETEXT.test(lines[k]!) || !paragraph(k - 1)) continue;
    for (let j = k; j === k || paragraph(j); j--) shape.keys[j] = `\u0003${j}`;
  }
}

/** For each line, its code key when it is code (equal for the same code in every form it is written in), else null. */
export function codeKeys(lines: string[]): (string | null)[] {
  const { code, keys } = codeShape(lines);
  return keys.map((key, k) => (code[k] ? key : null));
}

// --- Counterparts -----------------------------------------------------------------------------------

/** Matches `a[fs..fe)` to `b[ts..te)` by their longest common subsequence. */
function match(map: number[], a: string[], b: string[], [fs, fe, ts, te]: Gap): void {
  let link: ReturnType<typeof LCS> | null = LCS(a.slice(fs, fe), b.slice(ts, te));
  while (link && link.buffer1index >= 0) {
    map[fs + link.buffer1index] = ts + link.buffer2index;
    link = link.chain;
  }
}

/** `[fromStart, fromEnd, toStart, toEnd)`: lines on both sides between two matched lines, all unmatched. */
type Gap = [number, number, number, number];

function gaps(map: number[], toLength: number): Gap[] {
  const found: Gap[] = [];
  let fs = 0;
  let ts = 0;
  for (let k = 0; k <= map.length; k++) {
    if (k < map.length && map[k]! < 0) continue;
    const te = k < map.length ? map[k]! : toLength;
    if (k > fs && te > ts) found.push([fs, k, ts, te]);
    fs = k + 1;
    ts = te + 1;
  }
  return found;
}

/** A key that matches nothing. */
const none = (side: string, k: number) => `\u0000${side}${k}`;

/** Enough of the words a reader sees to tell a line apart: four letters or digits, not one short token. */
const telling = (key: string) => key.replace(/ /g, "").length >= 4;

/** Indices into `seq` of a longest strictly increasing subsequence. */
function increasing(seq: number[]): number[] {
  const tails: number[] = [];
  const before = new Array<number>(seq.length).fill(-1);
  seq.forEach((value, k) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]!]! < value) lo = mid + 1;
      else hi = mid;
    }
    before[k] = lo > 0 ? tails[lo - 1]! : -1;
    tails[lo] = k;
  });
  const out: number[] = [];
  for (let k = tails.length ? tails[tails.length - 1]! : -1; k !== -1; k = before[k]!) out.unshift(k);
  return out;
}

function tally(keys: string[]): Map<string, number> {
  const seen = new Map<string, number>();
  for (const key of keys) seen.set(key, (seen.get(key) ?? 0) + 1);
  return seen;
}

/**
 * Pairs the lines `ia` of one side with the lines `ib` of the other (each in order) by equal keys, only where
 * the pairing is certain: the shared start and end; keys found once on each side (in order), with the same
 * rule between them; and, where no key is found once, the remaining lines if, once the keys only one side
 * has are set aside, both sides hold the same keys in the same order.
 */
function anchor(map: number[], ka: string[], kb: string[], ia: number[], ib: number[]): void {
  let s = 0;
  let t = 0;
  let ea = ia.length;
  let eb = ib.length;
  while (s < ea && t < eb && ka[ia[s]!] === kb[ib[t]!]) map[ia[s++]!] = ib[t++]!;
  while (ea > s && eb > t && ka[ia[ea - 1]!] === kb[ib[eb - 1]!]) map[ia[--ea]!] = ib[--eb]!;
  const a = ia.slice(s, ea);
  const b = ib.slice(t, eb);
  if (a.length === 0 || b.length === 0) return;
  const countA = tally(a.map((k) => ka[k]!));
  const countB = tally(b.map((k) => kb[k]!));
  const at = new Map(b.map((k, n) => [kb[k]!, n]));
  const pairs: [number, number][] = [];
  a.forEach((k, n) => {
    if (countA.get(ka[k]!) === 1 && countB.get(ka[k]!) === 1) pairs.push([n, at.get(ka[k]!)!]);
  });
  if (pairs.length) {
    let pa = 0;
    let pb = 0;
    for (const x of increasing(pairs.map(([, m]) => m))) {
      const [n, m] = pairs[x]!;
      anchor(map, ka, kb, a.slice(pa, n), b.slice(pb, m));
      map[a[n]!] = b[m]!;
      pa = n + 1;
      pb = m + 1;
    }
    anchor(map, ka, kb, a.slice(pa), b.slice(pb));
    return;
  }
  const left = a.filter((k) => countB.has(ka[k]!));
  const right = b.filter((k) => countA.has(kb[k]!));
  if (left.length === right.length && left.every((k, n) => ka[k] === kb[right[n]!])) left.forEach((k, n) => (map[k] = right[n]!));
}

/**
 * For each line of `from`, the index of its counterpart in `to` (the same line in another form), or -1.
 * `dialect` is the markdown `to` is written in. Three passes, each only inside the gaps the previous one left:
 * exact keys, where the pairing is certain (see `anchor`); then the words a reader sees, where those words
 * tell the line apart (enough of them, found once on each side of the gap); then, where a gap holds as many
 * non-blank lines on both sides, those lines in order, if every pair shares words (or neither line has any).
 * Code, blank code lines included, is only ever matched by its exact keys, with the indentation inside its
 * block. Blank lines between blocks, which would otherwise pair across the text, are matched last.
 */
export function counterparts(from: string[], to: string[], dialect: Dialect = "note"): number[] {
  const map = new Array<number>(from.length).fill(-1);
  const shapeA = codeShape(from);
  const shapeB = codeShape(to);
  if (dialect === "note") {
    headingKeys(from, shapeA);
    headingKeys(to, shapeB);
  }
  const sepA = separators(from, dialect);
  const sepB = separators(to, dialect);
  anchor(
    map,
    shapeA.keys,
    shapeB.keys,
    range(0, from.length).filter((k) => !sepA[k]),
    range(0, to.length).filter((t) => !sepB[t]),
  );

  const codeA = shapeA.code;
  const codeB = shapeB.code;
  const looseA = from.map((line, k) => (sepA[k] ? "" : looseKey(line)));
  const looseB = to.map((line, t) => (sepB[t] ? "" : looseKey(line)));
  for (const [fs, fe, ts, te] of gaps(map, to.length)) {
    // A key counts once per line on its side of the gap, code and multi-line forms included.
    const left = tally(looseA.slice(fs, fe).filter(Boolean));
    const right = tally(looseB.slice(ts, te).filter(Boolean));
    const at = new Map<string, number>();
    for (let t = ts; t < te; t++) if (looseB[t] && !codeB[t] && !spansLines(to, t, dialect)) at.set(looseB[t]!, t);
    const pairs: [number, number][] = [];
    for (let k = fs; k < fe; k++) {
      const key = looseA[k]!;
      if (!key || codeA[k] || !telling(key) || left.get(key) !== 1 || right.get(key) !== 1 || !at.has(key)) continue;
      pairs.push([k, at.get(key)!]);
    }
    for (const n of increasing(pairs.map(([, t]) => t))) map[pairs[n]![0]] = pairs[n]![1];
  }

  const shared = (x: string, y: string) => {
    if (!x || !y) return !x && !y;
    const words = new Set(x.split(" "));
    return y.split(" ").some((w) => words.has(w));
  };
  for (const [fs, fe, ts, te] of gaps(map, to.length)) {
    const left = range(fs, fe).filter((k) => !sepA[k]);
    const right = range(ts, te).filter((t) => !sepB[t]);
    if (left.length !== right.length) continue;
    if (left.some((k) => codeA[k]) || right.some((t) => codeB[t] || spansLines(to, t, dialect))) continue;
    if (left.every((k, n) => shared(looseA[k]!, looseB[right[n]!]!))) left.forEach((k, n) => (map[k] = right[n]!));
  }

  // A blank line pairs with a blank line, a blank quote line with one of the same depth.
  const blanksA = from.map((line, k) => (sepA[k] ? quoteMarks(line) : none("a", k)));
  const blanksB = to.map((line, t) => (sepB[t] ? quoteMarks(line) : none("b", t)));
  for (const gap of gaps(map, to.length)) match(map, blanksA, blanksB, gap);
  return map;
}

/** Lines that only keep blocks apart, which are matched last and never need a counterpart: blank lines, and in a note, blank quote lines (`>`). */
export function separators(lines: string[], dialect: Dialect): boolean[] {
  const { code } = codeShape(lines);
  return lines.map((line, k) => !code[k] && (blank(line) || (dialect === "note" && /^(?:[ \t]{0,3}>)+[ \t]*$/.test(line))));
}

// --- Transplant ---------------------------------------------------------------------------------------

/** The edited line, keeping the layout the target had wherever the edit didn't change it. */
function relayout(base: string, changed: string, target: string): string {
  if (blank(changed)) return changed;
  const b = parts(base);
  const c = parts(changed);
  const t = parts(target);
  const lead = c.lead === b.lead ? t.lead : c.lead;
  const marker = c.marker === b.marker && b.marker !== "" && t.marker !== "" && markerKey(t.marker) === markerKey(b.marker) ? t.marker : c.marker;
  const attributes = c.attributes === b.attributes ? t.attributes : c.attributes;
  const trail = c.trail === b.trail ? t.trail : c.trail;
  return lead + marker + c.text + attributes + trail;
}

const lead = (line: string) => /^[ \t]*/.exec(line)![0];
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
/** How deep Notion nests a line: its leading tabs. */
const tabs = (line: string) => /^\t*/.exec(line)![0].length;
/** How far a note indents a line, in columns (a tab reaches the next multiple of four). */
function columns(line: string): number {
  let width = 0;
  for (const c of lead(line)) width += c === "\t" ? 4 - (width % 4) : 1;
  return width;
}
/** Headings and thematic breaks (in a quote too) need no blank line before or after them. */
const closesBlock = (line: string) => /^(#{1,6}( |$)|---$)/.test(lineKey(line).replace(/^(?:> ?)+/, ""));

/** How many lines `a` and `b` share at the start, and then at the end (the two never overlap). */
function common(a: string[], b: string[]): [number, number] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return [head, tail];
}

/** The changed regions between `a` and `b`, found after setting aside their shared start and end. */
function hunks(a: string[], b: string[]): { buffer1: [number, number]; buffer2: [number, number] }[] {
  const [head, tail] = common(a, b);
  return diffIndices(a.slice(head, a.length - tail), b.slice(head, b.length - tail)).map((h) => ({
    buffer1: [h.buffer1[0] + head, h.buffer1[1]],
    buffer2: [h.buffer2[0] + head, h.buffer2[1]],
  }));
}

/**
 * One line of the result: a target line kept as it is, a counterpart replaced one for one, or a line the edit
 * added; `from` is its line in `changed` (none for a line only the target has). `edit` marks where an edit
 * removed lines.
 */
type Piece =
  | { kind: "kept"; t: number; from?: number | undefined }
  | { kind: "replaced"; t: number; text: string; from: number }
  | { kind: "added"; text: string; from: number }
  | { kind: "edit" };

/**
 * Where lines inserted at `base[start]` go in the target: right after the counterpart of the nearest line
 * before them (or of a blank line between the two), else right before the counterpart of the next one. Null
 * when that line has no counterpart. `sep` marks the blank lines between blocks.
 */
function insertionPoint(map: number[], sep: boolean[], start: number, end: number): number | null {
  const matchedBefore = (from: number) => {
    let q = start - 1;
    while (q >= from && map[q]! < 0) q--;
    return q;
  };
  let p = start - 1;
  while (p >= 0 && sep[p]) p--;
  if (p >= 0) return map[p]! < 0 ? null : map[matchedBefore(p)]! + 1;
  const q = matchedBefore(0);
  if (q >= 0) return map[q]! + 1;
  let r = end;
  while (r < sep.length && sep[r]) r++;
  if (r === sep.length) return 0;
  if (map[r]! < 0) return null;
  let s = end;
  while (map[s]! < 0) s++;
  return map[s]!;
}

function place(base: string[], changed: string[], target: string[], keep: ((line: string, old: string) => string) | undefined, dialect: Dialect): Piece[] | null {
  const map = counterparts(base, target, dialect);
  const sepBase = separators(base, dialect);
  const sepTarget = separators(target, dialect);
  const codeBase = codeShape(base).code;
  const shapeTarget = codeShape(target);
  const codeTarget = shapeTarget.code;
  const shapeChanged = codeShape(changed);
  const owner = new Map<number, number>();
  map.forEach((t, k) => t >= 0 && owner.set(t, k));
  const found = hunks(base, changed);
  // The line of `changed` each line of `base` the edit leaves alone becomes, and the other way round.
  const kept = new Map<number, number>();
  let b = 0;
  let c = 0;
  for (const { buffer1, buffer2 } of [...found, { buffer1: [base.length, 0], buffer2: [changed.length, 0] } as const]) {
    while (b < buffer1[0]) kept.set(b++, c++);
    b = buffer1[0] + buffer1[1];
    c = buffer2[0] + buffer2[1];
  }
  const keptFrom = new Map([...kept].map(([k, n]) => [n, k]));
  /**
   * Whether every line of the code block of `changed` that opens at `open` would start, as Notion keeps it, with at
   * least as many tabs as the block is nested (`was`, its fence's tabs): Notion's form reads such a block one tab
   * short, while the translator's form is read, and taken by Notion, exactly.
   */
  const tabLed = (open: number, was: string): boolean => {
    const depth = /^\t*/.exec(was)![0].length;
    let k = open + 1;
    while (k < changed.length && shapeChanged.blockOf[k] === open && /^\t*/.exec(changed[k]!.slice(was.length))![0].length >= depth) k++;
    return depth > 0 && k > open + 1 && (k === changed.length || shapeChanged.blockOf[k] !== open);
  };
  /**
   * In a page, a code line the edit writes inside a code block the target already has, with that block's own
   * indentation: Notion writes a nested block's lines flush left, the translator indents them like the fence. A
   * block left with every line tab-led is written as the translator writes it (see `tabLed`).
   */
  const inBlock = (n: number): string | null => {
    const open = shapeChanged.blockOf[n]!;
    const from = open < 0 ? undefined : keptFrom.get(open);
    const t = from === undefined ? -1 : map[from]!;
    const [was, now] = [shapeChanged.lead[open], t < 0 ? null : shapeTarget.lead[t]];
    if (dialect !== "page" || was === null || was === undefined || now === null || now === undefined || !changed[n]!.startsWith(was)) return null;
    return tabLed(open, was) ? changed[n]! : now + changed[n]!.slice(was.length);
  };
  /**
   * In a note, a code line the edit writes inside a code block the target already has, in that block's own form:
   * after its quote markers and the indentation its lines share (a list item's fence takes the item's off them).
   */
  const inNoteBlock = (n: number): string | null => {
    const open = shapeChanged.blockOf[n]!;
    const from = open < 0 ? undefined : keptFrom.get(open);
    const t = from === undefined ? -1 : map[from]!;
    const write = t < 0 || !shapeTarget.code[t] ? null : shapeTarget.writer[t];
    // The key leaves out trailing spaces; the edited line keeps its own.
    return dialect === "note" && write ? write(shapeChanged.keys[n]!.slice(1)) + /[ \t]*$/.exec(changed[n]!)![0] : null;
  };
  const out: Piece[] = [];
  const keepUntil = (end: number) => {
    for (let t = next; t < end; t++) {
      const k = owner.get(t);
      out.push({ kind: "kept", t, from: k === undefined ? undefined : kept.get(k) });
    }
  };
  let next = 0;
  for (const hunk of found) {
    const [bStart, bLength] = hunk.buffer1;
    const [cStart, cLength] = hunk.buffer2;
    const bEnd = bStart + bLength;
    const lines = range(bStart, bEnd);
    // Every line the edit replaces or deletes must be found in the target: never guess where it is.
    if (lines.some((k) => map[k]! < 0 && !sepBase[k])) return null;
    const matched = lines.filter((k) => map[k]! >= 0);

    if (bLength > 0 && bLength === cLength && matched.length === bLength) {
      // Replaced one for one: each counterpart takes its new text, and target-only lines between them stay.
      const from = map[bStart]!;
      const to = map[bEnd - 1]! + 1;
      if (from < next) return null;
      keepUntil(from);
      const replaced = new Map<number, Piece>();
      lines.forEach((k, n) => {
        const t = map[k]!;
        const line = inBlock(cStart + n) ?? inNoteBlock(cStart + n) ?? relayout(base[k]!, changed[cStart + n]!, target[t]!);
        replaced.set(t, { kind: "replaced", t, text: keep && !blank(line) ? keep(line, target[t]!) : line, from: cStart + n });
      });
      for (let t = from; t < to; t++) out.push(replaced.get(t) ?? { kind: "kept", t });
      next = to;
      continue;
    }

    let from: number;
    let to: number;
    if (matched.length) {
      from = map[matched[0]!]!;
      to = map[matched[matched.length - 1]!]! + 1;
      // No target-only line inside the span is ever written over.
      for (let t = from; t < to; t++) {
        const k = owner.get(t);
        if (!sepTarget[t] && (k === undefined || k < bStart || k >= bEnd)) return null;
      }
      if (cLength === 0 && dialect === "page") {
        // In a page, a line belongs under the nearest line before it with fewer tabs: a deletion never leaves
        // behind lines nested under a deleted line (a toggle heading's) where the base doesn't nest them.
        const nested = (text: string[], sep: boolean[], start: number, end: number) => {
          let after = end;
          while (after < text.length && sep[after]) after++;
          const last = range(start, end).filter((k) => !sep[k]).pop();
          return after < text.length && last !== undefined && tabs(text[after]!) > tabs(text[last]!);
        };
        if (nested(target, sepTarget, from, to) && !nested(base, sepBase, bStart, bEnd)) return null;
      } else if (cLength === 0) {
        // In a note, deleting the line that kept a list item apart from a more indented line after it (a
        // heading, a divider) makes that line the item's own; never where the base doesn't do the same.
        const joined = (text: string[], sep: boolean[], code: boolean[], start: number, end: number) => {
          let before = start - 1;
          while (before >= 0 && sep[before]) before--;
          let after = end;
          while (after < text.length && sep[after]) after++;
          if (before < 0 || after >= text.length || code[before] || code[after] || !LIST_ITEM.test(text[before]!)) return false;
          const item = columns(text[before]!);
          return range(start, end).every((k) => sep[k] || columns(text[k]!) <= item) && columns(text[after]!) > item;
        };
        if (joined(target, sepTarget, codeTarget, from, to) && !joined(base, sepBase, codeBase, bStart, bEnd)) return null;
      }
    } else {
      const at = insertionPoint(map, sepBase, bStart, bEnd);
      if (at === null) return null;
      from = to = at;
    }
    if (from < next) return null;
    keepUntil(from);

    let anchorLine = bStart - 1;
    while (anchorLine >= 0 && (sepBase[anchorLine] || map[anchorLine]! < 0)) anchorLine--;
    if (anchorLine < 0) anchorLine = lines.find((k) => map[k]! >= 0 && !sepBase[k]) ?? -1;
    if (anchorLine < 0) {
      anchorLine = bEnd;
      while (anchorLine < base.length && (sepBase[anchorLine] || map[anchorLine]! < 0)) anchorLine++;
    }
    // The indentation the target gives the lines around them, where it differs from the base's: Notion
    // nests with tabs, and writes a nested code block's lines flush left.
    const outer = anchorLine >= 0 && anchorLine < base.length ? lead(target[map[anchorLine]!]!) : "";
    const inner = anchorLine >= 0 && anchorLine < base.length ? lead(base[anchorLine]!) : "";
    let same = 0;
    while (same < outer.length && same < inner.length && outer[outer.length - 1 - same] === inner[inner.length - 1 - same]) same++;
    const [fromLead, toLead] = [inner.slice(0, inner.length - same), outer.slice(0, outer.length - same)];
    const indent = (line: string) => (blank(line) || !line.startsWith(fromLead) ? line : toLead + line.slice(fromLead.length));

    out.push({ kind: "edit" });
    for (let n = 0; n < cLength; n++) {
      const line = changed[cStart + n]!;
      out.push({ kind: "added", text: inBlock(cStart + n) ?? inNoteBlock(cStart + n) ?? indent(line), from: cStart + n });
    }
    next = to;
  }
  keepUntil(target.length);
  return separate(out, changed, target, dialect);
}

/** A note's quote markers at the start of `line`, written as a blank quote line (`>`), or "" outside quotes. */
const quoteMarks = (line: string) => (/^(?:[ \t]{0,3}>[ \t]?)+/.exec(line)?.[0] ?? "").replace(/[ \t]/g, "");

/**
 * Adds the blank lines that keep blocks apart where an edit changed what stands next to what: an added line
 * is set apart as in `changed`; lines that became neighbours, or a line that stopped being a heading, get the
 * blank line that a heading or thematic break made unnecessary before, written as the edited text has it there
 * (a blank quote line keeps a quote's paragraphs in one quote). Nothing else is touched.
 */
function separate(pieces: Piece[], changed: string[], target: string[], dialect: Dialect): Piece[] {
  const text = (p: Exclude<Piece, { kind: "edit" }>) => (p.kind === "kept" ? target[p.t]! : p.text);
  const sepChanged = separators(changed, dialect);
  const apartLine = (line: string) => blank(line) || (dialect === "note" && /^(?:[ \t]{0,3}>)+[ \t]*$/.test(line));
  const out: Piece[] = [];
  let last: Exclude<Piece, { kind: "edit" }> | null = null;
  let apart = false;
  let edited = false;
  for (const piece of pieces) {
    if (piece.kind === "edit") {
      edited = true;
      continue;
    }
    if (apartLine(text(piece)) || piece.from === undefined) {
      apart = true;
      out.push(piece);
      continue;
    }
    const between = last && !apart && last.from !== undefined ? sepChanged.indexOf(true, last.from + 1) : -1;
    if (last && between !== -1 && between < piece.from) {
      const needed =
        last.kind === "added" || piece.kind === "added"
          ? true
          : edited
            ? !closesBlock(text(last))
            : (last.kind === "replaced" && closesBlock(target[last.t]!) && !closesBlock(text(last))) ||
              (piece.kind === "replaced" && closesBlock(target[piece.t]!) && !closesBlock(text(piece)));
      // The blank line the edited text has there: a blank quote line keeps a quote's paragraphs together.
      if (needed) out.push({ kind: "added", text: changed[between]!.trim(), from: -1 });
    }
    out.push(piece);
    last = piece;
    apart = false;
    edited = false;
  }
  return out;
}

/**
 * Applies the edits that turn `base` into `changed` onto `target`, a text that holds the same lines as
 * `base` in another form (`dialect` says which app's markdown `target` is). Lines the edits don't touch stay
 * exactly as they are in `target`; a line replaced one for one keeps the target's layout, and `keep` may
 * adjust it further. Returns null when an edit can't be placed on lines known to be its counterparts: it
 * never guesses.
 */
export function transplant(base: string[], changed: string[], target: string[], keep?: (line: string, old: string) => string, dialect: Dialect = "note"): string[] | null {
  // A run of blank lines between blocks is one separator; Notion's empty blocks count as blank lines.
  const { code } = codeShape(target);
  const spacer = (i: number) => !code[i] && (blank(target[i]!) || /^\t*<empty-block\/>[ \t]*$/.test(target[i]!));
  const runs: [number, number][] = [];
  const compact: string[] = [];
  for (let i = 0; i < target.length; ) {
    let j = i + 1;
    if (spacer(i)) while (j < target.length && spacer(j)) j++;
    runs.push([i, j]);
    compact.push(spacer(i) ? "" : target[i]!);
    i = j;
  }
  const pieces = place(base, changed, compact, keep, dialect);
  return pieces && pieces.flatMap((p) => (p.kind === "edit" ? [] : p.kind === "added" || p.kind === "replaced" ? [p.text] : target.slice(...runs[p.t]!)));
}

export interface MergeResult {
  lines: string[];
  conflicted: boolean;
}

/** `side` as lines added before `o`, `o` intact, and lines added after it; null when it isn't, or when `o` fits in more than one place. */
function around(side: string[], o: string[]): [string[], string[]] | null {
  if (o.length === 0 || side.length <= o.length) return null;
  let at = -1;
  for (let k = 0; k + o.length <= side.length; k++) {
    if (!o.every((line, j) => side[k + j] === line)) continue;
    if (at !== -1) return null;
    at = k;
  }
  return at === -1 ? null : [side.slice(0, at), side.slice(at + o.length)];
}

/** What both sides added at one end: one side's lines, or both's when they agree; null when they differ. */
function oneEnd(x: string[], y: string[]): string[] | null {
  if (x.length === 0) return y;
  return y.length === 0 || (x.length === y.length && x.every((line, k) => line === y[k])) ? x : null;
}

/**
 * Git-style three-way merge; where both sides changed the same lines, `ours` wins and `conflicted` is set.
 * Lines one side only added before or after lines the other side changed are not an overlap: both are kept.
 */
export function threeWay(base: string[], ours: string[], theirs: string[]): MergeResult {
  const lines: string[] = [];
  let conflicted = false;
  for (const region of diff3Merge(ours, base, theirs, { excludeFalseConflicts: true })) {
    if (region.ok) {
      lines.push(...region.ok);
      continue;
    }
    const { a, o, b } = region.conflict!;
    if (a.length === o.length && o.length === b.length) {
      for (let k = 0; k < a.length; k++) {
        if (a[k] === o[k]) lines.push(b[k]!);
        else if (b[k] === o[k] || a[k] === b[k]) lines.push(a[k]!);
        else {
          lines.push(a[k]!);
          conflicted = true;
        }
      }
      continue;
    }
    const ourAdditions = around(a, o);
    const theirAdditions = around(b, o);
    if (ourAdditions && theirAdditions) {
      const before = oneEnd(ourAdditions[0], theirAdditions[0]);
      const after = oneEnd(ourAdditions[1], theirAdditions[1]);
      if (before && after) {
        lines.push(...before, ...o, ...after);
        continue;
      }
    } else if (ourAdditions || theirAdditions) {
      const [before, after] = (ourAdditions ?? theirAdditions)!;
      lines.push(...before, ...(ourAdditions ? b : a), ...after);
      continue;
    }
    lines.push(...a);
    conflicted = true;
  }
  return { lines, conflicted };
}
