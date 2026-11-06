// Notion-hosted files and the placeholder URLs the sync writes in their stead: pure text functions.
import { encodeVaultPath } from "../links/index.ts";

/** Where the sync's placeholder image URLs point; Notion keeps them verbatim and `.invalid` can never resolve. */
export const PLACEHOLDER_BASE = "https://nopipeline.invalid/vault/";

/** The placeholder image URL for a vault path. */
export function placeholderUrl(path: string): string {
  return `${PLACEHOLDER_BASE}${encodeVaultPath(path)}`;
}

/** The vault path a placeholder URL stands for, or null for any other URL. The rest is decoded as a whole, so `%2F` reads as a slash too. */
export function placeholderPath(url: string): string | null {
  if (!url.startsWith(PLACEHOLDER_BASE)) return null;
  try {
    return decodeURIComponent(url.slice(PLACEHOLDER_BASE.length));
  } catch {
    return null;
  }
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  heic: "image/heic",
  tif: "image/tiff",
  tiff: "image/tiff",
  ico: "image/x-icon",
  bmp: "image/bmp",
};

/** The content type of an image file by its extension (any case), or null for any other file. */
export function imageContentType(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return IMAGE_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

export function isImagePath(path: string): boolean {
  return imageContentType(path) !== null;
}

/** What a vault file is to Notion: the block type its citation makes. */
export type MediaKind = "image" | "pdf" | "audio" | "video" | "file";

const AUDIO_TYPES: Record<string, string> = {
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  "3gp": "audio/3gpp",
};
const VIDEO_TYPES: Record<string, string> = {
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp4: "video/mp4",
  ogv: "video/ogg",
  webm: "video/webm",
};
/** Files that are no attachment: notes (and the drawings, which are notes, as are the legacy JSON `.excalidraw` ones), canvases and bases. */
const NOT_ATTACHMENTS = new Set(["md", "canvas", "base", "excalidraw"]);
/** The common type of some other extensions; any further one is `application/octet-stream`. */
const FILE_TYPES: Record<string, string> = {
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  epub: "application/epub+zip",
};

/** The lower-case extension of a path's file name, or null when it has none (`noext`, `dir.png/readme`); as `imageContentType` reads it. */
function extensionOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? null : name.slice(dot + 1).toLowerCase();
}

/** The kind of a vault file by its extension (any case); null for a note, a drawing, a canvas, a base or a name with no extension. */
export function mediaKind(path: string): MediaKind | null {
  const ext = extensionOf(path);
  if (ext === null || NOT_ATTACHMENTS.has(ext)) return null;
  if (ext in IMAGE_TYPES) return "image";
  if (ext === "pdf") return "pdf";
  if (ext in AUDIO_TYPES) return "audio";
  if (ext in VIDEO_TYPES) return "video";
  return "file";
}

/** The content type an upload of this file carries: the common type of its extension, else `application/octet-stream`. */
export function contentType(path: string): string {
  const ext = extensionOf(path);
  if (ext === null) return "application/octet-stream";
  if (ext === "pdf") return "application/pdf";
  return IMAGE_TYPES[ext] ?? AUDIO_TYPES[ext] ?? VIDEO_TYPES[ext] ?? FILE_TYPES[ext] ?? "application/octet-stream";
}

/**
 * A Notion-hosted file's URL up to the end of its path: `<workspace>/<file uuid>/<name>`, signature (`?…`) and record (`#…`) left off.
 * The name may hold balanced parentheses (`probe%20(1).png`, as a browser's duplicate download is named): `encodeURIComponent`, which
 * names are written with, leaves them alone, and an unbalanced `)` still ends the URL, so `[c](url)` reads right.
 */
const HOSTED_URL = /https:\/\/prod-files-secure\.s3\.[a-z0-9-]+\.amazonaws\.com\/[^/\s?#"'<>()]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(?:[^\s?#"'<>()]|\([^\s?#"'<>()]*\))+/;
/** The same URL with its signature and record, wherever it sits in the text. */
const HOSTED_URL_SIGNED = new RegExp(`${HOSTED_URL.source}(?:\\?[^\\s#"'<>()]*)?(?:#[^\\s"'<>()]*)?`, "g");

/** The file behind a Notion-hosted URL: `key` is its file uuid (stable between reads), `bare` the URL without the signature that changes at every read. Null for any other URL. */
export function hostedFile(url: string): { key: string; name: string; bare: string } | null {
  const match = new RegExp(`^${HOSTED_URL.source}(?:[?#].*)?$`, "s").exec(url);
  if (!match) return null;
  const bare = url.split(/[?#]/, 1)[0]!;
  const last = bare.slice(bare.lastIndexOf("/") + 1);
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // an undecodable name stays as written
  }
  return { key: match[1]!, name, bare };
}

/** `markdown` with every Notion-hosted URL (image, file, pdf, video, audio) in its bare form: two reads of one page then agree. */
export function stripSignatures(markdown: string): string {
  return markdown.replace(HOSTED_URL_SIGNED, (url) => hostedFile(url)?.bare ?? url);
}

/** An image alone on its line, at any tab depth (a list item's child reads back that way): tabs, caption, URL (balanced parentheses allowed in it). */
export const IMAGE_LINE = /^(\t*)!\[((?:[^\]\\\n]|\\.)*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)$/;

export function isImageLine(line: string): boolean {
  return IMAGE_LINE.test(line);
}

/**
 * A PDF, file, audio or video block alone on its line, at any tab depth: tabs, tag, `src`, caption (backslash escapes allowed in it).
 * Notion reads these blocks back as `<pdf src="…">caption</pdf>` and takes them the same way (spec §6).
 */
export const MEDIA_TAG = /^(\t*)<(pdf|file|audio|video)\s+src="([^"]*)"\s*>((?:[^<\\]|\\.)*)<\/\2>$/;

/** An image line or a media tag line, read: its tabs, kind, caption as written, and URL. Null for any other line. */
export function mediaLine(line: string): { indent: string; kind: MediaKind; caption: string; url: string } | null {
  const image = IMAGE_LINE.exec(line);
  if (image) return { indent: image[1]!, kind: "image", caption: image[2]!, url: image[3]! };
  const tag = MEDIA_TAG.exec(line);
  if (tag) return { indent: tag[1]!, kind: tag[2] as MediaKind, caption: tag[4]!, url: tag[3]! };
  return null;
}

/** A media line as Notion writes it and takes it: an image as Markdown, any other kind as its tag (spec §6). */
export function mediaText(kind: MediaKind, indent: string, caption: string, url: string): string {
  return kind === "image" ? `${indent}![${caption}](${url})` : `${indent}<${kind} src="${url}">${caption}</${kind}>`;
}

/**
 * A media line (an image's, or a PDF's, file's, audio's or video's) Notion's search can't find, so no search text may hold it: a
 * Notion-hosted file's (live, spec §7 result 2; §6 for a PDF) and a placeholder's (the page holds the hosted file it became). A web
 * URL's line (`![x](https://example.com/a.png)`, `<video src="https://youtu.be/x">`) is ordinary text.
 */
export function isUnsearchableMediaLine(line: string): boolean {
  const media = mediaLine(line);
  return media !== null && (hostedFile(media.url) !== null || placeholderPath(media.url) !== null);
}

/** `stripSignatures`, then each media line (image, PDF, file, audio, video) whose hosted file is a known vault file written with that file's placeholder URL. */
export function canonicalMarkdown(markdown: string, pathOf: (key: string) => string | null): string {
  return stripSignatures(markdown)
    .split("\n")
    .map((line) => {
      const media = mediaLine(line);
      if (!media) return line;
      const file = hostedFile(media.url);
      const path = file && pathOf(file.key);
      if (!path) return line;
      return mediaText(media.kind, media.indent, media.caption, placeholderUrl(path));
    })
    .join("\n");
}
