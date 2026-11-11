# nopipeline

Two-way sync between an Obsidian vault and a Notion database.

Links between notes are Markdown links in the vault (`[Title](Title.md)`) and page links in Notion (grey, underlined text that opens the page), so a zettelkasten keeps working in both apps. A `[[link]]` you type is turned into a Markdown link on the next run.

Optionally, the vault's folders and a Notion "projects" database follow each other (see [Folders and projects](docs/folders-and-projects.md)).

## What you need

- Node 22.22 or newer. It runs the TypeScript sources directly, so there is no build step.
- An Obsidian vault (a folder that holds a `.obsidian` folder).
- A Notion database for the notes, with a title property (usually `Name`).

Optional extras the setup looks for:

- A relation from the notes database to itself. The sync fills it with the pages each page links to.
- A multi-select property for tags (`Tags` by default). The sync keeps it in step with each note's frontmatter `tags`.
- A second database for projects, with a relation to it from the notes. This is what makes folders and projects follow each other.

The tool never creates or changes a database in Notion. It links the ones you already have, and `setup` only reads.

## Install and set up

1. **Create a Notion connection.** In Notion go to Settings → Connections → Develop or manage integrations, and create an internal connection with the capabilities *Read content*, *Update content* and *Insert content*. Copy its token.
2. **Connect it to your databases.** Open the notes database (and the projects database, if you use one). In each, choose `•••` → Connections and add your connection.
3. **Install.**

   On Fedora, from Copr:

   ```bash
   sudo dnf copr enable chipp/nopipeline
   sudo dnf install nopipeline
   ```

   Other Linux: from source. The project's `.npmrc` blocks install scripts and pins exact versions:

   ```bash
   git clone https://github.com/agus-enc/nopipeline.git
   cd nopipeline
   npm ci
   npm audit signatures
   ```

   From a clone, run every command below as `node src/cli.ts …` (for example `node src/cli.ts setup`) from that folder, instead of `nopipeline …`.

4. **Run the setup.** It asks a few questions and writes a profile file:

   ```bash
   nopipeline setup
   ```

5. **In Obsidian**, turn off Settings → Files and Links → **Use [[Wikilinks]]**.

The details of each step, and the warnings `setup` can print, are in [Setup](docs/setup.md).

## A safe first run

Preview first. This shows what a sync would change. It changes nothing in your notes or in Notion; it only writes the status note and `last-run.log`:

```bash
nopipeline sync --dry-run
```

The first real run on a profile also only previews, until you add `--yes`:

```bash
nopipeline sync --yes
```

After that, `nopipeline sync` syncs both ways.

Before you use your real vault and database, consider a trial on copies. See [Try it safely first](docs/setup.md#try-it-safely-first).

From a clone, `node src/cli.ts sync …` and `npm run sync -- …` do the same. Optional: `npm link` in the clone puts a `nopipeline` command on your path.

## Updating

`nopipeline --version` shows the version you have. The changes in each version are in [CHANGELOG.md](CHANGELOG.md).

On Fedora, updates come with the system:

```bash
sudo dnf upgrade
```

To go back, `sudo dnf downgrade nopipeline` installs the previous build, while Copr still has it. The changelog says if going back past a version is unsafe.

Before you remove the package with `dnf remove nopipeline`, remove what it set up: run `nopipeline auto uninstall` and `nopipeline launcher uninstall`, once for each profile you installed them for (add `--config <file>` for a profile other than the default). The package can't do that for you, because those files live in your home folder.

From a clone, `git pull`, then `npm ci` and `npm audit signatures` again. The launcher and timer point at the clone, so they need no reinstall unless you move the folder.

## Documentation

- [Setup](docs/setup.md): Notion connection, databases, install, the `setup` questions, Obsidian's Wikilinks setting, `npm link`, and a trial on copies.
- [Configuration](docs/configuration.md): the profile file, every key and its default, and where each profile keeps its state.
- [Usage](docs/usage.md): commands and options, exit codes, notes on how a run behaves, and where things are stored.
- [Desktop launcher, notifications, status note and automatic sync](docs/desktop.md): the app-menu entry, `--notify`, the status note, `confirm`, and the systemd timer for `--auto`.
- [How the sync treats your notes](docs/how-sync-works.md): ids, edits, merges, conflict copies, links, renames, deletes, backups and Notion's quirks.
- [Folders and projects](docs/folders-and-projects.md): how vault folders and Notion projects follow each other.
- [Attachments](docs/attachments.md): images, PDFs, audio, video and other files, and how to rename the attachment folder.
- [Troubleshooting](docs/troubleshooting.md): why a note is skipped, what to do, and known limitations.
- [Development](docs/development.md): checks, probes and live tests, releases, and the Fedora package.

## License

MIT, see [LICENSE](LICENSE).
