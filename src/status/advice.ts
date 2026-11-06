// One line on what to do about a skipped note, by the reason's code; condensed from the README's "When a note is skipped" table.
const ADVICE: Record<string, string> = {
  not_matched: "Make the same edit in the other app, or undo the edit; once both say the same thing, the next run records the note as synced.",
  unsupported_blocks: "Make that change in Notion (or remove the blocks a note can't hold there), or undo the edit in Obsidian.",
  changed_in_obsidian: "Nothing: the next run picks it up.",
  changed_in_notion: "Nothing: the next run picks it up.",
  path_taken: "Rename the note or the other file.",
  still_in_notion: "Move the page back into the database, or delete the note by hand if it should go.",
  truncated: "Split the page in Notion if it is too large to read; if too large to rewrite whole, make the edit in Notion, or in Obsidian line by line.",
  unreadable_mention: "Check the connection's access to the mentioned page in Notion (or remove the mention), or make the edit in Notion too.",
  notion_rereads: "Write the named line another way, in Obsidian or Notion (no backslash if the syntax is meant, a code span, or reworded).",
  download_failed: "Nothing if it was a hiccup; if Notion keeps refusing the file, replace it in Notion.",
  validation_error: "Usually the next run gets through; otherwise check the page in Notion.",
  conflict_error: "Usually the next run gets through; otherwise check the page in Notion.",
  object_not_found: "Usually the next run gets through; otherwise check the page in Notion.",
  restricted_resource: "Usually the next run gets through; otherwise check the page in Notion.",
};

export function adviceFor(reason: string): string {
  const code = reason.split(":")[0]!.trim();
  return Object.hasOwn(ADVICE, code) ? ADVICE[code]! : 'See "When a note is skipped" in the README.';
}
