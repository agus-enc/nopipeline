import { test } from "node:test";
import assert from "node:assert/strict";
import { linkedPageIds, nextRelation, sameEntries } from "../../src/links/relation.ts";
import { pageUrl } from "../../src/notion/ids.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [a, b, c, h, self] = [id(1), id(2), id(3), id(4), id(5)];
const live = new Set([a, b, c, h, self]);

test("linkedPageIds finds links and page mentions in text order, each once", () => {
  const md = [
    `<mention-page url="${pageUrl(b)}"/> first, then [t](${pageUrl(a)}) and`,
    `<mention-page url="${pageUrl(c)}">C</mention-page>, [again](${pageUrl(a)}).`,
  ].join("\n");
  assert.deepEqual(linkedPageIds(md, live, self), [b, a, c]);
});

test("linkedPageIds skips pages that are not live, and the page itself", () => {
  const md = `[x](${pageUrl(id(99))}) [me](${pageUrl(self)}) [ok](${pageUrl(a)})`;
  assert.deepEqual(linkedPageIds(md, live, self), [a]);
});

test("linkedPageIds skips embeds, database mentions and links to other sites", () => {
  const md = [
    `![x](${pageUrl(a)})`,
    `<mention-database url="${pageUrl(b)}"/>`,
    `[web](https://example.com/${pageUrl(c)})`,
    `[ok](${pageUrl(h)})`,
  ].join("\n");
  assert.deepEqual(linkedPageIds(md, live, self), [h]);
});

test("linkedPageIds skips links inside code blocks, quotes and list items", () => {
  const link = `[t](${pageUrl(a)})`;
  const md = [
    "```",
    link,
    "```",
    "> ```",
    `> ${link}`,
    "> ```",
    "- item",
    "  ```",
    `  ${link}`,
    "  ```",
    `[after](${pageUrl(b)})`,
  ].join("\n");
  assert.deepEqual(linkedPageIds(md, live, self), [b]);
});

test("linkedPageIds skips links inside inline code", () => {
  const md = `\`[t](${pageUrl(a)})\` and ${"``"}[t](${pageUrl(b)})${"``"} but [t](${pageUrl(c)})`;
  assert.deepEqual(linkedPageIds(md, live, self), [c]);
});

test("linkedPageIds counts a heading link for its page", () => {
  assert.deepEqual(linkedPageIds(`[t](${pageUrl(a)}#heading)`, live, self), [a]);
});

test("first run adopts entries that match a text link, and keeps the others as the user's", () => {
  assert.deepEqual(nextRelation({ current: [a, h], owned: undefined, linked: [a, b] }), {
    relation: [h, a, b],
    owned: [a, b],
    capped: false,
  });
});

test("a link added", () => {
  assert.deepEqual(nextRelation({ current: [a], owned: [a], linked: [a, b] }), {
    relation: [a, b],
    owned: [a, b],
    capped: false,
  });
});

test("a link removed", () => {
  assert.deepEqual(nextRelation({ current: [a, b], owned: [a, b], linked: [a] }), {
    relation: [a],
    owned: [a],
    capped: false,
  });
});

test("a hand entry with no link is kept", () => {
  assert.deepEqual(nextRelation({ current: [h, a], owned: [a], linked: [a] }), {
    relation: [h, a],
    owned: [a],
    capped: false,
  });
});

test("a link that matches a hand entry leaves it the user's, also once the link is gone", () => {
  assert.deepEqual(nextRelation({ current: [h], owned: [], linked: [h] }), { relation: [h], owned: [], capped: false });
  assert.deepEqual(nextRelation({ current: [h], owned: [], linked: [] }), { relation: [h], owned: [], capped: false });
});

test("an entry the sync added and the user removed comes back while its link stays", () => {
  assert.deepEqual(nextRelation({ current: [], owned: [a], linked: [a] }), { relation: [a], owned: [a], capped: false });
});

test("a relation over 100 entries is cut, hand entries first, and only the entries written are owned", () => {
  const hand = Array.from({ length: 99 }, (_, i) => id(100 + i));
  const linked = [id(1), id(2), id(3)];
  const next = nextRelation({ current: hand, owned: [], linked });
  assert.equal(next.relation.length, 100);
  assert.deepEqual(next.relation.slice(0, 99), hand);
  assert.deepEqual(next.owned, [id(1)]);
  assert.equal(next.capped, true);
});

test("an entry the sync added stays the sync's while its page is not live, and goes with its link once it is back", () => {
  const t = id(50);
  const liveNow = new Set([a, b]);
  // t is in the trash: Notion hides the entry and the text link does not count; ownership is kept.
  assert.deepEqual(nextRelation({ current: [], owned: [t], linked: [], live: liveNow }), { relation: [], owned: [t], capped: false });
  assert.deepEqual(nextRelation({ current: [a], owned: [a, t], linked: [a], live: liveNow }), { relation: [a], owned: [a, t], capped: false });
  // t is restored and its link is gone: the entry reappears, is still the sync's, and is removed.
  assert.deepEqual(nextRelation({ current: [t, h], owned: [t], linked: [], live: new Set([t, h]) }), { relation: [h], owned: [], capped: false });
});

test("more than 100 hand entries are left as they are", () => {
  const hand = Array.from({ length: 101 }, (_, i) => id(100 + i));
  assert.deepEqual(nextRelation({ current: hand, owned: [], linked: [a] }), { relation: hand, owned: [], capped: false, handOver: true });
  const exactly = hand.slice(0, 100);
  assert.equal(nextRelation({ current: exactly, owned: [], linked: [a] }).handOver, undefined);
});

test("sameEntries compares as sets", () => {
  assert.equal(sameEntries([a, b], [b, a]), true);
  assert.equal(sameEntries([a], [a, b]), false);
});

test("linkedPageIds: an unmatched backtick does not blank the links between it and a later span", () => {
  const md = `a \` b\n\n[t](${pageUrl(a)})\n\nlater \`x\``;
  assert.deepEqual(linkedPageIds(md, live, self), [a]);
});

test("linkedPageIds: a line that starts with an inline triple-backtick span does not open a fence", () => {
  const md = `\`\`\`code\`\`\` [a](${pageUrl(a)})\n[b](${pageUrl(b)})`;
  assert.deepEqual(linkedPageIds(md, live, self), [a, b]);
});

test("linkedPageIds skips an embedded page mention", () => {
  const md = `!<mention-page url="${pageUrl(a)}"/> <mention-page url="${pageUrl(b)}"/>`;
  assert.deepEqual(linkedPageIds(md, live, self), [b]);
});
