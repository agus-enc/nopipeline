import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { scriptWith, signedRepo, toolsAvailable, type TagSpec } from "../helpers/signed-repo.ts";
import { tempDir } from "../helpers/tmp.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const real = (path: string) => readFileSync(join(repo, path), "utf8");
const skip = toolsAvailable() ? false : "git and ssh-keygen are needed to make signed test tags";

function tree(version: string, buildSource = real("packaging/build-source.sh")): Record<string, string> {
  return {
    "package.json": JSON.stringify({ name: "nopipeline", version, dependencies: {} }),
    "package-lock.json": JSON.stringify({ name: "nopipeline", version, lockfileVersion: 3, requires: true, packages: { "": { name: "nopipeline", version } } }),
    ".npmrc": "ignore-scripts=true\n",
    "src/cli.ts": "console.log(1);\n",
    "packaging/build-source.sh": buildSource,
    "packaging/fedora/nopipeline.spec.in": real("packaging/fedora/nopipeline.spec.in"),
  };
}
const tagged = (name: string, sign: TagSpec["sign"], buildSource?: string): TagSpec => ({ name, sign, files: tree(name.replace(/^v/, ""), buildSource) });

async function bootstrap(
  t: import("node:test").TestContext,
  tags: TagSpec[],
  opts: { args?: (url: string) => string[]; signers?: (line: string) => string; gnupg?: boolean; env?: Record<string, string>; shell?: string; envFor?: (dir: string) => Promise<Record<string, string>> } = {},
) {
  const { url, signersLine, gnupgHome } = await signedRepo(t, tree("0.0.0"), tags);
  const script = scriptWith(opts.signers ? opts.signers(signersLine) : signersLine, "copr-bootstrap.sh");
  const cwd = await tempDir(t);
  const extra = { ...(opts.gnupg ? { GNUPGHOME: gnupgHome } : {}), ...(opts.envFor ? await opts.envFor(await tempDir(t)) : {}) };
  const run = spawnSync(opts.shell ?? "/bin/sh", [script, ...(opts.args ? opts.args(url) : [url])], { cwd, encoding: "utf8", env: { ...process.env, NOPIPELINE_SKIP_AUDIT: "1", ...opts.env, ...extra } });
  return { run, cwd, listing: await readdir(cwd), url };
}

test("the filled script is under Copr's 4 kB limit", async () => {
  const filled = real("packaging/copr-bootstrap.sh").replace("@RELEASE_SIGNERS@", real(".release-signers").trim());
  assert.ok(Buffer.byteLength(filled) < 4096, `${Buffer.byteLength(filled)} bytes`);
});

test("the tracked script holds the placeholder once and reads no key from the repo", () => {
  const text = real("packaging/copr-bootstrap.sh");
  assert.equal(text.split("@RELEASE_SIGNERS@").length - 1, 1);
  assert.ok(!text.includes(".release-signers"));
});

test("a tag signed with the release key builds into the current folder", { skip }, async (t) => {
  const { run, listing } = await bootstrap(t, [tagged("v0.2.0", "release")]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(listing, ["nopipeline-0.2.0.tar.gz", "nopipeline.spec"]);
});

test("the newest tag is built, and a named tag can be given", { skip }, async (t) => {
  const tags = [tagged("v0.9.0", "release"), tagged("v0.10.0", "release")];
  assert.deepEqual((await bootstrap(t, tags)).listing, ["nopipeline-0.10.0.tar.gz", "nopipeline.spec"]);
  assert.deepEqual((await bootstrap(t, tags, { args: (url) => [url, "v0.9.0"] })).listing, ["nopipeline-0.9.0.tar.gz", "nopipeline.spec"]);
});

for (const [title, sign] of [["an unsigned tag is refused", "none"], ["a tag signed by another key is refused", "other"]] as const) {
  test(title, { skip }, async (t) => {
    const { run, listing } = await bootstrap(t, [tagged("v0.2.0", sign)]);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /^copr-bootstrap: v0\.2\.0 is not signed by the release key/m);
    assert.deepEqual(listing, []);
  });
}

const skipGpg = toolsAvailable(["gpg"]) ? false : "gpg is needed to make a PGP-signed test tag";
test("a tag signed with OpenPGP is refused", { skip: skipGpg }, async (t) => {
  const { run, listing } = await bootstrap(t, [tagged("v0.2.0", "pgp")], { gnupg: true });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^copr-bootstrap: v0\.2\.0 is not signed by the release key/m);
  assert.deepEqual(listing, []);
});

async function fakeSigner(dir: string): Promise<string> {
  const program = join(dir, "fake-ssh-keygen");
  await writeFile(program, '#!/bin/sh\ncase "$*" in *find-principals*) echo releases;; *) echo \'Good "git" signature for releases with ED25519 key SHA256:forged\';; esac\nexit 0\n');
  await chmod(program, 0o755);
  return program;
}

test("GIT_* variables in the environment are dropped (GIT_TRACE writes nothing)", { skip }, async (t) => {
  const trace = join(await tempDir(t), "trace");
  const { run } = await bootstrap(t, [tagged("v0.2.0", "release")], { env: { GIT_TRACE: trace } });
  assert.equal(run.status, 0, run.stderr);
  await assert.rejects(stat(trace), "git was not told to trace");
});

test("git config in the environment cannot replace the signature verifier", { skip }, async (t) => {
  const { run, listing } = await bootstrap(t, [tagged("v0.2.0", "other")], {
    envFor: async (dir) => ({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "gpg.ssh.program", GIT_CONFIG_VALUE_0: await fakeSigner(dir) }),
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^copr-bootstrap: v0\.2\.0 is not signed by the release key/m);
  assert.deepEqual(listing, []);
});

test("an unfilled release key is refused", { skip }, async (t) => {
  const { run, listing } = await bootstrap(t, [tagged("v0.2.0", "release")], { signers: () => "@RELEASE_SIGNERS@" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^copr-bootstrap: the release key was not filled in/m);
  assert.deepEqual(listing, []);
});

test("a two-line release key value is refused", { skip }, async (t) => {
  const { run, listing } = await bootstrap(t, [tagged("v0.2.0", "release")], { signers: (line) => `${line}\nreleases ssh-ed25519 AAAA` });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^copr-bootstrap: the release key line is malformed/m);
  assert.deepEqual(listing, []);
});

test("a tag name that is not a release tag is refused", { skip }, async (t) => {
  const { run, listing } = await bootstrap(t, [tagged("v0.2.0", "release")], { args: (url) => [url, "--output=x"] });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^copr-bootstrap: /m);
  assert.deepEqual(listing, []);
});

test("a tampered build-source.sh on an unsigned newer tag is never run", { skip }, async (t) => {
  const marker = join(await tempDir(t), "marker");
  const evil = `#!/bin/sh\necho pwned >${marker}\n`;
  const { run, listing } = await bootstrap(t, [tagged("v0.2.0", "release"), tagged("v0.3.0", "none", evil)]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^copr-bootstrap: v0\.3\.0 is not signed by the release key/m);
  assert.deepEqual(listing, []);
  await assert.rejects(stat(marker), "the tampered script did not run");
});

test("the build-source.sh that runs is the one in the signed tag, with the bootstrap's own key and verified clone", { skip }, async (t) => {
  // A signed tag whose build-source.sh is replaced by a probe: it runs with the bootstrap's key filled in, the verified bare clone (not the url), the current folder and the tag.
  const out = join(await tempDir(t), "out");
  const probe = `#!/bin/sh\nALLOWED_SIGNERS='@RELEASE_SIGNERS@'\necho "$ALLOWED_SIGNERS|$#|$1|$2|$3" >${out}\ntouch nopipeline.spec\n`;
  const { signersLine, url } = await signedRepo(t, tree("0.0.0"), [tagged("v0.2.0", "release", probe)]);
  const cwd = await tempDir(t);
  const run = spawnSync("/bin/sh", [scriptWith(signersLine, "copr-bootstrap.sh"), url], { cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const [key, count, source, dir, tagArg] = readFileSync(out, "utf8").trim().split("|");
  assert.equal(key, signersLine);
  assert.equal(count, "3");
  assert.notEqual(source, url, "build-source.sh gets the verified clone, not the url");
  assert.match(source!, /repo\.git$/);
  assert.equal(dir, ".");
  assert.equal(tagArg, "v0.2.0");
});

test("when build-source.sh fails its own message is the only one", { skip }, async (t) => {
  const failing = "#!/bin/sh\nALLOWED_SIGNERS='@RELEASE_SIGNERS@'\necho 'build-source: boom' >&2\nexit 3\n";
  const { run, listing } = await bootstrap(t, [tagged("v0.2.0", "release", failing)]);
  assert.equal(run.status, 3);
  assert.equal(run.stderr.trim(), "build-source: boom");
  assert.deepEqual(listing, []);
});

test("a failing mktemp is reported with the script's prefix", { skip }, async (t) => {
  const dir = await tempDir(t);
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "mktemp"), "#!/bin/sh\nexit 1\n");
  await chmod(join(bin, "mktemp"), 0o755);
  const { signersLine } = await signedRepo(t, tree("0.0.0"), [tagged("v0.2.0", "release")]);
  const run = spawnSync("/bin/sh", [scriptWith(signersLine, "copr-bootstrap.sh")], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^copr-bootstrap: /m);
});

test("with no arguments the script clones the default repository", { skip }, async (t) => {
  const dir = await tempDir(t);
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "git"), '#!/bin/sh\necho "fake git $*" >&2\nexit 1\n');
  await chmod(join(bin, "git"), 0o755);
  const cwd = join(dir, "cwd");
  await mkdir(cwd);
  const { signersLine } = await signedRepo(t, tree("0.0.0"), [tagged("v0.2.0", "release")]);
  const run = spawnSync("/bin/sh", [scriptWith(signersLine, "copr-bootstrap.sh")], { cwd, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /^copr-bootstrap: cannot clone https:\/\/github\.com\/agus-enc\/nopipeline\.git/m);
  assert.deepEqual(await readdir(cwd), []);
});

test("both scripts carry the same tag verification block and tag regex", () => {
  const block = (text: string) => {
    const lines = text.split("\n");
    const from = lines.findIndex((l) => l.includes('cat-file -t "refs/tags/'));
    const to = lines.findIndex((l) => l.includes("the signed tag has another name"));
    return lines.slice(from, to + 1).filter((l) => !/^\s*#/.test(l)).map((l) => l.trim().replace(/\s+/g, " ")).filter(Boolean);
  };
  const a = block(real("packaging/build-source.sh"));
  const b = block(real("packaging/copr-bootstrap.sh"));
  assert.ok(a.length > 5, "found the block in build-source.sh");
  assert.deepEqual(b, a);
  const regex = (text: string) => text.match(/^semver='([^']+)'$/m)?.[1];
  assert.equal(regex(real("packaging/copr-bootstrap.sh")), "^v[0-9]+\\.[0-9]+\\.[0-9]+$");
  assert.equal(regex(real("packaging/copr-bootstrap.sh")), regex(real("packaging/build-source.sh")));
  const keyCheck = (text: string) => text.match(/grep -Eq '(\^releases[^']+)'/)?.[1];
  assert.equal(keyCheck(real("packaging/copr-bootstrap.sh")), keyCheck(real("packaging/build-source.sh")));
});

const dash = spawnSync("which", ["dash"], { stdio: "ignore" }).status === 0;
test("the script runs under dash", { skip: skip || (dash ? false : "dash is not installed") }, async (t) => {
  const { run, listing } = await bootstrap(t, [tagged("v0.2.0", "release")], { shell: "dash" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(listing, ["nopipeline-0.2.0.tar.gz", "nopipeline.spec"]);
});
