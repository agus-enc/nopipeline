// Which vault folder each Notion project has, as one JSON file.
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { flush, makeFolders, writeFlushed } from "../durable.ts";
import type { PageId } from "../types.ts";

export interface StoredProject {
  /** The project's folder, a vault path of one root folder name unless the folder was nested when the project was linked. */
  path: string;
  /** The project's title when the folder was last matched or named. */
  title: string;
}

export interface ProjectStore {
  /** The stored projects by page id (the live map: `set` and `delete` change it). */
  all(): Map<PageId, StoredProject>;
  set(id: PageId, project: StoredProject): void;
  delete(id: PageId): void;
  save(): Promise<void>;
}

interface Stored {
  projects: Record<string, StoredProject>;
}

export async function openProjectStore(stateDir: string): Promise<ProjectStore> {
  const file = join(stateDir, "projects.json");
  const projects = new Map<PageId, StoredProject>();

  let text: string | undefined;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text !== undefined) {
    const damaged = (why: string) => new Error(`can't read the project records ${file} (${why}); fix or delete it, then run again`);
    let stored: unknown;
    try {
      stored = JSON.parse(text);
    } catch (error) {
      throw damaged(error instanceof Error ? error.message : String(error));
    }
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) throw damaged("it must hold a JSON object");
    const entries = (stored as Partial<Stored>).projects ?? {};
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) throw damaged(`"projects" must be an object`);
    for (const [id, project] of Object.entries(entries)) {
      const entry = project as Partial<StoredProject> | null;
      if (typeof entry !== "object" || entry === null || typeof entry.path !== "string" || typeof entry.title !== "string") {
        throw damaged(`the entry ${JSON.stringify(id)} needs a text "path" and "title"`);
      }
      projects.set(id as PageId, { path: entry.path, title: entry.title });
    }
  }

  return {
    all: () => projects,
    set: (id, project) => void projects.set(id, { ...project }),
    delete: (id) => void projects.delete(id),
    async save() {
      const stored: Stored = { projects: Object.fromEntries(projects) };
      await makeFolders(stateDir);
      // Flushed before it takes its name, and the name after: a power cut leaves the old file or the new one.
      await writeFlushed(`${file}.tmp`, `${JSON.stringify(stored, null, 2)}\n`);
      await rename(`${file}.tmp`, file);
      await flush(stateDir);
    },
  };
}
