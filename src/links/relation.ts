// Which pages a page links to, and what its "Links to" relation should hold. Pure: no I/O.
import { idFromUrl, isNotionUrl } from "../notion/ids.ts";
import type { PageId } from "../types.ts";

/** Notion rejects a relation property with more than 100 entries. */
const RELATION_LIMIT = 100;

// Same shapes as the link and mention readers in translate/inline.ts. The leading "!" is captured so embeds can be told apart.
const LINK_OR_MENTION =
  /(!?)(?:\[(?:[^[\]\n]|\\[[\]])*\]\(([^()\s]+(?:\([^\s()]*\)[^\s()]*)*)\)|<mention-page\s+url="([^"]*)")/g;
// After any quote marker, list marker or indent: a line opening a fence (its info string has no backtick, else it is an
// inline span) or closing one (nothing after the backticks).
const PREFIX = /^(?:[\s>]|[-*+]\s|\d+[.)]\s)*/.source;
const FENCE_OPEN = new RegExp(`${PREFIX}\`\`\`+[^\`]*$`);
const FENCE_CLOSE = new RegExp(`${PREFIX}\`\`\`+\\s*$`);
// A span stays within one line, so a stray backtick can't pair with one paragraphs later.
const INLINE_CODE = /(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g;

const blank = (text: string) => text.replace(/[^\n]/g, " ");

/** The text with fenced blocks and inline code spans blanked out (same length, so nothing else moves). */
function withoutCode(markdown: string): string {
  let inFence = false;
  const lines = markdown.split("\n").map((line) => {
    if (inFence ? FENCE_CLOSE.test(line) : FENCE_OPEN.test(line)) {
      inFence = !inFence;
      return blank(line);
    }
    return inFence ? blank(line) : line;
  });
  return lines.join("\n").replace(INLINE_CODE, blank);
}

/** Pages the markdown links to or mentions, in order of first appearance: live pages other than `self`, no embeds, nothing inside code. */
export function linkedPageIds(markdown: string, live: ReadonlySet<PageId>, self: PageId): PageId[] {
  const ids = new Set<PageId>();
  for (const m of withoutCode(markdown).matchAll(LINK_OR_MENTION)) {
    if (m[1] === "!") continue;
    const url = m[2] ?? m[3]!;
    if (m[2] !== undefined && !isNotionUrl(url)) continue;
    const id = idFromUrl(url);
    if (id && id !== self && live.has(id)) ids.add(id);
  }
  return [...ids];
}

/**
 * The relation to write and the entries the sync now owns. `owned` is what the sync added last time (undefined before
 * its first run, when the entries that match a text link are adopted); every other current entry is the user's and stays.
 * With `live` (the pages in the database), an owned entry whose page is not live (in the trash: Notion hides the entry)
 * stays owned, so it is still the sync's if the page comes back.
 * More than 100 hand entries are left as they are (`relation` is `current`, `handOver` is set): cutting them would drop the user's.
 */
export function nextRelation(input: { current: PageId[]; owned: PageId[] | undefined; linked: PageId[]; live?: ReadonlySet<PageId> }): {
  relation: PageId[];
  owned: PageId[];
  capped: boolean;
  handOver?: true;
} {
  const { current, linked, live } = input;
  const owned = new Set(input.owned ?? current.filter((id) => linked.includes(id)));
  const hand = current.filter((id) => !owned.has(id));
  const away = live === undefined ? [] : (input.owned ?? []).filter((id) => !live.has(id) && !current.includes(id));
  if (hand.length > RELATION_LIMIT) return { relation: current, owned: input.owned ?? [], capped: false, handOver: true };
  const added = linked.filter((id) => !hand.includes(id));
  const relation = [...hand, ...added].slice(0, RELATION_LIMIT);
  return {
    relation,
    // Only what was actually written: an entry cut by the limit is not the sync's.
    owned: [...added.filter((id) => relation.includes(id)), ...away],
    capped: hand.length + added.length > RELATION_LIMIT,
  };
}

export function sameEntries(a: PageId[], b: PageId[]): boolean {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((id) => set.has(id));
}
