import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claimStateDir, loadConfig, readToken } from "../src/config.ts";
import { flushes } from "./helpers/fsync.ts";
import { tempDir } from "./helpers/tmp.ts";

test("loadConfig fills defaults and derives the profile and state folder", async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, "sample.json");
  await writeFile(file, JSON.stringify({ vaultPath: "/home/me/Documents/DemoVault", dataSourceId: "a50245e98e6a41aa8ccfd8795ed0dead" }));
  const config = await loadConfig(file, { XDG_STATE_HOME: "/state" });
  assert.deepEqual(config, {
    profile: "sample",
    vaultPath: "/home/me/Documents/DemoVault",
    vaultName: "DemoVault",
    dataSourceId: "a50245e9-8e6a-41aa-8ccf-d8795ed0dead",
    titleProperty: "Name",
    linksToProperty: "Links to",
    tagsProperty: "Tags",
    projectsRelation: null,
    pageIcon: null,
    ignoredKeys: [],
    inboxFolder: "0-In",
    massTrashLimit: 10,
    tokenFile: null,
    statusNote: "nopipeline status.md",
    autoSyncHours: 6,
    stateDir: "/state/nopipeline/sample",
  });
  // The state folder belongs to one vault and data source; a same-named config for another vault is refused.
  const claimed = { ...config, stateDir: join(dir, "state") };
  await claimStateDir(claimed);
  await claimStateDir(claimed);
  await assert.rejects(claimStateDir({ ...claimed, vaultPath: "/home/me/Documents/DemoVault copy" }), /belongs to the vault \/home\/me\/Documents\/DemoVault and/);
  // Two first claims at once: exactly one wins, and the folder records the winner.
  const race = join(dir, "race");
  const results = await Promise.allSettled(["/a", "/b"].map((vaultPath) => claimStateDir({ ...config, stateDir: race, vaultPath })));
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  const winner = results[0]!.status === "fulfilled" ? "/a" : "/b";
  assert.equal(JSON.parse(await readFile(join(race, "profile.json"), "utf8")).vaultPath, winner);
});

test("loadConfig reads projectsRelation and pageIcon, and accepts an old profile", async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, "p.json");
  const base = { vaultPath: "/v", dataSourceId: "a50245e98e6a41aa8ccfd8795ed0dead" };
  await writeFile(file, JSON.stringify({ ...base, projectsRelation: "Project", pageIcon: { name: "bookmark", color: "blue" } }));
  const icon = await loadConfig(file);
  assert.equal(icon.projectsRelation, "Project");
  assert.deepEqual(icon.pageIcon, { type: "icon", icon: { name: "bookmark", color: "blue" } });
  assert.equal(icon.pageIcon!.type, "icon");
  await writeFile(file, JSON.stringify({ ...base, pageIcon: "📘" }));
  assert.deepEqual((await loadConfig(file)).pageIcon, { type: "emoji", emoji: "📘" });
  for (const pageIcon of [3, "", { name: "x" }, { name: "x", color: 1 }]) {
    await writeFile(file, JSON.stringify({ ...base, pageIcon }));
    await assert.rejects(loadConfig(file), /"pageIcon" must be/);
  }
  // P5: a color Notion doesn't know, and text that is not one emoji.
  await writeFile(file, JSON.stringify({ ...base, pageIcon: { name: "book", color: "teal" } }));
  await assert.rejects(loadConfig(file), /"pageIcon" color "teal" is not one of gray, lightgray, brown, yellow, orange, green, blue, purple, pink, red/);
  for (const pageIcon of ["abc", "📘📘", "a", "📘 "]) {
    await writeFile(file, JSON.stringify({ ...base, pageIcon }));
    await assert.rejects(loadConfig(file), /"pageIcon" must be a single emoji/, pageIcon);
  }
  for (const pageIcon of ["📘", "👨‍👩‍👧", "🇪🇺", "❤️", "1️⃣"]) {
    await writeFile(file, JSON.stringify({ ...base, pageIcon }));
    assert.deepEqual((await loadConfig(file)).pageIcon, { type: "emoji", emoji: pageIcon });
  }
  await writeFile(file, JSON.stringify({ ...base, projectsRelation: "" }));
  await assert.rejects(loadConfig(file), /"projectsRelation" must be a non-empty string/);
  await writeFile(file, JSON.stringify(base));
  assert.equal((await loadConfig(file)).projectsRelation, null);
  // old profile loads
  await writeFile(file, JSON.stringify({ ...base, folderProperty: "Folder" }));
  const old = await loadConfig(file);
  assert.deepEqual(old.ignoredKeys, ["folderProperty"]);
  assert.equal(old.projectsRelation, null);
  assert.equal("folderProperty" in old, false);
});

test("loadConfig rejects missing or malformed values", async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, "bad.json");
  await writeFile(file, JSON.stringify({ vaultPath: "/v", dataSourceId: "nope" }));
  await assert.rejects(loadConfig(file), /not a Notion id/);
  await writeFile(file, JSON.stringify({ dataSourceId: "a50245e98e6a41aa8ccfd8795ed0dead" }));
  await assert.rejects(loadConfig(file), /"vaultPath" must be/);
  await assert.rejects(loadConfig(join(dir, "missing.json")), /can't read the config file/);
  const id = "a50245e98e6a41aa8ccfd8795ed0dead";
  await writeFile(file, JSON.stringify({ vaultPath: "/v", dataSourceId: id, titleProprety: "Title" }));
  await assert.rejects(loadConfig(file), /unknown setting "titleProprety"/);
  await writeFile(file, JSON.stringify({ vaultPath: "/v", dataSourceId: id, linksToProperty: "" }));
  await assert.rejects(loadConfig(file), /"linksToProperty" must be a non-empty string/);
  await writeFile(file, JSON.stringify({ vaultPath: "/v", dataSourceId: id, linksToProperty: "Mentions" }));
  assert.equal((await loadConfig(file)).linksToProperty, "Mentions");
  await writeFile(file, JSON.stringify({ vaultPath: "/v", dataSourceId: id, linksToProperty: null }));
  assert.equal((await loadConfig(file)).linksToProperty, null);
  await writeFile(file, JSON.stringify({ vaultPath: "relative/vault", dataSourceId: id }));
  await assert.rejects(loadConfig(file), /"vaultPath" must be an absolute path/);
  await writeFile(file, JSON.stringify({ vaultPath: "/v", dataSourceId: id, inboxFolder: "" }));
  await assert.rejects(loadConfig(file), /"inboxFolder" must be a non-empty string/);
  for (const inboxFolder of ["../In", ".inbox", "In/", "In:box"]) {
    await writeFile(file, JSON.stringify({ vaultPath: "/v", dataSourceId: id, inboxFolder }));
    await assert.rejects(loadConfig(file), /"inboxFolder" must be a folder inside the vault/);
  }
});

test("statusNote defaults, accepts a vault path, null turns it off, refuses bad paths", async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, "sn.json");
  const base = { vaultPath: "/v", dataSourceId: "a50245e98e6a41aa8ccfd8795ed0dead" };
  await writeFile(file, JSON.stringify(base));
  assert.equal((await loadConfig(file)).statusNote, "nopipeline status.md");
  await writeFile(file, JSON.stringify({ ...base, statusNote: "Meta/Sync status.md" }));
  assert.equal((await loadConfig(file)).statusNote, "Meta/Sync status.md");
  await writeFile(file, JSON.stringify({ ...base, statusNote: null }));
  assert.equal((await loadConfig(file)).statusNote, null);
  for (const statusNote of ["../x.md", "/abs.md", "x.txt", ".hidden/x.md", "", 5]) {
    await writeFile(file, JSON.stringify({ ...base, statusNote }));
    await assert.rejects(loadConfig(file), /"statusNote"/, JSON.stringify(statusNote));
  }
});

test("readToken prefers NOTION_TOKEN and insists the token file is private", async (t) => {
  const dir = await tempDir(t);
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, "secret_from_file\n");
  const file = join(dir, "p.json");
  await writeFile(file, JSON.stringify({ vaultPath: "/v", dataSourceId: "a50245e98e6a41aa8ccfd8795ed0dead", tokenFile }));
  const config = await loadConfig(file);
  assert.equal(await readToken(config, { NOTION_TOKEN: "secret_env" }), "secret_env");
  await chmod(tokenFile, 0o644);
  await assert.rejects(readToken(config, {}), /chmod 600/);
  await chmod(tokenFile, 0o600);
  assert.equal(await readToken(config, {}), "secret_from_file");
});

test("a config file's name must make a plain profile name, so its state folder is its own", async (t) => {
  const dir = await tempDir(t);
  const settings = JSON.stringify({ vaultPath: "/v", dataSourceId: "a50245e98e6a41aa8ccfd8795ed0dead" });
  for (const name of ["sample.json", "DemoVault trial.json", "work_2.v1-json", "config"]) {
    await writeFile(join(dir, name), settings);
    await loadConfig(join(dir, name), { XDG_STATE_HOME: "/state" });
  }
  for (const name of [".json", "..json", "...json", ".hidden.json", "-x.json", "a/b".replace("/", "\u2215") + ".json", "tab\there.json"]) {
    await writeFile(join(dir, name), settings);
    await assert.rejects(loadConfig(join(dir, name), { XDG_STATE_HOME: "/state" }), /can't name a profile/, name);
  }
});

test("the claim on a state folder reaches the disk before it takes its name, and its name right after", async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, "p.json");
  await writeFile(file, JSON.stringify({ vaultPath: "/v", dataSourceId: "a50245e98e6a41aa8ccfd8795ed0dead" }));
  const config = { ...(await loadConfig(file)), stateDir: join(dir, "state") };
  const flushed = await flushes(t);
  await claimStateDir(config);
  // The new state folder's name reaches its parent folder first.
  if (flushed.some((path) => path.startsWith("/"))) {
    assert.equal(flushed.length, 3);
    assert.equal(flushed[0], dir);
    assert.match(flushed[1]!, new RegExp(`^${join(dir, "state", "profile.json")}\\.[0-9a-f-]+\\.tmp$`));
    assert.equal(flushed[2], join(dir, "state"));
  } else assert.equal(flushed.length, 3);
});

test("autoSyncHours defaults to 6, takes 0.5, refuses 0, -1 and \"6\"", async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, "c.json");
  const base = { vaultPath: "/home/me/V", dataSourceId: "a50245e98e6a41aa8ccfd8795ed0dead" };
  await writeFile(file, JSON.stringify(base));
  assert.equal((await loadConfig(file)).autoSyncHours, 6);
  await writeFile(file, JSON.stringify({ ...base, autoSyncHours: 0.5 }));
  assert.equal((await loadConfig(file)).autoSyncHours, 0.5);
  for (const autoSyncHours of [0, -1, "6", null, Infinity]) {
    await writeFile(file, JSON.stringify({ ...base, autoSyncHours }));
    await assert.rejects(loadConfig(file), /"autoSyncHours"/, JSON.stringify(autoSyncHours));
  }
});

test("tagsProperty defaults to Tags, accepts a name or null, and rejects anything else", async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, "tags.json");
  const id = "a50245e98e6a41aa8ccfd8795ed0dead";
  const write = (extra: Record<string, unknown>) => writeFile(file, JSON.stringify({ vaultPath: "/v", dataSourceId: id, ...extra }));
  await write({});
  assert.equal((await loadConfig(file)).tagsProperty, "Tags");
  await write({ tagsProperty: "Labels" });
  assert.equal((await loadConfig(file)).tagsProperty, "Labels");
  await write({ tagsProperty: null });
  assert.equal((await loadConfig(file)).tagsProperty, null);
  await write({ tagsProperty: 3 });
  await assert.rejects(loadConfig(file), /"tagsProperty" must be a non-empty string/);
  await write({ tagsProperty: "" });
  await assert.rejects(loadConfig(file), /"tagsProperty" must be a non-empty string/);
});
