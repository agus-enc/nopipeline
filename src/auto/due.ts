// Is an automatic run due? The cheap, silent checks of spec §4.2, in order.
import { connect as netConnect, type Socket } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultExec, type Exec } from "../desktop.ts";
import { makeFolders, writeFlushed } from "../durable.ts";
import { readLastSync } from "./clock.ts";

export type SkipReason = "never-synced" | "not-due" | "obsidian-open" | "offline" | "busy";

export interface DueDeps {
  now: () => Date;
  /** Read-only: does `<stateDir>/records` hold a .json file? Creates nothing. */
  hasRecords: (stateDir: string) => Promise<boolean>;
  lastSync: (stateDir: string) => Promise<Date | null>;
  obsidianRunning: () => Promise<boolean>;
  /** Obsidian's open tabs can be read, so a run can leave the notes in use waiting instead of skipping the tick. */
  tabsReadable: () => Promise<boolean>;
  notionReachable: () => Promise<boolean>;
}

const OBSIDIAN_APP = "md.obsidian.Obsidian";
const REACH_HOST = "api.notion.com";
const REACH_PORT = 443;
const REACH_TIMEOUT_MS = 5000;
const LOG_LINES = 200;

export async function hasRecords(stateDir: string): Promise<boolean> {
  try {
    return (await readdir(join(stateDir, "records"))).some((name) => name.endsWith(".json"));
  } catch {
    return false;
  }
}

/** Flatpak lists the app, or a process named obsidian exists. A missing program counts as "not found". */
export function obsidianRunningWith(exec: Exec = defaultExec): () => Promise<boolean> {
  return async () => {
    const flatpak = await exec("flatpak", ["ps", "--columns=application"]);
    if (flatpak && flatpak.stdout.split("\n").some((line) => line.trim() === OBSIDIAN_APP)) return true;
    const pgrep = await exec("pgrep", ["-x", "obsidian"]);
    return pgrep !== null && pgrep.code === 0;
  };
}

/** A plain TCP connect, no request and no token; false on an error or when nothing answers in time. */
export function notionReachableWith(
  connect: (port: number, host: string) => Socket = (port, host) => netConnect(port, host),
  timeoutMs = REACH_TIMEOUT_MS,
): () => Promise<boolean> {
  return () =>
    new Promise((resolve) => {
      let socket: Socket | undefined;
      let timer: NodeJS.Timeout | undefined;
      const done = (ok: boolean) => {
        clearTimeout(timer);
        socket?.destroy();
        resolve(ok);
      };
      timer = setTimeout(() => done(false), timeoutMs);
      try {
        socket = connect(REACH_PORT, REACH_HOST);
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
      } catch {
        done(false);
      }
    });
}

/** The reason to skip, or null when a run is due ("busy" is decided later, by the lock). */
export async function whyNotDue(stateDir: string, hours: number, deps: Partial<DueDeps> = {}): Promise<SkipReason | null> {
  const d: DueDeps = {
    now: () => new Date(),
    hasRecords,
    lastSync: readLastSync,
    obsidianRunning: obsidianRunningWith(),
    tabsReadable: async () => false,
    notionReachable: notionReachableWith(),
    ...deps,
  };
  if (!(await d.hasRecords(stateDir))) return "never-synced";
  const last = await d.lastSync(stateDir);
  if (last !== null && d.now().getTime() - last.getTime() < hours * 3_600_000) return "not-due";
  if ((await d.obsidianRunning()) && !(await d.tabsReadable())) return "obsidian-open";
  if (!(await d.notionReachable())) return "offline";
  return null;
}

export const logSkip = (stateDir: string, reason: SkipReason, at: Date): Promise<void> => logAuto(stateDir, `skipped: ${reason}`, at);

/** Appends "<ISO> <message>" to auto.log, keeping its last 200 lines. */
export async function logAuto(stateDir: string, message: string, at: Date): Promise<void> {
  const file = join(stateDir, "auto.log");
  const old = await readFile(file, "utf8").catch(() => "");
  const lines = [...old.split("\n").filter((line) => line !== ""), `${at.toISOString()} ${message}`].slice(-LOG_LINES);
  await makeFolders(stateDir);
  await writeFlushed(file, `${lines.join("\n")}\n`);
}
