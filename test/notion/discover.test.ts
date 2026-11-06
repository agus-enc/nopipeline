import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiscovery } from "../../src/notion/discover.ts";

const DS = "575390a0-da37-450c-88eb-e8113c0af76d";

function http(answer: (method: string, url: URL) => unknown) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname, body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(answer(method, url)), { status: 200, headers: { "content-type": "application/json" } });
  }) as never;
  return { fetch, calls };
}

test("discovery reads only: search pages through data sources, schema, templates, who", async () => {
  const { fetch, calls } = http((method, url) => {
    if (url.pathname === "/v1/users/me") return { object: "user", id: "u", type: "bot", name: "Sync bot" };
    if (url.pathname === "/v1/search") {
      return url.searchParams.size === 0 && !calls.some((c) => c.body && (c.body as { start_cursor?: string }).start_cursor)
        ? { object: "list", results: [{ object: "data_source", id: DS, title: [{ plain_text: "Notes" }] }], has_more: true, next_cursor: "c2" }
        : { object: "list", results: [{ object: "data_source", id: "8fc1b8399ac34c698b79577cfc230df5", title: [] }], has_more: false, next_cursor: null };
    }
    if (url.pathname.endsWith("/templates")) return { object: "list", templates: [{ id: "t", name: "N", is_default: true }], has_more: false, next_cursor: null };
    return {
      object: "data_source",
      id: DS,
      title: [{ plain_text: "Notes" }],
      properties: { Name: { id: "title", name: "Name", type: "title", title: {} }, Up: { id: "r", name: "Up", type: "relation", relation: { data_source_id: DS.replaceAll("-", ""), type: "single_property", single_property: {} } } },
    };
  });
  const discovery = createDiscovery("secret_x", fetch, async () => {});
  assert.equal(await discovery.whoAmI(), "Sync bot");
  assert.deepEqual(await discovery.dataSources(), [{ id: DS, title: "Notes" }, { id: "8fc1b839-9ac3-4c69-8b79-577cfc230df5", title: "(untitled)" }]);
  assert.deepEqual(await discovery.schema(DS), { title: "Notes", properties: { Name: { type: "title" }, Up: { type: "relation", target: DS } } });
  assert.equal(await discovery.hasDefaultTemplate(DS), true);
  const search = calls.find((c) => c.url === "/v1/search")!;
  assert.deepEqual((search.body as { filter: unknown }).filter, { property: "object", value: "data_source" });
  // Every request is a read: GETs, and the search (a POST that changes nothing).
  assert.ok(calls.every((c) => c.method === "GET" || c.url === "/v1/search"), JSON.stringify(calls.map((c) => [c.method, c.url])));
});

test("P9: the second search call carries the cursor of the first and the page size", async () => {
  const { fetch, calls } = http((_method, url) => {
    if (url.pathname !== "/v1/search") return {};
    const cursor = (calls[calls.length - 1]!.body as { start_cursor?: string }).start_cursor;
    return cursor === undefined
      ? { object: "list", results: [{ object: "data_source", id: DS, title: [{ plain_text: "One" }] }], has_more: true, next_cursor: "c2" }
      : { object: "list", results: [{ object: "data_source", id: "8fc1b8399ac34c698b79577cfc230df5", title: [{ plain_text: "Two" }] }], has_more: false, next_cursor: null };
  });
  const found = await createDiscovery("secret_x", fetch, async () => {}).dataSources();
  assert.deepEqual(found.map((d) => d.title), ["One", "Two"]);
  const bodies = calls.map((c) => c.body as { page_size?: number; start_cursor?: string });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies.map((b) => b.page_size), [100, 100]);
  assert.equal(bodies[0]!.start_cursor, undefined);
  assert.equal(bodies[1]!.start_cursor, "c2");
});

test("P9: a 502 is tried again after a pause and then succeeds; a 401 is not tried again", async () => {
  let attempts = 0;
  const slept: number[] = [];
  const flaky = (async () => {
    attempts++;
    return attempts === 1
      ? new Response(JSON.stringify({ object: "error", status: 502, code: "bad_gateway", message: "bad gateway" }), { status: 502, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ object: "user", id: "u", type: "bot", name: "Sync bot" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as never;
  assert.equal(await createDiscovery("secret_x", flaky, async (ms) => void slept.push(ms)).whoAmI(), "Sync bot");
  assert.equal(attempts, 2);
  assert.equal(slept.length, 1);
  attempts = 0;
  const denied = (async () => {
    attempts++;
    return new Response(JSON.stringify({ object: "error", status: 401, code: "unauthorized", message: "no" }), { status: 401, headers: { "content-type": "application/json" } });
  }) as never;
  await assert.rejects(createDiscovery("secret_x", denied, async () => {}).whoAmI());
  assert.equal(attempts, 1);
});
