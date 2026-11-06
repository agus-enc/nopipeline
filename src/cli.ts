#!/usr/bin/env node
// nopipeline sync [--dry-run] [--yes] [--config <file>] [--allow-mass-trash] [--notify]
// nopipeline sync --auto [--config <file>]
// nopipeline setup [--config <file>]
// nopipeline confirm [--config <file>]
// nopipeline launcher install|uninstall [--config <file>]
// nopipeline auto install|uninstall [--config <file>]
import { createInterface } from "node:readline/promises";
import { Writable, type Readable } from "node:stream";
import { parseArgs } from "node:util";
import { defaultConfigPath, loadConfig, readToken, StateClaimError, type Config } from "./config.ts";
import { systemDesktop, type Desktop } from "./desktop.ts";
import { createDiscovery, type Discovery } from "./notion/discover.ts";
import { createSdkGateway, type NotionGateway } from "./notion/gateway.ts";
import { exitCode, formatMediaPlan, formatPlan, formatSummary } from "./report.ts";
import { realpathSync } from "node:fs";
import { installAuto, uninstallAuto, userSystemctl, type Systemctl } from "./auto/timer.ts";
import { installLauncher, launcherNode, profileOf, uninstallLauncher, whichSync } from "./launcher.ts";
import { runSetup, type SetupIo } from "./setup.ts";
import { writeLastSync } from "./auto/clock.ts";
import { whyNotDue, logSkip, logAuto, type DueDeps } from "./auto/due.ts";
import { autoNotifiedFile, clearConfigError, fingerprintOf, isNewConfigError, isNewResult, rememberConfigError, rememberResult, type AutoResult } from "./auto/notified.ts";
import { heldFrom, readHeld, saveHeld } from "./status/held.ts";
import { renderStatusNote, writeStatusNote, type RunKind, type StatusInput } from "./status/note.ts";
import { notificationFor, reportUrl, type Ending } from "./status/notify.ts";
import { LockTakenError } from "./state/lock.ts";
import { runSync } from "./sync.ts";
import { readOpenTabs, systemObsidian, type ObsidianProbe } from "./vault/inuse.ts";
import { writeFlushed, makeFolders } from "./durable.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: nopipeline sync [options]
       nopipeline setup [--config <file>]
       nopipeline confirm [--config <file>]
       nopipeline launcher install|uninstall [--config <file>]
       nopipeline auto install|uninstall [--config <file>]

sync: syncs an Obsidian vault with a Notion database, both ways.
setup: walks you through a profile (token, databases, vault); it only reads Notion.
confirm: applies exactly what the last real run held back (the first sync, or trashes over the limit); running it is the confirmation.
launcher: adds (or removes) an entry in the desktop's app menu that runs sync, with Preview and Confirm actions.
auto: sets up (or removes) a systemd user timer that runs sync --auto every 15 minutes; the sync itself runs only when due (see autoSyncHours).

Options:
  --dry-run            show what would change, change nothing but the status note and the log
  --yes                allow the first real run on a profile (it only previews otherwise)
  --config <file>      profile config (default: ${defaultConfigPath()})
  --allow-mass-trash   allow a run that trashes more notes, or moves more attachments to .trash, than the configured limit
  --notify             end with a desktop notification (for runs started from a launcher or a timer)
  --auto               run only when due (for a timer): skips quietly, never starts a first sync, notifies a new result once; not with --yes, --dry-run or --allow-mass-trash
  --help               show this help`;

/**
 * Questions on the terminal through readline; a secret is read with the echo off. Piped input (not a terminal) is read
 * line by line into a queue as it arrives, so answers written all at once are not lost before their question is asked.
 */
export function terminalIo(out: (line: string) => void, streams: { input?: Readable; output?: Writable } = {}): SetupIo & { close(): void } {
  const input = streams.input ?? process.stdin;
  const shown = streams.output ?? process.stdout;
  const interactive = (input as { isTTY?: boolean }).isTTY === true;
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) shown.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input, output, terminal: interactive });

  const queued: string[] = [];
  let waiting: { resolve(line: string): void; reject(error: Error): void } | null = null;
  let ended = false;
  if (!interactive) {
    rl.on("line", (line) => {
      if (waiting) {
        const w = waiting;
        waiting = null;
        w.resolve(line);
      } else queued.push(line);
    });
    rl.on("close", () => {
      ended = true;
      waiting?.reject(new Error("the input ended before every question was answered"));
      waiting = null;
    });
  }
  const line = (prompt: string): Promise<string> => {
    if (interactive) return rl.question(prompt);
    shown.write(prompt);
    if (queued.length > 0) return Promise.resolve(queued.shift()!);
    if (ended) return Promise.reject(new Error("the input ended before every question was answered"));
    return new Promise((resolve, reject) => void (waiting = { resolve, reject }));
  };
  return {
    async ask(question, suggestion) {
      const answer = (await line(suggestion === undefined ? `${question} ` : `${question} [${suggestion}] `)).trim();
      return answer === "" ? (suggestion ?? "") : answer;
    },
    async askSecret(question) {
      shown.write(question);
      muted = true;
      try {
        return await (interactive ? rl.question("") : line(""));
      } finally {
        muted = false;
        shown.write("\n");
      }
    },
    out,
    close: () => rl.close(),
  };
}

/** What `main` uses for `setup`; tests replace both. */
export interface SetupDeps {
  io?: SetupIo;
  discover?: (token: string) => Discovery;
}

export interface MainDeps extends SetupDeps {
  gateway?: (config: Config, token: string) => NotionGateway;
  desktop?: Desktop;
  now?: () => Date;
  /** stdin is a terminal (default `process.stdin.isTTY === true`). */
  interactive?: boolean;
  /** Replaces the checks of `sync --auto` (tests). */
  due?: Partial<DueDeps>;
  /** Replaces the check for a running Obsidian and its open tabs (tests). */
  obsidian?: ObsidianProbe;
  /** Replaces `systemctl --user` for `auto install|uninstall` (tests). */
  systemctl?: Systemctl;
}

interface RunFlags {
  dryRun: boolean;
  yes: boolean;
  allowMassTrash: boolean;
  allowTrashes?: { pages: readonly string[]; files: readonly string[] };
  notify: boolean;
  /** `sync --auto`: the quieter notification rule, and exit 0 unless the run failed. */
  auto?: boolean;
}

const sdkGateway = (config: Config, token: string): NotionGateway =>
  createSdkGateway({
    token,
    dataSourceId: config.dataSourceId,
    titleProperty: config.titleProperty,
    projectsRelation: config.projectsRelation,
    pageIcon: config.pageIcon,
    ...(config.linksToProperty === null ? {} : { linksToProperty: config.linksToProperty }),
    ...(config.tagsProperty == null ? {} : { tagsProperty: config.tagsProperty }),
  });

/** How long an automatic run waits for a click on its popup before treating it as shown. */
const AUTO_NOTIFY_WAIT_MS = 10 * 60_000;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Shared by sync and confirm: one run with the status note, the log, held.json and the optional notification. */
export async function syncAndReport(config: Config, flags: RunFlags, out: (line: string) => void, deps: MainDeps = {}): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const lines: string[] = [];
  const say = (line: string) => {
    lines.push(line);
    out(line);
  };
  const logFile = join(config.stateDir, "last-run.log");
  const writeLog = async () => {
    await makeFolders(config.stateDir);
    await writeFlushed(logFile, lines.join("\n"));
  };
  /** Writes the status note unless it is off; a note of the user's at its path is left alone and said so. */
  const writeNote = async (input: Omit<StatusInput, "notePath" | "profile" | "stateDir" | "at">) => {
    const notePath = config.statusNote ?? null;
    if (notePath === null) return { written: false, taken: null as string | null };
    const text = renderStatusNote({ ...input, at: now(), profile: config.profile, stateDir: config.stateDir, notePath });
    try {
      if ((await writeStatusNote(config.vaultPath, notePath, text)) === "taken") {
        say(`warning: status note not written: ${notePath} is one of your notes; set statusNote in the profile`);
        return { written: false, taken: notePath };
      }
      return { written: true, taken: null };
    } catch (error) {
      say(`warning: status note not written: ${messageOf(error)}`);
      return { written: false, taken: null };
    }
  };
  const failedEnding = (error: unknown, status: { written: boolean; taken: string | null }): Ending => ({
    kind: "failed", changes: 0, needLook: 0, heldNotes: 0, heldFiles: 0, listChanged: false, error: messageOf(error), statusTaken: status.taken, statusWritten: status.written,
  });

  let ending: Ending | null = null;
  let autoResult: AutoResult | null = null;
  let reachedFinish = false;
  let code = 0;
  try {
    const token = await readToken(config);
    const notion = (deps.gateway ?? sdkGateway)(config, token);
    await runSync({
      config,
      notion,
      dryRun: flags.dryRun,
      yes: flags.yes,
      allowMassTrash: flags.allowMassTrash,
      ...(flags.allowTrashes ? { allowTrashes: flags.allowTrashes } : {}),
      now,
      obsidian: deps.obsidian ?? systemObsidian,
      log: say,
      finish: async (result) => {
        reachedFinish = true;
        if ("error" in result) {
          // The failure line goes to the log only: the terminal gets the error from the caller, once.
          lines.push(`nopipeline: ${messageOf(result.error)}`);
          autoResult = { failed: messageOf(result.error), heldPages: [], heldFiles: [], needLook: [] };
          ending = failedEnding(result.error, { written: false, taken: null });
          try {
            ending = failedEnding(result.error, await writeNote({ kind: "failed", error: messageOf(result.error), report: "", exitCode: 2 }));
            await writeLog();
          } catch {
            // The original error wins over a failed write.
          }
          return;
        }
        const { outcome } = result;
        const stoppedAtFirstRun = outcome.summary === null && !flags.dryRun;
        const kind: RunKind = flags.dryRun ? "preview" : stoppedAtFirstRun ? "first-run" : "sync";
        const before = lines.length;
        if (outcome.summary === null) {
          say(formatPlan(outcome.plan, outcome.notes, outcome.pages));
          if (outcome.mediaPlan) say(formatMediaPlan(outcome.mediaPlan, true));
          if (outcome.linksToPreview) say(outcome.linksToPreview.join("\n"));
          if (outcome.tagsPreview) say(outcome.tagsPreview.map((line) => `  ${line}`).join("\n"));
          if (stoppedAtFirstRun) say("\nThis profile has never synced, so this was only a preview and nothing was changed. Run again with --yes to apply it.");
        } else {
          say(formatSummary(outcome.summary, outcome.plan));
          if (outcome.mediaPlan) say(formatMediaPlan(outcome.mediaPlan, false));
        }
        const report = lines.slice(before).join("\n");
        const waiting = outcome.plan.waiting?.length ?? 0;
        if (waiting > 0 && !flags.auto) {
          say(
            waiting === 1
              ? "1 note waited because it is open in Obsidian or was edited in the last few minutes; close it and run again to sync it."
              : `${waiting} notes waited because they are open in Obsidian or were edited in the last few minutes; close them and run again to sync them.`,
          );
        }
        code = exitCode(outcome.summary, outcome.plan, stoppedAtFirstRun);
        const status = await writeNote({ kind, outcome, report, exitCode: code });
        const { summary, plan } = outcome;
        const heldNotes = plan.held?.length ?? 0;
        const heldFiles = plan.heldFiles?.length ?? 0;
        ending = {
          kind,
          changes: summary ? Object.values(summary.done).reduce((a, n) => a + (n ?? 0), 0) : plan.actions.length + (plan.creates?.length ?? 0),
          needLook: (summary?.skipped.length ?? 0) + (summary?.conflicts.length ?? 0) + (summary?.rewritten.length ?? 0),
          heldNotes,
          heldFiles,
          listChanged: flags.allowTrashes !== undefined && heldNotes + heldFiles > 0,
          statusTaken: status.taken,
          statusWritten: status.written,
        };
        autoResult = {
          heldPages: (plan.held ?? []).map((h) => h.pageId),
          heldFiles: plan.heldFiles ?? [],
          needLook: [...(summary?.skipped.map((s) => s.path) ?? []), ...(summary?.conflicts ?? []), ...(summary?.rewritten ?? [])],
        };
        if (flags.auto) code = 0;
        try {
          if (!flags.dryRun) await saveHeld(config.stateDir, heldFrom(outcome, stoppedAtFirstRun, now()));
          if (kind === "sync" && waiting === 0) await writeLastSync(config.stateDir, now());
        } finally {
          await writeLog();
        }
      },
    });
  } catch (error) {
    if (error instanceof LockTakenError && flags.auto) {
      await logSkip(config.stateDir, "busy", now());
      return 0;
    }
    if (error instanceof LockTakenError && flags.notify) {
      ending = { kind: "busy", changes: 0, needLook: 0, heldNotes: 0, heldFiles: 0, listChanged: false, statusWritten: false };
    } else if (error instanceof LockTakenError) {
      throw error;
    } else {
      if (!reachedFinish) {
        // Before the lock (the token, the state folder): nothing ran, but the failure is still written down.
        lines.push(`nopipeline: ${messageOf(error)}`);
        try {
          const status = await writeNote({ kind: "failed", error: messageOf(error), report: "", exitCode: 2 });
          ending = failedEnding(error, status);
          // The state folder of another vault gets nothing, not even the log.
          if (!(error instanceof StateClaimError)) await writeLog();
        } catch {
          // The original error is the one that matters.
        }
      }
      if (!flags.notify) throw error;
      autoResult ??= { failed: messageOf(error), heldPages: [], heldFiles: [], needLook: [] };
      console.error(`nopipeline: ${messageOf(error)}`);
      ending ??= failedEnding(error, { written: false, taken: null });
      code = 2;
    }
    if ((ending as Ending).kind === "busy") code = 2;
  }
  if (flags.auto) {
    const fingerprint = autoResult === null ? null : fingerprintOf(autoResult);
    const file = autoNotifiedFile(config.stateDir);
    if (autoResult !== null && (await isNewResult(file, fingerprint))) {
      const { text, openReport } = notificationFor(ending ?? failedEnding(autoResult.failed ?? "unknown error", { written: false, taken: null }));
      const desktop = deps.desktop ?? systemDesktop();
      // A popup nobody answers must not stall the timer: wait at most 10 minutes; that counts as shown.
      const result = await desktop.notify(text, openReport ? "Open report" : undefined, { waitMs: AUTO_NOTIFY_WAIT_MS });
      if (result === "missing" || result === "failed") {
        await logAuto(config.stateDir, `notification not shown: ${result === "missing" ? "notify-send not found" : "notify-send failed"}`, (deps.now ?? (() => new Date()))()).catch(() => {});
      } else {
        await rememberResult(file, fingerprint!);
        if (result === "clicked" && config.statusNote) await desktop.open(reportUrl(join(config.vaultPath, config.statusNote)));
      }
    }
  } else if (flags.notify && ending !== null) {
    const desktop = deps.desktop ?? systemDesktop();
    const { text, openReport } = notificationFor(ending);
    const result = await desktop.notify(text, openReport ? "Open report" : undefined);
    if (result === "clicked" && config.statusNote) await desktop.open(reportUrl(join(config.vaultPath, config.statusNote)));
    if (result === "missing" && ending.kind !== "busy") {
      lines.push("warning: couldn't show a notification (notify-send not found)");
      await writeLog().catch(() => {});
    }
  }
  return code;
}

/** `nopipeline confirm`: runs, without asking, the sync allowed to do exactly what the last real run held. */
async function confirm(config: Config, out: (line: string) => void, deps: MainDeps): Promise<number> {
  const interactive = deps.interactive ?? process.stdin.isTTY === true;
  const desktop = () => deps.desktop ?? systemDesktop();
  const held = await readHeld(config.stateDir);
  if (held === null) {
    const text = "Nothing is waiting for confirmation.";
    out(text);
    if (!interactive) await desktop().notify(text);
    return 0;
  }
  return syncAndReport(
    config,
    { dryRun: false, yes: held.firstRun, allowMassTrash: false, allowTrashes: { pages: held.notes.map((n) => n.pageId), files: held.files }, notify: true },
    out,
    deps,
  );
}

/** `nopipeline launcher install|uninstall`: the desktop entry for the profile's config file. */
async function launcher(action: "install" | "uninstall", configPath: string, out: (line: string) => void): Promise<number> {
  if (action === "uninstall") {
    const result = await uninstallLauncher({ configPath });
    out(result === "removed" ? "Launcher removed." : result === "absent" ? "No launcher is installed for this profile." : "A file that nopipeline didn't write is at the launcher's path; it was left alone.");
    return result === "not ours" ? 1 : 0;
  }
  const { path, missing } = await installLauncher({ node: launcherNode(process.execPath, (program) => whichSync(program), realpathSync), cli: fileURLToPath(import.meta.url), configPath });
  out(`Launcher written to ${path}`);
  out('Find "nopipeline sync" in the launcher, right-click → Pin to Task Manager.');
  for (const program of missing) out(`warning: ${program} not found; ${program === "notify-send" ? "notifications won't show" : "the Open report button won't work"}`);
  out("If you move this folder or an upgrade changes Node's path, run `nopipeline launcher install` again.");
  return 0;
}

/** `nopipeline auto install|uninstall`: the systemd user timer for the profile's config file. */
async function auto(action: "install" | "uninstall", configPath: string, out: (line: string) => void, systemctl: Systemctl): Promise<number> {
  try {
    if (action === "uninstall") {
      const result = await uninstallAuto({ configPath, systemctl });
      out(result === "removed" ? "Automatic sync removed." : result === "absent" ? "No automatic sync is installed for this profile." : "A file that nopipeline didn't write is at a unit's path; it was left alone.");
      return result === "not ours" ? 1 : 0;
    }
    const node = launcherNode(process.execPath, (program) => whichSync(program), realpathSync);
    const names = await installAuto({ node, cli: fileURLToPath(import.meta.url), configPath, systemctl });
    const folder = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user");
    out(`Timer written to ${join(folder, names.timer)}`);
    out(`Service written to ${join(folder, names.service)}`);
    out("See it: systemctl --user list-timers 'nopipeline*'");
    out(`Skipped runs are logged in ${join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "nopipeline", profileOf(configPath, process.env).profile, "auto.log")}`);
    out("A profile that has synced before but has no last-sync.json yet is due right away: the first tick after installing (within 15 minutes) runs a real sync if Obsidian is closed or its open tabs can be read.");
    out("Remove it: nopipeline auto uninstall (with the same --config).");
    out("If you move this folder or an upgrade changes Node's path, run `nopipeline auto install` again.");
    return 0;
  } catch (error) {
    out(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export async function main(argv: string[], out: (line: string) => void = console.log, deps: MainDeps = {}): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      config: { type: "string" },
      "allow-mass-trash": { type: "boolean", default: false },
      notify: { type: "boolean", default: false },
      auto: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    out(USAGE);
    return 0;
  }
  if (positionals[0] === "launcher") {
    if ((positionals[1] !== "install" && positionals[1] !== "uninstall") || positionals.length > 2) {
      out(USAGE);
      return 2;
    }
    return launcher(positionals[1], values.config ?? defaultConfigPath(), out);
  }
  if (positionals[0] === "auto") {
    if ((positionals[1] !== "install" && positionals[1] !== "uninstall") || positionals.length > 2) {
      out(USAGE);
      return 2;
    }
    return auto(positionals[1], values.config ?? defaultConfigPath(), out, deps.systemctl ?? userSystemctl);
  }
  if ((positionals[0] !== "sync" && positionals[0] !== "setup" && positionals[0] !== "confirm") || positionals.length > 1) {
    out(USAGE);
    return 2;
  }
  if (values.auto && (positionals[0] !== "sync" || values.yes || values["dry-run"] || values["allow-mass-trash"])) {
    out(USAGE);
    return 2;
  }
  if (positionals[0] === "setup") {
    const terminal = deps.io ? null : terminalIo(out);
    try {
      return await runSetup(deps.io ?? terminal!, { configPath: values.config ?? defaultConfigPath(), env: process.env, discover: deps.discover ?? ((token) => createDiscovery(token)) });
    } finally {
      terminal?.close();
    }
  }
  let config: Config;
  try {
    config = await loadConfig(values.config ?? defaultConfigPath());
  } catch (error) {
    if (values.auto) {
      console.error(`nopipeline: ${messageOf(error)}`);
      const path = values.config ?? defaultConfigPath();
      if (await isNewConfigError(process.env, path, messageOf(error))) {
        const shown = await (deps.desktop ?? systemDesktop()).notify(`Sync failed: ${messageOf(error)}`);
        if (shown === "missing" || shown === "failed") console.error(`nopipeline: notification not shown (${shown})`);
        else await rememberConfigError(process.env, path, messageOf(error));
      }
      return 2;
    }
    const launched = positionals[0] === "confirm" && !(deps.interactive ?? process.stdin.isTTY === true);
    if (!values.notify && !launched) throw error;
    console.error(`nopipeline: ${messageOf(error)}`);
    const { text } = notificationFor({ kind: "failed", changes: 0, needLook: 0, heldNotes: 0, heldFiles: 0, listChanged: false, error: messageOf(error), statusWritten: false });
    await (deps.desktop ?? systemDesktop()).notify(text);
    return 2;
  }
  if (positionals[0] === "confirm") return confirm(config, out, deps);
  if (values.auto) {
    await clearConfigError(process.env, values.config ?? defaultConfigPath());
    const reason = await whyNotDue(config.stateDir, config.autoSyncHours ?? 6, { now: deps.now ?? (() => new Date()), tabsReadable: () => readOpenTabs(config.vaultPath).then((t) => t !== null), ...deps.due });
    if (reason !== null) {
      await logSkip(config.stateDir, reason, (deps.now ?? (() => new Date()))());
      return 0;
    }
    return syncAndReport(config, { dryRun: false, yes: false, allowMassTrash: false, notify: true, auto: true }, out, deps);
  }
  return syncAndReport(config, { dryRun: values["dry-run"], yes: values.yes, allowMassTrash: values["allow-mass-trash"], notify: values.notify }, out, deps);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`nopipeline: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    },
  );
}
