// A throwaway git repo with signed (or unsigned) release tags, and a copy of the build script with a release key.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { tempDir, writeTree } from "./tmp.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export interface TagSpec {
  name: string;
  sign: "release" | "other" | "none" | "pgp";
  /** Files committed just for this tag (on top of the base files); a new commit is made when given. */
  files?: Record<string, string>;
}

export function toolsAvailable(extra: string[] = []): boolean {
  return ["git", "ssh-keygen", ...extra].every((tool) => spawnSync("which", [tool], { stdio: "ignore" }).status === 0);
}

function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const env = { ...clean, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...extraEnv };
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

export async function signedRepo(
  t: TestContext,
  files: Record<string, string>,
  tags: TagSpec[],
): Promise<{ url: string; signersLine: string; gnupgHome: string }> {
  const dir = await tempDir(t);
  const keys = join(dir, "keys");
  await mkdir(keys);
  for (const name of ["release", "other"]) {
    execFileSync("ssh-keygen", ["-q", "-N", "", "-t", "ed25519", "-f", join(keys, name)], { stdio: "ignore" });
  }
  // A throwaway OpenPGP key (never the user's keyring), used only by tags signed "pgp".
  const gnupgHome = join(dir, "gnupg");
  let pgpKey = "";
  if (tags.some((tag) => tag.sign === "pgp")) {
    await mkdir(gnupgHome, { mode: 0o700 });
    const gpgEnv = { ...process.env, GNUPGHOME: gnupgHome };
    execFileSync("gpg", ["--batch", "--quiet", "--passphrase", "", "--quick-generate-key", "pgp-test <pgp@example.com>", "ed25519", "sign", "never"], { env: gpgEnv, stdio: "ignore" });
    pgpKey = execFileSync("gpg", ["--batch", "--list-keys", "--with-colons"], { env: gpgEnv, encoding: "utf8" }).split("\n").find((l) => l.startsWith("fpr:"))?.split(":")[9] ?? "";
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
    } else if (tag.sign === "pgp") {
      git(repo, [...identity, "-c", `user.signingkey=${pgpKey}`, "tag", "-s", "-m", tag.name, tag.name], { GNUPGHOME: gnupgHome });
    } else {
      git(repo, [...identity, "-c", "gpg.format=ssh", "-c", `user.signingkey=${join(keys, tag.sign)}`, "tag", "-s", "-m", tag.name, tag.name]);
    }
  }
  const publicKey = (await readFile(join(keys, "release.pub"), "utf8")).trim().split(/\s+/).slice(0, 2).join(" ");
  return { url: repo, signersLine: `releases ${publicKey}`, gnupgHome };
}

/** Writes a copy of a packaging script (default build-source.sh) with the release key filled in (what the release workflow does with sed). */
export function scriptWith(signersLine: string, name = "build-source.sh"): string {
  const dir = mkdtempSync(join(tmpdir(), "nopipeline-script-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const text = readFileSync(join(repoRoot, "packaging", name), "utf8").replace("@RELEASE_SIGNERS@", signersLine);
  const path = join(dir, name);
  writeFileSync(path, text, { mode: 0o755 });
  return path;
}
