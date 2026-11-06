import { test } from "node:test";
import assert from "node:assert/strict";
import { titleToFileName, uniqueName, usableFolder } from "../../src/vault/filenames.ts";

test("titleToFileName keeps accents and replaces characters that break files or links", () => {
  assert.equal(titleToFileName("Café Crème"), "Café Crème");
  assert.equal(titleToFileName("Soup: tomato - v2"), "Soup- tomato - v2");
  assert.equal(titleToFileName("Crème recipes/tarts/tips"), "Crème recipes-tarts-tips");
  assert.equal(titleToFileName('Say "yes" more'), "Say -yes- more");
  assert.equal(titleToFileName("a#b^c[d]e|f"), "a-b-c-d-e-f");
});

test("titleToFileName composes decomposed accents (NFC)", () => {
  assert.equal(titleToFileName("Cafe\u0301"), "Caf\u00e9");
});

test("titleToFileName never makes hidden, empty or trailing-dot names", () => {
  assert.equal(titleToFileName(".env tips"), "-env tips");
  assert.equal(titleToFileName("   "), "Untitled");
  assert.equal(titleToFileName("Why..."), "Why");
  assert.equal(titleToFileName("notes.v2 overview"), "notes.v2 overview");
});

test("titleToFileName caps the name at 200 bytes without splitting a character", () => {
  const name = titleToFileName("é".repeat(150));
  assert.equal(Buffer.byteLength(name, "utf8") <= 200, true);
  assert.equal(name, "é".repeat(100));
});

test("uniqueName adds a counter when the name is taken, ignoring case", () => {
  assert.equal(uniqueName("Draft", new Set()), "Draft");
  assert.equal(uniqueName("Draft", new Set(["draft"])), "Draft (2)");
  assert.equal(uniqueName("Draft", new Set(["draft", "draft (2)"])), "Draft (3)");
});

test("usableFolder accepts only folder paths inside the vault that the scan sees", () => {
  for (const folder of ["Grove", "Attic/Boxes/Maps", "0-In", "Étoiles et plus"]) assert.equal(usableFolder(folder), true, folder);
  for (const folder of ["../outside", "..", "a/../../b", ".hidden", "Notes/.obsidian", "/abs", "Cloud/", "a//b", "", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b", "a#b", "a^b", "a[b", "a]b", "a\u0000b", "a\nb"]) {
    assert.equal(usableFolder(folder), false, JSON.stringify(folder));
  }
});
