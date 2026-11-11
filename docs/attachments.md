# Attachments

How images, PDFs, audio, video and other files sync, and how to rename the attachment folder. [Back to README](../README.md)

Images, PDFs, audio, video and any other file sync both ways. A file cited alone on its line is a Notion block holding the uploaded file, and a file block pasted in Notion is downloaded and cited.

## What syncs, and the form decides how it shows

A citation of a vault file that is not a note, canvas, base or drawing, standing alone on its line or alone after a list marker, becomes a block at the same place.

By its form and the file's extension (any case):

| In Obsidian | In Notion |
|---|---|
| embed `![[x.png]]`, `![[x.png\|300]]`, `![a caption](x.png)` of an image (`png jpg jpeg gif webp avif svg heic tif tiff ico bmp`) | image block |
| embed `![[Manual.pdf]]`, `![[Manual.pdf#page=3]]`, `![caption](Manual.pdf)` | PDF block |
| embed of audio (`flac m4a mp3 ogg wav 3gp`) | audio block |
| embed of video (`mkv mov mp4 ogv webm`) | video block |
| link `[[minutes.docx]]`, `[[minutes.docx\|Minutes]]`, `[Minutes](minutes.docx)` of any file, images included; or an embed of any other file (`docx`, `xlsx`, `zip`…) | file block (a download link) |

The text after the `|` (not a size) and a Markdown link's text are the caption. A link whose text is just the file name sends none.

### Images that end a list item or a quote

A citation on its own line that ends a list item's text, or a quote's text after some text, becomes a child block of that item or quote in Notion, indented under it. The note keeps its own layout: the line can sit at the left margin, indented, or after a blank `>` line, and it is never rewritten to match.

```
- item
![[x.png]]
```

(an item with a block under it) and

```
> text
> ![[x.png]]
```

(a quote with a block under it). Several such lines at the end each become a child, in order. This holds for PDFs, audio, video and files too. A child added in Notion under an item or quote comes into the note one tab deeper than the item, or as a line of the quote.

A page synced earlier with such a line as text gets the block on the next run, or on the one after it when a Notion edit is pending (that run pulls the edit first). The plan says "turn the attachment citations already synced into Notion blocks…". Any edit made in Notion is kept.

### Coming back from Notion

- An image, PDF, audio or video block is written as an embed `![caption](name)`.
- A file block is written as a link `[caption or file name](name)`.
- Both use the shortest path that names the file.

A line Notion didn't change is never rewritten. So a note's own `![[Manual.pdf#page=3]]` or `[[minutes.docx|Minutes]]` stays byte for byte when Notion edits something else. One edited in Notion comes back in the Markdown form, without a page or a size (Notion's blocks have none).

A block whose kind differs from what its line's form calls for (an image block holding a docx) is replaced by the right block when the line is next written.

Web media (`![x](https://…)`, YouTube videos, web previews) stay web links: nothing is uploaded or downloaded.

## One folder for all of them

Downloads go to the attachment folder (`attachmentFolderPath` of `.obsidian/app.json`, the vault root if it isn't set) under the name Notion gives the file.

- A name already taken by other bytes gets a number (`Manual 1.pdf`).
- The very same bytes reuse the file.
- A file is never overwritten.
- An `attachmentFolderPath` relative to each note (`./`, `./pics`) has no single place in the vault, so it counts as the vault root.

A hosted file whose name has no extension, or one of a note, canvas, base or drawing, is not downloaded. Its page goes on syncing and the note keeps a link to Notion. Every run lists it under the warnings with what to do: rename it in Notion with the extension of its kind.

## A dry run lists them

`--dry-run` prints an "Attachments" block with a line for each file a real run would:

- move (`moved: old → new`);
- upload (`upload Assets/attachments/Manual.pdf for Note.md`, once per file; a file whose earlier upload is still good is not listed);
- download;
- replace (`update file …`);
- move to `.trash`.

The counts are in its header. A real run's summary says "uploaded N files".

The uploads are worked out from the text read in the dry run, so a page written differently by the real run can differ.

## A changed file

When a file changes in the vault (found by its content hash), every page that shows it gets the new file, in the block it already has. The page's text stays as it is. The summary lists "updated file … on N pages".

## Unused attachments go to `.trash`

A file of any kind in the attachment folder that was cited at the end of the last run and is cited by nothing now is moved to the vault's `.trash` folder. A number is added if the name is taken there. Nothing is deleted for good.

A file counts as cited if its name, written or URL-encoded, appears anywhere in a `.md` or `.canvas` file outside `.trash` and the other dot-folders (symlinked folders included). That covers:

- notes;
- conflict copies;
- drawings;
- canvases.

A note this run skipped or held back still counts what it last synced.

- Files that were never cited, and files outside the attachment folder, are never touched.
- The first run with a kind of file moves nothing of that kind.
- A run that would move more than `massTrashLimit` files (all kinds together) moves none and says so. Rerun with `--allow-mass-trash`.

## Moved or renamed files are recognized by their bytes

When a file the sync has uploaded or downloaded is gone from its path, and a vault file with the same bytes (sha256) is at a path the sync doesn't know, the sync's records follow it ("moved: old → new" in the run). Nothing is uploaded or downloaded, and pages and notes stay as they are.

- A file with another name than the old one is taken only when no note (or canvas) names the old file any more, because Obsidian renamed it and rewrote the citations.
  - While a note still names the old file, a copy of its bytes under another name is another file and is left alone.
  - The old file is then restored from Notion the next time its page is read, as for any deleted one.
- The moved file counts as cited only once a note is seen citing it, so a copy nobody cites is never moved to `.trash` by this.
- If several files tie, the one with the old file's name wins. If it is still ambiguous, the run stops before changing anything and says which files tie.
- Files never synced (`kx.png`) are candidates only; they are never moved.

## Renaming the attachment folder

For example `Attachments` to `Files`. This works because notes cite files by name only.

Before you start, check that no note writes the old folder's path, because a citation with the old path would name a file that is no longer there:

```bash
grep -r "Attachments/" <vault> --include="*.md" --include="*.canvas"
```

Then (from a clone, `nopipeline …` below is `node src/cli.ts …`):

1. **Run an ordinary sync first.** Run `nopipeline sync` and confirm it ends with nothing left unswitched:
   - no `image_not_switched` and no placeholder warning in its output;
   - `"unattached": []` in `images.json` of the state folder.

   A placeholder left unattached under the old path would read as a Notion edit after the move.
2. **Close Obsidian**, so it doesn't write the old folder or rewrite citations meanwhile.
3. **Back up the vault, and list the notes inside the attachment folder:**

   ```bash
   find Attachments -name '*.md'
   ```

   `mv` takes them along, and a synced note whose folder changes is a move in Notion (its project changes). Either:
   - move them out first in Obsidian and let one ordinary sync carry the move; or
   - expect each of them as a "rename/move in Notion" line in the plan of step 6 and in the summary of step 7, and nothing else.
4. **Move the folder:**

   ```bash
   mv Attachments Files
   ```

5. **Set `attachmentFolderPath`** in `.obsidian/app.json` to `Files`.
6. **Preview:** `nopipeline sync --dry-run`.
   - The plan should say there is nothing to do (apart from the notes of step 3 you chose to leave in the folder).
   - The only lines expected under "Attachments" are "moved:" ones, one per synced file.
   - Anything else (an upload, a download, a note to update) means something is not as described, so stop and look.
7. **Run** `nopipeline sync`. Its summary should read "Everything was already in sync." (plus the notes of step 3, if any) followed by the same "moved:" lines. Nothing is uploaded, downloaded or rewritten.

## Limits

- A file over 20 MB that the sync has never uploaded stays literal text in Notion with a warning. A file Notion already hosts (say a video pasted in Notion and downloaded) is never turned back into text for its size. Downloads have no limit.
- A file Notion refuses to take (a type or size it doesn't accept, such as `.3gp`) leaves its line literal and is listed under the warnings every run until the citation changes.
- A PDF's `#page=` and `#height=`, and an image's `|300`, stay in Obsidian only.

## A file Notion hosts that can't be downloaded

An attachment the run can't download (Notion refuses the file) holds its page and note, listed under "Skipped" as `download_failed`, until it can be downloaded. If it never can, replace the file in Notion. See [When a note is skipped](troubleshooting.md#when-a-note-is-skipped).

## Edits beside a hosted file on a page with Notion-only blocks

Notion can't find a Notion-hosted file's line to edit it in place. So an edit that removes a file, changes its caption or sits between two files is written by sending the page's text whole.

A page that also holds blocks a note can't hold (embeds, child pages…) refuses that (`unsupported_blocks`, the reason mentions the files). Either:

- make the same edit in Notion (the next run then records both as synced); or
- undo it in Obsidian.

Edits that can use a text line next to the file are unaffected.

## What stays text

These stay literal text in Notion:

- a citation sharing its line with other text (a link inside a sentence is text like any other);
- a citation that doesn't end its list item or quote (text follows it), or that is all a quote holds, and any citation in a callout or a table cell, or a task whose whole text is the citation (a task's trailing citation becomes its child);
- a citation of a file over 20 MB;
- a citation of a file the vault doesn't have (silently: no warning, and it becomes a block as soon as the file is in the vault).

All but the last are listed once under the run's warnings, with the line, so it can be moved to its own line.
