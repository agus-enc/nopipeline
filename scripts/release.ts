// Checks that the repo is ready to release, then prints the commands to run.
// It only prints: it never tags, pushes or builds (it does download the OBS repo key to read its expiry). With --notes it prints the GitHub release notes instead.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

type Git = (args: string[]) => Promise<string>;

const SCRIPT = "packaging/copr-bootstrap.sh";
const OBS_HOST = "https://download.opensuse.org/repositories";
const DAY = 86400;
const WARN_DAYS = 180;

/** Debian and Ubuntu archive Node.js is built without TypeScript support, so those users need Node.js from NodeSource. One place to change. */
const NODE_NOTE =
  "On Debian, Ubuntu and derivatives, first install Node.js 22.22 or newer from [NodeSource](https://github.com/nodesource/distributions): the distribution's own Node.js can't run nopipeline (no TypeScript support).";

/** The directory of one OBS repository on download.opensuse.org. */
export function obsRepoUrl(project: string, repo: string): string {
  return `${OBS_HOST}/${project.replaceAll(":", ":/")}/${repo}/`;
}

/** What to tell about the repo key's expiry (Unix seconds, 0 for none): a warning when it lapses within 180 days or already has. */
export function keyExpiryLine(expires: number, now: number): { level: "info" | "warning"; text: string } {
  if (expires === 0) return { level: "info", text: "the OBS repo key does not expire" };
  const date = new Date(expires * 1000).toISOString().slice(0, 10);
  const left = expires - now;
  if (left <= 0) return { level: "warning", text: `the OBS repo key expired on ${date}: renew it in OBS` };
  if (left < WARN_DAYS * DAY) return { level: "warning", text: `the OBS repo key expires on ${date} (in ${Math.ceil(left / DAY)} days): extend it in OBS` };
  return { level: "info", text: `the OBS repo key expires on ${date}` };
}

const PROJECT_FILE = "packaging/obs/project";
const FINGERPRINT_FILE = "packaging/obs-signing-key.fingerprint";

/** Reads the OBS project name and key fingerprint; a problem line for each that is missing, still a placeholder or malformed. */
async function readObs(root: string, problems: string[]): Promise<{ project: string | null; fingerprint: string | null }> {
  const read = async (file: string): Promise<string | null> => {
    try {
      return (await readFile(join(root, file), "utf8")).trim();
    } catch {
      problems.push(`${file} is missing`);
      return null;
    }
  };
  let project = await read(PROJECT_FILE);
  if (project !== null && project.includes("CHANGE-ME")) {
    problems.push(`${PROJECT_FILE} still holds the placeholder (put the OBS project name there)`);
    project = null;
  } else if (project !== null && !/^[A-Za-z0-9:._-]+$/.test(project)) {
    problems.push(`${PROJECT_FILE} must hold one OBS project name like home:user:nopipeline`);
    project = null;
  }
  let fingerprint = await read(FINGERPRINT_FILE);
  if (fingerprint !== null && /^0{40}$/.test(fingerprint)) {
    problems.push(`${FINGERPRINT_FILE} still holds the all-zero placeholder (put the OBS key's fingerprint there)`);
    fingerprint = null;
  } else if (fingerprint !== null && !/^[0-9A-Fa-f]{40}$/.test(fingerprint)) {
    problems.push(`${FINGERPRINT_FILE} must hold 40 hex characters`);
    fingerprint = null;
  }
  return { project, fingerprint };
}

/** The GitHub release notes for `version`: its CHANGELOG section, then the install blocks (from the OBS `project`) and the tag-check block. Null when there is no such section. */
export function releaseNotes(version: string, changelog: string, project: string, fingerprint: string): string | null {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${version} — `));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const section = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  const fence = "```";
  const repo = (name: string): string => obsRepoUrl(project, name);
  const keyringPath = "/usr/share/keyrings/nopipeline-archive-keyring.gpg";
  return [
    section,
    "",
    "**Install on Fedora (43, 44):**",
    "",
    `${fence}bash`,
    `sudo dnf config-manager addrepo --from-repofile=${repo("Fedora_$(rpm -E %fedora)")}${project}.repo`,
    "sudo dnf install nopipeline",
    fence,
    "",
    "**Install on Debian and Ubuntu:**",
    "",
    NODE_NOTE,
    "The commands use the `Debian_13` repository; on Ubuntu replace `Debian_13` with `xUbuntu_24.04` or `xUbuntu_26.04`.",
    "",
    "Download the key first and check it before you trust it:",
    "",
    `${fence}bash`,
    'key=$(mktemp)',
    `curl -fsSL ${repo("Debian_13")}Release.key -o "$key" &&`,
    '  gpg --show-keys "$key"',
    fence,
    "",
    `Only if the fingerprint matches, install the key and add the repository (same shell, so \`key\` is still set). The fingerprint must be ${fingerprint}:`,
    "",
    `${fence}bash`,
    `[ -s "$key" ] && sudo gpg --dearmor --yes -o ${keyringPath} "$key"`,
    'rm -f "$key"',
    "sudo tee /etc/apt/sources.list.d/nopipeline.sources <<'EOF'",
    "Types: deb",
    `URIs: ${repo("Debian_13")}`,
    "Suites: ./",
    `Signed-By: ${keyringPath}`,
    "EOF",
    "sudo apt update && sudo apt install nopipeline",
    fence,
    "",
    "**Install on Arch:**",
    "",
    "Add this to `/etc/pacman.conf`, then import the repo key and trust it:",
    "",
    `${fence}ini`,
    `[${project.replaceAll(":", "_")}_Arch]`,
    `Server = ${repo("Arch")}$arch`,
    fence,
    "",
    `${fence}bash`,
    `curl -fsSL "https://build.opensuse.org/projects/${project}/signing_keys/download?kind=gpg" | sudo pacman-key --add -`,
    `sudo pacman-key --lsign-key ${fingerprint}`,
    "sudo pacman -Syu nopipeline",
    fence,
    "",
    "The tag is signed with the release key in `.release-signers`; check it with:",
    "",
    `${fence}bash`,
    `git -c gpg.ssh.allowedSignersFile=.release-signers verify-tag v${version}`,
    fence,
    "",
  ].join("\n");
}

export async function checkRelease(
  git: Git,
  root: string,
): Promise<{ problems: string[]; version: string; commands: string[]; warnings: string[]; project: string | null; fingerprint: string | null }> {
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
  // Exactly what packaging/copr-bootstrap.sh accepts: that one line, one trailing newline allowed, nothing else.
  if (signers === null) problems.push(".release-signers is missing (it holds one line: releases ssh-ed25519 <public key>)");
  else if (signers.includes("\r")) problems.push(".release-signers has Windows line endings (CRLF); save it with LF");
  else if (!/^releases ssh-ed25519 [A-Za-z0-9+/=]+\n?$/.test(signers)) {
    problems.push(".release-signers must hold exactly one line: releases ssh-ed25519 <public key>");
  }

  const { project, fingerprint } = await readObs(root, problems);
  // The README's install commands name the OBS project; they must not go out with the placeholder.
  const readme = await readFile(join(root, "README.md"), "utf8").catch(() => "");
  // The placeholder appears as home:<user>, home:/<user>:/ (URLs) and home_<user>_ (pacman section): any <user> is one.
  if (readme.includes("<user>")) problems.push("README.md still has the placeholder <user> in its install commands (put the OBS project there)");

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

  return { problems, version, commands: [`git tag -s ${tag} -m "nopipeline ${version}"`, `git push origin ${tag}`], warnings, project, fingerprint };
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

/** The OBS project and key fingerprint for the notes, or null after printing a problem line. */
async function obsForNotes(): Promise<{ project: string; fingerprint: string } | null> {
  const problems: string[] = [];
  const { project, fingerprint } = await readObs(".", problems);
  if (project === null || fingerprint === null) {
    for (const p of problems) console.error(`problem: ${p}`);
    return null;
  }
  return { project, fingerprint };
}

async function printNotes(): Promise<void> {
  const { version } = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
  const obs = await obsForNotes();
  if (obs === null) {
    process.exitCode = 1;
    return;
  }
  const notes = releaseNotes(version, await readFile("CHANGELOG.md", "utf8"), obs.project, obs.fingerprint);
  if (notes === null) {
    console.error(`problem: CHANGELOG.md has no section for ${version} (a heading like '## ${version} — 2026-11-07')`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(notes);
}

/** The key's expiry in Unix seconds, from packaging/obs-key.sh (it downloads the key and checks the pinned fingerprint). */
async function fetchKeyExpiry(root: string, project: string, fingerprint: string): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "nopipeline-key-"));
  try {
    await promisify(execFile)("sh", [join(root, "packaging", "obs-key.sh"), "--project", project, fingerprint, dir], { cwd: root });
    return Number((await readFile(join(dir, "expires"), "utf8")).trim());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--notes")) return printNotes();
  const run = promisify(execFile);
  const git: Git = async (args) => (await run("git", args, { cwd: process.cwd() })).stdout;
  const fetchProblem = await fetchOrigin(git);
  if (fetchProblem !== null) {
    console.log(`problem: ${fetchProblem}`);
    process.exitCode = 1;
    return;
  }
  const { problems, version, commands, warnings, project, fingerprint } = await checkRelease(git, process.cwd());
  for (const w of warnings) console.log(`warning: ${w}`);
  // With a placeholder project or fingerprint there is nothing to fetch (already a problem above).
  if (project !== null && fingerprint !== null) {
    try {
      const line = keyExpiryLine(await fetchKeyExpiry(process.cwd(), project, fingerprint), Date.now() / 1000);
      console.log(`${line.level}: ${line.text}`);
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr?.trim().split("\n")[0] ?? (error instanceof Error ? error.message.split("\n")[0] : String(error));
      console.log(`warning: could not check the OBS repo key (${detail})`);
    }
  }
  if (problems.length > 0) {
    for (const p of problems) console.log(`problem: ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Ready to release ${version}. Run these, in order:`);
  for (const c of commands) console.log(`  ${c}`);
  console.log("GitHub Actions then builds and publishes the release and starts the OBS build.");
}

if (import.meta.main) await main();
