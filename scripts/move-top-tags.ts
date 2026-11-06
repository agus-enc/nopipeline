// One-time migration, run by hand: moves the tag-only lines at the top of notes into the frontmatter `tags`.
// Without --write it only prints, per note, the tags it would move. With --write (needs --backup <dir>) it first
// copies each changed note under <dir>, at its path in the vault, then rewrites it. Try it on a copy of a vault first.
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { moveTopTags } from "../src/vault/toptags.ts";
import { scanVault } from "../src/vault/scan.ts";

const args = process.argv.slice(2);
const write = args.includes("--write");
const backupAt = args.indexOf("--backup");
const backup = backupAt === -1 ? null : args[backupAt + 1];
const [root, ...extra] = args.filter((arg, k) => !arg.startsWith("--") && (backupAt === -1 || k !== backupAt + 1));
if (!root || extra.length > 0 || (backupAt !== -1 && !backup) || (write && !backup)) {
  console.error("usage: node scripts/move-top-tags.ts <vault path> [--write --backup <dir>]");
  process.exit(2);
}
if (backup !== null && backup !== undefined && backup.startsWith("--")) {
  console.error(`--backup needs a folder, not "${backup}"`);
  process.exit(2);
}
if (write && backup) {
  // The backup is the only way back: it must start empty (nothing of an earlier backup is overwritten) and lie outside the
  // vault (copies carrying a notion-id would be found by the next sync).
  const inside = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const where = async (path: string) => {
    // The real location of the folder, or of its nearest existing parent when it doesn't exist yet.
    const full = resolve(path);
    const tail: string[] = [];
    for (let at = full; ; at = dirname(at)) {
      try {
        return join(await realpath(at), ...tail);
      } catch {
        if (dirname(at) === at) return full;
        tail.unshift(at.slice(dirname(at).length + 1));
      }
    }
  };
  if (inside(await where(root), await where(backup))) {
    console.error(`the backup folder ${backup} is inside the vault; choose a folder outside it`);
    process.exit(2);
  }
  const existing = await readdir(backup).catch(() => null);
  if (existing !== null && existing.length > 0) {
    console.error(`the backup folder ${backup} is not empty; choose a new or empty folder, so no earlier backup is overwritten`);
    process.exit(2);
  }
}

let notes = 0;
let tags = 0;
for (const note of (await scanVault(root)).notes) {
  const moved = moveTopTags(note.text);
  if (!moved) continue;
  notes++;
  tags += moved.moved.length;
  console.log(`${note.path}: ${moved.moved.map((tag) => `#${tag}`).join(" ")}`);
  if (write && backup) {
    await mkdir(dirname(join(backup, note.path)), { recursive: true });
    await copyFile(join(root, note.path), join(backup, note.path), constants.COPYFILE_EXCL);
    await writeFile(join(root, note.path), moved.text);
  }
}
console.log(`${notes} notes, ${tags} tags`);
