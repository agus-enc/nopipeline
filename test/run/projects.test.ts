import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { withProjects } from "../../src/run/projects.ts";
import { openProjectStore } from "../../src/state/projects.ts";
import type { FolderContext } from "../../src/plan/projects.ts";
import type { PageId } from "../../src/types.ts";
import { FakeNotion } from "../helpers/fake-notion.ts";
import { tempDir } from "../helpers/tmp.ts";
import { readFile } from "node:fs/promises";

const FOLDERS = ["0-In", "Astronomy", "Botany", "Cooking", "Dup", "Dup/Inner", "A", "B/A", "Resources", "Resources/Sub", "Assets", "Assets/attachments"];

async function setup(t: TestContext, opts: { enabled?: boolean; ambiguous?: string[] } = {}) {
  const notion = new FakeNotion();
  notion.defaultTemplate = true;
  const astronomy = notion.addProject("Astronomy");
  const botany = notion.addProject("Botany");
  const dir = await tempDir(t);
  const store = await openProjectStore(dir);
  const firstProjects = new Map<PageId, { ids: PageId[]; more: boolean }>();
  const context: FolderContext = {
    inboxFolder: "0-In",
    attachmentFolder: "Assets/attachments",
    folders: new Set(FOLDERS),
    projects: notion.projectList(),
    stored: store.all(),
  };
  const gw = withProjects(notion, { enabled: opts.enabled ?? true, context, store, firstProjects, ambiguous: new Set(opts.ambiguous ?? []) });
  const track = async () => {
    for (const p of await notion.listPages()) firstProjects.set(p.id, p.projects ?? { ids: [], more: false });
  };
  return { notion, gw, store, astronomy, botany, track, dir };
}

test("folder Astronomy with an existing project sets the relation and stores the folder", async (t) => {
  const { notion, gw, store, astronomy, track } = await setup(t);
  const page = notion.add("n", "");
  await track();
  await gw.setProperties(page, { title: "n2", folder: "Astronomy" });
  assert.deepEqual(notion.projectsOf(page), [astronomy]);
  assert.equal((await notion.listPages()).find((p) => p.id === page)!.title, "n2");
  assert.deepEqual(store.all().get(astronomy), { path: "Astronomy", title: "Astronomy" });
  assert.equal(gw.projectOf(page), astronomy);
});

test("keeps other projects past 25", async (t) => {
  const { notion, gw, botany, track } = await setup(t);
  const others = Array.from({ length: 29 }, (_, i) => notion.addProject(`P${i}`));
  const page = notion.add("n", "", [notion.addProject("Old"), ...others]);
  await track();
  await gw.setProperties(page, { title: "n", folder: "Botany" });
  assert.deepEqual(notion.projectsOf(page), [botany, ...others]);
});

test("the inbox folder removes a page's only project", async (t) => {
  const { notion, gw, astronomy, track } = await setup(t);
  const page = notion.add("n", "", [astronomy]);
  await track();
  await gw.setProperties(page, { title: "n", folder: "0-In" });
  assert.deepEqual(notion.projectsOf(page), []);
  assert.equal(gw.projectOf(page), null);
});

test("item 7: the inbox folder or the root leaves a page with several projects as it is", async (t) => {
  const { notion, gw, astronomy, botany, track } = await setup(t);
  const page = notion.add("n", "", [astronomy, botany]);
  await track();
  await gw.setProperties(page, { title: "n", folder: "0-In" });
  await gw.setProperties(page, { title: "n", folder: null });
  assert.deepEqual(notion.projectsOf(page), [astronomy, botany]);
  assert.equal(notion.calls.filter((c) => c.startsWith("setProjects")).length, 0);
  assert.equal(gw.projectOf(page), astronomy);
});

test("a new folder creates one project from the default template; the next note reuses it", async (t) => {
  const { notion, gw, store, track } = await setup(t);
  const a = notion.add("a", "");
  const b = await gw.createPage({ title: "b", folder: "Cooking" });
  await track();
  await gw.setProperties(a, { title: "a", folder: "Cooking" });
  const cooking = notion.projectList().filter((p) => p.title === "Cooking");
  assert.equal(cooking.length, 1);
  assert.equal(notion.projectPages.get(cooking[0]!.id)!.template, "default");
  assert.deepEqual(notion.projectsOf(a), [cooking[0]!.id]);
  assert.deepEqual(notion.projectsOf(b), [cooking[0]!.id]);
  assert.deepEqual(store.all().get(cooking[0]!.id), { path: "Cooking", title: "Cooking" });
  assert.equal(notion.calls.filter((c) => c.startsWith("createProject")).length, 1);
});

test("a created project is saved right away", async (t) => {
  const { notion, gw, dir } = await setup(t);
  const a = notion.add("a", "");
  await gw.setProperties(a, { title: "a", folder: "Cooking" });
  assert.match(await readFile(`${dir}/projects.json`, "utf8"), /Cooking/);
});

test("project created, store not saved: an existing project of that title is reused", async (t) => {
  const { notion, gw, store, track } = await setup(t);
  const cooking = notion.addProject("Cooking");
  const a = notion.add("a", "");
  await track();
  await gw.setProperties(a, { title: "a", folder: "Cooking" });
  assert.equal(notion.calls.filter((c) => c.startsWith("createProject")).length, 0);
  assert.deepEqual(notion.projectsOf(a), [cooking]);
  assert.deepEqual(store.all().get(cooking), { path: "Cooking", title: "Cooking" });
});

test("an ambiguous or evicting folder leaves the relation alone, silently: the resolver already warned", async (t) => {
  const { notion, gw, astronomy, track } = await setup(t, { ambiguous: ["Botany"] });
  const page = notion.add("n", "", [astronomy]);
  await track();
  await gw.setProperties(page, { title: "n", folder: "A" }); // two leaf folders claim the name "A"
  await gw.setProperties(page, { title: "n", folder: "Resources" }); // has subfolders
  await gw.setProperties(page, { title: "n", folder: "Botany" }); // a project, but the resolver found it ambiguous
  assert.deepEqual(notion.projectsOf(page), [astronomy]);
  assert.equal(notion.calls.filter((c) => c.startsWith("setProjects")).length, 0);
});

test("a write that changes nothing is skipped", async (t) => {
  const { notion, gw, astronomy, botany, track } = await setup(t);
  const page = notion.add("n", "", [astronomy, botany]);
  await track();
  await gw.setProperties(page, { title: "n", folder: "Astronomy" });
  assert.equal(notion.calls.filter((c) => c.startsWith("setProjects")).length, 0);
  assert.equal(notion.calls.filter((c) => c.startsWith("readProjects")).length, 0);
  assert.equal(gw.projectOf(page), astronomy);
});

test("a page the listing did not show is read before its relation is written", async (t) => {
  const { notion, gw, astronomy, botany } = await setup(t);
  const page = notion.add("n", "", [astronomy, botany]);
  await gw.setProperties(page, { title: "n", folder: "Botany" }); // never tracked: the fallback reads the relation
  assert.equal(notion.calls.filter((c) => c.startsWith("readProjects")).length, 1);
  assert.deepEqual(notion.projectsOf(page), [botany]);
});

test("a page whose listing said `more` is read before its relation is written", async (t) => {
  const { notion, gw, botany, track } = await setup(t);
  const others = Array.from({ length: 29 }, (_, i) => notion.addProject(`P${i}`));
  const page = notion.add("n", "", [notion.addProject("Old"), ...others]);
  await track();
  const before = notion.calls.length;
  await gw.setProperties(page, { title: "n", folder: "Botany" });
  assert.equal(notion.calls.slice(before).filter((c) => c.startsWith("readProjects")).length, 1);
  assert.deepEqual(notion.projectsOf(page), [botany, ...others]);
});

test("the titles of the projects the layer created are listed", async (t) => {
  const { notion, gw, track } = await setup(t);
  const a = notion.add("a", "");
  await track();
  assert.deepEqual(gw.createdProjects(), []);
  await gw.setProperties(a, { title: "a", folder: "Cooking" });
  assert.deepEqual(gw.createdProjects(), ["Cooking"]);
});

test("not enabled: no relation call at all", async (t) => {
  const { notion, gw, track } = await setup(t, { enabled: false });
  const page = notion.add("n", "");
  await track();
  notion.calls.length = 0;
  await gw.setProperties(page, { title: "m", folder: "Astronomy" });
  const id = await gw.createPage({ title: "x", folder: "Astronomy" });
  assert.deepEqual(notion.calls.filter((c) => /Projects|Project/.test(c)), []);
  assert.deepEqual(notion.projectsOf(id), []);
  assert.equal(gw.projectOf(page), undefined);
});

test("the vault root (a null folder) removes a page's only project, like the default folder", async (t) => {
  const { notion, gw, astronomy, track } = await setup(t);
  const page = notion.add("n", "", [astronomy]);
  await track();
  await gw.setProperties(page, { title: "n", folder: null });
  assert.deepEqual(notion.projectsOf(page), []);
  assert.equal(gw.projectOf(page), null);
});
