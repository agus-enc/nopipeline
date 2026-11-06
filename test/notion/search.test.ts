import { test } from "node:test";
import assert from "node:assert/strict";
import { searchTexts, type MentionTarget } from "../../src/notion/search.ts";

const LIVE = "cb56bbf0-dc78-4886-8553-6285651b9f5d";
const TRASHED = "595b6194-8d72-4785-8ce8-a4eb90e3e551";
const MISSING = "1273de38-b3ab-4c53-8cc5-3c4a76c06f7a";
const HIDDEN = "e8ed47c3-53ba-4130-8efd-802761b1339b";
const UNTITLED = "f81667b8-032f-4c48-8b1e-c45e19085615";
const url = (id: string) => `https://app.notion.com/p/${id.replace(/-/g, "")}`;
const mention = (id: string) => `<mention-page url="${url(id)}"/>`;
const titled = (id: string, title: string) => `<mention-page url="${url(id)}">${title}</mention-page>`;
const known = new Map<string, MentionTarget>([
  [LIVE, { title: "Seed Catalog", trashed: false }],
  [TRASHED, { title: "Old note", trashed: true }],
  [MISSING, null],
  [UNTITLED, { title: "", trashed: false }],
]);
const target = (id: string) => known.get(id);

test("a search text holds each page mention in the form Notion finds it by", () => {
  const page = `Intro\n- Ask ${mention(LIVE)} before, see ${mention(UNTITLED)}\n- gone: ${mention(MISSING)}\nEnd`;
  // A page Notion has: titled with its current title (an untitled one with no title); one it can't find: as returned.
  assert.deepEqual(searchTexts(page, `- Ask ${mention(LIVE)} before, see ${mention(UNTITLED)}`, target), [`- Ask ${titled(LIVE, "Seed Catalog")} before, see ${titled(UNTITLED, "")}`]);
  assert.deepEqual(searchTexts(page, `- gone: ${mention(MISSING)}\nEnd`, target), [`- gone: ${mention(MISSING)}\nEnd`]);
  // A page in the trash: as returned, then titled, since Notion has found it either way.
  const trashed = `x ${mention(TRASHED)} and ${mention(LIVE)}`;
  assert.deepEqual(searchTexts(`a\n${trashed}\nb`, trashed, target), [`x ${mention(TRASHED)} and ${titled(LIVE, "Seed Catalog")}`, `x ${titled(TRASHED, "Old note")} and ${titled(LIVE, "Seed Catalog")}`]);
  // A page whose form can't be known (the connection can't read it): no search text.
  assert.equal(searchTexts(`a ${mention(HIDDEN)}`, `a ${mention(HIDDEN)}`, target), null);
  // Text without page mentions, and other mentions and links, are found as they are.
  const others = `On <mention-date start="2026-09-01"/> by <mention-user url="user://1"/> in <mention-database url="${url(LIVE)}">DB</mention-database>: [x](${url(LIVE)})`;
  assert.deepEqual(searchTexts(`${others}\nmore`, others, target), [others]);
});

test("a mention in code is text, found as it is written", () => {
  const span = `Use \`${mention(LIVE)}\` or ${mention(LIVE)}`;
  const block = `\t\`\`\`html\n${mention(HIDDEN)}\n\t\`\`\``;
  const page = `${span}\n- item\n${block}\nAfter`;
  assert.deepEqual(searchTexts(page, span, target), [`Use \`${mention(LIVE)}\` or ${titled(LIVE, "Seed Catalog")}`]);
  assert.deepEqual(searchTexts(page, `${mention(HIDDEN)}\n\t\`\`\`\nAfter`, target), [`${mention(HIDDEN)}\n\t\`\`\`\nAfter`]);
});

test("a line that mentions several pages in the trash is tried in every mix of their forms, all as returned first", () => {
  const OTHER = "05aab12a-52fe-4428-8b3e-b8651e9f4abf";
  const trashedTarget = (id: string) => (id === TRASHED || id === OTHER ? { title: id === TRASHED ? "Old note" : "Other", trashed: true } : known.get(id));
  const line = `x ${mention(TRASHED)} and ${mention(OTHER)} y`;
  const texts = searchTexts(`a\n${line}\nb`, line, trashedTarget)!;
  assert.deepEqual(texts, [
    `x ${mention(TRASHED)} and ${mention(OTHER)} y`,
    `x ${titled(TRASHED, "Old note")} and ${mention(OTHER)} y`,
    `x ${mention(TRASHED)} and ${titled(OTHER, "Other")} y`,
    `x ${titled(TRASHED, "Old note")} and ${titled(OTHER, "Other")} y`,
  ]);
});
