// The one-time move of tag-only lines at the top of a note into its frontmatter `tags`.
import { splitFrontmatter } from "./frontmatter.ts";
import { isObsidianTag, mergeTags, readTags, writeTags } from "./tags.ts";

const BLANK = /^[ \t]*\r?$/;
const TAG_LINE = /^ {0,3}#\S+([ \t]+#\S+)*[ \t]*\r?$/;

/** The names on a line that holds only tags, else null. */
function tagsOnLine(line: string): string[] | null {
  if (!TAG_LINE.test(line)) return null;
  const names = line.trim().split(/[ \t]+/).map((word) => word.slice(1));
  return names.every(isObsidianTag) ? names : null;
}

/**
 * Moves the run of tag-only lines after the body's leading blank lines (and one blank line after the run) into the
 * frontmatter tags. Null when there is no such run, or the frontmatter tags can't be rewritten safely.
 */
export function moveTopTags(text: string): { text: string; moved: string[] } | null {
  const existing = readTags(text);
  if (existing.kind === "unsafe") return null;
  const { body } = splitFrontmatter(text);
  const lines = body.split("\n");
  let first = 0;
  while (first < lines.length && BLANK.test(lines[first]!)) first++;
  const moved: string[] = [];
  let end = first;
  for (; end < lines.length; end++) {
    const names = tagsOnLine(lines[end]!);
    if (!names) break;
    moved.push(...names);
  }
  if (end === first) return null;
  if (end < lines.length && BLANK.test(lines[end]!)) end++;
  lines.splice(first, end - first);
  const rewritten = text.slice(0, text.length - body.length) + lines.join("\n");
  const out = writeTags(rewritten, mergeTags(undefined, existing.tags, moved));
  return { text: out, moved };
}
