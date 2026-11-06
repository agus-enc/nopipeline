import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { contentUpdates } from "../../src/merge/edits.ts";

function apply(text: string, edits: { old_str: string; new_str: string }[]): string {
  for (const e of edits) {
    assert.equal(text.split(e.old_str).length - 1, 1, `old_str must be unique: ${JSON.stringify(e.old_str)}`);
    text = text.replace(e.old_str, () => e.new_str);
  }
  return text;
}

test("a single changed line becomes one small edit", () => {
  assert.deepEqual(contentUpdates("# T\nold line\nend", "# T\nnew line\nend"), [{ old_str: "old line", new_str: "new line" }]);
});

test("repeated lines get context until they are unique", () => {
  const before = "- x\n- item\n- y\n- item";
  const after = "- x\n- item\n- y\n- item changed";
  assert.deepEqual(contentUpdates(before, after), [{ old_str: "- y\n- item", new_str: "- y\n- item changed" }]);
});

test("insertions and deletions carry a neighbouring line", () => {
  assert.deepEqual(contentUpdates("a\nb", "a\nnew\nb"), [{ old_str: "a", new_str: "a\nnew" }]);
  assert.deepEqual(contentUpdates("a\nb\nc", "a\nc"), [{ old_str: "a\nb", new_str: "a" }]);
});

test("no change needs no edits, and an empty page can't be edited in place", () => {
  assert.deepEqual(contentUpdates("same", "same"), []);
  assert.equal(contentUpdates("", "new page"), null);
});

test("edits always reproduce the target text exactly", () => {
  const line = fc.stringMatching(/^[a-c]{0,2}$/);
  fc.assert(fc.property(fc.array(line, { maxLength: 10 }), fc.array(line, { maxLength: 10 }), (x, y) => {
    const before = x.join("\n");
    const after = y.join("\n");
    const edits = contentUpdates(before, after);
    if (edits !== null) assert.equal(apply(before, edits), after);
  }));
});

const image = (n: number) => `![c${n}](https://nopipeline.invalid/vault/a.png)`;
const isImage = (line: string) => /^!\[.*\]\(.*\)$/.test(line);

test("the default unsearchable predicate changes nothing", () => {
  const before = `x\n${image(1)}\nx`;
  const after = `x\n${image(1)}\ny`;
  assert.deepEqual(contentUpdates(before, after), [{ old_str: `${image(1)}\nx`, new_str: `${image(1)}\ny` }]);
  assert.deepEqual(contentUpdates(before, after, 100, () => false), contentUpdates(before, after));
});

test("an edit beside an unsearchable line keeps it out of the search text when the line is unique", () => {
  const before = `a\n${image(1)}\nb`;
  const after = `a\n${image(1)}\nB`;
  assert.deepEqual(contentUpdates(before, after, 100, isImage), [{ old_str: "b", new_str: "B" }]);
});

test("context grows the other way round an unsearchable line", () => {
  // The first "x" needs context to be unique; the line above it is an image, so the context comes from below.
  const before = `${image(1)}\nx\nk\nx`;
  const after = `${image(1)}\ny\nk\nx`;
  assert.deepEqual(contentUpdates(before, after, 100, isImage), [{ old_str: "x\nk", new_str: "y\nk" }]);
  // An insertion next to an image takes its neighbour on the other side.
  assert.deepEqual(contentUpdates(`a\n${image(1)}\nb`, `a\n${image(1)}\nnew\nb`, 100, isImage), [{ old_str: "b", new_str: "new\nb" }]);
});

test("null when the search text would have to grow over an unsearchable line", () => {
  const before = `x\n${image(1)}\nx`;
  const after = `x\n${image(1)}\ny`;
  assert.equal(contentUpdates(before, after, 100, isImage), null);
});

test("null when the change itself touches an unsearchable line", () => {
  assert.equal(contentUpdates(`a\n${image(1)}\nb`, `a\n${image(2)}\nb`, 100, isImage), null);
  assert.equal(contentUpdates(`a\n${image(1)}\nb`, "a\nb", 100, isImage), null);
});

test("edits never hold an unsearchable line and still reproduce the target", () => {
  const line = fc.constantFrom("a", "b", "", image(1), image(2));
  fc.assert(fc.property(fc.array(line, { maxLength: 8 }), fc.array(line, { maxLength: 8 }), (x, y) => {
    const before = x.join("\n");
    const after = y.join("\n");
    const edits = contentUpdates(before, after, 100, isImage);
    if (edits === null) return;
    assert.equal(apply(before, edits), after);
    for (const edit of edits) assert.ok(!edit.old_str.split("\n").some(isImage), edit.old_str);
  }));
});
