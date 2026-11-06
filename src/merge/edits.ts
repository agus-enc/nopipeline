// Turning "page text before" and "page text after" into Notion `update_content` replacements.
import { diffIndices } from "node-diff3";
import type { ContentEdit } from "../types.ts";

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
}

interface Range {
  bStart: number;
  bEnd: number;
  aStart: number;
  aEnd: number;
  steps: number;
}

/**
 * The smallest list of search-and-replace edits that turns `before` into `after`, each `old_str`
 * unique in `before`. Returns null when that isn't possible (then the caller replaces the page).
 * No `old_str` holds a line for which `unsearchable` is true (Notion never finds a search text with an image
 * line in it): context grows the other way round such a line, and when it can't, the result is null.
 */
export function contentUpdates(before: string, after: string, maxEdits = 100, unsearchable: (line: string) => boolean = () => false): ContentEdit[] | null {
  if (before === after) return [];
  const b = before.split("\n");
  const a = after.split("\n");
  let ranges: Range[] = diffIndices(b, a).map((h) => ({
    bStart: h.buffer1[0],
    bEnd: h.buffer1[0] + h.buffer1[1],
    aStart: h.buffer2[0],
    aEnd: h.buffer2[0] + h.buffer2[1],
    steps: 0,
  }));
  const oldStr = (r: Range) => b.slice(r.bStart, r.bEnd).join("\n");
  const newStr = (r: Range) => a.slice(r.aStart, r.aEnd).join("\n");
  const settled = (r: Range) => {
    const old = oldStr(r);
    return old !== "" && occurrences(before, old) === 1 && (newStr(r) !== "" || (r.bStart === 0 && r.bEnd === b.length));
  };
  let stuck = false;
  for (;;) {
    let grew = false;
    ranges = ranges.map((r) => {
      if (settled(r)) return r;
      if (r.bStart === 0 && r.bEnd === b.length) return r;
      const canUp = r.bStart > 0 && !unsearchable(b[r.bStart - 1]!);
      const canDown = r.bEnd < b.length && !unsearchable(b[r.bEnd]!);
      if (!canUp && !canDown) {
        stuck = true;
        return r;
      }
      grew = true;
      const preferUp = r.steps % 2 === 0;
      const up = canUp && (preferUp || !canDown) ? 1 : 0;
      const down = up === 0 ? 1 : 0;
      return { bStart: r.bStart - up, bEnd: r.bEnd + down, aStart: r.aStart - up, aEnd: r.aEnd + down, steps: r.steps + 1 };
    });
    const merged: Range[] = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r.bStart <= last.bEnd) {
        last.bEnd = Math.max(last.bEnd, r.bEnd);
        last.aEnd = Math.max(last.aEnd, r.aEnd);
        grew = true;
      } else {
        merged.push({ ...r });
      }
    }
    ranges = merged;
    if (!grew) break;
  }
  if (stuck || !ranges.every(settled) || ranges.length > maxEdits) return null;
  const edits = ranges.map((r) => ({ old_str: oldStr(r), new_str: newStr(r) }));
  // A change to an unsearchable line itself, or a merge that swallowed one, can't be searched for either.
  if (edits.some((edit) => edit.old_str.split("\n").some(unsearchable))) return null;
  let text = before;
  for (const edit of edits) {
    if (occurrences(text, edit.old_str) !== 1) return null;
    text = text.replace(edit.old_str, () => edit.new_str);
  }
  return text === after ? edits : null;
}
