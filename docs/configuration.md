# Configuration

The profile file: where it is, every key, the defaults, and where each profile keeps its state. [Back to README](../README.md)

## The profile

`setup` writes a JSON file, by default `~/.config/nopipeline/config.json`. You can edit it by hand:

```json
{
  "vaultPath": "~/Documents/<your vault>",
  "dataSourceId": "<the notes database's data source id>",
  "projectsRelation": "Project",
  "tokenFile": "~/.config/nopipeline/token"
}
```

Use `--config <file>` on a command to use another profile (see [Usage](usage.md#commands-and-options)).

## Keys

| Key | Meaning |
|---|---|
| `vaultPath` | The vault folder (absolute, or starting with `~/`). |
| `vaultName` | The vault's name for `obsidian://open?vault=…` links. Default: the vault folder's name. |
| `dataSourceId` | The notes database's data source id. |
| `titleProperty` | The notes database's title property. Default `Name`. |
| `linksToProperty` | The notes database's relation to itself that the sync fills with the pages each page links to. Absent: `Links to`. `null`: off. The sync remembers, per page, which entries it added; if you later point this at a different relation it can remove entries there that match those remembered ids, so check a new relation's contents first. |
| `tagsProperty` | The notes database's multi-select property that mirrors each note's frontmatter `tags`. Absent: `Tags`. `null`: tags are off. The property must exist and be a multi-select; if it is missing or another type, the run says so in one line and leaves tags alone. See [Tags](how-sync-works.md#tags). |
| `projectsRelation` | The notes database's relation to the projects database. Absent: no folder mapping (notes keep their vault folders, new Notion pages go to the default folder). See [Folders and projects](folders-and-projects.md). |
| `pageIcon` | An icon for pages the sync creates: an emoji string, or `{ "name": "…", "color": "…" }` for a Notion icon. Absent: no icon. Setup doesn't ask for it. Projects never get it. |
| `inboxFolder` | The default folder. Default `0-In`. |
| `massTrashLimit` | How many notes a run may trash, and how many attachments it may move to `.trash`, before it stops. The two are counted separately against the same limit. Default `10`. See [Usage](usage.md#commands-and-options), `--allow-mass-trash`. |
| `statusNote` | The vault-relative path of the status note (see [Status note](desktop.md#status-note)), ending in `.md`, outside dot-folders. Default `nopipeline status.md`. `null`: no status note. Setup doesn't ask for it. |
| `autoSyncHours` | How many hours after the last finished sync an automatic run is due (see [Automatic sync](desktop.md#automatic-sync)). A positive number, decimals allowed. Default `6`. |
| `tokenFile` | The private file that holds the token; `NOTION_TOKEN` in the environment takes precedence. |

## Unknown keys

Unknown keys are refused. The one exception is `folderProperty` from older profiles, which is ignored with a note.

## State folder

Each profile keeps its state in `~/.local/state/nopipeline/<profile>/`, tied to its vault and database, so two profiles can never share records.

What is in that folder is listed in [Usage](usage.md#where-things-are-stored).
