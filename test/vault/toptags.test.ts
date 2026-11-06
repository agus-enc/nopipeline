import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { moveTopTags } from "../../src/vault/toptags.ts";
import { tempDir, writeTree } from "../helpers/tmp.ts";

const run = (...args: string[]) =>
  promisify(execFile)(process.execPath, ["scripts/move-top-tags.ts", ...args]).then(
    (r) => ({ code: 0, stdout: r.stdout }),
    (e: { code: number; stdout: string }) => ({ code: e.code, stdout: e.stdout }),
  );

test("a leading tag-only line moves into the frontmatter tags, with the blank line after it", () => {
  assert.deepEqual(moveTopTags("---\nnotion-id: x\n---\n#draft \n\nText"), {
    text: "---\nnotion-id: x\ntags:\n  - draft\n---\nText",
    moved: ["draft"],
  });
});

test("a note without frontmatter gets one; leading blank lines stay", () => {
  assert.deepEqual(moveTopTags("\n#a\nText"), { text: "---\ntags:\n  - a\n---\n\nText", moved: ["a"] });
});

test("several tag lines are moved in order", () => {
  assert.deepEqual(moveTopTags("---\nnotion-id: x\n---\n#a #b\n#c\n\nText")?.moved, ["a", "b", "c"]);
});

test("names already in the frontmatter tags are not repeated, whatever the case", () => {
  const out = moveTopTags("---\ntags: [a]\n---\n#A #b\nText");
  assert.equal(out?.text, "---\ntags:\n  - a\n  - b\n---\nText");
});

test("notes without a leading tag-only line, or with unsafe tags, are left alone", () => {
  const cases = [
    "#a and words\nText",
    "# Heading\nText",
    "Text\n\n#a\n",
    "```\n#a\n```\n",
    "#2024\nText",
    "---\ntags: [a, \"b\n---\n#c\nText",
    "---\ntags: a # note\n---\n#c\nText",
  ];
  for (const text of cases) assert.equal(moveTopTags(text), null, text);
});

test("the script reports in a dry run, refuses --write without --backup, and backs up before writing", async (t) => {
  const vault = await tempDir(t);
  const backup = await tempDir(t);
  const original = "---\nnotion-id: x\n---\n#a #b\n\nText\n";
  await writeTree(vault, { "One.md": original, "sub/Two.md": "Plain\n" });

  const dry = await run(vault);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /One\.md: #a #b/);
  assert.match(dry.stdout, /1 notes, 2 tags/);
  assert.equal(await readFile(join(vault, "One.md"), "utf8"), original);

  assert.equal((await run(vault, "--write")).code, 2);
  assert.equal((await run()).code, 2);
  assert.equal(await readFile(join(vault, "One.md"), "utf8"), original);

  const done = await run(vault, "--write", "--backup", backup);
  assert.equal(done.code, 0);
  assert.equal(await readFile(join(vault, "One.md"), "utf8"), "---\nnotion-id: x\ntags:\n  - a\n  - b\n---\nText\n");
  assert.equal(await readFile(join(backup, "One.md"), "utf8"), original);
  await assert.rejects(readFile(join(backup, "sub/Two.md"), "utf8"));
});

test("a tag line may start with up to three spaces; four spaces or a tab make a code block and never count", () => {
  assert.deepEqual(moveTopTags(" #a \nText"), { text: "---\ntags:\n  - a\n---\nText", moved: ["a"] });
  assert.equal(moveTopTags("   #a\nText")?.moved[0], "a");
  assert.equal(moveTopTags("    #a\nText"), null);
  assert.equal(moveTopTags("\t#a\nText"), null);
});

test("the script refuses a backup folder that is not empty, and never overwrites a backup", async (t) => {
  const vault = await tempDir(t);
  const backup = await tempDir(t);
  const original = "---\nnotion-id: x\n---\n#a\nText\n";
  await writeTree(vault, { "One.md": original });
  await writeTree(backup, { "One.md": "the true original\n" });
  const refused = await run(vault, "--write", "--backup", backup);
  assert.equal(refused.code, 2);
  assert.equal(await readFile(join(backup, "One.md"), "utf8"), "the true original\n");
  assert.equal(await readFile(join(vault, "One.md"), "utf8"), original);
});

test("the script refuses a backup folder inside the vault", async (t) => {
  const vault = await tempDir(t);
  const original = "#a\nText\n";
  await writeTree(vault, { "One.md": original });
  for (const inside of [join(vault, "bak"), vault]) {
    const refused = await run(vault, "--write", "--backup", inside);
    assert.equal(refused.code, 2, inside);
  }
  assert.equal(await readFile(join(vault, "One.md"), "utf8"), original);
  await assert.rejects(readFile(join(vault, "bak", "One.md"), "utf8"));
});

test("the script refuses a backup value that is another option", async (t) => {
  const vault = await tempDir(t);
  await writeTree(vault, { "One.md": "#a\nText\n" });
  const refused = await run(vault, "--backup", "--write");
  assert.equal(refused.code, 2);
  assert.equal(await readFile(join(vault, "One.md"), "utf8"), "#a\nText\n");
});
