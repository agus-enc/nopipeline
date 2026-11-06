// Human-readable plans and summaries.
import type { Action, ActionKind, Plan } from "./plan/planner.ts";
import type { Summary } from "./run/execute.ts";
import type { PageMeta, VaultNote } from "./types.ts";

const VERBS: Record<ActionKind, string> = {
  convertLinks: "convert [[links]] to Markdown links in",
  convertImages: "turn the Notion-hosted files (images, PDFs, audio, video, other files) into citations in",
  relocate: "move note",
  renameProject: "rename the Notion project of a renamed folder to",
  fileProject: "set the Notion project from the folder of",
  writeId: "restore notion-id in",
  createPage: "create Notion page for",
  recreatePage: "recreate Notion page for",
  createNote: "create note",
  restoreNote: "restore note",
  pair: "pair",
  push: "update Notion from",
  pull: "update note",
  merge: "merge both sides of",
  relink: "turn links to notes that now exist into Notion links in",
  updateEmbeds: "turn the attachment citations already synced into Notion blocks and drop the `!` before embedded notes in",
  renameInNotion: "rename/move in Notion:",
  endRename: "rewrite the links that use an unfinished rename's name to",
  moveInVault: "rename/move note",
  trashPage: "move Notion page to trash:",
  trashNote: "move note to .trash:",
  forget: "forget",
};

/** What the summary says of each kind of action done, as a complete phrase after "N × " (the plan's `VERBS` are for a line that ends with a name). */
const DONE: Record<ActionKind, string> = {
  convertLinks: "note's [[links]] converted to Markdown links",
  convertImages: "note's Notion-hosted files turned into citations",
  relocate: "note moved out of a folder that means no project",
  renameProject: "project renamed after its folder",
  fileProject: "Notion project set from the note's folder",
  writeId: "notion-id restored in a note",
  createPage: "Notion page created",
  recreatePage: "Notion page recreated",
  createNote: "note created",
  restoreNote: "note restored",
  pair: "note paired with its Notion page",
  push: "Notion page updated from its note",
  pull: "note updated from its Notion page",
  merge: "note and page merged",
  relink: "note's links to notes that now exist turned into Notion links",
  updateEmbeds: "note's attachment citations turned into Notion blocks",
  renameInNotion: "renamed or moved in Notion",
  endRename: "unfinished rename finished by rewriting the links that used its name",
  moveInVault: "note renamed or moved",
  trashPage: "Notion page moved to trash",
  trashNote: "note moved to .trash",
  forget: "record forgotten",
};

function subject(action: Action, notes: VaultNote[], pages: PageMeta[]): string {
  if (action.kind === "moveInVault" || action.kind === "relocate") return `${action.from} -> ${action.to}${action.reason ? ` (${action.reason})` : ""}`;
  if (action.kind === "renameProject") return action.title;
  if (action.kind === "convertLinks") return `${action.path} (${action.links} link${action.links === 1 ? "" : "s"})`;
  if (action.kind === "convertImages") return `${action.path} (${action.images} file${action.images === 1 ? "" : "s"})`;
  if (action.kind === "pair") return `${action.path} with its Notion page${action.same ? "" : " (texts differ: conflict copy)"}`;
  if ("path" in action) return action.path;
  if (!("pageId" in action)) return "";
  return notes.find((n) => n.notionId === action.pageId)?.path ?? pages.find((p) => p.id === action.pageId)?.title ?? action.pageId;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The lines about projects, which a plan or a summary says apart from the per-note actions. */
function projectLines(plan: Plan, created: readonly string[]): string[] {
  const clashes = plan.clashes ?? [];
  return [
    ...created.map((title) => `create project ${title}`),
    ...(clashes.length
      ? [`${plural(clashes.length, "note", "notes")} renamed or moved in Obsidian while the page's project also changed in Notion; the folder in Obsidian wins: ${clashes.join(", ")}`]
      : []),
  ];
}

export const WAITING_HEADER = "Waiting (open in Obsidian or edited in the last 5 minutes; they sync on a later run):";

const waitingLines = (plan: Plan): string[] => (plan.waiting?.length ? [WAITING_HEADER, ...plan.waiting.map((path) => `  ${path}`)] : []);

export function formatPlan(plan: Plan, notes: VaultNote[], pages: PageMeta[]): string {
  const filed = plan.actions.filter((a) => a.kind === "fileProject").length;
  const lines = [
    ...plan.actions.filter((a) => a.kind !== "fileProject").map((a) => `  ${VERBS[a.kind]} ${subject(a, notes, pages)}`),
    ...(filed ? [`  set the Notion project of ${plural(filed, "note", "notes")} from ${filed === 1 ? "its" : "their"} folder`] : []),
    ...projectLines(plan, plan.creates ?? []).map((line) => `  ${line}`),
  ];
  const body = lines.length ? lines.join("\n") : "  nothing to do";
  const warnings = plan.warnings.map((w) => `warning: ${w}`);
  const changes = plan.actions.length + (plan.creates?.length ?? 0);
  return [`Plan (${changes} change${changes === 1 ? "" : "s"}):`, body, ...waitingLines(plan), ...warnings].join("\n");
}

export function formatSummary(summary: Summary, plan: Plan): string {
  const done = Object.entries(summary.done).map(([kind, n]) => `  ${n} × ${DONE[kind as ActionKind]}`);
  for (const title of summary.projectsCreated ?? []) done.push(`  created project ${title}`);
  if (summary.linksTo > 0) done.push(`  ${summary.linksTo} × page's Links to set`);
  if (summary.tagsSet) done.push(`  ${summary.tagsSet} × tags set in Notion`);
  if (summary.tagsWritten) done.push(`  ${summary.tagsWritten} × tags written to notes`);
  if (summary.mediaUploaded > 0) done.push(`  uploaded ${summary.mediaUploaded} file${summary.mediaUploaded === 1 ? "" : "s"}`);
  for (const { path, pages } of summary.mediaUpdated) done.push(`  updated file ${path} on ${pages} page${pages === 1 ? "" : "s"}`);
  for (const path of summary.mediaMoved) done.push(`  moved ${path} to .trash`);
  // A moved file is not a change to either side: it is said, but it does not make the run "Done".
  const lines = [done.length ? "Done:" : "Everything was already in sync.", ...done, ...summary.mediaRekeyed.map((m) => `  ${movedLine(m)}`)];
  if (summary.conflicts.length) lines.push("Conflicts (Obsidian's text was kept; merge these copies by hand):", ...summary.conflicts.map((c) => `  ${c}`));
  if (summary.rewritten.length) {
    lines.push(
      "Rewritten whole (an edit couldn't be matched line by line, so one side was rewritten from the other in its own app's form; that side had nothing the other can't hold, so nothing was lost; the old note is in backups, the old page in Notion's page history):",
      ...summary.rewritten.map((path) => `  ${path}`),
    );
  }
  if (summary.skipped.length) lines.push("Skipped:", ...summary.skipped.map((s) => `  ${s.path}: ${s.reason}`));
  lines.push(...waitingLines(plan), ...projectLines(plan, []), ...plan.warnings.map((w) => `warning: ${w}`));
  return lines.join("\n");
}

/** The line for an attachment the sync found at a new path by its bytes. */
export const movedLine = ({ from, to }: { from: string; to: string }) => `moved: ${from} → ${to}`;

const MEDIA_STEPS: [prefix: string, one: string, many: string][] = [
  ["moved: ", "moved file", "moved files"],
  ["upload ", "upload", "uploads"],
  ["download ", "download", "downloads"],
  ["update file ", "file update", "file updates"],
  ["move to .trash ", "move to .trash", "moves to .trash"],
];

/**
 * The attachment lines of a run (images, PDFs, audio, video and other files), under a header; a preview's header counts what a real run would do (uploads, downloads, replaced
 * files, moves to `.trash`), spec §5.15.
 */
export function formatMediaPlan(lines: string[], preview: boolean): string {
  const counts = MEDIA_STEPS.flatMap(([prefix, one, many]) => {
    const n = lines.filter((line) => line.startsWith(prefix)).length;
    return n === 0 ? [] : [`${n} ${n === 1 ? one : many}`];
  });
  const header = preview && counts.length ? `Attachments (${counts.join(", ")}):` : "Attachments:";
  return [header, ...lines.map((line) => `  ${line}`)].join("\n");
}

/**
 * 0: clean, or a preview asked for with --dry-run; 1: finished (or stopped at the first-run preview) with
 * something that needs a look (conflicts, skipped notes, notes rewritten whole, held trashes); 2 is reserved
 * for failures.
 */
export function exitCode(summary: Summary | null, plan: Plan, stoppedAtFirstRun = false): number {
  if (stoppedAtFirstRun || plan.heldTrashes > 0) return 1;
  if (summary && (summary.conflicts.length > 0 || summary.skipped.length > 0 || summary.rewritten.length > 0)) return 1;
  return 0;
}
