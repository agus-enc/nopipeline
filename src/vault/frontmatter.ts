// Frontmatter handling by line edits, so every byte we don't own stays as it was.
import { normalizeId } from "../notion/ids.ts";

export interface Split {
  frontmatter: string | null;
  body: string;
}

const DELIMITER = /^---[ \t]*\r?$/;

export function frontmatterBounds(lines: string[]): { end: number } | null {
  if (lines.length < 2 || !DELIMITER.test(lines[0]!)) return null;
  for (let i = 1; i < lines.length; i++) {
    if (DELIMITER.test(lines[i]!)) return { end: i };
  }
  return null;
}

export function splitFrontmatter(text: string): Split {
  const lines = text.split("\n");
  const b = frontmatterBounds(lines);
  if (!b) return { frontmatter: null, body: text };
  return { frontmatter: lines.slice(1, b.end).join("\n"), body: lines.slice(b.end + 1).join("\n") };
}

function rawValue(frontmatter: string | null, key: string): string | null {
  if (frontmatter === null) return null;
  const match = new RegExp(`^${key}:[ \\t]*(.*?)\\r?$`, "m").exec(frontmatter);
  return match ? match[1]!.trim() : null;
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

export function readNotionProps(frontmatter: string | null): { notionId: string | null; notionTitle: string | null } {
  const id = rawValue(frontmatter, "notion-id");
  const title = rawValue(frontmatter, "notion-title");
  return {
    notionId: id ? normalizeId(unquote(id)) : null,
    notionTitle: title ? unquote(title) : null,
  };
}

export function isExcalidraw(frontmatter: string | null): boolean {
  return frontmatter !== null && /^excalidraw-plugin:/m.test(frontmatter);
}

/** The frontmatter line that marks the tool's own status note. */
export const STATUS_MARKER = "nopipeline: status";

/** Whether `text` is a status note the tool wrote: its frontmatter has a line that is exactly the marker. */
export function isStatusNote(text: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return match !== null && match[1]!.split(/\r?\n/).some((l) => l.trim() === STATUS_MARKER);
}

function formatValue(value: string): string {
  const plain = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(value) && !/ $/.test(value);
  const ambiguous = /^(true|false|null|yes|no|on|off|~)$/i.test(value) || /^[0-9._-]+$/.test(value);
  return plain && !ambiguous ? value : JSON.stringify(value);
}

/** Sets (or, with `null`, removes) one top-level frontmatter key. Everything else is left byte-for-byte. */
export function setProp(text: string, key: string, value: string | null): string {
  const crlf = text.includes("\r\n");
  const eol = crlf ? "\r\n" : "\n";
  const lines = text.split("\n");
  const b = frontmatterBounds(lines);
  const newLine = value === null ? null : `${key}: ${formatValue(value)}${crlf ? "\r" : ""}`;
  if (!b) {
    if (newLine === null) return text;
    return `---${eol}${key}: ${formatValue(value!)}${eol}---${eol}${text}`;
  }
  const keyLine = new RegExp(`^${key}:(\\s|$)`);
  let k = -1;
  for (let i = 1; i < b.end; i++) {
    if (keyLine.test(lines[i]!)) {
      k = i;
      break;
    }
  }
  if (k === -1) {
    if (newLine !== null) lines.splice(b.end, 0, newLine);
    return lines.join("\n");
  }
  let stop = k + 1;
  while (stop < b.end && /^[ \t]/.test(lines[stop]!)) stop++;
  if (newLine === null) lines.splice(k, stop - k);
  else lines.splice(k, stop - k, newLine);
  return lines.join("\n");
}

/** The same note with a new body; the frontmatter block, if any, is kept byte-for-byte. */
export function replaceBody(text: string, body: string): string {
  const lines = text.split("\n");
  const b = frontmatterBounds(lines);
  return b ? [...lines.slice(0, b.end + 1), body].join("\n") : body;
}

/** The note with `change` applied to each line of its frontmatter; every other byte is kept. */
export function mapFrontmatter(text: string, change: (line: string) => string): string {
  const lines = text.split("\n");
  const b = frontmatterBounds(lines);
  if (!b) return text;
  for (let i = 1; i < b.end; i++) lines[i] = change(lines[i]!);
  return lines.join("\n");
}
