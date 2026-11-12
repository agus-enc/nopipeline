import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { check, decide, expiryOfKeyring, shouldCreate, type Deps } from "../scripts/key-check.ts";
import { tempDir } from "./helpers/tmp.ts";
import { injectionProblems, secretProblems } from "./helpers/workflow-text.ts";

const DAY = 86400;
const NOW = Date.UTC(2026, 10, 11) / 1000;
const input = (over: Partial<Parameters<typeof decide>[0]> = {}) => ({ shippedExpires: NOW + 100 * DAY, servedExpires: NOW + 100 * DAY, servedMatchesPin: true, now: NOW, ...over });

test("a key that expires in 91 days raises nothing, in 89 days an issue", () => {
  assert.equal(decide(input({ shippedExpires: NOW + 91 * DAY })), null);
  const issue = decide(input({ shippedExpires: NOW + 89 * DAY }));
  assert.equal(issue?.title, "OBS repo key expires on 2027-02-08");
});

test("exactly 90 days is not yet; the dates are UTC", () => {
  assert.equal(decide(input({ shippedExpires: NOW + 90 * DAY })), null);
  assert.equal(decide(input({ shippedExpires: Date.UTC(2027, 0, 1, 23, 59, 59) / 1000, now: Date.UTC(2026, 11, 1) / 1000 }))?.title, "OBS repo key expires on 2027-01-01");
});

test("an extended key on OBS says to tag a patch release", () => {
  const issue = decide(input({ shippedExpires: NOW + 30 * DAY, servedExpires: NOW + 700 * DAY }));
  assert.match(issue!.body, /tag a patch release/);
  assert.doesNotMatch(issue!.body, /has not extended/);
  assert.match(issue!.body, /2026-12-11/);
  assert.match(issue!.body, /docs\/development\.md#obs-repo-key/);
});

test("a served key without an expiry counts as extended", () => {
  const issue = decide(input({ shippedExpires: NOW + 30 * DAY, servedExpires: 0 }));
  assert.match(issue!.body, /tag a patch release/);
  assert.doesNotMatch(issue!.body, /has not extended/);
  assert.doesNotMatch(issue!.body, /1970/);
});

test("a key OBS has not extended says to check the signing keys", () => {
  const issue = decide(input({ shippedExpires: NOW + 30 * DAY, servedExpires: NOW + 30 * DAY }));
  assert.match(issue!.body, /OBS has not extended it yet; check the project's signing keys/);
  assert.doesNotMatch(issue!.body, /tag a patch release/);
});

test("an already expired key still raises the issue", () => {
  assert.equal(decide(input({ shippedExpires: NOW - 5 * DAY }))?.title, "OBS repo key expires on 2026-11-06");
});

test("a key that changed gives its own issue, whatever the expiry", () => {
  for (const shippedExpires of [0, NOW + 400 * DAY, NOW + 5 * DAY]) {
    const issue = decide(input({ servedMatchesPin: false, shippedExpires }));
    assert.equal(issue?.title, "OBS repo key changed");
    assert.match(issue!.body, /docs\/development\.md#obs-repo-key/);
  }
});

test("a key without an expiry raises nothing", () => {
  assert.equal(decide(input({ shippedExpires: 0, servedExpires: 0 })), null);
});

test("the docs link can be a full URL", () => {
  assert.match(decide({ ...input({ shippedExpires: NOW + DAY }), docsUrl: "https://example.test/d.md#obs-repo-key" })!.body, /https:\/\/example\.test\/d\.md#obs-repo-key/);
});

test("shouldCreate: an open issue with the same title means no new one", () => {
  assert.equal(shouldCreate([], "OBS repo key changed"), true);
  assert.equal(shouldCreate(["Something else"], "OBS repo key changed"), true);
  assert.equal(shouldCreate(["Something else", "OBS repo key changed"], "OBS repo key changed"), false);
  assert.equal(shouldCreate(["OBS repo key expires on 2027-01-01"], "OBS repo key expires on 2027-02-01"), true, "another date is another issue");
  assert.equal(shouldCreate(["OBS repo key changed again"], "OBS repo key changed"), true, "whole title only");
});

function deps(over: Partial<Deps> = {}): Deps & { created: { title: string; body: string }[] } {
  const created: { title: string; body: string }[] = [];
  return {
    created,
    shippedExpires: async () => NOW + 30 * DAY,
    served: async () => ({ matchesPin: true, expires: NOW + 700 * DAY }),
    openTitles: async () => [],
    createIssue: async (issue) => void created.push(issue),
    now: () => NOW,
    ...over,
  };
}

test("check opens one issue when the shipped key is close to expiry", async () => {
  const d = deps();
  await check(d);
  assert.equal(d.created.length, 1);
  assert.equal(d.created[0]!.title, "OBS repo key expires on 2026-12-11");
});

test("check opens nothing when an issue with that title is already open", async () => {
  const d = deps({ openTitles: async () => ["OBS repo key expires on 2026-12-11"] });
  await check(d);
  assert.deepEqual(d.created, []);
});

test("check opens nothing when the key is far from expiry", async () => {
  const d = deps({ shippedExpires: async () => NOW + 300 * DAY });
  await check(d);
  assert.deepEqual(d.created, []);
});

test("check opens the changed-key issue on a fingerprint mismatch", async () => {
  const d = deps({ served: async () => ({ matchesPin: false, expires: 0 }) });
  await check(d);
  assert.equal(d.created[0]!.title, "OBS repo key changed");
});

test("a fetch failure rejects and opens no issue", async () => {
  for (const over of [
    { shippedExpires: async () => Promise.reject(new Error("no release")) },
    { served: async () => Promise.reject(new Error("network down")) },
    { openTitles: async () => Promise.reject(new Error("gh failed")) },
  ]) {
    const d = deps(over);
    await assert.rejects(check(d));
    assert.deepEqual(d.created, []);
  }
});

// --- real helpers with a fake gh on PATH (no GitHub, no OBS) ---

const have = (tool: string) => spawnSync("which", [tool], { stdio: "ignore" }).status === 0;
const skip = have("gpg") ? false : "gpg is needed to make a test key";
const script = fileURLToPath(new URL("../scripts/key-check.ts", import.meta.url));

test("expiryOfKeyring reads the primary key's expiry and does not import the key", { skip }, async (t) => {
  const dir = await tempDir(t);
  const home = join(dir, "gnupg");
  spawnSync("mkdir", ["-m", "700", home]);
  const g = (...a: string[]) => spawnSync("gpg", ["--batch", "--no-tty", "--homedir", home, ...a], { encoding: "buffer" });
  assert.equal(g("--passphrase", "", "--pinentry-mode", "loopback", "--quick-generate-key", "t <t@example.invalid>", "ed25519", "sign", "2031-05-01").status, 0);
  await writeFile(join(dir, "k.gpg"), g("--export").stdout);
  const before = await readFile(join(dir, "k.gpg"));
  const pub = g("--with-colons", "--list-keys").stdout.toString().split("\n").find((l) => l.startsWith("pub:"))!;
  const expected = Number(pub.split(":")[6]);
  assert.ok(expected > Date.UTC(2031, 3, 29) / 1000 && expected < Date.UTC(2031, 4, 3) / 1000);
  assert.equal(await expiryOfKeyring(join(dir, "k.gpg")), expected);
  assert.deepEqual(await readFile(join(dir, "k.gpg")), before);
});

test("expiryOfKeyring runs gpg in a private home and leaves the caller's GNUPGHOME alone", { skip }, async (t) => {
  const dir = await tempDir(t);
  const home = join(dir, "gnupg");
  spawnSync("mkdir", ["-m", "700", home]);
  const g = (...a: string[]) => spawnSync("gpg", ["--batch", "--no-tty", "--homedir", home, ...a], { encoding: "buffer" });
  assert.equal(g("--passphrase", "", "--pinentry-mode", "loopback", "--quick-generate-key", "t <t@example.invalid>", "ed25519", "sign", "2031-05-01").status, 0);
  await writeFile(join(dir, "k.gpg"), g("--export").stdout);
  const callers = join(dir, "callers-home");
  const saved = process.env.GNUPGHOME;
  process.env.GNUPGHOME = callers;
  try {
    await expiryOfKeyring(join(dir, "k.gpg"));
  } finally {
    if (saved === undefined) delete process.env.GNUPGHOME;
    else process.env.GNUPGHOME = saved;
  }
  assert.equal(await stat(callers).then(() => true, () => false), false, "the caller's GNUPGHOME was not created");
});

/** A fake gh on PATH: logs its arguments; `release view` answers with VIEW_OUT on stdout / VIEW_ERR on stderr and exit VIEW_EXIT; everything else exits 1. */
async function fakeGh(t: import("node:test").TestContext, view: { out?: string; err?: string; exit: number }) {
  const dir = await tempDir(t);
  const log = join(dir, "gh.log");
  await writeFile(
    join(dir, "gh"),
    `#!/bin/sh\necho "$*" >> '${log}'\nif [ "$1 $2" = "release view" ]; then\n  [ -z "$VIEW_OUT" ] || printf '%s\\n' "$VIEW_OUT"\n  [ -z "$VIEW_ERR" ] || printf '%s\\n' "$VIEW_ERR" >&2\n  exit "$VIEW_EXIT"\nfi\nexit 1\n`,
  );
  await chmod(join(dir, "gh"), 0o755);
  const r = () =>
    spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, VIEW_OUT: view.out ?? "", VIEW_ERR: view.err ?? "", VIEW_EXIT: String(view.exit) },
    });
  const calls = async () => readFile(log, "utf8").catch(() => "");
  return { r, calls };
}

test("main looks up the release's assets, then downloads the keyring; exit 1 and no issue when that fails", async (t) => {
  const gh = await fakeGh(t, { out: '{"assets":[{"name":"SHA256SUMS"},{"name":"nopipeline-archive-keyring.gpg"}]}', exit: 0 });
  const r = gh.r();
  assert.equal(r.status, 1);
  const calls = await gh.calls();
  assert.match(calls, /release view --json assets/);
  assert.match(calls, /release download --pattern nopipeline-archive-keyring\.gpg --dir /);
  assert.doesNotMatch(calls, /issue create/);
});

test("main: no release at all is a notice and exit 0, no download and no issue", async (t) => {
  const gh = await fakeGh(t, { err: "release not found", exit: 1 });
  const r = gh.r();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^::notice::/m);
  assert.doesNotMatch(await gh.calls(), /download|issue/);
});

test("main: a latest release without the keyring asset is a notice and exit 0", async (t) => {
  const gh = await fakeGh(t, { out: '{"assets":[{"name":"SHA256SUMS"}]}', exit: 0 });
  const r = gh.r();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^::notice::/m);
  assert.doesNotMatch(await gh.calls(), /download|issue/);
});

test("main: any other gh failure while looking up the release still exits 1", async (t) => {
  const gh = await fakeGh(t, { err: "error connecting to api.github.com", exit: 1 });
  const r = gh.r();
  assert.equal(r.status, 1);
  assert.doesNotMatch(await gh.calls(), /issue/);
});

test("check with nothing shipped yet opens no issue and does not ask OBS", async () => {
  const d = deps({ shippedExpires: async () => null, served: async () => Promise.reject(new Error("must not be called")) });
  await check(d);
  assert.deepEqual(d.created, []);
});

// --- the workflow ---

const wfText = await readFile(fileURLToPath(new URL("../.github/workflows/key-check.yml", import.meta.url)), "utf8");
const wf = wfText.split("\n");

test("the workflow runs monthly and by hand", () => {
  const i = wf.findIndex((l) => l === "on:");
  assert.deepEqual(wf.slice(i, i + 5), ["on:", "  schedule:", "    - cron: '17 6 1 * *'", "  workflow_dispatch:", ""]);
});

test("permissions are exactly contents: read and issues: write", () => {
  const i = wf.findIndex((l) => l === "permissions:");
  assert.notEqual(i, -1);
  assert.deepEqual(wf.slice(i, i + 3), ["permissions:", "  contents: read", "  issues: write"]);
  assert.equal(wf.filter((l) => /^\s*permissions:/.test(l)).length, 1);
});

test("no secrets, only the job's own token, and no expression inside a script", () => {
  assert.doesNotMatch(wfText.replace(/^\s*#.*$/gm, ""), /secrets\b/i);
  assert.deepEqual(secretProblems(wf), []);
  assert.deepEqual(injectionProblems(wf), []);
  assert.match(wfText, /^ {10}GH_TOKEN: \$\{\{ github\.token \}\}$/m);
  assert.doesNotMatch(wfText, /set\s+-[a-z]*x/);
});

test("every action is a pinned commit", () => {
  const uses = wf.filter((l) => /^\s*-?\s*uses:/.test(l)).map((l) => l.replace(/^\s*-?\s*uses:\s*/, ""));
  assert.ok(uses.length >= 2);
  for (const u of uses) assert.match(u, /^actions\/(checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1|setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7\.1\.0)$/);
});
