import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { main, terminalIo, type MainDeps } from "../src/cli.ts";
import type { Desktop } from "../src/desktop.ts";
import type { ObsidianProbe } from "../src/vault/inuse.ts";
import type { NotionGateway } from "../src/notion/gateway.ts";
import { STATUS_MARKER } from "../src/status/note.ts";
import { FakeNotion } from "./helpers/fake-notion.ts";
import { tempDir, writeTree } from "./helpers/tmp.ts";

test("--help prints the usage; unknown commands exit with 2", async () => {
  const out: string[] = [];
  assert.equal(await main(["--help"], (line) => out.push(line)), 0);
  assert.match(out.join("\n"), /Usage: nopipeline sync/);
  assert.equal(await main(["push"], () => {}), 2);
  assert.equal(await main([], () => {}), 2);
});

test("--version prints the version and exits 0", async () => {
  const out: string[] = [];
  assert.equal(await main(["--version"], (line) => out.push(line)), 0);
  assert.equal(out.length, 1);
  assert.match(out[0]!, /^nopipeline 0\.2\.0/);
});

test("a missing config file is reported plainly", async () => {
  await assert.rejects(main(["sync", "--config", "/nonexistent/profile.json"], () => {}), /can't read the config file/);
});

test("setup runs through main with the given answers and exits 0; the usage lists both commands", async () => {
  const out: string[] = [];
  assert.equal(await main(["--help"], (line) => out.push(line)), 0);
  assert.match(out.join("\n"), /nopipeline setup/);
  const io = { ask: async () => "", askSecret: async () => "", out: (line: string) => void out.push(line) };
  const never = () => assert.fail("no discovery without a token");
  // No token is given, so the setup stops before it reads anything from Notion.
  assert.equal(await main(["setup", "--config", "/nonexistent/dir/p.json"], () => {}, { io, discover: never }), 1);
  assert.equal(await main(["setup", "extra"], () => {}), 2);
});

test("U2: with piped input, answers written all at once are not lost between questions", async () => {
  const input = new PassThrough();
  const shown: string[] = [];
  const output = new Writable({ write: (chunk, _e, done) => (shown.push(String(chunk)), done()) });
  const io = terminalIo(() => {}, { input, output });
  input.end("one\n\nthree\nsecret\nfive\n");
  // Let every line arrive before the first question is asked.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await io.ask("A?"), "one");
  assert.equal(await io.ask("B?", "dflt"), "dflt");
  assert.equal(await io.ask("C?"), "three");
  assert.equal(await io.askSecret("S: "), "secret");
  assert.equal(await io.ask("E?"), "five");
  assert.ok(shown.join("").includes("A?"), "the questions are still shown");
  assert.ok(!shown.join("").includes("secret"), "the secret is not echoed");
  await assert.rejects(io.ask("F?"), /input ended/);
  io.close();
});

// The status note, the log and held.json, written by a run (spec §5.1-5.4).

const TOKEN = "secret-token-xyz";

/** A vault, a profile file, a state folder (through XDG_STATE_HOME) and a fake Notion; the environment is put back after the test. */
async function cliSetup(t: import("node:test").TestContext, extra: Record<string, unknown> = {}) {
  const dir = await tempDir(t);
  const vault = join(dir, "DemoVault");
  await mkdir(vault);
  const profile = join(dir, "config.json");
  await writeFile(profile, JSON.stringify({ vaultPath: vault, dataSourceId: "a50245e9-8e6a-41aa-8ccf-d8795ed0dead", linksToProperty: null, ...extra }));
  const saved = { token: process.env.NOTION_TOKEN, state: process.env.XDG_STATE_HOME };
  process.env.NOTION_TOKEN = TOKEN;
  process.env.XDG_STATE_HOME = join(dir, "state");
  t.after(() => {
    if (saved.token === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = saved.token;
    if (saved.state === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved.state;
  });
  const stateDir = join(process.env.XDG_STATE_HOME, "nopipeline", "config");
  const notion = new FakeNotion();
  const calls: { notify: Array<[string, string | undefined]>; waits: Array<number | undefined>; open: string[] } = { notify: [], waits: [], open: [] };
  let clicked: "clicked" | "closed" | "missing" | "failed" = "closed";
  const desktop: Desktop = {
    notify: async (text, button, options) => (calls.notify.push([text, button]), calls.waits.push(options?.waitMs), clicked),
    open: async (url) => (calls.open.push(url), true),
  };
  // Obsidian is never running in these tests, whatever runs on the machine.
  const obsidian: ObsidianProbe = { running: async () => false, openTabs: async () => null, modifiedAt: async () => null };
  const deps: MainDeps = { gateway: () => notion as NotionGateway, desktop, obsidian, now: () => new Date("2026-11-05T10:00:00Z"), interactive: false };
  const run = (...args: string[]) => {
    const out: string[] = [];
    return main(["sync", "--config", profile, ...args], (line) => out.push(line), deps).then((code) => ({ code, out }));
  };
  return { vault, profile, stateDir, notion, calls, deps, run, click: (v: typeof clicked) => void (clicked = v) };
}

test("a sync writes the status note and the log", async (t) => {
  const { vault, stateDir, run } = await cliSetup(t);
  await writeTree(vault, { "A.md": "Hello\n" });
  const { code } = await run("--yes");
  assert.equal(code, 0);
  const note = await readFile(join(vault, "nopipeline status.md"), "utf8");
  assert.ok(note.startsWith(`---\n${STATUS_MARKER}\n---`));
  const log = await readFile(join(stateDir, "last-run.log"), "utf8");
  assert.match(log, /1 × Notion page created/);
  assert.ok(!note.includes(TOKEN) && !log.includes(TOKEN));
});

async function holdTwelve(t: import("node:test").TestContext) {
  const s = await cliSetup(t);
  const files: Record<string, string> = {};
  for (let i = 1; i <= 12; i++) files[`N${i}.md`] = `Note ${i}\n`;
  await writeTree(s.vault, files);
  assert.equal((await s.run("--yes")).code, 0);
  const saved = new Map<string, string>();
  for (const name of Object.keys(files)) {
    saved.set(name, await readFile(join(s.vault, name), "utf8"));
    await rm(join(s.vault, name));
  }
  return { ...s, saved };
}

test("a held run writes held.json; a clean one removes it", async (t) => {
  const { vault, stateDir, run, saved } = await holdTwelve(t);
  const held = await run();
  assert.equal(held.code, 1);
  const json = JSON.parse(await readFile(join(stateDir, "held.json"), "utf8"));
  assert.equal(json.notes.length, 12);
  assert.equal(json.firstRun, false);
  assert.match(await readFile(join(vault, "nopipeline status.md"), "utf8"), /Stopped — 12 notes would be trashed/);
  for (const [name, text] of saved) await writeFile(join(vault, name), text);
  assert.equal((await run()).code, 0);
  await assert.rejects(readFile(join(stateDir, "held.json")), { code: "ENOENT" });
});

test("an ended real run writes last-sync.json; a dry run, a first-run stop and a failure don't", async (t) => {
  const { vault, stateDir, notion, run } = await cliSetup(t);
  const file = join(stateDir, "last-sync.json");
  await writeTree(vault, { "A.md": "Hello\n" });
  await run("--dry-run");
  await assert.rejects(readFile(file), { code: "ENOENT" });
  // No records yet and no --yes: the first-run preview stops.
  await run();
  await assert.rejects(readFile(file), { code: "ENOENT" });
  const real = notion.listPages.bind(notion);
  notion.listPages = async () => {
    throw new Error("boom");
  };
  await assert.rejects(run("--yes"), /boom/);
  await assert.rejects(readFile(file), { code: "ENOENT" });
  notion.listPages = real;
  assert.equal((await run("--yes")).code, 0);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { endedAt: "2026-11-05T10:00:00.000Z" });
});

test("a run that held trashes still records its end", async (t) => {
  const { stateDir, run } = await holdTwelve(t);
  await rm(join(stateDir, "last-sync.json"), { force: true });
  assert.equal((await run()).code, 1);
  assert.ok(JSON.parse(await readFile(join(stateDir, "last-sync.json"), "utf8")).endedAt);
});

test("a dry run leaves held.json alone", async (t) => {
  const { vault, stateDir, run } = await holdTwelve(t);
  await run();
  const before = await readFile(join(stateDir, "held.json"));
  await run("--dry-run");
  assert.deepEqual(await readFile(join(stateDir, "held.json")), before);
  assert.match(await readFile(join(vault, "nopipeline status.md"), "utf8"), /Preview —/);
});

test("a user's note at the status path is not overwritten", async (t) => {
  const { vault, run } = await cliSetup(t);
  await writeTree(vault, { "nopipeline status.md": "My own note\n", "A.md": "Hello\n" });
  const { out } = await run("--yes");
  assert.equal(await readFile(join(vault, "nopipeline status.md"), "utf8"), "My own note\n");
  assert.match(out.join("\n"), /status note not written: nopipeline status\.md is one of your notes; set statusNote in the profile/);
});

test("a failure after the profile loads writes Failed and leaves held.json", async (t) => {
  const { vault, stateDir, notion, run } = await holdTwelve(t);
  await run();
  const before = await readFile(join(stateDir, "held.json"));
  notion.listPages = async () => {
    throw new Error("boom");
  };
  await assert.rejects(run(), /boom/);
  assert.match(await readFile(join(vault, "nopipeline status.md"), "utf8"), /Failed — boom\./);
  assert.deepEqual(await readFile(join(stateDir, "held.json")), before);
  assert.match(await readFile(join(stateDir, "last-run.log"), "utf8"), /boom/);
});

test("a failure before the lock (no token) writes Failed outside the lock and never the token", async (t) => {
  const { vault, stateDir, run } = await cliSetup(t);
  delete process.env.NOTION_TOKEN;
  await assert.rejects(run(), /no Notion token/);
  assert.match(await readFile(join(vault, "nopipeline status.md"), "utf8"), /Failed — no Notion token/);
  assert.match(await readFile(join(stateDir, "last-run.log"), "utf8"), /no Notion token/);
});

test("a statusNote of null writes no note, but still the log", async (t) => {
  const { vault, stateDir, run } = await cliSetup(t, { statusNote: null });
  await writeTree(vault, { "A.md": "Hello\n" });
  await run("--yes");
  await assert.rejects(readFile(join(vault, "nopipeline status.md")), { code: "ENOENT" });
  await readFile(join(stateDir, "last-run.log"), "utf8");
});

test("with the status note off, an old marked note is not synced to Notion", async (t) => {
  const { vault, notion, run } = await cliSetup(t, { statusNote: null });
  await writeTree(vault, { "A.md": "Hello\n", "nopipeline status.md": "---\nnopipeline: status\n---\n# nopipeline status\n", "Meta/old.md": "---\nnopipeline: status\n---\nold\n" });
  assert.equal((await run("--yes")).code, 0);
  assert.equal(notion.pages.size, 1);
  assert.deepEqual([...notion.pages.values()].map((p) => p.title), ["A"]);
});

test("--notify sends one notification and opens the report on click", async (t) => {
  const { vault, calls, run, click } = await cliSetup(t);
  await writeTree(vault, { "A.md": "Hello\n" });
  assert.equal((await run("--yes")).code, 0);
  assert.equal(calls.notify.length, 0, "no notification without --notify");
  click("clicked");
  // A dry run is a preview, which carries the button.
  await run("--dry-run", "--notify");
  assert.equal(calls.notify.length, 1);
  assert.equal(calls.notify[0]![1], "Open report");
  assert.deepEqual(calls.open, [`obsidian://open?path=${encodeURIComponent(join(vault, "nopipeline status.md"))}`]);
});

test("--notify without a button for a quiet sync, and a missing notify-send is noted in the log", async (t) => {
  const { vault, stateDir, calls, run, click } = await cliSetup(t);
  await writeTree(vault, { "A.md": "Hello\n" });
  await run("--yes");
  click("missing");
  const { code } = await run("--notify");
  assert.equal(code, 0);
  assert.deepEqual(calls.notify, [["Everything was already in sync", undefined]]);
  assert.match(await readFile(join(stateDir, "last-run.log"), "utf8"), /warning: couldn't show a notification \(notify-send not found\)$/);
});

test("--notify turns a failure into a notification and exit 2", async (t) => {
  const { notion, calls, run } = await cliSetup(t);
  notion.listPages = async () => {
    throw new Error("boom");
  };
  assert.equal((await run("--notify")).code, 2);
  assert.deepEqual(calls.notify, [["Sync failed: boom", "Open report"]]);
});

test("a sync that finds the lock taken notifies busy and writes nothing", async (t) => {
  const { vault, stateDir, calls, run } = await cliSetup(t);
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "lock"), String(process.pid));
  assert.equal((await run("--notify")).code, 2);
  assert.deepEqual(calls.notify, [["A sync is already running", undefined]]);
  await assert.rejects(readFile(join(vault, "nopipeline status.md")), { code: "ENOENT" });
  await assert.rejects(readFile(join(stateDir, "last-run.log")), { code: "ENOENT" });
  // Without --notify it is an error, as before.
  await assert.rejects(run(), /another sync is running/);
});

test("a failing sync without --notify sends nothing extra to out; the failure line is in the log only", async (t) => {
  const { profile, stateDir, notion } = await cliSetup(t);
  notion.listPages = async () => {
    throw new Error("boom");
  };
  const out: string[] = [];
  await assert.rejects(main(["sync", "--config", profile], (line) => out.push(line), { gateway: () => notion as NotionGateway, desktop: { notify: async () => "closed", open: async () => true }, obsidian: { running: async () => false, openTabs: async () => null, modifiedAt: async () => null } }), /boom/);
  assert.ok(!out.some((line) => line.startsWith("nopipeline:")));
  assert.match(await readFile(join(stateDir, "last-run.log"), "utf8"), /nopipeline: boom/);
});

test("--notify prints a failure to stderr exactly once", async (t) => {
  const { notion, run } = await cliSetup(t);
  notion.listPages = async () => {
    throw new Error("boom");
  };
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    const { code, out } = await run("--notify");
    assert.equal(code, 2);
    assert.ok(!out.some((line) => line.includes("boom")));
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
});

test("a state folder of another vault gets no log, but this vault gets the Failed note", async (t) => {
  const { vault, stateDir, run } = await cliSetup(t);
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "profile.json"), JSON.stringify({ vaultPath: "/somewhere/else", dataSourceId: "ffffffff-ffff-ffff-ffff-ffffffffffff" }));
  await writeFile(join(stateDir, "last-run.log"), "the other profile's log");
  await assert.rejects(run(), /belongs to the vault/);
  assert.equal(await readFile(join(stateDir, "last-run.log"), "utf8"), "the other profile's log");
  assert.match(await readFile(join(vault, "nopipeline status.md"), "utf8"), /Failed — the state folder/);
  await assert.rejects(readFile(join(stateDir, "held.json")), { code: "ENOENT" });
});

test("--notify with a profile that can't load notifies the error without a button and exits 2", async (t) => {
  const { profile, calls, deps } = await cliSetup(t);
  await writeFile(profile, "{ not json");
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    assert.equal(await main(["sync", "--config", profile, "--notify"], () => {}, deps), 2);
  } finally {
    console.error = original;
  }
  assert.equal(calls.notify.length, 1);
  assert.match(calls.notify[0]![0], /^Sync failed: can't read the config file/);
  assert.equal(calls.notify[0]![1], undefined);
  assert.equal(errors.length, 1);
  await assert.rejects(main(["sync", "--config", profile], () => {}, deps), /can't read the config file/);
});

// `nopipeline confirm` (spec §5.3).

async function confirmSetup(t: import("node:test").TestContext, hold: boolean) {
  const s = hold ? await holdTwelve(t) : await cliSetup(t);
  if (hold) assert.equal((await s.run()).code, 1);
  const desktop: Desktop = {
    notify: async (text, button) => (s.calls.notify.push([text, button]), "closed"),
    open: async () => true,
  };
  const io = { ask: async () => assert.fail("confirm asks nothing"), askSecret: async () => assert.fail("confirm asks nothing"), out: () => {} };
  const confirm = (interactive = false) => {
    const out: string[] = [];
    return main(["confirm", "--config", s.profile], (line) => out.push(line), { ...s.deps, desktop, io, interactive }).then((code) => ({ code, out }));
  };
  return { ...s, confirm };
}

test("confirm with nothing held says so, and notifies when not on a terminal", async (t) => {
  const { calls, confirm } = await confirmSetup(t, false);
  const terminal = await confirm(true);
  assert.equal(terminal.code, 0);
  assert.deepEqual(terminal.out, ["Nothing is waiting for confirmation."]);
  assert.equal(calls.notify.length, 0);
  const launched = await confirm(false);
  assert.equal(launched.code, 0);
  assert.deepEqual(calls.notify, [["Nothing is waiting for confirmation.", undefined]]);
});

const trashedCount = (notion: FakeNotion) => [...notion.pages.values()].filter((p) => p.inTrash).length;

test("confirm trashes exactly the held notes, without asking anything", async (t) => {
  const { notion, stateDir, confirm } = await confirmSetup(t, true);
  assert.equal((await confirm()).code, 0);
  assert.equal(trashedCount(notion), 12);
  await assert.rejects(readFile(join(stateDir, "held.json")), { code: "ENOENT" });
});

test("a new trash holds again and the notification says the list changed", async (t) => {
  const { vault, notion, stateDir, calls, confirm, run } = await confirmSetup(t, true);
  // A 13th note is synced and then deleted, after the run whose list is on file.
  await writeTree(vault, { "Extra.md": "Extra\n" });
  assert.equal((await run("--yes")).code, 1);
  const held = await readFile(join(stateDir, "held.json"));
  assert.equal(JSON.parse(String(held)).notes.length, 12);
  await rm(join(vault, "Extra.md"));
  assert.equal((await confirm()).code, 1);
  assert.equal(trashedCount(notion), 0);
  assert.equal(JSON.parse(await readFile(join(stateDir, "held.json"), "utf8")).notes.length, 13);
  assert.match(calls.notify.at(-1)![0], /list of trashes changed/);
});

test("confirm on a first run applies it", async (t) => {
  const s = await confirmSetup(t, false);
  await writeTree(s.vault, { "A.md": "Hello\n" });
  assert.equal((await s.run()).code, 1);
  assert.equal(JSON.parse(await readFile(join(s.stateDir, "held.json"), "utf8")).firstRun, true);
  assert.equal((await s.confirm()).code, 0);
  assert.equal(s.notion.pages.size, 1);
  await assert.rejects(readFile(join(s.stateDir, "held.json")), { code: "ENOENT" });
});

test("launcher install writes the entry and prints its path; launcher alone prints the usage and exits 2", async (t) => {
  const dir = await tempDir(t);
  const saved = { data: process.env.XDG_DATA_HOME, config: process.env.XDG_CONFIG_HOME };
  process.env.XDG_DATA_HOME = join(dir, "data");
  process.env.XDG_CONFIG_HOME = join(dir, "cfg");
  t.after(() => {
    for (const [key, value] of [["XDG_DATA_HOME", saved.data], ["XDG_CONFIG_HOME", saved.config]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const out: string[] = [];
  const p = join(dir, "second.json");
  assert.equal(await main(["launcher", "install", "--config", p], (line) => out.push(line)), 0);
  const file = join(dir, "data", "applications", "nopipeline-second.desktop");
  assert.ok(out.join("\n").includes(file));
  assert.match(await readFile(file, "utf8"), /X-nopipeline=1/);
  const again: string[] = [];
  assert.equal(await main(["launcher", "uninstall", "--config", p], (line) => again.push(line)), 0);
  const usage: string[] = [];
  assert.equal(await main(["launcher"], (line) => usage.push(line)), 2);
  assert.match(usage.join("\n"), /nopipeline launcher install/);
});

// `nopipeline sync --auto` (spec §3 G1, §4.2, §4.3, §4.6).

const DUE = { hasRecords: async () => true, lastSync: async () => null, obsidianRunning: async () => false, tabsReadable: async () => false, notionReachable: async () => true };

async function autoSetup(t: import("node:test").TestContext, due: Partial<typeof DUE> = {}) {
  const s = await cliSetup(t);
  const auto = (...args: string[]) => {
    const out: string[] = [];
    return main(["sync", "--auto", "--config", s.profile, ...args], (line) => out.push(line), { ...s.deps, due: { ...DUE, ...due } }).then((code) => ({ code, out }));
  };
  const readIf = (file: string) => readFile(file, "utf8").catch(() => null);
  return { ...s, auto, readIf };
}

test("--auto refuses --yes, --dry-run and --allow-mass-trash with the usage, and loads nothing", async (t) => {
  const { profile, deps } = await autoSetup(t);
  await writeFile(profile, "{ not json");
  for (const flag of ["--yes", "--dry-run", "--allow-mass-trash"]) {
    const out: string[] = [];
    assert.equal(await main(["sync", "--auto", "--config", profile, flag], (line) => out.push(line), deps), 2);
    assert.match(out.join("\n"), /Usage: nopipeline sync/);
  }
});

test("--auto that is not due logs the skip and changes nothing else", async (t) => {
  const { vault, stateDir, calls, auto, readIf } = await autoSetup(t, { hasRecords: async () => false });
  const { code, out } = await auto();
  assert.equal(code, 0);
  assert.deepEqual(out, []);
  assert.match((await readIf(join(stateDir, "auto.log")))!, /^2026-11-05T10:00:00\.000Z skipped: never-synced\n$/);
  assert.equal(calls.notify.length, 0);
  await assert.rejects(readFile(join(vault, "nopipeline status.md")), { code: "ENOENT" });
  assert.equal(await readIf(join(stateDir, "last-run.log")), null);
});

test("--auto clean run: no notification, last-sync.json written, exit 0", async (t) => {
  const { vault, stateDir, calls, run, auto, readIf } = await autoSetup(t);
  await writeTree(vault, { "A.md": "Hello\n" });
  assert.equal((await run("--yes")).code, 0);
  await rm(join(stateDir, "last-sync.json"));
  assert.equal((await auto()).code, 0);
  assert.equal(calls.notify.length, 0);
  assert.deepEqual(JSON.parse((await readIf(join(stateDir, "last-sync.json")))!), { endedAt: "2026-11-05T10:00:00.000Z" });
});

/** An Obsidian that runs with `path` open in a tab. */
const withOpenTab = (path: string): ObsidianProbe => ({ running: async () => true, openTabs: async () => new Set([path]), modifiedAt: async () => null });

test("--auto with only waiting notes writes no last-sync.json, notifies nothing and exits 0; a manual run prints the hint", async (t) => {
  const { vault, stateDir, calls, deps, run, auto, readIf } = await autoSetup(t);
  await writeTree(vault, { "A.md": "Hello\n", "B.md": "Other\n" });
  assert.equal((await run("--yes")).code, 0);
  await rm(join(stateDir, "last-sync.json"));
  await writeFile(join(vault, "A.md"), "Hello again\n");
  deps.obsidian = withOpenTab("A.md");
  const { code, out } = await auto();
  assert.equal(code, 0);
  assert.equal(calls.notify.length, 0);
  assert.equal(await readIf(join(stateDir, "last-sync.json")), null);
  assert.ok(!out.join("\n").includes("waited because"), "no hint for the timer");
  const manual = await run();
  assert.equal(manual.code, 0);
  assert.match(manual.out.join("\n"), /Waiting \(open in Obsidian or edited in the last 5 minutes; they sync on a later run\):\n {2}A\.md/);
  assert.equal(manual.out.at(-1), "1 note waited because it is open in Obsidian or was edited in the last few minutes; close it and run again to sync it.");
  assert.equal(await readIf(join(stateDir, "last-sync.json")), null);
  deps.obsidian = { running: async () => false, openTabs: async () => null, modifiedAt: async () => null };
  assert.equal((await auto()).code, 0);
  assert.ok(await readIf(join(stateDir, "last-sync.json")), "nothing waiting: the clock is stamped");
});

test("--auto with a skipped note notifies once with the button, not again when unchanged", async (t) => {
  const { vault, notion, calls, run, auto } = await autoSetup(t);
  await writeTree(vault, { "A.md": "Hello\n" });
  assert.equal((await run("--yes")).code, 0);
  // A page too large to read completely is skipped and left for a look.
  notion.edit([...notion.pages.keys()][0]!, { truncated: true, markdown: "partial" });
  const first = await auto();
  assert.equal(first.code, 0);
  assert.equal(calls.notify.length, 1);
  assert.match(calls.notify[0]![0], /needs? a look/);
  assert.equal(calls.notify[0]![1], "Open report");
  assert.deepEqual(calls.waits, [600_000], "an automatic popup never waits without a limit");
  assert.equal((await auto()).code, 0);
  assert.equal(calls.notify.length, 1);
});

for (const bad of ["missing", "failed"] as const) {
  test(`--auto with a notification that is ${bad} is not remembered: the next run notifies again, and auto.log says so`, async (t) => {
    const { vault, stateDir, notion, calls, run, auto, click, readIf } = await autoSetup(t);
    await writeTree(vault, { "A.md": "Hello\n" });
    assert.equal((await run("--yes")).code, 0);
    notion.edit([...notion.pages.keys()][0]!, { truncated: true, markdown: "partial" });
    click(bad);
    assert.equal((await auto()).code, 0);
    assert.match((await readIf(join(stateDir, "auto.log")))!, /notification not shown/);
    click("closed");
    assert.equal((await auto()).code, 0);
    assert.equal(calls.notify.length, 2);
    assert.equal((await auto()).code, 0);
    assert.equal(calls.notify.length, 2, "once shown, it is remembered");
  });
}

test("--auto with 12 held trashes notifies Stopped once, exits 0 and writes held.json", async (t) => {
  const s = await holdTwelve(t);
  const out: string[] = [];
  const go = () => main(["sync", "--auto", "--config", s.profile], (line) => out.push(line), { ...s.deps, due: DUE });
  assert.equal(await go(), 0);
  assert.equal(s.calls.notify.length, 1);
  assert.match(s.calls.notify[0]![0], /^Stopped: 12 notes would be trashed/);
  assert.equal(JSON.parse(await readFile(join(s.stateDir, "held.json"), "utf8")).notes.length, 12);
  assert.equal(await go(), 0);
  assert.equal(s.calls.notify.length, 1);
});

test("--auto failure notifies once over two runs, exits 2 both times, keeps last-sync.json", async (t) => {
  const { vault, stateDir, notion, calls, run, auto, readIf } = await autoSetup(t);
  await writeTree(vault, { "A.md": "Hello\n" });
  assert.equal((await run("--yes")).code, 0);
  const before = await readIf(join(stateDir, "last-sync.json"));
  notion.listPages = async () => {
    throw new Error("boom");
  };
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await auto()).code, 2);
    assert.equal((await auto()).code, 2);
  } finally {
    console.error = original;
  }
  assert.deepEqual(calls.notify, [["Sync failed: boom", "Open report"]]);
  assert.equal(await readIf(join(stateDir, "last-sync.json")), before);
});

test("--auto with the lock taken logs busy, exits 0 and notifies nothing", async (t) => {
  const { stateDir, calls, auto, readIf } = await autoSetup(t);
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "lock"), String(process.pid));
  assert.equal((await auto()).code, 0);
  assert.equal(calls.notify.length, 0);
  assert.match((await readIf(join(stateDir, "auto.log")))!, /skipped: busy\n$/);
});

test("--auto with a profile that can't load notifies once and exits 2 each time", async (t) => {
  const { profile, calls, auto } = await autoSetup(t);
  await writeFile(profile, "{ not json");
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await auto()).code, 2);
    assert.equal((await auto()).code, 2);
  } finally {
    console.error = original;
  }
  assert.equal(calls.notify.length, 1);
  assert.match(calls.notify[0]![0], /^Sync failed: can't read the config file/);
  assert.equal(calls.notify[0]![1], undefined);
});

test("--auto never writes the token to auto.log, the log or a notification", async (t) => {
  const { vault, stateDir, notion, calls, run, auto, readIf } = await autoSetup(t);
  await writeTree(vault, { "A.md": "Hello\n" });
  await run("--yes");
  notion.listPages = async () => {
    throw new Error("boom");
  };
  const original = console.error;
  console.error = () => {};
  try {
    await auto();
  } finally {
    console.error = original;
  }
  for (const text of [await readIf(join(stateDir, "auto.log")), await readIf(join(stateDir, "last-run.log")), ...calls.notify.map((n) => n[0])]) assert.ok(text === null || !text.includes(TOKEN));
});


test("--auto config error: notify, fixed and run, the same error again notifies again", async (t) => {
  const { profile, calls, auto, readIf } = await autoSetup(t);
  const good = (await readIf(profile))!;
  const original = console.error;
  console.error = () => {};
  try {
    await writeFile(profile, "{ not json");
    assert.equal((await auto()).code, 2);
    assert.equal((await auto()).code, 2);
    assert.equal(calls.notify.length, 1);
    await writeFile(profile, good);
    assert.equal((await auto()).code, 0);
    await writeFile(profile, "{ not json");
    assert.equal((await auto()).code, 2);
    assert.equal(calls.notify.length, 2);
  } finally {
    console.error = original;
  }
});

test("auto install prints the unit paths; auto alone prints the usage and exits 2", async (t) => {
  const dir = await tempDir(t);
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(dir, "cfg");
  t.after(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  });
  const calls: string[][] = [];
  const systemctl = async (args: string[]) => {
    calls.push(args);
    return { code: 0, stderr: "" };
  };
  const p = join(dir, "second.json");
  const out: string[] = [];
  assert.equal(await main(["auto", "install", "--config", p], (line) => out.push(line), { systemctl }), 0);
  const unit = join(dir, "cfg", "systemd", "user", "nopipeline-auto-second.timer");
  assert.ok(out.join("\n").includes(unit));
  assert.match(out.join("\n"), /list-timers/);
  assert.ok(out.join("\n").includes(join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "nopipeline", "second", "auto.log")));
  assert.match(out.join("\n"), /due right away/);
  assert.match(await readFile(unit, "utf8"), /X-nopipeline/);
  const again: string[] = [];
  assert.equal(await main(["auto", "uninstall", "--config", p], (line) => again.push(line), { systemctl }), 0);
  assert.match(again.join("\n"), /removed/i);
  const failing: string[] = [];
  assert.equal(await main(["auto", "install", "--config", p], (line) => failing.push(line), { systemctl: async () => ({ code: 1, stderr: "no user bus" }) }), 2);
  assert.match(failing.join("\n"), /no user bus/);
  const usage: string[] = [];
  assert.equal(await main(["auto"], (line) => usage.push(line)), 2);
  assert.match(usage.join("\n"), /nopipeline auto install/);
});
