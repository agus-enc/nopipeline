import { test } from "node:test";
import assert from "node:assert/strict";
import { idFromUrl, isNotionUrl, normalizeId, pageUrl } from "../../src/notion/ids.ts";

test("normalizeId accepts dashed and compact ids", () => {
  assert.equal(normalizeId("cb56bbf0-dc78-4886-8553-6285651b9f5d"), "cb56bbf0-dc78-4886-8553-6285651b9f5d");
  assert.equal(normalizeId("cb56bbf0dc78488685536285651b9f5d"), "cb56bbf0-dc78-4886-8553-6285651b9f5d");
  assert.equal(normalizeId("not an id"), null);
});

test("idFromUrl reads the page id from the URL path", () => {
  const id = "cb56bbf0-dc78-4886-8553-6285651b9f5d";
  assert.equal(idFromUrl("https://app.notion.com/p/cb56bbf0dc78488685536285651b9f5d?pvs=204"), id);
  assert.equal(idFromUrl("https://www.notion.so/My-Page-cb56bbf0dc78488685536285651b9f5d"), id);
  assert.equal(idFromUrl("https://www.notion.so/cb56bbf0dc78488685536285651b9f5d#7786d65583f34410875d274986df403e"), id);
  assert.equal(idFromUrl("https://example.com/about"), null);
});

test("isNotionUrl only accepts Notion hosts with a page id", () => {
  assert.equal(isNotionUrl("https://www.notion.so/cb56bbf0dc78488685536285651b9f5d"), true);
  assert.equal(isNotionUrl("https://app.notion.com/p/cb56bbf0dc78488685536285651b9f5d"), true);
  assert.equal(isNotionUrl("https://notion.so.evil.example/cb56bbf0dc78488685536285651b9f5d"), false);
  assert.equal(isNotionUrl("https://www.notion.so/pricing"), false);
});

test("pageUrl builds the app.notion.com link form Notion writes", () => {
  assert.equal(pageUrl("cb56bbf0-dc78-4886-8553-6285651b9f5d"), "https://app.notion.com/p/cb56bbf0dc78488685536285651b9f5d");
});
