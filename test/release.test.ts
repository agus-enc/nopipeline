import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { checkRelease, fetchOrigin } from "../scripts/release.ts";
import { tempDir } from "./helpers/tmp.ts";

const SIGNERS = "releases ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n";
const TAGS = "git tag --list v[0-9]*.[0-9]*.[0-9]* --sort=-v:refname";
const DIFF = "git diff --quiet v0.1.0 HEAD -- packaging/build-source.sh";

const happy: Record<string, string | Error> = {
  "git status --porcelain": "",
  "git rev-parse --abbrev-ref HEAD": "main\n",
  "git rev-parse HEAD": "aaa\n",
  "git rev-parse origin/main": "aaa\n",
  "git tag --list v0.2.0": "",
  "git ls-remote --tags origin v0.2.0": "",
  [TAGS]: "v0.2.0\nv0.1.0\nv0.1.0-rc1\n",
  [DIFF]: "",
};

async function run(t: import("node:test").TestContext, over: Record<string, string | Error> = {}, opts: { signers?: string | null; changelog?: string; version?: string } = {}) {
  const root = await tempDir(t);
  await writeFile(join(root, "package.json"), JSON.stringify({ version: opts.version ?? "0.2.0" }));
  await writeFile(join(root, "CHANGELOG.md"), opts.changelog ?? "# Changelog\n\n## 0.2.0 — 2026-11-07\n\n- x\n\n## 0.1.0 — 2026-10-01\n");
  if (opts.signers !== null) await writeFile(join(root, ".release-signers"), opts.signers ?? SIGNERS);
  const table = { ...happy, ...over };
  const calls: string[] = [];
  const git = async (args: string[]): Promise<string> => {
    const key = `git ${args.join(" ")}`;
    calls.push(key);
    const v = table[key];
    if (v === undefined) throw new Error(`unexpected git call: ${key}`);
    if (v instanceof Error) throw v;
    return v;
  };
  return { result: await checkRelease(git, root), calls };
}

test("the happy path returns the three commands for 0.2.0", async (t) => {
  const { result } = await run(t);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.version, "0.2.0");
  assert.deepEqual(result.commands, ['git tag -s v0.2.0 -m "nopipeline 0.2.0"', "git push origin v0.2.0", "copr-cli build-package chipp/nopipeline --name nopipeline"]);
});

test("a dirty working tree is a problem", async (t) => {
  const { result } = await run(t, { "git status --porcelain": " M src/cli.ts\n" });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /working tree is not clean/);
});

test("being off main is a problem", async (t) => {
  const { result } = await run(t, { "git rev-parse --abbrev-ref HEAD": "feat/x\n" });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /not on main/);
});

test("HEAD different from origin/main is a problem", async (t) => {
  const { result } = await run(t, { "git rev-parse origin/main": "bbb\n" });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /origin\/main/);
});

test("a package.json version that differs from the newest CHANGELOG heading is a problem", async (t) => {
  const { result } = await run(t, {}, { changelog: "# Changelog\n\n## 0.3.0 — 2026-12-01\n" });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /0\.2\.0.*0\.3\.0/);
});

test("a CHANGELOG without a version heading is a problem", async (t) => {
  const { result } = await run(t, {}, { changelog: "# Changelog\n" });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /CHANGELOG\.md has no version heading/);
});

test("an existing local tag is a problem", async (t) => {
  const { result } = await run(t, { "git tag --list v0.2.0": "v0.2.0\n" });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /v0\.2\.0 already exists locally/);
});

test("a tag already on origin is a problem", async (t) => {
  const { result } = await run(t, { "git ls-remote --tags origin v0.2.0": "ccc\trefs/tags/v0.2.0\n" });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /v0\.2\.0 already exists on origin/);
});

test("a missing .release-signers is a problem", async (t) => {
  const { result } = await run(t, {}, { signers: null });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /\.release-signers/);
});

test("a .release-signers with two lines or the wrong shape is a problem", async (t) => {
  for (const signers of [SIGNERS + SIGNERS, "bob ssh-ed25519 AAAA\n", "releases ssh-rsa AAAA\n", ""]) {
    const { result } = await run(t, {}, { signers });
    assert.equal(result.problems.length, 1, JSON.stringify(signers));
    assert.match(result.problems[0]!, /\.release-signers/);
  }
});

test("a .release-signers with a comment, blank lines or CRLF is a problem (the build script accepts only the one line)", async (t) => {
  for (const signers of ["releases ssh-ed25519 AAAA maintainer key\n", "\nreleases ssh-ed25519 AAAA\n", "releases ssh-ed25519 AAAA\n\n", "releases ssh-ed25519 AAAA\r\n"]) {
    const { result } = await run(t, {}, { signers });
    assert.equal(result.problems.length, 1, JSON.stringify(signers));
    assert.match(result.problems[0]!, /\.release-signers/);
  }
  const { result } = await run(t, {}, { signers: "releases ssh-ed25519 AAAA" });
  assert.deepEqual(result.problems, [], "no trailing newline is fine");
});

test("a changed build-source.sh warns with the previous tag, and is not a problem", async (t) => {
  const { result } = await run(t, { [DIFF]: exitWith(1) });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.warnings, ["packaging/build-source.sh changed since v0.1.0: update the Copr package's script before building"]);
});

const exitWith = (code: number) => Object.assign(new Error(`exit ${code}`), { code });

test("a build-source.sh comparison that fails for another reason is a problem, not the changed warning", async (t) => {
  const { result } = await run(t, { [DIFF]: exitWith(128) });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /comparison failed/);
  assert.match(result.problems[0]!, /v0\.1\.0/);
});

test("an exit code 1 from the diff is the changed warning", async (t) => {
  const { result } = await run(t, { [DIFF]: exitWith(1) });
  assert.deepEqual(result.problems, []);
  assert.equal(result.warnings.length, 1);
});

test("a missing origin/main is a problem, not a stack trace", async (t) => {
  const { result } = await run(t, { "git rev-parse origin/main": exitWith(128) });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /origin\/main/);
});

test("a .release-signers with CRLF line endings gets its own message", async (t) => {
  const { result } = await run(t, {}, { signers: "releases ssh-ed25519 AAAA\r\n" });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /Windows line endings \(CRLF\); save it with LF/);
});

test("fetchOrigin returns null on success and a problem line when the fetch fails", async () => {
  const seen: string[][] = [];
  assert.equal(await fetchOrigin(async (args) => (seen.push(args), "")), null);
  assert.deepEqual(seen, [["fetch", "origin", "--tags"]]);
  const problem = await fetchOrigin(async () => {
    throw exitWith(128);
  });
  assert.match(problem ?? "", /git fetch origin --tags failed/);
});

test("no previous tag means no warning and no diff", async (t) => {
  const { result, calls } = await run(t, { [TAGS]: "v0.2.0\n" });
  assert.deepEqual(result.warnings, []);
  assert.ok(!calls.some((c) => c.startsWith("git diff")));
});

test("the checker only reads: no tag, push or fetch call", async (t) => {
  const { calls } = await run(t);
  for (const c of calls) assert.doesNotMatch(c, /^git (tag -s|push|fetch)/);
});
