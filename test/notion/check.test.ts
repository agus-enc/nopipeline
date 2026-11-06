import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDatabase } from "../../src/notion/check.ts";

const config = { titleProperty: "Name", linksToProperty: "Links to", projectsRelation: "Project" as string | null, dataSourceId: "notes" };
const good = {
  properties: { Name: { type: "title" }, "Links to": { type: "relation", target: "notes" }, Project: { type: "relation", target: "projects" } },
};

test("a database with a title, Links to and a projects relation passes", () => {
  assert.deepEqual(checkDatabase(good, config), { errors: [], notes: [], linksTo: true, tags: false });
});

test("a wrong title property names the one the database has", () => {
  const { errors } = checkDatabase({ properties: { ...good.properties, Name: { type: "rich_text" }, Titel: { type: "title" } } }, config);
  assert.match(errors[0]!, /title property is "Titel", not "Name": rename it back to "Name" in Notion, or set "titleProperty": "Titel"/);
});

test("no Links to property is a note; one that is not a relation to the database itself is an error", () => {
  const { Project, Name } = good.properties;
  assert.deepEqual(checkDatabase({ properties: { Name, Project } }, config), {
    errors: [],
    notes: ['the database has no "Links to" property; the Links to relation is left alone'],
    linksTo: false,
    tags: false,
  });
  assert.match(checkDatabase({ properties: { Name, Project, "Links to": { type: "rich_text" } } }, config).errors[0]!, /"Links to" property is not a relation to the database itself: it is a rich_text/);
  assert.match(checkDatabase({ properties: { Name, Project, "Links to": { type: "relation", target: "other" } } }, config).errors[0]!, /it is a relation to another database/);
});

test("the projects relation must exist, be a relation, and not point at the notes database", () => {
  const { Name } = good.properties;
  assert.match(checkDatabase({ properties: { Name } }, config).errors.join(), /no "Project" property/);
  assert.match(checkDatabase({ properties: { Name, Project: { type: "select" } } }, config).errors.join(), /"Project" property is a select, not a relation/);
  assert.match(checkDatabase({ properties: { Name, Project: { type: "relation", target: "notes" } } }, config).errors.join(), /points to the notes database itself/);
  assert.deepEqual(checkDatabase({ properties: { Name } }, { ...config, projectsRelation: null }).errors, []);
});

test("linksToProperty null turns Links to off: one note, no error, even with a Links to property", () => {
  const result = checkDatabase(good, { ...config, linksToProperty: null });
  assert.equal(result.errors.length, 0);
  assert.equal(result.linksTo, false);
  assert.equal(result.notes.length, 1);
});

test("tags are on for a multi-select property, and off with one note when it is missing or of another type", () => {
  const withTags = { ...config, tagsProperty: "Tags" as string | null };
  assert.equal(checkDatabase({ properties: { ...good.properties, Tags: { type: "multi_select" } } }, withTags).tags, true);
  const missing = checkDatabase(good, withTags);
  assert.equal(missing.tags, false);
  assert.deepEqual(missing.notes, ['the database has no "Tags" property; tags are left alone']);
  const text = checkDatabase({ properties: { ...good.properties, Tags: { type: "rich_text" } } }, withTags);
  assert.equal(text.tags, false);
  assert.deepEqual(text.notes, ['the database\'s "Tags" property is a rich_text, not a multi-select; tags are left alone']);
  assert.deepEqual(text.errors, []);
  assert.deepEqual(checkDatabase({ properties: { ...good.properties, Tags: { type: "multi_select" } } }, { ...withTags, tagsProperty: null }), { errors: [], notes: [], linksTo: true, tags: false });
});
