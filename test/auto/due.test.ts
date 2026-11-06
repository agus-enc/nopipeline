import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasRecords, logSkip, notionReachableWith, obsidianRunningWith, whyNotDue, type DueDeps } from "../../src/auto/due.ts";
import type { Exec } from "../../src/desktop.ts";
import { tempDir } from "../helpers/tmp.ts";

const NOW = new Date("2026-11-06T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const deps = (over: Partial<DueDeps> = {}): Partial<DueDeps> => ({
  now: () => NOW,
  hasRecords: async () => true,
  lastSync: async () => hoursAgo(7),
  obsidianRunning: async () => false,
  tabsReadable: async () => false,
  notionReachable: async () => true,
  ...over,
});

test("no records is never-synced, even with Obsidian open", async () => {
  assert.equal(await whyNotDue("/s", 6, deps({ hasRecords: async () => false, obsidianRunning: async () => true })), "never-synced");
});

test("a last sync inside the interval is not-due; the boundary is due", async () => {
  assert.equal(await whyNotDue("/s", 6, deps({ lastSync: async () => hoursAgo(5) })), "not-due");
  assert.equal(await whyNotDue("/s", 6, deps({ lastSync: async () => hoursAgo(6) })), null);
  assert.equal(await whyNotDue("/s", 0.5, deps({ lastSync: async () => hoursAgo(0.4) })), "not-due");
  assert.equal(await whyNotDue("/s", 0.5, deps({ lastSync: async () => hoursAgo(0.5) })), null);
});

test("Obsidian open, then offline, in that order; all fine is due", async () => {
  assert.equal(await whyNotDue("/s", 6, deps({ obsidianRunning: async () => true, notionReachable: async () => false })), "obsidian-open");
  assert.equal(await whyNotDue("/s", 6, deps({ notionReachable: async () => false })), "offline");
  assert.equal(await whyNotDue("/s", 6, deps()), null);
});

test("Obsidian open with readable tabs is due; with unreadable tabs it is obsidian-open", async () => {
  assert.equal(await whyNotDue("/s", 6, deps({ obsidianRunning: async () => true, tabsReadable: async () => true })), null);
  assert.equal(await whyNotDue("/s", 6, deps({ obsidianRunning: async () => true, tabsReadable: async () => false })), "obsidian-open");
  assert.equal(await whyNotDue("/s", 6, deps({ obsidianRunning: async () => false, tabsReadable: async () => { throw new Error("not asked"); } })), null);
});

test("records but no last-sync file is due", async () => {
  assert.equal(await whyNotDue("/s", 6, deps({ lastSync: async () => null })), null);
});

test("the cheap checks run first: nothing later is asked once one skips", async () => {
  const never = async () => assert.fail("must not be asked");
  assert.equal(await whyNotDue("/s", 6, deps({ lastSync: async () => hoursAgo(1), obsidianRunning: never, notionReachable: never })), "not-due");
  assert.equal(await whyNotDue("/s", 6, deps({ obsidianRunning: async () => true, notionReachable: never })), "obsidian-open");
});

test("the Obsidian check: flatpak lists the app, or pgrep finds it, or neither", async () => {
  const calls: string[] = [];
  const exec = (flatpak: { code: number; stdout: string } | null, pgrep: { code: number; stdout: string } | null): Exec => async (file, args) => {
    calls.push([file, ...args].join(" "));
    return file === "flatpak" ? flatpak : pgrep;
  };
  assert.equal(await obsidianRunningWith(exec({ code: 0, stdout: "org.other.App\nmd.obsidian.Obsidian\n" }, null))(), true);
  assert.deepEqual(calls, ["flatpak ps --columns=application"]);
  assert.equal(await obsidianRunningWith(exec(null, { code: 0, stdout: "123\n" }))(), true);
  assert.equal(await obsidianRunningWith(exec({ code: 0, stdout: "org.other.App\n" }, { code: 0, stdout: "123\n" }))(), true);
  assert.equal(await obsidianRunningWith(exec({ code: 0, stdout: "org.other.App\n" }, { code: 1, stdout: "" }))(), false);
  assert.equal(await obsidianRunningWith(exec(null, null))(), false);
  assert.ok(calls.includes("pgrep -x obsidian"));
});

/** A socket stand-in: emits what the test says, and records destroy. */
function fakeSocket(behavior: "connect" | "error" | "silent") {
  const socket = new EventEmitter() as EventEmitter & { destroy: () => void; destroyed: boolean };
  socket.destroyed = false;
  socket.destroy = () => void (socket.destroyed = true);
  if (behavior !== "silent") setImmediate(() => (behavior === "connect" ? socket.emit("connect") : socket.emit("error", new Error("ENOTFOUND"))));
  return socket;
}

test("reachability: connect → true; error → false; no answer within the time → false", async () => {
  const asked: Array<[number, string]> = [];
  const via = (behavior: "connect" | "error" | "silent") => notionReachableWith((port, host) => (asked.push([port, host]), fakeSocket(behavior) as never), behavior === "silent" ? 20 : 5000);
  assert.equal(await via("connect")(), true);
  assert.deepEqual(asked[0], [443, "api.notion.com"]);
  assert.equal(await via("error")(), false);
  assert.equal(await via("silent")(), false);
});

test("hasRecords: a .json file in records/ counts; a missing folder is false and not created", async (t) => {
  const dir = await tempDir(t);
  const state = join(dir, "state");
  assert.equal(await hasRecords(state), false);
  await assert.rejects(stat(state), { code: "ENOENT" });
  await mkdir(join(state, "records"), { recursive: true });
  assert.equal(await hasRecords(state), false);
  await writeFile(join(state, "records", "x.tmp"), "");
  assert.equal(await hasRecords(state), false);
  await writeFile(join(state, "records", "x.json"), "{}");
  assert.equal(await hasRecords(state), true);
});

test("logSkip appends a line and keeps the last 200", async (t) => {
  const state = join(await tempDir(t), "state");
  await logSkip(state, "offline", new Date("2026-11-06T12:00:00Z"));
  assert.equal(await readFile(join(state, "auto.log"), "utf8"), "2026-11-06T12:00:00.000Z skipped: offline\n");
  for (let i = 0; i < 204; i++) await logSkip(state, "not-due", new Date(Date.UTC(2026, 10, 6, 12, 0, i + 1)));
  const lines = (await readFile(join(state, "auto.log"), "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 200);
  assert.equal(lines.at(-1), "2026-11-06T12:03:24.000Z skipped: not-due");
  assert.equal(lines[0], "2026-11-06T12:00:05.000Z skipped: not-due");
});
