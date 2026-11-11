import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { tempDir } from "../helpers/tmp.ts";

const script = fileURLToPath(new URL("../../packaging/obs-key.sh", import.meta.url));
const fingerprintFile = fileURLToPath(new URL("../../packaging/obs-signing-key.fingerprint", import.meta.url));
const have = (tool: string) => spawnSync("which", [tool], { stdio: "ignore" }).status === 0;
const skip = have("gpg") && have("curl") ? false : "gpg and curl are needed to make test keys";

/** Runs gpg in a private home, never the user's keyring. */
function gpg(home: string, args: string[], input?: Buffer | string) {
  return spawnSync("gpg", ["--batch", "--no-tty", "--homedir", home, ...args], { encoding: "buffer", input });
}
const text = (b: Buffer | string) => b.toString();

async function gnupgHome(t: import("node:test").TestContext): Promise<string> {
  const home = join(await tempDir(t), "gnupg");
  await mkdir(home, { mode: 0o700 });
  return home;
}

/** Makes a throwaway key (expiring on `expiry`, an ISO date) and returns its fingerprint. */
function makeKey(home: string, uid: string, expiry: string): string {
  const made = gpg(home, ["--passphrase", "", "--pinentry-mode", "loopback", "--quick-generate-key", `${uid} <${uid}@example.invalid>`, "ed25519", "sign", expiry]);
  assert.equal(made.status, 0, text(made.stderr));
  const listing = text(gpg(home, ["--with-colons", "--fingerprint", "--list-keys", uid]).stdout);
  return /^fpr:::::::::([0-9A-F]{40}):/m.exec(listing)![1]!;
}

function expiryOf(home: string, fpr: string): number {
  const pub = text(gpg(home, ["--with-colons", "--list-keys", fpr]).stdout).split("\n").find((l) => l.startsWith("pub:"))!;
  return Number(pub.split(":")[6]);
}

function armored(home: string, ...fprs: string[]): string {
  return text(gpg(home, ["--armor", "--export", ...fprs]).stdout);
}

async function run(t: import("node:test").TestContext, args: (out: string) => string[] | Promise<string[]>, opts: { shell?: string } = {}) {
  const out = join(await tempDir(t), "out");
  const r = spawnSync(opts.shell ?? "/bin/sh", [script, ...(await args(out))], { encoding: "utf8", env: { ...process.env, GNUPGHOME: await gnupgHome(t) } });
  const listing = await readdir(out).catch(() => null);
  return { r, out, listing };
}

async function keyFile(t: import("node:test").TestContext, content: string): Promise<string> {
  const path = join(await tempDir(t), "key.asc");
  await writeFile(path, content);
  return `file://${path}`;
}

/** Lists the keys in a key file, as gpg --with-colons lines. */
async function show(t: import("node:test").TestContext, file: string): Promise<string[]> {
  const home = await gnupgHome(t);
  return text(gpg(home, ["--show-keys", "--with-colons", file]).stdout).split("\n");
}

const fingerprints = (lines: string[]) => lines.filter((l) => l.startsWith("fpr:")).map((l) => l.split(":")[9]);

const files = ["nopipeline-archive-keyring.gpg", "nopipeline-trusted", "nopipeline.gpg"];

test("the pinned key is exported with its expiry", { skip }, async (t) => {
  const home = await gnupgHome(t);
  const fpr = makeKey(home, "pinned", "2031-05-01");
  const url = await keyFile(t, armored(home, fpr));
  const { r, out } = await run(t, (o) => [url, fpr, o]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual((await readdir(join(out, "keys"))).sort(), files);
  assert.equal(Number((await readFile(join(out, "expires"), "utf8")).trim()), expiryOf(home, fpr));
  assert.ok(expiryOf(home, fpr) > 1_900_000_000);
  const lines = await show(t, join(out, "keys", "nopipeline-archive-keyring.gpg"));
  assert.equal(lines.filter((l) => l.startsWith("pub:")).length, 1);
  assert.deepEqual(fingerprints(lines)[0], fpr);
  assert.deepEqual(await readFile(join(out, "keys", "nopipeline.gpg")), await readFile(join(out, "keys", "nopipeline-archive-keyring.gpg")));
  assert.equal(await readFile(join(out, "keys", "nopipeline-trusted"), "utf8"), `${fpr}:4:\n`);
  assert.equal((await stat(join(out, "keys", "nopipeline.gpg"))).isFile(), true);
});

test("an extended key with the same fingerprint is accepted", { skip }, async (t) => {
  const home = await gnupgHome(t);
  const fpr = makeKey(home, "pinned", "2031-05-01");
  const before = expiryOf(home, fpr);
  const set = gpg(home, ["--passphrase", "", "--pinentry-mode", "loopback", "--quick-set-expire", fpr, "2033-05-01"]);
  assert.equal(set.status, 0, text(set.stderr));
  const after = expiryOf(home, fpr);
  assert.ok(after > before);
  const { r, out } = await run(t, async (o) => [await keyFile(t, armored(home, fpr)), fpr, o]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(Number((await readFile(join(out, "expires"), "utf8")).trim()), after);
});

test("a key without an expiry is recorded as 0", { skip }, async (t) => {
  const home = await gnupgHome(t);
  const fpr = makeKey(home, "pinned", "0");
  const { r, out } = await run(t, async (o) => [await keyFile(t, armored(home, fpr)), fpr, o]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await readFile(join(out, "expires"), "utf8"), "0\n");
});

test("a second key in the download is dropped", { skip }, async (t) => {
  const home = await gnupgHome(t);
  const fpr = makeKey(home, "pinned", "2031-05-01");
  const other = makeKey(home, "other", "2031-05-01");
  const { r, out } = await run(t, async (o) => [await keyFile(t, armored(home, other, fpr)), fpr, o]);
  assert.equal(r.status, 0, r.stderr);
  const lines = await show(t, join(out, "keys", "nopipeline-archive-keyring.gpg"));
  assert.deepEqual(fingerprints(lines), [fpr]);
});

test("a different key fails", { skip }, async (t) => {
  const home = await gnupgHome(t);
  const fpr = makeKey(home, "pinned", "2031-05-01");
  const other = makeKey(home, "other", "2031-05-01");
  const { r, out, listing } = await run(t, async (o) => [await keyFile(t, armored(home, other)), fpr, o]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^obs-key: /);
  assert.equal(listing, null, out);
});

test("a key that only has the pinned fingerprint as a subkey fails", { skip }, async (t) => {
  const home = await gnupgHome(t);
  const main = makeKey(home, "main", "2031-05-01");
  const add = gpg(home, ["--passphrase", "", "--pinentry-mode", "loopback", "--quick-add-key", main, "ed25519", "sign", "2031-05-01"]);
  assert.equal(add.status, 0, text(add.stderr));
  const listing = text(gpg(home, ["--with-colons", "--fingerprint", "--list-keys", main]).stdout);
  const sub = [...listing.matchAll(/^fpr:::::::::([0-9A-F]{40}):/gm)].map((m) => m[1]!)[1]!;
  const { r, listing: written } = await run(t, async (o) => [await keyFile(t, armored(home, main)), sub, o]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^obs-key: /);
  assert.equal(written, null);
});

for (const bad of ["", "abc", "0".repeat(39), "0".repeat(41), "G".repeat(40), `${"0".repeat(20)} ${"0".repeat(20)}`]) {
  test(`a malformed fingerprint fails (${JSON.stringify(bad.slice(0, 12))})`, { skip }, async (t) => {
    const home = await gnupgHome(t);
    const fpr = makeKey(home, "pinned", "2031-05-01");
    const { r, listing } = await run(t, async (o) => [await keyFile(t, armored(home, fpr)), bad, o]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^obs-key: /);
    assert.equal(listing, null);
  });
}

test("a failed download fails", { skip }, async (t) => {
  const fpr = "A".repeat(40);
  const { r, listing } = await run(t, (o) => [`file://${join(o, "..", "missing.asc")}`, fpr, o]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^obs-key: /);
  assert.equal(listing, null);
});

test("a download that is not a key fails", { skip }, async (t) => {
  const { r, listing } = await run(t, async (o) => [await keyFile(t, "<html>not a key</html>\n"), "B".repeat(40), o]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^obs-key: /);
  assert.equal(listing, null);
});

test("third-party certifications are stripped", { skip }, async (t) => {
  const home = await gnupgHome(t);
  const fpr = makeKey(home, "pinned", "2031-05-01");
  const other = makeKey(home, "other", "2031-05-01");
  const signed = gpg(home, ["--passphrase", "", "--pinentry-mode", "loopback", "--local-user", other, "--quick-sign-key", fpr]);
  assert.equal(signed.status, 0, text(signed.stderr));
  const otherId = other.slice(-16);
  const withSig = spawnSync("gpg", ["--batch", "--homedir", home, "--export", fpr], { encoding: "buffer" }).stdout;
  assert.match(text(gpg(home, ["--list-packets"], withSig).stdout), new RegExp(`keyid ${otherId}`), "the test key carries the certification");
  const { r, out } = await run(t, async (o) => [await keyFile(t, armored(home, fpr)), fpr, o]);
  assert.equal(r.status, 0, r.stderr);
  const packets = text(gpg(await gnupgHome(t), ["--list-packets", join(out, "keys", "nopipeline-archive-keyring.gpg")]).stdout);
  assert.doesNotMatch(packets, new RegExp(`keyid ${otherId}`));
});

test("--project builds the OBS download URL and checks the project name", { skip }, async (t) => {
  const bad = await run(t, (o) => ["--project", "home:a/../b", "A".repeat(40), o]);
  assert.equal(bad.r.status, 1);
  assert.match(bad.r.stderr, /^obs-key: /);
  assert.equal(bad.listing, null);
  const missing = await run(t, (o) => ["--project", "", "A".repeat(40), o]);
  assert.equal(missing.r.status, 1);
  assert.match(missing.r.stderr, /^obs-key: /);
});

test("the committed fingerprint file is 40 hex characters", async () => {
  assert.match(await readFile(fingerprintFile, "utf8"), /^[0-9A-Fa-f]{40}\n$/);
});

const dash = have("dash");
test("the script runs under dash", { skip: skip || (dash ? false : "dash is not installed") }, async (t) => {
  const home = await gnupgHome(t);
  const fpr = makeKey(home, "pinned", "2031-05-01");
  const { r, out } = await run(t, async (o) => [await keyFile(t, armored(home, fpr)), fpr, o], { shell: "dash" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await readFile(join(out, "keys", "nopipeline-trusted"), "utf8"), `${fpr}:4:\n`);
});
