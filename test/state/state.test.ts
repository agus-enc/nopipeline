import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireLock, LockTakenError } from "../../src/state/lock.ts";
import { openRecordStore } from "../../src/state/records.ts";
import type { SyncRecord } from "../../src/types.ts";
import { flushes } from "../helpers/fsync.ts";
import { tempDir } from "../helpers/tmp.ts";

const record: SyncRecord = {
  notionId: "cb56bbf0-dc78-4886-8553-6285651b9f5d",
  path: "Grove/Elm.md",
  title: "Elm",
  folder: "Grove",
  obsidianText: "# Elm\n",
  notionMarkdown: "# Elm",
  notionSeenAt: "2026-09-27T04:00:00.000Z",
  syncedAt: "2026-09-27T04:00:00.000Z",
};

test("records survive a reopen and can be removed", async (t) => {
  const dir = await tempDir(t);
  const store = await openRecordStore(dir);
  await store.put(record);
  assert.deepEqual((await openRecordStore(dir)).all().get(record.notionId), record);
  await store.remove(record.notionId);
  assert.equal((await openRecordStore(dir)).all().size, 0);
  await assert.rejects(store.put({ ...record, notionId: "../escaped" }), /not a Notion page id/);
  await assert.rejects(store.remove("../escaped"), /not a Notion page id/);
});

test("records are readable JSON files named after the page id", async (t) => {
  const dir = await tempDir(t);
  await (await openRecordStore(dir)).put(record);
  const text = await readFile(join(dir, "records", `${record.notionId}.json`), "utf8");
  assert.equal(JSON.parse(text).path, "Grove/Elm.md");
  await writeFile(join(dir, "records", "f8601963-ee58-44fa-87b3-54a743b38c5a.json"), '{"notionId": "f860');
  await assert.rejects(openRecordStore(dir), /can't read the sync record .*8c5a\.json/);
});

test("the lock stops a second run and is released afterwards", async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "lock"), String(process.ppid));
  await assert.rejects(acquireLock(dir, () => {}), (error) => error instanceof LockTakenError && /another sync is running/.test(error.message));
  await writeFile(join(dir, "lock"), "999999999");
  const warnings: string[] = [];
  const release = await acquireLock(dir, (w) => warnings.push(w));
  assert.match(warnings[0]!, /stale lock/);
  await assert.rejects(acquireLock(dir, () => {}), /another sync is running/);
  await release();
  await (await acquireLock(dir, () => {}))();
  const mine = await acquireLock(dir, () => {});
  await writeFile(join(dir, "lock"), String(process.ppid));
  await mine();
  assert.equal(await readFile(join(dir, "lock"), "utf8"), String(process.ppid), "a release leaves another run's lock alone");
});

test("a record reaches the disk before it takes its name, and its name right after", async (t) => {
  const dir = await tempDir(t);
  const store = await openRecordStore(dir);
  const flushed = await flushes(t);
  await store.put(record);
  const file = join(dir, "records", `${record.notionId}.json`);
  if (flushed.some((path) => path.startsWith("/"))) assert.deepEqual(flushed, [`${file}.tmp`, join(dir, "records")]);
  else assert.equal(flushed.length, 2);
});
