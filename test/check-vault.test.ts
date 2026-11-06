// scripts/check-vault.ts on a small vault (final review, third round N7): every simulated Notion edit is pulled and
// counted; those the translator writes back in another form, and deletions of a block with the lines nested under
// it, apart from the one-line edits, and none may be pulled wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tempDir, writeTree } from "./helpers/tmp.ts";

test("check-vault pulls and counts the edits that aren't one-line edits too, apart from the others", async (t) => {
  const vault = await tempDir(t);
  await writeTree(vault, {
    "One.md": "- parent\n\t- child\n- other\n\n> quote text\n> ```python\n> x = 1\n> ```\n",
    "Two.md": "Plain\n\n* star\n* two\n\n```js\nlet y\n```\n",
  });
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/check-vault.ts", vault]);
  const report =
    /(\d+) one-line edits: (\d+) pulled right, (\d+) not placed \(the note would be skipped\), (\d+) pulled wrong\. (\d+) more edits the translator writes back in another form, or that delete a block with the lines nested under it: (\d+) pulled as the translator reads Notion's new text, (\d+) not placed, (\d+) pulled wrong\./.exec(
      stdout,
    );
  assert.ok(report, stdout);
  const [oneLine, right, unplaced, wrong, other, otherRight, otherUnplaced, otherWrong] = report.slice(1).map(Number) as [number, number, number, number, number, number, number, number];
  assert.equal(right + unplaced + wrong, oneLine);
  assert.equal(otherRight + otherUnplaced + otherWrong, other);
  assert.ok(other > 0, "deleting `- parent` in Notion deletes `- child` with it");
  assert.equal(wrong + otherWrong, 0);
  assert.match(stdout, /Code block languages: "js" 1 in 1 notes, "python" 1 in 1 notes/);
});

test("check-vault pushes an edit to every note line through the fake's model of Notion's search", async (t) => {
  const vault = await tempDir(t);
  // A note's link is a page link in Notion; an embed of a note is still a page mention.
  await writeTree(vault, {
    "Market.md": "- Bread from [[Rye]] is __fresh__ today.\n- As ![[Rye]] says, __early__ is best.\n",
    "Rye.md": "A _grain_ for bread ~ text\n",
  });
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/check-vault.ts", vault]);
  const report =
    /(\d+) edits: (\d+) written right, (\d+) not placed \(the note would be skipped\), (\d+) not written \(a line Notion would read back as something else\), (\d+) written as a whole page, (\d+) refused by Notion's search, (\d+) written wrong\. (\d+) search texts held a page mention; sent as Notion returns them, (\d+) of them would have been refused\./.exec(
      stdout,
    );
  assert.ok(report, stdout);
  const [edits, right, unplaced, rereads, whole, refused, wrong, mentions, before] = report.slice(1).map(Number) as number[];
  assert.deepEqual([edits, right, unplaced, rereads, whole, refused, wrong], [3, 3, 0, 0, 0, 0, 0]);
  assert.deepEqual([mentions, before], [1, 1]);
});

test("check-vault counts the lines Notion would merge with the lines after them: a backtick left alone, and a later one", async (t) => {
  const vault = await tempDir(t);
  await writeTree(vault, { "Cmds.md": "- `npm ci\n- second\n- `npm test`\n", "Fine.md": "a ` b\n\nno more\n" });
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/check-vault.ts", vault]);
  assert.match(stdout, /Lines Notion would merge with the lines after them \(a backtick left alone, which Notion pairs with a later one\): 1 in 1 notes, whose edits aren't simulated\.\n {2}MERGES {4}1 {2}Cmds\.md/);
});

test("check-vault names the notes whose simulated pushes need a whole-page write", async (t) => {
  // Text added after a table row's last pipe adds a column, a cell in every row of a table of like cells.
  const vault = await tempDir(t);
  await writeTree(vault, { "Grid.md": "| p | q | r |\n| - | - | - |\n| 1 | 1 | 0 |\n| 0 | 0 | 1 |\n| 0 |   |   |\n" });
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/check-vault.ts", vault]);
  assert.match(stdout, /\d+ written as a whole page/);
  assert.match(stdout, /\n {2}whole page +\d+ {2}Grid\.md\n/);
});

test("check-vault counts the lines Notion would read back as something else, and leaves those notes' edits out", async (t) => {
  const vault = await tempDir(t);
  await writeTree(vault, { "Esc.md": "\\# Not a heading\n\nOther\n", "Fine.md": "# Heading\n" });
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/check-vault.ts", vault]);
  assert.match(stdout, /Lines Notion would read back as something else the next time their page is written \(the tool writes none of those pages, not even to create or pair them\): 1 in 1 notes, whose edits aren't simulated\.\n {2}REREADS {4}1 {2}Esc\.md/);
});

test("check-vault counts the [[links]] a sync would convert, apart by target, and the embeds it leaves", async (t) => {
  const vault = await tempDir(t);
  await writeTree(vault, {
    "A.md": "See [[B]] and [[B|bee]], also [[Nothing]]. ![[B]]\n\n`[[B]]` and `![[pic.png]]` stay\n\n```\n![[B]]\n```\n",
    "B.md": "Plain\n",
  });
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/check-vault.ts", vault]);
  assert.match(stdout, /^LINKS converted 3 in 1 notes \(2 to notes, 1 to missing notes\), 1 embeds left$/m);
});

test("check-vault simulates the notes as a run converts them, as every run works on the converted notes (final review)", async (t) => {
  const vault = await tempDir(t);
  await writeTree(vault, { "A.md": "---\ntags: [x]\n---\nSee [[B]] and [[B|bee]] here\n", "B.md": "Plain\n" });
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/check-vault.ts", vault, "--show", "A.md"]);
  assert.match(stdout, /^NOTE {4}1 {2}See \[B\]\(B\.md\) and \[bee\]\(B\.md\) here$/m);
  assert.match(stdout, /^LINKS converted 2 in 1 notes \(2 to notes, 0 to missing notes\), 0 embeds left$/m);
});

test("check-vault translates with the vault's images and counts the image notes apart (final review, finding 3)", async (t) => {
  const vault = await tempDir(t);
  await writeTree(vault, {
    ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: "Assets" }),
    "Assets/x.png": "x",
    "Pics.md": "Intro\n\n![[x.png]]\n\n- ![[x.png|cap|300]]\n- two\n\n![w|200](x.png)\n\nand ![[x.png]] inline\n\n![[gone.png]]\n",
    "Plain.md": "No pictures here.\n",
  });
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/check-vault.ts", vault]);
  assert.match(stdout, /IMAGES 3 image lines in 1 notes are translated as Notion images/);
  assert.match(stdout, /2 notes, 0 drawings: 0 failed, 0 lost words, 0 unstable/);
  assert.match(stdout, /0 pulled wrong\./);
  assert.match(stdout, /0 refused by Notion's search, 0 written wrong\./);
});

test("check-vault counts the placeholder lines of each kind of attachment, so a note that would gain a non-image block shows", async (t) => {
  const vault = await tempDir(t);
  await writeTree(vault, {
    ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: "Assets" }),
    "Assets/x.png": "x",
    "Assets/Manual.pdf": "p",
    "Assets/song.mp3": "s",
    "Assets/lecture.mp4": "v",
    "Assets/minutes.docx": "d",
    "A.md": "![[x.png]]\n\n![[Manual.pdf#page=3]]\n\n[[minutes.docx|Minutes]]\n\n![[song.mp3]]\n\n- ![[lecture.mp4]]\n\n[x](x.png)\n\nand ![[Manual.pdf]] inline\n\n![[gone.pdf]]\n",
    "B.md": "![[song.mp3]]\n",
    "Plain.md": "No attachments.\n",
  });
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/check-vault.ts", vault]);
  assert.match(stdout, /^ATTACHMENTS image 1, pdf 1, audio 2, video 1, file 2$/m);
  assert.match(stdout, /^IMAGES 1 image lines in 1 notes are translated as Notion images/m);
  const none = await tempDir(t);
  await writeTree(none, { "Plain.md": "Nothing.\n" });
  assert.match((await promisify(execFile)(process.execPath, ["scripts/check-vault.ts", none])).stdout, /^ATTACHMENTS image 0, pdf 0, audio 0, video 0, file 0$/m);
});
