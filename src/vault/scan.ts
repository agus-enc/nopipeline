// Finding the notes in a vault.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { VaultNote } from "../types.ts";
import { isExcalidraw, isStatusNote, readNotionProps, splitFrontmatter } from "./frontmatter.ts";

export const CONFLICT_COPY = / \(Notion conflict [^)]*\)\.md$/;

export interface VaultScan {
  notes: VaultNote[];
  /** Excalidraw drawings: `.md` files that stay Obsidian-only but can be linked to. */
  drawings: string[];
  /** Every visible folder (none starting with `.`, at any depth), empty ones too. */
  folders: string[];
}

export async function scanVault(root: string, skip: string | null = null): Promise<VaultScan> {
  const notes: VaultNote[] = [];
  const drawings: string[] = [];
  const folders: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(join(root, dir), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        folders.push(path);
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".md") && !CONFLICT_COPY.test(entry.name) && path !== skip) {
        const text = await readFile(join(root, path), "utf8");
        // A status note the tool wrote counts wherever it lies, so turning the note off or moving it never syncs the old one.
        if (isStatusNote(text)) continue;
        const { frontmatter, body } = splitFrontmatter(text);
        if (isExcalidraw(frontmatter)) {
          drawings.push(path);
          continue;
        }
        const props = readNotionProps(frontmatter);
        notes.push({ path, text, body, notionId: props.notionId, notionTitle: props.notionTitle });
      }
    }
  }
  await walk("");
  notes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { notes, drawings: drawings.sort(), folders: folders.sort() };
}
