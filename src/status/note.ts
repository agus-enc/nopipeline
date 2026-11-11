// The status note: what a run did and what needs a look, rendered as Markdown and written into the vault (spec §5.1).
import { readFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { makeFolders, writeFlushed } from "../durable.ts";
import type { SyncOutcome } from "../sync.ts";
import { isStatusNote, STATUS_MARKER } from "../vault/frontmatter.ts";
import { adviceFor } from "./advice.ts";

export { STATUS_MARKER };

export type RunKind = "sync" | "preview" | "first-run" | "failed";

export interface StatusInput {
  kind: RunKind;
  /** What `versionString` says. */
  version: string;
  at: Date;
  profile: string;
  stateDir: string;
  /** The status note's vault path (links are made relative to its folder). */
  notePath: string;
  /** Absent for "failed". */
  outcome?: SyncOutcome;
  /** For "failed". */
  error?: string;
  /** The text the terminal got (plan or summary, attachments), shown in a text block. */
  report: string;
  exitCode: number;
}

const PREVIEW_HELD = "A real sync would stop here. To go ahead: run the sync (click the launcher), then right-click → Confirm held changes, or run `nopipeline confirm`.";
const GO_AHEAD = "To go ahead: right-click the launcher → Confirm held changes, or run `nopipeline confirm`.";

export function notionUrl(pageId: string): string {
  return `https://app.notion.com/p/${pageId.replaceAll("-", "")}`;
}

const encode = (segment: string) => encodeURIComponent(segment).replaceAll("(", "%28").replaceAll(")", "%29");

/** A Markdown link from the note at `fromNote` to the vault path `target`; the text is the target's path unless given. */
export function obsidianLink(fromNote: string, target: string, text: string = target): string {
  const relative = posix.relative(posix.dirname(fromNote), target);
  const destination = relative.split("/").map((s) => (s === ".." ? s : encode(s))).join("/");
  return `[${text.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${destination})`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function changeCount(input: StatusInput): number {
  const { outcome } = input;
  if (!outcome) return 0;
  const { summary, plan } = outcome;
  if (summary && input.kind === "sync") {
    return Object.values(summary.done).reduce((a, n) => a + (n ?? 0), 0) + summary.linksTo + summary.mediaUploaded + summary.mediaUpdated.length + summary.mediaMoved.length;
  }
  return plan.actions.length + (plan.creates?.length ?? 0);
}

function resultLine(input: StatusInput, held: number, heldFiles: number, look: number): string {
  const changes = plural(changeCount(input), "change", "changes");
  switch (input.kind) {
    case "failed":
      return `Failed — ${(input.error ?? "unknown error").replace(/\.$/, "")}.`;
    case "first-run":
      return "First run of this profile — preview only.";
    case "preview":
      return `Preview — ${changes}, nothing was written.`;
    case "sync":
      if (held > 0 && heldFiles > 0) return `Stopped — ${plural(held, "note", "notes")} would be trashed and ${plural(heldFiles, "attachment", "attachments")} moved to .trash. Nothing was trashed or moved.`;
      if (held > 0) return `Stopped — ${plural(held, "note would", "notes would")} be trashed. Nothing was trashed.`;
      if (heldFiles > 0) return `Stopped — ${plural(heldFiles, "attachment would", "attachments would")} be moved to .trash. Nothing was moved.`;
      return `Synced ${stamp(input.at)} — ${changes}${look ? `, ${plural(look, "note needs", "notes need")} a look` : ""}.`;
  }
}

const CONFLICT_SUFFIX = / \(Notion conflict \d{4}-\d\d-\d\d\)(?=\.[^./]*$|$)/;

export function renderStatusNote(input: StatusInput): string {
  const { outcome, notePath } = input;
  const link = (path: string) => obsidianLink(notePath, path);
  const held = outcome?.plan.held ?? [];
  const heldFiles = outcome?.plan.heldFiles ?? [];
  const skipped = outcome?.summary?.skipped ?? [];
  const conflicts = outcome?.summary?.conflicts ?? [];
  const rewritten = outcome?.summary?.rewritten ?? [];
  const warnings = outcome?.plan.warnings ?? [];
  const look = skipped.length + conflicts.length + rewritten.length;

  const lines = ["---", STATUS_MARKER, "---", "# nopipeline status", "", resultLine(input, held.length, heldFiles.length, look)];
  const heldAny = held.length + heldFiles.length > 0;
  if (input.kind === "first-run") lines.push("", GO_AHEAD);

  const needs: string[] = [];
  if (skipped.length) {
    needs.push("### Skipped", "");
    const ids = new Map((outcome?.notes ?? []).map((n) => [n.path, n.notionId]));
    for (const { path, reason } of skipped) {
      const id = ids.get(path);
      needs.push(`- ${link(path)}${id ? ` · [Open in Notion](${notionUrl(id)})` : ""} — ${reason}`, `  What to do: ${adviceFor(reason)}`);
    }
    needs.push("");
  }
  if (conflicts.length) {
    needs.push("### Conflicts", "", "Obsidian's text was kept; merge each copy into the note by hand.", "");
    for (const copy of conflicts) needs.push(`- ${link(copy.replace(CONFLICT_SUFFIX, ""))} · ${obsidianLink(notePath, copy, "conflict copy")}`);
    needs.push("");
  }
  if (rewritten.length) {
    needs.push("### Rewritten whole", "", "An edit couldn't be matched line by line, so one side was rewritten from the other; nothing was lost.", "");
    for (const path of rewritten) needs.push(`- ${link(path)}`);
    needs.push("");
  }
  if (heldAny) {
    needs.push("### Held", "");
    for (const h of held) {
      needs.push(h.side === "notion" ? `- trash the Notion page of ${h.path} (deleted in Obsidian)` : `- move ${link(h.path)} to .trash (its page was trashed in Notion)`);
    }
    for (const f of heldFiles) needs.push(`- move ${link(f)} to .trash (no note cites it)`);
    needs.push("", input.kind === "preview" ? PREVIEW_HELD : GO_AHEAD, "");
  }
  if (warnings.length) needs.push("### Warnings", "", ...warnings.map((w) => `- ${w}`), "");
  if (needs.length) lines.push("", "## Needs a look", "", ...needs.slice(0, -1));
  // Waiting notes need nothing from the user, so they have a heading of their own.
  const waiting = outcome?.plan.waiting ?? [];
  if (waiting.length) {
    lines.push("", "## Waiting", "", "Open in Obsidian or edited in the last 5 minutes; they sync on a later run.", "");
    for (const path of waiting) lines.push(`- ${link(path)}`);
  }

  if (input.kind !== "failed") {
    lines.push("", input.kind === "sync" ? "## What changed" : "## Plan", "", "```text", input.report.trimEnd(), "```");
  }
  lines.push("", "---", `Written by nopipeline ${input.version} at ${stamp(input.at)} for profile ${input.profile}; rewritten on every run (edits to this note are lost). Full output: \`${join(input.stateDir, "last-run.log")}\`.`, "");
  return lines.join("\n");
}

/** Writes the status note unless the file is one of the user's notes (it exists without the tool's marker). */
export async function writeStatusNote(vaultPath: string, notePath: string, text: string): Promise<"written" | "taken"> {
  const file = join(vaultPath, notePath);
  let existing: string | null = null;
  try {
    existing = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing !== null && !isStatusNote(existing)) return "taken";
  await makeFolders(dirname(file));
  await writeFlushed(file, text);
  return "written";
}
