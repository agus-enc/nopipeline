import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { notesInUse, readOpenTabs, RECENT_EDIT_MS, type ObsidianProbe } from "../../src/vault/inuse.ts";
import type { SyncRecord, VaultNote } from "../../src/types.ts";
import { tempDir } from "../helpers/tmp.ts";

async function writeWorkspace(root: string, name: string, content: unknown): Promise<void> {
  await mkdir(join(root, ".obsidian"), { recursive: true });
  await writeFile(join(root, ".obsidian", name), typeof content === "string" ? content : JSON.stringify(content), "utf8");
}

const leaf = (file: unknown) => ({ state: { type: "markdown", state: { file } } });

test("readOpenTabs collects files of leaves under main, left and right, not history", async (t) => {
  const root = await tempDir(t);
  await writeWorkspace(root, "workspace.json", {
    main: { children: [{ children: [leaf("A/One.md")] }] },
    left: { children: [leaf("Two.md")] },
    right: {},
    lastOpenFiles: ["Old.md"],
  });
  assert.deepEqual(await readOpenTabs(root), new Set(["A/One.md", "Two.md"]));
});

test("readOpenTabs returns null when the tab list cannot be read", async (t) => {
  const missing = await tempDir(t);
  assert.equal(await readOpenTabs(missing), null);
  for (const content of ["not json", {}, { main: 3 }]) {
    const root = await tempDir(t);
    await writeWorkspace(root, "workspace.json", content);
    assert.equal(await readOpenTabs(root), null);
  }
});

test("readOpenTabs ignores non-string files", async (t) => {
  const root = await tempDir(t);
  await writeWorkspace(root, "workspace.json", { main: { state: { state: { file: 7 } } } });
  assert.deepEqual(await readOpenTabs(root), new Set());
});

test("readOpenTabs ignores the mobile and sync-conflict workspace files", async (t) => {
  const root = await tempDir(t);
  const content = { main: { children: [leaf("A.md")] } };
  await writeWorkspace(root, "workspace-mobile.json", content);
  await writeWorkspace(root, "workspace.sync-conflict-x.json", content);
  assert.equal(await readOpenTabs(root), null);
});

const NOW = new Date("2026-11-06T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

function note(path: string, text: string, notionId: string | null = null): VaultNote {
  return { path, text, body: text, notionId, notionTitle: null };
}

function record(notionId: string, path: string, obsidianText: string): SyncRecord {
  return { notionId, path, title: "t", folder: null, obsidianText, notionMarkdown: "", notionSeenAt: "", syncedAt: "" };
}

function probe(opts: { running?: boolean; tabs?: string[] | null; mtimes?: Record<string, Date | null> }): ObsidianProbe & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    running: async () => opts.running ?? true,
    openTabs: async () => {
      calls.push("openTabs");
      return opts.tabs === null || opts.tabs === undefined ? null : new Set(opts.tabs);
    },
    modifiedAt: async (_vault, path) => {
      calls.push("modifiedAt");
      return opts.mtimes?.[path] ?? null;
    },
  };
}

test("RECENT_EDIT_MS is five minutes", () => {
  assert.equal(RECENT_EDIT_MS, 300_000);
});

test("notesInUse is empty and never probes files when Obsidian is not running", async () => {
  const p = probe({ running: false, tabs: ["A.md"] });
  const result = await notesInUse({ vaultPath: "/v", notes: [note("A.md", "x")], records: new Map(), probe: p, now: NOW });
  assert.deepEqual(result, { paths: new Set(), tabsUnreadable: false });
  assert.deepEqual(p.calls, []);
});

test("a note open in a tab is in use even when old and unchanged", async () => {
  const records = new Map([["id1", record("id1", "A/One.md", "same")]]);
  const p = probe({ tabs: ["A/One.md"], mtimes: { "A/One.md": ago(600) } });
  const result = await notesInUse({ vaultPath: "/v", notes: [note("A/One.md", "same", "id1")], records, probe: p, now: NOW });
  assert.deepEqual(result, { paths: new Set(["A/One.md"]), tabsUnreadable: false });
});

test("a recent edit that differs from the record is in use; old or unchanged is not", async () => {
  const records = new Map([
    ["id1", record("id1", "Recent.md", "old")],
    ["id2", record("id2", "Old.md", "old")],
    ["id3", record("id3", "Same.md", "same")],
  ]);
  const p = probe({ tabs: [], mtimes: { "Recent.md": ago(4), "Old.md": ago(6), "Same.md": ago(1), "New.md": ago(1) } });
  const notes = [
    note("Recent.md", "edited", "id1"),
    note("Old.md", "edited", "id2"),
    note("Same.md", "same", "id3"),
    note("New.md", "fresh"),
  ];
  const result = await notesInUse({ vaultPath: "/v", notes, records, probe: p, now: NOW });
  assert.deepEqual(result.paths, new Set(["Recent.md", "New.md"]));
});

test("a note without an id uses the record at its path", async () => {
  const records = new Map([["id1", record("id1", "Same.md", "same")]]);
  const p = probe({ tabs: [], mtimes: { "Same.md": ago(1) } });
  const result = await notesInUse({ vaultPath: "/v", notes: [note("Same.md", "same")], records, probe: p, now: NOW });
  assert.deepEqual(result.paths, new Set());
});

test("a missing mtime does not make a note in use", async () => {
  const p = probe({ tabs: [], mtimes: {} });
  const result = await notesInUse({ vaultPath: "/v", notes: [note("Gone.md", "x")], records: new Map(), probe: p, now: NOW });
  assert.deepEqual(result.paths, new Set());
});

test("a pdf in the tab list never appears in paths", async () => {
  const p = probe({ tabs: ["Doc.pdf", "A.md"], mtimes: {} });
  const result = await notesInUse({ vaultPath: "/v", notes: [note("A.md", "x")], records: new Map(), probe: p, now: NOW });
  assert.deepEqual(result.paths, new Set(["A.md"]));
});

test("unreadable tabs while running are flagged and the recent-edit rule still applies", async () => {
  const p = probe({ tabs: null, mtimes: { "A.md": ago(1) } });
  const result = await notesInUse({ vaultPath: "/v", notes: [note("A.md", "x"), note("B.md", "y")], records: new Map(), probe: p, now: NOW });
  assert.deepEqual(result, { paths: new Set(["A.md"]), tabsUnreadable: true });
});
