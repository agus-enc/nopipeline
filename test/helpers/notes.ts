// Notes and pages for property tests: the forms each app writes, and one-line edits in either app.
import fc from "fast-check";

const word = fc.constantFrom("alpha", "beta", "gamma", "i", "1", "x", "print", "loop", "zeta", "end");
const words = fc.array(word, { minLength: 1, maxLength: 3 }).map((w) => w.join(" "));
const codeLine = fc
  .tuple(fc.constantFrom("i = 0", "i += 1", "print(i)", "while i < 3:", "i", "1", "x = i + 1", "return i", ""), fc.boolean())
  .map(([line, deep]) => (line && deep ? `    ${line}` : line));
const codeBody = fc.array(codeLine, { minLength: 1, maxLength: 4 });

/** Blocks of a note like a typical vault's: paragraphs, lists, headings, quotes, code blocks, and code blocks inside quotes. */
const sampleBlock = fc.oneof(
  fc.array(words, { minLength: 1, maxLength: 2 }),
  fc.tuple(fc.constantFrom("-", "*", "1."), fc.array(words, { minLength: 1, maxLength: 3 })).map(([bullet, items]) => items.map((item) => `${bullet} ${item}`)),
  fc.tuple(fc.integer({ min: 1, max: 3 }), words).map(([level, text]) => [`${"#".repeat(level)} ${text}`]),
  fc.array(words, { minLength: 1, maxLength: 2 }).map((lines) => lines.map((line) => `> ${line}`)),
  fc.tuple(fc.constantFrom("python", ""), codeBody).map(([lang, body]) => [`> \`\`\`${lang}`, ...body.map((line) => (line ? `> ${line}` : ">")), "> ```"]),
  fc.tuple(fc.constantFrom("python", ""), codeBody).map(([lang, body]) => [`> \`\`\`${lang}`, ...body.map((line) => (line ? `> ${line}` : ">")), "> ```"]),
  codeBody.map((body) => ["```python", ...body, "```"]),
);

/** Blocks whose lines the translator writes as more lines, or fewer: one-line formulas, `~~~` fences, setext headings, `<br>`, tables, callouts. */
const reshapedBlock = fc.oneof(
  fc.constantFrom("x^2", "i + 1", "E = mc^2").map((formula) => [`$$ ${formula} $$`]),
  codeBody.map((body) => ["~~~", ...body, "~~~"]),
  fc.tuple(words, fc.constantFrom("===", "---")).map(([text, underline]) => [text, underline]),
  fc.tuple(words, words).map(([a, b]) => [`${a}<br>${b}`]),
  fc.tuple(word, word).map(([a, b]) => ["| a | b |", "| --- | --- |", `| ${a} | ${b} |`]),
  fc.tuple(word, words).map(([title, text]) => [`> [!note] ${title}`, `> ${text}`]),
  fc.constantFrom("x^2", "i + 1").map((formula) => ["$$", formula, "$$"]),
);

const note = (block: fc.Arbitrary<string[]>) => fc.array(block, { minLength: 2, maxLength: 7 }).map((blocks) => `${blocks.map((b) => b.join("\n")).join("\n\n")}\n`);
/** A note like a typical vault's, with code blocks inside quotes. */
export const sampleNote = note(sampleBlock);
/** A note that also holds the forms the translator writes as more lines or fewer. */
export const reshapedNote = note(fc.oneof(sampleBlock, reshapedBlock));

const DATES = ["2026-09-01", "2026-09-02"];
const pageLine = (tab: string) =>
  fc.oneof(
    words.map((text) => `${tab}${text}`),
    fc.tuple(fc.constantFrom(...DATES), words).map(([date, text]) => `${tab}<mention-date start="${date}"/> ${text}`),
    fc.tuple(words, fc.constantFrom("a1", "b2")).map(([text, user]) => `${tab}${text} <mention-user url="user://${user}"/>`),
    fc.tuple(words, fc.constantFrom("red", "blue")).map(([text, color]) => `${tab}${text} {color="${color}"}`),
    words.map((text) => `${tab}- ${text}`),
    fc.tuple(fc.constantFrom(...DATES), words).map(([date, text]) => `${tab}- <mention-date start="${date}"/> ${text}`),
  );
const pageBlock = fc.oneof(
  { arbitrary: pageLine("").map((line) => [line]), weight: 4 },
  { arbitrary: fc.constant(["<empty-block/>"]), weight: 1 },
  { arbitrary: fc.constant(["<table_of_contents/>"]), weight: 1 },
  {
    arbitrary: fc.tuple(pageLine("\t\t"), pageLine("\t\t"), pageLine("\t\t")).map(([a, b, c]) => ["<columns>", "\t<column>", a, b, "\t</column>", "\t<column>", c, "\t</column>", "</columns>"]),
    weight: 1,
  },
  { arbitrary: fc.tuple(words, pageLine("\t")).map(([title, child]) => [`## ${title} {toggle="true"}`, child]), weight: 2 },
  { arbitrary: pageLine("\t").map((child) => ['<callout icon="🚀">', child, "</callout>"]), weight: 2 },
  {
    arbitrary: fc.tuple(fc.constantFrom("video", "audio", "file", "pdf"), fc.nat(9), word).map(([tag, n, caption]) => [`<${tag} src="https://example.com/${n}">${caption}</${tag}>`]),
    weight: 1,
  },
);
/** A page written in Notion: date and person mentions, colors, empty blocks, a table of contents, columns, toggle headings, callouts with their own icon, files. */
export const notionPage = fc.array(pageBlock, { minLength: 3, maxLength: 10 }).map((blocks) => blocks.flat().join("\n"));

export type EditKind = "edit" | "insert" | "delete";
export const edit = fc.record({ at: fc.nat(), kind: fc.constantFrom<EditKind>("edit", "insert", "delete") });

/** Lines of Notion markdown an edit in Notion can touch: text and code lines, not tags, fences or `$$` lines. */
function notionContent(lines: string[]): number[] {
  const out: number[] = [];
  let fence: string | null = null;
  lines.forEach((raw, k) => {
    const line = raw.replace(/^\t+/, "").trim();
    if (fence !== null) {
      if (line === fence) fence = null;
      else out.push(k);
      return;
    }
    const open = /^(`{3,})[^`]*$/.exec(line);
    if (open) fence = open[1]!;
    else if (line !== "" && line !== "$$" && !/^<\/?[a-z_-]+(\s[^>]*)?\/?>$/.test(line)) out.push(k);
  });
  return out;
}

/** Notion markdown after one edit made in Notion: a content line changed, a line inserted after it, or the line deleted. */
export function inNotion(markdown: string, { at, kind }: { at: number; kind: EditKind }): string | null {
  const lines = markdown.split("\n");
  const content = notionContent(lines);
  if (content.length === 0) return null;
  const k = content[at % content.length]!;
  const tabs = /^\t*/.exec(lines[k]!)![0];
  if (kind === "edit") {
    const m = /^(.*?)((?:<\/[a-z]+>)?)([ \t]*\{(?:[a-z_-]+="[^"]*"[ \t]*)+\})?$/.exec(lines[k]!)!;
    return [...lines.slice(0, k), `${m[1]} zq${m[2]}${m[3] ?? ""}`, ...lines.slice(k + 1)].join("\n");
  }
  if (kind === "insert") return [...lines.slice(0, k + 1), `${tabs}zq new`, ...lines.slice(k + 1)].join("\n");
  const next = lines[k + 1];
  if (next !== undefined && /^\t*/.exec(next)![0].length > tabs.length && !/^\t*<\//.test(next)) return null;
  return [...lines.slice(0, k), ...lines.slice(k + 1)].join("\n");
}

/** A note after one edit made in Obsidian: a line changed, a line added after it in the same block, or the line deleted. */
export function inObsidian(body: string, { at, kind }: { at: number; kind: EditKind }): string | null {
  const lines = body.split("\n");
  const content = lines.flatMap((line, k) => (line.trim() === "" || /^\s*(```|~~~|\$\$)/.test(line) ? [] : [k]));
  if (content.length === 0) return null;
  const k = content[at % content.length]!;
  const line = lines[k]!;
  if (kind === "edit") return [...lines.slice(0, k), `${line} zq`, ...lines.slice(k + 1)].join("\n");
  if (kind === "insert") {
    const quote = /^((?:> ?)+)/.exec(line);
    const item = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]/.exec(line);
    const added = quote ? [`${quote[1]!.trimEnd()} zq new`] : item ? [`${item[1]}${/\d/.test(item[2]!) ? "1." : item[2]} zq new`] : ["", "zq new"];
    return [...lines.slice(0, k + 1), ...added, ...lines.slice(k + 1)].join("\n");
  }
  const lead = (l: string) => /^[ \t]*/.exec(l)![0].length;
  const next = lines[k + 1];
  if (next !== undefined && next.trim() !== "" && lead(next) > lead(line)) return null;
  return [...lines.slice(0, k), ...lines.slice(k + 1)].join("\n");
}
