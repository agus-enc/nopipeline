// The desktop launcher: a Desktop Entry for the app menu, with the preview and confirm actions as menu actions.
import { accessSync, realpathSync } from "node:fs";
import { access, constants, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { defaultConfigPath } from "./config.ts";
import { writeFlushed } from "./durable.ts";

type Env = Record<string, string | undefined>;

const MARKER = "X-nopipeline=1";
const MUST_QUOTE = /[ \t\n\r"'\\><~|&;$*?#()`]/;

/** One argument of an `Exec` line, quoted per the Desktop Entry spec (quote level, then `%`, then the string-level escape). */
export function execArg(arg: string): string {
  let text = arg;
  if (MUST_QUOTE.test(text)) text = `"${text.replace(/["`$\\]/g, "\\$&")}"`;
  return text
    .replace(/%/g, "%%")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r");
}

/**
 * The node the launcher runs: the one on PATH when it is the same file as the running node and sits in /usr/bin or /usr/local/bin
 * (so a distro's `node` symlink survives a version change), else `execPath`. `which` and `realpath` are injected.
 */
export function launcherNode(execPath: string, which: (program: string) => string | null, realpath: (path: string) => string): string {
  const found = which("node");
  if (found === null) return execPath;
  const dir = dirname(found);
  if (dir !== "/usr/bin" && dir !== "/usr/local/bin") return execPath;
  try {
    return realpath(found) === execPath ? found : execPath;
  } catch {
    return execPath;
  }
}

/** The first `program` on PATH that can be run, as a path; null when none. */
export function whichSync(program: string, env: Env = process.env): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, program);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not in this folder
    }
  }
  return null;
}

/** The profile's name as shown and as part of a file name: no control characters, nothing a path or a key line could be hurt by. */
export const label = (profile: string) => profile.replace(/[\u0000-\u001f\u007f]/g, " ").trim() || "profile";
export const fileSafe = (profile: string) => profile.replace(/[^A-Za-z0-9._-]/g, "-");

export function desktopEntry(o: { node: string; cli: string; configPath: string; profile: string; isDefault: boolean }): string {
  const run = (...args: string[]) => ["Exec=" + [o.node, o.cli].map(execArg).join(" "), ...args, "--config", execArg(o.configPath)].join(" ");
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=nopipeline sync${o.isDefault ? "" : ` (${label(o.profile)})`}`,
    "Comment=Sync the Obsidian vault with Notion",
    "Icon=folder-sync",
    "Terminal=false",
    "Categories=Utility;",
    "Actions=preview;confirm;",
    MARKER,
    run("sync", "--notify"),
    "",
    "[Desktop Action preview]",
    "Name=Preview (dry run)",
    run("sync", "--dry-run", "--notify"),
    "",
    "[Desktop Action confirm]",
    "Name=Confirm held changes",
    run("confirm"),
    "",
  ].join("\n");
}

export function launcherPath(profile: string, isDefault: boolean, env: Env = process.env): string {
  const data = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(data, "applications", isDefault ? "nopipeline.desktop" : `nopipeline-${fileSafe(profile)}.desktop`);
}

/** The profile is the config file's name without `.json`, as `loadConfig` names it. */
export function profileOf(configPath: string, env: Env) {
  const absolute = resolve(configPath);
  return { absolute, profile: basename(absolute).replace(/\.json$/, ""), isDefault: absolute === resolve(defaultConfigPath(env)) };
}

async function onPath(program: string, env: Env): Promise<boolean> {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try {
      await access(join(dir, program), constants.X_OK);
      return true;
    } catch {
      // not in this folder
    }
  }
  return false;
}

export async function installLauncher(o: { node: string; cli: string; configPath: string; env?: Env }): Promise<{ path: string; missing: string[] }> {
  const env = o.env ?? process.env;
  const { absolute, profile, isDefault } = profileOf(o.configPath, env);
  const path = launcherPath(profile, isDefault, env);
  await mkdir(dirname(path), { recursive: true });
  await writeFlushed(path, desktopEntry({ node: o.node, cli: o.cli, configPath: absolute, profile, isDefault }));
  const missing: string[] = [];
  for (const program of ["notify-send", "xdg-open"]) if (!(await onPath(program, env))) missing.push(program);
  return { path, missing };
}

export async function uninstallLauncher(o: { configPath: string; env?: Env }): Promise<"removed" | "absent" | "not ours"> {
  const env = o.env ?? process.env;
  const { profile, isDefault } = profileOf(o.configPath, env);
  const path = launcherPath(profile, isDefault, env);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (!text.split("\n").some((line) => line.trim() === MARKER)) return "not ours";
  await rm(path);
  return "removed";
}
