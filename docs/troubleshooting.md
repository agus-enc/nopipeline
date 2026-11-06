# Troubleshooting

Why a note is skipped and what to do about it, and the known limitations. [Back to README](../README.md)

## When a note is skipped

A skipped note is left as it is in both apps, listed under "Skipped" with its reason (exit code `1`), and tried again every run until the reason is gone.

### What "say the same thing" means

"Say the same thing" means as Obsidian shows it, line by line, nesting and blank lines between blocks included, and only where Notion would hold the same thing too:

- Code compares exactly as Notion holds it (every line of a nested block one tab deeper is a change).
- A link's text written as text (`\[\[Note\]\]`, escaped pipes) is not the link (or table) itself.

What only Notion writes its own way counts as the same:

- a code block's language under Notion's name;
- a mention of a page outside the database, or a bookmark shown as a link;
- a callout's own icon, colors and blank lines typed in Notion;
- a literal `*`, `_` or `~`, escaped or not;
- backslashes Notion drops (`C\# notes` is `C# notes` in Notion).

If the note stays skipped after you made the same edit, undo the edit instead. With nothing new on that side, the skip ends. For a note both apps changed, undoing one app's edits leaves the other's, which are then carried over, or skipped with their own reason.

### Reasons

| Reason | What happened | What to do |
|---|---|---|
| `not_matched` (Obsidian's edit …) | An edit made in Obsidian couldn't be matched to the page line by line, and rewriting the page from the note would lose what Obsidian can't hold (files, date and people mentions, colors, columns, toggles, callout icons, blank lines typed in Notion). | Make the same edit in Notion, or undo it in Obsidian. Once both apps say the same thing, the next run records the note as synced without writing anything. |
| `not_matched` (Notion's edit …) | An edit made in Notion couldn't be matched to the note line by line, and rewriting the note would lose its formatting (link anchors, list markers, callout types, a one-line formula, a code block whose lines all start with a tab, …). | Make the same edit in Obsidian, or undo it in Notion. |
| `not_matched` (both apps changed it …) | Both apps changed the note and the edits couldn't be combined line by line. | Make the note and the page say the same thing by hand (Notion's edit in Obsidian, Obsidian's in Notion), or undo the edits in one of the two apps. |
| `unsupported_blocks` (this edit would delete …) | An edit made in Obsidian would delete a block a note can't hold. | Make that change in Notion, and undo it in Obsidian or leave it there (once both say the same, the next run records them as synced); or only undo it in Obsidian. |
| `unsupported_blocks` (… can't be replaced by the note) | A first-run pairing would replace a page holding such a block. | Remove those blocks from the page in Notion, or rename the note or the page so the two sync as separate notes. A note that already carries the page's `notion-id` (its records were lost) pairs as it is once the note and the page say the same. |
| `unsupported_blocks` (… can't be replaced as a whole) | An edit made in Obsidian needs the page's text sent whole (the edit removes or changes a file Notion hosts, or sits between two of them), and the page holds a block a note can't hold. | Make the same edit in Notion (the next run records both as synced), or undo it in Obsidian. |
| `changed_in_obsidian`, `changed_in_notion` | The note or the page changed while the run was working on it. | Nothing: the next run picks it up. |
| `path_taken` | A rename from Notion would move the note onto a file that already exists. | Rename one of the two. |
| `still_in_notion` | The note's page is missing from the database listing but still exists in Notion (maybe moved out of the database). | Move the page back into the database, or delete the note by hand if it should go. |
| `truncated` | Three reasons. **Too large to read completely:** Notion cut the page at about 20,000 blocks, and the tool couldn't fetch every block it left out (see [Large pages](#large-pages)). **Too large to rewrite whole:** the page was read in pieces, and this edit would need Notion to take the whole page at once. | For the first, split the page in Notion. For the second, make the edit in Notion, or in Obsidian a few lines at a time (the note then syncs line by line). A third, **touches a part Notion doesn't load for editing**, is an edit inside a block Notion left out: make it in Notion. |
| `unreadable_mention` | A line the edit changes mentions a Notion page Notion refused to tell about (`restricted_resource`); Notion finds a line with a mention only by that page's title. Nothing was written. | Check the connection's access to that page in Notion (or remove the mention), or make the edit in Notion too. |
| `notion_rereads` | The note, or the page, holds a line Notion would read back as something else the next time the page is written. The reason names the line. Nothing was written. See [`notion_rereads` in detail](#notion_rereads-in-detail). | Write that line another way, in Obsidian or in Notion: without the backslash if the syntax is meant, in a code span, or reworded (`*a* ***b*** *c*` for italics around bold). The next run then syncs the note. |
| `download_failed` (can't download …) | A file pasted in Notion (an image, PDF, audio, video or file) couldn't be downloaded. The page and its note are left alone and the download is tried again every run. | Nothing, if it was a hiccup; if Notion keeps refusing the file, replace it in Notion. |
| Notion's own codes (`validation_error`, `conflict_error`, `object_not_found`, `restricted_resource`) | Notion refused the request for this page. | Usually the next run gets through; otherwise check the page in Notion. |

### `notion_rereads` in detail

Notion reads the whole page again on every write. So a line that Notion would read back as something else is refused, and nothing is written.

The lines that cause it:

- `\# x`, `\- x`, `\+ x`, `1\. x` or `\---` (a heading, a list or a divider);
- `\_x\_` (italics);
- `_a **b** c_` (italics around bold, which Notion can't hold);
- a code span holding a backtick;
- a link's text whose escaped underscores pair, such as `[\_\_dict\_\_ keys](Note.md)`, which is what `[[Note|__dict__ keys]]` is converted to;
- a URL Notion would cut at its underscores.

About the link case:

- Unescaped, `[__dict__ keys](Note.md)` is bold in both apps.
- A link whose text is the note's title is written as a mention instead, so it passes.

For a new note, nothing was written, but:

- The page is made with its title (and project) only, so links to it work. It gets its text once the line is fixed.
- Until then the note syncs with that empty page as if it were new:
  - deleting the note trashes the page;
  - renaming either renames the other;
  - text typed into the page comes back as a conflict copy when the note's text is written.
- A first-run pairing replaces nothing.

## Waiting notes

A note listed under "Waiting" is open in Obsidian or was edited in the last 5 minutes, so the run left it and its Notion page as they were (exit code `0`). Close the note, wait 5 minutes after the last edit, and run again; the automatic timer retries every 15 minutes.

- **A note stays waiting.** Check that it isn't open in a tab or a pane, and that nothing keeps changing the file (for example another sync tool).
- **Warning that Obsidian's open tabs couldn't be read.** Obsidian runs, but `.obsidian/workspace.json` in the vault is missing or not in the expected form, so the run can't tell which notes are open. Notes edited in the last 5 minutes still wait; the automatic timer skips its tick (`obsidian-open` in `auto.log`) until Obsidian is closed. This also happens when the vault uses an "Override config folder" in Obsidian's settings: the workspace file is then in that folder, which is not read.

## Tags

Both warnings are said on every run until fixed; the tags concerned are left alone.

- **`<note>: its frontmatter "tags" can't be edited safely (<reason>); its tags are left alone`.** The note's `tags` key can't be read or rewritten without risking the rest of its frontmatter: the key appears twice, a value is not a plain or quoted word (a comment on the line, a nested list), or a value is not a tag Obsidian accepts. Fix the `tags` lines in the note (one `tags:` key, a list of words), and the next run syncs them. No tags are written to the note or read from it meanwhile; the page's tags are not touched either.
- **`<note>: the Notion tag "<name>" can't be an Obsidian tag; it stays in Notion only`.** A Notion option with a space, only digits, or characters outside Obsidian's tag characters (letters, digits, `_`, `-`, `/`) can't be written to a note. It stays on the page and the sync never removes it. To have it in the note, rename the option in Notion.
- **Tags don't sync at all, and the run says `the database has no "Tags" property` or `… not a multi-select`.** Add a multi-select property with that name, or set `tagsProperty` (see [Configuration](configuration.md)).

## Known limitations

### Large pages

Notion's markdown endpoint cuts a page at about 20,000 blocks and leaves each block it cut out as a placeholder line. The tool fetches every left-out block and puts it back in its place, so such a page syncs like any other, at the cost of one extra request per left-out block each time the page is read, and a full re-read of the page (all those requests again) after each write to it. Pages not edited since the last run aren't read.

- A page read this way is never rewritten whole: Notion times out on a request that large. Edits go through line by line. An edit made in Obsidian that can only be written as a whole rewrite is skipped (`truncated: the page is too large to rewrite whole …`). Notion finds search text only in the part of the page it loads (it leaves nested list items out first), so an edit that touches a left-out part is skipped before anything is sent (`truncated: this edit touches a part of the page Notion doesn't load for editing; make it in Notion`).
- If any left-out block can't be fetched, the page and its note are left alone and the run warns (`truncated: the page is too large to read completely`).

### Lines written in more lines or fewer

The tool writes some Obsidian forms differently in Notion:

- a heading underlined with `===` or `---`;
- a formula on one `$$` line;
- a `~~~` fence;
- a `<br>` typed in a note.

An edit made in Notion to such a line can't be placed on the note, so the note is skipped until the same edit is made in Obsidian.

`node scripts/check-vault.ts <vault>` counts these lines and simulates a Notion edit on every line of every note (see [Development](development.md)).

### Code blocks in Notion

- Notion keeps a code block's language under its own name (see [Language names](how-sync-works.md#language-names)). The note keeps its own spelling unless that fence line is edited in Notion or the note is rewritten whole.
- A code block nested in a quote, a list item or a callout whose every line starts with a tab reads in Obsidian with one tab fewer, because Notion writes such a block the way the tool writes all nested code. An edit made in Notion to such a block is skipped (make it in Obsidian too).
- An edit made in Obsidian that leaves every line of a block tab-led (indenting the whole block) is written the way the tool writes nested code.
- Any other edit made in Obsidian to a block Notion already holds that way rewrites the page whole when the page loses nothing that way, and is skipped otherwise.
- Lines indented four spaces or a tab after a blank line outside a list (an indented code block in Obsidian) go to Notion as text.

### Notion-only formatting on an edited line

Editing a line in Obsidian replaces Notion-only formatting on that line (text color, date and people mentions, a mention of a page outside the database) with the Obsidian text.

### Links

- A note that writes `\[\[Note\]\]` as text on purpose and also links `[[Note]]` for real gets both turned into links in Notion when the link starts resolving.
- When a line is edited in Notion, links come back like this:
  - A page link comes back as a Markdown link with the text Notion holds.
  - A mention comes back with the page's title, for example `[Soup: Tomato](Soup-%20Tomato.md)`. It is escaped as conversion writes it, where Obsidian would show formatting.
  - A link the line already had keeps the note's own text and destination.
- Text Notion shows for a link to a note that doesn't exist comes back as the target's base name (`[[Folder/Missing]]` as `[Missing](Folder/Missing.md)`).
- Notion splits a link whose text is partly formatted into several links, so adjacent links to the same page read back as one link.
  - A note that writes two links to the same note with nothing between them is read that way too.
  - An edit made to that line in Notion is then skipped (`not_matched`) until it is made in Obsidian.
- After a rename in Notion, Markdown links written as `[text](<Note.md>)` or with a `'title'`, and links inside code that spans lines, are not rewritten.
- A rename from Notion can be cut short before the note moved. The next run ends it if that run doesn't move the note, that is, if it was renamed in Obsidian or Notion's title went back. The plan shows "rewrite the links that use an unfinished rename's name to …".
  - Links already rewritten to the new name follow the note to its name.
  - But if a note with that new name appears first, those links mean that note, as Obsidian shows them.
- A `[[link]]` inside the text of an existing Markdown link is converted too.
- When two notes share a file name, a link may resolve to the other one.

### Callouts

A foldable callout that opens by default (`[!note]+`) comes back as closed (`-`) when edited in Notion. Other callout types come back with the type whose icon Notion shows.

### Identical lines

Several edits inside a run of identical lines can move Notion-only formatting (a color) to another copy of the line. The words stay right.

### A page trashed while its note is edited

It gets a new page when the note syncs, so links and mentions of the old page in other Notion pages keep pointing at the trashed one.

### New pages sharing a title

They get `Draft.md`, `Draft (2).md` in the order Notion lists them, not by creation time.

### Large databases

Only the first 10,000 rows of the database are read. A note whose page lies beyond them is reported instead of trashed, and gets a new page if it was edited.

### Conflict copies

A conflict copy written by a run that was cut short right after its Notion write may not be listed again by the next run. Look beside the note for `(Notion conflict …)` files.

### Escapes Notion drops

Notion holds a note's `\# Not a heading`, `1\. Not a list` or `\_not italic\_` as the text it is, but returns it without the backslash, even though that backslash kept it from being syntax. The next write to the page, any line of it, reads it again from that: the line becomes a heading, a list or italics in Notion.

So the tool writes no page that holds such a line, not even to create or pair it (`notion_rereads`), and the note waits until the line is written another way.

Pages written before this rule (the first acceptance run) may already hold such lines. The next write to them is refused the same way.

### Emphasis inside emphasis

Notion writes these as one span:

- `*_a_*`, `**__a__**`, `___a___` or `~~_a_~~` as `*a*`, `**a**`, `***a***` and `*~~a~~*`;
- `~~**a**~~` as `**~~a~~**`;
- `*[a](u)*` as `[*a*](u)`.

The tool writes those as the note does, so a line holding one is a line Notion writes differently, like the forms above.

Italics around bold (`_a **b** c_`) Notion can't hold at all (`*a **b** c*` loses the bold), so a page holding them isn't written (`notion_rereads`). `*a* ***b*** *c*` says nearly the same in a form Notion keeps.

### Links Notion makes

Which words Notion links (`script.py` yes, `notes.txt` no) depends on a list of domain endings Notion doesn't publish. The tool's list is an approximation from probes, so a word Notion links that the tool doesn't expect makes that line read as edited in Notion.

A bare URL whose underscores pair (`…/__init__.py`) Notion cuts short, so a page holding one isn't written (`notion_rereads`). Write it as a link, `[…](url)`, or in a code span.

### A code span holding a backtick

A code span holding a backtick (` `` a ` b `` `) has no form in Notion: it mangles the line and merges it with the next. A page holding one isn't written (`notion_rereads`).

### Pages not shared with the connection

What Notion answers, and what its search finds, for a page that exists but isn't shared with the connection is unchecked (the connection can't make one to probe). Notion's documentation says such a page answers like a missing one. A line mentioning it is then searched the way a missing page's mention is, which no probe has confirmed.

### A backtick left alone

Notion takes a backtick without its pair (an unclosed `` `code``) for the start of a code span and merges that line with the lines after it, up to the next one with a backtick. Close the code span in the note.

`node scripts/check-vault.ts <vault>` counts these lines.

### Backslashes Notion keeps

In text that comes from Notion (a pulled line, a note made from a page), a backslash before `<`, `>`, `|`, `{`, `}` or `^` is dropped. So a Notion paragraph that starts with `\>`, or lines of `\|`, read in Obsidian as a quote or a table.

### Pairing after lost records

A note that carries its page's `notion-id` but whose sync record is gone is linked to the page as it is when their texts match with all spacing ignored. A difference only in nesting or line breaks then stays until one side is edited.
