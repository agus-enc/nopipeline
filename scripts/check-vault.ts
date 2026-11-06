// Read-only: translates every note of a vault to Notion's format and back, in memory, and reports
// notes that fail, lose words (counting repeats), or come back in a form that translates differently (an embed of a
// note, a mention in Notion, comes back as the link it reads as, and counts as the same).
// It also counts the note lines that have no counterpart in their own round trip, first by the exact line
// key used before the final review and then with the three matching passes: a Notion edit to such a line
// can't be placed line by line.
// Then it simulates Notion edits: for every note, each content line of its page (as Notion keeps it: nested
// code blocks flush left, see test/helpers/fake-notion.ts) is edited, has a line inserted after it, and is
// deleted (with the lines nested under it, as Notion deletes a block), one at a time, and each edit is pulled
// into the note as a sync would. A pulled note is right when, as Notion would keep it, it is what the
// translator reads from Notion's new text (for a one-line edit, exactly that text); a result that isn't is
// wrong (an edit placed on the wrong line). Edits the translator writes back in another form, and deletions
// of a block with lines nested under it, are counted apart. Unplaced edits are counted too: a sync skips those
// notes. It also counts the results the line matching alone would get wrong, which the pull's own check refuses.
// Then it simulates Obsidian edits: each line of every note is edited, one at a time, pushed as a sync would, and
// each edit's search text sent, as the tool sends it, to the fake Notion's model of what Notion's search finds (page
// mentions by their current title, see test/helpers/fake-notion.ts). A push is right when the page it leaves is the
// placed text as Notion keeps it; refused searches and wrong pages are counted, and so are the edits whose search
// text holds a page mention (which Notion refused every time before it was fixed).
// It counts the lines of the Notion translation that Notion would merge with the lines after them (a line with an odd
// number of backticks, escaped ones counted, and a later line with a backtick, before any fence: live probes
// 2026-10-08 and 2026-10-09, modelled in test/helpers/notion-model.ts), and those it holds as written but reads back as
// something else the next time the page is written (src/translate/rereads.ts); such a note's edits aren't simulated,
// since its page doesn't hold it.
// It lists the code block languages the vault uses (the language each fence is written with), so their names in
// Notion can be checked.
// It also counts, as a sync's conversion would, the `[[links]]` it turns into Markdown links (to notes, and to notes
// that don't exist) and the embeds (`![[...]]`) it leaves, outside code. Every run converts them before it plans, so
// all of the above is checked on the notes as converted, in memory (nothing is written).
// The notes are translated with the vault's images, as a sync does (a note's lone image citation is a Notion image), so
// all of the above covers image lines too; the notes holding some, and their lines, are counted apart (IMAGES line), and the placeholder lines of every kind of block are counted (ATTACHMENTS line).
// Exits 1 if any note fails, loses words or is unstable, any simulated edit is pulled wrong, or any simulated push is
// refused or leaves a wrong page.
// Writes nothing anywhere. With --digest it also prints a digest of each note's Notion translation (to compare
// two versions of the translator), and with --show <note path> that note's body (NOTE lines) and its Notion translation
// (SHOW lines), checking only that note.
// Usage: node scripts/check-vault.ts <vault path> [vault name] [--digest] [--show <note path>]
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { LCS } from "node-diff3";
import { convertNotes } from "../src/links/convert.ts";
import { baseName, buildLinkIndex } from "../src/links/index.ts";
import { outsideCode } from "../src/links/rewrite.ts";
import { contentUpdates } from "../src/merge/edits.ts";
import { counterparts, separators, transplant } from "../src/merge/lines.ts";
import { isImageLine, mediaKind, mediaLine, placeholderPath, type MediaKind } from "../src/notion/hosted.ts";
import { idFromUrl } from "../src/notion/ids.ts";
import { searchTexts } from "../src/notion/search.ts";
import { mentionsAsLinks, pullResult, pushResult } from "../src/run/content.ts";
import { parseObsidian, type Block } from "../src/translate/blocks.ts";
import { toNotion, toObsidian, words, type TranslateContext } from "../src/translate/index.ts";
import type { SyncRecord } from "../src/types.ts";
import { splitFrontmatter } from "../src/vault/frontmatter.ts";
import { scanMedia } from "../src/vault/images.ts";
import { DEFAULT_STATUS_NOTE } from "../src/config.ts";
import { scanVault } from "../src/vault/scan.ts";
import { asNotionKeeps, searchAndReplace } from "../test/helpers/fake-notion.ts";
import { joins } from "../test/helpers/notion-model.ts";
import { rereadByNotion } from "../src/translate/rereads.ts";

/** The line key and matching transplant used before the final review: layout and Notion URL forms only. */
function exactCounterparts(from: string[], to: string[]): number[] {
  const key = (line: string) =>
    line
      .replace(/^[ \t]*/, "")
      .replace(/[ \t]*\{(?:[a-z_-]+="[^"]*"[ \t]*)+\}[ \t]*$/i, "")
      .replace(/<mention-page\s+url="([^"]*)"[^>]*?(?:\/>|>[\s\S]*?<\/mention-page>)/g, (_m, url: string) => `<mention-page ${idFromUrl(url) ?? url}/>`)
      .replace(/\]\((https?:\/\/[^)\s]*notion\.(?:so|com|site)\/[^)\s]*)\)/g, (_m, url: string) => `](${idFromUrl(url) ?? url})`);
  const a = from.map(key);
  const b = to.map(key);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const map = new Array<number>(from.length).fill(-1);
  for (let k = 0; k < head; k++) map[k] = k;
  for (let k = 1; k <= tail; k++) map[a.length - k] = b.length - k;
  let link: ReturnType<typeof LCS> | null = LCS(a.slice(head, a.length - tail), b.slice(head, b.length - tail));
  while (link && link.buffer1index >= 0) {
    map[link.buffer1index + head] = link.buffer2index + head;
    link = link.chain;
  }
  return map;
}

/** Lines of `note` that need a counterpart (not blank lines between blocks) and are no line's counterpart. */
function alone(map: number[], note: string[]): number {
  const found = new Set(map);
  const between = separators(note, "note");
  return note.filter((_line, t) => !between[t] && !found.has(t)).length;
}

/** Lines of Notion markdown an edit in Notion can touch: text and code lines, not tags, fences or `$$` lines. */
function contentLines(lines: string[]): { k: number; code: boolean }[] {
  const out: { k: number; code: boolean }[] = [];
  let fence: string | null = null;
  lines.forEach((raw, k) => {
    const line = raw.replace(/^\t+/, "").trim();
    if (fence !== null) {
      if (line === fence) fence = null;
      else if (line !== "") out.push({ k, code: true });
      return;
    }
    const open = /^(`{3,})[^`]*$/.exec(line);
    if (open) fence = open[1]!;
    else if (line !== "" && line !== "$$" && !/^<\/?[a-z_-]+(\s[^>]*)?\/?>$/.test(line)) out.push({ k, code: false });
  });
  return out;
}

/** Where the block that starts at line `k` ends: after the lines nested under it, a nested code block's all. */
function blockEnd(lines: string[], k: number): number {
  const depth = /^\t*/.exec(lines[k]!)![0].length;
  let j = k + 1;
  while (j < lines.length && lines[j]!.trim() !== "" && /^\t*/.exec(lines[j]!)![0].length > depth) {
    const fence = /^\t*(`{3,})[^`]*$/.exec(lines[j]!)?.[1];
    j++;
    if (fence !== undefined) {
      while (j < lines.length && lines[j]!.trim() !== fence) j++;
      if (j < lines.length) j++;
    }
  }
  return j;
}

/** Notion's text after one edit at line `k`: changed, a line inserted after it, or deleted (a block with the lines nested under it). */
function edited(lines: string[], k: number, kind: "edit" | "insert" | "delete", code: boolean): string {
  const line = lines[k]!;
  const tabs = /^\t*/.exec(line)![0];
  if (kind === "edit") {
    const m = /^(.*?)((?:<\/[a-z]+>)?)([ \t]*\{(?:[a-z_-]+="[^"]*"[ \t]*)+\})?$/.exec(line)!;
    return [...lines.slice(0, k), `${m[1]} zqx${m[2]}${m[3] ?? ""}`, ...lines.slice(k + 1)].join("\n");
  }
  if (kind === "insert") return [...lines.slice(0, k + 1), `${tabs}zqx inserted`, ...lines.slice(k + 1)].join("\n");
  return [...lines.slice(0, k), ...lines.slice(code ? k + 1 : blockEnd(lines, k))].join("\n");
}

/** The info string of every code block in `blocks`, nested ones included. */
function fenceInfos(blocks: Block[]): string[] {
  return blocks.flatMap((b) => (b.type === "code" ? [b.info] : "children" in b ? fenceInfos(b.children) : []));
}

const args = process.argv.slice(2);
const digest = args.includes("--digest");
const showAt = args.indexOf("--show");
const show = showAt === -1 ? null : args[showAt + 1];
const [root, name] = args.filter((arg, k) => !arg.startsWith("--") && (showAt === -1 || k !== showAt + 1));
if (!root || (showAt !== -1 && !show)) {
  console.error("usage: node scripts/check-vault.ts <vault path> [vault name] [--digest] [--show <note path>]");
  process.exit(2);
}
const vaultName = name ?? basename(root);
const scan = await scanVault(root, DEFAULT_STATUS_NOTE);
const media = await scanMedia(root);
/** A page id for a note that has none yet, the same every run (so translations compare between runs). */
const idFor = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-");
const index = buildLinkIndex([
  ...scan.notes.map((n) => ({ path: n.path, pageId: n.notionId ?? idFor(n.path), title: n.notionTitle ?? baseName(n.path) })),
  ...scan.drawings.map((path) => ({ path, pageId: null, title: baseName(path) })),
]);
// The [[links]] a sync converts, by what they point at; the notes as that conversion leaves them are the ones checked.
const toward = { notes: 0, missing: 0 };
const converting = convertNotes(scan.notes, scan.drawings, (toNote) => void (toNote ? toward.notes++ : toward.missing++));
const convertedText = new Map(converting.map((c) => [c.path, c.text]));
const notes = scan.notes.map((note) => {
  const text = convertedText.get(note.path);
  return text === undefined ? note : { ...note, text, body: splitFrontmatter(text).body };
});
const visible = (text: string) => words(text.replace(/\]\([^)]*\)/g, "]").replace(/\[\[([^\]|]*)\|/g, "[[").replace(/\[![\w-]+\][+-]?/g, ""));
/**
 * A note's text as the words check reads it: an attachment's file name (and the `#page=3` after it) is no word of the text and a
 * size (`|300`) in an image's alias is dropped by the translator (the caption stays), so neither counts as lost.
 */
const MEDIA_EMBED = /!\[\[([^\]|\n#]+)(#[^\]|\n]*)?((?:\|[^\]\n]*)?)\]\]/g;
const SIZE = /^\d+(?:x\d+)?$/;
const withoutImageNames = (text: string) =>
  text
    .replace(MEDIA_EMBED, (whole, target: string, _section: string | undefined, alias: string) =>
      mediaKind(target) === null ? whole : ` ${alias.split("|").filter((part) => part !== "" && !SIZE.test(part.trim())).join("|")} `,
    )
    .replace(/(!\[[^\]\n]*?)\|\d+(?:x\d+)?\]\(/g, "$1](");
let failed = 0;
let imageNotes = 0;
let imageLines = 0;
/** The translated lines that are placeholders of vault files, per kind of block: the blocks a sync's first run would upload. */
const attachmentLines: Record<MediaKind, number> = { image: 0, pdf: 0, audio: 0, video: 0, file: 0 };
let lossy = 0;
let unstable = 0;
let lines = 0;
let aloneBefore = 0;
let aloneAfter = 0;
const worst: { path: string; before: number; after: number }[] = [];
/** Simulated edits, one-line ones and the others (more lines on either side, as the translator reads them). */
const tally = () => ({ edits: 0, right: 0, unplaced: 0, wrong: 0, wrongRaw: 0 });
const simulated = { oneLine: tally(), other: tally() };
const wrongNotes = new Map<string, number>();
const unplacedNotes = new Map<string, number>();

/**
 * Pulls each simulated Notion edit of `note`'s page and tallies the results. A pull is right when the note it
 * gives is, as Notion would keep it, what the translator reads from Notion's new text: for a one-line edit,
 * exactly that text. Edits the translator writes back in another form, and deletions of a block with the lines
 * nested under it, are counted apart.
 */
function simulate(path: string, body: string, notion: string, ctx: TranslateContext): void {
  // The page as Notion keeps what the tool wrote, and a note's text as Notion would keep it.
  // An embedded note is the mention alone, which Notion's edit of it reads back as a link: the two count as the same text.
  const kept = (note: string) => asNotionKeeps(mentionsAsLinks(toNotion(note, ctx), ctx));
  const stored = asNotionKeeps(notion);
  const record: SyncRecord = { notionId: "check", path, title: baseName(path), folder: null, obsidianText: body, notionMarkdown: stored, notionSeenAt: "", syncedAt: "" };
  const page = stored.split("\n");
  const base = toObsidian(stored, ctx).split("\n");
  const own = body.split("\n");
  for (const { k, code } of contentLines(page)) {
    for (const kind of ["edit", "insert", "delete"] as const) {
      const after = edited(page, k, kind, code);
      const expected = kept(toObsidian(after, ctx));
      // One-line edits are those whose page text the translator writes the same way back.
      const oneLine = expected === mentionsAsLinks(after, ctx) && (kind !== "delete" || after.split("\n").length === page.length - 1);
      const counts = oneLine ? simulated.oneLine : simulated.other;
      counts.edits++;
      const raw = transplant(base, toObsidian(after, ctx).split("\n"), own);
      if (raw !== null && kept(raw.join("\n")) !== expected) counts.wrongRaw++;
      const pulled = pullResult(record, body, after, ctx);
      if (pulled === null) {
        counts.unplaced++;
        unplacedNotes.set(path, (unplacedNotes.get(path) ?? 0) + 1);
      } else if (kept(pulled) === expected) {
        counts.right++;
      } else {
        counts.wrong++;
        wrongNotes.set(path, (wrongNotes.get(path) ?? 0) + 1);
      }
    }
  }
}

/** Simulated Obsidian edits pushed to Notion. */
const pushes = { edits: 0, right: 0, unplaced: 0, whole: 0, refused: 0, wrong: 0, mentions: 0, refusedBefore: 0, rereads: 0 };
const refusedNotes = new Map<string, number>();
const wholeNotes = new Map<string, number>();
const unplacedPushes = new Map<string, number>();

/** A page's title, as Notion's search shows it in a mention: every note's page is in the database, with its title. */
const titleOf = new Map(scan.notes.map((n) => [n.notionId ?? idFor(n.path), n.notionTitle ?? baseName(n.path)]));

/**
 * Pushes an edit to each line of `note` (one at a time) as a sync would, sending each search text in the form the
 * tool sends it to the fake's model of Notion's search. Lines that are only a fence or `$$` are left out.
 */
function simulatePush(path: string, body: string, notion: string, ctx: TranslateContext): void {
  const stored = asNotionKeeps(notion);
  const record: SyncRecord = { notionId: "check", path, title: baseName(path), folder: null, obsidianText: body, notionMarkdown: stored, notionSeenAt: "", syncedAt: "" };
  const own = body.split("\n");
  const title = (id: string | null) => (id === null ? null : (titleOf.get(id) ?? null));
  own.forEach((line, k) => {
    if (line.trim() === "" || /^[ \t]*(?:>[ \t]?)*[ \t]*(?:`{3,}|~{3,}|\$\$)/.test(line)) return;
    pushes.edits++;
    const edited = [...own.slice(0, k), `${line} zqx`, ...own.slice(k + 1)].join("\n");
    const placed = pushResult(record, edited, stored, ctx);
    if (placed === null) {
      pushes.unplaced++;
      unplacedPushes.set(path, (unplacedPushes.get(path) ?? 0) + 1);
      return;
    }
    // A write the tool refuses: Notion would read a line of the page back as something else (`writePage`).
    if (rereadByNotion(toNotion(edited, ctx)).length || rereadByNotion(placed).length) return void pushes.rereads++;
    // An image line is never in a search text (Notion doesn't find one), as in a sync's write.
    const edits = contentUpdates(stored, placed, undefined, isImageLine);
    if (edits === null) {
      pushes.whole++;
      wholeNotes.set(path, (wholeNotes.get(path) ?? 0) + 1);
      return;
    }
    let text = stored;
    for (const edit of edits) {
      if (/<mention-page\s/.test(edit.old_str)) {
        pushes.mentions++;
        try {
          searchAndReplace(text, edit.old_str, edit.new_str, title);
        } catch {
          pushes.refusedBefore++;
        }
      }
      const texts = searchTexts(stored, edit.old_str, (id) => (titleOf.has(id) ? { title: titleOf.get(id)!, trashed: false } : null)) ?? [];
      let next: string | null = null;
      for (const old of texts) {
        try {
          next = searchAndReplace(text, old, edit.new_str, title);
          break;
        } catch {
          // the next form, if any
        }
      }
      if (next === null) {
        pushes.refused++;
        refusedNotes.set(path, (refusedNotes.get(path) ?? 0) + 1);
        return;
      }
      text = asNotionKeeps(next, text);
    }
    if (text === asNotionKeeps(placed, stored)) pushes.right++;
    else pushes.wrong++;
  });
}

/** Lines of Notion translations that Notion would merge with the lines after them, per note. */
const merging = new Map<string, number>();
/** Lines of Notion translations that Notion holds as written but reads back as something else, per note. */
const rereading = new Map<string, number>();

/** Code block languages: info string -> [blocks, notes]. */
const languages = new Map<string, [number, number]>();

for (const note of notes) {
  // With --show, only that note is checked.
  if (show && note.path !== show) continue;
  const ctx = { index, fromPath: note.path, vaultName, media };
  try {
    const body = note.body.replace(/\r\n/g, "\n");
    const notion = toNotion(body, ctx);
    let imaged = 0;
    for (const line of notion.split("\n")) {
      const found = mediaLine(line);
      if (found === null || placeholderPath(found.url) === null) continue;
      attachmentLines[found.kind]++;
      if (found.kind === "image") imaged++;
    }
    if (imaged > 0) imageNotes++;
    imageLines += imaged;
    if (digest) console.log(`DIGEST ${createHash("sha256").update(notion).digest("hex").slice(0, 16)}  ${note.path}`);
    if (show === note.path) {
      for (const [k, line] of body.split("\n").entries()) console.log(`NOTE ${String(k + 1).padStart(4)}  ${line}`);
      for (const [k, line] of notion.split("\n").entries()) console.log(`SHOW ${String(k + 1).padStart(4)}  ${line}`);
    }
    const infos = fenceInfos(parseObsidian(body.split("\n")));
    for (const info of infos) languages.set(info, [(languages.get(info)?.[0] ?? 0) + 1, languages.get(info)?.[1] ?? 0]);
    for (const info of new Set(infos)) languages.get(info)![1]++;
    const back = toObsidian(notion, ctx);
    const own = body.split("\n");
    const trip = back.split("\n");
    const before = alone(exactCounterparts(trip, own), own);
    const after = alone(counterparts(trip, own), own);
    lines += own.filter((line) => line.trim() !== "").length;
    aloneBefore += before;
    aloneAfter += after;
    if (before > 0 || after > 0) worst.push({ path: note.path, before, after });
    const kept = new Map<string, number>();
    for (const w of visible(back).split(" ")) if (w) kept.set(w, (kept.get(w) ?? 0) + 1);
    const lost: string[] = [];
    for (const w of visible(withoutImageNames(note.body)).split(" ")) {
      if (!w) continue;
      const left = kept.get(w) ?? 0;
      if (left > 0) kept.set(w, left - 1);
      else lost.push(w);
    }
    if (lost.length) {
      lossy++;
      console.log(`LOST WORDS  ${note.path}: ${[...new Set(lost)].slice(0, 8).join(", ")}`);
    }
    // An embed of a note is a mention in Notion and a link in the note once read back: the same text, as for the pulls.
    if (mentionsAsLinks(toNotion(back, ctx), ctx) !== mentionsAsLinks(notion, ctx)) {
      unstable++;
      console.log(`UNSTABLE    ${note.path}`);
    }
    // A page whose lines Notion merges, or holds as written but reads back as something else, doesn't hold the note:
    // edits to it aren't simulated (counted apart; the tool refuses to write such a page).
    const reread = rereadByNotion(notion).length;
    if (reread) rereading.set(note.path, reread);
    const merges = joins(notion.split("\n")).count;
    if (merges) merging.set(note.path, merges);
    if (!merges && !reread) {
      simulate(note.path, body, notion, ctx);
      simulatePush(note.path, body, notion, ctx);
    }
  } catch (error) {
    failed++;
    console.log(`FAILED      ${note.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(
  `Line matching: of ${lines} non-blank note lines, ${aloneBefore} have no counterpart in their round trip by the exact key alone, ${aloneAfter} after the three passes (a Notion edit to one of them can't be placed line by line).`,
);
worst.sort((x, y) => y.after - x.after || y.before - x.before || (x.path < y.path ? -1 : 1));
for (const { path, before, after } of worst.slice(0, 10)) console.log(`  ${String(after).padStart(4)} (exact key: ${String(before).padStart(4)})  ${path}`);
const { oneLine, other } = simulated;
console.log(
  `Simulated Notion edits (each content line changed, a line inserted after it, and deleted with the lines nested under it): ${oneLine.edits} one-line edits: ${oneLine.right} pulled right, ${oneLine.unplaced} not placed (the note would be skipped), ${oneLine.wrong} pulled wrong. ${other.edits} more edits the translator writes back in another form, or that delete a block with the lines nested under it: ${other.right} pulled as the translator reads Notion's new text, ${other.unplaced} not placed, ${other.wrong} pulled wrong. The line matching alone would place ${oneLine.wrongRaw} and ${other.wrongRaw} of them wrong; the pull's own check refuses those.`,
);
const ranked = (counts: Map<string, number>) => [...counts].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 10);
for (const [path, n] of ranked(wrongNotes)) console.log(`  WRONG ${String(n).padStart(4)}  ${path}`);
for (const [path, n] of ranked(unplacedNotes)) console.log(`  not placed ${String(n).padStart(4)}  ${path}`);
console.log(
  `Simulated Obsidian edits (each note line changed and pushed, each search text sent as the tool sends it): ${pushes.edits} edits: ${pushes.right} written right, ${pushes.unplaced} not placed (the note would be skipped), ${pushes.rereads} not written (a line Notion would read back as something else), ${pushes.whole} written as a whole page, ${pushes.refused} refused by Notion's search, ${pushes.wrong} written wrong. ${pushes.mentions} search texts held a page mention; sent as Notion returns them, ${pushes.refusedBefore} of them would have been refused.`,
);
for (const [path, n] of ranked(refusedNotes)) console.log(`  REFUSED ${String(n).padStart(4)}  ${path}`);
for (const [path, n] of ranked(unplacedPushes)) console.log(`  not placed ${String(n).padStart(4)}  ${path}`);
for (const [path, n] of ranked(wholeNotes)) console.log(`  whole page ${String(n).padStart(4)}  ${path}`);
console.log(
  `Lines Notion would merge with the lines after them (a backtick left alone, which Notion pairs with a later one): ${[...merging.values()].reduce((a, b) => a + b, 0)} in ${merging.size} notes, whose edits aren't simulated.`,
);
for (const [path, n] of ranked(merging)) console.log(`  MERGES ${String(n).padStart(4)}  ${path}`);
console.log(
  `Lines Notion would read back as something else the next time their page is written (the tool writes none of those pages, not even to create or pair them): ${[...rereading.values()].reduce((a, b) => a + b, 0)} in ${rereading.size} notes, whose edits aren't simulated.`,
);
for (const [path, n] of ranked(rereading)) console.log(`  REREADS ${String(n).padStart(4)}  ${path}`);
const fenced = [...languages].sort((x, y) => y[1][0] - x[1][0] || (x[0] < y[0] ? -1 : 1));
console.log(`Code block languages: ${fenced.map(([info, [blocks, notes]]) => `${JSON.stringify(info)} ${blocks} in ${notes} notes`).join(", ") || "none"}`);
// The embeds a sync's conversion leaves.
let embeds = 0;
for (const note of scan.notes) {
  outsideCode(splitFrontmatter(note.text).body, (part) => {
    embeds += part.match(/!\[\[[^\]\n]+?\]\]/g)?.length ?? 0;
    return part;
  });
}
console.log(`LINKS converted ${toward.notes + toward.missing} in ${converting.length} notes (${toward.notes} to notes, ${toward.missing} to missing notes), ${embeds} embeds left`);
console.log(`IMAGES ${imageLines} image lines in ${imageNotes} notes are translated as Notion images (the vault holds ${media.folder === "" ? "its images in the vault root" : `its attachment folder at ${media.folder}`}); all of the above counts them`);
// On a vault that held no PDF, audio, video or file citations before, every kind but image is 0: no note gains a block a sync would upload.
console.log(`ATTACHMENTS ${(Object.entries(attachmentLines) as [MediaKind, number][]).map(([kind, n]) => `${kind} ${n}`).join(", ")}`);
console.log(`${scan.notes.length} notes, ${scan.drawings.length} drawings: ${failed} failed, ${lossy} lost words, ${unstable} unstable`);
process.exitCode = failed + lossy + unstable + oneLine.wrong + other.wrong + pushes.refused + pushes.wrong > 0 ? 1 : 0;
