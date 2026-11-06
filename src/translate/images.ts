// Attachment citations: a note's lone `![[x.png]]`, `![[x.pdf]]`, `[[x.docx]]` or `[t](x.mp4)` as a Notion image, PDF, audio, video
// or file block on a line of its own, and back.
import { posix } from "node:path";
import { mediaKind, mediaLine, PLACEHOLDER_BASE, placeholderPath, placeholderUrl, type MediaKind } from "../notion/hosted.ts";
import type { Block } from "./blocks.ts";
import { escapeNotionText, type TranslateContext } from "./context.ts";
import { toNotionInline } from "./inline.ts";
import type { VaultMedia } from "../vault/images.ts";

type WithMedia = TranslateContext & { media: VaultMedia };

/** A citation as a note writes it: an embed (`!`) or a link, where it points and the pieces of its alias (the size among them). */
interface Citation {
  embed: boolean;
  target: string;
  parts: string[];
}

const WIKI = /^(!?)\[\[([^\]\n]+)\]\]$/;
const MARKDOWN = /^(!?)\[((?:[^\]\\]|\\.)*)\]\((?:<([^>]*)>|((?:[^\s()<>]|\([^\s()]*\))*))\)$/;
const SIZE = /^\d+(x\d+)?$/;

/** What `text` cites, if it is one embed or link and nothing else, whether its target is a vault file or not. A web address is no citation of a vault file. */
function citation(text: string): Citation | null {
  const wiki = WIKI.exec(text);
  if (wiki) {
    const [target = "", ...parts] = wiki[2]!.replace(/\\\|/g, "|").split("|");
    return { embed: wiki[1] === "!", target: target.trim(), parts };
  }
  const markdown = MARKDOWN.exec(text);
  if (!markdown) return null;
  const dest = markdown[3] ?? markdown[4] ?? "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(dest)) return null;
  let target = dest;
  try {
    target = decodeURIComponent(dest);
  } catch {
    // keep the raw destination
  }
  const embed = markdown[1] === "!";
  // An embed's alias may carry a size after a `|`; a link's text is all text.
  return { embed, target: target.trim(), parts: embed ? markdown[2]!.split("|") : [markdown[2]!] };
}

/** The caption of a citation: an embed's alias without the sizes (`300`, `300x200`), a link's text. */
const captionOf = (cited: Citation) => (cited.embed ? cited.parts.filter((part) => !SIZE.test(part.trim())) : cited.parts).join("|").trim();

/**
 * The ways to read a target: as written, and, when it has a fragment (`Manual.pdf#page=3&height=400`), without it. Notion's blocks
 * hold no page or height, so the fragment is dropped for any file but an image, whose citations never had one (spec §3).
 */
function readings(target: string): string[] {
  const hash = target.indexOf("#");
  return hash > 0 ? [target, target.slice(0, hash)] : [target];
}

/** The vault file `cited` means (or, with `find`, the one that is over the upload limit), or null. */
function fileOf(cited: Citation, ctx: WithMedia, find: (target: string, fromPath: string) => string | null): string | null {
  for (const target of readings(cited.target)) {
    const path = find(target, ctx.fromPath);
    if (path !== null && (target === cited.target || mediaKind(path) !== "image")) return path;
  }
  return null;
}
const resolved = (cited: Citation, ctx: WithMedia) => fileOf(cited, ctx, (target, from) => ctx.media.resolve(target, from));
const oversized = (cited: Citation, ctx: WithMedia) => fileOf(cited, ctx, (target, from) => ctx.media.oversized(target, from));

/** The vault path, block kind and caption of `text` when it is a lone citation of a file the sync can upload (or already holds), else null. */
function loneMedia(text: string, ctx: WithMedia): { path: string; kind: MediaKind; link: boolean; caption: string } | null {
  const cited = citation(text);
  const path = cited && resolved(cited, ctx);
  if (!cited || !path) return null;
  // An embed makes the block of the file's kind; a link is a file block for any kind, images included (spec §5.9).
  const kind = cited.embed ? mediaKind(path)! : "file";
  let caption = captionOf(cited);
  // A file block captioned with the file's own name says nothing the block doesn't (the link reads back so).
  if (kind === "file" && [path, cited.target.split("#")[0]!].some((name) => caption.normalize("NFC") === posix.basename(name).normalize("NFC"))) caption = "";
  return { path, kind, link: !cited.embed, caption };
}

/** The block for a lone citation, unless its caption would not read back as the line of that block. */
function mediaBlock(text: string, ctx: WithMedia): Block | null {
  const found = loneMedia(text.trim(), ctx);
  if (!found) return null;
  const target = placeholderUrl(found.path);
  const written = toNotionInline(found.caption, ctx).replace(/\n/g, "<br>");
  const line = found.kind === "image" ? `![${written}](${target})` : `<${found.kind} src="${target}">${written}</${found.kind}>`;
  return mediaLine(line)?.kind === found.kind ? { type: "media", kind: found.kind, link: found.link, caption: found.caption, target } : null;
}

/**
 * `text` of an item or a quote without the lone citations that end it (each a line of its own, with text before them), and the blocks
 * they make, in order. Blank lines between and after them go; text after a citation keeps it text.
 */
function trailingMedia(text: string, ctx: WithMedia, quote: boolean): { text: string; media: Block[] } {
  const lines = text.split("\n");
  const media: Block[] = [];
  let end = lines.length;
  while (end > 1) {
    if (lines[end - 1]!.trim() === "") {
      end--;
      continue;
    }
    const block = mediaBlock(lines[end - 1]!, ctx);
    if (!block) break;
    media.unshift(block);
    end--;
  }
  const kept = lines.slice(0, end);
  while (kept.length > 1 && kept[kept.length - 1]!.trim() === "") kept.pop();
  // Citations with nothing before them are not an item's tail but its text; a quote that is left with only a citation is made of citations alone.
  const bare = kept.join("\n").trim() === "" || (quote && mediaBlock(kept.join("\n"), ctx) !== null);
  return bare || media.length === 0 ? { text, media: [] } : { text: kept.join("\n"), media };
}

/**
 * `blocks` of an Obsidian note with each lone citation of a vault file as a block of its own: a paragraph's line that is only a
 * citation, and a list item whose text is only a citation, which becomes the empty item with the block as its
 * first child (live, spec §7 result 4: Notion reads it back that way). The citations that end an item's or a quote's
 * text become its children. A quote of only a citation, a callout, a table or a task of only a citation is
 * left alone: Notion holds no file there.
 */
export function mediaToNotion(blocks: Block[], ctx: WithMedia): Block[] {
  return blocks.flatMap((b): Block[] => {
    if (b.type === "paragraph") {
      const out: Block[] = [];
      const run: string[] = [];
      const flush = () => {
        if (run.length) out.push({ type: "paragraph", text: run.join("\n") });
        run.length = 0;
      };
      for (const line of b.text.split("\n")) {
        const media = mediaBlock(line, ctx);
        if (media) {
          flush();
          out.push(media);
        } else {
          run.push(line);
        }
      }
      flush();
      return out.length === 1 && out[0]!.type === "paragraph" ? [b] : out;
    }
    if (b.type === "item" || b.type === "quote") {
      const { text, media } = trailingMedia(b.text, ctx, b.type === "quote");
      // An item that is only a citation is the empty item with the block as its first child (a task or a quote stays text).
      const whole = b.type === "item" && b.task === null && !text.includes("\n") ? mediaBlock(text, ctx) : null;
      const children = mediaToNotion(b.children, ctx);
      if (whole) return [{ ...b, text: "", children: [whole, ...media, ...children] }];
      return [media.length ? { ...b, text, children: [...media, ...children] } : { ...b, children }];
    }
    return [b];
  });
}

/**
 * `blocks` of a Notion page with each image, PDF, audio, video and file line written for a note: a placeholder URL as the
 * shortest citation of its file (an embed, or a link for a file block), any other URL as it is (an image as an embed of it, the rest left as the tag).
 * At the top, in list items and inside quotes, callouts and toggles (a file pasted
 * there in Notion is a block of its own; the note writes it as a line of the quote or callout); elsewhere the line is text, as before.
 */
export function mediaToObsidian(blocks: Block[], ctx: WithMedia): Block[] {
  return blocks.map((b): Block => {
    if (b.type === "item" || b.type === "quote" || b.type === "callout") return { ...b, children: mediaToObsidian(b.children, ctx) };
    const line = b.type === "paragraph" ? mediaLine(b.text) : null;
    if (!line || line.indent !== "") return b;
    const path = placeholderPath(line.url);
    if (path === null) return line.kind === "image" ? { type: "media", kind: "image", link: false, caption: line.caption, target: line.url } : b;
    const link = line.kind === "file";
    // A link needs text: the file's name when the block has no caption.
    const caption = line.caption === "" && link ? escapeNotionText(posix.basename(path)) : line.caption;
    return { type: "media", kind: line.kind, link, caption, target: ctx.media.pathFor(path, ctx.fromPath) };
  });
}

const PLACEHOLDER_URL = new RegExp(`${PLACEHOLDER_BASE.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}[^\\s()<>"']*`, "g");

/**
 * `markdown` (a note's text) with every placeholder URL still in it written as the citation of its file: the safety net
 * for a place `mediaToObsidian` doesn't reach (inline, a table cell, any block it doesn't know), where the URL would
 * otherwise reach the note and never open.
 */
export function placeholdersToCitations(text: string, ctx: WithMedia): string {
  return text.replace(PLACEHOLDER_URL, (url) => {
    const path = placeholderPath(url);
    return path === null ? url : ctx.media.pathFor(path, ctx.fromPath);
  });
}

/** Inline code spans blanked out: an embed inside one is text. */
const blankCode = (text: string) => text.replace(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m) => " ".repeat(m.length));
const EMBEDS = /!\[\[[^\]\n]+\]\]|!\[(?:[^\]\\\n]|\\.)*\]\((?:<[^>\n]*>|(?:[^\s()<>]|\([^\s()]*\))*)\)/g;

/** Whether `text` cites, somewhere in it, a vault file by an embed (one over the upload limit too). */
function embedsFile(text: string, ctx: WithMedia): boolean {
  return [...blankCode(text).matchAll(EMBEDS)].some((m) => {
    const cited = citation(m[0]);
    return cited !== null && (resolved(cited, ctx) !== null || oversized(cited, ctx) !== null);
  });
}

/** The lines `blocks` hold as text, as a note writes them (trimmed), each with its quote marker. */
function textLines(blocks: Block[], quote: string): string[] {
  return blocks.flatMap((b): string[] => {
    const lines = (text: string) => text.split("\n").map((l) => `${quote}${l}`.trim());
    switch (b.type) {
      case "paragraph":
      case "heading":
        return lines(b.text);
      case "item": {
        const [first = "", ...rest] = b.text.split("\n");
        return [`${quote}${b.marker} ${b.task === null ? "" : `[${b.task}] `}${first}`.trim(), ...lines(rest.join("\n")).filter(Boolean), ...textLines(b.children, quote)];
      }
      case "quote":
        return [...lines(b.text).map((l) => `> ${l}`.trim()), ...textLines(b.children, "> ")];
      case "callout":
        return [`> [!${b.kind}]${b.fold}${b.title ? ` ${b.title}` : ""}`, ...textLines(b.children, "> ")];
      case "table":
        return b.rows.map((row) => `| ${row.join(" | ")} |`);
      default:
        return [];
    }
  });
}

/**
 * Why a citation stays text on the page: it shares its line with other text (or sits in a quote, callout, table or task),
 * text follows it in its list item or quote, or its file is over the upload limit.
 */
export type StrandedWhy = "shared" | "followed" | "large";

export interface StrandedMedia {
  /** The note's line, trimmed. */
  line: string;
  why: StrandedWhy;
}

/** The quote and list markers (and a task's box) a line may start with before its text. */
const LINE_START = /^(?:>\s?)*(?:(?:[-+*]|\d+[.)])\s+(?:\[.\]\s+)?)?/;

function whyStranded(line: string, ctx: WithMedia): StrandedWhy | null {
  const lone = citation(line.replace(LINE_START, "").trim());
  if (lone) {
    if (resolved(lone, ctx) === null) return oversized(lone, ctx) !== null ? "large" : null;
    // A link alone on its line in a place no block is made from (a quote, a task) stays text too; a link in a sentence is text like any other.
    if (!lone.embed) return "shared";
    // Alone on its line with no marker, yet not a block: it is a continuation line, with text after it in its item or quote.
    if (LINE_START.exec(line)![0] === "") return "followed";
  }
  return embedsFile(line, ctx) ? "shared" : null;
}

/**
 * The lines of a note (trimmed) that cite a vault file but are not written as a block, each once, with why: shared with
 * other text, in a quote, a callout, a table or a task, or of a file over the upload limit (spec §5.1, §5.10).
 */
export function strandedFrom(blocks: Block[], ctx: WithMedia): StrandedMedia[] {
  const left = mediaToNotion(blocks, ctx);
  const found = new Map<string, StrandedWhy>();
  for (const line of textLines(left, "")) {
    const why = found.has(line) ? null : whyStranded(line, ctx);
    if (why !== null) found.set(line, why);
  }
  return [...found].map(([line, why]) => ({ line, why }));
}
