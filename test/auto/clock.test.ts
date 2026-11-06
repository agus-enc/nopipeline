import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readLastSync, writeLastSync } from "../../src/auto/clock.ts";
import { tempDir } from "../helpers/tmp.ts";

test("the last sync time round-trips and a missing file reads as null", async (t) => {
  const dir = join(await tempDir(t), "state");
  assert.equal(await readLastSync(dir), null);
  const at = new Date("2026-11-05T10:00:00.000Z");
  await writeLastSync(dir, at);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "last-sync.json"), "utf8")), { endedAt: "2026-11-05T10:00:00.000Z" });
  assert.deepEqual(await readLastSync(dir), at);
});

test("an unreadable last-sync.json reads as null", async (t) => {
  const dir = await tempDir(t);
  for (const text of ["not json", "[]", '{"endedAt":5}', '{"endedAt":"nope"}']) {
    await writeFile(join(dir, "last-sync.json"), text);
    assert.equal(await readLastSync(dir), null, text);
  }
});
