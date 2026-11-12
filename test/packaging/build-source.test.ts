import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { scriptWith, signedRepo, toolsAvailable, type TagSpec } from "../helpers/signed-repo.ts";
import { tempDir } from "../helpers/tmp.ts";
import { readFileSync } from "node:fs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
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
    "packaging/fedora/nopipeline.spec.in": readFileSync(fileURLToPath(new URL("../../packaging/fedora/nopipeline.spec.in", import.meta.url)), "utf8"),
  };
}

const debianFiles = ["nopipeline.dsc.in", "debian.control", "debian.rules", "debian.changelog.in", "debian.copyright"];
function debianTree(version: string): Record<string, string> {
  const files = tree(version);
  for (const name of debianFiles) {
    files[`packaging/debian/${name}`] = readFileSync(fileURLToPath(new URL(`../../packaging/debian/${name}`, import.meta.url)), "utf8");
  }
  return files;
}

const archFiles = ["PKGBUILD.in", "nopipeline.install"];
function archTree(version: string): Record<string, string> {
  const files = tree(version);
  for (const name of archFiles) {
    files[`packaging/arch/${name}`] = readFileSync(fileURLToPath(new URL(`../../packaging/arch/${name}`, import.meta.url)), "utf8");
  }
  return files;
}

const tagged = (name: string, sign: TagSpec["sign"]): TagSpec => ({ name, sign, files: tree(name.replace(/^v/, "")) });

async function build(
  t: import("node:test").TestContext,
  tags: TagSpec[],
  opts: { files?: Record<string, string>; tag?: string; signers?: (line: string) => string; gnupg?: boolean; env?: Record<string, string>; shell?: string; envFor?: (dir: string) => Promise<Record<string, string>> } = {},
) {
  const { url, signersLine, gnupgHome } = await signedRepo(t, opts.files ?? tree("0.2.0"), tags);
  const script = scriptWith(opts.signers ? opts.signers(signersLine) : signersLine);
  const result = join(await tempDir(t), "result");
  const args = [url, result, ...(opts.tag ? [opts.tag] : [])];
  const extra = { ...(opts.gnupg ? { GNUPGHOME: gnupgHome } : {}), ...(opts.envFor ? await opts.envFor(await tempDir(t)) : {}) };
  const run = spawnSync(opts.shell ?? "/bin/sh", [script, ...args], { encoding: "utf8", env: { ...process.env, NOPIPELINE_SKIP_AUDIT: "1", NOPIPELINE_REPO_KEYS: "", ...opts.env, ...extra } });
  const listing = await readdir(result).catch(() => null);
  return { run, result, listing };
}

test("a tag signed with the release key builds", { skip }, async (t) => {
  const { run, result, listing } = await build(t, [{ name: "v0.2.0", sign: "release" }]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(listing, ["nopipeline.spec", "nopipeline.tar.gz", "version"]);
  const spec = await readFile(join(result, "nopipeline.spec"), "utf8");
  assert.match(spec, /^Version:\s+0\.2\.0$/m);
  assert.doesNotMatch(spec, /@[A-Z]+@/, "no placeholder is left in the spec");
  assert.match(spec, /^\* (Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d\d \d{4} nopipeline <noreply@github\.com> - 0\.2\.0-1$/m);
  assert.match(spec, /^Source0:\s+nopipeline\.tar\.gz$/m);
  assert.doesNotMatch(spec, /^BuildRequires/m, "the rpm needs no Node to build");
  assert.doesNotMatch(spec, /^%check/m);
  assert.equal(await readFile(join(result, "version"), "utf8"), "0.2.0\n");
  assert.doesNotMatch(spec, /^Provides:\s+bundled/m, "a tree with no dependencies bundles nothing");
  const names = spawnSync("tar", ["-tzf", join(result, "nopipeline.tar.gz")], { encoding: "utf8" }).stdout.split("\n");
  assert.ok(names.includes("nopipeline-0.2.0/src/cli.ts"));
  assert.ok(names.includes("nopipeline-0.2.0/version.json"));
  assert.ok(names.some((n) => n.startsWith("nopipeline-0.2.0/node_modules/")));
  assert.ok(!names.some((n) => /nopipeline-0\.2\.0\/(test|scripts)\//.test(n)));
  const extract = await tempDir(t);
  spawnSync("tar", ["-xzf", join(result, "nopipeline.tar.gz"), "-C", extract]);
  const info = JSON.parse(await readFile(join(extract, "nopipeline-0.2.0/version.json"), "utf8")) as { version: string; commit: string };
  assert.equal(info.version, "0.2.0");
  assert.match(info.commit, /^[0-9a-f]{40}$/);
});

test("the Debian recipe is rendered", { skip }, async (t) => {
  const { run, result, listing } = await build(t, [{ name: "v0.2.0", sign: "release" }], { files: debianTree("0.2.0") });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(listing, ["debian.changelog", "debian.control", "debian.copyright", "debian.rules", "nopipeline.dsc", "nopipeline.spec", "nopipeline.tar.gz", "version"]);
  for (const name of ["nopipeline.dsc", "debian.control", "debian.copyright", "debian.rules", "debian.changelog"]) {
    assert.doesNotMatch(await readFile(join(result, name), "utf8"), /@[A-Z0-9_]+@/, `no placeholder is left in ${name}`);
  }
  const dsc = await readFile(join(result, "nopipeline.dsc"), "utf8");
  assert.match(dsc, /^Version: 0\.2\.0-1$/m);
  assert.match(dsc, /^Source: nopipeline$/m);
  assert.match(dsc, /^Debtransform-Tar: nopipeline\.tar\.gz$/m);
  assert.match(dsc, /^Format: /m);
  assert.doesNotMatch(dsc, /nodejs/i, "no Node in Build-Depends");
  const tarball = await readFile(join(result, "nopipeline.tar.gz"));
  const size = (await stat(join(result, "nopipeline.tar.gz"))).size;
  assert.ok(dsc.includes(`\n ${createHash("sha256").update(tarball).digest("hex")} ${size} nopipeline.tar.gz\n`), "sha256 line");
  assert.ok(dsc.includes(`\n ${createHash("md5").update(tarball).digest("hex")} ${size} nopipeline.tar.gz\n`), "md5 line");
  const changelog = await readFile(join(result, "debian.changelog"), "utf8");
  assert.equal(changelog.split("\n")[0], "nopipeline (0.2.0-1) unstable; urgency=medium");
  assert.match(changelog, /^ -- nopipeline <noreply@github\.com>  (Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d\d [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d \+0000$/m);
  const control = await readFile(join(result, "debian.control"), "utf8");
  assert.match(control, /^Depends: nodejs \(>= 22\.22\), \$\{misc:Depends\}$/m);
  assert.match(control, /^Architecture: all$/m);
  assert.match(control, /^Recommends: libnotify-bin, xdg-utils$/m);
  assert.doesNotMatch(control, /^Build-Depends:.*node/m);
  assert.ok(((await stat(join(result, "debian.rules"))).mode & 0o111) !== 0, "debian.rules is executable");
  const copyright = await readFile(join(result, "debian.copyright"), "utf8");
  assert.match(copyright, /^Format: https:\/\/www\.debian\.org\/doc\/packaging-manuals\/copyright-format\/1\.0\/$/m);
  for (const files of ["*", "node_modules/@notionhq/client/*", "node_modules/node-diff3/*"]) assert.ok(copyright.includes(`\nFiles: ${files}\n`), files);
  assert.equal(copyright.split("\nLicense: MIT\n").length - 1, 4, "three Files stanzas and the license text");
});

test("a tag without packaging/debian renders no Debian files", { skip }, async (t) => {
  const { run, listing } = await build(t, [{ name: "v0.2.0", sign: "release" }]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(listing, ["nopipeline.spec", "nopipeline.tar.gz", "version"]);
});

const keyNames = ["nopipeline-archive-keyring.gpg", "nopipeline.gpg", "nopipeline-trusted"];
test("the Arch recipe is rendered", { skip }, async (t) => {
  const { run, result, listing } = await build(t, [{ name: "v0.2.0", sign: "release" }], { files: archTree("0.2.0") });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(listing, ["PKGBUILD", "nopipeline.install", "nopipeline.spec", "nopipeline.tar.gz", "version"]);
  for (const name of ["PKGBUILD", "nopipeline.install"]) {
    assert.doesNotMatch(await readFile(join(result, name), "utf8"), /@[A-Z0-9_]+@/, `no placeholder is left in ${name}`);
  }
  const pkgbuild = await readFile(join(result, "PKGBUILD"), "utf8");
  assert.match(pkgbuild, /^pkgname=nopipeline$/m);
  assert.match(pkgbuild, /^pkgver=0\.2\.0$/m);
  assert.match(pkgbuild, /^pkgrel=1$/m);
  assert.match(pkgbuild, /^arch=\('any'\)$/m);
  assert.match(pkgbuild, /^depends=\('nodejs>=22\.22'\)$/m);
  assert.match(pkgbuild, /^source=\('nopipeline\.tar\.gz'\)$/m);
  assert.match(pkgbuild, /^install=nopipeline\.install$/m);
  const sha256 = createHash("sha256").update(await readFile(join(result, "nopipeline.tar.gz"))).digest("hex");
  assert.ok(pkgbuild.includes(`\nsha256sums=('${sha256}')\n`), "sha256 of the tarball");
  const install = await readFile(join(result, "nopipeline.install"), "utf8");
  for (const fn of ["post_install", "post_upgrade"]) {
    assert.match(install, new RegExp(`^${fn}\\(\\) \\{\\n  pacman-key --populate nopipeline \\|\\|\\n`, "m"), `${fn} runs the populate with a fallback`);
  }
});

test("a tag without packaging/arch renders no Arch files", { skip }, async (t) => {
  const { run, listing } = await build(t, [{ name: "v0.2.0", sign: "release" }]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(listing, ["nopipeline.spec", "nopipeline.tar.gz", "version"]);
});

async function keysDir(t: import("node:test").TestContext, names = keyNames): Promise<string> {
  const dir = join(await tempDir(t), "keys");
  await mkdir(dir);
  for (const name of names) await writeFile(join(dir, name), `dummy ${name}\n`);
  return dir;
}

test("repo keys are baked into the tarball", { skip }, async (t) => {
  const keys = await keysDir(t);
  const { run, result, listing } = await build(t, [{ name: "v0.2.0", sign: "release" }], { env: { NOPIPELINE_REPO_KEYS: keys } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(listing, ["nopipeline.spec", "nopipeline.tar.gz", "version"]);
  const names = spawnSync("tar", ["-tzf", join(result, "nopipeline.tar.gz")], { encoding: "utf8" }).stdout.split("\n");
  for (const name of keyNames) assert.ok(names.includes(`nopipeline-0.2.0/keys/${name}`), name);
  const extract = await tempDir(t);
  spawnSync("tar", ["-xzf", join(result, "nopipeline.tar.gz"), "-C", extract]);
  assert.equal(await readFile(join(extract, "nopipeline-0.2.0/keys/nopipeline.gpg"), "utf8"), "dummy nopipeline.gpg\n");
});

test("without NOPIPELINE_REPO_KEYS the tarball has no keys folder", { skip }, async (t) => {
  const { run, result } = await build(t, [{ name: "v0.2.0", sign: "release" }], { env: { NOPIPELINE_REPO_KEYS: "" } });
  assert.equal(run.status, 0, run.stderr);
  const names = spawnSync("tar", ["-tzf", join(result, "nopipeline.tar.gz")], { encoding: "utf8" }).stdout.split("\n");
  assert.ok(!names.some((n) => n.includes("/keys")));
});

test("an unexpected file in the keys folder stops the build", { skip }, async (t) => {
  const keys = await keysDir(t, [...keyNames, "extra.txt"]);
  const { run, listing } = await build(t, [{ name: "v0.2.0", sign: "release" }], { env: { NOPIPELINE_REPO_KEYS: keys } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^build-source: .*extra\.txt/m);
  assert.equal(listing, null);
});

test("a missing key file stops the build", { skip }, async (t) => {
  const keys = await keysDir(t, keyNames.slice(0, 2));
  const { run, listing } = await build(t, [{ name: "v0.2.0", sign: "release" }], { env: { NOPIPELINE_REPO_KEYS: keys } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^build-source: .*nopipeline-trusted/m);
  assert.equal(listing, null);
});

test("a symlink or a subfolder in the keys folder stops the build", { skip }, async (t) => {
  const link = await keysDir(t);
  await rm(join(link, "nopipeline.gpg"));
  await symlink(join(link, "nopipeline-trusted"), join(link, "nopipeline.gpg"));
  const a = await build(t, [{ name: "v0.2.0", sign: "release" }], { env: { NOPIPELINE_REPO_KEYS: link } });
  assert.notEqual(a.run.status, 0);
  assert.match(a.run.stderr, /^build-source: /m);
  assert.equal(a.listing, null);
  const sub = await keysDir(t);
  await mkdir(join(sub, "sub"));
  const b = await build(t, [{ name: "v0.2.0", sign: "release" }], { env: { NOPIPELINE_REPO_KEYS: sub } });
  assert.notEqual(b.run.status, 0);
  assert.match(b.run.stderr, /^build-source: /m);
  assert.equal(b.listing, null);
});

test("an empty keys folder or a path that does not exist stops the build", { skip }, async (t) => {
  const empty = join(await tempDir(t), "keys");
  await mkdir(empty);
  const a = await build(t, [{ name: "v0.2.0", sign: "release" }], { env: { NOPIPELINE_REPO_KEYS: empty } });
  assert.notEqual(a.run.status, 0);
  assert.match(a.run.stderr, /^build-source: the keys folder has no /m);
  assert.equal(a.listing, null);
  const b = await build(t, [{ name: "v0.2.0", sign: "release" }], { env: { NOPIPELINE_REPO_KEYS: join(empty, "nope") } });
  assert.notEqual(b.run.status, 0);
  assert.match(b.run.stderr, /^build-source: NOPIPELINE_REPO_KEYS is not a folder/m);
  assert.equal(b.listing, null);
});

test("the keys folder is checked before npm ci runs", { skip }, async (t) => {
  const files = { ...tree("0.2.0"), "package.json": JSON.stringify({ name: "nopipeline", version: "0.2.0", dependencies: { left: "1.0.0" } }) };
  const { run, listing } = await build(t, [{ name: "v0.2.0", sign: "release" }], { files, env: { NOPIPELINE_REPO_KEYS: join(await tempDir(t), "nope") } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^build-source: NOPIPELINE_REPO_KEYS is not a folder/m);
  assert.doesNotMatch(run.stderr, /npm ci failed/);
  assert.equal(listing, null);
});

test("a tagged tree that already has a keys folder stops the build with a clear message", { skip }, async (t) => {
  const keys = await keysDir(t);
  const files = { ...tree("0.2.0"), "keys/other.txt": "x\n" };
  const { run, listing } = await build(t, [{ name: "v0.2.0", sign: "release" }], { files, env: { NOPIPELINE_REPO_KEYS: keys } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^build-source: the tagged tree already has a keys folder/m);
  assert.equal(listing, null);
});

test("the build records the tag's commit", { skip }, async (t) => {
  const { url, signersLine } = await signedRepo(t, tree("0.2.0"), [{ name: "v0.2.0", sign: "release" }]);
  const result = join(await tempDir(t), "r");
  const run = spawnSync("/bin/sh", [scriptWith(signersLine), url, result], { encoding: "utf8", env: { ...process.env, NOPIPELINE_SKIP_AUDIT: "1" } });
  assert.equal(run.status, 0, run.stderr);
  const head = spawnSync("git", ["-C", url, "rev-parse", "v0.2.0^{commit}"], { encoding: "utf8" }).stdout.trim();
  const extract = await tempDir(t);
  spawnSync("tar", ["-xzf", join(result, "nopipeline.tar.gz"), "-C", extract]);
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

const skipGpg = toolsAvailable(["gpg"]) ? false : "gpg is needed to make a PGP-signed test tag";
test("a tag signed with OpenPGP (key in the builder's keyring) is refused", { skip: skipGpg }, async (t) => {
  const { run, listing } = await build(t, [{ name: "v0.2.0", sign: "pgp" }], { gnupg: true });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^build-source: v0\.2\.0 is not signed by the release key/m);
  assert.doesNotMatch(run.stderr, /\(\)/);
  assert.equal(listing, null);
});

test("a two-line release key value is refused", { skip }, async (t) => {
  const { run, listing } = await build(t, [{ name: "v0.2.0", sign: "release" }], { signers: (line) => `${line}\nreleases ssh-ed25519 AAAA` });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^build-source: the release key line is malformed/m);
  assert.equal(listing, null);
});

test("the newest release tag is picked in version order", { skip }, async (t) => {
  const { run, listing } = await build(t, [
    tagged("v0.9.0", "release"),
    tagged("v0.10.0", "release"),
    tagged("v1.0.0-rc1", "none"),
    tagged("test", "none"),
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(listing, ["nopipeline.spec", "nopipeline.tar.gz", "version"]);
});

test("a tag can be named", { skip }, async (t) => {
  const { run, listing } = await build(t, [tagged("v0.9.0", "release"), tagged("v0.10.0", "release")], { tag: "v0.9.0" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(listing, ["nopipeline.spec", "nopipeline.tar.gz", "version"]);
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
  const run = spawnSync("/bin/sh", [join(repo, "packaging/build-source.sh"), url, result], { encoding: "utf8" });
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
    packages: {
      "": { name: "nopipeline", version: "0.2.0", dependencies: { left: "1.0.0" } },
      "node_modules/left": { version: "1.0.0", resolved: "https://registry.npmjs.org/left/-/left-1.0.0.tgz" },
    },
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

// A fake ssh-keygen that vouches for any signature.
async function fakeSigner(dir: string): Promise<string> {
  const program = join(dir, "fake-ssh-keygen");
  await writeFile(program, '#!/bin/sh\ncase "$*" in *find-principals*) echo releases;; *) echo \'Good "git" signature for releases with ED25519 key SHA256:forged\';; esac\nexit 0\n');
  await chmod(program, 0o755);
  return program;
}

test("GIT_* variables in the environment are dropped (GIT_TRACE writes nothing)", { skip }, async (t) => {
  const trace = join(await tempDir(t), "trace");
  const { run } = await build(t, [{ name: "v0.2.0", sign: "release" }], { env: { GIT_TRACE: trace } });
  assert.equal(run.status, 0, run.stderr);
  await assert.rejects(stat(trace), "git was not told to trace");
});

test("git config in the environment cannot replace the signature verifier (GIT_CONFIG_COUNT)", { skip }, async (t) => {
  const { run, listing } = await build(t, [{ name: "v0.2.0", sign: "other" }], {
    envFor: async (dir) => ({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "gpg.ssh.program", GIT_CONFIG_VALUE_0: await fakeSigner(dir) }),
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^build-source: v0\.2\.0 is not signed by the release key/m);
  assert.equal(listing, null);
});

test("git config in the environment cannot replace the signature verifier (GIT_CONFIG_PARAMETERS)", { skip }, async (t) => {
  const { run, listing } = await build(t, [{ name: "v0.2.0", sign: "other" }], {
    envFor: async (dir) => ({ GIT_CONFIG_PARAMETERS: `'gpg.ssh.program=${await fakeSigner(dir)}'` }),
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^build-source: v0\.2\.0 is not signed by the release key/m);
  assert.equal(listing, null);
});

test("an optional dependency does not let NOPIPELINE_SKIP_AUDIT through", { skip }, async (t) => {
  const files = tree("0.2.0");
  files["package.json"] = JSON.stringify({ name: "nopipeline", version: "0.2.0", dependencies: {}, optionalDependencies: { left: "1.0.0" } });
  files["package-lock.json"] = JSON.stringify({
    name: "nopipeline", version: "0.2.0", lockfileVersion: 3, requires: true,
    packages: {
      "": { name: "nopipeline", version: "0.2.0", optionalDependencies: { left: "1.0.0" } },
      "node_modules/left": { version: "1.0.0", resolved: "https://registry.npmjs.org/left/-/left-1.0.0.tgz", optional: true },
    },
  });
  const { run, listing } = await build(t, [{ name: "v0.2.0", sign: "release" }], { files });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^build-source: NOPIPELINE_SKIP_AUDIT is only allowed/m);
  assert.equal(listing, null);
});

test("NOPIPELINE_SKIP_AUDIT is refused when npm ci installed something the lockfile check missed (lockfileVersion 1)", { skip }, async (t) => {
  const files = tree("0.2.0");
  files["package.json"] = JSON.stringify({ name: "nopipeline", version: "0.2.0", dependencies: { left: "1.0.0" } });
  files["package-lock.json"] = JSON.stringify({ name: "nopipeline", version: "0.2.0", lockfileVersion: 1, requires: true, dependencies: { left: { version: "1.0.0" } } });
  const bin = join(await tempDir(t), "bin");
  await mkdir(bin);
  await writeFile(join(bin, "npm"), '#!/bin/sh\nif [ "$1" = ci ]; then mkdir -p node_modules/left && echo "{}" >node_modules/left/package.json; fi\n');
  await chmod(join(bin, "npm"), 0o755);
  const { run, listing } = await build(t, [{ name: "v0.2.0", sign: "release" }], { files, env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^build-source: NOPIPELINE_SKIP_AUDIT is only allowed/m);
  assert.equal(listing, null);
});

const dash = spawnSync("which", ["dash"], { stdio: "ignore" }).status === 0;
test("the script runs under dash", { skip: skip || (dash ? false : "dash is not installed") }, async (t) => {
  const { run, listing } = await build(t, [{ name: "v0.2.0", sign: "release" }], { shell: "dash" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(listing, ["nopipeline.spec", "nopipeline.tar.gz", "version"]);
});

test("with no arguments the script clones the default repository into the current folder", { skip }, async (t) => {
  const dir = await tempDir(t);
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "git"), '#!/bin/sh\necho "fake git $*" >&2\nexit 1\n');
  await chmod(join(bin, "git"), 0o755);
  const cwd = join(dir, "cwd");
  await mkdir(cwd);
  const { signersLine } = await signedRepo(t, tree("0.2.0"), [{ name: "v0.2.0", sign: "release" }]);
  const run = spawnSync("/bin/sh", [scriptWith(signersLine)], { cwd, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^build-source: cannot clone https:\/\/github\.com\/agus-enc\/nopipeline\.git/m);
  assert.deepEqual(await readdir(cwd), []);
});

test("the spec lists the production packages of the lockfile that npm ci installed", { skip }, async (t) => {
  const files = tree("0.2.0");
  const entry = (version?: string, extra: object = {}) => ({ ...(version ? { version } : {}), resolved: "https://registry.npmjs.org/x/-/x.tgz", ...extra });
  files["package-lock.json"] = JSON.stringify({
    name: "nopipeline", version: "0.2.0", lockfileVersion: 3, requires: true,
    packages: {
      "": { name: "nopipeline", version: "0.2.0" },
      "node_modules/@scope/name": entry("1.2.3"),
      "node_modules/a": entry("2.0.0"),
      "node_modules/a/node_modules/b": entry("4.5.6"),
      "node_modules/devonly": entry("7.0.0", { dev: true }),
      "node_modules/linked": { resolved: "../linked", link: true },
      "node_modules/opt": entry("8.0.0", { optional: true }),
    },
  });
  // A stand-in for npm: ci installs every entry that is not dev, a link or the optional one; audit succeeds.
  const bin = join(await tempDir(t), "bin");
  await mkdir(bin);
  await writeFile(join(bin, "npm"), `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "ci") {
  const packages = JSON.parse(fs.readFileSync("package-lock.json", "utf8")).packages;
  for (const [key, info] of Object.entries(packages)) {
    if (key === "" || info.dev || info.link || info.optional) continue;
    fs.mkdirSync(key, { recursive: true });
    fs.writeFileSync(key + "/package.json", key === "node_modules/a" ? '{"version":"2.1.0"}' : "{}");
  }
}
`);
  await chmod(join(bin, "npm"), 0o755);
  const { run, result } = await build(t, [{ name: "v0.2.0", sign: "release" }], { files, env: { NOPIPELINE_SKIP_AUDIT: "", PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(run.status, 0, run.stderr);
  const provides = (await readFile(join(result, "nopipeline.spec"), "utf8")).split("\n").filter((l) => /^Provides:\s+bundled/.test(l));
  assert.equal(provides.length, 3, provides.join("\n"));
  assert.match(provides[0] ?? "", /^Provides:\s+bundled\(nodejs-@scope\/name\) = 1\.2\.3$/);
  assert.match(provides[1] ?? "", /^Provides:\s+bundled\(nodejs-a\) = 2\.1\.0$/);
  assert.match(provides[2] ?? "", /^Provides:\s+bundled\(nodejs-b\) = 4\.5\.6$/);
});
