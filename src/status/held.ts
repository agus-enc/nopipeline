// held.json: what a real run stopped on, for `nopipeline confirm` (spec §5.4).
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { makeFolders, writeFlushed } from "../durable.ts";
import type { HeldTrash } from "../plan/planner.ts";
import type { SyncOutcome } from "../sync.ts";

export interface Held {
  /** The run stopped at the first-run preview. */
  firstRun: boolean;
  changes: number;
  notes: HeldTrash[];
  files: string[];
  at: string;
}

/** What the run held, or null when it held nothing (and was not a first-run stop). */
export function heldFrom(outcome: SyncOutcome, stoppedAtFirstRun: boolean, at: Date): Held | null {
  const { plan, summary } = outcome;
  const notes = plan.held ?? [];
  const files = plan.heldFiles ?? [];
  if (!stoppedAtFirstRun && notes.length + files.length === 0) return null;
  const changes = stoppedAtFirstRun || !summary ? plan.actions.length + (plan.creates?.length ?? 0) : Object.values(summary.done).reduce((a, n) => a + (n ?? 0), 0);
  return { firstRun: stoppedAtFirstRun, changes, notes: [...notes], files: [...files], at: at.toISOString() };
}

const fileOf = (stateDir: string) => join(stateDir, "held.json");

/** The saved held list; null when there is none (or the file can't be read as one). */
export async function readHeld(stateDir: string): Promise<Held | null> {
  let text: string;
  try {
    text = await readFile(fileOf(stateDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const held = JSON.parse(text) as Held;
    return held && typeof held === "object" && Array.isArray(held.notes) && Array.isArray(held.files) ? held : null;
  } catch {
    return null;
  }
}

/** Saves the held list; null removes the file. */
export async function saveHeld(stateDir: string, held: Held | null): Promise<void> {
  if (held === null) {
    await rm(fileOf(stateDir), { force: true });
    return;
  }
  await makeFolders(stateDir);
  await writeFlushed(fileOf(stateDir), `${JSON.stringify(held, null, 2)}\n`);
}
