import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { checkRelease, fetchOrigin, releaseNotes, shellPath, webhookLocation } from "../scripts/release.ts";
import { tempDir } from "./helpers/tmp.ts";

const SIGNERS = "releases ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n";
const TAGS = "git tag --list v[0-9]*.[0-9]*.[0-9]* --sort=-v:refname";
const DIFF = "git diff --quiet v0.1.0 HEAD -- packaging/copr-bootstrap.sh";

const URL_TEXT = "https://copr.fedorainfracloud.org/webhooks/custom/12345/00000000-aaaa-bbbb-cccc-SECRETSECRET/nopipeline/";
const CURL = 'curl -fsS -X POST "$(cat ~/.config/nopipeline/copr-webhook)"';
const GH = 'node scripts/release.ts --notes | gh release create v0.2.0 --verify-tag --title "nopipeline 0.2.0" --notes-file -';

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

async function run(t: import("node:test").TestContext, over: Record<string, string | Error> = {}, opts: { signers?: string | null; changelog?: string; version?: string; webhook?: string | null; mode?: number; xdg?: boolean; homeName?: string } = {}) {
  const root = await tempDir(t);
  await writeFile(join(root, "package.json"), JSON.stringify({ version: opts.version ?? "0.2.0" }));
  await writeFile(join(root, "CHANGELOG.md"), opts.changelog ?? "# Changelog\n\n## 0.2.0 — 2026-11-07\n\n- x\n\n## 0.1.0 — 2026-10-01\n");
  if (opts.signers !== null) await writeFile(join(root, ".release-signers"), opts.signers ?? SIGNERS);
  const home = join(root, opts.homeName ?? "home");
  const cfg = opts.xdg ? join(root, "xdg", "nopipeline") : join(home, ".config", "nopipeline");
  const webhookPath = join(cfg, "copr-webhook");
  if (opts.webhook !== null) {
    await mkdir(cfg, { recursive: true });
    await writeFile(webhookPath, opts.webhook ?? `${URL_TEXT}\n`);
    await chmod(webhookPath, opts.mode ?? 0o600);
  }
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
  return { result: await checkRelease(git, root, { path: webhookPath, home }), calls, root };
}

test("the happy path returns the four commands for 0.2.0", async (t) => {
  const { result } = await run(t);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.version, "0.2.0");
  assert.deepEqual(result.commands, ['git tag -s v0.2.0 -m "nopipeline 0.2.0"', "git push origin v0.2.0", CURL, GH]);
});

test("a webhook file outside HOME is printed with its absolute path", async (t) => {
  const { result, root } = await run(t, {}, { xdg: true });
  assert.deepEqual(result.problems, []);
  assert.equal(result.commands[2], `curl -fsS -X POST "$(cat ${join(root, "xdg", "nopipeline", "copr-webhook")})"`);
});

test("a missing webhook file is a problem that says where to put the URL", async (t) => {
  const { result } = await run(t, {}, { webhook: null });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /copr-webhook: put the project's custom webhook URL there \(Copr → Settings → Integrations\), mode 600/);
});

test("a webhook file readable by group or others is a problem, 400 and 600 are fine", async (t) => {
  for (const mode of [0o640, 0o644, 0o604, 0o660]) {
    const { result } = await run(t, {}, { mode });
    assert.equal(result.problems.length, 1, mode.toString(8));
    assert.match(result.problems[0]!, /is readable by others; chmod 600 it/);
  }
  const { result } = await run(t, {}, { mode: 0o400 });
  assert.deepEqual(result.problems, []);
});

test("a webhook file with spaces or blank lines around the URL is a problem (curl rejects a leading space)", async (t) => {
  for (const webhook of [` ${URL_TEXT}\n`, `${URL_TEXT} \n`, `\t${URL_TEXT}`, `\n${URL_TEXT}\n`, `${URL_TEXT}\n\n`]) {
    const { result } = await run(t, {}, { webhook });
    assert.equal(result.problems.length, 1, JSON.stringify(webhook));
    assert.match(result.problems[0]!, /has spaces or blank lines around the URL; it must hold only the URL/);
    assert.ok(!result.problems[0]!.includes("SECRET"));
  }
  const { result } = await run(t, {}, { webhook: URL_TEXT });
  assert.deepEqual(result.problems, [], "no trailing newline is fine");
});

test("a webhook file that is not a Copr custom webhook URL is a problem", async (t) => {
  for (const webhook of ["", "\n", "http://copr.fedorainfracloud.org/webhooks/custom/1/x/", "https://example.com/webhooks/custom/1/x/", "token=abc"]) {
    const { result } = await run(t, {}, { webhook });
    assert.equal(result.problems.length, 1, JSON.stringify(webhook));
    assert.match(result.problems[0]!, /doesn't look like a Copr custom webhook URL/);
  }
});

test("the webhook URL never appears in problems or commands, even when the file is malformed", async (t) => {
  const secret = "SUPERSECRETVALUE";
  for (const [webhook, mode] of [[`${URL_TEXT}\n`, 0o600], [`${URL_TEXT}\n`, 0o644], [`https://evil.example/${secret}\n`, 0o600], [`${secret}\nsecond line ${URL_TEXT}\n`, 0o600]] as const) {
    const { result } = await run(t, {}, { webhook, mode });
    const out = JSON.stringify([result.problems, result.commands, result.warnings]);
    assert.ok(!out.includes(secret) && !out.includes("SECRETSECRET") && !out.includes("12345"), JSON.stringify(webhook));
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

test("a changed copr-bootstrap.sh warns with the previous tag, and is not a problem", async (t) => {
  const { result } = await run(t, { [DIFF]: exitWith(1) });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.warnings, ["packaging/copr-bootstrap.sh changed since v0.1.0: update the Copr package's script before building"]);
});

const exitWith = (code: number) => Object.assign(new Error(`exit ${code}`), { code });

test("a copr-bootstrap.sh comparison that fails for another reason is a problem, not the changed warning", async (t) => {
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

test("no previous tag means no warning and no diff", async (t) => {
  const { result, calls } = await run(t, { [TAGS]: "v0.2.0\n" });
  assert.deepEqual(result.warnings, []);
  assert.ok(!calls.some((c) => c.startsWith("git diff")));
});

test("the checker only reads: no tag, push or fetch call", async (t) => {
  const { calls } = await run(t);
  for (const c of calls) assert.doesNotMatch(c, /^git (tag -s|push|fetch)/);
});

test("webhookLocation uses XDG_CONFIG_HOME when set, else ~/.config", () => {
  assert.equal(webhookLocation({ XDG_CONFIG_HOME: "/x/cfg" }, "/h").path, "/x/cfg/nopipeline/copr-webhook");
  assert.equal(webhookLocation({}, "/h").path, "/h/.config/nopipeline/copr-webhook");
  assert.equal(webhookLocation({ XDG_CONFIG_HOME: "" }, "/h").path, "/h/.config/nopipeline/copr-webhook");
});

test("the printed command reads the right file even when HOME has a space and a quote", async (t) => {
  for (const homeName of ["my home", "it's home", "a$b;c(d)&e`f"]) {
    const { result, root } = await run(t, {}, { homeName, webhook: "https://copr.fedorainfracloud.org/webhooks/custom/1/x/\n" });
    assert.deepEqual(result.problems, [], homeName);
    const cmd = result.commands[2]!.replace("curl -fsS -X POST", "printf %s");
    const out = execFileSync("sh", ["-c", cmd], { env: { HOME: join(root, homeName), PATH: process.env.PATH }, encoding: "utf8" });
    assert.equal(out, "https://copr.fedorainfracloud.org/webhooks/custom/1/x/", homeName);
  }
});

test("the part after ~/ is single-quoted when it has unsafe characters, and the printed form reads the file", async (t) => {
  const home = await tempDir(t);
  const rel = "My Config/it's $x;`y`(z)&/copr-webhook";
  const path = join(home, rel);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "ok");
  const printed = shellPath({ path, home });
  assert.ok(printed.startsWith("~/'"), printed);
  const out = execFileSync("sh", ["-c", `printf %s "$(cat ${printed})"`], { env: { HOME: home, PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(out, "ok");
});

test("a folder named ..foo under HOME is still printed with ~", () => {
  assert.equal(shellPath({ path: "/h/..foo/copr-webhook", home: "/h" }), "~/..foo/copr-webhook");
  assert.equal(shellPath({ path: "/other/copr-webhook", home: "/h" }), "/other/copr-webhook");
});

test("a webhook file with Windows line endings is a problem and the content is not printed", async (t) => {
  const { result } = await run(t, {}, { webhook: `${URL_TEXT}\r\n` });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /has Windows line endings \(CRLF\)/);
  assert.ok(!JSON.stringify(result).includes("SECRETSECRET"));
});

const LOG = "# Changelog\n\nNewest first.\n\n## 0.3.0 — 2026-12-01\n\n- three\n- more\n\n## 0.2.0 — 2026-11-11\n\n- two\n\n\n## 0.1.0 — 2026-10-01\n\n- one\n";

test("releaseNotes extracts the section of the asked version, trimmed", () => {
  assert.match(releaseNotes("0.3.0", LOG)!, /^- three\n- more\n\n\*\*Install/);
  assert.match(releaseNotes("0.2.0", LOG)!, /^- two\n\n\*\*Install/);
  assert.match(releaseNotes("0.1.0", LOG)!, /^- one\n\n\*\*Install/);
  assert.doesNotMatch(releaseNotes("0.2.0", LOG)!, /three|- one/);
});

test("releaseNotes is null when the changelog has no section for the version", () => {
  assert.equal(releaseNotes("0.4.0", LOG), null);
  assert.equal(releaseNotes("0.2", LOG), null);
});

test("releaseNotes prints the exact notes for a sample", () => {
  const fence = "```";
  assert.equal(
    releaseNotes("0.2.0", LOG),
    [
      "- two",
      "",
      "**Install (Fedora 43/44):**",
      "",
      `${fence}bash`,
      "sudo dnf copr enable chipp/nopipeline",
      "sudo dnf install nopipeline",
      fence,
      "",
      "The tag is signed with the release key in `.release-signers`; check it with:",
      "",
      `${fence}bash`,
      "git -c gpg.ssh.allowedSignersFile=.release-signers verify-tag v0.2.0",
      fence,
      "",
    ].join("\n"),
  );
});

test("--notes prints the notes for package.json's version without git; a missing section is a problem", async (t) => {
  const root = await tempDir(t);
  const script = join(process.cwd(), "scripts", "release.ts");
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.2.0" }));
  await writeFile(join(root, "CHANGELOG.md"), LOG);
  const out = execFileSync("node", [script, "--notes"], { cwd: root, encoding: "utf8" });
  assert.equal(out, releaseNotes("0.2.0", LOG));
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.9.0" }));
  let status = 0;
  let stdout = "";
  try {
    execFileSync("node", [script, "--notes"], { cwd: root, encoding: "utf8" });
  } catch (error) {
    status = (error as { status: number }).status;
    stdout = (error as { stdout: string }).stdout;
  }
  assert.equal(status, 1);
  assert.match(stdout, /^problem: CHANGELOG\.md has no section for 0\.9\.0/);
});
