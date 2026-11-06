import { test } from "node:test";
import assert from "node:assert/strict";
import { isObsidianTag, mergeTags, readTags, sameTags, writeTags } from "../../src/vault/tags.ts";

const note = (line: string) => `---\nnotion-id: x\n${line}\n---\nBody`;

test("isObsidianTag accepts Obsidian's tag characters and rejects the rest", () => {
  for (const ok of ["draft", "a/b", "snake_case", "kebab-case", "über"]) assert.equal(isObsidianTag(ok), true, ok);
  for (const bad of ["2024", "to do", "a,b", "", "#x"]) assert.equal(isObsidianTag(bad), false, bad);
});

test("readTags reads each accepted form", () => {
  const ab = { kind: "tags", tags: ["a", "b"] };
  assert.deepEqual(readTags(note("tags: [a, b]")), ab);
  assert.deepEqual(readTags(note("tags: a, b")), ab);
  assert.deepEqual(readTags(note("tags:\n  - a\n  - b")), ab);
  assert.deepEqual(readTags(note("tags:\n- a\n- b")), ab);
  assert.deepEqual(readTags(note('tags: ["a", \'b\']')), ab);
  assert.deepEqual(readTags(note("tags: a")), { kind: "tags", tags: ["a"] });
  assert.deepEqual(readTags(note('tags: "#a"')), { kind: "tags", tags: ["a"] });
  assert.deepEqual(readTags(note("tags:\n  - '#a'")), { kind: "tags", tags: ["a"] });
  assert.deepEqual(readTags(note("tags: []")), { kind: "tags", tags: [] });
  assert.deepEqual(readTags(note("tags:")), { kind: "tags", tags: [] });
  assert.deepEqual(readTags("---\r\nnotion-id: x\r\ntags:\r\n  - a\r\n---\r\nBody"), { kind: "tags", tags: ["a"] });
});

test("readTags gives no tags when there is no key or no frontmatter", () => {
  assert.deepEqual(readTags(note("title: y")), { kind: "tags", tags: [] });
  assert.deepEqual(readTags("Just text #a"), { kind: "tags", tags: [] });
});

test("readTags marks shapes it cannot edit safely as unsafe", () => {
  for (const text of [
    note("tags: a\ntags: b"),
    note("tags: a # note"),
    note("tags:\n  - a # note"),
    note("tags: #a"),
    note("tags:\n  x: 1"),
    note("tags: a\n  - b"),
    note("tags: [a, {b: 1}]"),
    note("tags: [a, b"),
  ]) {
    assert.equal(readTags(text).kind, "unsafe", text);
  }
});

test("writeTags replaces the key's lines and keeps everything else", () => {
  assert.equal(
    writeTags("---\nnotion-id: x\ntags: [a]\ntitle: y\n---\nBody", ["a", "b"]),
    "---\nnotion-id: x\ntags:\n  - a\n  - b\ntitle: y\n---\nBody",
  );
  assert.equal(
    writeTags("---\ntags:\n  - a\n  - b\ntitle: y\n---\nBody", ["c"]),
    "---\ntags:\n  - c\ntitle: y\n---\nBody",
  );
});

test("writeTags adds the key at the end of the frontmatter or makes a frontmatter", () => {
  assert.equal(writeTags("---\ntitle: y\n---\nBody", ["a"]), "---\ntitle: y\ntags:\n  - a\n---\nBody");
  assert.equal(writeTags("Body\n", ["a"]), "---\ntags:\n  - a\n---\nBody\n");
});

test("writeTags with no tags removes only the key", () => {
  assert.equal(writeTags("---\nnotion-id: x\ntags:\n  - a\ntitle: y\n---\nBody", []), "---\nnotion-id: x\ntitle: y\n---\nBody");
  assert.equal(writeTags("---\ntags: [a]\n---\nBody", []), "---\n---\nBody");
  assert.equal(writeTags("---\ntitle: y\n---\nBody", []), "---\ntitle: y\n---\nBody");
  assert.equal(writeTags("Body", []), "Body");
});

test("writeTags keeps CRLF line endings", () => {
  assert.equal(
    writeTags("---\r\ntitle: y\r\ntags: a\r\n---\r\nBody\r\n", ["a", "b"]),
    "---\r\ntitle: y\r\ntags:\r\n  - a\r\n  - b\r\n---\r\nBody\r\n",
  );
  assert.equal(writeTags("Body\r\n", ["a"]), "---\r\ntags:\r\n  - a\r\n---\r\nBody\r\n");
});

test("writeTags quotes words YAML would read as another type, and readTags round-trips", () => {
  const text = "---\ntitle: y\n---\nBody";
  for (const tags of [["a", "b"], ["yes", "null", "x/y"], ["über"]]) {
    assert.deepEqual(readTags(writeTags(text, tags)), { kind: "tags", tags });
  }
  assert.match(writeTags(text, ["yes"]), /- "yes"/);
});

test("mergeTags is a case-insensitive three-way set merge", () => {
  assert.deepEqual(mergeTags(["a", "b"], ["a", "b", "c"], ["b"]), ["b", "c"]);
  assert.deepEqual(mergeTags(["A"], ["a"], ["A"]), ["a"]);
  assert.deepEqual(mergeTags(undefined, ["a"], ["b"]), ["a", "b"]);
  assert.deepEqual(mergeTags(["a"], ["a", "x"], ["a", "y"]), ["a", "x", "y"]);
  assert.deepEqual(mergeTags(["a", "b"], ["b"], ["a", "b"]), ["b"]);
  assert.deepEqual(mergeTags([], ["B"], ["b", "c"]), ["B", "c"]);
});

test("sameTags compares as sets, ignoring case and order", () => {
  assert.equal(sameTags(["a", "B"], ["b", "A"]), true);
  assert.equal(sameTags(["a"], ["a", "b"]), false);
  assert.equal(sameTags([], []), true);
});

test("readTags reads across a blank line inside the list", () => {
  assert.deepEqual(readTags(note("tags:\n  - a\n\n  - b\ntitle: y")), { kind: "tags", tags: ["a", "b"] });
  assert.deepEqual(readTags(note("tags:\n  - a\n   \n  - b")), { kind: "tags", tags: ["a", "b"] });
});

test("writeTags replaces a list with blank lines inside and keeps trailing blank lines", () => {
  assert.equal(writeTags(note("tags:\n  - a\n\n  - b\ntitle: y"), ["c"]), note("tags:\n  - c\ntitle: y"));
  assert.equal(writeTags(note("tags:\n  - a\n   \ntitle: y"), ["a", "b"]), note("tags:\n  - a\n  - b\n   \ntitle: y"));
  assert.equal(writeTags(note("tags:\n  - a\n\ntitle: y"), []), note("\ntitle: y"));
});

test("writeTags leaves a note it cannot read safely unchanged", () => {
  for (const line of ["tags: a\ntags: b", "tags: a # c", "tags:\n  x: 1"]) {
    assert.equal(writeTags(note(line), ["z"]), note(line));
  }
});

test("writeTags quotes values YAML would read as numbers, dates or indicators, and they read back", () => {
  const names = ["1e3", "0x1f", "2024-01-01", "-", "-x", "+1", ".5", "1a"];
  const text = writeTags("Body", names);
  for (const name of names) assert.ok(text.includes(`  - ${JSON.stringify(name)}\n`), name);
  const valid = names.filter((n) => isObsidianTag(n));
  assert.deepEqual(readTags(writeTags("Body", valid)), { kind: "tags", tags: valid });
  assert.match(writeTags("Body", ["plain", "yes"]), /\n {2}- plain\n {2}- "yes"\n/);
});
