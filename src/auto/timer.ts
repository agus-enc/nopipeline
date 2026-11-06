// The systemd user timer behind `nopipeline auto install|uninstall` (spec §4.4).
import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeFlushed } from "../durable.ts";
import { fileSafe, label, profileOf } from "../launcher.ts";

type Env = Record<string, string | undefined>;

const MARKER = "# X-nopipeline";

/** One argument of an `ExecStart` line: quoted with `"` when it needs it (`\` and `"` escaped), then `%` → `%%` and `$` → `$$`. */
export function systemdArg(arg: string): string {
  let text = arg;
  if (/[\s"'\\]/.test(text)) text = `"${text.replace(/[\\"]/g, "\\$&")}"`;
  return text.replace(/%/g, "%%").replace(/\$/g, "$$$$");
}

/** The profile label for a `Description=` line: `%` is a specifier there. */
const descText = (profile: string) => label(profile).replace(/%/g, "%%");

export function unitNames(profile: string, isDefault: boolean): { service: string; timer: string } {
  const base = isDefault ? "nopipeline-auto" : `nopipeline-auto-${fileSafe(profile)}`;
  return { service: `${base}.service`, timer: `${base}.timer` };
}

export function serviceUnit(o: { node: string; cli: string; configPath: string; profile: string }): string {
  return [
    MARKER,
    "[Unit]",
    `Description=nopipeline automatic sync (${descText(o.profile)})`,
    "",
    "[Service]",
    "Type=oneshot",
    // A backstop: a hung run must not stall the timer for good.
    "TimeoutStartSec=1h",
    `ExecStart=${[o.node, o.cli, "sync", "--auto", "--config", o.configPath].map(systemdArg).join(" ")}`,
    "",
  ].join("\n");
}

export function timerUnit(o: { service: string; profile: string }): string {
  return [
    MARKER,
    "[Unit]",
    `Description=nopipeline automatic sync, every 15 minutes (${descText(o.profile)})`,
    "",
    "[Timer]",
    "OnCalendar=*:0/15",
    "Persistent=true",
    `Unit=${o.service}`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

export type Systemctl = (args: string[]) => Promise<{ code: number; stderr: string }>;

/** `systemctl --user <args>` with no shell; a program that can't be started is code 127 with the reason. */
export const userSystemctl: Systemctl = (args) =>
  new Promise((resolve) => {
    execFile("systemctl", ["--user", ...args], (error, _stdout, stderr) => {
      if (!error) return resolve({ code: 0, stderr });
      const code = (error as { code?: unknown }).code;
      resolve({ code: typeof code === "number" ? code : 127, stderr: stderr.trim() || error.message });
    });
  });

function unitFolder(env: Env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user");
}

async function run(systemctl: Systemctl, args: string[]): Promise<void> {
  const { code, stderr } = await systemctl(args);
  if (code !== 0) throw new Error(`systemctl --user ${args.join(" ")} failed: ${stderr.trim() || `exit code ${code}`}`);
}

export async function installAuto(o: { node: string; cli: string; configPath: string; env?: Env; systemctl?: Systemctl }): Promise<{ service: string; timer: string }> {
  const env = o.env ?? process.env;
  const systemctl = o.systemctl ?? userSystemctl;
  const { absolute, profile, isDefault } = profileOf(o.configPath, env);
  const names = unitNames(profile, isDefault);
  const folder = unitFolder(env);
  const servicePath = join(folder, names.service);
  const timerPath = join(folder, names.timer);
  const files = [servicePath, timerPath];
  await mkdir(folder, { recursive: true });
  // A failed install puts back what was there (a previous install), and removes only what wasn't.
  const before = await Promise.all(files.map((file) => readFile(file, "utf8").catch(() => null)));
  try {
    await writeFlushed(servicePath, serviceUnit({ node: o.node, cli: o.cli, configPath: absolute, profile }));
    await writeFlushed(timerPath, timerUnit({ service: names.service, profile }));
    await run(systemctl, ["daemon-reload"]);
    await run(systemctl, ["enable", "--now", names.timer]);
  } catch (error) {
    for (const [i, file] of files.entries()) {
      const old = before[i]!;
      if (old === null) await rm(file, { force: true });
      else await writeFlushed(file, old).catch(() => {});
    }
    await systemctl(["daemon-reload"]).catch(() => {});
    throw error;
  }
  return names;
}

async function marked(file: string): Promise<boolean | null> {
  try {
    return (await readFile(file, "utf8")).split("\n").some((line) => line.trim() === MARKER);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function uninstallAuto(o: { configPath: string; env?: Env; systemctl?: Systemctl }): Promise<"removed" | "absent" | "not ours"> {
  const env = o.env ?? process.env;
  const systemctl = o.systemctl ?? userSystemctl;
  const { profile, isDefault } = profileOf(o.configPath, env);
  const names = unitNames(profile, isDefault);
  const folder = unitFolder(env);
  const files = [join(folder, names.service), join(folder, names.timer)];
  const found = await Promise.all(files.map(marked));
  if (found.every((f) => f === null)) return "absent";
  if (found.some((f) => f === false)) return "not ours";
  await run(systemctl, ["disable", "--now", names.timer]);
  for (const file of files) await rm(file, { force: true });
  await run(systemctl, ["daemon-reload"]);
  return "removed";
}
