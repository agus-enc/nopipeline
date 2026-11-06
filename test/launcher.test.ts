import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopEntry, execArg, installLauncher, launcherNode, launcherPath, uninstallLauncher } from "../src/launcher.ts";
import { tempDir } from "./helpers/tmp.ts";

test("execArg quotes the way the Desktop Entry spec says", () => {
  assert.equal(execArg("/usr/bin/node"), "/usr/bin/node");
  assert.equal(execArg("/home/a b/cli.ts"), '"/home/a b/cli.ts"');
  assert.equal(execArg('/x/"q"$v'), '"/x/\\\\"q\\\\"\\\\$v"');
  assert.equal(execArg("/x/100%.json"), "/x/100%%.json");
});

/** What a reader of the Desktop Entry spec would get back from one Exec argument (unquote, then the string-level unescape, then `%%`). */
function readBack(arg: string): string {
  const unescaped = arg.replace(/\\(.)/g, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c === "\\" ? "\\" : c)).replace(/%%/g, "%");
  if (!unescaped.startsWith('"')) return unescaped;
  return unescaped.slice(1, -1).replace(/\\(["`$\\])/g, "$1");
}

test("execArg round-trips awkward characters and never leaves a raw line break", () => {
  for (const arg of ["a\\b c", "it's here", "back`tick x", "(paren) x", "100% sure x", 'q"uote x', "$HOME x", "line\nbreak", "tab\there", "cr\rhere", "p;&|<>*?#~ x"]) {
    const out = execArg(arg);
    assert.doesNotMatch(out, /[\n\t\r]/, JSON.stringify(arg));
    assert.equal(readBack(out), arg, JSON.stringify(arg));
  }
  assert.equal(execArg("a\nb"), '"a\\nb"');
});

test("desktopEntry keeps a config path with a space and % in one piece", () => {
  const text = desktopEntry({ ...base, configPath: "/home/u/my 100%/c.json", profile: "c", isDefault: true });
  const exec = text.split("\n").find((l) => l.startsWith("Exec="))!;
  assert.ok(exec.endsWith('--config "/home/u/my 100%%/c.json"'), exec);
  assert.ok(!text.split("\n").some((l) => l.includes("100%") && !l.includes("100%%")));
});

test("launcherNode prefers the PATH node when it is the running one in /usr/bin or /usr/local/bin", () => {
  const real = (map: Record<string, string>) => (p: string) => map[p] ?? p;
  assert.equal(launcherNode("/usr/bin/node-22", () => "/usr/bin/node", real({ "/usr/bin/node": "/usr/bin/node-22" })), "/usr/bin/node");
  assert.equal(launcherNode("/usr/bin/node-22", () => "/usr/local/bin/node", real({ "/usr/local/bin/node": "/usr/bin/node-22" })), "/usr/local/bin/node");
  // another node, another folder, nothing on PATH, or a failing realpath: the running one
  assert.equal(launcherNode("/usr/bin/node-22", () => "/usr/bin/node", real({ "/usr/bin/node": "/usr/bin/node-24" })), "/usr/bin/node-22");
  assert.equal(launcherNode("/opt/n/bin/node", () => "/home/u/.nvm/bin/node", real({ "/home/u/.nvm/bin/node": "/opt/n/bin/node" })), "/opt/n/bin/node");
  assert.equal(launcherNode("/usr/bin/node-22", () => null, real({})), "/usr/bin/node-22");
  assert.equal(launcherNode("/usr/bin/node-22", () => "/usr/bin/node", () => { throw new Error("x"); }), "/usr/bin/node-22");
});

const base = { node: "/usr/bin/node", cli: "/opt/n p/src/cli.ts", configPath: "/home/u/.config/nopipeline/config.json" };

test("desktopEntry for the default profile and for a named one", () => {
  const text = desktopEntry({ ...base, profile: "config", isDefault: true });
  assert.match(text, /^Name=nopipeline sync$/m);
  assert.match(text, /^Actions=preview;confirm;$/m);
  assert.match(text, /^X-nopipeline=1$/m);
  assert.match(text, /^Icon=folder-sync$/m);
  assert.match(text, /^Terminal=false$/m);
  const execs = text.split("\n").filter((l) => l.startsWith("Exec="));
  assert.equal(execs.length, 3);
  assert.ok(execs.every((l) => l.includes("--config /home/u/.config/nopipeline/config.json")));
  assert.equal(execs[0], 'Exec=/usr/bin/node "/opt/n p/src/cli.ts" sync --notify --config /home/u/.config/nopipeline/config.json');
  assert.match(execs[1]!, /sync --dry-run --notify --config/);
  assert.match(execs[2]!, /cli\.ts" confirm --config/);
  const second = desktopEntry({ ...base, profile: "second", isDefault: false });
  assert.match(second, /^Name=nopipeline sync \(second\)$/m);
});

test("launcherPath names the default profile and the others", () => {
  const env = { XDG_DATA_HOME: "/d" };
  assert.equal(launcherPath("config", true, env), "/d/applications/nopipeline.desktop");
  assert.equal(launcherPath("second", false, env), "/d/applications/nopipeline-second.desktop");
});

test("install writes the entry, overwrites it, and uninstall only removes its own file", async (t) => {
  const dir = await tempDir(t);
  const env = { XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "cfg"), PATH: join(dir, "nobin") };
  const configPath = join(dir, "cfg", "nopipeline", "second.json");
  const o = { node: "/usr/bin/node", cli: "/opt/cli.ts", configPath, env };
  const file = join(dir, "data", "applications", "nopipeline-second.desktop");
  const first = await installLauncher(o);
  assert.equal(first.path, file);
  assert.deepEqual(first.missing, ["notify-send", "xdg-open"]);
  assert.match(await readFile(file, "utf8"), /^Name=nopipeline sync \(second\)$/m);
  await installLauncher({ ...o, cli: "/opt/other.ts" });
  assert.match(await readFile(file, "utf8"), /other\.ts/);
  assert.equal(await uninstallLauncher({ configPath, env }), "removed");
  assert.equal(await uninstallLauncher({ configPath, env }), "absent");
  await mkdir(join(dir, "data", "applications"), { recursive: true });
  await writeFile(file, "[Desktop Entry]\nName=mine\n");
  assert.equal(await uninstallLauncher({ configPath, env }), "not ours");
  assert.match(await readFile(file, "utf8"), /Name=mine/);
});

test("the default profile gets nopipeline.desktop; programs found on PATH are not missing", async (t) => {
  const dir = await tempDir(t);
  const bin = join(dir, "bin");
  await mkdir(bin);
  for (const name of ["notify-send", "xdg-open"]) await writeFile(join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
  const env = { XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "cfg"), PATH: bin };
  const r = await installLauncher({ node: "/n", cli: "/c.ts", configPath: join(dir, "cfg", "nopipeline", "config.json"), env });
  assert.equal(r.path, join(dir, "data", "applications", "nopipeline.desktop"));
  assert.deepEqual(r.missing, []);
});
