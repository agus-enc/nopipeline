// What a note's two sides should look like after a push, a pull or a merge. Pure text in, text out.
import { LCS, diffIndices } from "node-diff3";
import { keepLinkForms } from "../links/rewrite.ts";
import { codeKeys, samePages, separators, threeWay, transplant } from "../merge/lines.ts";
import { mediaLine, placeholderPath } from "../notion/hosted.ts";
import { idFromUrl } from "../notion/ids.ts";
import { keptByNotion, toNotion, toObsidian, type TranslateContext } from "../translate/index.ts";
import { autolinksShown, shownInline, toNotionInline, toObsidianInline } from "../translate/inline.ts";
import { notionLanguage } from "../translate/languages.ts";
import type { SyncRecord } from "../types.ts";
import { splitFrontmatter } from "../vault/frontmatter.ts";

const lines = (text: string) => text.replace(/\r\n/g, "\n").split("\n");
export const recordBody = (record: SyncRecord) => splitFrontmatter(record.obsidianText).body.replace(/\r\n/g, "\n");

const same = (x: string[], y: string[]) => x.length === y.length && x.every((line, k) => line === y[k]);

/** Lines with each code block's language under the name Notion keeps it by (no language is javascript). */
function withLanguage(text: string[]): string[] {
  let fence: string | null = null;
  return text.map((line) => {
    const m = /^([\t ]*(?:> ?)*[\t ]*)(`{3,})(.*)$/.exec(line);
    if (fence === null) {
      if (!m || m[3]!.includes("`")) return line;
      fence = m[2]!;
      return `${m[1]}${m[2]}${notionLanguage(m[3]!)}`;
    }
    if (m && m[2]!.length >= fence.length && m[3]!.trim() === "") fence = null;
    return line;
  });
}

/**
 * `o` with the changes that turn it into `a` and those that turn it into `b`, or null where the two overlap
 * (they change the same lines, add lines at the same place, or add lines inside lines the other changes).
 * Changes that only touch each other both apply.
 */
function bothChanges(o: string[], a: string[], b: string[]): string[] | null {
  const ofA = diffIndices(o, a).map((h) => ({ h, side: a }));
  const text = (c: (typeof ofA)[number]) => c.side.slice(c.h.buffer2[0], c.h.buffer2[0] + c.h.buffer2[1]).join("\n");
  // The same change made on both sides counts once.
  const ofB = diffIndices(o, b)
    .map((h) => ({ h, side: b }))
    .filter((c) => !ofA.some((x) => x.h.buffer1[0] === c.h.buffer1[0] && x.h.buffer1[1] === c.h.buffer1[1] && text(x) === text(c)));
  const changes = [...ofA, ...ofB].sort((x, y) => x.h.buffer1[0] - y.h.buffer1[0] || x.h.buffer1[1] - y.h.buffer1[1]);
  for (let n = 1; n < changes.length; n++) {
    const [s1, l1] = changes[n - 1]!.h.buffer1;
    const [s2, l2] = changes[n]!.h.buffer1;
    if (s2 < s1 + l1 || (s2 === s1 && (l1 === 0) === (l2 === 0))) return null;
  }
  const out: string[] = [];
  let at = 0;
  for (const { h, side } of changes) {
    out.push(...o.slice(at, h.buffer1[0]), ...side.slice(h.buffer2[0], h.buffer2[0] + h.buffer2[1]));
    at = h.buffer1[0] + h.buffer1[1];
  }
  return [...out, ...o.slice(at)];
}

/**
 * Whether `result` (an edit placed on `target`) says what `changed` says, read the way the other app will read
 * it (`view`). Where `target` already said something other than `base`, those differences must stay as they
 * were and clear of the edit. This check knows nothing of how the edit was placed, so a misplaced edit can't
 * pass it.
 */
export function confirmed(base: string, changed: string, target: string, result: string, view: (text: string) => string): boolean {
  // A link Notion makes of a bare URL or a domain-like word reads as that word (`autolinksShown`).
  const [o, a, b, r] = [base, target, changed, result].map((text) => withLanguage(lines(view(text)).map(autolinksShown)));
  if (same(o!, a!)) return same(r!, b!);
  const merged = bothChanges(o!, a!, b!);
  return merged !== null && same(r!, merged);
}

/**
 * The page's new markdown: Obsidian's edits since the last sync, applied to the page as it is now. Null when
 * they can't be placed line by line.
 */
export function pushResult(record: SyncRecord, body: string, current: string, ctx: TranslateContext): string | null {
  return placeOnPage(toNotion(recordBody(record), ctx), toNotion(body, ctx), current, ctx);
}

/** `current` with the edits from `base` to `changed` (all three Notion markdown); null when they can't be placed. */
export function placeOnPage(base: string, changed: string, current: string, ctx: TranslateContext): string | null {
  const placed = transplant(lines(base), lines(changed), lines(current), undefined, "page")?.join("\n") ?? null;
  return placed !== null && confirmed(base, changed, current, placed, (text) => toObsidian(text, ctx)) ? placed : null;
}

/**
 * An escaped literal citation of an attachment as a page holds it (`!\[\[x.png\]\]`, `!\[\[x.pdf\]\]`, `\[\[x.docx\|text\]\]`,
 * `!\[c\]\(x.png\)`), an embed or a link, alone on its line or after a list marker.
 */
const LITERAL_CITATION = /^(\t*)((?:[-+*]|\d+[.)]) )?!?\\\[.*(?:\\\]\\\]|\\\))$/;

/**
 * Whether the escaped citation `part` (as `LITERAL_CITATION` reads it) is one the translator now writes as a block. An embed (`!\[`)
 * always counts, as it did for images. A link form (`\[\[x.docx\]\]`) is also what Notion holds for a link to a note that doesn't
 * exist (`\[\[Missing\]\]`), so it counts only when its target is an attachment file of the vault.
 */
function becomesBlock(part: string, ctx: TranslateContext): boolean {
  const match = /^(\t*)(?:(?:[-+*]|\d+[.)]) )?(!?)(.*)$/.exec(part)!;
  if (match[2] === "!") return true;
  const written = toNotion(match[3]!.replace(/\\(.)/g, "$1"), ctx).split("\n");
  return written.length === 1 && mediaLine(written[0]!) !== null;
}

/** The marked mention of an embedded note, as pages synced before the `!` was dropped hold it. */
const MARKED_MENTION = /!(?=<mention-page\b)/g;

/**
 * Whether `added` is `removed` with its escaped citations written as blocks (a media line for each citation, and a list
 * marker left alone on its line where an item held only the image) and the `!` taken off each mention. Notion joins the
 * lines of a paragraph with `<br>`, so a citation may share a removed line with the text around it. Once the citations,
 * the `!`s and the image lines are taken out, both say the same text.
 */
function embedsBecomeCurrent(removed: string[], added: string[], ctx: TranslateContext): boolean {
  const unmarked = removed.map((line) => line.replace(MARKED_MENTION, ""));
  const dropped = unmarked.some((line, k) => line !== removed[k]);
  const before = unmarked.flatMap((line) => line.split("<br>"));
  const after = added.flatMap((line) => line.split("<br>"));
  const cited = before.filter((part) => LITERAL_CITATION.test(part) && becomesBlock(part, ctx));
  const images = after.filter((part) => mediaLine(part) !== null);
  if (cited.length === 0 && images.length === 0) return dropped && same(unmarked, added);
  if (cited.length === 0 || images.length === 0) return false;
  // A citation after a list marker leaves the marker (the item is empty, its image one tab deeper).
  // An empty part next to a removed citation (a quote's blank `>` line: `> text<br><br>!\[x\]`) goes with it.
  const text = before.flatMap((part, k) => {
    const match = cited.includes(part) ? LITERAL_CITATION.exec(part) : null;
    if (match) return match[2] === undefined ? [] : [`${match[1]}${match[2].trimEnd()}`];
    const beside = [before[k - 1], before[k + 1]].some((other) => other !== undefined && cited.includes(other));
    return part === "" && beside ? [] : [part];
  });
  return same(text, after.filter((part) => mediaLine(part) === null));
}

/**
 * The record's page text brought up to date (spec §5.11): `notionMarkdown` with only these changes applied, from the ones
 * that turn it into what the translator writes for the note now: an escaped citation of an attachment (an image, PDF, audio,
 * video or file) becomes its block's line, and
 * a note embedded with a `!` before its mention (how pages synced before the `!` was dropped hold it) loses the `!`. Every
 * other difference (Notion keeps text in its own forms) stays as the page has it. Null when nothing would change.
 *
 * The changes are the ones between the translator's text as the page holds it (citations as text, mentions marked) and
 * as it writes it now, so a neighbouring line that Notion holds in another form can't join a change and hold it back; a
 * change applies where the page holds the translator's lines as they are.
 */
export function updateEmbedsResult(record: SyncRecord, ctx: TranslateContext): string | null {
  // Every run asks this of every synced note: most pages hold no escaped citation (`!\[`, `\[\[`, or a link's `\]\(`) and no marked mention.
  const text = record.notionMarkdown;
  if (!text.includes("!\\[") && !text.includes("\\[\\[") && !text.includes("\\]\\(") && !text.includes("!<mention-page")) return null;
  const { media: _media, ...without } = ctx;
  const body = recordBody(record);
  const base = lines(record.notionMarkdown);
  const literal = lines(toNotion(body, { ...without, markEmbeds: true }));
  const wanted = lines(toNotion(body, ctx));
  // Where each line of `literal` is in the page, for those the page holds as they are.
  const onPage = new Map<number, number>();
  let [fromPage, fromLiteral] = [0, 0];
  const keep = (to: number) => {
    while (fromPage < to) onPage.set(fromLiteral++, fromPage++);
  };
  for (const h of diffIndices(base, literal)) {
    keep(h.buffer1[0]);
    fromPage += h.buffer1[1];
    fromLiteral += h.buffer2[1];
  }
  keep(base.length);
  const out: string[] = [];
  let [at, applied] = [0, 0];
  for (const h of diffIndices(literal, wanted)) {
    const [first, length] = h.buffer1;
    const there = onPage.get(first);
    const added = wanted.slice(h.buffer2[0], h.buffer2[0] + h.buffer2[1]);
    if (there === undefined || there < at || !embedsBecomeCurrent(literal.slice(first, first + length), added, ctx)) continue;
    if (!Array.from({ length }, (_, k) => k).every((k) => onPage.get(first + k) === there + k)) continue;
    out.push(...base.slice(at, there), ...added);
    at = there + length;
    applied++;
  }
  return applied === 0 ? null : [...out, ...base.slice(at)].join("\n");
}

/** What text holds that isn't text: code spans, inline math, link targets and bare URLs. */
const NOT_TEXT = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|\$[^$\n]+?\$|\]\([^)\s]*\)|https?:\/\/[^\s<>]+/g;

/**
 * `line` (an edited line, in Notion's forms) with each emphasis whose text the note's line `old` writes with `_`
 * (`__bold__`, `_it_`) written so again, where `old` doesn't also write it with `*`. Code spans, math, link targets
 * and URLs are left as they are.
 */
function keepEmphasisForms(line: string, old: string): string {
  const text = (part: string) =>
    part.replace(/(\*{1,2})([^*\s](?:[^*]*?[^*\s])?)\1(?!\*)/g, (whole, stars: string, inner: string) => {
      const underscores = "_".repeat(stars.length);
      return old.includes(`${underscores}${inner}${underscores}`) && !old.includes(whole) ? `${underscores}${inner}${underscores}` : whole;
    });
  let out = "";
  let at = 0;
  for (const m of line.matchAll(NOT_TEXT)) {
    out += text(line.slice(at, m.index)) + m[0];
    at = m.index! + m[0].length;
  }
  return out + text(line.slice(at));
}

/**
 * `line` (an edited line, in Notion's forms) with each link Notion made of a bare URL or a domain-like word written as
 * that word again where the note's line `old` writes it so.
 */
function keepBareLinks(line: string, old: string): string {
  return line.replace(/(?<!!)\[((?:[^\]\\\n]|\\.)+)\]\(([^)\s]+)\)/g, (whole) => {
    const plain = autolinksShown(whole);
    return plain !== whole && old.includes(plain) && !old.includes(whole) ? plain : whole;
  });
}

/**
 * `markdown` (the translator's text) with each page mention written as the page link it reads as in Obsidian, outside
 * code. An embedded note is the mention alone, and the line Notion's edit of it gives is a link: both say the same here.
 */
export function mentionsAsLinks(markdown: string, ctx: TranslateContext): string {
  const all = lines(markdown);
  const code = codeKeys(all);
  return all
    .map((line, k) => (code[k] !== null ? line : line.replace(/<mention-page\s+url="[^"]*"[^>]*?\/>/g, (mention) => toNotionInline(toObsidianInline(mention, ctx), ctx))))
    .join("\n");
}

/**
 * The note's new body: Notion's edits since the last sync, applied to the note as it is now, each edited line
 * keeping the note's own form of its links, of its `_` emphasis and of the words Notion links (bare URLs, domains).
 * Null when they can't be placed line by line.
 */
export function pullResult(record: SyncRecord, body: string, markdown: string, ctx: TranslateContext): string | null {
  const base = toObsidian(record.notionMarkdown, ctx);
  const changed = toObsidian(markdown, ctx);
  const keep = (line: string, old: string) => keepBareLinks(keepEmphasisForms(keepLinkForms(line, old, ctx.index, ctx.fromPath), old), old);
  const { view, restore } = embedView(lines(body), lines(base), ctx);
  const placed = transplant(lines(base), lines(changed), view, keep);
  const result = placed === null ? null : restore(placed)?.join("\n") ?? null;
  return result !== null && confirmed(base, changed, body, result, (text) => mentionsAsLinks(toNotion(text, ctx), ctx)) ? result : null;
}

/** An embed of a note as the note writes it (`![[Baking Method]]`, `![[Baking Method|label]]`; a section embed stays a link). */
const NOTE_EMBED = /!\[\[[^\]\n]+\]\]/g;

/**
 * The note's lines with each lone citation of an attachment written as `toObsidian` writes the page's line for it (`![[x.png|300]]`
 * as `![](x.png)`, `![[Manual.pdf#page=3]]` as `![](Manual.pdf)`, `[[minutes.docx|Minutes]]` as `[Minutes](minutes.docx)`) and each embed of a note written as the link its mention reads as (`![[Baking Method]]` as
 * `[Baking Method](Baking Method.md)`), so an edit made to that line in Notion finds its counterpart; and `restore`, which puts the
 * note's own form back on the lines of a transplanted text that are still the view's (as many of each as the view altered,
 * in order; null when one view line stands for lines written differently and some of them are gone, or when Notion added lines
 * reading the same, since which one is the note's is a guess). Code is left alone, as are image citations in quotes and tables, which Notion holds differently, and
 * lines with an inline code span next to an embed. A line the page's own text (`base`) already holds as written (an embed
 * still marked with its old `!`) is left as it is.
 */
function embedView(body: string[], base: string[], ctx: TranslateContext): { view: string[]; restore: (placed: string[]) => string[] | null } {
  const code = codeKeys(body);
  const pageHolds = new Set(base);
  const altered = new Map<string, string[]>();
  const view = body.map((line, k) => {
    if (code[k] !== null) return line;
    const form = mediaForm(line, ctx) ?? noteEmbedForm(line, pageHolds, ctx);
    if (form === null || form === line) return line;
    altered.set(form, []);
    return form;
  });
  // A line of the note that already reads as a form (a link) is one of the lines it stands for too.
  for (const [k, line] of view.entries()) altered.get(line)?.push(body[k]!);
  return {
    view,
    restore(placed) {
      for (const [form, originals] of altered) {
        const left = placed.filter((line) => line === form).length;
        // More lines than the note had: a line added in Notion (a link or mention of the same note) reads alike, and which
        // one is the note's is a guess. Fewer is a guess only where the originals are written differently.
        if (left > originals.length || (new Set(originals).size > 1 && left !== originals.length)) return null;
      }
      return placed.map((line) => altered.get(line)?.shift() ?? line);
    },
  };
}

/** What a lone citation of an attachment may start with: indentation, a list marker (an item holding only the citation), and the `!` of an embed or the `[` of a link. */
const CITATION_START = /^[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?[![]/;
/** A list marker alone on its line, as Notion writes an item whose only content is a media block (the block is on the next line, one tab deeper). */
const EMPTY_ITEM = /^\t*(?:[-+*]|\d+[.)])$/;

/**
 * A lone citation of an attachment, alone on its line or alone in a list item, as the page's block reads in Obsidian (`- ![](x.png)`
 * for the item, as the page's empty item with the block under it is read), or null when `line` is not one.
 */
function mediaForm(line: string, ctx: TranslateContext): string | null {
  if (!ctx.media || !CITATION_START.test(line)) return null;
  const [first = "", second, ...rest] = toNotion(line, ctx).split("\n");
  const alone = second === undefined ? mediaLine(first) !== null : rest.length === 0 && EMPTY_ITEM.test(first) && mediaLine(second) !== null;
  return alone ? toObsidian(second === undefined ? first : `${first}\n${second}`, ctx).trimEnd() : null;
}

/**
 * `body` (a note's) with each lone citation of an attachment written as the page's block reads in Obsidian (`mediaForm`), for comparing
 * the note with a page that holds the citation as a block. Code is left alone.
 */
export function withMediaAsPageReads(body: string, ctx: TranslateContext): string {
  const all = lines(body);
  const code = codeKeys(all);
  return all.map((line, k) => (code[k] !== null ? line : (mediaForm(line, ctx) ?? line))).join("\n");
}

/** `line` with each embed of a note that has a page written as its mention reads in Obsidian, or null when it holds none. */
function noteEmbedForm(line: string, pageHolds: ReadonlySet<string>, ctx: TranslateContext): string | null {
  if (!line.includes("![[") || line.includes("`") || pageHolds.has(line)) return null;
  const form = line.replace(NOTE_EMBED, (embed) => {
    const written = toNotion(embed, ctx);
    return written.startsWith("<mention-page ") && !written.includes("\n") ? toObsidian(written, ctx).trimEnd() : embed;
  });
  return form === line ? null : form;
}

export interface MergeOutcome {
  body: string;
  conflicted: boolean;
  /** Notion's version of the note in Obsidian form, for the conflict copy. */
  notionVersion: string;
  /** Notion's edits couldn't be placed line by line, so Notion's version is the whole page translated. */
  whole: boolean;
}

/** Both sides changed: merge like git, keeping Obsidian's text where the edits overlap. */
export function mergeResult(record: SyncRecord, body: string, markdown: string, ctx: TranslateContext): MergeOutcome {
  const base = recordBody(record);
  const placed = pullResult(record, base, markdown, ctx);
  const notionVersion = placed ?? toObsidian(markdown, ctx);
  const merged = threeWay(lines(base), lines(body), lines(notionVersion));
  return { body: merged.lines.join("\n"), conflicted: merged.conflicted, notionVersion, whole: placed === null };
}

// --- When a whole side may be rewritten, and when both sides already say the same -------------------------

/** How many lines of `a` and `b` (keys) a longest common subsequence pairs. */
function shared(a: string[], b: string[]): number {
  let n = 0;
  for (let link: ReturnType<typeof LCS> | null = LCS(a, b); link && link.buffer1index >= 0; link = link.chain) n++;
  return n;
}

/** A note's line as written, except that trailing spaces only count as a hard line break (two or more). */
const noteForm = (line: string) => line.replace(/[ \t]+$/, (space) => (space.length >= 2 ? "  " : ""));

/**
 * Whether the note can be rewritten from Notion's text without losing anything: every line of it that holds
 * something (link forms, list markers, callout types, heading levels, hard breaks, code layout) comes back
 * exactly as it is from `markdown`, the page as Notion keeps it for this note (its record's), read the way a
 * rewrite reads it. A code block's language may come back under Notion's name for it.
 */
export function noteKeepsAll(body: string, markdown: string, ctx: TranslateContext): boolean {
  const keep = (text: string[]) => {
    const sep = separators(text, "note");
    return withLanguage(text).flatMap((line, k) => (sep[k] ? [] : [noteForm(line)]));
  };
  const mine = keep(lines(body));
  return shared(mine, keep(lines(toObsidian(markdown, ctx)))) === mine.length;
}

/**
 * A page's line with Notion's own variants of the same thing in one form: a page mention with or without its
 * title, Notion page URLs, and a table's row and cell lines without indentation (Notion writes them flush left).
 */
const pageForm = (line: string) =>
  (/^[ \t]*<\/?(?:tr|td|th)\b/.test(line) ? line.trimStart() : line)
    .replace(/<mention-page\s+url="([^"]*)"[^>]*?(?:\/>|>[\s\S]*?<\/mention-page>)/g, (_m, url: string) => `<mention-page ${idFromUrl(url) ?? url}/>`)
    .replace(/\]\((https?:\/\/[^)\s]*notion\.(?:so|com|site)\/[^)\s]*)\)/g, (_m, url: string) => `](${idFromUrl(url) ?? url})`)
    .trimEnd();

/**
 * Whether the page can be rewritten from the note without losing anything: every line of it that holds
 * something comes back exactly as it is in its own round trip through the note's form, so no file, embed, date
 * or person mention, color, column, toggle, callout icon or empty block (a blank line typed in Notion) would go.
 */
export function pageKeepsAll(markdown: string, ctx: TranslateContext): boolean {
  // A block of a vault file comes back as the block its citation calls for, which can be another kind than the one the page holds (an
  // image block holding a docx comes back as a file block, spec §5.9): same file, same caption, nothing lost, so the kind is left out.
  const ofFile = (line: string) => {
    const media = mediaLine(line);
    return media !== null && placeholderPath(media.url) !== null ? `${media.indent}<media src="${media.url}">${media.caption}</media>` : line;
  };
  const keep = (text: string[]) => {
    const code = codeKeys(text);
    return text.flatMap((line, k) => (code[k] !== null ? [code[k]!] : line.trim() === "" ? [] : [pageForm(ofFile(line))]));
  };
  const mine = keep(lines(markdown));
  return shared(mine, keep(lines(toNotion(toObsidian(markdown, ctx), ctx)))) === mine.length;
}

/** What a line opens with in Obsidian's form: indentation, quote markers, a list marker and task box, a heading's `#`s. */
const OPENING = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])(?:[ \t]+\[[ xX]\])?(?:[ \t]+|$)|#{1,6}(?:[ \t]+|$))?/;

/**
 * A text in Obsidian's form, line by line as it shows: code exactly, and other lines with the forms Notion and
 * Obsidian write the same thing in made one (page links and mentions as page ids, literal `*`, `_` and `~`, `_`
 * emphasis, backslashes that change nothing; see `shownInline`).
 */
function shownLines(text: string): string[] {
  const all = lines(text.normalize("NFC"));
  const code = codeKeys(all);
  return all.map((line, k) => {
    if (code[k] !== null) return line.trimEnd();
    const opening = OPENING.exec(line)![0];
    return (opening + shownInline(samePages(line.slice(opening.length)))).trimEnd();
  });
}

/**
 * Whether the note and the page say the same thing: the page read in Obsidian's form, line by line, nesting,
 * blank lines and code included, against the note read the same way after Notion keeps it (its code block
 * languages under Notion's names, nested code flush left), so a `$$ x $$` line reads as the formula and Notion's
 * own forms (a mention or a link of a page outside the database, a bookmark, a callout's icon, colors and empty
 * blocks) read as the note shows them. Both are read exactly as Notion holds them (`toObsidian`'s `exact`): code
 * as written, and escaped text, such as a link's text or `\|`, apart from a link or a table, so two texts Notion
 * holds differently never agree.
 */
export function sayTheSame(body: string, markdown: string, ctx: TranslateContext): boolean {
  return same(shownLines(toObsidian(markdown, ctx, true)), shownLines(toObsidian(keptByNotion(toNotion(body, ctx)), ctx, true)));
}

