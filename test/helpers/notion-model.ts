// What Notion keeps of the markdown it is sent, as far as live probes have shown it (fixtures in test/fixtures/notion:
// code-languages.json, inline-forms.json, inline-forms-2.json, reread.json, page-links.json, page-links-2.json). A model, kept apart from
// the translator, for the fake Notion and check-vault: each rule names the probe that showed it, and the fake's tests
// check the model against every recorded line it claims to model.
import { notionLanguage } from "../../src/translate/languages.ts";

/** The characters Notion keeps a backslash before (live probes); it drops any other. */
const KEPT_ESCAPES = "\\*~`$[]<>{}|^";

/**
 * Top-level domains Notion links a bare word ending in (live probe linked `.py`, `.md`, `.sh`, `.io`,
 * `.org`, `.com`, `.co.uk`, but not `.txt`, `.js`, `.go`, `.yaml`, `.csv`, `.png`, `os.path`). Notion's own list isn't
 * known: this one holds the generic ones in common use and every two-letter country code, an approximation.
 */
const TLDS = new Set(
  (
    "com org net edu gov mil int info biz name pro dev app io ai xyz online site tech store blog page cloud digital zip mov " +
    "ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cc cd cf cg " +
    "ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gd ge gf gg gh gi " +
    "gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky " +
    "kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni " +
    "nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sk sl sm sn so " +
    "sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt " +
    "za zm zw"
  ).split(" "),
);

/** The bare URL, `www.` host, email or domain-like word at the start of `text` that Notion makes a link, and its target. */
function autolinkAt(text: string, before: string | undefined): { label: string; href: string } | null {
  if (before !== undefined && /[A-Za-z0-9.@/:-]/.test(before)) return null;
  const trim = (url: string) => {
    for (;;) {
      const t = url.replace(/[?!.,:_~'"]+$/, "");
      const unbalanced = t.endsWith(")") && (t.match(/\)/g) ?? []).length > (t.match(/\(/g) ?? []).length;
      const next = unbalanced ? t.slice(0, -1) : t;
      if (next === url) return url;
      url = next;
    }
  };
  let m = /^https?:\/\/[^\s<>*`[\]\u0000\u0001]+/.exec(text);
  if (m) return { label: trim(m[0]), href: trim(m[0]) };
  m = /^www\.[^\s<>*`[\]\u0000\u0001]+/.exec(text);
  if (m) return { label: trim(m[0]), href: `http://${trim(m[0])}` };
  m = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.([A-Za-z]{2,})(?![A-Za-z0-9-])/.exec(text);
  if (m && TLDS.has(m[1]!.toLowerCase())) return { label: m[0], href: `mailto:${m[0]}` };
  m = /^(?:[A-Za-z0-9-]+\.)+([A-Za-z]{2,})(?![A-Za-z0-9-(])/.exec(text);
  if (m && TLDS.has(m[1]!.toLowerCase()) && /[A-Za-z]/.test(m[0].split(".")[0]!)) return { label: m[0], href: `http://${m[0]}` };
  return null;
}

/**
 * `text` with what Notion links made links (their text with Notion's escapes, their target as it is), each link
 * replaced by what `hold` gives for it, so no later rule reads inside it.
 */
function autolinks(text: string, hold: (kept: string) => string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const found = /[\u0000\u0001]/.test(text[i]!) ? null : autolinkAt(text.slice(i), text[i - 1]);
    if (found) {
      out += hold(`[${found.label.replace(/~/g, "\\~")}](${found.href})`);
      i += found.label.length;
    } else {
      out += text[i++];
    }
  }
  return out;
}

/**
 * Lone stars, as Notion reads them (live probe): it pairs stars CommonMark wouldn't (`2 * 3 * 4` makes
 * "3" italic, written back as sent), escapes the last single star of a line holding an odd number of stars, and drops
 * `**` or `****` standing alone between spaces when no other double run pairs with it. Escaped stars are text.
 */
function loneStars(text: string): string {
  const runs = [...text.matchAll(/(?<![*\\])\*+/g)];
  let out = text;
  const doubles = runs.filter((r) => r[0].length === 2 || r[0].length === 4);
  if (doubles.length % 2 === 1) out = out.replace(/(^|\s)(\*\*|\*\*\*\*)(?=\s|$)/, "$1");
  const stars = [...out.matchAll(/(?<!\\)\*/g)];
  if (stars.length % 2 === 1) {
    const singles = [...out.matchAll(/(?<![*\\])\*(?!\*)/g)];
    const last = singles[singles.length - 1];
    if (last) out = `${out.slice(0, last.index)}\\*${out.slice(last.index! + 1)}`;
  }
  return out;
}

/**
 * A line of text (not code) as Notion keeps it when it reads it from markdown: when it is sent, and again whenever the
 * page is written (live probe: one `update_content` edit reads every line of the page back from its
 * markdown). Escapes are read first and come back without their backslash outside Notion's escape set, so a line
 * Notion holds literally (`\# x`, `\_x\_`) reads back as what its markdown says the next time the page is written.
 * Then: a list marker `+ ` or `* ` as `- `; emphasis Notion writes its own way; lone stars; links Notion makes of bare
 * URLs and domain-like words; a tilde that strikes nothing, and a lone `<` or `>`, escaped. A code span (inline math
 * holds one) is code, and keeps one backtick a side (two make plain text). A link's text is read as text, and a link
 * whose text is emphasis or code only in part becomes one link per run on the write that sends it (`linkRuns`: confirmed
 * live, a recorded live run); a link's target, whatever page it names
 * (one in the trash, or one no one has: live probe), tags and code stay as they are.
 * Not modelled (see the fake's tests): emphasis nested in ways Notion mangles (`***a** b*`, `_a __b__ c_`,
 * `*a _b_ c*`), a single star next to a double one (`x * y **z**`), and code spans holding a backtick.
 */
export function inlineAsNotionKeeps(line: string): string {
  const held: string[] = [];
  const hold = (kept: string) => `\u0001${held.push(kept) - 1}\u0001`;
  // Code spans (inline math holds one) first: what is in them is code. A code span keeps one backtick a side; two
  // make plain text.
  let text = line.replace(/(?<!\\)(`+)((?:[^`]|[^`][\s\S]*?[^`]))\1(?!`)/g, (whole, ticks: string, c: string) => {
    if (ticks.length === 2) return hold(c);
    return hold(ticks.length === 1 ? whole : `\`${c.length > 2 && c.startsWith(" ") && c.endsWith(" ") ? c.slice(1, -1) : c}\``);
  });
  // Escapes outside Notion's set come back as their character, and are text for every rule below.
  text = text.replace(/\\([\s\S])/g, (whole, c: string) => `\u0000${held.push(KEPT_ESCAPES.includes(c) ? whole : c) - 1}\u0000`);
  // A list marker Notion writes as `- `; a quote's marker is no text.
  text = text.replace(/^(\t*)[+*] /, "$1- ").replace(/^(\t*)[+*]$/, "$1-").replace(/^(\t*)>(?= |$)/, (_m, tabs: string) => hold(`${tabs}>`));
  const prose = (part: string, links = true): string => {
    let p = part
      .replace(/(?<![*\\])\*(?![*\s])([^*]*?)\*\*([^*]+?)\*\*([^*]*?)(?<![*\s\\])\*(?!\*)/g, "*$1$2$3*")
      .replace(/~~\*\*([^*~]+)\*\*~~/g, "**~~$1~~**")
      .replace(/(?<!\*)\*_([^_*]+)_\*(?!\*)/g, "*$1*")
      .replace(/\*\*__([^_*]+)__\*\*/g, "**$1**")
      .replace(/(?<![\p{L}\p{N}_])_\*\*([^*_]+)\*\*_(?![\p{L}\p{N}_])/gu, "***$1***")
      .replace(/\*\*_([^_*]+)_\*\*/g, "***$1***")
      .replace(/(?<![\p{L}\p{N}_])___([^_]+)___(?![\p{L}\p{N}_])/gu, "***$1***")
      .replace(/(?<![\p{L}\p{N}_\\*~])__(?![\s_*~])(.+?)(?<![\s\\_*~])__(?![\p{L}\p{N}_*~])/gu, "**$1**")
      .replace(/(?<![\p{L}\p{N}_\\*])_(?![\s_*])(.+?)(?<![\s\\_])_(?![\p{L}\p{N}_*])/gu, "*$1*")
      .replace(/~~\*([^*~]+)\*~~/g, "*~~$1~~*");
    p = loneStars(p);
    if (links) p = autolinks(p, hold);
    return p.replace(/(?<![\\~])~(?!~)/g, "\\~").replace(/[<>]/g, (c) => `\\${c}`);
  };
  // Links (their text read as text), tags and mentions are held aside while the rules run.
  const KEEP = /(!?)\[((?:[^\]\\]|\\.|[\u0000\u0001]\d+[\u0000\u0001])*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)|<\/?[A-Za-z][\w-]*(?:\s[^>\n]*)?\/?>/g;
  text = text.replace(KEEP, (whole, bang: string | undefined, label: string | undefined, target: string | undefined) =>
    target === undefined ? hold(whole) : hold(bang ? `![${prose(label!, false)}](${target})` : linkRuns(prose(label!, false), target)),
  );
  text = prose(text);
  // A link or a colour span that emphasis wraps holds the emphasis instead: `*[a](u)*` as `[*a*](u)`.
  const restore = (t: string): string => t.replace(/[\u0000\u0001](\d+)[\u0000\u0001]/g, (_m, n: string) => restore(held[Number(n)]!));
  return restore(text)
    .replace(/(\*{1,3})\[([^\]]*)\]\(([^)\s]*)\)\1/g, "[$1$2$1]($3)")
    .replace(/(\*{1,3})(<span\b[^>]*>)([^<]*)<\/span>\1/g, "$2$1$3$1</span>");
}

/**
 * A link whose text (in Notion's forms) is emphasis only in part, as Notion writes it: one link for each run of the
 * text that reads alike, each holding its own emphasis (live probe: `[Probe __glow__ lamp …](u)`, read again,
 * came back `[Probe - ](u)[**slots**](u)[ …](u)`). A link that is emphasis throughout stays one link. Bold, italics,
 * strikethrough and a code span (a vault's `` [`__slots__` attribute](…) ``) all split, on the first write already, and
 * the split stays on later writes: confirmed live (a recorded live run; fixture
 * page-links-2.json). Not modelled: emphasis nested inside emphasis in a link's text.
 */
function linkRuns(label: string, target: string): string {
  const runs: string[] = [];
  let at = 0;
  // A code span in a link's text is held (`\u0001n\u0001`) by the time the link is read.
  for (const m of label.matchAll(/\u0001\d+\u0001|(?<![*~\\])(\*{1,3}|~~)(?![\s*~])((?:\\.|[^\\])*?)(?<![\s*~\\])\1(?![*~])/g)) {
    if (m.index > at) runs.push(label.slice(at, m.index));
    runs.push(m[0]);
    at = m.index + m[0].length;
  }
  if (at < label.length) runs.push(label.slice(at));
  return runs.length <= 1 ? `[${label}](${target})` : runs.map((run) => `[${run}](${target})`).join("");
}

/** Notion's escape set applied to a line that joins another (a merge): what would be syntax there is escaped. */
const asJoined = (line: string) => line.replace(/(?<!\\)[<>[\]]/g, (c) => `\\${c}`);

/**
 * Lines Notion joins (live probes): a line of text holding an odd number of backticks (an
 * escaped one counts) takes in every line after it up to the next one holding a backtick, joined with `<br>`, those
 * lines' `<`, `>`, `[` and `]` escaped; unless a code fence comes first, or no such line does.
 */
export function joinedByNotion(lines: string[]): string[] {
  return joins(lines).lines;
}

/** `joinedByNotion`, and how many lines took others in. */
export function joins(lines: string[]): { lines: string[]; count: number } {
  let count = 0;
  const out: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    const open = /^\t*(`{3,})[^`]*$/.exec(line);
    if (fence !== null || open) {
      if (fence === null) fence = open![1]!;
      else if (line.trim() === fence) fence = null;
      out.push(line);
      continue;
    }
    let joined = false;
    while ((line.match(/`/g) ?? []).length % 2 === 1) {
      let j = i + 1;
      while (j < lines.length && !lines[j]!.includes("`")) j++;
      if (j >= lines.length || /^\t*`{3,}/.test(lines[j]!) || lines.slice(i + 1, j).some((l) => /^\t*`{3,}/.test(l))) break;
      line = [line, ...lines.slice(i + 1, j + 1).map(asJoined)].join("<br>");
      i = j;
      joined = true;
    }
    if (joined) count++;
    out.push(line);
  }
  return { lines: out, count };
}

/**
 * The markdown Notion keeps for what it is sent (live probes). It writes a nested code
 * block's lines as they are, flush left, while the fences keep their tabs; keeps every code block's language under its
 * own name for it (`js` as javascript, an untagged or unknown one as javascript); writes an empty code block with an
 * empty line; joins lines a lone backtick runs into (`joinedByNotion`); and writes every line of text in its own
 * forms (`inlineAsNotionKeeps`), block equations aside. A code block the page already held (`before`) stays as it is;
 * every line of text is read again, as Notion reads the whole page whenever it is written.
 */
export function asNotionKeeps(markdown: string, before = ""): string {
  const lines = joinedByNotion(markdown.split("\n"));
  const out: string[] = [];
  let math = false;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\t*)(`{3,})([^`]*)$/.exec(lines[i]!);
    if (!m) {
      // A block equation's lines are its formula, not text.
      if (lines[i]!.trim() === "$$") math = !math;
      out.push(math || lines[i]!.trim() === "$$" ? lines[i]! : inlineAsNotionKeeps(lines[i]!));
      continue;
    }
    const [, tabs, fence, info] = m as unknown as [string, string, string, string];
    let j = i + 1;
    const body: string[] = [];
    while (j < lines.length && lines[j]!.trim() !== fence) body.push(lines[j++]!);
    if (before !== "" && before.includes(lines.slice(i, j + 1).join("\n"))) {
      out.push(...lines.slice(i, j + 1));
    } else {
      out.push(`${tabs}${fence}${notionLanguage(info)}`);
      const flush = tabs !== "" && body.every((l) => l.startsWith(tabs)) ? body.map((l) => l.slice(tabs.length)) : body;
      out.push(...(flush.length ? flush : [""]));
      if (j < lines.length) out.push(lines[j]!);
    }
    i = j;
  }
  return out.join("\n");
}
