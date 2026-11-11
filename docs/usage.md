# Usage

The commands, their options, exit codes, notes on how a run behaves, and where things are stored. [Back to README](../README.md)

## Commands and options

Everything below is written as `nopipeline …`, which works from the Fedora package or after `npm link` (see [Setup](setup.md#from-a-clone-npm-link)). From a clone, `node src/cli.ts …` does the same (`npm run sync -- …` and `nopipeline setup` also work from the clone's folder).

### `sync`

```bash
nopipeline sync --dry-run
```

shows what a sync would change. It changes nothing in your vault's notes or in Notion. It still writes the status note and `last-run.log`, and it never writes `held.json`.

The first real run on a profile also only previews, until you add `--yes`:

```bash
nopipeline sync --yes
```

After that, `nopipeline sync` syncs both ways.

| Option | What it does |
|---|---|
| `--dry-run` | Shows what a sync would change. Changes nothing in the notes or in Notion; still writes the status note and `last-run.log`. |
| `--yes` | Confirms the first real run on a profile, which otherwise only previews. |
| `--allow-mass-trash` | Lets a run trash more than `massTrashLimit` (see below). |
| `--config <file>` | Uses another profile. |
| `--notify` | Ends the run with a desktop notification (see [Notifications](desktop.md#notifications)). |
| `--auto` | For a timer: runs only when due, skips quietly, never starts a first sync, and notifies a new result once. Not with `--yes`, `--dry-run` or `--allow-mass-trash`. See [Automatic sync](desktop.md#automatic-sync). |

A run that would trash more notes than `massTrashLimit`, or move more attachments to `.trash` than that limit, stops before trashing anything. Check the plan and rerun with `--allow-mass-trash`. The limit is a profile key, default `10` (see [Configuration](configuration.md#keys)).

### `confirm`

```bash
nopipeline confirm
```

applies what the last real run held. See [Confirm](desktop.md#confirm).

### `setup`

```bash
nopipeline setup
```

asks the questions in [Setup](setup.md#4-run-the-setup) and writes the profile. `--config <file>` writes it somewhere else.

### `launcher install` and `launcher uninstall`

```bash
nopipeline launcher install
nopipeline launcher uninstall
```

put "nopipeline sync" in the app menu, or remove it. See [Desktop launcher](desktop.md#desktop-launcher).

### `auto install` and `auto uninstall`

```bash
nopipeline auto install
nopipeline auto uninstall
```

set up, or remove, a systemd user timer that runs `sync --auto` every 15 minutes. Use `--config <file>` for another profile. See [Automatic sync](desktop.md#automatic-sync).

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Everything synced, or a `--dry-run` preview. |
| `1` | The run finished but something needs a look (conflicts, skipped notes, notes rewritten whole, held trashes), or a first run stopped at its preview. |
| `2` | The run failed. |

With `--auto`, `0` also means the run wasn't due or was skipped, and notes that need a look and held trashes exit `0` too (they notify instead). `2` means only a failure, and `1` never occurs.

## Notes on how a run behaves

- **The second run is slow.** The run after the first one reads every page once more (about 6 minutes for 1,000 pages, at Notion's rate limit), so a slow second run isn't a hang. Later runs read only pages edited since.
- **Notes in use wait.** A note that is open in a tab in Obsidian, or was edited in the last 5 minutes, is left alone by a run, together with its Notion page, and listed under "Waiting". Obsidian can save an open note over a file a run just wrote, so these notes sync on a later run, once you close them. A manual run says how many waited (exit code `0`, since nothing is wrong). Don't edit a note in either app while a run is working on it: a change during the run is merged or left for the next run.
- **Property checks.** Before planning, every run checks the database's properties. If the title property, the "Links to" relation or the projects relation was renamed, deleted or changed type in Notion, the run stops before changing anything (exit code `2`) and says which property and what to do. You can rename it back, or set `titleProperty` / `linksToProperty` / `projectsRelation` in the profile. Otherwise one renamed column would rename or move every note.

## Where things are stored

Each profile keeps its files in `~/.local/state/nopipeline/<profile>/`, outside the vault.

| What | Where |
|---|---|
| Backups | `backups/`. Every file the tool overwrites, moves or trashes is first copied there. |
| Sync records | `records/`. The sync state. |
| Run log | `last-run.log`. |
| Held changes | `held.json`. |
| Automatic sync log | `auto.log`. One line per skipped or undelivered automatic run, the last 200 lines. |
| When the last sync ended | `last-sync.json`. Written by a sync that finished; `--auto` reads it to decide whether a run is due. |
| What an automatic run already notified | `auto-notified.json`. |

The automatic sync also keeps `auto-config-error.json` in `~/.local/state/nopipeline/` (not in a profile's folder): the last error notified for each profile file that couldn't load.

### The run log

Every run writes everything it printed to `last-run.log`, replacing the previous one. The detail is there when a run came from the launcher and had no terminal. The terminal output is unchanged.

### Held changes

A real run that held something back (the first run's preview, or trashes over `massTrashLimit`) writes `held.json` with exactly what it held.

- A real run that held nothing removes it.
- A `--dry-run` and a run that fails leave it as it was.

[`confirm`](desktop.md#confirm) applies what is in it.
