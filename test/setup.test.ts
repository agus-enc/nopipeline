import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { Discovery } from "../src/notion/discover.ts";
import { runSetup } from "../src/setup.ts";
import { tempDir } from "./helpers/tmp.ts";

const NOTES = "11111111-1111-1111-1111-111111111111";
const PROJECTS = "22222222-2222-2222-2222-222222222222";
const OTHER = "33333333-3333-3333-3333-333333333333";
const TOKEN = "secret_TEST123";

type Properties = Record<string, { type: string; target?: string }>;

interface FakeOptions {
  sources?: { id: string; title: string }[];
  notes?: Properties;
  projects?: Properties;
  template?: boolean;
  /** What the token is refused with. */
  refuse?: string;
}

const NOTES_PROPERTIES: Properties = {
  Überschrift: { type: "title" },
  Projekt: { type: "relation", target: PROJECTS },
  "Links to": { type: "relation", target: NOTES },
  Tags: { type: "multi_select" },
};

/** A Discovery that only reads; it has no write methods at all. */
function fakeDiscovery(options: FakeOptions = {}): Discovery & { tokens: string[] } {
  const tokens: string[] = [];
  const schemas: Record<string, { title: string; properties: Properties }> = {
    [NOTES]: { title: "Notes", properties: options.notes ?? NOTES_PROPERTIES },
    [PROJECTS]: { title: "Projects", properties: options.projects ?? { Name: { type: "title" } } },
    [OTHER]: { title: "Other", properties: { Name: { type: "title" } } },
  };
  return {
    tokens,
    async whoAmI() {
      if (options.refuse) throw new Error(options.refuse);
      return "My connection";
    },
    async dataSources() {
      return options.sources ?? [{ id: OTHER, title: "Other" }, { id: NOTES, title: "Notes" }, { id: PROJECTS, title: "Projects" }];
    },
    async schema(id) {
      const found = schemas[id];
      if (!found) throw new Error(`no such source ${id}`);
      return found;
    },
    async hasDefaultTemplate() {
      return options.template ?? true;
    },
  };
}

async function vaultWith(t: TestContext, appJson: string | null = '{"useMarkdownLinks": true}'): Promise<string> {
  const vault = join(await tempDir(t), "Vault");
  await mkdir(join(vault, ".obsidian"), { recursive: true });
  if (appJson !== null) await writeFile(join(vault, ".obsidian", "app.json"), appJson);
  return vault;
}

/** Answers questions by the first rule whose pattern matches; an empty answer takes the suggestion, as Enter does. */
function script(rules: [RegExp, string][], secret = TOKEN) {
  const out: string[] = [];
  const asked: string[] = [];
  return {
    out,
    asked,
    io: {
      async ask(question: string, suggestion?: string) {
        asked.push(question);
        const rule = rules.find(([pattern]) => pattern.test(question));
        if (!rule) throw new Error(`unexpected question: ${question}`);
        return rule[1] === "" ? (suggestion ?? "") : rule[1];
      },
      async askSecret(question: string) {
        asked.push(question);
        return secret;
      },
      out: (line: string) => void out.push(line),
    },
  };
}

async function setupFor(t: TestContext, vault: string, extra: [RegExp, string][] = [], fake: FakeOptions = {}, env: Record<string, string | undefined> = {}) {
  const dir = await tempDir(t);
  const configPath = join(dir, "conf", "trial.json");
  const run = script([...extra, [/notes database/i, "2"], [/projects database/i, "3"], [/as Obsidian shows/i, ""], [/vault/i, vault], [/default folder/i, ""], [/links to/i, ""]]);
  const code = await runSetup(run.io, { configPath, env, discover: () => fakeDiscovery(fake) });
  return { ...run, code, configPath, dir };
}

const profile = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

test("a full setup writes a profile that loads, and a private token file", async (t) => {
  const vault = await vaultWith(t);
  const result = await setupFor(t, vault);
  assert.equal(result.code, 0, result.out.join("\n"));
  const written = await profile(result.configPath);
  assert.deepEqual(written, {
    vaultPath: vault,
    dataSourceId: NOTES,
    titleProperty: "Überschrift",
    projectsRelation: "Projekt",
    linksToProperty: "Links to",
    inboxFolder: "0-In",
    tokenFile: join(result.dir, "conf", "token"),
  });
  const config = await loadConfig(result.configPath);
  assert.equal(config.titleProperty, "Überschrift");
  assert.equal(config.projectsRelation, "Projekt");
  assert.equal(config.tokenFile, join(result.dir, "conf", "token"));
  const info = await stat(join(result.dir, "conf", "token"));
  assert.equal(info.mode & 0o777, 0o600);
  assert.equal((await readFile(join(result.dir, "conf", "token"), "utf8")).trim(), TOKEN);
  assert.match(result.out.join("\n"), /sync -- --dry-run/);
});

test("the token never appears in any output line", async (t) => {
  const vault = await vaultWith(t);
  const ok = await setupFor(t, vault);
  assert.ok(ok.out.length > 0);
  for (const line of ok.out) assert.ok(!line.includes(TOKEN), line);
  const refused = await setupFor(t, vault, [], { refuse: `Notion said no to ${TOKEN}` });
  assert.equal(refused.code, 1);
  assert.match(refused.out.join("\n"), /token/i);
  for (const line of refused.out) assert.ok(!line.includes(TOKEN), line);
});

test("a refused token stops the setup before anything is written", async (t) => {
  const vault = await vaultWith(t);
  const result = await setupFor(t, vault, [], { refuse: "unauthorized" });
  assert.equal(result.code, 1);
  await assert.rejects(stat(result.configPath));
  await assert.rejects(stat(join(result.dir, "conf", "token")));
});

test("NOTION_TOKEN is used when offered: no token file and no tokenFile in the profile", async (t) => {
  const vault = await vaultWith(t);
  const result = await setupFor(t, vault, [[/NOTION_TOKEN/, "y"]], {}, { NOTION_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.out.join("\n"));
  assert.ok(!("tokenFile" in (await profile(result.configPath))));
  await assert.rejects(stat(join(result.dir, "conf", "token")));
  assert.ok(!result.asked.some((q) => /paste/i.test(q)));
  for (const line of result.out) assert.ok(!line.includes(TOKEN), line);
});

test("declining NOTION_TOKEN asks for a token like any other run", async (t) => {
  const vault = await vaultWith(t);
  const result = await setupFor(t, vault, [[/NOTION_TOKEN/, "n"]], {}, { NOTION_TOKEN: "secret_OTHER" });
  assert.equal(result.code, 0, result.out.join("\n"));
  assert.equal((await readFile(join(result.dir, "conf", "token"), "utf8")).trim(), TOKEN);
});

test("an existing token file is offered for reuse", async (t) => {
  const vault = await vaultWith(t);
  const dir = await tempDir(t);
  const configPath = join(dir, "trial.json");
  await writeFile(join(dir, "token"), "secret_EXISTING\n", { mode: 0o600 });
  const seen: string[] = [];
  const run = script([[/notes database/i, "2"], [/projects database/i, "3"], [/as Obsidian shows/i, ""], [/vault/i, vault], [/default folder/i, ""], [/links to/i, ""], [/existing token/i, "y"]]);
  const code = await runSetup(run.io, { configPath, env: {}, discover: (token) => (seen.push(token), fakeDiscovery()) });
  assert.equal(code, 0, run.out.join("\n"));
  assert.deepEqual(seen, ["secret_EXISTING"]);
  assert.ok(!run.asked.some((q) => /paste/i.test(q)));
  assert.equal((await profile(configPath)).tokenFile, join(dir, "token"));
  assert.equal((await readFile(join(dir, "token"), "utf8")).trim(), "secret_EXISTING");
});

test("a vault without .obsidian/ is refused, and asked again", async (t) => {
  const vault = await vaultWith(t);
  const plain = join(await tempDir(t), "Plain");
  await mkdir(plain);
  const answers = [plain, join(plain, "missing"), vault];
  const dir = await tempDir(t);
  const run = script([[/notes database/i, "2"], [/projects database/i, "3"], [/as Obsidian shows/i, ""], [/default folder/i, ""], [/links to/i, ""]]);
  const io = { ...run.io, ask: async (q: string, s?: string) => (/Path to your Obsidian vault/i.test(q) ? (run.asked.push(q), answers.shift()!) : run.io.ask(q, s)) };
  const code = await runSetup(io, { configPath: join(dir, "p.json"), env: {}, discover: () => fakeDiscovery() });
  assert.equal(code, 0, run.out.join("\n"));
  assert.equal((await profile(join(dir, "p.json"))).vaultPath, vault);
  assert.match(run.out.join("\n"), /\.obsidian/);
});

test("a vault path may start with ~/ and is kept as typed", async (t) => {
  const vault = await vaultWith(t);
  const home = process.env.HOME;
  t.after(() => void (process.env.HOME = home));
  process.env.HOME = dirname(vault);
  const result = await setupFor(t, "~/Vault");
  assert.equal(result.code, 0, result.out.join("\n"));
  assert.equal((await profile(result.configPath)).vaultPath, "~/Vault");
  assert.equal((await loadConfig(result.configPath)).vaultPath, vault);
});

test("warns when app.json does not say useMarkdownLinks: true, is missing or unreadable", async (t) => {
  for (const app of ['{"useMarkdownLinks": false}', "{}", null, "not json"]) {
    const result = await setupFor(t, await vaultWith(t, app));
    assert.equal(result.code, 0);
    assert.match(result.out.join("\n"), /warning: .*Wikilinks.*Settings → Files and links/, String(app));
  }
  const fine = await setupFor(t, await vaultWith(t));
  assert.doesNotMatch(fine.out.join("\n"), /Wikilinks/);
});

test("warns when the projects database has no default template", async (t) => {
  const result = await setupFor(t, await vaultWith(t), [], { template: false });
  assert.match(result.out.join("\n"), /warning: .*default template.*blank/);
  const fine = await setupFor(t, await vaultWith(t));
  assert.doesNotMatch(fine.out.join("\n"), /default template/);
});

test("warns when a chosen database is missing from what the connection can see", async (t) => {
  const hidden = await setupFor(t, await vaultWith(t), [[/notes database/i, NOTES], [/projects database/i, PROJECTS]], { sources: [{ id: OTHER, title: "Other" }] });
  assert.equal(hidden.code, 0, hidden.out.join("\n"));
  const text = hidden.out.join("\n");
  assert.match(text, /warning: .*Notes.*not in the list/);
  assert.match(text, /warning: .*Projects.*not in the list/);
});

test("the title property is found from the schema", async (t) => {
  const result = await setupFor(t, await vaultWith(t), [], { notes: { ...NOTES_PROPERTIES, Überschrift: { type: "title" } } });
  assert.equal((await profile(result.configPath)).titleProperty, "Überschrift");
});

test("two relations to the projects database: the user picks one", async (t) => {
  const notes: Properties = { ...NOTES_PROPERTIES, Area: { type: "relation", target: PROJECTS } };
  const result = await setupFor(t, await vaultWith(t), [[/relation holds/i, "2"]], { notes });
  assert.equal(result.code, 0, result.out.join("\n"));
  assert.equal((await profile(result.configPath)).projectsRelation, "Area");
  const asked = result.asked.filter((q) => /relation holds/i.test(q));
  assert.equal(asked.length, 1);
  const single = await setupFor(t, await vaultWith(t));
  assert.ok(!single.asked.some((q) => /relation holds/i.test(q)));
});

test("no relation to the projects database stops with what to add in Notion", async (t) => {
  const { Projekt: _skip, ...notes } = NOTES_PROPERTIES;
  const result = await setupFor(t, await vaultWith(t), [], { notes });
  assert.equal(result.code, 1);
  assert.match(result.out.join("\n"), /no relation to "Projects".*add one in Notion/s);
  await assert.rejects(stat(result.configPath));
});

test("no self-relation: linksToProperty is omitted and a line explains", async (t) => {
  const { "Links to": _skip, ...notes } = NOTES_PROPERTIES;
  const result = await setupFor(t, await vaultWith(t), [], { notes });
  assert.equal(result.code, 0, result.out.join("\n"));
  assert.equal((await profile(result.configPath)).linksToProperty, null);
  assert.match(result.out.join("\n"), /no relation to itself.*works without/s);
});

test("a self-relation with another name is offered and written", async (t) => {
  const { "Links to": _skip, ...rest } = NOTES_PROPERTIES;
  const result = await setupFor(t, await vaultWith(t), [], { notes: { ...rest, Verweise: { type: "relation", target: NOTES } } });
  assert.equal((await profile(result.configPath)).linksToProperty, "Verweise");
});

test("declining the self-relation omits linksToProperty", async (t) => {
  const result = await setupFor(t, await vaultWith(t), [[/links to/i, "n"]]);
  assert.equal(result.code, 0, result.out.join("\n"));
  assert.equal((await profile(result.configPath)).linksToProperty, null);
  assert.equal((await loadConfig(result.configPath)).linksToProperty, null);
});

test("U1: with several self-relations the list offers none, and picking one is not asked again", async (t) => {
  const notes = { ...NOTES_PROPERTIES, Verweise: { type: "relation", target: NOTES } };
  const pick = await setupFor(t, await vaultWith(t), [[/which relation should hold the links/i, "2"]], { notes });
  assert.equal(pick.code, 0, pick.out.join("\n"));
  assert.equal((await profile(pick.configPath)).linksToProperty, "Verweise");
  assert.ok(!pick.asked.some((q) => /^Use ".*" as the Links to/.test(q)), "no confirmation after picking");
  assert.ok(pick.out.some((line) => /none/.test(line)), "none is on the list");
  const off = await setupFor(t, await vaultWith(t), [[/which relation should hold the links/i, "none"]], { notes });
  assert.equal(off.code, 0, off.out.join("\n"));
  assert.equal((await profile(off.configPath)).linksToProperty, null);
  assert.equal((await loadConfig(off.configPath)).linksToProperty, null);
});

test("U3: the vault's name is asked as Obsidian shows it, suggesting the folder's name, and written only when it differs", async (t) => {
  const vault = await vaultWith(t);
  const same = await setupFor(t, vault);
  const question = same.asked.find((q) => /as Obsidian shows/.test(q))!;
  assert.match(question, /obsidian:\/\/open/);
  assert.equal("vaultName" in (await profile(same.configPath)), false);
  const named = await setupFor(t, vault, [[/as Obsidian shows/i, "DemoVault"]]);
  assert.equal((await profile(named.configPath)).vaultName, "DemoVault");
  assert.equal((await loadConfig(named.configPath)).vaultName, "DemoVault");
});

test("none for projects writes no projectsRelation and does not look for one", async (t) => {
  const result = await setupFor(t, await vaultWith(t), [[/projects database/i, "none"]], { template: false });
  assert.equal(result.code, 0, result.out.join("\n"));
  assert.ok(!("projectsRelation" in (await profile(result.configPath))));
  assert.doesNotMatch(result.out.join("\n"), /default template/);
});

test("the inbox folder takes Enter for 0-In, or what was typed; an unusable name is asked again", async (t) => {
  const typed = await setupFor(t, await vaultWith(t), [[/default folder/i, "Inbox/Notion"]]);
  assert.equal((await profile(typed.configPath)).inboxFolder, "Inbox/Notion");
  const dir = await tempDir(t);
  const answers = ["../up", "Inbox"];
  const run = script([[/notes database/i, "2"], [/projects database/i, "3"], [/as Obsidian shows/i, ""], [/vault/i, await vaultWith(t)], [/links to/i, ""]]);
  const io = { ...run.io, ask: async (q: string, s?: string) => (/default folder/i.test(q) ? answers.shift()! : run.io.ask(q, s)) };
  assert.equal(await runSetup(io, { configPath: join(dir, "p.json"), env: {}, discover: () => fakeDiscovery() }), 0);
  assert.equal((await profile(join(dir, "p.json"))).inboxFolder, "Inbox");
});

test("an existing profile is kept when the answer to overwrite is n, and replaced on y", async (t) => {
  const vault = await vaultWith(t);
  const dir = await tempDir(t);
  const configPath = join(dir, "p.json");
  await writeFile(configPath, '{"old": true}\n');
  const rules: [RegExp, string][] = [[/notes database/i, "2"], [/projects database/i, "3"], [/as Obsidian shows/i, ""], [/vault/i, vault], [/default folder/i, ""], [/links to/i, ""]];
  const no = script([...rules, [/overwrite/i, "n"]]);
  assert.equal(await runSetup(no.io, { configPath, env: {}, discover: () => fakeDiscovery() }), 1);
  assert.equal(await readFile(configPath, "utf8"), '{"old": true}\n');
  await assert.rejects(stat(join(dir, "token")), "no token file when the profile is kept");
  const yes = script([...rules, [/overwrite/i, "y"]]);
  assert.equal(await runSetup(yes.io, { configPath, env: {}, discover: () => fakeDiscovery() }), 0);
  assert.equal((await profile(configPath)).dataSourceId, NOTES);
});

test("choosing the same database for notes and projects is refused and asked again", async (t) => {
  const vault = await vaultWith(t);
  const answers = ["2", "3"];
  const dir = await tempDir(t);
  const run = script([[/notes database/i, "2"], [/as Obsidian shows/i, ""], [/vault/i, vault], [/default folder/i, ""], [/links to/i, ""]]);
  const io = { ...run.io, ask: async (q: string, s?: string) => (/projects database/i.test(q) ? answers.shift()! : run.io.ask(q, s)) };
  assert.equal(await runSetup(io, { configPath: join(dir, "p.json"), env: {}, discover: () => fakeDiscovery() }), 0);
  assert.match(run.out.join("\n"), /different from the notes database/);
});

test("a database the checks reject stops the setup with what to fix", async (t) => {
  const result = await setupFor(t, await vaultWith(t), [], { notes: { Name: { type: "rich_text" }, Projekt: { type: "relation", target: PROJECTS } } });
  assert.equal(result.code, 1);
  assert.match(result.out.join("\n"), /title property/);
  await assert.rejects(stat(result.configPath));
});

test("no visible databases: says how to connect the connection", async (t) => {
  const result = await setupFor(t, await vaultWith(t), [], { sources: [] });
  assert.equal(result.code, 1);
  assert.match(result.out.join("\n"), /Connections/);
});

test("a file name that can't name a profile stops before anything is asked or written", async (t) => {
  const dir = await tempDir(t);
  const run = script([]);
  const code = await runSetup(run.io, { configPath: join(dir, "conf", ".hidden.json"), env: {}, discover: () => fakeDiscovery() });
  assert.equal(code, 1);
  assert.deepEqual(run.asked, []);
  assert.match(run.out.join("\n"), /can't name a profile/);
  await assert.rejects(stat(join(dir, "conf")));
});

test("pasting a new token over an existing token file says it will be replaced", async (t) => {
  const vault = await vaultWith(t);
  const dir = await tempDir(t);
  await writeFile(join(dir, "token"), "secret_OLD\n", { mode: 0o600 });
  const run = script([[/notes database/i, "2"], [/projects database/i, "3"], [/as Obsidian shows/i, ""], [/vault/i, vault], [/default folder/i, ""], [/links to/i, ""], [/existing token/i, "n"]]);
  assert.equal(await runSetup(run.io, { configPath: join(dir, "p.json"), env: {}, discover: () => fakeDiscovery() }), 0);
  assert.match(run.out.join("\n"), /existing token file .* will be replaced/);
  assert.equal((await readFile(join(dir, "token"), "utf8")).trim(), TOKEN);
});

test("failures reading Notion are plain messages without the token", async (t) => {
  const vault = await vaultWith(t);
  for (const broken of ["dataSources", "schema"] as const) {
    const dir = await tempDir(t);
    const fake = fakeDiscovery();
    fake[broken] = async () => {
      throw new Error(`boom ${TOKEN}`);
    };
    const run = script([[/notes database/i, "2"], [/projects database/i, "3"], [/as Obsidian shows/i, ""], [/vault/i, vault]]);
    const code = await runSetup(run.io, { configPath: join(dir, "p.json"), env: {}, discover: () => fake });
    assert.equal(code, 1, broken);
    for (const line of run.out) assert.ok(!line.includes(TOKEN), line);
    assert.match(run.out.join("\n"), /Nothing was written/);
    await assert.rejects(stat(join(dir, "p.json")));
  }
});

test("a projects database without a title property stops the setup", async (t) => {
  const result = await setupFor(t, await vaultWith(t), [], { projects: { Status: { type: "select" } } });
  assert.equal(result.code, 1);
  assert.match(result.out.join("\n"), /has no title property/);
  await assert.rejects(stat(result.configPath));
});

test("the database lists show an id suffix to tell same-titled databases apart", async (t) => {
  const result = await setupFor(t, await vaultWith(t));
  assert.ok(result.out.includes("  2. Notes (id ends 1111)"), result.out.join("\n"));
});

test("item 13: answering none for the projects database says how to connect the one that isn't listed", async (t) => {
  const result = await setupFor(t, await vaultWith(t), [[/projects database/i, "none"]]);
  assert.equal(result.code, 0, result.out.join("\n"));
  assert.ok(result.out.includes("If your projects database isn't listed, connect the connection to it in Notion (••• → Connections) and run setup again."));
  const kept = await setupFor(t, await vaultWith(t));
  assert.ok(!kept.out.some((line) => line.includes("isn't listed")));
});

test("item 13: overwriting a profile keeps its pageIcon and massTrashLimit, and says so", async (t) => {
  const vault = await vaultWith(t);
  const dir = await tempDir(t);
  const configPath = join(dir, "p.json");
  await writeFile(configPath, JSON.stringify({ vaultPath: "/old", pageIcon: { name: "book", color: "blue" }, massTrashLimit: 25, titleProperty: "Old" }));
  const run = script([[/notes database/i, "2"], [/projects database/i, "3"], [/as Obsidian shows/i, ""], [/vault/i, vault], [/default folder/i, ""], [/links to/i, ""], [/overwrite/i, "y"]]);
  assert.equal(await runSetup(run.io, { configPath, env: {}, discover: () => fakeDiscovery() }), 0);
  const written = await profile(configPath);
  assert.deepEqual(written.pageIcon, { name: "book", color: "blue" });
  assert.equal(written.massTrashLimit, 25);
  assert.equal(written.titleProperty, "Überschrift");
  assert.ok(run.out.includes("note: kept pageIcon and massTrashLimit from the profile it replaced."));
  const plain = script([[/notes database/i, "2"], [/projects database/i, "3"], [/as Obsidian shows/i, ""], [/vault/i, vault], [/default folder/i, ""], [/links to/i, ""], [/overwrite/i, "y"], [/existing token file/i, "y"]]);
  await writeFile(configPath, '{"old": true}');
  assert.equal(await runSetup(plain.io, { configPath, env: {}, discover: () => fakeDiscovery() }), 0);
  assert.equal("pageIcon" in (await profile(configPath)), false);
  assert.ok(!plain.out.some((line) => line.includes("kept pageIcon")));
});

test("setup says in one line when the Tags property is missing or not a multi-select, and stays quiet when it is fine", async (t) => {
  const vault = await vaultWith(t);
  const { Tags: _, ...without } = NOTES_PROPERTIES;
  const missing = await setupFor(t, vault, [], { notes: without });
  assert.equal(missing.code, 0, missing.out.join("\n"));
  assert.ok(missing.out.includes('note: the database has no "Tags" property; tags are left alone'));
  const wrong = await setupFor(t, vault, [], { notes: { ...NOTES_PROPERTIES, Tags: { type: "rich_text" } } });
  assert.ok(wrong.out.includes('note: the database\'s "Tags" property is a rich_text, not a multi-select; tags are left alone'));
  const fine = await setupFor(t, vault);
  assert.ok(!fine.out.some((line) => line.includes("Tags")));
});

test("overwriting a profile keeps its tagsProperty (a custom name or null) and checks that name", async (t) => {
  const vault = await vaultWith(t);
  const dir = await tempDir(t);
  const configPath = join(dir, "p.json");
  const answers = [[/notes database/i, "2"], [/projects database/i, "3"], [/as Obsidian shows/i, ""], [/vault/i, vault], [/default folder/i, ""], [/links to/i, ""], [/overwrite/i, "y"], [/existing token file/i, "y"]] as Parameters<typeof script>[0];
  for (const tagsProperty of ["Labels", null]) {
    await writeFile(configPath, JSON.stringify({ vaultPath: "/old", tagsProperty }));
    const run = script(answers);
    assert.equal(await runSetup(run.io, { configPath, env: {}, discover: () => fakeDiscovery() }), 0, run.out.join("\n"));
    assert.equal((await profile(configPath)).tagsProperty, tagsProperty);
    assert.ok(run.out.includes(tagsProperty === null ? "note: kept tagsProperty from the profile it replaced." : "note: kept tagsProperty from the profile it replaced.") );
    // The check names the kept property, not "Tags"; null makes no check.
    assert.equal(run.out.some((line) => line.includes('has no "Labels" property')), tagsProperty === "Labels");
    assert.ok(!run.out.some((line) => line.includes('"Tags" property')));
  }
});
