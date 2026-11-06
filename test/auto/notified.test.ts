import { test } from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { autoNotifiedFile, configErrorFile, clearConfigError, fingerprintOf, isNewConfigError, isNewResult, rememberConfigError, rememberResult, type AutoResult } from "../../src/auto/notified.ts";
import { tempDir } from "../helpers/tmp.ts";

/** The old one-step rule: is it new? If so, remember it. */
async function shouldNotify(file: string, fingerprint: string | null): Promise<boolean> {
  if (!(await isNewResult(file, fingerprint))) return false;
  await rememberResult(file, fingerprint!);
  return true;
}

async function shouldNotifyConfigError(env: Record<string, string | undefined>, path: string, message: string): Promise<boolean> {
  if (!(await isNewConfigError(env, path, message))) return false;
  await rememberConfigError(env, path, message);
  return true;
}

const result = (over: Partial<AutoResult> = {}): AutoResult => ({ heldPages: [], heldFiles: [], needLook: [], ...over });

test("a clean result has no fingerprint and clears the file", async (t) => {
  const file = join(await tempDir(t), "state", "auto-notified.json");
  assert.equal(fingerprintOf(result()), null);
  assert.equal(await shouldNotify(file, fingerprintOf(result({ failed: "boom" }))), true);
  await stat(file);
  assert.equal(await shouldNotify(file, null), false);
  await assert.rejects(stat(file), { code: "ENOENT" });
  // Clearing a file that isn't there is fine.
  assert.equal(await shouldNotify(file, null), false);
});

test("the same failure notifies once; a changed message notifies again", async (t) => {
  const file = join(await tempDir(t), "n.json");
  assert.equal(await shouldNotify(file, fingerprintOf(result({ failed: "boom" }))), true);
  assert.equal(await shouldNotify(file, fingerprintOf(result({ failed: "boom" }))), false);
  assert.equal(await shouldNotify(file, fingerprintOf(result({ failed: "other" }))), true);
});

test("the order of a held list does not matter; failure beats held beats needLook", () => {
  const a = fingerprintOf(result({ heldPages: ["p2", "p1"], heldFiles: ["f.png"] }));
  assert.equal(a, fingerprintOf(result({ heldPages: ["p1", "p2"], heldFiles: ["f.png"] })));
  assert.notEqual(a, fingerprintOf(result({ heldPages: ["p1", "p2"] })));
  assert.equal(fingerprintOf(result({ failed: "x", heldPages: ["p1"], needLook: ["n.md"] })), fingerprintOf(result({ failed: "x" })));
  assert.equal(fingerprintOf(result({ heldPages: ["p1"], needLook: ["n.md"] })), fingerprintOf(result({ heldPages: ["p1"], needLook: ["m.md"] })));
  assert.notEqual(fingerprintOf(result({ heldPages: ["p1"] })), fingerprintOf(result({ needLook: ["p1"] })));
});

test("held, then clean, then the same held notifies again", async (t) => {
  const file = join(await tempDir(t), "n.json");
  const held = fingerprintOf(result({ heldPages: ["p1"] }));
  assert.equal(await shouldNotify(file, held), true);
  assert.equal(await shouldNotify(file, held), false);
  assert.equal(await shouldNotify(file, fingerprintOf(result())), false);
  assert.equal(await shouldNotify(file, held), true);
});

test("a growing needLook set notifies; the same set does not", async (t) => {
  const file = join(await tempDir(t), "n.json");
  assert.equal(await shouldNotify(file, fingerprintOf(result({ needLook: ["b.md", "a.md"] }))), true);
  assert.equal(await shouldNotify(file, fingerprintOf(result({ needLook: ["a.md", "b.md"] }))), false);
  assert.equal(await shouldNotify(file, fingerprintOf(result({ needLook: ["a.md", "b.md", "c.md"] }))), true);
});

test("config errors: once per message per config path", async (t) => {
  const dir = await tempDir(t);
  const env = { XDG_STATE_HOME: dir };
  assert.equal(configErrorFile(env), join(dir, "nopipeline", "auto-config-error.json"));
  assert.equal(autoNotifiedFile("/s"), "/s/auto-notified.json");
  assert.equal(await shouldNotifyConfigError(env, "/c/a.json", "bad key"), true);
  assert.equal(await shouldNotifyConfigError(env, "/c/a.json", "bad key"), false);
  assert.equal(await shouldNotifyConfigError(env, "/c/b.json", "bad key"), true);
  assert.equal(await shouldNotifyConfigError(env, "/c/a.json", "bad key"), false);
  assert.equal(await shouldNotifyConfigError(env, "/c/a.json", "another"), true);
});

test("a result that is only checked is not remembered until it is", async (t) => {
  const file = join(await tempDir(t), "n.json");
  const f = fingerprintOf(result({ failed: "boom" }))!;
  assert.equal(await isNewResult(file, f), true);
  assert.equal(await isNewResult(file, f), true);
  await rememberResult(file, f);
  assert.equal(await isNewResult(file, f), false);
});

test("clearConfigError forgets one path, and removes the file when empty", async (t) => {
  const env = { XDG_STATE_HOME: await tempDir(t) };
  await rememberConfigError(env, "/c/a.json", "bad");
  await rememberConfigError(env, "/c/b.json", "bad");
  await clearConfigError(env, "/c/a.json");
  assert.equal(await isNewConfigError(env, "/c/a.json", "bad"), true);
  assert.equal(await isNewConfigError(env, "/c/b.json", "bad"), false);
  await clearConfigError(env, "/c/b.json");
  await assert.rejects(stat(configErrorFile(env)), { code: "ENOENT" });
  await clearConfigError(env, "/c/b.json");
});
