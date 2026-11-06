import { test } from "node:test";
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SyncOutcome } from "../../src/sync.ts";
import { heldFrom, readHeld, saveHeld } from "../../src/status/held.ts";
import { tempDir } from "../helpers/tmp.ts";

const at = new Date("2026-11-05T10:00:00Z");

function outcome(plan: Record<string, unknown>, summary: Record<string, unknown> | null): SyncOutcome {
  return { plan: { actions: [], warnings: [], heldTrashes: 0, ...plan }, summary, notes: [], pages: [] } as unknown as SyncOutcome;
}

test("heldFrom is null for a clean outcome", () => {
  const clean = outcome({}, { done: { pull: 2 } });
  assert.equal(heldFrom(clean, false, at), null);
});

test("heldFrom lists the held notes and attachments", () => {
  const held = [
    { pageId: "p1", path: "A.md", side: "notion" },
    { pageId: "p2", path: "B.md", side: "vault" },
  ];
  const o = outcome({ held, heldFiles: ["Files/x.png"], heldTrashes: 3 }, { done: { pull: 1, push: 2 } });
  assert.deepEqual(heldFrom(o, false, at), { firstRun: false, changes: 3, notes: held, files: ["Files/x.png"], at: at.toISOString() });
});

test("a first-run stop is held with its changes counted from the plan", () => {
  const o = outcome({ actions: [{ kind: "createPage", path: "A.md" }, { kind: "createPage", path: "B.md" }], creates: ["P"] }, null);
  assert.deepEqual(heldFrom(o, true, at), { firstRun: true, changes: 3, notes: [], files: [], at: at.toISOString() });
});

test("held.json round-trips and saving null removes it", async (t) => {
  const dir = await tempDir(t);
  assert.equal(await readHeld(dir), null);
  const held = { firstRun: false, changes: 1, notes: [{ pageId: "p1", path: "A.md", side: "notion" as const }], files: ["f.png"], at: at.toISOString() };
  await saveHeld(dir, held);
  assert.deepEqual(await readHeld(dir), held);
  await saveHeld(dir, null);
  await assert.rejects(access(join(dir, "held.json")));
  assert.equal(await readHeld(dir), null);
  await saveHeld(dir, null);
});

test("a held.json that isn't valid reads as nothing held", async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "held.json"), "not json");
  assert.equal(await readHeld(dir), null);
});
