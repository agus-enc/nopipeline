import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { diffIndices } from "node-diff3";
import { codeKeys, lineKey, threeWay, transplant } from "../../src/merge/lines.ts";

test("lineKey ignores indentation, attribute lists, the form of Notion URLs and mention titles", () => {
  assert.equal(lineKey('\t\t- item {color="blue"}'), "- item");
  assert.equal(
    lineKey('See <mention-page url="https://app.notion.com/p/cb56bbf0dc78488685536285651b9f5d"/> now'),
    lineKey('See <mention-page url="https://www.notion.so/cb56bbf0dc78488685536285651b9f5d">Elm</mention-page> now'),
  );
  assert.equal(lineKey("[x](https://app.notion.com/p/cb56bbf0dc78488685536285651b9f5d)"), lineKey("[x](https://www.notion.so/cb56bbf0dc78488685536285651b9f5d)"));
});

test("transplant applies an edit inside Notion-only layout without disturbing it", () => {
  const base = ["- Pick the beans", "## Roast", "- Other"];
  const changed = ["- Pick the beans", "## Roast them dark", "- Other"];
  const target = ["<columns>", '\t<column ratio="50">', "\t\t- Pick the beans", "\t\t## Roast", "\t\t- Other", "\t</column>", "</columns>"];
  assert.deepEqual(transplant(base, changed, target), [
    "<columns>",
    '\t<column ratio="50">',
    "\t\t- Pick the beans",
    "\t\t## Roast them dark",
    "\t\t- Other",
    "\t</column>",
    "</columns>",
  ]);
});

test("transplant keeps attribute lists and inserts new lines at the anchor's depth", () => {
  const base = ["Intro", "- a"];
  const changed = ["Intro edited", "- a", "- b"];
  const target = ['Intro {color="blue"}', "\t- a"];
  assert.deepEqual(transplant(base, changed, target), ['Intro edited {color="blue"}', "\t- a", "\t- b"]);
  assert.deepEqual(transplant(["A", "B"], ["NEW", "A", "B"], ["\tA", "\tB"]), ["\tNEW", "\tA", "\tB"]);
  // In a run of identical lines, the edit lands on the line that was edited and the others keep theirs.
  const others = ['- Other {color="red"}', '- Other {color="green"}', '- Other {color="blue"}'];
  assert.deepEqual(transplant(["- Other", "- Other", "- Other"], ["- Other", "- Other changed", "- Other"], others), [
    '- Other {color="red"}',
    '- Other changed {color="green"}',
    '- Other {color="blue"}',
  ]);
});

test("transplant respects an indentation change made on purpose", () => {
  assert.deepEqual(transplant(["- a", "- b"], ["- a", "\t- b"], ["- a", "- b"]), ["- a", "\t- b"]);
});

test("transplant replaces a line whose target version drifted", () => {
  const base = ["A", "old wording", "C"];
  const changed = ["A", "new wording", "C"];
  const target = ["A", "old wording, as Notion wrote it", "C"];
  assert.deepEqual(transplant(base, changed, target), ["A", "new wording", "C"]);
});

test("transplant deletes lines and keeps target-only lines around them", () => {
  const base = ["A", "B", "C"];
  const changed = ["A", "C"];
  const target = ["A", "<empty-block/>", "B", "C"];
  assert.deepEqual(transplant(base, changed, target), ["A", "<empty-block/>", "C"]);
});

const line = fc.stringMatching(/^[a-e]{1,3}$/);
const doc = fc.array(line, { maxLength: 12 });

test("transplant onto the base itself gives exactly the changed text", () => {
  fc.assert(fc.property(doc, doc, (base, changed) => {
    assert.deepEqual(transplant(base, changed, base), changed);
  }));
});

test("transplant without edits leaves the target untouched", () => {
  fc.assert(fc.property(doc, fc.array(fc.tuple(fc.boolean(), fc.boolean())), (base, layout) => {
    const target = base.map((l, k) => (layout[k]?.[0] ? `\t${l}` : l) + (layout[k]?.[1] ? ' {color="red"}' : ""));
    assert.deepEqual(transplant(base, base, target), target);
  }));
});

test("transplant never touches lines far from the edits, even among identical lines", () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 4, maxLength: 20 }), fc.nat(), (numbers, pick) => {
    const base = numbers.map((n) => `line ${n}`);
    const k = pick % base.length;
    const changed = base.map((l, i) => (i === k ? `${l} edited` : l));
    const target = base.map((l, i) => `\t${l} {color="c${i}"}`);
    const result = transplant(base, changed, target)!;
    assert.equal(result.length, target.length);
    result.forEach((l, i) => assert.equal(l, i === k ? `\t${base[i]} edited {color="c${k}"}` : target[i]));
  }));
});

test("threeWay merges edits to different lines and reports overlapping ones", () => {
  const base = ["a", "b", "c", "d"];
  assert.deepEqual(threeWay(base, ["A", "b", "c", "d"], ["a", "b", "c", "D"]), { lines: ["A", "b", "c", "D"], conflicted: false });
  assert.deepEqual(threeWay(base, ["A", "b", "c", "d"], ["a", "B", "c", "d"]), { lines: ["A", "B", "c", "d"], conflicted: false });
  assert.deepEqual(threeWay(base, ["x", "b", "c", "d"], ["y", "b", "c", "d"]), { lines: ["x", "b", "c", "d"], conflicted: true });
  assert.deepEqual(threeWay(base, ["a", "b", "c", "d", "ours"], ["a", "b", "c", "d", "theirs"]), { lines: ["a", "b", "c", "d", "ours"], conflicted: true });
});

// --- Lines written in another form (final review C1) -------------------------------------------------

test("lineKey reads the forms Markdown treats alike as one line", () => {
  const alike: [string, string][] = [
    ["City 2  ", "City 2"],
    ["*   milk", "- milk"],
    ["+ milk", "- milk"],
    ["-\tmilk", "- milk"],
    ["1) first", "1. first"],
    ["- [X] one", "- [x] one"],
    ["* [x] one", "- [x] one"],
    ["## Title ##", "## Title"],
    ["***", "---"],
    ["___", "---"],
    ["- - -", "---"],
    [">text", "> text"],
    ["| Yew     | timbers    |", "| Yew | timbers |"],
    ["|:---|---:|", "| --- | --- |"],
    ["| :---: | --- |", "| --- | --- |"],
    ["Café", "Café"],
  ];
  for (const [a, b] of alike) assert.equal(lineKey(a), lineKey(b), `${JSON.stringify(a)} and ${JSON.stringify(b)}`);
  for (const [a, b] of [["- a", "1. a"], ["- [ ] a", "- [x] a"], ["## a", "### a"], ["| a | b |", "| a | c |"], ["a", "b"]]) assert.notEqual(lineKey(a!), lineKey(b!));
});

test("transplant puts an edit made in the other app on its own line, whatever form the target writes it in", () => {
  const edit = (base: string[], from: string, to: string) => base.map((line) => (line === from ? to : line));
  // Hard breaks: trailing spaces are kept on the edited line.
  const address = ["Address", "Street 1", "City 2", "Country", ""];
  assert.deepEqual(transplant(address, edit(address, "City 2", "City 3"), ["Address  ", "Street 1  ", "City 2  ", "Country", ""]), ["Address  ", "Street 1  ", "City 3  ", "Country", ""]);
  // Wide list markers, star bullets and 1) lists keep their own marker.
  const shopping = ["Shopping", "", "- milk", "- eggs", "- bread", ""];
  assert.deepEqual(transplant(shopping, edit(shopping, "- bread", "- rye bread"), ["Shopping", "", "-   milk", "-   eggs", "-   bread", ""]), ["Shopping", "", "-   milk", "-   eggs", "-   rye bread", ""]);
  const stars = ["Intro", "", "- alpha", "- beta", "- gamma", "", "End"];
  const starTarget = ["Intro", "", "* alpha", "* beta", "* gamma", "", "End"];
  assert.deepEqual(transplant(stars, edit(stars, "- gamma", "- gamma, edited"), starTarget), ["Intro", "", "* alpha", "* beta", "* gamma, edited", "", "End"]);
  assert.deepEqual(transplant(stars, stars.filter((l) => l !== "- beta"), starTarget), ["Intro", "", "* alpha", "* gamma", "", "End"]);
  assert.deepEqual(transplant(stars, ["Intro", "", "- alpha", "- beta", "- gamma", "- delta", "", "End"], starTarget), ["Intro", "", "* alpha", "* beta", "* gamma", "- delta", "", "End"]);
  const steps = ["Steps", "", "1. first", "2. second", "3. third", ""];
  assert.deepEqual(transplant(steps, edit(steps, "3. third", "3. third, edited"), ["Steps", "", "1) first", "2) second", "3) third", ""]), ["Steps", "", "1) first", "2) second", "3) third, edited", ""]);
  // Upper-case task boxes: only the edited task changes.
  const tasks = ["- [x] one", "- [x] two", "- [x] three", ""];
  assert.deepEqual(transplant(tasks, edit(tasks, "- [x] three", "- [ ] three"), ["- [X] one", "- [X] two", "- [X] three", ""]), ["- [X] one", "- [X] two", "- [ ] three", ""]);
  // A padded table: a cell edit and a row deletion touch only their own row.
  const table = ["| Species | Use |", "| --- | --- |", "| Elm | shadowed |", "| Yew | timbers |", "", "End"];
  const padded = ["| Species | Use      |", "| ------- | -------- |", "| Elm     | shadowed |", "| Yew     | timbers  |", "", "End"];
  assert.deepEqual(transplant(table, edit(table, "| Yew | timbers |", "| Yew | split timbers |"), padded), [...padded.slice(0, 3), "| Yew | split timbers |", "", "End"]);
  assert.deepEqual(transplant(table, table.filter((l) => !l.startsWith("| Yew")), padded), [...padded.slice(0, 3), "", "End"]);
  // Notion-side date and outside-page mentions: the edit lands on its line, the others keep their mentions.
  const log = ["Log", "- 2026-09-01 started", "- 2026-09-02 continued", "- 2026-09-03 finished", "End"];
  const mentions = ["Log", ...[1, 2, 3].map((d, k) => `- <mention-date start="2026-09-0${d}"/> ${["started", "continued", "finished"][k]}`), "End"];
  assert.deepEqual(transplant(log, edit(log, "- 2026-09-03 finished", "- 2026-09-03 finished late"), mentions), [...mentions.slice(0, 3), "- 2026-09-03 finished late", "End"]);
});

test("transplant never guesses: an edit whose lines have no counterpart gives null", () => {
  const base = ["A", "old wording", "B"];
  const target = ["A", "one form", "and another line", "B"];
  assert.equal(transplant(base, ["A", "new wording", "B"], target), null);
  assert.equal(transplant(base, ["A", "B"], target), null);
  // Lines added right after a line with no counterpart have nowhere certain to go.
  assert.equal(transplant(base, ["A", "old wording", "added", "B"], target), null);
  // Lines added elsewhere still go in.
  assert.deepEqual(transplant(base, ["A", "old wording", "B", "added"], target), ["A", "one form", "and another line", "B", "added"]);
});

test("transplant never writes over a line only the target has", () => {
  const base = ["A", "B", "C", "D"];
  const target = ["A", "B", "<table_of_contents/>", "C", "D"];
  assert.equal(transplant(base, ["A", "B and C together", "D"], target, undefined, "page"), null);
  // Replaced one for one, the lines around it stay.
  assert.deepEqual(transplant(base, ["A", "B2", "C2", "D"], target, undefined, "page"), ["A", "B2", "<table_of_contents/>", "C2", "D"]);
  // A one-line $$ formula is matched only exactly, so an edit inside it can't strip its $$.
  assert.equal(transplant(["$$", "x", "$$"], ["$$", "y", "$$"], ["$$ x $$"]), null);
});

test("Notion's empty blocks count as blank lines: an edit next to one, or across one, is placed", () => {
  const base = ["A", "B", "C", "D"];
  const target = ["A", "B", "<empty-block/>", "C", "D"];
  assert.deepEqual(transplant(base, ["A", "B and C together", "D"], target, undefined, "page"), ["A", "B and C together", "D"]);
  assert.deepEqual(transplant(base, ["A", "B", "D"], target, undefined, "page"), ["A", "B", "<empty-block/>", "D"]);
  // A dated line next to an empty block (the most common reason a push couldn't be placed before).
  const page = ["Log", '- <mention-date start="2026-09-01"/> started', "<empty-block/>", "End"];
  assert.deepEqual(transplant(["Log", "- 2026-09-01 started", "End"], ["Log", "- 2026-09-01 started late", "End"], page, undefined, "page"), [
    "Log",
    "- 2026-09-01 started late",
    "<empty-block/>",
    "End",
  ]);
});

test("a line replaced one for one keeps the target's indentation, marker, attributes and hard break", () => {
  assert.deepEqual(transplant(["- a"], ["- b"], ['\t*   a {color="red"}']), ['\t*   b {color="red"}']);
  assert.deepEqual(transplant(["x"], ["y"], ["x  "]), ["y  "]);
  // What the edit itself changes wins.
  assert.deepEqual(transplant(["- a"], ["1. a"], ["* a"]), ["1. a"]);
  assert.deepEqual(transplant(["- a"], ["\t- b"], ["* a"]), ["\t* b"]);
});

test("new lines keep paragraphs apart the way the edit does", () => {
  // The note has no blank line after its heading; the paragraph added below it still gets its own.
  assert.deepEqual(transplant(["# H", "", "P", ""], ["# H", "", "N", "", "P", ""], ["# H", "P", ""]), ["# H", "", "N", "", "P", ""]);
  assert.deepEqual(transplant(["# H", "", "P", ""], ["# H", "", "N", "P", ""], ["# H", "P", ""]), ["# H", "", "N", "P", ""]);
  // A run of blank lines counts as one: a line joined to the next paragraph goes right before it.
  assert.deepEqual(transplant(["A", "", "B"], ["A", "", "N", "B"], ["A", "", "", "B"]), ["A", "", "", "N", "B"]);
  assert.deepEqual(transplant(["A", "", "B"], ["A", "N", "", "B"], ["A", "", "", "B"]), ["A", "N", "", "", "B"]);
  assert.deepEqual(transplant(["A", "", "B", "", "C"], ["A", "", "C"], ["A", "", "", "B", "", "", "C"]), ["A", "", "", "C"]);
});

// Lines in the forms lineKey reads alike, each with the base's form and forms a note may use instead.
const word = fc.constantFrom("alpha", "beta", "gamma");
const fresh = fc.constantFrom("delta", "omega");
const kinds = (w: fc.Arbitrary<string>) =>
  fc.oneof(
    w.map((x) => ({ base: x, forms: [x, `${x}  `, ` ${x}`, `${x}\t`] })),
    w.map((x) => ({ base: `- ${x}`, forms: [`* ${x}`, `+ ${x}`, `-   ${x}`, `*  ${x}`] })),
    fc.tuple(w, fc.boolean()).map(([x, done]) => ({ base: `- [${done ? "x" : " "}] ${x}`, forms: [`- [${done ? "X" : " "}] ${x}`, `* [${done ? "x" : " "}] ${x}`, `-   [${done ? "x" : " "}] ${x}`] })),
    fc.tuple(fc.integer({ min: 1, max: 3 }), w).map(([n, x]) => ({ base: `${n}. ${x}`, forms: [`${n}) ${x}`, `${n}.  ${x}`] })),
    w.map((x) => ({ base: `## ${x}`, forms: [`## ${x} ##`, `##   ${x}`, `## ${x} #`] })),
    w.map((x) => ({ base: `> ${x}`, forms: [`>${x}`, `>  ${x}`] })),
    fc.tuple(w, w).map(([x, y]) => ({ base: `| ${x} | ${y} |`, forms: [`|${x}|${y}|`, `| ${x}    | ${y} |`, `| ${x} | ${y}`] })),
    fc.constant({ base: "| --- | --- |", forms: ["|:---|---:|", "| :---: | --- |", "|---|---|"] }),
    fc.constant({ base: "---", forms: ["***", "___", "- - -", "* * *"] }),
    w.map((x) => ({ base: `\t- ${x}`, forms: [`    - ${x}`, `  * ${x}`, `\t+ ${x}`] })),
  );
/** Headings and thematic breaks end their block, so a note may leave out the blank line after them. */
const closesBlock = (line: string) => /^(#|---$)/.test(lineKey(line));
const blankLine = (line: string) => line.trim() === "";

/** For each line of `changed` that the edit left alone, the line of `base` it is (the diff transplant sees). */
function untouched(base: string[], changed: string[]): Map<number, number> {
  let head = 0;
  while (head < base.length && head < changed.length && base[head] === changed[head]) head++;
  let tail = 0;
  while (tail < base.length - head && tail < changed.length - head && base[base.length - 1 - tail] === changed[changed.length - 1 - tail]) tail++;
  const origin = new Map<number, number>();
  for (let k = 0; k < head; k++) origin.set(k, k);
  for (let k = 1; k <= tail; k++) origin.set(changed.length - k, base.length - k);
  let b = head;
  let c = head;
  for (const h of diffIndices(base.slice(head, base.length - tail), changed.slice(head, changed.length - tail))) {
    while (b < h.buffer1[0] + head) origin.set(c++, b++);
    b = h.buffer1[0] + head + h.buffer1[1];
    c = h.buffer2[0] + head + h.buffer2[1];
  }
  while (b < base.length - tail) origin.set(c++, b++);
  return origin;
}

const reformatted = fc
  .record({
    doc: fc.array(fc.record({ line: kinds(word), blankAfter: fc.boolean(), form: fc.nat(), blanks: fc.integer({ min: 0, max: 3 }) }), { minLength: 1, maxLength: 10 }),
    endsBlank: fc.boolean(),
    lead: fc.integer({ min: 0, max: 2 }),
    trail: fc.integer({ min: 0, max: 2 }),
    edits: fc.array(fc.record({ at: fc.nat(), length: fc.integer({ min: 0, max: 3 }), lines: fc.array(fc.record({ line: kinds(fresh), blankBefore: fc.boolean() }), { maxLength: 3 }) }), { minLength: 1, maxLength: 2 }),
  })
  .map(({ doc, endsBlank, lead, trail, edits }) => {
    const base: string[] = [];
    const target: string[] = Array.from({ length: lead }, () => "");
    /** base index -> target index, for non-blank lines */
    const truth = new Map<number, number>();
    doc.forEach(({ line, blankAfter, form, blanks }, k) => {
      truth.set(base.length, target.length);
      base.push(line.base);
      target.push(line.forms[form % line.forms.length]!);
      if (blankAfter && k < doc.length - 1) {
        base.push("");
        // A note may repeat blank lines, and leave out the one after a heading or thematic break.
        const copies = closesBlock(line.base) ? blanks : Math.max(1, blanks);
        for (let n = 0; n < copies; n++) target.push("");
      }
    });
    if (endsBlank) base.push("");
    for (let n = 0; n < trail + (endsBlank ? 1 : 0); n++) target.push("");
    let changed = [...base];
    for (const { at, length, lines } of [...edits].sort((x, y) => y.at - x.at)) {
      const start = at % (changed.length + 1);
      const added = lines.flatMap(({ line, blankBefore }) => (blankBefore ? ["", line.base] : [line.base]));
      changed = [...changed.slice(0, start), ...added, ...changed.slice(Math.min(changed.length, start + length))];
    }
    return { base, target, truth, changed };
  });

test("transplant onto a reformatted copy applies exactly the edit, at the counterparts, and leaves every other line alone", () => {
  fc.assert(
    fc.property(reformatted, ({ base, target, truth, changed }) => {
      const result = transplant(base, changed, target);
      if (result === null) {
        // Every line has a counterpart, so only a deletion is ever refused: one after which the copy would nest
        // a line under a list item (a paragraph indented one space, say) that the base keeps apart.
        assert.ok(diffIndices(base, changed).some((hunk) => hunk.buffer2[1] === 0), "only a deletion is refused");
        return;
      }
      const origin = untouched(base, changed);
      const lines = (text: string[]) => text.flatMap((line, k) => (blankLine(line) ? [] : [k]));
      const [got, want] = [lines(result), lines(changed)];
      assert.deepEqual(got.map((k) => lineKey(result[k]!)), want.map((k) => lineKey(changed[k]!)), "the result says what the edited text says");
      want.forEach((c, n) => {
        // A line the edit left alone is the target's own line, byte for byte.
        const b = origin.get(c);
        if (b !== undefined) assert.equal(result[got[n]!], target[truth.get(b)!]);
        // Paragraphs stay apart or together as in the edited text.
        if (n > 0 && !closesBlock(changed[want[n - 1]!]!)) assert.equal(got[n]! - got[n - 1]! > 1, c - want[n - 1]! > 1, "blank line between two lines");
      });
    }),
    { numRuns: 2000 },
  );
});

test("transplant keeps every line only the target has, or refuses", () => {
  const extra = fc.constantFrom("<empty-block/>", '<unknown url="https://example.com" alt="bookmark"/>', "<table_of_contents/>");
  fc.assert(
    fc.property(doc, fc.array(fc.tuple(fc.nat(), extra), { maxLength: 4 }), doc, fc.nat(), fc.nat(), (base, inserts, added, at, length) => {
      const target = [...base];
      for (const [k, line] of inserts) target.splice(k % (target.length + 1), 0, line);
      const start = at % (base.length + 1);
      const changed = [...base.slice(0, start), ...added, ...base.slice(Math.min(base.length, start + (length % 4)))];
      const result = transplant(base, changed, target, undefined, "page");
      if (result === null) return;
      // Empty blocks are blank lines: an edit may write over them.
      const own = (text: string[]) => text.filter((line) => line.startsWith("<") && line !== "<empty-block/>");
      assert.deepEqual(own(result), own(target));
      assert.deepEqual(result.filter((line) => !line.startsWith("<")), changed);
    }),
    { numRuns: 2000 },
  );
});

test("threeWay merges an edit with lines the other side added right next to it", () => {
  const paragraphs = ["Alpha", "", "Beta", "", "Gamma", ""];
  const obsidian = ["Alpha", "", "Beta", "", "Gamma (Obsidian)", ""];
  const notion = ["Alpha", "", "Beta", "", "New from Notion", "", "Gamma", ""];
  const both = ["Alpha", "", "Beta", "", "New from Notion", "", "Gamma (Obsidian)", ""];
  assert.deepEqual(threeWay(paragraphs, obsidian, notion), { lines: both, conflicted: false });
  assert.deepEqual(threeWay(paragraphs, notion, obsidian), { lines: both, conflicted: false });
  const list = ["- one", "- two", "- three", ""];
  assert.deepEqual(threeWay(list, ["- one", "- two (Obsidian)", "- three", ""], ["- one", "- two", "- two and a half", "- three", ""]), {
    lines: ["- one", "- two (Obsidian)", "- two and a half", "- three", ""],
    conflicted: false,
  });
  // A deletion next to an addition keeps both.
  assert.deepEqual(threeWay(list, ["- one", "- three", ""], ["- one", "- two", "- two and a half", "- three", ""]), { lines: ["- one", "- two and a half", "- three", ""], conflicted: false });
  // Both sides adding at different ends of the same lines keep both.
  assert.deepEqual(threeWay(list, ["- one", "- before", "- two", "- three", ""], ["- one", "- two", "- after", "- three", ""]), {
    lines: ["- one", "- before", "- two", "- after", "- three", ""],
    conflicted: false,
  });
  // Both sides adding different lines at the same place is still a conflict.
  assert.deepEqual(threeWay(list, ["- one", "- two", "- mine", "- three", ""], ["- one", "- two", "- theirs", "- three", ""]).conflicted, true);
});

// --- Final review, second round: no wrong counterparts --------------------------------------------------

test("lineKey reads Notion's date and person mentions as Obsidian shows them", () => {
  assert.equal(lineKey('- <mention-date start="2026-09-01"/> started'), lineKey("- 2026-09-01 started"));
  assert.equal(lineKey('<mention-date start="2026-09-01" end="2026-09-03"/> trip'), lineKey("2026-09-01 → 2026-09-03 trip"));
  assert.equal(lineKey('Ask <mention-user url="user://abc">Ana</mention-user>'), lineKey("Ask @Ana"));
  assert.equal(lineKey("> ---------"), lineKey("> ---"));
});

test("the words pass pairs only lines it can tell apart, found once on each side", () => {
  // Quoted code blocks written on one line (an older form): an edit in the second block must not land in the
  // first, which holds the same code line.
  const note = ["> ```python", "> x = i + 1", "> i += 1", "> ```", "", "> ```", "> x = i + 1", "> ```", ""];
  const base = ["> ```python<br>x = i + 1<br>i += 1<br>```", "", "> ```<br>x = i + 1<br>```", ""];
  assert.equal(transplant(base, ["> ```python<br>x = i + 1<br>i += 1<br>```", "", "> ```<br>x = i + 1 + 2<br>```", ""], note), null);
  // Words that tell a line apart still find it in another form.
  assert.deepEqual(transplant(["A", "Shopping list for today", "B"], ["A", "Shopping list for tomorrow", "B"], ["A", "**Shopping** list *for* today", "B"]), ["A", "Shopping list for tomorrow", "B"]);
});

test("the equal-count pass pairs a gap's lines only when every pair shares words", () => {
  assert.equal(transplant(["A", "one", "B"], ["A", "two", "B"], ["A", "something else", "B"]), null);
  // A mention reads as the page it points to, so the link Obsidian shows for it pairs with it.
  const url = "https://app.notion.com/p/146d0c3ffedc44cd800583022f0461b2";
  assert.deepEqual(transplant(["A", `[Notion page](${url})`, "B"], ["A", `[Notion page, edited](${url})`, "B"], ["A", `<mention-page url="${url}"/>`, "B"], undefined, "page"), [
    "A",
    `[Notion page, edited](${url})`,
    "B",
  ]);
  // A callout's type shows as its icon, not as words: a title line pairs with one of another type.
  assert.deepEqual(transplant(["A", "> [!note]", "> text", "B"], ["A", "> [!note]", "> text, edited", "B"], ["A", "> [!recipe]", "> text", "B"]), ["A", "> [!recipe]", "> text, edited", "B"]);
});

test("code lines match only exactly, blank ones included, whatever form their block is written in", () => {
  // Blank lines inside a code block are code: an edit to one keeps the others.
  const code = ["```python", "return i", "", "", "", "```"];
  assert.deepEqual(transplant(code, ["```python", "return i", "", "", " zq", "```"], code), ["```python", "return i", "", "", " zq", "```"]);
  // Notion writes a nested code block's lines flush left; the translator indents them like the fence.
  const translator = [">", "\t```python", "\ti = 0", "\twhile i < 3:", "\t    i += 1", "\t```"];
  const notion = [">", "\t```python", "i = 0", "while i < 3:", "    i += 1", "\t```"];
  assert.deepEqual(transplant(translator, translator.map((l) => l.replace("i += 1", "i += 2")), notion, undefined, "page"), notion.map((l) => l.replace("i += 1", "i += 2")));
  assert.deepEqual(transplant(translator, [...translator.slice(0, 5), "\t    print(i)", "\t```"], notion, undefined, "page"), [...notion.slice(0, 5), "    print(i)", "\t```"]);
  // A code line never pairs with a line of text that shares its words.
  assert.equal(transplant(["A", "x = i + 1", "B"], ["A", "B"], ["A", "```", "x = i + 1", "```", "B"]), null);
});

test("a deletion never leaves lines nested under another block", () => {
  // A toggle heading's lines are nested under it in Notion, not in the note.
  const page = ["- item", '## Details {toggle="true"}', "\tHidden", "End"];
  assert.equal(transplant(["- item", "## Details", "Hidden", "End"], ["- item", "Hidden", "End"], page, undefined, "page"), null);
  // Deleting the heading between a list and lines the note indents would make them the item's own.
  const note = ["- item", "", "### Heading", "", "   indented text", ""];
  assert.equal(transplant(["- item", "", "### Heading", "", "indented text", ""], ["- item", "", "indented text", ""], note), null);
  // Lines nested under the same parent stay with it.
  const columns = ["<columns>", "\t<column>", "\t\tFirst", "\t\tSecond", "\t</column>", "</columns>"];
  assert.deepEqual(transplant(["First", "Second"], ["Second"], columns, undefined, "page"), ["<columns>", "\t<column>", "\t\tSecond", "\t</column>", "</columns>"]);
});

test("an edit turning a divider into text keeps it apart from the lines around it", () => {
  const note = ["> [!note]", "> - item", "> continued", "> -----", "> after"];
  const base = ["> [!note]", "> - item", "> \tcontinued", ">", "> ---", ">", "> after"];
  assert.deepEqual(transplant(base, base.map((l) => (l === "> ---" ? "> --- note" : l)), note), ["> [!note]", "> - item", "> continued", ">", "> --- note", ">", "> after"]);
});


test("a code line keeps its own `>`: only the quote markers its block sits in are left out (final review, third round N1)", () => {
  // A Python prompt in a code block is code, not a quote marker.
  assert.deepEqual(codeKeys(["```python", ">>> print(x)", "print(x)", "```"]).slice(1, 3), ["\u0002>>> print(x)", "\u0002print(x)"]);
  assert.deepEqual(codeKeys(["> ```python", "> >>> print(x)", ">> x", "> ```"]).slice(1, 3), ["\u0002>>> print(x)", "\u0002> x"]);
  // A `> ```` line inside a code block outside any quote is code, not its closing fence.
  assert.deepEqual(codeKeys(["```", "> ```", "x", "```", "after"]).map((key) => key !== null), [true, true, true, true, false]);
});

test("in a page, code lines placed in a nested block take its form: flush left as Notion writes it, or the translator's (final review, third round N4)", () => {
  const base = [">", "\t```python", "\ti = 0", "\t```"];
  const changed = [">", "\t```python", "\t# first", "\t    i = 0", "\t```"];
  // Notion's form: the added line and the re-indented one are flush left.
  assert.deepEqual(transplant(base, changed, [">", "\t```python", "i = 0", "\t```"], undefined, "page"), [">", "\t```python", "# first", "    i = 0", "\t```"]);
  // The translator's form: they keep the fence's tab.
  assert.deepEqual(transplant(base, changed, base, undefined, "page"), changed);
  // A new block keeps the translator's form.
  assert.deepEqual(transplant(base, [...base, "- step", "\t```bash", "\techo", "\t```"], [">", "\t```python", "i = 0", "\t```"], undefined, "page"), [">", "\t```python", "i = 0", "\t```", "- step", "\t```bash", "\techo", "\t```"]);
});

test("in a note, a code line placed in a block takes the block's own form and keeps its trailing spaces", () => {
  // A list item's fence whose lines don't all have the item's width: they are written as they are.
  const note = ["> [!example]", "> - ```python", "> x = 1", ">    y = 2", "> ```"];
  const base = ["> [!example]", "> -", "> \t```python", "> \tx = 1", "> \t   y = 2", "> \t```"];
  const changed = ["> [!example]", "> -", "> \t```python", "> \tx = 10  ", "> \t   y = 20", "> \t```"];
  assert.deepEqual(transplant(base, changed, note), ["> [!example]", "> - ```python", "> x = 10  ", ">    y = 20", "> ```"]);
  // One whose lines all have it: they take it again, a deeper line keeping the rest.
  assert.deepEqual(transplant(["-", "\t```py", "\ta", "\t  b", "\t```"], ["-", "\t```py", "\ta", "\t  c", "\t```"], ["- ```py", "  a", "    b", "  ```"]), ["- ```py", "  a", "    c", "  ```"]);
  // A bare `>`: the space after it is the marker's, so a code line that starts with one needs another.
  assert.deepEqual(transplant([">", "\t```python", "\t y", "\t```"], [">", "\t```python", "\t z", "\t```"], [">```python", ">  y", ">```"]), [">```python", ">  z", ">```"]);
});
