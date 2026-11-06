import type { RunKind } from "./note.ts";

export interface Ending {
  kind: RunKind | "busy";
  changes: number;
  needLook: number;
  heldNotes: number;
  heldFiles: number;
  listChanged: boolean;
  error?: string;
  statusTaken?: string | null;
  statusWritten: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function notificationFor(e: Ending): { text: string; openReport: boolean } {
  let text: string;
  let button: boolean;
  const held = e.heldNotes + e.heldFiles > 0;
  const look = e.needLook > 0 ? ` (and ${plural(e.needLook, "note needs", "notes need")} a look)` : "";
  if (e.kind === "busy") {
    text = "A sync is already running";
    button = false;
  } else if (e.kind === "failed") {
    text = `Sync failed: ${e.error ?? "unknown error"}`;
    button = true;
  } else if (e.listChanged) {
    text = "The list of trashes changed; check the status note and confirm again.";
    button = true;
  } else if (e.kind === "first-run") {
    text = `First run: preview only${look}. Confirm from the menu.`;
    button = true;
  } else if (e.kind === "preview") {
    text = `Preview: ${plural(e.changes, "change", "changes")}`;
    button = true;
  } else if (held) {
    const parts = [];
    if (e.heldNotes > 0) parts.push(`${plural(e.heldNotes, "note", "notes")} would be trashed`);
    if (e.heldFiles > 0) parts.push(`${plural(e.heldFiles, "attachment", "attachments")} would be moved to .trash`);
    text = `Stopped: ${parts.join(" and ")}${look}. Confirm from the menu.`;
    button = true;
  } else if (e.needLook > 0) {
    text = `Synced: ${plural(e.changes, "change", "changes")}, ${plural(e.needLook, "note needs", "notes need")} a look`;
    button = true;
  } else if (e.changes > 0) {
    text = `Synced: ${plural(e.changes, "change", "changes")}`;
    button = false;
  } else {
    text = "Everything was already in sync";
    button = false;
  }
  if (e.statusTaken) {
    text = `${text.replace(/\.$/, "")}. Status note not written: ${e.statusTaken} is one of your notes; set statusNote in the profile.`;
  }
  return { text, openReport: button && e.statusWritten };
}

/** Opens the status note by its absolute file path, so Obsidian picks the vault by folder, whatever name the profile gives it. */
export function reportUrl(absoluteNotePath: string): string {
  return `obsidian://open?path=${encodeURIComponent(absoluteNotePath)}`;
}
