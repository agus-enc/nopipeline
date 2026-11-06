import { test } from "node:test";
import assert from "node:assert/strict";
import { isExcalidraw, readNotionProps, replaceBody, setProp, splitFrontmatter } from "../../src/vault/frontmatter.ts";

const ID = "cb56bbf0-dc78-4886-8553-6285651b9f5d";

test("splitFrontmatter separates the YAML block from the body", () => {
  assert.deepEqual(splitFrontmatter("---\ntags: [a, b]\n---\n# Title\n"), { frontmatter: "tags: [a, b]", body: "# Title\n" });
  assert.deepEqual(splitFrontmatter("---\n---\nBody"), { frontmatter: "", body: "Body" });
  assert.deepEqual(splitFrontmatter("No frontmatter\n---\n"), { frontmatter: null, body: "No frontmatter\n---\n" });
  assert.deepEqual(splitFrontmatter("---\nnever closed\n"), { frontmatter: null, body: "---\nnever closed\n" });
});

test("readNotionProps reads our keys in plain, double- and single-quoted form", () => {
  assert.deepEqual(readNotionProps(`notion-id: ${ID}\nnotion-title: "Soup: Tomato"`), { notionId: ID, notionTitle: "Soup: Tomato" });
  assert.deepEqual(readNotionProps(`notion-id: "${ID.replace(/-/g, "")}"\nnotion-title: 'It''s'`), { notionId: ID, notionTitle: "It's" });
  assert.deepEqual(readNotionProps("tags: [a]"), { notionId: null, notionTitle: null });
  assert.deepEqual(readNotionProps(null), { notionId: null, notionTitle: null });
});

test("isExcalidraw recognizes drawings by their plugin key", () => {
  assert.equal(isExcalidraw("excalidraw-plugin: parsed\ntags: [excalidraw]"), true);
  assert.equal(isExcalidraw("tags: [excalidraw]"), false);
  assert.equal(isExcalidraw(null), false);
});

test("setProp adds frontmatter to a note that has none", () => {
  assert.equal(setProp("Body\n", "notion-id", ID), `---\nnotion-id: ${ID}\n---\nBody\n`);
});

test("setProp inserts before the closing line and keeps every other byte", () => {
  const text = "---\ntags: [ a,b ]   # odd spacing stays\naliases:\n  - One\n---\nBody";
  assert.equal(setProp(text, "notion-id", ID), `---\ntags: [ a,b ]   # odd spacing stays\naliases:\n  - One\nnotion-id: ${ID}\n---\nBody`);
});

test("setProp replaces and removes an existing key, including indented continuation lines", () => {
  const text = `---\nnotion-title: >\n  folded\n  title\nnotion-id: ${ID}\n---\nBody`;
  assert.equal(setProp(text, "notion-title", "Soup: Tomato"), `---\nnotion-title: "Soup: Tomato"\nnotion-id: ${ID}\n---\nBody`);
  assert.equal(setProp(text, "notion-title", null), `---\nnotion-id: ${ID}\n---\nBody`);
  assert.equal(setProp("Body", "notion-title", null), "Body");
});

test("setProp keeps Windows line endings", () => {
  const text = "---\r\ntags: x\r\n---\r\nBody\r\n";
  assert.equal(setProp(text, "notion-id", ID), `---\r\ntags: x\r\nnotion-id: ${ID}\r\n---\r\nBody\r\n`);
});

test("setProp quotes values YAML would misread", () => {
  assert.equal(setProp("B", "notion-title", "yes"), '---\nnotion-title: "yes"\n---\nB');
  assert.equal(setProp("B", "notion-title", "2024"), '---\nnotion-title: "2024"\n---\nB');
  assert.equal(setProp("B", "notion-title", "Plan"), "---\nnotion-title: Plan\n---\nB");
});

test("replaceBody swaps the body and keeps the frontmatter", () => {
  assert.equal(replaceBody("---\ntags: [x]\n---\nold\n", "new\n"), "---\ntags: [x]\n---\nnew\n");
  assert.equal(replaceBody("old", "new"), "new");
});
