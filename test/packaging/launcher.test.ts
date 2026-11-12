import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { tempDir } from "../helpers/tmp.ts";

const launcher = fileURLToPath(new URL("../../packaging/nopipeline-launcher.sh", import.meta.url));
const have = (tool: string) => spawnSync("which", [tool], { stdio: "ignore" }).status === 0;

/** A fake node: `-e` answers the feature probe, `--version` prints a version, anything else is the cli run (args echoed one per line). */
async function fakeNode(t: import("node:test").TestContext, typescript: boolean): Promise<string> {
  const path = join(await tempDir(t), "node");
  await writeFile(
    path,
    [
      "#!/bin/sh",
      'case "$1" in',
      `  -e) exit ${typescript ? 0 : 3} ;;`,
      "  --version) echo v22.21.0; exit 0 ;;",
      "esac",
      'for a in "$@"; do printf "arg:%s\\n" "$a"; done',
      "exit 7",
      "",
    ].join("\n"),
  );
  await chmod(path, 0o755);
  return path;
}

function run(shell: string, node: string, args: string[] = []) {
  return spawnSync(shell, [launcher, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", NOPIPELINE_TEST_NODE: node, NOPIPELINE_TEST_CLI: "/fake/cli.ts" },
  });
}

for (const shell of ["sh", "dash"]) {
  const skip = have(shell) ? false : `${shell} is not installed`;

  test(`${shell}: with TypeScript support it runs the cli with every argument and its exit code`, { skip }, async (t) => {
    const r = run(shell, await fakeNode(t, true), ["sync", "two words", "--x=*", ""]);
    assert.equal(r.status, 7);
    assert.equal(r.stdout, "arg:/fake/cli.ts\narg:sync\narg:two words\narg:--x=*\narg:\n");
  });

  test(`${shell}: without TypeScript support it explains and exits 1`, { skip }, async (t) => {
    const r = run(shell, await fakeNode(t, false), ["--version"]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.equal(
      r.stderr,
      "nopipeline: this Node.js (v22.21.0) cannot run TypeScript. Install Node.js 22.22 or newer from NodeSource (https://github.com/nodesource/distributions), which can.\n",
    );
  });

  test(`${shell}: a missing node is reported and exits 1`, { skip }, async (t) => {
    const r = run(shell, join(await tempDir(t), "no-such-node"));
    assert.equal(r.status, 1);
    assert.equal(r.stderr, "nopipeline: /usr/bin/node is missing or broken; install Node.js 22.22 or newer.\n");
  });
}

test("the launcher defaults to /usr/bin/node and the installed cli", async () => {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(launcher, "utf8");
  assert.ok(text.startsWith("#!/bin/sh\n"));
  assert.ok(text.includes("node=${NOPIPELINE_TEST_NODE:-/usr/bin/node}"));
  assert.ok(text.includes("cli=${NOPIPELINE_TEST_CLI:-/usr/share/nopipeline/src/cli.ts}"));
});

test("the three recipes install the one launcher as /usr/bin/nopipeline", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (p: string) => readFile(fileURLToPath(new URL(`../../packaging/${p}`, import.meta.url)), "utf8");
  assert.match(await read("fedora/nopipeline.spec.in"), /^install -m 0755 packaging\/nopipeline-launcher\.sh %\{buildroot\}\/usr\/bin\/nopipeline$/m);
  assert.match(await read("debian/debian.rules"), /^\tinstall -m 0755 packaging\/nopipeline-launcher\.sh debian\/nopipeline\/usr\/bin\/nopipeline$/m);
  assert.match(await read("arch/PKGBUILD.in"), /^ {2}install -m 0755 packaging\/nopipeline-launcher\.sh "\$pkgdir\/usr\/bin\/nopipeline"$/m);
});

test("the launcher says its test variables are not a supported interface", async () => {
  const text = await readFile(fileURLToPath(new URL("../../packaging/nopipeline-launcher.sh", import.meta.url)), "utf8");
  assert.match(text, /NOPIPELINE_TEST_NODE and NOPIPELINE_TEST_CLI exist only for the test suite; they are not a supported interface/);
});
