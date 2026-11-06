// Notion page ids and URLs. Ids are stored dashed and lowercase.

const DASHED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const COMPACT = /(?:^|[^0-9a-f])([0-9a-f]{32})(?![0-9a-f])/i;

function dash(hex: string): string {
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Finds a page id in a bare id (dashed or not) or in any text that contains one. */
export function normalizeId(value: string): string | null {
  const dashed = DASHED.exec(value);
  if (dashed) return dashed[0].toLowerCase();
  const compact = COMPACT.exec(value);
  return compact ? dash(compact[1]!) : null;
}

/** The page id in a Notion URL's path; query strings and #block fragments are ignored. */
export function idFromUrl(url: string): string | null {
  const path = url.split(/[?#]/)[0] ?? "";
  const segments = path.split("/").reverse();
  for (const segment of segments) {
    const id = normalizeId(segment);
    if (id) return id;
  }
  return null;
}

export function isNotionUrl(url: string): boolean {
  return /^https?:\/\/([a-z0-9-]+\.)*notion\.(so|com|site)\//i.test(url) && idFromUrl(url) !== null;
}

/** The URL form Notion itself writes for page links and mentions. */
export function pageUrl(id: string): string {
  return `https://app.notion.com/p/${id.replace(/-/g, "")}`;
}
