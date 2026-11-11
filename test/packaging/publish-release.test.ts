import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { tempDir } from "../helpers/tmp.ts";

const script = fileURLToPath(new URL("../../packaging/publish-release.sh", import.meta.url));
const have = (tool: string) => spawnSync("which", [tool], { stdio: "ignore" }).status === 0;
const FILES = { "nopipeline.tar.gz": "tar bytes", "nopipeline.spec": "spec\n", PKGBUILD: "pkg\n", "nopipeline-archive-keyring.gpg": "key" };

/** A scratch dir with the release files and a bin/ holding a fake gh (logs argv and stdin; `view` succeeds when GH_VIEW=0) and a fake node (prints notes). */
async function setup(t: import("node:test").TestContext) {
  const root = await tempDir(t);
  const out = join(root, "out");
  const bin = join(root, "bin");
  await mkdir(out);
  await mkdir(bin);
  for (const [name, body] of Object.entries(FILES)) await writeFile(join(out, name), body);
  const log = join(root, "gh.log");
  await writeFile(
    join(bin, "gh"),
    ['#!/bin/sh', 'printf "gh" >>"$GH_LOG"', 'for a in "$@"; do printf " [%s]" "$a" >>"$GH_LOG"; done', 'echo >>"$GH_LOG"',
     'if [ "$1 $2" = "release create" ]; then cat >"$GH_LOG.stdin"; fi',
     'if [ "$1 $2" = "release view" ]; then exit "${GH_VIEW:-1}"; fi', "exit 0", ""].join("\n"),
  );
  await writeFile(join(bin, "node"), ['#!/bin/sh', '[ "$1 $2" = "scripts/release.ts --notes" ] || exit 9', "echo 'the notes'", ""].join("\n"));
  await chmod(join(bin, "gh"), 0o755);
  await chmod(join(bin, "node"), 0o755);
  return { out, bin, log };
}

function run(shell: string, s: { out: string; bin: string; log: string }, args: string[], view: string) {
  return spawnSync(shell, [script, ...args], {
    encoding: "utf8",
    env: { PATH: `${s.bin}:${process.env.PATH}`, GH_LOG: s.log, GH_VIEW: view, GH_TOKEN: "not-a-real-token" },
  });
}

const calls = async (log: string) => (await readFile(log, "utf8")).trim().split("\n");

for (const shell of ["sh", "dash"]) {
  const skip = have(shell) ? false : `${shell} is not installed`;

  test(`${shell}: a missing release is created once, with --verify-tag, the notes on stdin and all files`, { skip }, async (t) => {
    const s = await setup(t);
    const r = run(shell, s, [s.out, "v1.2.3"], "1");
    assert.equal(r.status, 0, r.stderr);
    const all = await calls(s.log);
    const creates = all.filter((l) => l.startsWith("gh [release] [create]"));
    assert.equal(creates.length, 1);
    assert.equal(all.filter((l) => l.includes("[upload]")).length, 0);
    const c = creates[0]!;
    assert.match(c, /\[v1\.2\.3\]/);
    assert.match(c, /\[--verify-tag\]/);
    assert.match(c, /\[--title\] \[nopipeline 1\.2\.3\]/);
    assert.match(c, /\[--notes-file\] \[-\]/);
    for (const name of [...Object.keys(FILES), "SHA256SUMS"]) assert.ok(c.includes(`${s.out}/${name}]`), name);
    assert.equal((await readFile(`${s.log}.stdin`, "utf8")).trim(), "the notes");
  });

  test(`${shell}: an existing release is left alone: no upload, no --clobber, no create, exit 0 with a notice`, { skip }, async (t) => {
    const s = await setup(t);
    const r = run(shell, s, [s.out, "v1.2.3"], "0");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /v1\.2\.3 already exists/);
    const all = await calls(s.log);
    assert.deepEqual(all.filter((l) => !l.startsWith("gh [release] [view]")), []);
    assert.ok(!(await readFile(s.log, "utf8")).includes("--clobber"));
  });

  test(`${shell}: SHA256SUMS lists every other file with its hash, and running again gives the same file`, { skip }, async (t) => {
    const s = await setup(t);
    assert.equal(run(shell, s, [s.out, "v1.2.3"], "1").status, 0);
    const sums = await readFile(join(s.out, "SHA256SUMS"), "utf8");
    const want = Object.entries(FILES)
      .map(([n, b]) => `${createHash("sha256").update(b).digest("hex")}  ${n}`)
      .sort((a, b) => a.split("  ")[1]!.localeCompare(b.split("  ")[1]!));
    assert.deepEqual(sums.trim().split("\n").sort(), want.sort());
    assert.equal(run(shell, s, [s.out, "v1.2.3"], "0").status, 0);
    assert.equal(await readFile(join(s.out, "SHA256SUMS"), "utf8"), sums);
  });

  test(`${shell}: a tag that is not vX.Y.Z, a missing folder or missing notes stops before gh runs`, { skip }, async (t) => {
    const s = await setup(t);
    for (const bad of ["v1.2.3-rc1", "v1.2", "1.2.3", ""]) assert.notEqual(run(shell, s, [s.out, bad], "1").status, 0, bad);
    assert.notEqual(run(shell, s, [join(s.out, "nope"), "v1.2.3"], "1").status, 0);
    assert.notEqual(run(shell, s, [s.out], "1").status, 0);
    await writeFile(join(s.bin, "node"), "#!/bin/sh\necho no notes >&2\nexit 1\n");
    const r = run(shell, s, [s.out, "v1.2.3"], "1");
    assert.notEqual(r.status, 0);
    await assert.rejects(readFile(s.log, "utf8"), "gh must not have been called");
  });
}
