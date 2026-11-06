// Checks what the Notion API really does with the markdown this project sends, and records fixtures.
// Usage: NOTION_TOKEN=... node scripts/probe.ts <scratch data source id>
// Only ever point it at a scratch database: it creates pages there and moves them to the trash at the end.
import { Client, LogLevel, isFullBlock, iteratePaginatedAPI } from "@notionhq/client";
import { mkdir, writeFile } from "node:fs/promises";
import { normalizeId } from "../src/notion/ids.ts";

const dataSourceId = normalizeId(process.argv[2] ?? "");
const token = process.env.NOTION_TOKEN;
if (!dataSourceId || !token) {
  console.error("usage: NOTION_TOKEN=... node scripts/probe.ts <scratch data source id>");
  process.exit(2);
}

const client = new Client({ auth: token, notionVersion: "2026-03-11", logLevel: LogLevel.ERROR });
const FIXTURES = "test/fixtures/notion";
const created: string[] = [];
const results: Record<string, unknown> = {};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function newPage(title: string, markdown: string, folder?: string): Promise<string> {
  const page = await client.pages.create({
    parent: { data_source_id: dataSourceId! },
    properties: {
      Name: { title: [{ type: "text", text: { content: title } }] },
      ...(folder ? { Folder: { select: { name: folder } } } : {}),
    },
    markdown,
    template: { type: "none" },
  });
  created.push(page.id);
  return page.id;
}
const read = async (id: string) => (await client.pages.retrieveMarkdown({ page_id: id })).markdown;
async function blocks(id: string): Promise<{ id: string; type: string }[]> {
  const out: { id: string; type: string }[] = [];
  for await (const block of iteratePaginatedAPI(client.blocks.children.list, { block_id: id })) {
    if (isFullBlock(block)) out.push({ id: block.id, type: block.type });
  }
  return out;
}

try {
  await mkdir(FIXTURES, { recursive: true });

  // 7 first, because later pages use the Folder property.
  const source = await client.dataSources.retrieve({ data_source_id: dataSourceId });
  results.folderPropertyExisted = "Folder" in source.properties;
  if (!results.folderPropertyExisted) {
    await client.dataSources.update({ data_source_id: dataSourceId, properties: { Folder: { select: { options: [] } } } });
  }
  const withProps = await newPage("probe: properties + markdown", "created with **markdown**", "Probe/Folder");
  results.createWithPropertiesAndMarkdown = await read(withProps);

  // 1. Do block ids survive update_content and replace_content?
  const ids = await newPage("probe: block ids", "Alpha\nBravo\nCharlie");
  const before = (await blocks(ids)).map((b) => b.id);
  await client.pages.updateMarkdown({ page_id: ids, type: "update_content", update_content: { content_updates: [{ old_str: "Charlie", new_str: "Charlie edited" }] } });
  const afterUpdate = (await blocks(ids)).map((b) => b.id);
  await client.pages.updateMarkdown({ page_id: ids, type: "replace_content", replace_content: { new_str: "Alpha\nInserted\nBravo\nCharlie edited again" } });
  const afterReplace = (await blocks(ids)).map((b) => b.id);
  results.blockIds = {
    before,
    afterUpdate,
    afterReplace,
    keptByUpdateContent: before.every((id) => afterUpdate.includes(id)),
    keptByReplaceContent: before.every((id) => afterReplace.includes(id)),
  };

  // 2 and 3. How mentions and links to other pages come back.
  const target = await newPage("probe: link target", "target");
  const url = `https://www.notion.so/${target.replace(/-/g, "")}`;
  const mentions = await newPage(
    "probe: mentions",
    [`<mention-page url="${url}">probe: link target</mention-page>`, `[custom wording](${url})`, `<mention-page url="${url}">custom wording in a mention</mention-page>`].join("\n"),
  );
  results.mentions = await read(mentions);
  await writeFile(`${FIXTURES}/mentions.md`, results.mentions as string);

  // 4. Every construct the translator writes, as sent and as returned.
  const constructs: Record<string, string> = {
    "table-pipe": "| a | b |\n| --- | --- |\n| 1 | 2 |",
    "table-xml": '<table header-row="true">\n\t<tr>\n\t\t<td>a</td>\n\t\t<td>b</td>\n\t</tr>\n\t<tr>\n\t\t<td>1</td>\n\t\t<td>2</td>\n\t</tr>\n</table>',
    callout: '<callout icon="⚠️">\n\t**Careful**\n\tBody text\n</callout>',
    toggle: "<details>\n<summary>Show more</summary>\n\tHidden text\n</details>",
    columns: "<columns>\n\t<column>\n\t\tLeft\n\t</column>\n\t<column>\n\t\tRight\n\t</column>\n</columns>",
    math: "$$\nx^2 + y^2\n$$\nInline $a = b$ math",
    highlight: '<span color="yellow_bg">marked</span> text',
    escapes: "a \\< b \\> c \\{x\\} \\| y \\^ z \\[1\\] \\$5 \\* \\~ \\` C:\\\\Users",
    headings: "# One\n#### Four\n##### Five",
    lists: "- one\n\t- two\n\t\t- three\n1. first\n2. second\n- [ ] todo\n- [x] done",
    code: "```js\nconst a = [1] | 2 < 3;\n```",
    breaks: "line one<br>line two",
    empty: "above\n<empty-block/>\nbelow",
    literal: "\\[\\[Not a link\\]\\] and !\\[\\[embed\\]\\]",
    obsidian: "[📎 image.png](obsidian://open?vault=DemoVault&file=image.png)",
  };
  const constructResults: Record<string, { sent: string; got?: string; error?: string }> = {};
  for (const [name, markdown] of Object.entries(constructs)) {
    try {
      const got = await read(await newPage(`probe: ${name}`, markdown));
      constructResults[name] = { sent: markdown, got };
      await writeFile(`${FIXTURES}/${name}.md`, got);
    } catch (error) {
      constructResults[name] = { sent: markdown, error: message(error) };
    }
  }
  results.constructs = constructResults;

  // 5. A block the markdown API can't express (a bookmark), and an edit that sends its tag back.
  const unknown = await newPage("probe: unknown", "before\nafter");
  const first = (await blocks(unknown))[0]!.id;
  await client.blocks.children.append({ block_id: unknown, children: [{ type: "bookmark", bookmark: { url: "https://example.com" } }], position: { type: "after_block", after_block: { id: first } } });
  const withBookmark = await read(unknown);
  await writeFile(`${FIXTURES}/unknown.md`, withBookmark);
  const tag = /<unknown[^>]*\/>/.exec(withBookmark)?.[0] ?? null;
  const unknownResult: Record<string, unknown> = { markdown: withBookmark, tag };
  if (tag) {
    try {
      await client.pages.updateMarkdown({ page_id: unknown, type: "update_content", update_content: { content_updates: [{ old_str: `${tag}\nafter`, new_str: `${tag}\nafter, edited` }] } });
    } catch (error) {
      unknownResult.updateError = message(error);
    }
    unknownResult.after = await read(unknown);
    unknownResult.bookmarkSurvives = (await blocks(unknown)).some((b) => b.type === "bookmark");
  }
  results.unknown = unknownResult;

  // 6. last_edited_time granularity.
  const page = (await client.pages.retrieve({ page_id: ids })) as { last_edited_time?: string };
  results.lastEditedTime = page.last_edited_time ?? null;

  // 8. Is an update_content batch all-or-nothing?
  const batch = await newPage("probe: batch", "one\ntwo");
  let batchError: string | null = null;
  try {
    await client.pages.updateMarkdown({ page_id: batch, type: "update_content", update_content: { content_updates: [{ old_str: "one", new_str: "ONE" }, { old_str: "missing", new_str: "x" }] } });
  } catch (error) {
    batchError = message(error);
  }
  results.batch = { error: batchError, after: await read(batch) };

  await writeFile(`${FIXTURES}/probe-results.json`, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
} finally {
  for (const id of created) await client.pages.update({ page_id: id, in_trash: true }).catch(() => {});
}
