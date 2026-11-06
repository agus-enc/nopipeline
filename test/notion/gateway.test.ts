import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkGateway, NotionPageError, ProjectsUnreadable, type SdkGatewayOptions } from "../../src/notion/gateway.ts";

interface Call {
  method: string;
  url: string;
  version: string | undefined;
  body: unknown;
}

function fakeHttp(respond: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = { method: String(init?.method), url, version: headers["Notion-Version"], body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const { status = 200, body } = respond(call);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as SdkGatewayOptions["fetch"];
  return { calls, fetch };
}

const options = { token: "secret_test", dataSourceId: "a50245e9-8e6a-41aa-8ccf-d8795ed0dead", titleProperty: "Name" };
const PROJECTS = { ...options, projectsRelation: "Project" };
const page = (id: string, title: string, projects?: { ids: string[]; more?: boolean }) => ({
  object: "page",
  id,
  url: `https://www.notion.so/${id.replace(/-/g, "")}`,
  last_edited_time: "2026-09-27T04:00:00.000Z",
  properties: {
    Name: { id: "title", type: "title", title: [{ type: "text", plain_text: title, text: { content: title } }] },
    ...(projects ? { Project: { id: "prj", type: "relation", relation: projects.ids.map((id) => ({ id })), has_more: projects.more === true } } : {}),
  },
});

test("listPages reads every page of the data source with API version 2026-03-11, leaving out trashed ones", async () => {
  const http = fakeHttp((call) => {
    const second = (call.body as { start_cursor?: string }).start_cursor === "next";
    return {
      body: second
        ? {
            object: "list",
            results: [page("595b6194-8d72-4785-8ce8-a4eb90e3e551", "Oak"), { ...page("974d5b35-3044-4348-8ee8-927db9b4a732", "Old"), in_trash: true }],
            has_more: false,
            next_cursor: null,
          }
        : { object: "list", results: [page("cb56bbf0-dc78-4886-8553-6285651b9f5d", "Elm")], has_more: true, next_cursor: "next" },
    };
  });
  const pages = await createSdkGateway({ ...options, fetch: http.fetch }).listPages();
  assert.deepEqual(pages, [
    { id: "cb56bbf0-dc78-4886-8553-6285651b9f5d", title: "Elm", folder: null, lastEditedTime: "2026-09-27T04:00:00.000Z" },
    { id: "595b6194-8d72-4785-8ce8-a4eb90e3e551", title: "Oak", folder: null, lastEditedTime: "2026-09-27T04:00:00.000Z" },
  ]);
  assert.equal(http.calls[0]!.url, `https://api.notion.com/v1/data_sources/${options.dataSourceId}/query`);
  assert.equal(http.calls[0]!.version, "2026-03-11");
});

test("markdown reads and writes go to the page markdown endpoint", async () => {
  const http = fakeHttp(() => ({ body: { object: "page_markdown", id: "p", markdown: "after", truncated: false, unknown_block_ids: [] } }));
  const notion = createSdkGateway({ ...options, fetch: http.fetch });
  assert.deepEqual(await notion.getMarkdown("p1"), { markdown: "after", truncated: false });
  assert.equal(await notion.updateContent("p1", [{ old_str: "a", new_str: "b" }]), "after");
  assert.equal(await notion.replaceContent("p1", "whole"), "after");
  assert.deepEqual(
    http.calls.map((c) => [c.method, c.url, c.body]),
    [
      ["GET", "https://api.notion.com/v1/pages/p1/markdown", undefined],
      ["PATCH", "https://api.notion.com/v1/pages/p1/markdown", { type: "update_content", update_content: { content_updates: [{ old_str: "a", new_str: "b" }] } }],
      ["PATCH", "https://api.notion.com/v1/pages/p1/markdown", { type: "replace_content", replace_content: { new_str: "whole" } }],
    ],
  );
});

test("pages are created empty with title, projects and the note icon, renamed by title only, and trashed with in_trash", async () => {
  const http = fakeHttp(() => ({ body: { object: "page", id: "cb56bbf0dc78488685536285651b9f5d" } }));
  const notion = createSdkGateway({ ...PROJECTS, pageIcon: { type: "icon", icon: { name: "bookmark", color: "blue" } }, fetch: http.fetch });
  assert.equal(await notion.createPage({ title: "Elm", projects: ["p-1"] }), "cb56bbf0-dc78-4886-8553-6285651b9f5d");
  await notion.createPage({ title: "Loose" });
  await notion.setTitle("p1", "Root note");
  await notion.trash("p1");
  assert.deepEqual(http.calls[0]!.body, {
    parent: { data_source_id: options.dataSourceId },
    properties: { Name: { title: [{ type: "text", text: { content: "Elm" } }] }, Project: { relation: [{ id: "p-1" }] } },
    icon: { type: "icon", icon: { name: "bookmark", color: "blue" } },
    template: { type: "none" },
  });
  assert.deepEqual((http.calls[1]!.body as { properties: unknown }).properties, { Name: { title: [{ type: "text", text: { content: "Loose" } }] } });
  assert.deepEqual(http.calls[2]!.body, { properties: { Name: { title: [{ type: "text", text: { content: "Root note" } }] } } });
  assert.deepEqual(http.calls[3]!.body, { in_trash: true });
});

test("a project for a profile without a projects relation is refused before any request", async () => {
  const http = fakeHttp(() => ({ body: {} }));
  await assert.rejects(createSdkGateway({ ...options, fetch: http.fetch }).createPage({ title: "A", projects: ["p-1"] }), /projectsRelation/);
  assert.equal(http.calls.length, 0);
});

test("createPage sends no icon unless the profile sets one", async () => {
  const http = fakeHttp(() => ({ body: { object: "page", id: "cb56bbf0dc78488685536285651b9f5d" } }));
  await createSdkGateway({ ...options, pageIcon: null, fetch: http.fetch }).createPage({ title: "A" });
  assert.equal("icon" in (http.calls[0]!.body as object), false);
  const note = { type: "icon", icon: { name: "bookmark", color: "blue" } } as const;
  await createSdkGateway({ ...options, pageIcon: note, fetch: http.fetch }).createPage({ title: "A" });
  assert.deepEqual((http.calls[1]!.body as { icon: unknown }).icon, note);
  await createSdkGateway({ ...options, pageIcon: { type: "emoji", emoji: "📘" }, fetch: http.fetch }).createPage({ title: "A" });
  assert.deepEqual((http.calls[2]!.body as { icon: unknown }).icon, { type: "emoji", emoji: "📘" });
});

test("properties reads the data source's property names and types", async () => {
  const http = fakeHttp(() => ({
    body: { object: "data_source", id: "ds", properties: { Titel: { id: "title", name: "Titel", type: "title", title: {} }, Tags: { id: "f", name: "Tags", type: "multi_select", multi_select: { options: [] } } } },
  }));
  assert.deepEqual(await createSdkGateway({ ...options, fetch: http.fetch }).properties(), { Titel: "title", Tags: "multi_select" });
  assert.deepEqual(http.calls.map((c) => [c.method, c.url]), [["GET", `https://api.notion.com/v1/data_sources/${options.dataSourceId}`]]);
});

test("pageStatus tells a live page from one in the trash or gone, and refuses to guess about one it can't read", async () => {
  const answer = (status: number, body: unknown) => createSdkGateway({ ...options, fetch: fakeHttp(() => ({ status, body })).fetch });
  const full = page("cb56bbf0-dc78-4886-8553-6285651b9f5d", "Elm");
  assert.equal(await answer(200, { ...full, in_trash: false }).pageStatus("p"), "live");
  assert.equal(await answer(200, { ...full, in_trash: true }).pageStatus("p"), "trashed");
  assert.equal(await answer(404, { object: "error", status: 404, code: "object_not_found", message: "no" }).pageStatus("p"), "gone");
  await assert.rejects(answer(403, { object: "error", status: 403, code: "restricted_resource", message: "no" }).pageStatus("p"), (e: unknown) => e instanceof NotionPageError && e.code === "restricted_resource");
  await assert.rejects(answer(401, { object: "error", status: 401, code: "unauthorized", message: "no" }).pageStatus("p"), (e: unknown) => !(e instanceof NotionPageError));
});

test("a refusal for one page becomes a NotionPageError; other failures pass through", async () => {
  const refused = fakeHttp(() => ({ status: 400, body: { object: "error", status: 400, code: "validation_error", message: "old_str not found" } }));
  await assert.rejects(createSdkGateway({ ...options, fetch: refused.fetch }).updateContent("p", [{ old_str: "x", new_str: "y" }]), (e: unknown) => e instanceof NotionPageError && e.code === "validation_error");
  const unauthorized = fakeHttp(() => ({ status: 401, body: { object: "error", status: 401, code: "unauthorized", message: "API token is invalid." } }));
  await assert.rejects(createSdkGateway({ ...options, fetch: unauthorized.fetch }).getMarkdown("p"), (e: unknown) => !(e instanceof NotionPageError));
  for (const [status, code] of [[404, "object_not_found"], [403, "restricted_resource"]] as const) {
    const gone = fakeHttp(() => ({ status, body: { object: "error", status, code, message: "no" } }));
    await assert.rejects(createSdkGateway({ ...options, fetch: gone.fetch }).trash("p"), (e: unknown) => e instanceof NotionPageError && e.code === code);
  }
});

test("pageTitles reads each page's title and leaves out pages it can't read", async () => {
  const http = fakeHttp((call) =>
    call.url.endsWith("/pages/p-ok")
      ? { body: page("f81667b8-032f-4c48-8b1e-c45e19085615", "Grove") }
      : { status: 404, body: { object: "error", status: 404, code: "object_not_found", message: "Could not find page." } },
  );
  const titles = await createSdkGateway({ ...options, fetch: http.fetch }).pageTitles(["p-ok", "p-hidden"]);
  assert.deepEqual([...titles], [["p-ok", "Grove"]]);
  assert.deepEqual(http.calls.map((c) => [c.method, c.url]), [
    ["GET", "https://api.notion.com/v1/pages/p-ok"],
    ["GET", "https://api.notion.com/v1/pages/p-hidden"],
  ]);
  const unauthorized = fakeHttp(() => ({ status: 401, body: { object: "error", status: 401, code: "unauthorized", message: "API token is invalid." } }));
  await assert.rejects(createSdkGateway({ ...options, fetch: unauthorized.fetch }).pageTitles(["p-ok"]), (e: unknown) => !(e instanceof NotionPageError));
});

const blockNotPage = {
  status: 400,
  body: { object: "error", status: 400, code: "validation_error", message: "Provided ID 49c09384-e846-4e1b-84a4-c84df8555f0d is a block, not a page. Use the retrieve block API instead" },
};

test("pageTitles leaves out an id that is a block, not a page (a link-preview's #fragment, live), but other validation errors still surface", async () => {
  const http = fakeHttp((call) => (call.url.endsWith("/pages/p-ok") ? { body: page("f81667b8-032f-4c48-8b1e-c45e19085615", "Grove") } : blockNotPage));
  const titles = await createSdkGateway({ ...options, fetch: http.fetch }).pageTitles(["p-block", "p-ok"]);
  assert.deepEqual([...titles], [["p-ok", "Grove"]]);
  const other = fakeHttp(() => ({ status: 400, body: { object: "error", status: 400, code: "validation_error", message: "path.page_id should be a valid uuid" } }));
  await assert.rejects(createSdkGateway({ ...options, fetch: other.fetch }).pageTitles(["p-ok"]), (e: unknown) => (e as { code?: string }).code === "validation_error");
});

/** Answers each request with the next of `statuses` (a 502 as Notion's edge proxy sends it, as HTML), then with `body`. */
function flaky(statuses: number[], body: unknown) {
  const calls: string[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${String(init?.method)} ${url}`);
    const status = statuses.shift();
    if (status === undefined) return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (status === 502) return new Response("<html><body>502 Bad Gateway</body></html>", { status, headers: { "content-type": "text/html; charset=UTF-8", "cf-ray": "abc-XYZ" } });
    return new Response(JSON.stringify({ object: "error", status, code: status === 503 ? "service_unavailable" : "gateway_timeout", message: "try later" }), { status, headers: { "content-type": "application/json" } });
  }) as unknown as SdkGatewayOptions["fetch"];
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  return { calls, fetch, waits, sleep };
}

const markdownBody = { object: "page_markdown", id: "p", markdown: "text", truncated: false, unknown_block_ids: [] };

test("a 502, 503 or 504 is tried again, waiting longer each time, before the run ends on it", async () => {
  const http = flaky([502, 504], markdownBody);
  assert.deepEqual(await createSdkGateway({ ...options, fetch: http.fetch, sleep: http.sleep }).getMarkdown("p1"), { markdown: "text", truncated: false });
  assert.equal(http.calls.length, 3);
  assert.deepEqual(http.waits, [1000, 2000]);
  // Writes that give the same result when repeated are tried again too (the SDK itself retries no PATCH).
  const write = flaky([503, 502], markdownBody);
  assert.equal(await createSdkGateway({ ...options, fetch: write.fetch, sleep: write.sleep }).replaceContent("p1", "whole"), "text");
  assert.deepEqual(write.calls, ["PATCH https://api.notion.com/v1/pages/p1/markdown", "PATCH https://api.notion.com/v1/pages/p1/markdown", "PATCH https://api.notion.com/v1/pages/p1/markdown"]);
  const trash = flaky([504], { object: "page", id: "p1" });
  await createSdkGateway({ ...options, fetch: trash.fetch, sleep: trash.sleep }).trash("p1");
  assert.equal(trash.calls.length, 2);
  // Three more tries at most: the fourth failure ends the run, as before.
  const down = flaky([502, 502, 502, 502, 502], markdownBody);
  await assert.rejects(createSdkGateway({ ...options, fetch: down.fetch, sleep: down.sleep }).getMarkdown("p1"), (e: unknown) => !(e instanceof NotionPageError));
  assert.equal(down.calls.length, 4);
  assert.deepEqual(down.waits, [1000, 2000, 4000]);
  // Creating a page and search-and-replace edits are not tried again: repeating them could create a second page,
  // or apply an edit twice (an edit that adds a line after its search text matches again).
  const create = flaky([502], { object: "page", id: "cb56bbf0dc78488685536285651b9f5d" });
  await assert.rejects(createSdkGateway({ ...options, fetch: create.fetch, sleep: create.sleep }).createPage({ title: "Elm" }), (e: unknown) => !(e instanceof NotionPageError));
  assert.equal(create.calls.length, 1);
  const edit = flaky([504], markdownBody);
  await assert.rejects(createSdkGateway({ ...options, fetch: edit.fetch, sleep: edit.sleep }).updateContent("p1", [{ old_str: "a", new_str: "a\nb" }]), (e: unknown) => !(e instanceof NotionPageError));
  assert.equal(edit.calls.length, 1);
});

test("a listing that fails halfway is tried again from the page that failed", async () => {
  let n = 0;
  const statuses = [0, 502];
  const fetch = (async (url: string, init?: RequestInit) => {
    const status = statuses[n++] ?? 0;
    if (status === 502) return new Response("<html>502</html>", { status, headers: { "content-type": "text/html" } });
    const second = (JSON.parse(String(init!.body)) as { start_cursor?: string }).start_cursor === "next";
    const body = second
      ? { object: "list", results: [page("595b6194-8d72-4785-8ce8-a4eb90e3e551", "Oak")], has_more: false, next_cursor: null }
      : { object: "list", results: [page("cb56bbf0-dc78-4886-8553-6285651b9f5d", "Elm")], has_more: true, next_cursor: "next" };
    void url;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as SdkGatewayOptions["fetch"];
  const pages = await createSdkGateway({ ...options, fetch, sleep: async () => {} }).listPages();
  assert.deepEqual(pages.map((p) => p.title), ["Elm", "Oak"]);
  assert.equal(n, 3);
});

test("mentionTargets says what Notion knows of each mentioned page: its title, whether it is in the trash, or that it can't find it", async () => {
  const http = fakeHttp((call) => {
    if (call.url.endsWith("/pages/p-live")) return { body: page("f81667b8-032f-4c48-8b1e-c45e19085615", "Seed Catalog") };
    if (call.url.endsWith("/pages/p-trash")) return { body: { ...page("5d220adf-9757-45a9-85ea-49d5824be8c9", "Old"), in_trash: true } };
    if (call.url.endsWith("/pages/p-restricted")) return { status: 403, body: { object: "error", status: 403, code: "restricted_resource", message: "no" } };
    return { status: 404, body: { object: "error", status: 404, code: "object_not_found", message: "Could not find page." } };
  });
  const targets = await createSdkGateway({ ...options, fetch: http.fetch }).mentionTargets(["p-live", "p-trash", "p-gone", "p-restricted"]);
  assert.deepEqual([...targets], [
    ["p-live", { title: "Seed Catalog", trashed: false }],
    ["p-trash", { title: "Old", trashed: true }],
    ["p-gone", null],
  ]);
  const unauthorized = fakeHttp(() => ({ status: 401, body: { object: "error", status: 401, code: "unauthorized", message: "API token is invalid." } }));
  await assert.rejects(createSdkGateway({ ...options, fetch: unauthorized.fetch }).mentionTargets(["p-live"]), (e: unknown) => !(e instanceof NotionPageError));
});

test("mentionTargets leaves out an id that is a block, not a page", async () => {
  const http = fakeHttp(() => blockNotPage);
  const targets = await createSdkGateway({ ...options, fetch: http.fetch }).mentionTargets(["p-block"]);
  assert.deepEqual([...targets], []);
});

test("trashing a page already in the trash counts as done: a try whose answer was lost, tried again (live probe)", async () => {
  // Notion refuses to trash a trashed page: "Can't edit block that is archived" (validation_error).
  let calls = 0;
  const fetch = (async (url: string, init?: RequestInit) => {
    calls++;
    if (init?.method === "PATCH") {
      return new Response(JSON.stringify({ object: "error", status: 400, code: "validation_error", message: "Can't edit block that is archived. You must unarchive the block before editing." }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ...page("cb56bbf0-dc78-4886-8553-6285651b9f5d", "Elm"), in_trash: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as SdkGatewayOptions["fetch"];
  await createSdkGateway({ ...options, fetch }).trash("p1");
  assert.equal(calls, 2, "the refusal, then the page's status");
  // A refusal for a page that isn't in the trash is still a refusal.
  const live = (async (url: string, init?: RequestInit) =>
    init?.method === "PATCH"
      ? new Response(JSON.stringify({ object: "error", status: 400, code: "validation_error", message: "Can't edit block that is archived." }), { status: 400, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ ...page("cb56bbf0-dc78-4886-8553-6285651b9f5d", "Elm"), in_trash: false }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as SdkGatewayOptions["fetch"];
  await assert.rejects(createSdkGateway({ ...options, fetch: live }).trash("p1"), (e: unknown) => e instanceof NotionPageError && e.code === "validation_error");
});

const linksToOptions = { ...options, linksToProperty: "Links to" };
const SOURCE_URL = `https://api.notion.com/v1/data_sources/${options.dataSourceId}`;
const relationSource = (type: string) => ({
  object: "data_source",
  id: options.dataSourceId,
  properties: {
    Name: { id: "title", name: "Name", type: "title", title: {} },
    "Links to":
      type === "relation"
        ? { id: "J%3FMW", name: "Links to", type: "relation", relation: { data_source_id: "575390a0da37450c88ebe8113c0af76d", type: "single_property", single_property: {} } }
        : { id: "J%3FMW", name: "Links to", type: type, [type]: {} },
  },
});

test("listPages reads a row's Links to relation, with whether the row lists only some of its entries", async () => {
  const withLinks = (id: string, relation: unknown) => ({ ...page(id, "N"), properties: { ...page(id, "N").properties, "Links to": relation } });
  const http = fakeHttp(() => ({
    body: {
      object: "list",
      results: [
        withLinks("cb56bbf0-dc78-4886-8553-6285651b9f5d", { id: "J%3FMW", type: "relation", relation: [{ id: "595b61948d7247858ce8a4eb90e3e551" }], has_more: true }),
        withLinks("595b6194-8d72-4785-8ce8-a4eb90e3e551", { id: "J%3FMW", type: "relation", relation: [], has_more: false }),
        withLinks("974d5b35-3044-4348-8ee8-927db9b4a732", { id: "x", type: "rich_text", rich_text: [] }),
        page("ee6da113-2445-4040-883b-829a9426cd12", "No property"),
      ],
      has_more: false,
      next_cursor: null,
    },
  }));
  const pages = await createSdkGateway({ ...linksToOptions, fetch: http.fetch }).listPages();
  assert.deepEqual(pages.map((p) => p.linksTo), [{ ids: ["595b6194-8d72-4785-8ce8-a4eb90e3e551"], more: true }, { ids: [], more: false }, undefined, undefined]);
});

test("readRelation reads the property id once, then every entry of the page's relation across pages of results", async () => {
  const entry = (id: string) => ({ object: "property_item", type: "relation", id: "x", relation: { id } });
  const a = "cb56bbf0-dc78-4886-8553-6285651b9f5d";
  const b = "595b6194-8d72-4785-8ce8-a4eb90e3e551";
  const c = "974d5b35-3044-4348-8ee8-927db9b4a732";
  const http = fakeHttp((call) => {
    if (call.url === SOURCE_URL) return { body: relationSource("relation") };
    const cursor = new URL(call.url).searchParams.get("start_cursor");
    return {
      body: cursor === "next"
        ? { object: "list", results: [entry(c.replace(/-/g, ""))], has_more: false, next_cursor: null }
        : { object: "list", results: [entry(a), entry(b)], has_more: true, next_cursor: "next" },
    };
  });
  const notion = createSdkGateway({ ...linksToOptions, fetch: http.fetch });
  assert.deepEqual(await notion.readRelation("p1"), [a, b, c]);
  assert.deepEqual(await notion.readRelation("p2"), [a, b, c]);
  const urls = http.calls.map((x) => `${x.method} ${x.url.replace("https://api.notion.com", "")}`);
  assert.deepEqual(urls, [
    `GET /v1/data_sources/${options.dataSourceId}`,
    "GET /v1/pages/p1/properties/J%3FMW",
    "GET /v1/pages/p1/properties/J%3FMW?start_cursor=next",
    "GET /v1/pages/p2/properties/J%3FMW",
    "GET /v1/pages/p2/properties/J%3FMW?start_cursor=next",
  ]);
});

test("setRelation replaces the page's whole relation, and is tried again after a passing failure", async () => {
  const a = "cb56bbf0-dc78-4886-8553-6285651b9f5d";
  const b = "595b6194-8d72-4785-8ce8-a4eb90e3e551";
  let failures = 1;
  const http = fakeHttp(() => (failures-- > 0 ? { status: 503, body: { object: "error", status: 503, code: "service_unavailable", message: "later" } } : { body: { object: "page", id: "p1" } }));
  const notion = createSdkGateway({ ...linksToOptions, fetch: http.fetch, sleep: async () => {} });
  await notion.setRelation("p1", [a, b]);
  assert.deepEqual(http.calls.map((x) => [x.method, x.url, x.body]), Array(2).fill(["PATCH", "https://api.notion.com/v1/pages/p1", { properties: { "Links to": { relation: [{ id: a }, { id: b }] } } }]));
  const refused = fakeHttp(() => ({ status: 400, body: { object: "error", status: 400, code: "validation_error", message: "nope" } }));
  await assert.rejects(createSdkGateway({ ...linksToOptions, fetch: refused.fetch }).setRelation("p1", []), NotionPageError);
});

test("relationTarget is the data source the property points to, or null when it is missing or not a relation", async () => {
  const http = fakeHttp(() => ({ body: relationSource("relation") }));
  assert.equal(await createSdkGateway({ ...linksToOptions, fetch: http.fetch }).relationTarget(), "575390a0-da37-450c-88eb-e8113c0af76d");
  const text = fakeHttp(() => ({ body: relationSource("rich_text") }));
  assert.equal(await createSdkGateway({ ...linksToOptions, fetch: text.fetch }).relationTarget(), null);
  const missing = fakeHttp(() => ({ body: { object: "data_source", id: "ds", properties: { Name: { id: "title", name: "Name", type: "title", title: {} } } } }));
  assert.equal(await createSdkGateway({ ...linksToOptions, fetch: missing.fetch }).relationTarget(), null);
  const unset = fakeHttp(() => ({ body: relationSource("relation") }));
  assert.equal(await createSdkGateway({ ...options, fetch: unset.fetch }).relationTarget(), null);
  assert.deepEqual(unset.calls, []);
});

// Image calls (spec §6): upload, list the page's image blocks, switch a block to the upload, download the signed URL.
interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Answers each request with `respond`, recording what was sent (a multipart body is kept as the FormData). */
function recorder(respond: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined;
    const request: Sent = { method: String(init?.method), url, headers: (init?.headers ?? {}) as Record<string, string>, body };
    sent.push(request);
    return respond(request);
  }) as unknown as SdkGatewayOptions["fetch"];
  return { sent, fetch };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("uploadFile creates a single-part upload with the content type of the extension, sends the bytes, and returns the upload id", async () => {
  const http = recorder((sent) => json({ object: "file_upload", id: "up-1", status: sent.url.endsWith("/send") ? "uploaded" : "pending" }));
  const notion = createSdkGateway({ ...options, fetch: http.fetch });
  assert.equal(await notion.uploadFile("Branch.JPG", Uint8Array.from([1, 2, 3])), "up-1");
  assert.deepEqual(
    http.sent.map((s) => [s.method, s.url]),
    [
      ["POST", "https://api.notion.com/v1/file_uploads"],
      ["POST", "https://api.notion.com/v1/file_uploads/up-1/send"],
    ],
  );
  assert.deepEqual(http.sent[0]!.body, { mode: "single_part", filename: "Branch.JPG", content_type: "image/jpeg" });
  const file = (http.sent[1]!.body as FormData).get("file") as File;
  assert.equal(file.name, "Branch.JPG");
  assert.equal(file.type, "image/jpeg");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), Uint8Array.from([1, 2, 3]));
});

test("uploadFile takes any file, each with the content type of its extension (octet-stream for an unknown one)", async () => {
  const http = recorder((sent) => json({ object: "file_upload", id: "up-1", status: sent.url.endsWith("/send") ? "uploaded" : "pending" }));
  const notion = createSdkGateway({ ...options, fetch: http.fetch });
  const cases = [
    ["Paper.PDF", "application/pdf"],
    ["song.mp3", "audio/mpeg"],
    ["rec.3gp", "audio/3gpp"],
    ["clip.mp4", "video/mp4"],
    ["memo.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["bundle.zip", "application/zip"],
    ["data.xyz", "application/octet-stream"],
    ["README", "application/octet-stream"],
  ] as const;
  for (const [name, type] of cases) {
    http.sent.length = 0;
    await notion.uploadFile(name, Uint8Array.from([1]));
    assert.deepEqual(http.sent[0]!.body, { mode: "single_part", filename: name, content_type: type }, name);
    assert.equal(((http.sent[1]!.body as FormData).get("file") as File).type, type, name);
  }
});

test("mediaBlocks lists the page's image blocks in document order, descending into blocks with children", async () => {
  const image = (id: string, source: { external: string } | { file: string }, caption: string, has_children = false) => ({
    object: "block",
    type: "image",
    id,
    has_children,
    image: {
      caption: caption ? [{ type: "text", plain_text: caption, text: { content: caption } }] : [],
      ..."external" in source ? { type: "external", external: { url: source.external } } : { type: "file", file: { url: source.file, expiry_time: "2026-11-03T05:00:00.000Z" } },
    },
  });
  const other = (id: string, type: string, has_children: boolean) => ({ object: "block", type, id, has_children, [type]: { rich_text: [] } });
  const pages: Record<string, { results: unknown[]; next?: string }> = {
    // the list item is the last block of the first page of results; its children come before the second page's block
    "page-1": { results: [other("b-text", "paragraph", false), image("b-ext", { external: "https://nopipeline.invalid/vault/a.png" }, "first"), other("b-item", "bulleted_list_item", true)], next: "more" },
    "page-1/more": { results: [image("b-hosted", { file: "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/key/b.png?X-Amz-Signature=s" }, "")] },
    "b-item": { results: [image("b-child", { external: "https://example.com/c.png" }, "in an item"), other("b-sub", "bulleted_list_item", true)] },
    "b-sub": { results: [image("b-deep", { external: "https://example.com/d.png" }, "deeper")] },
  };
  const http = recorder((sent) => {
    const url = new URL(sent.url);
    const block = url.pathname.split("/")[3]!;
    const cursor = url.searchParams.get("start_cursor");
    const answer = pages[cursor ? `${block}/${cursor}` : block]!;
    return json({ object: "list", results: answer.results, has_more: answer.next !== undefined, next_cursor: answer.next ?? null });
  });
  const blocks = await createSdkGateway({ ...options, fetch: http.fetch }).mediaBlocks("page-1");
  assert.deepEqual(blocks, [
    { id: "b-ext", kind: "image", external: "https://nopipeline.invalid/vault/a.png", hosted: null, caption: "first" },
    { id: "b-child", kind: "image", external: "https://example.com/c.png", hosted: null, caption: "in an item" },
    { id: "b-deep", kind: "image", external: "https://example.com/d.png", hosted: null, caption: "deeper" },
    { id: "b-hosted", kind: "image", external: null, hosted: "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/key/b.png?X-Amz-Signature=s", caption: "" },
  ]);
  assert.deepEqual(
    http.sent.map((s) => s.method + " " + s.url.replace("https://api.notion.com/v1/blocks/", "")),
    ["GET page-1/children?page_size=100", "GET page-1/children?start_cursor=more&page_size=100", "GET b-item/children?page_size=100", "GET b-sub/children?page_size=100"],
  );
});

test("mediaBlocks does not walk into child pages or child databases (their blocks are their own, and listing one may be refused)", async () => {
  const image = { object: "block", type: "image", id: "b-img", has_children: false, image: { caption: [], type: "external", external: { url: "https://example.com/a.png" } } };
  const child = (id: string, type: "child_page" | "child_database") => ({ object: "block", type, id, has_children: true, [type]: { title: "t" } });
  const http = recorder((sent) => {
    const block = new URL(sent.url).pathname.split("/")[3]!;
    if (block !== "page-1") return json({ object: "error", status: 400, code: "validation_error", message: `${block} is not a block to list` }, 400);
    return json({ object: "list", results: [child("b-page", "child_page"), image, child("b-db", "child_database")], has_more: false, next_cursor: null });
  });
  const blocks = await createSdkGateway({ ...options, fetch: http.fetch }).mediaBlocks("page-1");
  assert.deepEqual(blocks.map((b) => b.id), ["b-img"]);
  assert.deepEqual(http.sent.map((s) => s.url.replace("https://api.notion.com/v1/blocks/", "")), ["page-1/children?page_size=100"]);
});

test("attachFile sends the upload id alone, with no caption, under the block's own type", async () => {
  for (const kind of ["image", "pdf", "audio", "video", "file"] as const) {
    const http = recorder(() => json({ object: "block", id: "b-1", type: kind }));
    await createSdkGateway({ ...options, fetch: http.fetch }).attachFile("b-1", kind, "up-1");
    assert.deepEqual(http.sent.map((s) => [s.method, s.url, s.body]), [["PATCH", "https://api.notion.com/v1/blocks/b-1", { [kind]: { file_upload: { id: "up-1" } } }]], kind);
  }
});

test("mediaBlocks reads PDF, file, audio and video blocks, external or hosted, with their captions, inside list items too", async () => {
  const caption = (text: string) => (text ? [{ type: "text", plain_text: text, text: { content: text } }] : []);
  const HOSTED = "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/9d1f6a3c-0000-4000-8000-000000000001/doc.pdf?X-Amz-Signature=s";
  // pdf, audio and video: { type, external | file, caption }; a file block also has a name
  const external = (id: string, type: string, url: string, text: string) => ({ object: "block", type, id, has_children: false, [type]: { type: "external", external: { url }, caption: caption(text) } });
  const hosted = (id: string, type: string, url: string, text: string) => ({
    object: "block",
    type,
    id,
    has_children: false,
    [type]: { type: "file", file: { url, expiry_time: "2026-11-03T21:00:00.000Z" }, caption: caption(text), ...(type === "file" ? { name: "doc.pdf" } : {}) },
  });
  const item = { object: "block", type: "bulleted_list_item", id: "b-item", has_children: true, bulleted_list_item: { rich_text: [] } };
  const pages: Record<string, unknown[]> = {
    "page-1": [
      external("b-pdf", "pdf", "https://nopipeline.invalid/vault/a.pdf", "paper"),
      hosted("b-pdf-h", "pdf", HOSTED, ""),
      external("b-audio", "audio", "https://nopipeline.invalid/vault/s.mp3", "song"),
      hosted("b-video", "video", "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/9d1f6a3c-0000-4000-8000-000000000002/c.mp4?X-Amz-Signature=v", "clip"),
      item,
    ],
    "b-item": [external("b-file", "file", "https://nopipeline.invalid/vault/m.docx", "memo"), hosted("b-file-h", "file", "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/9d1f6a3c-0000-4000-8000-000000000003/m.docx?X-Amz-Signature=f", "")],
  };
  const http = recorder((sent) => json({ object: "list", results: pages[new URL(sent.url).pathname.split("/")[3]!], has_more: false, next_cursor: null }));
  const blocks = await createSdkGateway({ ...options, fetch: http.fetch }).mediaBlocks("page-1");
  assert.deepEqual(blocks, [
    { id: "b-pdf", kind: "pdf", external: "https://nopipeline.invalid/vault/a.pdf", hosted: null, caption: "paper" },
    { id: "b-pdf-h", kind: "pdf", external: null, hosted: HOSTED, caption: "" },
    { id: "b-audio", kind: "audio", external: "https://nopipeline.invalid/vault/s.mp3", hosted: null, caption: "song" },
    { id: "b-video", kind: "video", external: null, hosted: "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/9d1f6a3c-0000-4000-8000-000000000002/c.mp4?X-Amz-Signature=v", caption: "clip" },
    { id: "b-file", kind: "file", external: "https://nopipeline.invalid/vault/m.docx", hosted: null, caption: "memo" },
    { id: "b-file-h", kind: "file", external: null, hosted: "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/9d1f6a3c-0000-4000-8000-000000000003/m.docx?X-Amz-Signature=f", caption: "" },
  ]);
});

test("mediaBlocks reads a block that comes with no caption as having an empty one", async () => {
  const bare = { object: "block", type: "pdf", id: "b-bare", has_children: false, pdf: { type: "external", external: { url: "https://nopipeline.invalid/vault/a.pdf" } } };
  const http = recorder(() => json({ object: "list", results: [bare], has_more: false, next_cursor: null }));
  const blocks = await createSdkGateway({ ...options, fetch: http.fetch }).mediaBlocks("page-1");
  assert.deepEqual(blocks, [{ id: "b-bare", kind: "pdf", external: "https://nopipeline.invalid/vault/a.pdf", hosted: null, caption: "" }]);
});

test("download fetches the signed URL with no Authorization header and gives the bytes; a refusal is a download_failed NotionPageError", async () => {
  const signed = "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/key/a.png?X-Amz-Signature=s";
  const calls: { url: string; headers: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers });
    return url.includes("expired") ? new Response("<Error>", { status: 403 }) : new Response(Uint8Array.from([9, 8, 7]));
  }) as unknown as SdkGatewayOptions["fetch"];
  const notion = createSdkGateway({ ...options, fetch });
  assert.deepEqual(await notion.download(signed), Uint8Array.from([9, 8, 7]));
  assert.deepEqual(calls, [{ url: signed, headers: undefined }]);
  await assert.rejects(notion.download(`${signed}&expired=1`), (e: unknown) => e instanceof NotionPageError && e.code === "download_failed" && e.message.includes("403"));
});

/** A folder for one test, removed after it. */
async function scratch<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "nopipeline-gateway-"));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("downloadTo streams the file to the path and gives its sha256 and size; no Authorization goes with the request", async () => {
  const signed = "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/key/a.mp4?X-Amz-Signature=s";
  const chunks = [Uint8Array.from([1, 2, 3]), new Uint8Array(70_000).fill(7), Uint8Array.from([9])];
  const whole = Buffer.concat(chunks);
  const calls: { url: string; headers: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers });
    return new Response(new ReadableStream({ start(controller) { for (const c of chunks) controller.enqueue(c); controller.close(); } }));
  }) as unknown as SdkGatewayOptions["fetch"];
  await scratch(async (dir) => {
    const path = join(dir, "a.mp4");
    assert.deepEqual(await createSdkGateway({ ...options, fetch }).downloadTo(signed, path), { sha256: createHash("sha256").update(whole).digest("hex"), size: whole.length });
    assert.deepEqual(new Uint8Array(await readFile(path)), new Uint8Array(whole));
    assert.deepEqual(calls, [{ url: signed, headers: undefined }]);
  });
});

test("downloadTo of an empty file writes an empty file", async () => {
  const fetch = (async () => new Response(null)) as unknown as SdkGatewayOptions["fetch"];
  await scratch(async (dir) => {
    const path = join(dir, "empty.txt");
    assert.deepEqual(await createSdkGateway({ ...options, fetch }).downloadTo("https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/key/e.txt", path), {
      sha256: createHash("sha256").digest("hex"),
      size: 0,
    });
    assert.equal((await readFile(path)).length, 0);
  });
});

test("downloadTo refuses a path that exists and leaves that file as it is", async () => {
  const fetch = (async () => new Response(Uint8Array.from([1, 2, 3]))) as unknown as SdkGatewayOptions["fetch"];
  await scratch(async (dir) => {
    const path = join(dir, "taken.pdf");
    await writeFile(path, "mine");
    await assert.rejects(createSdkGateway({ ...options, fetch }).downloadTo("https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/key/a.pdf", path), (e: unknown) => (e as NodeJS.ErrnoException).code === "EEXIST");
    assert.equal(await readFile(path, "utf8"), "mine");
  });
});

test("downloadTo of a refused URL is a download_failed NotionPageError and leaves no file; a stream that breaks halfway leaves none either", async () => {
  const fetch = (async (url: string) => {
    if (url.includes("expired")) return new Response("<Error>", { status: 403 });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.from([1, 2])); controller.error(new Error("connection reset")); } }));
  }) as unknown as SdkGatewayOptions["fetch"];
  await scratch(async (dir) => {
    const notion = createSdkGateway({ ...options, fetch });
    await assert.rejects(notion.downloadTo("https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/key/a.pdf?expired=1", join(dir, "a.pdf")), (e: unknown) => e instanceof NotionPageError && e.code === "download_failed" && e.message.includes("403"));
    await assert.rejects(notion.downloadTo("https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/key/b.pdf", join(dir, "b.pdf")), /connection reset/);
    assert.deepEqual(await readdir(dir), []);
  });
});

// Projects (spec §7 live results 3, 4 and 5).

const SOURCE = "9af15f91-6806-40cc-8b99-91c7627acd6c";
const NOTES_SOURCE = (relation: unknown) => ({ object: "data_source", id: options.dataSourceId, properties: { Name: { id: "title", name: "Name", type: "title", title: {} }, ...(relation ? { Project: relation } : {}) } });
const PROJECTS_SOURCE = { object: "data_source", id: SOURCE, properties: { Archived: { id: "a", name: "Archived", type: "checkbox", checkbox: {} }, Title: { id: "title", name: "Title", type: "title", title: {} } } };
const RELATION = { id: "prj", name: "Project", type: "relation", relation: { data_source_id: SOURCE, type: "dual_property", dual_property: {} } };

test("listPages maps the projects relation, with more when the query cut it", async () => {
  const http = fakeHttp(() => ({
    body: {
      object: "list",
      results: [page("cb56bbf0-dc78-4886-8553-6285651b9f5d", "Elm", { ids: ["A0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000002"], more: true }), page("595b6194-8d72-4785-8ce8-a4eb90e3e551", "Oak", { ids: [] })],
      has_more: false,
      next_cursor: null,
    },
  }));
  const pages = await createSdkGateway({ ...PROJECTS, fetch: http.fetch }).listPages();
  assert.deepEqual(pages.map((p) => p.projects), [{ ids: ["a0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000002"], more: true }, { ids: [], more: false }]);
  assert.equal(pages.every((p) => p.folder === null), true);
});

test("listPages leaves projects out without a projects relation", async () => {
  const http = fakeHttp(() => ({ body: { object: "list", results: [page("cb56bbf0-dc78-4886-8553-6285651b9f5d", "Elm", { ids: [] })], has_more: false, next_cursor: null } }));
  const [first] = await createSdkGateway({ ...options, fetch: http.fetch }).listPages();
  assert.equal("projects" in first!, false);
});

test("setProjects sends the whole relation", async () => {
  const http = fakeHttp(() => ({ body: { object: "page", id: "p1" } }));
  const notion = createSdkGateway({ ...PROJECTS, fetch: http.fetch });
  await notion.setProjects("p1", ["x", "y"]);
  await notion.setProjects("p1", []);
  assert.deepEqual(http.calls.map((c) => [c.method, c.url, c.body]), [
    ["PATCH", "https://api.notion.com/v1/pages/p1", { properties: { Project: { relation: [{ id: "x" }, { id: "y" }] } } }],
    ["PATCH", "https://api.notion.com/v1/pages/p1", { properties: { Project: { relation: [] } } }],
  ]);
});

test("readProjects reads every entry of the relation, in order, past the 25 a query lists", async () => {
  const entry = (n: number) => ({ object: "property_item", type: "relation", id: `i${n}`, relation: { id: `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}` } });
  const http = fakeHttp((call) => {
    if (call.url.includes("/data_sources/")) return { body: call.url.endsWith(`/data_sources/${SOURCE}`) ? PROJECTS_SOURCE : NOTES_SOURCE(RELATION) };
    const second = call.url.includes("start_cursor=c2");
    return { body: { object: "list", type: "property_item", results: second ? [entry(29), entry(30)] : Array.from({ length: 28 }, (_, n) => entry(n + 1)), has_more: !second, next_cursor: second ? null : "c2", property_item: { id: "prj", type: "relation", next_url: null, relation: {} } } };
  });
  const ids = await createSdkGateway({ ...PROJECTS, fetch: http.fetch }).readProjects("p1");
  assert.equal(ids.length, 30);
  assert.equal(ids[0], "b0000000-0000-4000-8000-000000000001");
  assert.equal(ids[29], "b0000000-0000-4000-8000-000000000030");
  assert.deepEqual(http.calls.map((c) => c.url.replace("https://api.notion.com/v1", "")), [`/data_sources/${options.dataSourceId}`, `/data_sources/${SOURCE}`, "/pages/p1/properties/prj", "/pages/p1/properties/prj?start_cursor=c2"]);
});

test("projectsSource is null without a projects relation, and names the title property of the projects database", async () => {
  const none = fakeHttp(() => ({ body: {} }));
  assert.equal(await createSdkGateway({ ...options, fetch: none.fetch }).projectsSource(), null);
  assert.equal(none.calls.length, 0);
  const http = fakeHttp((call) => ({ body: call.url.endsWith(`/data_sources/${SOURCE}`) ? PROJECTS_SOURCE : NOTES_SOURCE(RELATION) }));
  assert.deepEqual(await createSdkGateway({ ...PROJECTS, fetch: http.fetch }).projectsSource(), { dataSourceId: SOURCE, titleProperty: "Title" });
});

test("projectsSource errors, naming the relation, when it is missing, not a relation, or its target can't be read", async () => {
  const unreadable = /"Project" relation/;
  const missing = fakeHttp(() => ({ body: NOTES_SOURCE(null) }));
  await assert.rejects(createSdkGateway({ ...PROJECTS, fetch: missing.fetch }).projectsSource(), (e: unknown) => e instanceof ProjectsUnreadable && unreadable.test(e.message) && /Connections/.test(e.message));
  const notRelation = fakeHttp(() => ({ body: NOTES_SOURCE({ id: "prj", name: "Project", type: "select", select: { options: [] } }) }));
  await assert.rejects(createSdkGateway({ ...PROJECTS, fetch: notRelation.fetch }).projectsSource(), (e: unknown) => e instanceof ProjectsUnreadable && /select, not a relation/.test(e.message));
  const hidden = fakeHttp((call) => (call.url.endsWith(`/data_sources/${SOURCE}`) ? { status: 404, body: { object: "error", status: 404, code: "object_not_found", message: "no" } } : { body: NOTES_SOURCE(RELATION) }));
  await assert.rejects(createSdkGateway({ ...PROJECTS, fetch: hidden.fetch }).projectsSource(), (e: unknown) => e instanceof ProjectsUnreadable && unreadable.test(e.message));
  const down = fakeHttp((call) => (call.url.endsWith(`/data_sources/${SOURCE}`) ? { status: 401, body: { object: "error", status: 401, code: "unauthorized", message: "no" } } : { body: NOTES_SOURCE(RELATION) }));
  await assert.rejects(createSdkGateway({ ...PROJECTS, fetch: down.fetch }).projectsSource(), (e: unknown) => !(e instanceof ProjectsUnreadable));
});

test("listProjects lists the live pages of the projects database", async () => {
  const project = (id: string, title: string, trashed = false) => ({ object: "page", id, url: `https://www.notion.so/${id.replace(/-/g, "")}`, in_trash: trashed, last_edited_time: "2026-09-27T04:00:00.000Z", properties: { Title: { id: "title", type: "title", title: [{ type: "text", plain_text: title, text: { content: title } }] } } });
  const http = fakeHttp((call) => {
    if (call.url.endsWith("/query")) return { body: { object: "list", results: [project("C0000000-0000-4000-8000-000000000001", "Astronomy"), project("c0000000-0000-4000-8000-000000000002", "Old", true)], has_more: false, next_cursor: null } };
    return { body: call.url.endsWith(`/data_sources/${SOURCE}`) ? PROJECTS_SOURCE : NOTES_SOURCE(RELATION) };
  });
  assert.deepEqual(await createSdkGateway({ ...PROJECTS, fetch: http.fetch }).listProjects(), [{ id: "c0000000-0000-4000-8000-000000000001", title: "Astronomy" }]);
  assert.equal(http.calls.at(-1)!.url, `https://api.notion.com/v1/data_sources/${SOURCE}/query`);
});

test("createProject asks for the default template only when the projects database lists one", async () => {
  const made = (templates: unknown[]) => {
    const http = fakeHttp((call) => {
      if (call.url.includes("/templates")) return { body: { object: "list", templates, has_more: false, next_cursor: null } };
      if (call.url.endsWith("/pages")) return { body: { object: "page", id: "D0000000000040008000000000000001" } };
      return { body: call.url.endsWith(`/data_sources/${SOURCE}`) ? PROJECTS_SOURCE : NOTES_SOURCE(RELATION) };
    });
    return { http, notion: createSdkGateway({ ...PROJECTS, fetch: http.fetch }) };
  };
  const withDefault = made([{ id: "t1", name: "Other", is_default: false }, { id: "t2", name: "Project", is_default: true }]);
  assert.equal(await withDefault.notion.createProject("Cooking"), "d0000000-0000-4000-8000-000000000001");
  assert.deepEqual(withDefault.http.calls.at(-1)!.body, { parent: { data_source_id: SOURCE }, properties: { Title: { title: [{ type: "text", text: { content: "Cooking" } }] } }, template: { type: "default" } });
  const without = made([{ id: "t1", name: "Other", is_default: false }]);
  await without.notion.createProject("Cooking");
  assert.deepEqual((without.http.calls.at(-1)!.body as { template: unknown }).template, { type: "none" });
  const none = made([]);
  await none.notion.createProject("Cooking");
  assert.deepEqual((none.http.calls.at(-1)!.body as { template: unknown }).template, { type: "none" });
  assert.equal("icon" in (none.http.calls.at(-1)!.body as object), false);
});

test("createProject is not tried again after a passing failure, renameProject is", async () => {
  const state = { creates: 0, renames: 0 };
  const http = fakeHttp((call) => {
    if (call.url.includes("/templates")) return { body: { object: "list", templates: [], has_more: false, next_cursor: null } };
    if (call.url.endsWith("/pages")) return (state.creates++, { status: 502, body: { object: "error", status: 502, code: "internal_server_error", message: "bad gateway" } });
    if (call.url.endsWith("/pages/p1")) return state.renames++ === 0 ? { status: 503, body: { object: "error", status: 503, code: "service_unavailable", message: "no" } } : { body: { object: "page", id: "p1" } };
    return { body: call.url.endsWith(`/data_sources/${SOURCE}`) ? PROJECTS_SOURCE : NOTES_SOURCE(RELATION) };
  });
  const notion = createSdkGateway({ ...PROJECTS, fetch: http.fetch, sleep: async () => {} });
  await assert.rejects(notion.createProject("Cooking"));
  assert.equal(state.creates, 1);
  await notion.renameProject("p1", "Cooking 2");
  assert.equal(state.renames, 2);
  assert.deepEqual(http.calls.at(-1)!.body, { properties: { Title: { title: [{ type: "text", text: { content: "Cooking 2" } }] } } });
});

test("listPages reads a row's tags only when tagsProperty names a multi-select", async () => {
  const row = (tags: unknown) => ({ ...page("cb56bbf0-dc78-4886-8553-6285651b9f5d", "A"), properties: { Name: page("x", "A").properties.Name, Tags: tags } });
  const select = { id: "t", type: "multi_select", multi_select: [{ id: "1", name: "alpha", color: "red" }, { id: "2", name: "Beta", color: "blue" }] };
  const answer = (tags: unknown) => fakeHttp(() => ({ body: { object: "list", results: [row(tags)], has_more: false, next_cursor: null } }));
  const tagged = { ...options, tagsProperty: "Tags" };
  assert.deepEqual((await createSdkGateway({ ...tagged, fetch: answer(select).fetch }).listPages())[0]!.tags, ["alpha", "Beta"]);
  assert.deepEqual((await createSdkGateway({ ...tagged, fetch: answer({ ...select, multi_select: [] }).fetch }).listPages())[0]!.tags, []);
  assert.equal("tags" in (await createSdkGateway({ ...tagged, fetch: answer({ id: "t", type: "rich_text", rich_text: [] }).fetch }).listPages())[0]!, false);
  assert.equal("tags" in (await createSdkGateway({ ...options, fetch: answer(select).fetch }).listPages())[0]!, false);
});

test("setTags replaces the page's tags by name, is tried again after a passing failure, and needs tagsProperty", async () => {
  let failures = 1;
  const http = fakeHttp(() => (failures-- > 0 ? { status: 503, body: { object: "error", status: 503, code: "service_unavailable", message: "later" } } : { body: { object: "page", id: "p1" } }));
  await createSdkGateway({ ...options, tagsProperty: "Tags", fetch: http.fetch, sleep: async () => {} }).setTags("p1", ["a", "B"]);
  assert.deepEqual(http.calls.map((x) => [x.method, x.url, x.body]), Array(2).fill(["PATCH", "https://api.notion.com/v1/pages/p1", { properties: { Tags: { multi_select: [{ name: "a" }, { name: "B" }] } } }]));
  await assert.rejects(createSdkGateway({ ...options, fetch: http.fetch }).setTags("p1", []), /no tags property/);
});

// Notion cuts a page at about 20,000 blocks: the markdown holds a tag line per left-out block, and
// `unknown_block_ids` lists them (probe 2026-11-06). Asking for a block's id as `page_id` gives its subtree.
const PAGE_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const BLOCK = (n: number) => `5d6e7f80-a1b2-4c3d-9e4f-${String(n).padStart(12, "0")}`;
const tag = (block: string, indent = "") => `${indent}<unknown url="https://app.notion.com/p/${PAGE_ID.replace(/-/g, "")}#${block.replace(/-/g, "")}"/>`;
type RawPage = { markdown: string; truncated?: boolean; unknown?: string[] };
function cutPages(pages: Record<string, RawPage | "gone" | "error">) {
  return fakeHttp((call) => {
    const asked = call.url.split("/pages/")[1]!.split("/")[0]!;
    const raw = pages[asked];
    if (raw === "gone") return { status: 404, body: { object: "error", status: 404, code: "object_not_found", message: "no" } };
    if (raw === "error" || raw === undefined) return { status: 400, body: { object: "error", status: 400, code: "validation_error", message: "no" } };
    return { body: { object: "page_markdown", id: asked, markdown: raw.markdown, truncated: raw.truncated ?? false, unknown_block_ids: raw.unknown ?? [] } };
  });
}
const read = (http: ReturnType<typeof fakeHttp>) => createSdkGateway({ ...options, fetch: http.fetch }).getMarkdown(PAGE_ID);

test("a cut page is completed with the blocks Notion left out, each at the tag line's depth", async () => {
  const [a, b] = [BLOCK(1), BLOCK(2)];
  const http = cutPages({
    [PAGE_ID]: { markdown: `p0\n${tag(a)}\n- item\n${tag(b, "\t")}`, truncated: true, unknown: [a, b] },
    [a]: { markdown: "p1" },
    [b]: { markdown: "- child" },
  });
  assert.deepEqual(await read(http), { markdown: "p0\np1\n- item\n\t- child", truncated: false, pieced: true, loaded: `p0\n${tag(a)}\n- item\n${tag(b, "\t")}` });
});

test("a subtree is put back at the depth of its tag line, line by line", async () => {
  const a = BLOCK(1);
  const http = cutPages({ [PAGE_ID]: { markdown: `- x\n${tag(a, "\t")}`, truncated: true, unknown: [a] }, [a]: { markdown: "- one\n\t- two\n\n- three" } });
  assert.deepEqual(await read(http), { markdown: "- x\n\t- one\n\t\t- two\n\n\t- three", truncated: false, pieced: true, loaded: `- x\n${tag(a, "\t")}` });
});

test("a subtree that is itself cut is completed, three levels deep; a fourth level gives up", async () => {
  const [a, b, c, d] = [BLOCK(1), BLOCK(2), BLOCK(3), BLOCK(4)];
  const chain = (last: RawPage): Record<string, RawPage> => ({
    [PAGE_ID]: { markdown: `top\n${tag(a)}`, truncated: true, unknown: [a] },
    [a]: { markdown: `- a\n\t${tag(b)}`, truncated: true, unknown: [b] },
    [b]: { markdown: `- b\n\t${tag(c)}`, truncated: true, unknown: [c] },
    [c]: last,
  });
  assert.deepEqual(await read(cutPages(chain({ markdown: "- c" }))), { markdown: "top\n- a\n\t- b\n\t\t- c", truncated: false, pieced: true, loaded: `top\n${tag(a)}` });
  const fourth = await read(cutPages({ ...chain({ markdown: `- c\n\t${tag(d)}`, truncated: true, unknown: [d] }), [d]: { markdown: "- d" } }));
  assert.equal(fourth.truncated, true);
  assert.equal("pieced" in fourth, false);
});

test("a left-out block that can't be fetched leaves the page truncated, as Notion gave it", async () => {
  const [a, b] = [BLOCK(1), BLOCK(2)];
  const markdown = `p0\n${tag(a)}\n- item\n${tag(b, "\t")}`;
  for (const missing of ["gone", "error"] as const) {
    const result = await read(cutPages({ [PAGE_ID]: { markdown, truncated: true, unknown: [a, b] }, [a]: { markdown: "p1" }, [b]: missing }));
    assert.deepEqual(result, { markdown, truncated: true }, missing);
  }
});

test("an id with no tag line, or a cut page that lists no ids, stays truncated", async () => {
  const [a, b] = [BLOCK(1), BLOCK(2)];
  const markdown = `p0\n${tag(a)}`;
  assert.deepEqual(await read(cutPages({ [PAGE_ID]: { markdown, truncated: true, unknown: [a, b] }, [a]: { markdown: "p1" }, [b]: { markdown: "p2" } })), { markdown, truncated: true });
  assert.deepEqual(await read(cutPages({ [PAGE_ID]: { markdown: "p0", truncated: true } })), { markdown: "p0", truncated: true });
});

test("an unknown tag whose id Notion doesn't list stays as it is; ids match without hyphens and in any case", async () => {
  const [a, c] = [BLOCK(1), BLOCK(3)];
  const embed = `<unknown url="https://app.notion.com/p/${PAGE_ID.replace(/-/g, "")}#${c.replace(/-/g, "")}" alt="embed"/>`;
  const http = cutPages({
    [PAGE_ID]: { markdown: `${tag(a).replace(a.replace(/-/g, ""), a.replace(/-/g, "").toUpperCase())}\n${embed}`, truncated: true, unknown: [a] },
    [a]: { markdown: `p1\n${embed}` },
  });
  assert.deepEqual(await read(http), { markdown: `p1\n${embed}\n${embed}`, truncated: false, pieced: true, loaded: `${tag(a).replace(a.replace(/-/g, ""), a.replace(/-/g, "").toUpperCase())}\n${embed}` });
});

test("an uncut page is returned as it is, with no pieced key and no extra request", async () => {
  const http = cutPages({ [PAGE_ID]: { markdown: "plain\n<unknown url=\"https://app.notion.com/p/x#y\" alt=\"embed\"/>" } });
  const result = await read(http);
  assert.deepEqual(result, { markdown: "plain\n<unknown url=\"https://app.notion.com/p/x#y\" alt=\"embed\"/>", truncated: false });
  assert.equal("pieced" in result, false);
  assert.equal(http.calls.length, 1);
});

test("only a refusal for this page gives up on piecing; a failure that should end the run is thrown", async () => {
  const a = BLOCK(1);
  const markdown = `p0\n${tag(a)}`;
  const failing = (answerBlock: (call: Call) => { status?: number; body: unknown }) => {
    const http = fakeHttp((call) => (call.url.includes(`/pages/${PAGE_ID}/`) ? { body: { object: "page_markdown", id: PAGE_ID, markdown, truncated: true, unknown_block_ids: [a] } } : answerBlock(call)));
    return createSdkGateway({ ...options, sleep: async () => {}, fetch: http.fetch }).getMarkdown(PAGE_ID);
  };
  const refusal = (status: number, code: string) => () => ({ status, body: { object: "error", status, code, message: "no" } });
  await assert.rejects(failing(refusal(401, "unauthorized")), /no/);
  await assert.rejects(failing(refusal(500, "internal_server_error")), /no/);
  await assert.rejects(failing(() => { throw new TypeError("fetch failed"); }), /fetch failed/);
  for (const [status, code] of [[404, "object_not_found"], [403, "restricted_resource"], [400, "validation_error"]] as const) {
    assert.deepEqual(await failing(refusal(status, code)), { markdown, truncated: true }, code);
  }
});
