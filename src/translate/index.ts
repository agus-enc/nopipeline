// Whole-note translation between an Obsidian body and a Notion page's enhanced markdown.
import { parseNotion, parseObsidian, writeNotion, writeObsidian } from "./blocks.ts";
import type { TranslateContext } from "./context.ts";
import { mediaToNotion, mediaToObsidian, placeholdersToCitations, strandedFrom, type StrandedMedia } from "./images.ts";
import { toNotionInline, toObsidianInline } from "./inline.ts";
import { notionLanguage } from "./languages.ts";

export type { TranslateContext } from "./context.ts";
export type { StrandedMedia, StrandedWhy } from "./images.ts";

export function toNotion(body: string, ctx: TranslateContext): string {
  const blocks = parseObsidian(body.replace(/\r\n/g, "\n").split("\n"));
  return writeNotion(ctx.media ? mediaToNotion(blocks, { ...ctx, media: ctx.media }) : blocks, (text) => toNotionInline(text, ctx)).join("\n");
}

/** The lines of a note (trimmed) that cite a vault file but stay literal text on the page, each with why (see `StrandedMedia`). */
export function strandedMedia(body: string, ctx: TranslateContext): StrandedMedia[] {
  return ctx.media ? strandedFrom(parseObsidian(body.replace(/\r\n/g, "\n").split("\n")), { ...ctx, media: ctx.media }) : [];
}

/**
 * A page's Notion markdown as an Obsidian body. `exact`: read to compare two Notion texts, both as Notion keeps them,
 * so that different ones never read alike: nested code exactly as Notion holds it (not as the translator might have
 * indented it), and escaped text kept escaped (see `toObsidianInline`).
 */
export function toObsidian(markdown: string, ctx: TranslateContext, exact = false): string {
  const parsed = parseNotion(markdown.replace(/\r\n/g, "\n").split("\n"), 0, exact);
  const blocks = ctx.media ? mediaToObsidian(parsed, { ...ctx, media: ctx.media }) : parsed;
  const lines = writeObsidian(blocks, (text) => toObsidianInline(text, ctx, exact));
  const text = lines.length ? `${lines.join("\n")}\n` : "";
  return ctx.media ? placeholdersToCitations(text, { ...ctx, media: ctx.media }) : text;
}

/**
 * The markdown Notion keeps for `markdown` written as the translator writes it (live probes and
 * 2026-10-02): every code block's language under Notion's name, and a nested code block's lines flush left, while
 * its fences keep their tabs. Only for the translator's own output: Notion's text is already in this form.
 */
export function keptByNotion(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\t*)(`{3,})([^`]*)$/.exec(lines[i]!);
    if (!m) {
      out.push(lines[i]!);
      continue;
    }
    const [, tabs, fence, info] = m as unknown as [string, string, string, string];
    let j = i + 1;
    const body: string[] = [];
    while (j < lines.length && lines[j]!.trim() !== fence) body.push(lines[j++]!);
    out.push(`${tabs}${fence}${notionLanguage(info)}`);
    out.push(...(tabs !== "" && body.every((l) => l.startsWith(tabs)) ? body.map((l) => l.slice(tabs.length)) : body));
    if (j < lines.length) out.push(lines[j]!);
    i = j;
  }
  return out.join("\n");
}

/** The words of a text, ignoring markup, case and spacing. Used to pair notes on the first run. */
export function words(text: string): string {
  return (text.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
}
