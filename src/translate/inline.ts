// Inline text: Obsidian markdown <-> Notion enhanced markdown.
import { convertWiki, markdownDestination } from "../links/convert.ts";
import { baseName, linkPathFor, linkText, resolveLink, stem, type LinkEntry } from "../links/index.ts";
import { idFromUrl, isNotionUrl, pageUrl } from "../notion/ids.ts";
import { escapeNotionText, isAttachment, MATH, unescapeMarkdown, type TranslateContext } from "./context.ts";

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const CODE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;
const EMBED = /!\[\[([^\]\n]+?)\]\]/y;
const WIKI = /\[\[([^\]\n]+?)\]\]/y;
/** A Markdown link or image: `!`, text, destination (bare or `<…>`), and an optional title. */
export const MD_LINK = /(!?)\[((?:[^[\]\n]|\\[[\]])*)\]\(\s*(<[^>\n]*>|[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)(?:\s+"[^"\n]*")?\s*\)/y;
const HIGHLIGHT = /==(?=\S)([^=\n]*?\S)==/y;
const BR = /<br\s*\/?>/iy;
const AUTOLINK = /<(https?:\/\/[^>\s]+)>/y;
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<>]+/y;

/**
 * The bare URL at `i` (`https://…`, `www.…`), which Obsidian shows as a link, without the punctuation that ends a
 * sentence or an unbalanced `)` (as GFM, and Notion, end one); null when there is none. Its `_` and `*` are no emphasis.
 */
function bareUrl(text: string, i: number): string | null {
  if (i > 0 && /[\p{L}\p{N}_]/u.test(text[i - 1]!)) return null;
  const m = at(BARE_URL, text, i);
  if (!m) return null;
  let url = m[0];
  for (;;) {
    const trimmed = url.replace(/[?!.,:*_~'"]+$/, "");
    const open = (trimmed.match(/\(/g) ?? []).length;
    const close = (trimmed.match(/\)/g) ?? []).length;
    const next = trimmed.endsWith(")") && close > open ? trimmed.slice(0, -1) : trimmed;
    if (next === url) break;
    url = next;
  }
  return /[\p{L}\p{N}/]/u.test(url[url.length - 1] ?? "") ? url : null;
}

/** A code span as Notion reads one back: one backtick each side (its content as CommonMark reads it) when it holds none. */
function codeSpan(span: string): string {
  const ticks = /^`+/.exec(span)![0].length;
  let content = span.slice(ticks, span.length - ticks);
  if (ticks === 1 || content.includes("`")) return span;
  if (content.length > 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "") content = content.slice(1, -1);
  return `\`${content}\``;
}
/** Notion keeps links only with these schemes; anything else (obsidian:, file:, mailto:…) travels as literal text. */
const WEB = /^https?:\/\//i;

function at(re: RegExp, text: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(text);
}

const mention = (url: string) => `<mention-page url="${url}"/>`;
const notionLink = (label: string, url: string) => `[${escapeNotionText(label)}](${url})`;
const literalWiki = (inner: string, embed: boolean) => `${embed ? "!" : ""}\\[\\[${escapeNotionText(inner)}\\]\\]`;
const literalLink = (label: string, dest: string, image: boolean) => `${image ? "!" : ""}\\[${escapeNotionText(label)}\\](${dest})`;

/**
 * Whether Notion would re-read a page link's text, given as the translator writes it (escaped Notion text): its
 * underscores pair as italics or bold once Notion's markdown drops their backslashes (live probes:
 * `[Probe - \_\_name\_\_](…)` came back as three links with a bold middle).
 */
export function linkTextRereads(text: string): boolean {
  const dropped = text.replace(/\\([\s\S])/g, (whole, c: string) => (NOTION_ESCAPES.includes(c) ? whole : c));
  return emphasisSpans(dropped.replace(/^(?:https?:\/\/|www\.)/i, "")).some((s) => s.char === "_");
}

/** The context for text that holds no link (each bracket escaped): never consulted. */
const NO_LINKS: TranslateContext = { index: { entries: [], byName: new Map(), byPageId: new Map() }, fromPath: "", vaultName: "" };

/**
 * Plain words as a Markdown link's text, so both apps show them as they are (final review): as `linkText` writes them
 * (`[`, `]` and `\` escaped) when the translator reads none of them as formatting, otherwise with `*`, `_` (not inside
 * a word, where it is never emphasis), `~`, `` ` ``, `$`, `<` and each `=` before another escaped too. An HTML tag
 * (`<b>`) counts as formatting: Obsidian shows it as one. The translator writes either form as the text it is.
 */
export function plainLinkText(text: string): string {
  const plain = linkText(text);
  if (toNotionInline(plain, NO_LINKS) === escapeNotionText(text) && !/<[A-Za-z/!?]/.test(text)) return plain;
  return plain.replace(/[*~`$<_]|=(?==)/g, (c, at: number) => (c === "_" && wordAt(plain[at - 1]) && wordAt(plain[at + 1]) ? c : `\\${c}`));
}

/**
 * A link to a synced note's page (no heading: a mention would lose it) reading `text`: a page link, or a mention
 * when the text is the page's own title and Notion would re-read it as written (a mention shows the title without
 * holding it as text).
 */
function pageLink(text: string, title: string, url: string): string {
  return text === title && linkTextRereads(escapeNotionText(text)) ? mention(url) : notionLink(text, url);
}

/**
 * The inner text of the `[[…]]` literal for a link to a note without a page: `target` (with `#anchor`) when `label`
 * says no more than it (the target's base name, or that `› anchor`), otherwise `target|label`. The literal reads back
 * with the base name (`convertWiki`), so text with the target's folders is kept (final review).
 */
export function unresolvedLiteral(label: string, target: string, anchor: string | null): string {
  const link = anchor === null ? target : `${target}#${anchor}`;
  const name = baseName(target);
  const plain = label === name || (anchor !== null && label === `${name} › ${anchor}`);
  return plain ? link : `${link}|${label}`;
}

function wikiToNotion(rawInner: string, embed: boolean, ctx: TranslateContext): string {
  const inner = rawInner.replace(/\\\|/g, "|");
  const pipe = inner.indexOf("|");
  const targetPart = pipe === -1 ? inner : inner.slice(0, pipe);
  const alias = pipe === -1 ? null : inner.slice(pipe + 1);
  const hash = targetPart.indexOf("#");
  const target = hash === -1 ? targetPart : targetPart.slice(0, hash);
  const anchor = hash === -1 ? null : targetPart.slice(hash + 1);
  if (target.trim() === "") return literalWiki(inner, embed);
  const entry = resolveLink(ctx.index, target, ctx.fromPath);
  if (entry?.pageId) {
    const url = pageUrl(entry.pageId);
    // Notion can't show another page's content inline, so an embedded note is its mention alone, without the `!` that
    // marked it (and that Notion showed as a stray character); `markEmbeds` writes that old form (see `ctx.markEmbeds`).
    if (embed) return anchor === null ? `${ctx.markEmbeds ? "!" : ""}${mention(url)}` : notionLink(`📎 ${target} › ${anchor}`, url);
    if (anchor !== null) return notionLink(alias ?? `${target} › ${anchor}`, url);
    return pageLink(alias ?? entry.title, entry.title, url);
  }
  // A [[link]] to a note without a page travels as it is written, which is the literal relink looks for.
  return literalWiki(inner, embed);
}

/** The vault file an obsidian://open link points to, when it points into this vault. */
function obsidianFile(url: string, ctx: TranslateContext): string | null {
  if (!url.startsWith("obsidian://open?")) return null;
  const params = new URLSearchParams(url.slice("obsidian://open?".length));
  return params.get("vault") === ctx.vaultName ? params.get("file") : null;
}

function mdLinkToNotion(m: RegExpExecArray, ctx: TranslateContext): string {
  const [whole, bang, label, rawDest] = m as unknown as [string, string, string, string];
  const dest = rawDest.startsWith("<") ? rawDest.slice(1, -1) : rawDest;
  const vaultFile = obsidianFile(dest, ctx);
  if (vaultFile === null && /^[a-z][a-z0-9+.-]*:/i.test(dest)) {
    if (!WEB.test(dest)) return literalLink(label, dest, bang === "!");
    return bang ? whole : `[${toNotionInline(label, ctx)}](${dest})`;
  }
  let decoded = vaultFile ?? dest;
  if (vaultFile === null) {
    try {
      decoded = decodeURIComponent(dest);
    } catch {
      // keep the raw destination
    }
  }
  const hash = decoded.indexOf("#");
  const target = hash === -1 ? decoded : decoded.slice(0, hash);
  const plainLabel = unescapeMarkdown(label);
  const entry = target ? resolveLink(ctx.index, target, ctx.fromPath) : null;
  if (entry?.pageId && !bang) {
    const url = pageUrl(entry.pageId);
    if (hash === -1 && plainLabel === entry.title && linkTextRereads(escapeNotionText(entry.title))) return mention(url);
    return `[${toNotionInline(label, ctx) || escapeNotionText(entry.title)}](${url})`;
  }
  // A link to a note without a page, or to no note: the literal [[link]] a note without a page has, for relink.
  if (!bang && !isAttachment(target) && (entry || /\.md$/i.test(target))) {
    const note = stem(target);
    const anchor = hash === -1 ? null : decoded.slice(hash + 1);
    return literalWiki(unresolvedLiteral(plainLabel || note, note, anchor), false);
  }
  if ((entry && entry.pageId === null) || (target && isAttachment(target))) {
    return bang || plainLabel === "" || plainLabel === target ? literalWiki(target, bang === "!") : literalWiki(`${target}|${plainLabel}`, false);
  }
  return literalLink(label, dest, bang === "!");
}

/** The characters Notion's markdown escapes in text (section 3 of the spec); it drops a backslash before any other. */
const NOTION_ESCAPES = "\\*~`$[]<>{}|^";

const blankAt = (c: string | undefined) => c === undefined || /\s/u.test(c);
const punctuationAt = (c: string | undefined) => c !== undefined && /[\p{P}\p{S}]/u.test(c);
const wordAt = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/**
 * Whether the backslash at `at` keeps the character after it from being syntax, so it must stay: before `*`, `_`
 * and `~` and Notion's own escapes, at the start of the text (a heading, a list), before `[` (an image), and in
 * `==`, `%%` and an HTML entity. Elsewhere it changes nothing, and Notion drops it.
 */
function meaningfulEscape(text: string, at: number): boolean {
  const char = text[at + 1]!;
  return (
    "*_~".includes(char) ||
    NOTION_ESCAPES.includes(char) ||
    /^\d*$/.test(text.slice(0, at)) ||
    (char === "!" && text[at + 2] === "[") ||
    ((char === "=" || char === "%") && (text[at - 1] === char || text[at + 2] === char)) ||
    (char === "&" && /^[#A-Za-z0-9]+;/.test(text.slice(at + 2)))
  );
}

/** A run of `*`, `_` or `~` in inline text, and whether CommonMark's flanking rules let it open and close. */
interface Run {
  char: string;
  at: number;
  length: number;
  open: boolean;
  close: boolean;
}

/**
 * The `*`, `_` and `~` runs of `text` outside what `toNotionInline` writes as a whole (escapes, code, math, embeds,
 * links, highlights, `<br>` and autolinks), each with what it may do, as CommonMark reads it.
 */
function delimiterRuns(text: string): Run[] {
  const runs: Run[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    let m: RegExpExecArray | null = null;
    if (ch === "\\") {
      i += i + 1 < text.length && PUNCTUATION.test(text[i + 1]!) ? 2 : 1;
    } else if (ch === "`") {
      i += (m = at(CODE, text, i)) ? m[0].length : /^`+/.exec(text.slice(i))![0].length;
    } else if ((ch === "h" || ch === "w") && bareUrl(text, i)) {
      i += bareUrl(text, i)!.length;
    } else if (
      (ch === "$" && text[i + 1] !== "$" && (m = at(MATH, text, i))) ||
      (ch === "!" && (m = at(EMBED, text, i))) ||
      (ch === "[" && (m = at(WIKI, text, i))) ||
      ((ch === "[" || ch === "!") && (m = at(MD_LINK, text, i))) ||
      (ch === "=" && (m = at(HIGHLIGHT, text, i))) ||
      (ch === "<" && ((m = at(BR, text, i)) || (m = at(AUTOLINK, text, i))))
    ) {
      i += m[0].length;
    } else if (ch === "*" || ch === "_" || ch === "~") {
      let j = i;
      while (text[j] === ch) j++;
      const before = text[i - 1];
      const after = text[j];
      const left = !blankAt(after) && (!punctuationAt(after) || blankAt(before) || punctuationAt(before));
      const right = !blankAt(before) && (!punctuationAt(before) || blankAt(after) || punctuationAt(after));
      const open = ch === "_" ? left && (!right || punctuationAt(before)) : left;
      const close = ch === "_" ? right && (!left || punctuationAt(after)) : right;
      runs.push({ char: ch, at: i, length: j - i, open, close });
      i = j;
    } else {
      i++;
    }
  }
  return runs;
}

/**
 * How CommonMark pairs the `*` and `_` runs of a text (its "process emphasis"): for each pair, where the opener's
 * characters it uses start, where the closer's start, and how many (2 for strong, 1 for emphasis).
 */
function emphasisPairs(runs: Run[]): string[] {
  const stack = runs.filter((r) => r.char !== "~").map((r) => ({ ...r, left: r.length }));
  const pairs: string[] = [];
  const bottom = new Map<string, number>();
  stack.forEach((closer, c) => {
    while (closer.close && closer.left > 0) {
      const key = `${closer.char}${closer.open}${closer.length % 3}`;
      const floor = bottom.get(key) ?? -1;
      let o = c - 1;
      for (; o > floor; o--) {
        const opener = stack[o]!;
        if (opener.char !== closer.char || !opener.open || opener.left === 0) continue;
        const odd = (opener.close || closer.open) && (opener.length + closer.length) % 3 === 0 && !(opener.length % 3 === 0 && closer.length % 3 === 0);
        if (!odd) break;
      }
      if (o <= floor) {
        bottom.set(key, c - 1);
        break;
      }
      const opener = stack[o]!;
      const use = opener.left >= 2 && closer.left >= 2 ? 2 : 1;
      pairs.push(`${opener.at + opener.left - use}:${closer.at + closer.length - closer.left}:${use}`);
      opener.left -= use;
      closer.left -= use;
      for (let k = o + 1; k < c; k++) stack[k]!.left = 0;
    }
    if (!closer.open) closer.left = 0;
  });
  return pairs;
}

/** The emphasis of `text` as CommonMark pairs it: where each pair's characters start, how many it uses, and which. */
export function emphasisSpans(text: string): { open: number; close: number; use: number; char: string }[] {
  return emphasisPairs(delimiterRuns(text)).map((pair) => {
    const [open, close, use] = pair.split(":").map(Number) as [number, number, number];
    return { open, close, use, char: text[open]! };
  });
}

/**
 * The emphasis delimiters of `text`, as CommonMark pairs them: `starred`, the positions of the `_` the translator
 * writes as `*` (Notion writes `_x_` as `*x*` and `__x__` as `**x**`; not italics around bold, which Notion reads
 * only with `_`, and none where writing them so would change what pairs with what, next to a `*`); and `stars`, the
 * positions of the `*` that are emphasis. Any other `*` is written
 * escaped: Notion pairs stars CommonMark wouldn't (`2 * 3 * 4` made "3" italic, live probe).
 */
function emphasisDelimiters(text: string): { starred: Set<number>; stars: Set<number> } {
  const pairs = emphasisPairs(delimiterRuns(text));
  const starred = new Set<number>();
  const stars = new Set<number>();
  const spans = pairs.map((pair) => pair.split(":").map(Number) as [number, number, number]);
  for (const [opener, closer, use] of spans) {
    // Italics around bold keep their `_`: Notion reads `*a **b** c*` as italics only (live probe). Bold and
    // italics over the same words (`_**a**_`, Notion's `***a***`) it reads right.
    const aroundBold = use === 1 && spans.some(([o, c, u]) => u === 2 && o > opener && c < closer && (o > opener + 1 || c + 2 < closer));
    for (let k = 0; k < use; k++) {
      if (text[opener] === "*") stars.add(opener + k).add(closer + k);
      else if (!aroundBold) starred.add(opener + k).add(closer + k);
    }
  }
  if (starred.size === 0) return { starred, stars };
  const converted = [...text].map((c, k) => (starred.has(k) ? "*" : c)).join("");
  const same = emphasisPairs(delimiterRuns(converted));
  return same.length === pairs.length && same.every((pair, k) => pair === pairs[k]) ? { starred, stars } : { starred: new Set(), stars };
}

/** The positions of the `~` of `text` that strike something through: `~~` runs that pair as GFM pairs them. */
function strikethrough(text: string): Set<number> {
  const found = new Set<number>();
  const open: Run[] = [];
  for (const run of delimiterRuns(text)) {
    if (run.char !== "~" || run.length !== 2) continue;
    if (run.close && open.length) {
      const opener = open.pop()!;
      for (const r of [opener, run]) for (let k = 0; k < 2; k++) found.add(r.at + k);
    } else if (run.open) {
      open.push(run);
    }
  }
  return found;
}

/**
 * Obsidian inline markdown -> Notion enhanced markdown. Newlines are kept; blocks turn them into <br>. Written in
 * Notion's own forms wherever they say the same (live probe): `_` emphasis as `*`, a tilde that strikes
 * nothing escaped, and no backslash where it changes nothing.
 */
export function toNotionInline(text: string, ctx: TranslateContext): string {
  const { starred, stars } = emphasisDelimiters(text);
  const struck = strikethrough(text);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    let m: RegExpExecArray | null;
    if (ch === "\\") {
      const next = text[i + 1];
      if (next !== undefined && PUNCTUATION.test(next)) {
        // A backslash in a word before `_` changes nothing either: `snake_case` is no emphasis.
        const bare = !meaningfulEscape(text, i) || (next === "_" && wordAt(text[i - 1]) && wordAt(text[i + 2]));
        out += bare ? next : `\\${next}`;
        i += 2;
      } else {
        out += "\\\\";
        i += 1;
      }
    } else if (ch === "`") {
      if ((m = at(CODE, text, i))) {
        out += codeSpan(m[0]);
        i += m[0].length;
      } else {
        const run = /`+/y;
        run.lastIndex = i;
        const ticks = run.exec(text)![0];
        out += "\\`".repeat(ticks.length);
        i += ticks.length;
      }
    } else if ((ch === "h" || ch === "w") && bareUrl(text, i)) {
      // A bare URL as it is: Notion makes it a link.
      const url = bareUrl(text, i)!;
      out += url;
      i += url.length;
    } else if (ch === "$") {
      if (text[i + 1] !== "$" && (m = at(MATH, text, i))) {
        out += m[1]!.includes("`") ? m[0] : `$\`${m[1]}\`$`;
        i += m[0].length;
      } else {
        out += "\\$";
        i += 1;
      }
    } else if (ch === "!" && (m = at(EMBED, text, i))) {
      out += wikiToNotion(m[1]!, true, ctx);
      i += m[0].length;
    } else if (ch === "[" && (m = at(WIKI, text, i))) {
      out += wikiToNotion(m[1]!, false, ctx);
      i += m[0].length;
    } else if ((ch === "[" || ch === "!") && (m = at(MD_LINK, text, i))) {
      out += mdLinkToNotion(m, ctx);
      i += m[0].length;
    } else if (ch === "=" && (m = at(HIGHLIGHT, text, i))) {
      out += `<span color="yellow_bg">${toNotionInline(m[1]!, ctx)}</span>`;
      i += m[0].length;
    } else if (ch === "<" && (m = at(BR, text, i))) {
      out += "<br>";
      i += m[0].length;
    } else if (ch === "<" && (m = at(AUTOLINK, text, i))) {
      // The URL as its text, as Notion writes a link it makes of a URL: no `\_`, which it would drop.
      out += `[${escapeNotionText(m[1]!).replace(/\\_/g, "_")}](${m[1]!})`;
      i += m[0].length;
    } else if ("<>{}|^[]".includes(ch)) {
      out += `\\${ch}`;
      i += 1;
    } else if (ch === "_" && starred.has(i)) {
      out += "*";
      i += 1;
    } else if (ch === "*" && !stars.has(i)) {
      out += "\\*";
      i += 1;
    } else if (ch === "~" && !struck.has(i)) {
      out += "\\~";
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

const ESCAPED_WIKI = /(!?)\\\[\\\[((?:(?!\\\]\\\]).)+?)\\\]\\\]/y;
const ESCAPED_LINK = /(!?)\\\[((?:[^\\\n]|\\[^\]\n])*?)\\\]\(([^()\s]+(?:\([^\s()]*\)[^\s()]*)*)\)/y;
const NOTION_MATH = /\$`([^`\n]+)`\$/y;
const MENTION_PAGE = /(!?)<mention-page\s+url="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/mention-page>)/y;
const MENTION_ANY = /<mention-page\s+url="([^"]*)"/g;
const MENTION_REF = /<mention-(database|data-source)\s+url="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/mention-\1>)/y;
const MENTION_NAME = /<mention-(user|agent)\b[^>]*?(?:\/>|>([\s\S]*?)<\/mention-\1>)/y;
const MENTION_DATE = /<mention-date\b([^>]*?)\/?>(?:<\/mention-date>)?/y;
const SPAN = /<span\b([^>]*)>([\s\S]*?)<\/span>/y;
const NOTION_LINK = /\[((?:[^[\]\n]|\\[[\]])*)\]\(([^()\s]+(?:\([^\s()]*\)[^\s()]*)*)\)/y;
const CITATION = /\[\^([^\]\s]+)\]/y;
const ESCAPED_FOOTNOTE = /\\\[\\\^([^\]\s\\]+)\\\]/y;
const ATTRIBUTE = (name: string, attrs: string) => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;

/** A date mention's text in Obsidian: its start, or `start → end`. */
function dateText(attrs: string): string {
  const start = ATTRIBUTE("start", attrs) ?? "";
  const end = ATTRIBUTE("end", attrs);
  return end ? `${start} → ${end}` : start;
}

/** The same pattern, matching anywhere in the text. */
const everywhere = (re: RegExp) => new RegExp(re.source, "g");

/**
 * The links Notion makes of a bare URL, a `www.` host, an email or a word it takes for a domain (`script.py`; live
 * probe 2026-10-09) written as that text again, so a line Notion linked reads as the note writes it: a link whose
 * text is such a word and whose target is the word itself, or the word after `http://`, `https://` or `mailto:`.
 */
export function autolinksShown(text: string): string {
  return text.replace(/(?<!!)\[((?:[^\]\\\n]|\\.)+)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) => {
    const plain = unescapeMarkdown(label);
    const linkable = /^(?:https?:\/\/|www\.)\S+$/i.test(plain) || /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(plain) || /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:\/\S*)?$/.test(plain);
    return linkable && [plain, `http://${plain}`, `https://${plain}`, `mailto:${plain}`].includes(href) ? plain : whole;
  });
}

/**
 * Notion's date, person and database mentions in `text` written as Obsidian shows them, so two lines that
 * differ only in those forms read alike.
 */
export function mentionsShown(text: string): string {
  return text
    .replace(everywhere(MENTION_DATE), (_m, attrs: string) => dateText(attrs))
    .replace(everywhere(MENTION_NAME), (_m, kind: string, name: string | undefined) => `@${unescapeMarkdown(name ?? kind)}`)
    .replace(everywhere(MENTION_REF), (_m, _kind: string, url: string, title: string | undefined) => `[${unescapeMarkdown(title ?? "") || "Notion database"}](${url})`);
}

/**
 * Inline Obsidian text written one way where Obsidian and Notion write the same thing two ways: a `*`, `_` or `~`
 * that can't be emphasis or strikethrough there is written escaped (`2 \* 3`, `snake\_case`), `_` emphasis as `*`
 * emphasis (Notion writes `_x_` as `*x*`), and a backslash before other punctuation is dropped where that
 * character means nothing (Notion drops those backslashes). Escapes that keep something from being syntax stay:
 * at the start of the text (a heading, a list), before `[` (an image), and in Notion's own escape set. Code spans,
 * math, wikilinks and link targets stay as they are. A run counts as emphasis whenever CommonMark's flanking rules
 * let it open before a run that can close, or close after one that can open, so nothing that is emphasis is ever
 * read as plain text.
 */
export function shownInline(text: string): string {
  type Token = { kind: "text"; text: string } | { kind: "escape"; char: string; at: number } | { kind: "run"; char: string; at: number; length: number };
  const tokens: Token[] = [];
  for (let i = 0; i < text.length; ) {
    const ch = text[i]!;
    let m: RegExpExecArray | null;
    if (ch === "\\" && i + 1 < text.length && PUNCTUATION.test(text[i + 1]!)) {
      tokens.push({ kind: "escape", char: text[i + 1]!, at: i });
      i += 2;
    } else if (ch === "`" && (m = at(CODE, text, i))) {
      tokens.push({ kind: "text", text: m[0] });
      i += m[0].length;
    } else if (ch === "$" && text[i + 1] !== "$" && (m = at(MATH, text, i))) {
      tokens.push({ kind: "text", text: m[0] });
      i += m[0].length;
    } else if ((ch === "[" || ch === "!") && ((m = at(EMBED, text, i)) || (m = at(WIKI, text, i)))) {
      tokens.push({ kind: "text", text: m[0] });
      i += m[0].length;
    } else if ((ch === "[" || ch === "!") && (m = at(MD_LINK, text, i))) {
      const label = m[2]!;
      tokens.push({ kind: "text", text: `${m[1]}[${shownInline(label)}${m[0].slice(m[1]!.length + 1 + label.length)}` });
      i += m[0].length;
    } else if (ch === "<" && (m = at(AUTOLINK, text, i))) {
      tokens.push({ kind: "text", text: m[0] });
      i += m[0].length;
    } else if (ch === "*" || ch === "_" || ch === "~") {
      let j = i;
      while (text[j] === ch) j++;
      tokens.push({ kind: "run", char: ch, at: i, length: j - i });
      i = j;
    } else {
      tokens.push({ kind: "text", text: ch });
      i += 1;
    }
  }
  const runs = tokens.filter((t) => t.kind === "run");
  const role = new Map(
    runs.map((run) => {
      const before = text[run.at - 1];
      const after = text[run.at + run.length];
      const left = !blankAt(after) && (!punctuationAt(after) || blankAt(before) || punctuationAt(before));
      const right = !blankAt(before) && (!punctuationAt(before) || blankAt(after) || punctuationAt(after));
      const underscore = run.char === "_";
      return [run, { opens: left && (!underscore || !right || punctuationAt(before)), closes: right && (!underscore || !left || punctuationAt(after)) }];
    }),
  );
  const syntax = (run: Extract<Token, { kind: "run" }>) => {
    const kin = runs.filter((r) => r.char === run.char);
    const k = kin.indexOf(run);
    return (role.get(run)!.opens && kin.slice(k + 1).some((r) => role.get(r)!.closes)) || (role.get(run)!.closes && kin.slice(0, k).some((r) => role.get(r)!.opens));
  };
  return tokens
    .map((t) => {
      if (t.kind === "text") return t.text;
      if (t.kind === "run") return syntax(t) ? (t.char === "_" ? "*" : t.char).repeat(t.length) : `\\${t.char}`.repeat(t.length);
      return meaningfulEscape(text, t.at) ? `\\${t.char}` : t.char;
    })
    .join("");
}

/** Ids of every page mentioned in Notion markdown. */
export function mentionedPageIds(markdown: string): string[] {
  const ids = new Set<string>();
  for (const m of markdown.matchAll(MENTION_ANY)) {
    const id = idFromUrl(m[1]!);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * A link to a synced note's page as the vault writes it, `[text](Path.md)`: the link's own text (`rawLabel`, as Notion
 * holds it), or the page's title for a mention (null); a `Title › Heading` text links to the heading. Plain words (what
 * the translator writes as `rawLabel` exactly) are written as `markdownLink` writes them, so a link the vault wrote
 * comes back as it was; text with formatting reads as Obsidian markdown, and so does any text read `exact`ly, so two
 * texts Notion holds differently never read alike (a mention then reads as the page link the translator writes for
 * the title). A `📎` text (an embedded section) and a block link keep their `![[ ]]` and `[[ ]]` forms.
 */
function pageLinkToObsidian(entry: LinkEntry, rawLabel: string | null, ctx: TranslateContext, exact: boolean): string {
  const path = linkPathFor(ctx.index, entry, ctx.fromPath);
  if (rawLabel === null || rawLabel === "") {
    const title = plainLinkText(entry.title);
    return `[${exact ? toObsidianInline(toNotionInline(title, ctx), ctx, true) : title}](${markdownDestination(path, null)})`;
  }
  const label = unescapeMarkdown(rawLabel);
  if (label.startsWith("📎 ")) {
    const anchor = /^.* › (.+)$/.exec(label.slice("📎 ".length))?.[1];
    return anchor === undefined ? `![[${path}]]` : `![[${path}#${anchor}]]`;
  }
  const anchored = /^(.*) › (.+)$/.exec(label);
  const head = anchored?.[1];
  const anchor = head !== undefined && (head === path || head === entry.title || resolveLink(ctx.index, head, ctx.fromPath) === entry) ? anchored![2]! : null;
  if (anchor?.startsWith("^")) return `[[${path}#${anchor}]]`;
  const dest = markdownDestination(path, anchor);
  const plain = plainLinkText(label);
  if (!exact && toNotionInline(plain, ctx) === rawLabel) return `[${plain}](${dest})`;
  return `[${toObsidianInline(rawLabel, ctx, exact)}](${dest})`;
}

function linkToObsidian(rawLabel: string, url: string, ctx: TranslateContext, exact: boolean): string {
  const id = isNotionUrl(url) ? idFromUrl(url) : null;
  const entry = id ? ctx.index.byPageId.get(id) : undefined;
  if (entry) return pageLinkToObsidian(entry, rawLabel, ctx, exact);
  return `[${toObsidianInline(rawLabel, ctx, exact)}](${url})`;
}

/**
 * The `[[…]]` Notion holds as text (a link to a note without a page, or to no note) as the vault writes it, the way
 * the vault's own `[[links]]` are converted; attachments and block links stay `[[ ]]`.
 */
const literalToObsidian = (inner: string, ctx: TranslateContext) => convertWiki(inner, ctx.index, ctx.fromPath) ?? `[[${inner}]]`;

/**
 * Text Notion holds as text (a `[[link]]` it can't hold), with each `_` escaped as the translator writes it there
 * (`escapeNotionText`): Notion writes those back without the backslash, and both read the same.
 */
const literalUnderscores = (text: string) => text.replace(/\\?_/g, (u, at: number) => (u.length === 1 && wordAt(text[at - 1]) && wordAt(text[at + 1]) ? u : "\\_"));

/**
 * Notion enhanced markdown inline text -> Obsidian inline markdown. `<br>` becomes a newline. `exact`: escaped text
 * stays escaped (a link's text Notion holds as text, `\|`, `\<`), so two different Notion texts never read alike.
 */
export function toObsidianInline(text: string, ctx: TranslateContext, exact = false): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    let m: RegExpExecArray | null;
    if ((ch === "\\" || ch === "!") && (m = at(ESCAPED_WIKI, text, i))) {
      out += exact ? literalUnderscores(m[0]) : m[1] ? `![[${unescapeMarkdown(m[2]!)}]]` : literalToObsidian(unescapeMarkdown(m[2]!), ctx);
      i += m[0].length;
    } else if ((ch === "\\" || ch === "!") && (m = at(ESCAPED_LINK, text, i))) {
      out += exact ? literalUnderscores(m[0]) : `${m[1]}[${unescapeMarkdown(m[2]!)}](${m[3]!})`;
      i += m[0].length;
    } else if (ch === "\\" && (m = at(ESCAPED_FOOTNOTE, text, i))) {
      out += exact ? m[0] : `[^${m[1]}]`;
      i += m[0].length;
    } else if (ch === "\\") {
      const next = text[i + 1];
      if (next !== undefined && "<>{}|^".includes(next) && !exact) {
        out += next;
        i += 2;
      } else if (next !== undefined && PUNCTUATION.test(next)) {
        out += `\\${next}`;
        i += 2;
      } else {
        out += "\\";
        i += 1;
      }
    } else if (ch === "`" && (m = at(CODE, text, i))) {
      out += m[0];
      i += m[0].length;
    } else if (ch === "$" && (m = at(NOTION_MATH, text, i))) {
      out += `$${m[1]}$`;
      i += m[0].length;
    } else if (ch === "$" && (m = at(MATH, text, i))) {
      out += m[0];
      i += m[0].length;
    } else if ((ch === "<" || ch === "!") && (m = at(MENTION_PAGE, text, i))) {
      const id = idFromUrl(m[2]!);
      const entry = id ? ctx.index.byPageId.get(id) : undefined;
      if (entry) {
        out += m[1] ? `![[${linkPathFor(ctx.index, entry, ctx.fromPath)}]]` : pageLinkToObsidian(entry, null, ctx, exact);
      } else {
        const title = (id && ctx.titles?.get(id)) || unescapeMarkdown(m[3] ?? "") || "Notion page";
        out += `[${title}](${id ? pageUrl(id) : m[2]!})`;
      }
      i += m[0].length;
    } else if (ch === "<" && (m = at(MENTION_REF, text, i))) {
      out += `[${unescapeMarkdown(m[3] ?? "") || "Notion database"}](${m[2]!})`;
      i += m[0].length;
    } else if (ch === "<" && (m = at(MENTION_NAME, text, i))) {
      out += `@${unescapeMarkdown(m[2] ?? m[1]!)}`;
      i += m[0].length;
    } else if (ch === "<" && (m = at(MENTION_DATE, text, i))) {
      out += dateText(m[1]!);
      i += m[0].length;
    } else if (ch === "<" && (m = at(SPAN, text, i))) {
      const inner = toObsidianInline(m[2]!, ctx, exact);
      out += ATTRIBUTE("color", m[1]!) === "yellow_bg" ? `==${inner}==` : inner;
      i += m[0].length;
    } else if (ch === "<" && (m = at(BR, text, i))) {
      out += "\n";
      i += m[0].length;
    } else if (ch === "[" && (m = at(CITATION, text, i))) {
      out += m[0];
      i += m[0].length;
    } else if (ch === "[" && (m = at(NOTION_LINK, text, i))) {
      // Notion writes a page link whose text is styled only in part (bold, italic, strikethrough or code: confirmed live
      // 2026-10-20, a recorded live run) as one link per run: links to the same page with nothing between them read as one.
      let label = m[1]!;
      let end = i + m[0].length;
      let next: RegExpExecArray | null;
      if (isNotionUrl(m[2]!) && idFromUrl(m[2]!) !== null) {
        while (text[end] === "[" && !at(CITATION, text, end) && (next = at(NOTION_LINK, text, end)) && next[2] === m[2]) {
          label += next[1]!;
          end += next[0].length;
        }
      }
      out += linkToObsidian(label, m[2]!, ctx, exact);
      i = end;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}
