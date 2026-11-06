// Turning Notion titles into safe, unique Obsidian file names.

const FORBIDDEN = /[/\\:*?"<>|#^[\]]/g;
const MAX_BYTES = 200;

export function titleToFileName(title: string): string {
  let name = title.normalize("NFC").replace(FORBIDDEN, "-").replace(/\s+/g, " ").trim();
  name = name.replace(/^\.+/, (dots) => "-".repeat(dots.length));
  name = name.replace(/[. ]+$/, "");
  while (Buffer.byteLength(name, "utf8") > MAX_BYTES) name = Array.from(name).slice(0, -1).join("");
  name = name.trim();
  return name === "" ? "Untitled" : name;
}

/** `taken` holds lowercase names (no folder, no `.md`) already used in the vault. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Whether a project folder names a folder inside the vault that the scan sees: `/`-separated names, none
 * empty, none starting with `.`, none holding `\\`, control characters or characters file names can't have.
 */
export function usableFolder(folder: string): boolean {
  return folder.split("/").every((name) => name !== "" && !name.startsWith(".") && !/[\\:*?"<>|#^[\]\u0000-\u001f\u007f]/.test(name));
}
