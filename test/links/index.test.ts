import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLinkIndex, encodeVaultPath, linkPathFor, linkTextFor, resolveLink, type LinkEntry } from "../../src/links/index.ts";

const entries: LinkEntry[] = [
  { path: "Grove/Elm.md", pageId: "id-elm", title: "Elm" },
  { path: "0-In/Draft.md", pageId: "id-draft-1", title: "Draft" },
  { path: "Archive/Draft.md", pageId: "id-draft-2", title: "Draft" },
  { path: "Café Crème.md", pageId: "id-sn", title: "Café Crème" },
  { path: "Soup- Tomato.md", pageId: "id-soup", title: "Soup: Tomato" },
  { path: "Layouts/Floor Plan.md", pageId: null, title: "Floor Plan" },
];
const index = buildLinkIndex(entries);

test("resolveLink finds notes by bare name, ignoring case", () => {
  assert.equal(resolveLink(index, "elm", "x.md")?.pageId, "id-elm");
  assert.equal(resolveLink(index, "Café Crème", "x.md")?.pageId, "id-sn");
  assert.equal(resolveLink(index, "Café Crème", "x.md")?.pageId, "id-sn");
  assert.equal(resolveLink(index, "Missing", "x.md"), null);
});

test("resolveLink accepts full paths, path suffixes, .md and relative paths", () => {
  assert.equal(resolveLink(index, "Grove/Elm", "x.md")?.pageId, "id-elm");
  assert.equal(resolveLink(index, "Grove/Elm.md", "x.md")?.pageId, "id-elm");
  assert.equal(resolveLink(index, "Archive/Draft", "x.md")?.pageId, "id-draft-2");
  assert.equal(resolveLink(index, "../Archive/Draft.md", "0-In/Other.md")?.pageId, "id-draft-2");
});

test("resolveLink breaks ties by folder, then by shortest path", () => {
  assert.equal(resolveLink(index, "Draft", "Archive/Note.md")?.pageId, "id-draft-2");
  assert.equal(resolveLink(index, "Draft", "Elsewhere/Note.md")?.pageId, "id-draft-1");
});

test("linkTextFor writes the shortest unambiguous link", () => {
  assert.equal(linkTextFor(index, "id-elm", "x.md"), "Elm");
  assert.equal(linkTextFor(index, "id-draft-1", "Elsewhere/Note.md"), "Draft");
  assert.equal(linkTextFor(index, "id-draft-2", "Elsewhere/Note.md"), "Archive/Draft");
  assert.equal(linkTextFor(index, "id-unknown", "x.md"), null);
});

test("a name a page is known by until its note moves never wins over a real note, but is found where only it fits (final review, third round N5)", () => {
  const index = buildLinkIndex([
    { path: "Renamed.md", pageId: "p", title: "Renamed", alias: true },
    { path: "Folder/Other.md", pageId: "p", title: "Renamed", alias: true },
    { path: "Sub/Renamed.md", pageId: "q", title: "Renamed" },
    { path: "Target.md", pageId: "p", title: "Renamed" },
  ]);
  assert.equal(resolveLink(index, "Renamed", "C.md")?.pageId, "q");
  assert.equal(resolveLink(index, "Other", "C.md")?.path, "Folder/Other.md");
  assert.equal(index.byPageId.get("p")?.path, "Target.md");
});

test("linkPathFor gives the shortest path for any entry, page or not", () => {
  const floorPlan = entries.find((e) => e.title === "Floor Plan")!;
  assert.equal(linkPathFor(index, floorPlan, "x.md"), "Floor Plan");
  const zeroIn = entries.find((e) => e.pageId === "id-draft-1")!;
  assert.equal(linkPathFor(index, zeroIn, "Archive/Note.md"), "0-In/Draft");
  assert.equal(linkPathFor(index, zeroIn, "Elsewhere/Note.md"), "Draft");
});

test("encodeVaultPath encodes each segment, parentheses and % included", () => {
  assert.equal(encodeVaultPath("a b/Draft (2)/100% [x] C#"), "a%20b/Draft%20%282%29/100%25%20%5Bx%5D%20C%23");
});
