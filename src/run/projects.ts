// What the executor needs from Notion for the folder of a note.
import type { NotionGateway } from "../notion/gateway.ts";
import { folderMeaning, type FolderContext } from "../plan/projects.ts";
import type { ProjectStore } from "../state/projects.ts";
import type { PageId, ProjectMeta } from "../types.ts";

/** The gateway as the executor uses it: a page is created and renamed with its folder, and `projectOf` is the project the page has (undefined: not known). */
export interface FolderGateway extends Omit<NotionGateway, "createPage" | "setTitle"> {
  createPage(input: { title: string; folder: string | null }): Promise<PageId>;
  /** `sameTitle`: the page already has `title`, so it is not written again (a write bumps the page's edit time, and every page is read again for it). */
  setProperties(id: PageId, input: { title: string; folder: string | null; sameTitle?: true }): Promise<void>;
  projectOf(id: PageId): PageId | null | undefined;
  /** Titles of the projects this layer created in Notion. */
  createdProjects(): string[];
}

/** A passthrough that ignores `folder`: for a profile without a projects relation. */
export function folderless(notion: NotionGateway): FolderGateway {
  return {
    ...notion,
    createPage: (input) => notion.createPage({ title: input.title }),
    setProperties: async (id, input) => {
      if (!input.sameTitle) await notion.setTitle(id, input.title);
    },
    projectOf: () => undefined,
    createdProjects: () => [],
  };
}

export interface ProjectsOptions {
  /** False: the profile has no projects relation, and no relation is read or written. */
  enabled: boolean;
  context: FolderContext;
  store: ProjectStore;
  /** The projects relation of each page as the listing showed it: `more` says the listing cut it short. Kept up to date by the layer. */
  firstProjects: Map<PageId, { ids: PageId[]; more: boolean }>;
  /** Folders the resolver judged ambiguous (and warned about): no relation is written for a note in one, whatever `folderMeaning` makes of it here. */
  ambiguous?: ReadonlySet<string>;
}

const nfc = (text: string) => text.normalize("NFC");

/** The gateway with folders written as the first project of a page (spec §3): replaces the first entry, keeps the rest. */
export function withProjects(notion: NotionGateway, options: ProjectsOptions): FolderGateway {
  const { enabled, context, store, firstProjects } = options;
  const ambiguous = new Set([...(options.ambiguous ?? [])].map(nfc));
  let live: ProjectMeta[] | undefined;
  const created: ProjectMeta[] = [];

  /** The project a "new" folder stands for: a live project of exactly that title, else a fresh one (stored and saved at once). */
  async function projectForNew(folder: string, title: string): Promise<PageId> {
    live ??= await notion.listProjects();
    const found = live.find((p) => nfc(p.title) === nfc(title));
    if (found) {
      store.set(found.id, { path: folder, title });
      return found.id;
    }
    // The executor runs one action at a time, so two notes of a new folder never both get here before the first has stored its project.
    const id = await notion.createProject(title);
    const project = { id, title };
    live.push(project);
    created.push(project);
    store.set(id, { path: folder, title });
    await store.save();
    return id;
  }

  /** The project a folder asks for (null: the vault root): an id, null for none, undefined to leave the relation alone. */
  async function target(given: string | null): Promise<PageId | null | undefined> {
    const folder = given ?? "";
    if (ambiguous.has(nfc(folder))) return undefined;
    const meaning = folderMeaning(folder, { ...context, stored: store.all(), projects: [...context.projects, ...created] });
    switch (meaning.kind) {
      case "none":
        return null;
      case "evict":
      case "ambiguous": // the resolver warned about every folder of the vault that is
        return undefined;
      case "project": {
        if (store.all().get(meaning.id) === undefined) {
          const project = context.projects.find((p) => p.id === meaning.id);
          if (project) store.set(meaning.id, { path: folder, title: project.title });
        }
        return meaning.id;
      }
      case "new":
        return projectForNew(folder, meaning.title);
    }
  }

  return {
    ...notion,
    async createPage(input) {
      if (!enabled) return notion.createPage({ title: input.title });
      const project = await target(input.folder);
      const projects = project ? [project] : [];
      const id = await notion.createPage({ title: input.title, projects });
      firstProjects.set(id, { ids: projects, more: false });
      return id;
    },
    async setProperties(id, input) {
      if (!input.sameTitle) await notion.setTitle(id, input.title);
      if (!enabled) return;
      const project = await target(input.folder);
      if (project === undefined) return;
      const known = firstProjects.get(id);
      const current = known === undefined || known.more ? await notion.readProjects(id) : known.ids;
      // A page with several projects whose note went to the default folder or the root keeps all of them.
      if (project === null && current.length > 1) {
        firstProjects.set(id, { ids: current, more: false });
        return;
      }
      const rest = current.slice(1).filter((other) => other !== project);
      const next = project === null ? current.slice(1) : [project, ...(current.length === 0 ? [] : rest)];
      if (next.length === current.length && next.every((entry, i) => entry === current[i])) {
        firstProjects.set(id, { ids: current, more: false });
        return;
      }
      await notion.setProjects(id, next);
      firstProjects.set(id, { ids: next, more: false });
    },
    createdProjects: () => created.map((p) => p.title),
    projectOf(id) {
      if (!enabled) return undefined;
      const known = firstProjects.get(id);
      return known === undefined ? undefined : (known.ids[0] ?? null);
    },
  };
}
