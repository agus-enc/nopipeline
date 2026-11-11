import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { scriptWith, signedRepo, toolsAvailable, type TagSpec } from "../helpers/signed-repo.ts";
import { tempDir } from "../helpers/tmp.ts";

const repo = new URL("../..", import.meta.url).pathname;
const skip = toolsAvailable() ? false : "git and ssh-keygen are needed to make signed test tags";

function tree(version: string, lockVersion = version, dependencies: Record<string, string> = {}): Record<string, string> {
  return {
    "package.json": JSON.stringify({ name: "nopipeline", version, dependencies }),
    "package-lock.json": JSON.stringify({ name: "nopipeline", version: lockVersion, lockfileVersion: 3, requires: true, packages: { "": { name: "nopipeline", version: lockVersion } } }),
    ".npmrc": "ignore-scripts=true\n",
    "src/cli.ts": "console.log(1);\n",
    "test/x.test.ts": "// test\n",
    "scripts/y.ts": "// script\n",
    ".gitattributes": "test/ export-ignore\nscripts/ export-ignore\n.github/ export-ignore\n",
  };
}

const tagged = (name: string, sign: TagSpec["sign"]): TagSpec => ({ name, sign, files: tree(name.replace(/^v/, "")) });

async function build(
  t: import("node:test").TestContext,
  tags: TagSpec[],
  opts: { files?: Record<string, string>; tag?: string; env?: Record<string, string> } = {},
) {
  const { url, signersLine } = await signedRepo(t, opts.files ?? tree("0.2.0"), tags);
  const script = scriptWith(signersLine);
  const result = join(await tempDir(t), "result");
  const args = [url, result, ...(opts.tag ? [opts.tag] : [])];
  const run = spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, NOPIPELINE_SKIP_AUDIT: "1", ...opts.env } });
  const listing = await readdir(result).catch(() => null);
  return { run, result, listing };
}

test("a tag signed with the release key builds", { skip }, async (t) => {
  const { run, result, listing } = await build(t, [{ name: "v0.2.0", sign: "release" }]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(listing, ["nopipeline-0.2.0.tar.gz"]);
  const names = spawnSync("tar", ["-tzf", join(result, "nopipeline-0.2.0.tar.gz")], { encoding: "utf8" }).stdout.split("\n");
  assert.ok(names.includes("nopipeline-0.2.0/src/cli.ts"));
  assert.ok(names.includes("nopipeline-0.2.0/version.json"));
  assert.ok(names.some((n) => n.startsWith("nopipeline-0.2.0/node_modules/")));
  assert.ok(!names.some((n) => /nopipeline-0\.2\.0\/(test|scripts)\//.test(n)));
  const extract = await tempDir(t);
  spawnSync("tar", ["-xzf", join(result, "nopipeline-0.2.0.tar.gz"), "-C", extract]);
  const info = JSON.parse(await readFile(join(extract, "nopipeline-0.2.0/version.json"), "utf8")) as { version: string; commit: string };
  assert.equal(info.version, "0.2.0");
  assert.match(info.commit, /^[0-9a-f]{40}$/);
});

test("the build records the tag's commit", { skip }, async (t) => {
  const { url, signersLine } = await signedRepo(t, tree("0.2.0"), [{ name: "v0.2.0", sign: "release" }]);
  const result = join(await tempDir(t), "r");
  const run = spawnSync("bash", [scriptWith(signersLine), url, result], { encoding: "utf8", env: { ...process.env, NOPIPELINE_SKIP_AUDIT: "1" } });
  assert.equal(run.status, 0, run.stderr);
  const head = spawnSync("git", ["-C", url, "rev-parse", "v0.2.0^{commit}"], { encoding: "utf8" }).stdout.trim();
  const extract = await tempDir(t);
  spawnSync("tar", ["-xzf", join(result, "nopipeline-0.2.0.tar.gz"), "-C", extract]);
  const info = JSON.parse(await readFile(join(extract, "nopipeline-0.2.0/version.json"), "utf8")) as { commit: string };
  assert.equal(info.commit, head);
});

for (const [title, sign] of [["an unsigned tag stops the build", "none"], ["a tag signed by another key stops the build", "other"]] as const) {
  test(title, { skip }, async (t) => {
    const { run, listing } = await build(t, [{ name: "v0.2.0", sign }]);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /^build-source: v0\.2\.0 is not signed by the release key/m);
    assert.equal(listing, null);
  });
}

test("the newest release tag is picked in version order", { skip }, async (t) => {
  const { run, listing } = await build(t, [
    tagged("v0.9.0", "release"),
    tagged("v0.10.0", "release"),
    tagged("v1.0.0-rc1", "none"),
    tagged("test", "none"),
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(listing, ["nopipeline-0.10.0.tar.gz"]);
});

test("a tag can be named", { skip }, async (t) => {
  const { run, listing } = await build(t, [tagged("v0.9.0", "release"), tagged("v0.10.0", "release")], { tag: "v0.9.0" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(listing, ["nopipeline-0.9.0.tar.gz"]);
});

test("a tag name that is not a release tag is refused", { skip }, async (t) => {
  const { run, listing } = await build(t, [tagged("v0.9.0", "release")], { tag: "--output=x" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^build-source: /m);
  assert.equal(listing, null);
});

test("no release tag stops the build", { skip }, async (t) => {
  const { run, listing } = await build(t, [{ name: "test", sign: "release" }]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /no release tag/);
  assert.equal(listing, null);
});

test("a version that doesn't match the tag stops the build", { skip }, async (t) => {
  const { run, listing } = await build(t, [{ name: "v0.3.0", sign: "release" }]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /package\.json says 0\.2\.0 but the tag is v0\.3\.0/);
  assert.equal(listing, null);
});

test("npm ci failing stops the build", { skip }, async (t) => {
  const { run, listing } = await build(t, [{ name: "v0.2.0", sign: "release" }], { files: { ...tree("0.2.0"), "package.json": JSON.stringify({ name: "nopipeline", version: "0.2.0", dependencies: { left: "1.0.0" } }) } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^build-source: /m);
  assert.equal(listing, null);
});

test("an unfilled release key stops the build", { skip }, async (t) => {
  const { url } = await signedRepo(t, tree("0.2.0"), [{ name: "v0.2.0", sign: "release" }]);
  const result = join(await tempDir(t), "r");
  const run = spawnSync("bash", [join(repo, "packaging/build-source.sh"), url, result], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^build-source: the release key was not filled in/m);
});

test("without NOPIPELINE_SKIP_AUDIT, npm audit signatures runs (and fails on an empty tree)", { skip }, async (t) => {
  const { run, listing } = await build(t, [{ name: "v0.2.0", sign: "release" }], { env: { NOPIPELINE_SKIP_AUDIT: "" } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^build-source: npm audit signatures failed/m);
  assert.equal(listing, null);
});

test("NOPIPELINE_SKIP_AUDIT is refused when the tree has dependencies", { skip }, async (t) => {
  const files = tree("0.2.0");
  files["package.json"] = JSON.stringify({ name: "nopipeline", version: "0.2.0", dependencies: { left: "1.0.0" } });
  files["package-lock.json"] = JSON.stringify({
    name: "nopipeline", version: "0.2.0", lockfileVersion: 3, requires: true,
    packages: { "": { name: "nopipeline", version: "0.2.0", dependencies: { left: "1.0.0" } } },
  });
  const { run, listing } = await build(t, [{ name: "v0.2.0", sign: "release" }], { files, env: { NOPIPELINE_SKIP_AUDIT: "1" } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^build-source: NOPIPELINE_SKIP_AUDIT is only allowed/m);
  assert.equal(listing, null);
});

test("the tracked script holds the placeholder and reads no key from the repo", async () => {
  const text = await readFile(join(repo, "packaging/build-source.sh"), "utf8");
  assert.equal(text.split("@RELEASE_SIGNERS@").length - 1, 1);
  assert.ok(!text.includes(".release-signers"));
});
