import type { LinkIndex } from "../links/index.ts";
import type { VaultMedia } from "../vault/images.ts";

export interface TranslateContext {
  index: LinkIndex;
  /** Vault path of the note being translated (relative links and same-folder preference). */
  fromPath: string;
  /** Vault name, to recognize obsidian://open links into this vault. */
  vaultName: string;
  /** Titles of mentioned pages that are outside the database (fetched once per run). */
  titles?: ReadonlyMap<string, string>;
  /** The vault's attachments (images, PDFs, audio, video, other files). Without it, their citations travel as escaped text, as before attachments were synced. */
  media?: VaultMedia;
  /**
   * Write an embedded note's mention with the `!` before it, as pages synced before the `!` was dropped hold it. Only
   * the first-run update of those pages (`updateEmbedsResult`) asks for it, to find their lines.
   */
  markEmbeds?: boolean;
}

/**
 * Text Notion must hold as written: the characters its enhanced markdown treats as syntax outside code escaped, and
 * `_` too, unless inside a word (where it is never emphasis), since Notion reads `_x_` as emphasis.
 */
export function escapeNotionText(text: string): string {
  const word = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  return text.replace(/[\\*~`$[\]<>{}|^_]/g, (c, at: number) => (c === "_" && word(text[at - 1]) && word(text[at + 1]) ? c : `\\${c}`));
}

/** Inline math, `$x$`, as the translator reads it (sticky: matched at a position). */
export const MATH = /\$(?=[^\s$])([^$\n]*?[^\s\\])\$(?!\d)/y;

/** Removes backslash escapes of ASCII punctuation. */
export function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

/** A link target with an extension other than .md: images, PDFs, drawings, canvases. */
export function isAttachment(target: string): boolean {
  const last = target.split("/").pop() ?? "";
  return /\.[A-Za-z0-9]{1,10}$/.test(last) && !/\.md$/i.test(last);
}
