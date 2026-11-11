// A throwaway git repo with signed (or unsigned) release tags, and a copy of the build script with a release key.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { tempDir, writeTree } from "./tmp.ts";

const repoRoot = new URL("../..", import.meta.url).pathname;

export interface TagSpec {
  name: string;
  sign: "release" | "other" | "none";
  /** Files committed just for this tag (on top of the base files); a new commit is made when given. */
  files?: Record<string, string>;
}

export function toolsAvailable(): boolean {
  return ["git", "ssh-keygen"].every((tool) => spawnSync("which", [tool], { stdio: "ignore" }).status === 0);
}

function git(cwd: string, args: string[]): string {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

export async function signedRepo(
  t: TestContext,
  files: Record<string, string>,
  tags: TagSpec[],
): Promise<{ url: string; signersLine: string }> {
  const dir = await tempDir(t);
  const keys = join(dir, "keys");
  await mkdir(keys);
  for (const name of ["release", "other"]) {
    execFileSync("ssh-keygen", ["-q", "-N", "", "-t", "ed25519", "-f", join(keys, name)], { stdio: "ignore" });
  }
  const repo = join(dir, "repo");
  await mkdir(repo);
  git(repo, ["init", "--quiet", "--initial-branch=main"]);
  await writeTree(repo, files);
  git(repo, [...identity, "add", "-A"]);
  git(repo, [...identity, "commit", "--quiet", "-m", "base"]);
  for (const tag of tags) {
    if (tag.files) {
      await writeTree(repo, tag.files);
      git(repo, [...identity, "add", "-A"]);
      git(repo, [...identity, "commit", "--quiet", "-m", `for ${tag.name}`]);
    }
    if (tag.sign === "none") {
      git(repo, [...identity, "tag", "-a", "-m", tag.name, tag.name]);
    } else {
      git(repo, [...identity, "-c", "gpg.format=ssh", "-c", `user.signingkey=${join(keys, tag.sign)}`, "tag", "-s", "-m", tag.name, tag.name]);
    }
  }
  const publicKey = (await readFile(join(keys, "release.pub"), "utf8")).trim().split(/\s+/).slice(0, 2).join(" ");
  return { url: repo, signersLine: `releases ${publicKey}` };
}

/** Writes a copy of packaging/build-source.sh with the release key filled in (what is pasted into Copr). */
export function scriptWith(signersLine: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nopipeline-script-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const text = readFileSync(join(repoRoot, "packaging/build-source.sh"), "utf8").replace("@RELEASE_SIGNERS@", signersLine);
  const path = join(dir, "build-source.sh");
  writeFileSync(path, text, { mode: 0o755 });
  return path;
}
