// Checks that the repo is ready to release, then prints the commands to run.
// It only prints: it never tags, pushes or builds.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

type Git = (args: string[]) => Promise<string>;

const SCRIPT = "packaging/build-source.sh";
const COPR = "copr-cli build-package chipp/nopipeline --name nopipeline";

export async function checkRelease(
  git: Git,
  root: string,
): Promise<{ problems: string[]; version: string; commands: string[]; warnings: string[] }> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
  const version = pkg.version;
  const tag = `v${version}`;

  if ((await git(["status", "--porcelain"])).trim() !== "") problems.push("the working tree is not clean (git status --porcelain prints something)");
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (branch !== "main") problems.push(`not on main (on ${branch})`);
  const head = (await git(["rev-parse", "HEAD"])).trim();
  const remote = (await git(["rev-parse", "origin/main"])).trim();
  if (head !== remote) problems.push("HEAD is not origin/main (push or pull first)");

  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
  const heading = changelog.split("\n").map((l) => /^## (\d+\.\d+\.\d+) — \d{4}-\d{2}-\d{2}$/.exec(l)).find((m) => m !== null);
  if (!heading) problems.push("CHANGELOG.md has no version heading like '## 0.2.0 — 2026-11-07'");
  else if (heading[1] !== version) problems.push(`package.json says ${version} but the newest CHANGELOG.md heading says ${heading[1]}`);

  if ((await git(["tag", "--list", tag])).trim() !== "") problems.push(`tag ${tag} already exists locally`);
  if ((await git(["ls-remote", "--tags", "origin", tag])).trim() !== "") problems.push(`tag ${tag} already exists on origin`);

  let signers: string | null = null;
  try {
    signers = await readFile(join(root, ".release-signers"), "utf8");
  } catch {
    // reported below
  }
  // Exactly what packaging/build-source.sh accepts: that one line, one trailing newline allowed, nothing else.
  if (signers === null) problems.push(".release-signers is missing (it holds one line: releases ssh-ed25519 <public key>)");
  else if (!/^releases ssh-ed25519 [A-Za-z0-9+/=]+\n?$/.test(signers)) {
    problems.push(".release-signers must hold exactly one line: releases ssh-ed25519 <public key>");
  }

  const tags = (await git(["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-v:refname"]))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^v\d+\.\d+\.\d+$/.test(l) && l !== tag);
  const previous = tags[0];
  if (previous !== undefined) {
    try {
      await git(["diff", "--quiet", previous, "HEAD", "--", SCRIPT]);
    } catch {
      warnings.push(`${SCRIPT} changed since ${previous}: update the Copr package's script before building`);
    }
  }

  return { problems, version, commands: [`git tag -s ${tag} -m "nopipeline ${version}"`, `git push origin ${tag}`, COPR], warnings };
}

async function main(): Promise<void> {
  const run = promisify(execFile);
  const git: Git = async (args) => (await run("git", args, { cwd: process.cwd() })).stdout;
  await git(["fetch", "origin", "--tags"]);
  const { problems, version, commands, warnings } = await checkRelease(git, process.cwd());
  for (const w of warnings) console.log(`warning: ${w}`);
  if (problems.length > 0) {
    for (const p of problems) console.log(`problem: ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Ready to release ${version}. Run these, in order:`);
  for (const c of commands) console.log(`  ${c}`);
}

if (import.meta.main) await main();
