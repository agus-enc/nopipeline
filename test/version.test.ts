import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { versionString } from "../src/version.ts";
import { tempDir } from "./helpers/tmp.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));

test("versionString reads version.json when the package has one", async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "version.json"), JSON.stringify({ version: "0.2.0", commit: "abc" }));
  await writeFile(join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
  assert.equal(await versionString(dir), "0.2.0");
});

test("versionString says where a clone runs from", async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.2.0" }));
  assert.equal(await versionString(dir), `0.2.0 (from ${dir})`);
});

test("the newest CHANGELOG heading is package.json's version", async () => {
  const changelog = await readFile(join(repo, "CHANGELOG.md"), "utf8");
  const heading = changelog.split("\n").map((l) => /^## (\d+\.\d+\.\d+) — \d{4}-\d{2}-\d{2}$/.exec(l)).find((m) => m !== null);
  assert.ok(heading, "CHANGELOG.md has a version heading");
  const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8")) as { version: string };
  assert.equal(heading[1], pkg.version);
});

test("src has no dynamic import", async () => {
  const entries = await readdir(join(repo, "src"), { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".ts")) continue;
    const file = join(e.parentPath, e.name);
    assert.doesNotMatch(await readFile(file, "utf8"), /\bimport\s*\(/, `${file} uses a dynamic import`);
  }
});
