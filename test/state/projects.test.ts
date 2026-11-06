import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openProjectStore } from "../../src/state/projects.ts";
import type { PageId } from "../../src/types.ts";
import { tempDir } from "../helpers/tmp.ts";

const id = (s: string) => s as PageId;

test("a missing file opens as an empty store", async (t) => {
  assert.equal((await openProjectStore(await tempDir(t))).all().size, 0);
});

test("projects survive save and a fresh open, and delete is saved", async (t) => {
  const dir = await tempDir(t);
  const store = await openProjectStore(dir);
  store.set(id("p1"), { path: "Astronomy", title: "Astronomy" });
  store.set(id("p2"), { path: "Été Indien", title: "Été Indien" });
  store.delete(id("p2"));
  store.set(id("p3"), { path: "Name 2", title: "Name" });
  await store.save();
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(dir, "projects.json"), "utf8"))), ["projects"]);
  const again = await openProjectStore(dir);
  assert.deepEqual([...again.all()], [[id("p1"), { path: "Astronomy", title: "Astronomy" }], [id("p3"), { path: "Name 2", title: "Name" }]]);
});

test("a damaged file is refused with its name", async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "projects.json"), "{nope");
  await assert.rejects(openProjectStore(dir), /projects\.json/);
});

test("P6: an entry without a text path or title is refused, naming projects.json and saying to fix or delete it", async (t) => {
  for (const projects of [{ p1: { path: "Astronomy" } }, { p1: { title: "Astronomy" } }, { p1: { path: 3, title: "x" } }, { p1: null }, { p1: "Astronomy" }, [1], "nope"]) {
    const dir = await tempDir(t);
    await writeFile(join(dir, "projects.json"), JSON.stringify({ projects }));
    await assert.rejects(openProjectStore(dir), /projects\.json.*fix or delete it/, JSON.stringify(projects));
  }
  const dir = await tempDir(t);
  await writeFile(join(dir, "projects.json"), JSON.stringify([1]));
  await assert.rejects(openProjectStore(dir), /projects\.json.*fix or delete it/);
});
