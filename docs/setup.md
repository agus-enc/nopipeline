# Setup

How to connect nopipeline to Notion and Obsidian, install it, and try it on copies first. [Back to README](../README.md)

## 1. Create a Notion connection

In Notion go to Settings → Connections → Develop or manage integrations.

Create an internal connection with the capabilities *Read content*, *Update content* and *Insert content*. Copy its token.

## 2. Connect it to both databases

Open the notes database and, if you use one, the projects database.

In each one choose `•••` → Connections and add your connection. A database the connection isn't connected to is invisible to the tool.

## 3. Install

Install the package for your distribution from the OBS repository: Fedora, Debian/Ubuntu (which needs Node.js from NodeSource first) and Arch are covered, with the exact commands, in the [README](../README.md#install-and-set-up). If you installed from Copr before, the README has the short switch-over steps.

This puts a `nopipeline` command on your path. Updates come with the system's normal upgrade (see [Updating](../README.md#updating)).

### Other Linux: from source

The project's `.npmrc` blocks install scripts and pins exact versions:

```bash
git clone https://github.com/agus-enc/nopipeline.git
cd nopipeline
npm ci
npm audit signatures
```

From a clone, run the commands below as `node src/cli.ts …` from that folder, or `npm run setup` and `npm run sync -- …`. The next section's `nopipeline` works only from the package or after `npm link`.

## 4. Run the setup

```bash
nopipeline setup
```

`nopipeline setup --config <file>` writes the profile somewhere else. The profile is described in [Configuration](configuration.md).

### What it asks

It asks, in order:

1. **The token.**
   - It is typed without echo, or taken from `NOTION_TOKEN` in the environment.
   - If `NOTION_TOKEN` is set, it first asks whether to use it.
   - If a token file already exists, it asks whether to reuse it.
   - The token is saved in a private file, mode 600.
2. **Which of the databases the connection can see is your notes database.**
3. **Which is your projects database, or `none`.** If you answer `none`, it reminds you to connect the connection to the projects database in Notion (`•••` → Connections), if it isn't listed.
4. **Which relation is the projects relation**, when the notes database has several relations to the projects database.
5. **Whether to use the self-relation it found as "Links to".**
   - Accept or decline.
   - With several, pick one by number or `none`.
   - Without one, links are still synced as text and the relation is just left alone.
   - Separately, it checks the database for a multi-select property named `Tags` (see below) and notes when it is missing; it never asks about it.
6. **The path of your vault.**
7. **The vault's name as Obsidian shows it.**
   - The suggestion is the folder's name.
   - `obsidian://open` links use it.
   - The profile gets a `vaultName` only when it differs from the folder's name.
8. **The default folder** where notes created in Notion land. The suggestion is `0-In`.

When the profile file already exists, it asks before overwriting it, and keeps its `pageIcon` and `massTrashLimit` if it has them.

Answers can also be piped in, one per line.

### Adding the Tags property

To sync tags, add a property of type **Multi-select** named `Tags` to the notes database in Notion (or another name, set as `tagsProperty` in the profile; see [Configuration](configuration.md)). Add it before the first run that should sync tags. `setup` only reads the database, so it will not create it; if it is missing, setup and every run say so and leave tags alone. See [How sync works](how-sync-works.md#tags).

### What it checks

It checks everything before writing the profile, and it never writes to Notion.

It prints warnings for what it can see:

- Obsidian's "Use [[Wikilinks]]" is still on.
- A database the connection can't read.
- A projects database without a default template (projects will then be created blank).

If something is missing in Notion, it tells you what to add there. Run it again afterwards.

## 5. Set up Obsidian

Turn off Settings → Files and Links → **Use [[Wikilinks]]**.

Typing `[[` still opens the list of notes, and picking one then inserts a Markdown link, `[Title](Title.md)`, the form the vault keeps. A `[[link]]` typed out in full is turned into that form by the next sync.

With the setting on, Obsidian writes `[[links]]` and the sync converts them on every run.

## 6. Preview, then run

See [Usage](usage.md). The first real run on a profile only previews until you add `--yes`.

## From a clone: `npm link`

The package already provides the `nopipeline` command. From a clone, `npm link` in the clone's folder puts a `nopipeline` command on your path, so `nopipeline setup` and `nopipeline sync --dry-run` work from anywhere.

For a menu entry instead, see [Desktop launcher](desktop.md#desktop-launcher).

Everything also works as `node src/cli.ts …` or `npm run sync -- …` from the clone.

## Try it safely first

Before pointing it at your real vault and database, try a trial profile on copies.

1. Make a copy of the vault.
2. Create a scratch Notion notes database (and projects database) with the same properties, connected to the same Notion connection.
3. Make a second profile, say `~/.config/nopipeline/trial.json`, by running:

   ```bash
   nopipeline setup --config ~/.config/nopipeline/trial.json
   ```

4. If the copy's folder has another name than the vault (`My Vault copy`), add `"vaultName": "My Vault"` to the trial profile. Then `obsidian://open?vault=My%20Vault…` links still count as links into the vault.
5. Run the sync steps from [Usage](usage.md) with `--config ~/.config/nopipeline/trial.json`. Edit on both sides, and check the results in both apps.
6. Only then run it on the real pair, starting with `--dry-run`.
