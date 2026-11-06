// The search text of an `update_content` edit in the form Notion finds it by.
import type { PageId } from "../types.ts";
import { idFromUrl } from "./ids.ts";

/** What Notion knows of a mentioned page: its current title and whether it is in the trash; null when it can't find it. */
export type MentionTarget = { title: string; trashed: boolean } | null;

const MENTION = /<mention-page\s+url="([^"]*)"\s*\/>/g;
const CODE_SPAN = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

/** The page mentions of `markdown` outside code (fenced blocks and code spans): where each starts and ends, and its URL. */
function mentions(markdown: string): { from: number; to: number; url: string }[] {
  const found: { from: number; to: number; url: string }[] = [];
  let fence: string | null = null;
  let at = 0;
  for (const line of markdown.split("\n")) {
    const open = /^\t*(`{3,})[^`]*$/.exec(line);
    if (fence === null && !open) {
      const code = [...line.matchAll(CODE_SPAN)].map((m) => [m.index!, m.index! + m[0].length] as const);
      for (const m of line.matchAll(MENTION)) {
        if (!code.some(([from, to]) => m.index! >= from && m.index! < to)) found.push({ from: at + m.index!, to: at + m.index! + m[0].length, url: m[1]! });
      }
    } else if (fence === null) {
      fence = open![1]!;
    } else if (line.trim() === fence) {
      fence = null;
    }
    at += line.length + 1;
  }
  return found;
}

/**
 * The texts Notion's `update_content` finds `old` by, `old` being found once in `page` (the page as
 * `retrieveMarkdown` returns it), in the order to try them. Live probes showed that Notion finds a page
 * mention only by the form that holds the page's current title, `<mention-page url="…">Title</mention-page>`, while
 * it returns every mention self-closing: a mention of a page Notion can't find is found self-closing, and one of a
 * page in the trash sometimes one way and sometimes the other, so both are tried (every mix of them, for a few).
 * Mentions in code are text, and date, person and database mentions and links are found as returned. Null when a mentioned page's form can't be
 * known (`target` gives undefined: a page the connection can't read).
 */
export function searchTexts(page: string, old: string, target: (id: PageId) => MentionTarget | undefined): string[] | null {
  const start = page.indexOf(old);
  if (start === -1) return [old];
  const inside = mentions(page).filter((m) => m.from >= start && m.to <= start + old.length);
  const forms: string[][] = [];
  for (const m of inside) {
    const id = idFromUrl(m.url);
    const known = id === null ? null : target(id);
    if (known === undefined) return null;
    const plain = page.slice(m.from, m.to);
    const titled = known && `<mention-page url="${m.url}">${known.title}</mention-page>`;
    forms.push(known === null ? [plain] : known.trashed ? [plain, titled!] : [titled!]);
  }
  const write = (pick: (options: string[], k: number) => string) => {
    let text = "";
    let at = start;
    inside.forEach((m, k) => {
      text += page.slice(at, m.from) + pick(forms[k]!, k);
      at = m.to;
    });
    return text + page.slice(at, start + old.length);
  };
  // Each mention of a page in the trash may be found either way: every mix of their forms, all as returned first
  // (up to three such mentions; with more, all one way and then all the other).
  const open = forms.flatMap((options, k) => (options.length > 1 ? [k] : []));
  if (open.length > 3) return [...new Set([write((options) => options[0]!), write((options) => options[options.length - 1]!)])];
  const texts: string[] = [];
  for (let mix = 0; mix < 2 ** open.length; mix++) texts.push(write((options, k) => options[open.includes(k) && mix & (1 << open.indexOf(k)) ? 1 : 0]!));
  return [...new Set(texts)];
}
