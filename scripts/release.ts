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

  /** Runs one git command; a failure becomes a problem line naming it, and the result is null. */
  const safe = async (args: string[]): Promise<string | null> => {
    try {
      return await git(args);
    } catch (error) {
      problems.push(`could not run git ${args.join(" ")}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      return null;
    }
  };

  const status = await safe(["status", "--porcelain"]);
  if (status !== null && status.trim() !== "") problems.push("the working tree is not clean (git status --porcelain prints something)");
  const branch = (await safe(["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
  if (branch !== undefined && branch !== "main") problems.push(`not on main (on ${branch})`);
  const head = (await safe(["rev-parse", "HEAD"]))?.trim();
  const remote = (await safe(["rev-parse", "origin/main"]))?.trim();
  if (head !== undefined && remote !== undefined && head !== remote) problems.push("HEAD is not origin/main (push or pull first)");

  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
  const heading = changelog.split("\n").map((l) => /^## (\d+\.\d+\.\d+) — \d{4}-\d{2}-\d{2}$/.exec(l)).find((m) => m !== null);
  if (!heading) problems.push("CHANGELOG.md has no version heading like '## 0.2.0 — 2026-11-07'");
  else if (heading[1] !== version) problems.push(`package.json says ${version} but the newest CHANGELOG.md heading says ${heading[1]}`);

  if (((await safe(["tag", "--list", tag])) ?? "").trim() !== "") problems.push(`tag ${tag} already exists locally`);
  if (((await safe(["ls-remote", "--tags", "origin", tag])) ?? "").trim() !== "") problems.push(`tag ${tag} already exists on origin`);

  let signers: string | null = null;
  try {
    signers = await readFile(join(root, ".release-signers"), "utf8");
  } catch {
    // reported below
  }
  // Exactly what packaging/build-source.sh accepts: that one line, one trailing newline allowed, nothing else.
  if (signers === null) problems.push(".release-signers is missing (it holds one line: releases ssh-ed25519 <public key>)");
  else if (signers.includes("\r")) problems.push(".release-signers has Windows line endings (CRLF); save it with LF");
  else if (!/^releases ssh-ed25519 [A-Za-z0-9+/=]+\n?$/.test(signers)) {
    problems.push(".release-signers must hold exactly one line: releases ssh-ed25519 <public key>");
  }

  const tags = ((await safe(["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-v:refname"])) ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^v\d+\.\d+\.\d+$/.test(l) && l !== tag);
  const previous = tags[0];
  if (previous !== undefined) {
    try {
      await git(["diff", "--quiet", previous, "HEAD", "--", SCRIPT]);
    } catch (error) {
      // git diff --quiet exits 1 when the files differ; any other failure means the comparison itself did not work.
      if ((error as { code?: unknown }).code === 1) warnings.push(`${SCRIPT} changed since ${previous}: update the Copr package's script before building`);
      else problems.push(`comparing ${SCRIPT} with ${previous}: the comparison failed (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
    }
  }

  return { problems, version, commands: [`git tag -s ${tag} -m "nopipeline ${version}"`, `git push origin ${tag}`, COPR], warnings };
}

/** Fetches origin's branches and tags; returns a problem line when that fails. */
export async function fetchOrigin(git: Git): Promise<string | null> {
  try {
    await git(["fetch", "origin", "--tags"]);
    return null;
  } catch (error) {
    return `git fetch origin --tags failed (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
  }
}

async function main(): Promise<void> {
  const run = promisify(execFile);
  const git: Git = async (args) => (await run("git", args, { cwd: process.cwd() })).stdout;
  const fetchProblem = await fetchOrigin(git);
  if (fetchProblem !== null) {
    console.log(`problem: ${fetchProblem}`);
    process.exitCode = 1;
    return;
  }
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
