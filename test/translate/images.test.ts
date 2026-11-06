import { test } from "node:test";
import assert from "node:assert/strict";
import { strandedMedia, toNotion, toObsidian } from "../../src/translate/index.ts";
import type { TranslateContext } from "../../src/translate/index.ts";
import { rereadLines } from "../../src/translate/rereads.ts";
import { mediaOf } from "../../src/vault/images.ts";
import { testContext } from "../helpers/context.ts";

const DIR = "Assets/pictures";
const BASE = "https://nopipeline.invalid/vault";
const FILES = [
  `${DIR}/whisk.png`,
  `${DIR}/map.png`,
  `${DIR}/tide_chart.png`,
  `${DIR}/oven.png`,
  `${DIR}/chart 2.png`,
  `${DIR}/two_under_scores.png`,
  "Other/dup.png",
  "Third/dup.png",
  `${DIR}/huge.png`,
];
const media = mediaOf(FILES, DIR, [`${DIR}/huge.png`]);
const ctx = (fromPath = "Cookbook/x.md"): TranslateContext => ({ ...testContext(fromPath), media });
const plain = (fromPath = "Cookbook/x.md"): TranslateContext => testContext(fromPath);
const here = ctx();

const toN = (body: string, c = here) => toNotion(body, c);
const toO = (markdown: string, c = here) => toObsidian(markdown, c).trimEnd();

test("a lone embed becomes an image line with the placeholder URL", () => {
  assert.equal(toN("![[whisk.png]]"), `![](${BASE}/${DIR}/whisk.png)`);
  assert.equal(toN("![](whisk.png)"), `![](${BASE}/${DIR}/whisk.png)`);
  assert.equal(toN(`![](${DIR}/chart%202.png)`), `![](${BASE}/${DIR}/chart%202.png)`);
  assert.equal(toN("![alt text](<chart 2.png>)"), `![alt text](${BASE}/${DIR}/chart%202.png)`);
});

test("the alias is the caption, translated like any text; a size is dropped", () => {
  const line = toN("![[map.png|_North_ is up]]");
  assert.equal(line, `![*North* is up](${BASE}/${DIR}/map.png)`);
  assert.deepEqual(rereadLines(line), []);
  assert.equal(toN("![[tide_chart.png|300]]"), `![](${BASE}/${DIR}/tide_chart.png)`);
  assert.equal(toN("![[tide_chart.png|300x200]]"), `![](${BASE}/${DIR}/tide_chart.png)`);
  assert.equal(toN("![[tide_chart.png|a cap|300]]"), `![a cap](${BASE}/${DIR}/tide_chart.png)`);
  assert.equal(toN("![[tide_chart.png|x|y]]"), `![x\\|y](${BASE}/${DIR}/tide_chart.png)`);
  assert.equal(toN("![cap|300](tide_chart.png)"), `![cap](${BASE}/${DIR}/tide_chart.png)`);
  assert.equal(toN("![|300](tide_chart.png)"), `![](${BASE}/${DIR}/tide_chart.png)`);
  assert.equal(toN("![a \\[b\\] c](tide_chart.png)"), `![a \\[b\\] c](${BASE}/${DIR}/tide_chart.png)`);
});

test("a placeholder with underscores in its path is not read as emphasis", () => {
  assert.deepEqual(rereadLines(toN("![[two_under_scores.png]]")), []);
  assert.deepEqual(rereadLines(toN("![[tide_chart.png|a cap]]")), []);
});

test("an image alone in a list item becomes the empty item and the image one tab deeper", () => {
  assert.equal(toN("- ![[tide_chart.png]]"), `-\n\t![](${BASE}/${DIR}/tide_chart.png)`);
  assert.equal(toN("* ![[tide_chart.png|cap]]"), `-\n\t![cap](${BASE}/${DIR}/tide_chart.png)`);
  assert.equal(toN("1. ![[tide_chart.png]]"), `1.\n\t![](${BASE}/${DIR}/tide_chart.png)`);
  assert.equal(toN("- a\n\t- ![[tide_chart.png]]"), `- a\n\t-\n\t\t![](${BASE}/${DIR}/tide_chart.png)`);
  assert.equal(toN("- ![[tide_chart.png]]\n\t- sub"), `-\n\t![](${BASE}/${DIR}/tide_chart.png)\n\t- sub`);
});

test("an image line among the lines of a paragraph is its own block", () => {
  assert.equal(toN("before\n![[tide_chart.png]]\nafter"), `before\n![](${BASE}/${DIR}/tide_chart.png)\nafter`);
});

test("citations that stay literal are written as without images, and stranded lists them", () => {
  const stay = [
    "- See ![[oven.png]][Stove](Stove.md)",
    "text ![[oven.png]] more",
    "> ![[oven.png]]",
    "| a | b |\n| --- | --- |\n| ![[oven.png]] | x |",
    "> [!note]\n> ![[oven.png]]",
    "- [ ] ![[oven.png]]",
    "![[nothing.png]]",
    "![nope](nothing.png)",
    "![[huge.png]]",
    "![[Draft]]",
  ];
  for (const body of stay) assert.equal(toN(body), toNotion(body, plain()), body);
  const stranded = (body: string, c = here) => strandedMedia(body, c).map((s) => s.line);
  assert.deepEqual(stranded("- See ![[oven.png]][Stove](Stove.md)"), ["- See ![[oven.png]][Stove](Stove.md)"]);
  assert.deepEqual(stranded("text ![[oven.png]] more"), ["text ![[oven.png]] more"]);
  assert.deepEqual(stranded("> ![[oven.png]]"), ["> ![[oven.png]]"]);
  assert.deepEqual(stranded("> ![[oven.png]]\n> ![[whisk.png]]"), ["> ![[oven.png]]", "> ![[whisk.png]]"]);
  assert.deepEqual(stranded("| a | b |\n| --- | --- |\n| ![[oven.png]] | x |"), ["| ![[oven.png]] | x |"]);
  assert.deepEqual(stranded("> [!note]\n> ![[oven.png]]\n\n- [ ] ![[oven.png]]"), ["> ![[oven.png]]", "- [ ] ![[oven.png]]"]);
  assert.deepEqual(strandedMedia("text ![[oven.png]] more\n\n> ![[oven.png]]", here).map((s) => s.why), ["shared", "shared"]);
  assert.deepEqual(strandedMedia("![[huge.png]]\n\n![x](huge.png)", here), [
    { line: "![[huge.png]]", why: "large" },
    { line: "![x](huge.png)", why: "large" },
  ]);
  assert.deepEqual(strandedMedia("- item\n![[oven.png]]\nmore", here), [{ line: "![[oven.png]]", why: "followed" }]);
  // Not stranded: converted, external, in code.
  assert.deepEqual(stranded("![[oven.png]]\n\n- ![[oven.png]]\n\n![](https://example.com/a.png)\n\n```\n![[oven.png]]\n```\n\n`![[oven.png]]` text"), []);
  assert.deepEqual(stranded("anything ![[oven.png]]", plain()), []);
});

test("a lone citation of a file that isn't in the vault stays text and says nothing", () => {
  assert.deepEqual(strandedMedia("![[nothing.png]]\n\n![nope](nothing.png)\n\n- ![[Nothing.JPG|300]]\n\n> ![[nothing.png]]\n\n- item\n![[nothing.png]]", here), []);
  assert.deepEqual(strandedMedia("![[nothing.png]]", plain()), []);
  assert.equal(toN("![[nothing.png]]"), toNotion("![[nothing.png]]", plain()), "it is written as text, as before");
  assert.equal(toN("- item\n![[nothing.png]]"), toNotion("- item\n![[nothing.png]]", plain()));
});

test("an external image stays as it is", () => {
  assert.equal(toN("![](https://example.com/a.png)"), "![](https://example.com/a.png)");
  assert.equal(toN("![cap](https://example.com/a.png)"), toNotion("![cap](https://example.com/a.png)", plain()));
});

test("without images in the context the translator writes the same lines as before", () => {
  assert.equal(toNotion("![[whisk.png]]", plain()), "!\\[\\[whisk.png\\]\\]");
  assert.equal(toNotion("- ![[oven.png]]", plain()), "- !\\[\\[oven.png\\]\\]");
  assert.equal(toNotion("![[whisk.png|a cap]]", plain()), "!\\[\\[whisk.png\\|a cap\\]\\]");
  assert.equal(toObsidian(`![c](${BASE}/${DIR}/whisk.png)\n`, plain()), `![c](${BASE}/${DIR}/whisk.png)\n`);
});

test("a placeholder image line comes back as a citation of the file, in the shortest form", () => {
  assert.equal(toO(`![cap](${BASE}/${DIR}/chart%202.png)`, ctx("0-In/x.md")), "![cap](chart%202.png)");
  assert.equal(toO(`![](${BASE}/${DIR}/whisk.png)`), "![](whisk.png)");
  assert.equal(toO(`![](${BASE}/Other/dup.png)`), "![](Other/dup.png)");
  assert.equal(toO(`![a *b* \\[c\\]](${BASE}/${DIR}/whisk.png)`), "![a *b* \\[c\\]](whisk.png)");
});

test("an image in a list item comes back on the item's line", () => {
  assert.equal(toO(`-\n\t![](${BASE}/${DIR}/tide_chart.png)`), "- ![](tide_chart.png)");
  assert.equal(toO(`1.\n\t![c](${BASE}/${DIR}/tide_chart.png)`), "1. ![c](tide_chart.png)");
  assert.equal(toO(`- a\n\t-\n\t\t![](${BASE}/${DIR}/tide_chart.png)`), "- a\n\t- ![](tide_chart.png)");
  assert.equal(toO(`-\n\t![](${BASE}/${DIR}/tide_chart.png)\n\t- sub`), "- ![](tide_chart.png)\n\t- sub");
});

test("a hosted URL, a web URL and an image without URL come back as they are", () => {
  const hosted = "https://prod-files-secure.s3.us-west-2.amazonaws.com/4f1c2a9e-0000-4000-8000-123456789abc/cfdfc7c5-9649-4e3a-8148-8a38d31e611e/probe.png";
  assert.equal(toO(`![c](${hosted})`), `![c](${hosted})`);
  assert.equal(toO(`![c](${hosted}?X-Amz-Signature=abc#notion_record=block.1.2)`), `![c](${hosted}?X-Amz-Signature=abc#notion_record=block.1.2)`);
  assert.equal(toO("![c](https://example.com/a.png)"), "![c](https://example.com/a.png)");
  assert.equal(toO("![c]()"), "![c]()");
  assert.equal(toO(`-\n\t![c](${hosted})`), `- ![c](${hosted})`);
});

test("a hosted URL whose file name holds parentheses is read back whole", () => {
  const url = "https://prod-files-secure.s3.us-west-2.amazonaws.com/4f1c2a9e-0000-4000-8000-123456789abc/cfdfc7c5-9649-4e3a-8148-8a38d31e611e/probe_(1).png";
  assert.equal(toO(`![c](${url})`), `![c](${url})`);
  assert.equal(toObsidian(`![c](${url})\n`, here, true), `![c](${url})\n`);
});

test("a placeholder image line outside the positions the translator writes images in still reaches the note as a citation, never as the placeholder URL", () => {
  // (Notion holds no image in a quote's own text; the safety net covers any block `mediaToObsidian` doesn't know.)
  assert.equal(toObsidian(`> ![c](${BASE}/${DIR}/whisk.png)\n`, here), "> ![c](whisk.png)\n");
  assert.equal(toObsidian(`text ![c](${BASE}/${DIR}/chart%202.png) and [link](${BASE}/Other/dup.png)\n`, here), "text ![c](chart%202.png) and [link](Other/dup.png)\n");
  assert.equal(toObsidian(`| a |\n| --- |\n| ![c](${BASE}/${DIR}/whisk.png) |\n`, here).includes("nopipeline.invalid"), false);
  // Without the vault's images the text is what it was.
  assert.match(toObsidian(`> ![c](${BASE}/${DIR}/whisk.png)\n`, plain()), /nopipeline\.invalid/);
});

test("an image pasted into a callout, a toggle or a quote comes back as a citation inside it (final review, finding 2)", () => {
  const image = `![](${BASE}/${DIR}/whisk.png)`;
  assert.equal(toO(`<callout icon="💡">\n\tinside\n\t${image}\n</callout>`), "> [!tip]\n> inside\n>\n> ![](whisk.png)");
  assert.equal(toO(`<details>\n<summary>T</summary>\n\t${image}\n</details>`), "> [!note]- T\n> ![](whisk.png)");
  assert.equal(toO(`> quoted\n\t${image}`), "> quoted\n>\n> ![](whisk.png)");
  assert.equal(toO(`<callout icon="💡">\n\t- item\n\t\t${image}\n</callout>`).includes("nopipeline.invalid"), false);
  // A web image there stays the URL it is.
  assert.equal(toO(`<details>\n<summary>T</summary>\n\t![w](https://example.com/w.png)\n</details>`), "> [!note]- T\n> ![w](https://example.com/w.png)");
});

test("each lone form comes back as the Markdown form with the same caption", () => {
  const cases: [string, string][] = [
    ["![[whisk.png]]", "![](whisk.png)"],
    ["![[whisk.png|a cap]]", "![a cap](whisk.png)"],
    ["![[whisk.png|a cap|300]]", "![a cap](whisk.png)"],
    ["![[whisk.png|300]]", "![](whisk.png)"],
    ["![[map.png|_North_ is up]]", "![*North* is up](map.png)"],
    ["![x](whisk.png)", "![x](whisk.png)"],
    ["![x](<chart 2.png>)", "![x](chart%202.png)"],
    ["![x](chart%202.png)", "![x](chart%202.png)"],
    ["![x|300](whisk.png)", "![x](whisk.png)"],
    ["- ![[whisk.png|c]]", "- ![c](whisk.png)"],
    ["* ![x](whisk.png)", "- ![x](whisk.png)"],
    ["1. ![[whisk.png]]", "1. ![](whisk.png)"],
    ["![[Other/dup.png]]", "![](Other/dup.png)"],
    ["![[dup.png]]", "![](Other/dup.png)"],
  ];
  for (const [line, back] of cases) assert.equal(toO(toN(line)), back, line);
  // And that Markdown form is a fixed point.
  for (const [, back] of cases) assert.equal(toO(toN(back)), back, back);
});

// --- PDFs, audio, video and other files ------------------------------------

const MDIR = "Assets/attachments";
const MURL = `${BASE}/${MDIR}`;
const attachments = mediaOf(
  [
    `${MDIR}/Manual.pdf`,
    `${MDIR}/lecture.mp4`,
    `${MDIR}/audio_memo.mp3`,
    `${MDIR}/minutes.docx`,
    `${MDIR}/My Manual (1).pdf`,
    `${MDIR}/x.png`,
    `${MDIR}/big.mov`,
    `${MDIR}/big.zip`,
    "Other/Duplicate.pdf",
    "Third/Duplicate.pdf",
    "Notes/Draft.md",
    "Notes/Doodle.excalidraw.md",
    "Notes/board.canvas",
  ],
  MDIR,
  [`${MDIR}/big.mov`, `${MDIR}/big.zip`],
);
const mctx = (fromPath = "Cookbook/x.md"): TranslateContext => ({ ...testContext(fromPath), media: attachments });
const mN = (body: string, c = mctx()) => toNotion(body, c);
const mO = (markdown: string, c = mctx()) => toObsidian(markdown, c).trimEnd();

test("an embed of a PDF, audio or video is a block of that kind with the placeholder URL; the alias is the caption", () => {
  assert.equal(mN("![[Manual.pdf]]", mctx("Notes/x.md")), `<pdf src="${MURL}/Manual.pdf"></pdf>`);
  assert.equal(mN("![[lecture.mp4|Lecture 1]]"), `<video src="${MURL}/lecture.mp4">Lecture 1</video>`);
  assert.equal(mN("![[audio_memo.mp3]]"), `<audio src="${MURL}/audio_memo.mp3"></audio>`);
  assert.equal(mN("![Handout](lecture.mp4)"), `<video src="${MURL}/lecture.mp4">Handout</video>`);
  assert.equal(mN("![[lecture.mp4|a _cap_|300]]"), `<video src="${MURL}/lecture.mp4">a *cap*</video>`);
  assert.equal(mN("![[lecture.MP4]]"), `<video src="${MURL}/lecture.mp4"></video>`, "the case of the citation doesn't matter");
  assert.equal(mN("![](My%20Manual%20(1).pdf)"), `<pdf src="${MURL}/My%20Manual%20%281%29.pdf"></pdf>`);
  assert.equal(mN("![](<My Manual (1).pdf>)"), `<pdf src="${MURL}/My%20Manual%20%281%29.pdf"></pdf>`);
});

test("the pinned lines of the brief", () => {
  assert.equal(mN("![[Manual.pdf]]"), '<pdf src="https://nopipeline.invalid/vault/Assets/attachments/Manual.pdf"></pdf>');
  assert.equal(mN("![[Duplicate.pdf]]"), '<pdf src="https://nopipeline.invalid/vault/Other/Duplicate.pdf"></pdf>', "the shortest path among files of one name");
  assert.equal(mN("![[Assets/attachments/Manual.pdf]]"), '<pdf src="https://nopipeline.invalid/vault/Assets/attachments/Manual.pdf"></pdf>');
  assert.equal(mN("[[minutes.docx]]"), `<file src="${MURL}/minutes.docx"></file>`);
  assert.equal(mN("[Handout](minutes.docx)"), `<file src="${MURL}/minutes.docx">Handout</file>`);
  assert.equal(mN("[Handout](Assets/attachments/Manual.pdf)"), `<file src="${MURL}/Manual.pdf">Handout</file>`);
  assert.equal(mN("![[Manual.pdf#page=3]]"), '<pdf src="https://nopipeline.invalid/vault/Assets/attachments/Manual.pdf"></pdf>');
  assert.equal(mN("[[x.png]]"), `<file src="${MURL}/x.png"></file>`, "a link to an image stays a file block");
});

test("an embed of a file Obsidian can't show is a file block too; a link is a file block for every kind", () => {
  assert.equal(mN("![[minutes.docx]]"), `<file src="${MURL}/minutes.docx"></file>`);
  assert.equal(mN("![t](minutes.docx)"), `<file src="${MURL}/minutes.docx">t</file>`);
  assert.equal(mN("[[lecture.mp4|Lecture 1]]"), `<file src="${MURL}/lecture.mp4">Lecture 1</file>`);
  assert.equal(mN("[Lecture 1](lecture.mp4)"), `<file src="${MURL}/lecture.mp4">Lecture 1</file>`);
  assert.equal(mN("[[audio_memo.mp3]]"), `<file src="${MURL}/audio_memo.mp3"></file>`);
  assert.equal(mN("[t](x.png)"), `<file src="${MURL}/x.png">t</file>`);
});

test("a link's text is the caption, unless it is only the file's name", () => {
  assert.equal(mN("[[minutes.docx|My minutes]]"), `<file src="${MURL}/minutes.docx">My minutes</file>`);
  assert.equal(mN("[[minutes.docx|minutes.docx]]"), `<file src="${MURL}/minutes.docx"></file>`);
  assert.equal(mN("[minutes.docx](minutes.docx)"), `<file src="${MURL}/minutes.docx"></file>`);
  assert.equal(mN("[[Assets/attachments/minutes.docx|minutes.docx]]"), `<file src="${MURL}/minutes.docx"></file>`);
  assert.equal(mN("[Manual.pdf](<My Manual (1).pdf>)"), `<file src="${MURL}/My%20Manual%20%281%29.pdf">Manual.pdf</file>`, "another file's name is a caption");
  assert.equal(mN("[**bold** and _italic_](minutes.docx)"), `<file src="${MURL}/minutes.docx">**bold** and *italic*</file>`);
  assert.equal(mN("[[minutes.docx|a|b]]"), `<file src="${MURL}/minutes.docx">a\\|b</file>`);
});

test("a page or height after the file is dropped from Notion", () => {
  const pdf = `<pdf src="${MURL}/My%20Manual%20%281%29.pdf">`;
  assert.equal(mN("![[My Manual (1).pdf#page=3]]"), `${pdf}</pdf>`);
  assert.equal(mN("![[My Manual (1).pdf#height=400]]"), `${pdf}</pdf>`);
  assert.equal(mN("![[My Manual (1).pdf#page=3&height=400|Cap]]"), `${pdf}Cap</pdf>`);
  assert.equal(mN("![](<My Manual (1).pdf#page=3>)"), `${pdf}</pdf>`);
  assert.equal(mN("![Cap](My%20Manual%20(1).pdf#page=3)"), `${pdf}Cap</pdf>`);
  assert.equal(mN("[[minutes.docx#page=3]]"), `<file src="${MURL}/minutes.docx"></file>`);
  // An image's citation never had one: it stays as it is, text.
  assert.equal(mN("![[x.png#page=3]]"), toNotion("![[x.png#page=3]]", plain()));
});

test("a file in a list item is the empty item and the block one tab deeper", () => {
  assert.equal(mN("- ![[audio_memo.mp3]]"), `-\n\t<audio src="${MURL}/audio_memo.mp3"></audio>`);
  assert.equal(mN("1. [Handout](minutes.docx)"), `1.\n\t<file src="${MURL}/minutes.docx">Handout</file>`);
  assert.equal(mN("- a\n\t- ![[lecture.mp4|c]]\n\t- sub"), `- a\n\t-\n\t\t<video src="${MURL}/lecture.mp4">c</video>\n\t- sub`);
  assert.equal(mN("before\n[[minutes.docx]]\nafter"), `before\n<file src="${MURL}/minutes.docx"></file>\nafter`);
});

test("an inline link, a quote, a table, a task and a shared line stay text, as without attachments", () => {
  const stay = [
    "see [[minutes.docx]] now",
    "see [Handout](minutes.docx) now",
    "![[Manual.pdf]] and more",
    "> ![[lecture.mp4]]",
    "> [[minutes.docx]]",
    "- [ ] [[minutes.docx]]",
    "- [[minutes.docx]] and more",
    "| a | b |\n| --- | --- |\n| ![[Manual.pdf]] | [[minutes.docx]] |",
    "[[Draft]]",
    "[Draft](Draft.md)",
    "![[Draft]]",
    "[[Doodle.excalidraw]]",
    "![[board.canvas]]",
    "[web](https://example.com/a.pdf)",
    "![web](https://example.com/a.pdf)",
    "[[Release 1.2]]",
    "`![[Manual.pdf]]`",
  ];
  for (const body of stay) assert.equal(mN(body), toNotion(body, plain()), body);
});

test("a file over the upload limit that Notion doesn't hold stays text and is listed as large; once hosted, it is a block", () => {
  const body = "![[big.mov]]\n\n[[big.zip]]\n\n- ![big](big.mov)";
  assert.equal(mN(body), toNotion(body, plain()));
  assert.deepEqual(strandedMedia(body, mctx()), [
    { line: "![[big.mov]]", why: "large" },
    { line: "[[big.zip]]", why: "large" },
    { line: "- ![big](big.mov)", why: "large" },
  ]);
  const held = mediaOf([`${MDIR}/big.mov`, `${MDIR}/big.zip`], MDIR, [`${MDIR}/big.mov`, `${MDIR}/big.zip`]);
  held.hosted = (path) => path.endsWith("big.mov");
  const c = { ...testContext(), media: held };
  assert.equal(toNotion("![[big.mov]]", c), `<video src="${MURL}/big.mov"></video>`);
  assert.equal(toNotion("[[big.zip]]", c), toNotion("[[big.zip]]", testContext()));
  assert.deepEqual(strandedMedia("![[big.mov]]\n\n[[big.zip]]", c), [{ line: "[[big.zip]]", why: "large" }]);
});

test("stranded lists every kind: shared; an inline link or a note's name is no stranded file", () => {
  const stranded = (body: string) => strandedMedia(body, mctx());
  assert.deepEqual(stranded("text ![[Manual.pdf]] more\n\n> ![[lecture.mp4]]\n\n> [[minutes.docx]]\n\n- [ ] [Handout](minutes.docx)"), [
    { line: "text ![[Manual.pdf]] more", why: "shared" },
    { line: "> ![[lecture.mp4]]", why: "shared" },
    { line: "> [[minutes.docx]]", why: "shared" },
    { line: "- [ ] [Handout](minutes.docx)", why: "shared" },
  ]);
  assert.deepEqual(stranded("![[void.pdf]]\n\n[[void.docx]]\n\n[t](void.mp3)\n\n![[void.zip#page=2]]"), []);
  assert.deepEqual(stranded("see [[minutes.docx]] now\n\n[[Draft]]\n\n[[Release 1.2]]\n\n[[Meeting 2024.11.03]]\n\n![[Draft]]\n\n[[void]]\n\n[[x.png#a]]"), []);
  assert.deepEqual(stranded("![[Manual.pdf]]\n\n[[minutes.docx]]\n\n- ![[lecture.mp4]]\n\n```\n![[Manual.pdf]]\n```\n\n`> ![[Manual.pdf]]`"), []);
  assert.deepEqual(strandedMedia("text ![[Manual.pdf]] more\n\n[[void.docx]]", plain()), []);
});

test("without attachments in the context the translator writes the same lines as before", () => {
  for (const body of ["![[Manual.pdf]]", "[[minutes.docx]]", "[Handout](Manual.pdf)", "- ![[lecture.mp4|Lecture 1]]"]) {
    assert.equal(toNotion(body, plain()).includes("nopipeline.invalid"), false, body);
  }
  assert.equal(toNotion("[[minutes.docx]]", plain()), "\\[\\[minutes.docx\\]\\]");
  assert.equal(toObsidian(`<pdf src="${MURL}/Manual.pdf">c</pdf>\n`, plain()), `<pdf src="${MURL}/Manual.pdf">c</pdf>\n`);
});

test("the lines the translator writes read back from Notion as they are", () => {
  for (const body of ["![[Manual.pdf]]", "![[lecture.mp4|Lecture 1]]", "![[audio_memo.mp3|a _b_ c]]", "[[minutes.docx]]", "[Handout](minutes.docx)", "![[My Manual (1).pdf|Cap]]"]) {
    assert.deepEqual(rereadLines(mN(body)), [], body);
  }
});

test("PDF, audio, video and file blocks come back as citations; embeds for the first three, a link for a file", () => {
  assert.equal(mO(`<pdf src="${MURL}/My%20Manual%20%281%29.pdf">Cap</pdf>`), "![Cap](My%20Manual%20%281%29.pdf)");
  assert.equal(mO(`<pdf src="${BASE}/Other/Duplicate.pdf"></pdf>`), "![](Other/Duplicate.pdf)", "its name is shared with another file");
  assert.equal(mO(`<video src="${MURL}/lecture.mp4">Lecture *1*</video>`), "![Lecture *1*](lecture.mp4)");
  assert.equal(mO(`<audio src="${MURL}/audio_memo.mp3"></audio>`), "![](audio_memo.mp3)");
  assert.equal(mO(`<file src="${MURL}/minutes.docx">My minutes</file>`), "[My minutes](minutes.docx)");
  assert.equal(mO(`<file src="${MURL}/minutes.docx"></file>`), "[minutes.docx](minutes.docx)", "a link without a caption reads as the file's name");
  assert.equal(mO(`<file src="${MURL}/My%20Manual%20%281%29.pdf"></file>`), "[My Manual (1).pdf](My%20Manual%20%281%29.pdf)");
  assert.equal(mO(`<file src="${MURL}/x.png"></file>`), "[x.png](x.png)", "a file block holding an image stays a link");
  assert.equal(mO(`<pdf src="${MURL}/minutes.docx"></pdf>`), "![](minutes.docx)", "a PDF block holding another kind of file is an embed of it");
  assert.equal(mO(`<file src="${MURL}/audio_memo.mp3">c</file>`), "[c](audio_memo.mp3)");
});

test("a file in a list item, a callout, a toggle or a quote comes back as a citation inside it", () => {
  assert.equal(mO(`-\n\t<audio src="${MURL}/audio_memo.mp3">c</audio>`), "- ![c](audio_memo.mp3)");
  assert.equal(mO(`1.\n\t<file src="${MURL}/minutes.docx">c</file>`), "1. [c](minutes.docx)");
  assert.equal(mO(`<callout icon="💡">\n\tinside\n\t<file src="${MURL}/minutes.docx"></file>\n</callout>`), "> [!tip]\n> inside\n>\n> [minutes.docx](minutes.docx)");
  assert.equal(mO(`<details>\n<summary>T</summary>\n\t<pdf src="${MURL}/My%20Manual%20%281%29.pdf"></pdf>\n</details>`), "> [!note]- T\n> ![](My%20Manual%20%281%29.pdf)");
  assert.equal(mO(`> quoted\n\t<video src="${MURL}/lecture.mp4"></video>`), "> quoted\n>\n> ![](lecture.mp4)");
});

test("a hosted or web source of a PDF, audio, video or file comes back as it is", () => {
  const hosted = "https://prod-files-secure.s3.us-west-2.amazonaws.com/4f1c2a9e-0000-4000-8000-123456789abc/cfdfc7c5-9649-4e3a-8148-8a38d31e611e/probe.pdf";
  for (const tag of ["pdf", "file", "audio", "video"]) {
    for (const src of [hosted, `${hosted}?X-Amz-Signature=abc#notion_record=block.1.2`, "https://example.com/a.bin", "https://youtu.be/x"]) {
      assert.equal(mO(`<${tag} src="${src}">c</${tag}>`), `<${tag} src="${src}">c</${tag}>`, `${tag} ${src}`);
      assert.equal(mO(`-\n\t<${tag} src="${src}">c</${tag}>`), `-\n\t<${tag} src="${src}">c</${tag}>`, `${tag} ${src}`);
    }
  }
  assert.equal(mO(`![c](${hosted})`), `![c](${hosted})`, "an image's, as before");
});

test("a placeholder of any kind outside the positions the translator writes blocks in still reaches the note as a citation", () => {
  const text = toObsidian(`text <pdf src="${MURL}/My%20Manual%20%281%29.pdf">c</pdf> end [l](${MURL}/minutes.docx)\n`, mctx());
  assert.equal(text.includes("nopipeline.invalid"), false);
});

test("each lone form comes back as the Markdown form, and that form is a fixed point", () => {
  const cases: [string, string][] = [
    ["![[My Manual (1).pdf]]", "![](My%20Manual%20%281%29.pdf)"],
    ["![[My Manual (1).pdf#page=3|Cap]]", "![Cap](My%20Manual%20%281%29.pdf)"],
    ["![[lecture.mp4|Lecture 1]]", "![Lecture 1](lecture.mp4)"],
    ["![[lecture.mp4|Lecture 1|300]]", "![Lecture 1](lecture.mp4)"],
    ["![x](audio_memo.mp3)", "![x](audio_memo.mp3)"],
    ["[[minutes.docx]]", "[minutes.docx](minutes.docx)"],
    ["[[minutes.docx|My minutes]]", "[My minutes](minutes.docx)"],
    ["[Handout](minutes.docx)", "[Handout](minutes.docx)"],
    ["[[lecture.mp4]]", "[lecture.mp4](lecture.mp4)"],
    ["[[x.png]]", "[x.png](x.png)"],
    ["![[minutes.docx]]", "[minutes.docx](minutes.docx)"],
    ["- [[minutes.docx|My minutes]]", "- [My minutes](minutes.docx)"],
    ["* ![[lecture.mp4]]", "- ![](lecture.mp4)"],
    ["1. [[x.png]]", "1. [x.png](x.png)"],
    ["[[My Manual (1).pdf]]", "[My Manual (1).pdf](My%20Manual%20%281%29.pdf)"],
  ];
  for (const [line, back] of cases) assert.equal(mO(mN(line)), back, line);
  for (const [, back] of cases) assert.equal(mO(mN(back)), back, back);
});

test("an image alone keeps its image line next to the other kinds", () => {
  assert.equal(mN("![[x.png|cap]]\n\n![[Duplicate.pdf]]\n\n[[x.png]]"), `![cap](${MURL}/x.png)\n<pdf src="https://nopipeline.invalid/vault/Other/Duplicate.pdf"></pdf>\n<file src="${MURL}/x.png"></file>`);
});

const IMG = `\t![](${BASE}/${DIR}/oven.png)`;

test("an image that ends a list item is its child, however the note lays it out", () => {
  const want = `- item\n${IMG}\n- next`;
  for (const note of ["- item\n![[oven.png]]\n- next", "- item\n  ![[oven.png]]\n- next", "- item\n\t![[oven.png]]\n- next"]) assert.equal(toN(note), want, note);
  assert.equal(toN("1. step\n![[oven.png]]"), `1. step\n${IMG}`);
  assert.equal(toN("- [ ] task\n![[oven.png]]"), `- [ ] task\n${IMG}`);
  assert.equal(toN("- item\n![[oven.png]]\n![[whisk.png]]"), `- item\n${IMG}\n\t![](${BASE}/${DIR}/whisk.png)`);
  assert.equal(toN("- a\n\t- b\n\t![[oven.png]]"), `- a\n\t- b\n\t\t![](${BASE}/${DIR}/oven.png)`);
});

test("a PDF that ends a list item is its child", () => {
  assert.equal(mN("- item\n![[Manual.pdf]]"), `- item\n\t<pdf src="${MURL}/Manual.pdf"></pdf>`);
});

test("an image that ends a quote is its child, with or without a blank quote line", () => {
  const want = `> text\n${IMG}`;
  assert.equal(toN("> text\n>\n> ![[oven.png]]"), want);
  assert.equal(toN("> text\n> ![[oven.png]]"), want);
  assert.equal(toN("> text\n> ![[oven.png]]\n> ![[whisk.png]]"), `${want}\n\t![](${BASE}/${DIR}/whisk.png)`);
});

test("a citation that does not end the item or quote, or has no text before it, stays text", () => {
  for (const body of ["- ![[oven.png]] word", "- item\n![[oven.png]]\nmore", "> ![[oven.png]]", "> ![[oven.png]]\n> ![[whisk.png]]", "> text\n> ![[oven.png]]\n> more", "> [!note]\n> text\n> ![[oven.png]]", "| a | b |\n| --- | --- |\n| ![[oven.png]] | x |"]) {
    assert.equal(toN(body), toNotion(body, plain()), body);
  }
});

test("stranded reports nothing for the lines that become children, and shared for the rest", () => {
  const stranded = (body: string) => strandedMedia(body, here).map((s) => s.line);
  assert.deepEqual(stranded("- item\n![[oven.png]]\n\n> text\n>\n> ![[oven.png]]\n\n- item\n  ![[oven.png]]"), []);
  assert.deepEqual(stranded("- ![[oven.png]] word"), ["- ![[oven.png]] word"]);
  assert.deepEqual(stranded("> ![[oven.png]]"), ["> ![[oven.png]]"]);
  assert.deepEqual(stranded("> ![[oven.png]]\n> ![[whisk.png]]"), ["> ![[oven.png]]", "> ![[whisk.png]]"]);
  assert.deepEqual(stranded("> [!note]\n> ![[oven.png]]"), ["> ![[oven.png]]"]);
  assert.deepEqual(stranded("| a | b |\n| --- | --- |\n| ![[oven.png]] | x |"), ["| ![[oven.png]] | x |"]);
  assert.deepEqual(stranded("- item\n![[oven.png]]\nmore"), ["![[oven.png]]"]);
});
