import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

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

test("secrets appear only on env: lines, and never on a curl command line", () => {
  lines.forEach((l, n) => {
    if (!l.includes("${{ secrets.")) return;
    assert.match(l, /^\s+[A-Z_]+: \$\{\{ secrets\.[A-Z_]+ \}\}$/, `line ${n + 1} puts a secret somewhere other than a plain env value`);
    const indent = l.search(/\S/);
    let k = n - 1;
    while (k >= 0 && (lines[k]!.trim() === "" || lines[k]!.search(/\S/) >= indent)) k--;
    assert.equal(lines[k]!.trim(), "env:", `line ${n + 1} is not under env:`);
  });
  for (const l of lines.filter((x) => /\bcurl\b/.test(x))) {
    // The secret may go to printf (a shell builtin, so not in the process list) before the pipe, never to curl itself.
    assert.doesNotMatch(l.slice(l.lastIndexOf("|") + 1), /OBS_TOKEN|COPR_WEBHOOK/, "a secret on a curl command line would show in the process list");
  }
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
    "name: Trigger the Copr build",
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

test("Copr is skipped with a notice when the webhook secret is empty", () => {
  assert.match(text, /COPR_WEBHOOK: \$\{\{ secrets\.COPR_WEBHOOK \}\}/);
  assert.match(text, /\[ -z "\$COPR_WEBHOOK" \]/);
  assert.match(text, /::notice::[^\n]*Copr/);
});

test("the signers variable is compared with the tag's .release-signers and fills build-source.sh", () => {
  assert.match(text, /RELEASE_SIGNERS: \$\{\{ vars\.RELEASE_SIGNERS \}\}/);
  assert.match(text, /cmp -s[^\n]*\.release-signers/);
  assert.match(text, /::error::[^\n]*RELEASE_SIGNERS/);
  assert.match(text, /@RELEASE_SIGNERS@/);
});
