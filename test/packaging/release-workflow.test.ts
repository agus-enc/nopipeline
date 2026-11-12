import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { injectionProblems, secretProblems, yaml } from "../helpers/workflow-text.ts";

// The workflow is read as text: no YAML parser is a dependency, and the rules below are about lines.
const file = fileURLToPath(new URL("../../.github/workflows/release.yml", import.meta.url));
const text = await readFile(file, "utf8");
const lines = text.split("\n");

const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
const SETUP_NODE = "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0";
const TAG_PATTERN = "v[0-9]+.[0-9]+.[0-9]+";

/** The lines of one job (from its `  name:` line to the next job). */
function job(name: string): string[] {
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.notEqual(start, -1, `job ${name} not found`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

test("the trigger is a push of a tag matching exactly vX.Y.Z", () => {
  const i = lines.findIndex((l) => l === "on:");
  assert.deepEqual(lines.slice(i, i + 4), ["on:", "  push:", "    tags:", `      - '${TAG_PATTERN}'`]);
  assert.equal(text.match(/^\s+-? ?'?v\[0-9\][^\n]*$/gm)?.length, 1, "only one tag pattern");
});

test("the tag pattern, read as GitHub's filter pattern, accepts releases and refuses everything else", () => {
  // GitHub filter pattern cheat sheet: `+` is one or more of the preceding character, [] a character class, `.` is literal
  // (its own example `v[12].[0-9]+.[0-9]+` matches v1.10.1).
  const re = new RegExp(`^${TAG_PATTERN.replaceAll(".", "\\.")}$`);
  for (const ok of ["v1.2.3", "v0.3.0", "v10.20.30"]) assert.match(ok, re);
  for (const bad of ["v1.2.3-rc1", "v1.2", "release-1", "v1.2.3.4", "1.2.3", "v1.2.x", "v1.2.3/x"]) assert.doesNotMatch(bad, re);
});

test("releases are serialised: one concurrency group at the top, never cancelling a running release", () => {
  const i = lines.findIndex((l) => l === "concurrency:");
  assert.notEqual(i, -1, "a top-level concurrency: block");
  assert.deepEqual(lines.slice(i, i + 3), ["concurrency:", "  group: release", "  cancel-in-progress: false"]);
  assert.equal(lines.filter((l) => /^\s*concurrency:/.test(l)).length, 1);
});

test("permissions are empty at the top", () => {
  assert.ok(lines.includes("permissions: {}"));
  assert.equal(lines.filter((l) => /^permissions:/.test(l)).length, 1);
});

test("every action is one of the two pinned commits", () => {
  const uses = lines.filter((l) => /^\s*-?\s*uses:/.test(l));
  assert.ok(uses.length >= 4);
  for (const l of uses) {
    const value = l.replace(/^\s*-?\s*uses:\s*/, "");
    assert.ok(value === CHECKOUT || value === SETUP_NODE, `unexpected action: ${l}`);
  }
});

test("nothing prints a secret: no set -x, curl -v, --verbose", () => {
  assert.doesNotMatch(text, /set\s+-[a-z]*x/);
  assert.doesNotMatch(text, /set\s+-o\s+xtrace/);
  assert.doesNotMatch(text, /curl\b[^\n]*\s-[a-zA-Z]*v/);
  assert.doesNotMatch(text, /--verbose/);
  assert.doesNotMatch(text, /--trace/);
});

const GOOD = `jobs:
  publish:
    steps:
      - name: x
        env:
          OBS_TOKEN: \${{ secrets.OBS_TOKEN }}
        run: |
          echo hi
`;

test("secrets sit only in a step's own env: the real file, and broken copies are caught", () => {
  assert.deepEqual(secretProblems(lines), []);
  assert.deepEqual(secretProblems(yaml(GOOD)), []);
  const jobEnv = `jobs:\n  publish:\n    env:\n      OBS_TOKEN: \${{ secrets.OBS_TOKEN }}\n    steps:\n      - run: x\n`;
  assert.notEqual(secretProblems(yaml(jobEnv)).length, 0, "job-level env");
  for (const bad of ["\${{secrets.OBS_TOKEN}}", "\${{ secrets['OBS_TOKEN'] }}", "\${{ toJSON(secrets) }}", "inherit"]) {
    const broken = GOOD.replace("\${{ secrets.OBS_TOKEN }}", bad).replace("echo hi", bad.includes("secrets") ? "echo hi" : "echo hi\n      - uses: ./x\n        secrets: inherit");
    assert.notEqual(secretProblems(yaml(broken)).length, 0, bad);
  }
  assert.notEqual(secretProblems(yaml(GOOD.replace("echo hi", "echo \${{ secrets.OBS_TOKEN }}"))).length, 0, "in run");
  assert.notEqual(secretProblems(yaml(GOOD.replace("echo hi", "echo SECRETS"))).length, 0, "case-insensitive word");
});

test("the real file never puts a secret on a curl command line", () => {
  for (const l of lines.filter((x) => /\bcurl\b/.test(x))) {
    // The secret may go to printf (a shell builtin, so not in the process list) before the pipe, never to curl itself.
    assert.doesNotMatch(l.slice(l.lastIndexOf("|") + 1), /OBS_TOKEN/, "a secret on a curl command line would show in the process list");
  }
});

test("no ${{ }} expression inside a run: script: the real file, and broken copies are caught", () => {
  assert.deepEqual(injectionProblems(lines), []);
  assert.deepEqual(injectionProblems(yaml(GOOD)), []);
  assert.notEqual(injectionProblems(yaml(GOOD.replace("echo hi", "echo \${{ github.ref_name }}"))).length, 0, "ref_name in run");
  assert.notEqual(injectionProblems(yaml(GOOD.replace("echo hi", "echo \${{ vars.X }}"))).length, 0, "vars in run");
  assert.notEqual(injectionProblems(yaml(GOOD.replace("run: |", "run: echo \${{ github.ref_name }}"))).length, 0, "one-line run");
});

test("the environment is on the publish job only", () => {
  assert.equal(lines.filter((l) => /^\s+environment:/.test(l)).length, 1);
  assert.ok(job("publish").includes("    environment: release"));
  assert.ok(job("build").every((l) => !/environment:/.test(l)));
});

test("the build job has no secrets, read-only contents and runs the checks", () => {
  const build = job("build").join("\n");
  assert.doesNotMatch(build, /secrets\./);
  assert.match(build, /permissions:\n {6}contents: read\n/);
  for (const cmd of ["npm ci", "npm audit signatures", "npm run check"]) assert.ok(build.includes(cmd), cmd);
  assert.match(build, /persist-credentials: false/);
  assert.match(build, /fetch-depth: 0/);
});

test("the publish job needs build, can write contents only, and does the release steps in order", () => {
  const publish = job("publish").join("\n");
  assert.match(publish, /needs: build\n/);
  assert.match(publish, /permissions:\n {6}contents: write\n/);
  assert.equal(lines.filter((l) => /^\s+contents: write/.test(l)).length, 1);
  const order = [
    "name: The tag's .release-signers equals RELEASE_SIGNERS",
    "name: Fetch and check the OBS repo key",
    "name: Verify the tag and build the sources",
    "name: Build and install the Debian package",
    "name: Build and install the Arch package",
    "name: Publish the GitHub release",
    "name: Trigger the OBS service run",
  ].map((s) => {
    const at = publish.indexOf(s);
    assert.notEqual(at, -1, `${s} missing`);
    return at;
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("the OBS trigger sends the token through curl's stdin config, not an argument", () => {
  assert.match(text, /https:\/\/api\.opensuse\.org\/trigger\/runservice/);
  assert.match(text, /OBS_TOKEN: \$\{\{ secrets\.OBS_TOKEN \}\}/);
  assert.match(text, /printf 'header = "Authorization: Token %s"\\n' "\$OBS_TOKEN" \| curl [^\n]*--config -/);
  assert.match(text, /openbuildservice\.org\/help\/manuals\/obs-user-guide\/cha-obs-authorization-token/);
});

test("the signers variable is compared with the tag's .release-signers and fills build-source.sh", () => {
  assert.match(text, /RELEASE_SIGNERS: \$\{\{ vars\.RELEASE_SIGNERS \}\}/);
  assert.match(text, /cmp -s[^\n]*\.release-signers/);
  assert.match(text, /::error::[^\n]*RELEASE_SIGNERS/);
  assert.match(text, /@RELEASE_SIGNERS@/);
});
