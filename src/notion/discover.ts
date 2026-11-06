// What the setup reads from Notion: who the connection is, which databases it can see, and what they look like. It has no write methods.
import { Client, LogLevel } from "@notionhq/client";
import { NOTION_VERSION, retrying } from "./gateway.ts";
import { normalizeId } from "./ids.ts";

export interface Discovery {
  /** The connection's name (the token is checked by asking Notion who it is). */
  whoAmI(): Promise<string>;
  /** Every database (data source) the connection can see, with its id (dashed) and title. */
  dataSources(): Promise<{ id: string; title: string }[]>;
  /** A database's title and properties: type and, for a relation, the data source it points to (dashed id). */
  schema(id: string): Promise<{ title: string; properties: Record<string, { type: string; target?: string }> }>;
  /** Whether new pages of the database can start from a default template. */
  hasDefaultTemplate(id: string): Promise<boolean>;
}

type ClientOptions = NonNullable<ConstructorParameters<typeof Client>[0]>;

const plain = (title: { plain_text: string }[] | undefined) => (title ?? []).map((part) => part.plain_text).join("").trim();

/** Reads only: users.me, search, dataSources.retrieve and dataSources.listTemplates. */
export function createDiscovery(token: string, fetch?: ClientOptions["fetch"], sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Discovery {
  const client = new Client({ auth: token, notionVersion: NOTION_VERSION, logLevel: LogLevel.ERROR, ...(fetch ? { fetch } : {}) });
  const again = <T>(call: () => Promise<T>) => retrying(call, sleep);
  return {
    async whoAmI() {
      const me = await again(() => client.users.me({}));
      return me.name ?? "your connection";
    },
    async dataSources() {
      const found: { id: string; title: string }[] = [];
      for (let cursor: string | undefined; ; ) {
        const from = cursor;
        const page = await again(() => client.search({ filter: { property: "object", value: "data_source" }, page_size: 100, ...(from ? { start_cursor: from } : {}) }));
        for (const result of page.results) {
          const id = normalizeId(result.id);
          if (id === null) continue;
          const title = "title" in result && Array.isArray(result.title) ? plain(result.title as { plain_text: string }[]) : "";
          found.push({ id, title: title || "(untitled)" });
        }
        if (!page.has_more || !page.next_cursor) return found;
        cursor = page.next_cursor;
      }
    },
    async schema(id) {
      const source = await again(() => client.dataSources.retrieve({ data_source_id: id }));
      const properties: Record<string, { type: string; target?: string }> = {};
      for (const [name, property] of Object.entries(source.properties)) {
        properties[name] = property.type === "relation" ? { type: "relation", target: normalizeId(property.relation.data_source_id) ?? property.relation.data_source_id } : { type: property.type };
      }
      return { title: plain("title" in source ? (source.title as { plain_text: string }[]) : undefined) || "(untitled)", properties };
    },
    async hasDefaultTemplate(id) {
      for (let cursor: string | undefined; ; ) {
        const from = cursor;
        const list = await again(() => client.dataSources.listTemplates({ data_source_id: id, ...(from ? { start_cursor: from } : {}) }));
        if (list.templates.some((template) => template.is_default)) return true;
        if (!list.has_more || !list.next_cursor) return false;
        cursor = list.next_cursor;
      }
    },
  };
}
