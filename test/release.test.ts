import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { checkRelease, fetchOrigin, keyExpiryLine, obsRepoUrl, parseKeyExpiry, releaseNotes } from "../scripts/release.ts";
import { tempDir } from "./helpers/tmp.ts";

const SIGNERS = "releases ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n";

const happy: Record<string, string | Error> = {
  "git status --porcelain": "",
  "git rev-parse --abbrev-ref HEAD": "main\n",
  "git rev-parse HEAD": "aaa\n",
  "git rev-parse origin/main": "aaa\n",
  "git tag --list v0.2.0": "",
  "git ls-remote --tags origin v0.2.0": "",
};

const FPR = "0123456789ABCDEF0123456789ABCDEF01234567";

async function run(t: import("node:test").TestContext, over: Record<string, string | Error> = {}, opts: { signers?: string | null; changelog?: string; version?: string; project?: string | null; fingerprint?: string | null } = {}) {
  const root = await tempDir(t);
  await writeFile(join(root, "package.json"), JSON.stringify({ version: opts.version ?? "0.2.0" }));
  await writeFile(join(root, "CHANGELOG.md"), opts.changelog ?? "# Changelog\n\n## 0.2.0 — 2026-11-07\n\n- x\n\n## 0.1.0 — 2026-10-01\n");
  if (opts.signers !== null) await writeFile(join(root, ".release-signers"), opts.signers ?? SIGNERS);
  await mkdir(join(root, "packaging", "obs"), { recursive: true });
  if (opts.project !== null) await writeFile(join(root, "packaging", "obs", "project"), opts.project ?? "home:someone:nopipeline\n");
  if (opts.fingerprint !== null) await writeFile(join(root, "packaging", "obs-signing-key.fingerprint"), opts.fingerprint ?? `${FPR}\n`);
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
  return { result: await checkRelease(git, root), calls, root };
}

test("the happy path returns exactly the tag and push commands for 0.2.0", async (t) => {
  const { result } = await run(t);
  assert.deepEqual(result.problems, []);
  assert.equal(result.version, "0.2.0");
  assert.deepEqual(result.commands, ['git tag -s v0.2.0 -m "nopipeline 0.2.0"', "git push origin v0.2.0"]);
  assert.equal(result.project, "home:someone:nopipeline");
  assert.equal(result.fingerprint, FPR);
});

test("the placeholder OBS project is a problem and no key can be fetched", async (t) => {
  const { result } = await run(t, {}, { project: "home:CHANGE-ME:nopipeline\n" });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /packaging\/obs\/project/);
  assert.equal(result.project, null);
});

test("a README that still has the home:<user> placeholder is a problem", async (t) => {
  const { result, root } = await run(t);
  assert.deepEqual(result.problems, []);
  await writeFile(join(root, "README.md"), "Server = https://download.opensuse.org/repositories/home:/<user>:/nopipeline/Arch/$arch\nhome:<user>:nopipeline\n");
  const again = await checkRelease(async (args) => {
    const v = ({ ...happy })[`git ${args.join(" ")}`];
    if (v === undefined || v instanceof Error) throw new Error("unexpected");
    return v;
  }, root);
  assert.equal(again.problems.length, 1);
  assert.match(again.problems[0]!, /README\.md/);
});

for (const [form, text] of [
  ["home:<user> (project name)", "home:<user>:nopipeline\n"],
  ["home:/<user>:/ (URL form)", "Server = https://download.opensuse.org/repositories/home:/<user>:/nopipeline/Arch/$arch\n"],
  ["home_<user>_ (pacman section)", "[home_<user>_nopipeline_Arch]\n"],
] as const) {
  test(`a README with only the ${form} placeholder is a problem`, async (t) => {
    const { root } = await run(t);
    await writeFile(join(root, "README.md"), text);
    const again = await checkRelease(async (args) => {
      const v = ({ ...happy })[`git ${args.join(" ")}`];
      if (v === undefined || v instanceof Error) throw new Error("unexpected");
      return v;
    }, root);
    assert.equal(again.problems.length, 1);
    assert.match(again.problems[0]!, /README\.md/);
  });
}

test("the all-zero key fingerprint is a problem", async (t) => {
  const { result } = await run(t, {}, { fingerprint: "0".repeat(40) + "\n" });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /obs-signing-key\.fingerprint/);
  assert.equal(result.fingerprint, null);
});

test("a missing or malformed project or fingerprint file is a problem", async (t) => {
  for (const o of [{ project: null }, { fingerprint: null }, { project: "two words\n" }, { fingerprint: "abc\n" }]) {
    const { result } = await run(t, {}, o);
    assert.equal(result.problems.length, 1, JSON.stringify(o));
  }
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

const exitWith = (code: number) => Object.assign(new Error(`exit ${code}`), { code });

test("a git failure in any check becomes a problem naming the command", async (t) => {
  for (const [key, name] of [["git status --porcelain", "status"], ["git ls-remote --tags origin v0.2.0", "ls-remote"]] as const) {
    const { result } = await run(t, { [key]: exitWith(128) });
    assert.equal(result.problems.length, 1, name);
    assert.match(result.problems[0]!, new RegExp(`could not run git ${name}`));
  }
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

test("the checker only reads: no tag, push or fetch call", async (t) => {
  const { calls } = await run(t);
  for (const c of calls) assert.doesNotMatch(c, /^git (tag -s|push|fetch)/);
});

const PROJ = "home:someone:nopipeline";
const LOG = "# Changelog\n\nNewest first.\n\n## 0.3.0 — 2026-12-01\n\n- three\n- more\n\n## 0.2.0 — 2026-11-11\n\n- two\n\n\n## 0.1.0 — 2026-10-01\n\n- one\n";

test("releaseNotes extracts the section of the asked version, trimmed", () => {
  assert.match(releaseNotes("0.3.0", LOG, PROJ, FPR)!, /^- three\n- more\n\n\*\*Install/);
  assert.match(releaseNotes("0.2.0", LOG, PROJ, FPR)!, /^- two\n\n\*\*Install/);
  assert.match(releaseNotes("0.1.0", LOG, PROJ, FPR)!, /^- one\n\n\*\*Install/);
  assert.doesNotMatch(releaseNotes("0.2.0", LOG, PROJ, FPR)!, /three|- one/);
});

test("releaseNotes is null when the changelog has no section for the version", () => {
  assert.equal(releaseNotes("0.4.0", LOG, PROJ, FPR), null);
  assert.equal(releaseNotes("0.2", LOG, PROJ, FPR), null);
});

test("--notes prints the notes for package.json's version without git; a missing section is a problem", async (t) => {
  const root = await tempDir(t);
  const script = join(process.cwd(), "scripts", "release.ts");
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.2.0" }));
  await writeFile(join(root, "CHANGELOG.md"), LOG);
  await mkdir(join(root, "packaging", "obs"), { recursive: true });
  await writeFile(join(root, "packaging", "obs-signing-key.fingerprint"), `${FPR}\n`);
  await writeFile(join(root, "packaging", "obs", "project"), `${PROJ}\n`);
  const out = execFileSync("node", [script, "--notes"], { cwd: root, encoding: "utf8" });
  assert.equal(out, releaseNotes("0.2.0", LOG, PROJ, FPR));
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.9.0" }));
  let status = 0;
  let stdout = "";
  let stderr = "";
  try {
    execFileSync("node", [script, "--notes"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    status = (error as { status: number }).status;
    stdout = (error as { stdout: string }).stdout;
    stderr = (error as { stderr: string }).stderr;
  }
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /^problem: CHANGELOG\.md has no section for 0\.9\.0/);
});

const DAY = 86400;
const NOW = Date.UTC(2026, 10, 11) / 1000;

test("keyExpiryLine warns inside 180 days and names the UTC date", () => {
  const soon = keyExpiryLine(NOW + 179 * DAY, NOW);
  assert.equal(soon.level, "warning");
  assert.match(soon.text, /2027-05-09/);
  assert.equal(keyExpiryLine(NOW + 181 * DAY, NOW).level, "info");
  assert.match(keyExpiryLine(NOW + 181 * DAY, NOW).text, /2027-05-11/);
  assert.equal(keyExpiryLine(NOW + 180 * DAY, NOW).level, "info");
});

test("parseKeyExpiry reads digits and gives a clear error for anything else", () => {
  assert.equal(parseKeyExpiry("1893456000\n"), 1893456000);
  assert.equal(parseKeyExpiry("0\n"), 0);
  for (const bad of ["", "\n", "soon", "12x", "-5", "1.5"]) {
    assert.throws(() => parseKeyExpiry(bad), /could not read the OBS key expiry/, JSON.stringify(bad));
  }
});

test("keyExpiryLine: no expiry is info, an already expired key is a warning", () => {
  const none = keyExpiryLine(0, NOW);
  assert.equal(none.level, "info");
  assert.match(none.text, /does not expire/);
  assert.equal(keyExpiryLine(NOW - DAY, NOW).level, "warning");
});

test("obsRepoUrl turns every colon of the project into :/", () => {
  assert.equal(obsRepoUrl("home:a:nopipeline", "Debian_13"), "https://download.opensuse.org/repositories/home:/a:/nopipeline/Debian_13/");
});

test("releaseNotes install blocks come from the OBS project", () => {
  const notes = releaseNotes("0.2.0", LOG, "home:a:nopipeline", FPR)!;
  const base = "https://download.opensuse.org/repositories/home:/a:/nopipeline";
  assert.ok(notes.includes(`sudo dnf config-manager addrepo --from-repofile=${base}/Fedora_$(rpm -E %fedora)/home:a:nopipeline.repo`));
  assert.ok(notes.includes("sudo dnf install nopipeline"));
  assert.ok(notes.includes("Types: deb\n"));
  assert.ok(notes.includes(`URIs: ${base}/Debian_13/`));
  assert.ok(notes.includes("Signed-By: /usr/share/keyrings/nopipeline-archive-keyring.gpg"));
  assert.ok(notes.includes(`${base}/Debian_13/Release.key`));
  assert.ok(notes.includes('key=$(mktemp)'));
  assert.ok(notes.includes(`curl -fsSL ${base}/Debian_13/Release.key -o "$key" &&`));
  assert.ok(notes.includes('gpg --show-keys "$key"'));
  assert.ok(notes.includes('[ -s "$key" ] && sudo gpg --dearmor --yes -o /usr/share/keyrings/nopipeline-archive-keyring.gpg "$key"'));
  assert.ok(notes.includes('rm -f "$key"'));
  assert.doesNotMatch(notes, /Release\.key \| sudo gpg/);
  assert.ok(notes.indexOf("gpg --show-keys") < notes.indexOf("gpg --dearmor"));
  assert.ok(notes.includes(`fingerprint must be ${FPR}`));
  assert.ok(notes.includes("xUbuntu_24.04"));
  assert.ok(notes.includes("```ini\n[home_a_nopipeline_Arch]\nServer = "));
  assert.ok(notes.includes(`Server = ${base}/Arch/$arch`));
  assert.ok(notes.includes(`sudo pacman-key --lsign-key ${FPR}`));
  assert.ok(notes.includes("https://github.com/nodesource/distributions"));
  assert.ok(notes.includes("Node.js 22.22 or newer from [NodeSource]"));
  assert.ok(notes.includes("no TypeScript support"));
  assert.ok(notes.includes("verify-tag v0.2.0"));
  assert.doesNotMatch(notes, /copr/i);
});

test("--notes with the placeholder OBS project is a problem on stderr and exit 1", async (t) => {
  const root = await tempDir(t);
  const script = join(process.cwd(), "scripts", "release.ts");
  await mkdir(join(root, "packaging", "obs"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.2.0" }));
  await writeFile(join(root, "CHANGELOG.md"), LOG);
  await writeFile(join(root, "packaging", "obs-signing-key.fingerprint"), `${FPR}\n`);
  await writeFile(join(root, "packaging", "obs", "project"), "home:CHANGE-ME:nopipeline\n");
  const r = spawnSync("node", [script, "--notes"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^problem: packaging\/obs\/project/);
});

test("the OBS _service downloads exactly the files build-source.sh renders, from the latest release of @REPO@", async () => {
  const { readFile } = await import("node:fs/promises");
  const xml = await readFile("packaging/obs/_service", "utf8");
  const paths = [...xml.matchAll(/<param name="path">([^<]*)<\/param>/g)].map((m) => m[1]);
  const names = ["nopipeline.tar.gz", "nopipeline.spec", "nopipeline.dsc", "debian.control", "debian.rules", "debian.changelog", "debian.copyright", "PKGBUILD", "nopipeline.install"];
  assert.deepEqual(paths, names.map((n) => `@REPO@/releases/latest/download/${n}`));
  assert.equal([...xml.matchAll(/<param name="host">github\.com<\/param>/g)].length, names.length);
  const meta = await readFile("packaging/obs/project-meta.xml.in", "utf8");
  assert.deepEqual([...meta.matchAll(/<repository name="([^"]*)"/g)].map((m) => m[1]), ["Fedora_43", "Fedora_44", "Debian_13", "xUbuntu_24.04", "xUbuntu_26.04", "Arch"]);
  assert.match(meta, /<project name="@PROJECT@">/);
});
