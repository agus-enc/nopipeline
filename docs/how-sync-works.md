# How the sync treats your notes

What happens to your notes and pages: ids, edits, merges, links, renames, deletes, backups, and Notion's formatting quirks. [Back to README](../README.md)

## Ids and file names

- Each synced note gets a `notion-id` property.
- Titles that can't be file names get a safe file name plus a `notion-title` property with the exact title.

## Folders

Folders follow projects as described in [Folders and projects](folders-and-projects.md). Without a projects relation, notes keep their vault folders and new Notion pages land in the default folder.

## Edits

### Line-level edits

An edit made in one app changes only that line in the other. The line keeps the other app's own layout:

- list markers;
- indentation;
- hard line breaks;
- link forms such as `[Note › Heading](Note.md#Heading)`.

The tool never guesses which line an edit belongs to. It places an edit only on lines it is certain are the same, and checks every placed edit against how the other app will read the result.

### Rewritten whole

When an edit can't be matched line by line, the other side is rewritten as a whole, but only if it holds nothing its app can't carry over:

- a note in exactly the forms Notion keeps for it;
- a page with nothing Obsidian can't hold, not even a blank line typed in Notion.

The summary lists the note under "Rewritten whole" (exit code `1`). The old note is in the backups, the old page in Notion's page history.

Otherwise nothing changes on either side, and the note is skipped with the edit to make by hand (see [When a note is skipped](troubleshooting.md#when-a-note-is-skipped)).

### Merges and conflict copies

When both apps changed a note, edits to different lines merge. That includes a line or paragraph added right next to a line edited on the other side.

Where the edits overlap, Obsidian's text wins and Notion's version is saved as `Note (Notion conflict YYYY-MM-DD).md` beside the note. Conflict copies never sync.

## Links

### `[[link]]` conversion

Before each run plans, every `[[link]]` in a note's body is written as a Markdown link.

- `[[Note]]` becomes `[Note](Note.md)`. The text is the note's title, or its `notion-title`. The destination is the shortest vault path that finds the note, each part encoded, spaces as `%20`.
- `[[Note|words]]` becomes `[words](Note.md)`.
- `[[Note#Heading]]` becomes `[Note › Heading](Note.md#Heading)`.
- Text that Obsidian would show as formatting is escaped so it reads as before: `[[Note|a *b* c]]` becomes `[a \*b\* c](Note.md)`, and `[[Lamp __glow__ mode]]` becomes `[Lamp \_\_glow\_\_ mode](…)`. Text without any is written as it is.

The plan shows "convert [[links]] to Markdown links in …". The conversion is an edit made in Obsidian (backed up like any write), and the same run pushes it.

Left as they are:

- embeds (`![[…]]`);
- links to attachments;
- links to a heading of the same note (`[[#H]]`);
- block links (`[[Note#^id]]`);
- anything in code or math (`$[[x]]$`, `$$` blocks);
- `\[[x]]`;
- frontmatter.

A link that is already a Markdown link keeps its text exactly as written.

`node scripts/check-vault.ts <vault>` counts what a run would convert (see [Development](development.md)).

### Page links and mentions

- In Notion a link to a note is a page link: `[Title](Notion page URL)`, never a mention.
- A page link comes into the note as a Markdown link. So does a mention typed in Notion with `@` (it keeps showing as a mention in Notion until its line is next written from Obsidian).
- An embed of a note (`![[Note]]`) is written to Notion as the page's mention alone, since Notion can't show another page's content inline. The note keeps `![[Note]]`, and an embed line edited in Notion comes back as a Markdown link.
- The page's "Links to" relation counts that mention like any other.
- Pages synced before the `!` was dropped lose it on the first run. The plan shows "turn the attachment citations already synced into Notion blocks and drop the `!` before embedded notes in …".
- Links to pages outside the database keep their mentions.

### Titles with underscores

A link whose text is exactly the page's title, with underscores that Notion would pair as italics or bold (`Lamp __glow__ mode`), is written to Notion as a mention instead. A mention shows the title without holding it as text. Otherwise the whole note would be refused every run (`notion_rereads`).

### Links to notes that don't exist yet

- A link to a note that doesn't exist yet is converted too: `[[Folder/Missing]]` becomes `[Missing](Folder/Missing.md)`. It shows in Notion as plain text, `\[\[Folder/Missing\]\]`.
- Once the note exists, a later run turns it into a page link. The plan shows "turn links to notes that now exist into Notion links in …".
- A target that resolves to a note or drawing is converted even when it looks like a file name (`[[ISO 8601]]`).
- Only an unresolved target with an extension other than `.md` (`[[diagram.png]]`) stays as it is.

## Tags

A note's tags are the `tags` list in its frontmatter. The sync keeps it in step with a multi-select property of the page (named by `tagsProperty`, default `Tags`; see [Configuration](configuration.md)).

- **The property.** It must be a multi-select in the notes database. Add it in Notion by hand: the tool never changes a database. If it is missing or another type, every run (and `setup`) says `the database has no "Tags" property; tags are left alone` or `… is a <type>, not a multi-select; tags are left alone`, and tags are off. With `tagsProperty: null` they are off without a word.
- **Only the frontmatter counts.** `#tags` written in a note's text, or in a page's text, are ignored for tags; they sync as text, as before. The sync never adds, removes or moves a `#tag` in text.
- **Reading and writing.** A note's `tags` may be a block list, `[a, b]`, `a, b` or one word; a leading `#` is dropped. The sync writes it as a block list and touches only the `tags` lines: every other key, comment and the order stay byte for byte. A note without `tags` gets the key at the end of its frontmatter, and a note without frontmatter gets one. An empty set removes the key.
- **Which side wins.** A tag added on either side is added to the other; one removed on either side is removed from the other. When both sides changed since the last run, both changes count. With no earlier agreement (the first run with tags, or a new pairing), the union of both sides goes to both.
- **Case.** Tags are compared without regard to case, as Obsidian does. A change of case alone is no change. The spelling written is the note's when the note has the tag, Notion's otherwise.
- **Waiting and held notes.** A note that waits (open in Obsidian), a page too large to read, and a page the run skipped keep their tags, on both sides, until a later run.
- **Preview and summary.** A dry run lists `set tags in Notion on …` and `write tags to …`. A run counts `N × tags set in Notion` and `N × tags written to notes`.
- **Two warnings.** Both are said every run, and the tags concerned are left alone:
  - `<note>: its frontmatter "tags" can't be edited safely (…); its tags are left alone`: see [Troubleshooting](troubleshooting.md#tags).
  - `<note>: the Notion tag "…" can't be an Obsidian tag; it stays in Notion only`.

## Renames

Renaming a note (in either app) rewrites every link to it in the other notes:

- the destination;
- the text of a link whose text was exactly the old title: `[Old](Old.md)` becomes `[New](New.md)`, and `Old › Heading` becomes `New › Heading`.

Links with other text keep it.

A Notion page link doesn't follow a rename the way a mention does. So the notes whose link text changed are pushed in the same run (counted under "update Notion from"; they aren't in the dry run's plan).

## Deletes

- Deleted notes go to Notion's trash or the vault's `.trash` folder.
- An edit on the other side wins over a delete.
- A note goes to `.trash` only when Notion confirms its page is in the trash or gone.

## Backups and records

- Every file the tool overwrites, moves or trashes is first copied to `~/.local/state/nopipeline/<profile>/backups/`.
- Sync state lives in `~/.local/state/nopipeline/<profile>/records/`, outside the vault.

See [Where things are stored](usage.md#where-things-are-stored).

## Drawings and canvases

Excalidraw drawings and canvases stay in Obsidian. Notion shows their embeds as plain `![[...]]` text (Notion keeps only web links), and they come back unchanged.

Images, PDFs, audio, video and other files sync (see [Attachments](attachments.md)), also when one ends a list item or a quote: it is the child block of that item or quote in Notion, and the note's line stays as written.

## Code blocks

### Code in quotes

A code block inside a quote (`> ```python`) is a code block inside the Notion quote, so its lines keep their indentation in both apps.

### Language names

Notion keeps a code block's language under its own name:

- `js` as `javascript`;
- `py` as `python`;
- `sh` and `Bash` as `bash`;
- `yml` as `yaml`;
- a block without a language, or with one Notion doesn't know (`Build log, part 2`), as `javascript`.

The tool reads both spellings as the same language, so a note keeps its own.

### Where a fence counts

A code fence counts where Obsidian (CommonMark) reads one:

- It is indented at most three spaces. In a list item, that is counted from the item's text. In a quote, it is counted after the tab that may follow `>`.
- A backtick fence's language has no backticks in it.

A fence on a list item's own line (`> - ```python`) opens a code block in the item, which Notion shows under an empty bullet. Left open, it runs to the end of its callout, quote or note.

Its code keeps its depth: the item's indentation comes off only where every line has it.

## Notion's formatting quirks

### Emphasis and escapes

Notion writes some formatting its own way:

- `__bold__` as `**bold**`;
- `_italic_` as `*italic*`;
- a lone `~` as `\~`;
- no backslash where it changes nothing (`C\# notes` as `C# notes`).

The tool writes those forms itself, so a line edited in Obsidian lands on its line in Notion. A line edited in Notion keeps the note's own `__bold__`.

It also writes these the way Notion holds them:

- a `*` that isn't emphasis as `\*` (Notion pairs stars more freely: `2 * 3 * 4` would make "3" italic);
- a code span with one backtick a side;
- an empty code block with one empty line.

### Automatic links

Notion makes links of bare URLs, `www.` hosts, emails and words that end like a domain (`script.py`, `notes.md`). The tool reads such a link as the word it was made of, so the note keeps its bare word both ways.

## Retries

A request Notion's servers fail with `502`, `503` or `504` is tried again three times (after 1, 2 and 4 seconds) before the run ends on it, unless repeating it could create a page or apply an edit twice.

## Notion content a note can't hold

Content a note can't hold comes to Obsidian as a link that opens it in Notion, as its text, or not at all. It stays as it is in Notion. This covers:

- child pages;
- inline databases;
- synced blocks;
- bookmarks and embeds;
- web videos;
- tables of contents;
- column layouts;
- files Notion hosts that the sync hasn't taken yet.

An edit that would delete such content is refused and reported. Make that change in Notion and undo it in Obsidian.

## Interrupted runs

A run cut short (a power cut, a refused edit) is finished by the next run. A note or page that changes while a run works on it is merged or waits for the next run.

Notes and sync records are flushed to the disk as they are written.
