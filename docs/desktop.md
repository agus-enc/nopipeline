# Desktop launcher, notifications and status note

The app-menu launcher, desktop notifications, the status note, and the `confirm` command. [Back to README](../README.md)

## Desktop launcher

On Linux desktops that read Desktop Entries (KDE, GNOME…), the launcher puts "nopipeline sync" in the app menu, so a sync can start from a click, with no terminal:

```bash
nopipeline launcher install            # or: node src/cli.ts launcher install
nopipeline launcher install --config ~/.config/nopipeline/trial.json
nopipeline launcher uninstall
```

### Install

- Install writes `~/.local/share/applications/nopipeline.desktop` (under `$XDG_DATA_HOME` if set) for the default profile.
- Another profile gets its own entry, `nopipeline-<profile>.desktop`, named "nopipeline sync (<profile>)".
- It prints the file's path and how to pin the entry: find "nopipeline sync" in the launcher, right-click → Pin to Task Manager.
- Installing again overwrites the tool's own earlier entry without asking.
- The install warns, without failing, when `notify-send` or `xdg-open` isn't on `PATH`.

### Which Node it uses

The entry runs the absolute path of the Node that ran the install on this folder's `src/cli.ts`, with the absolute `--config`. So it doesn't depend on `PATH`, `npm link` or the working folder.

The Node path is:

- the `node` on `PATH`, when that is the same file as the running Node and lives in `/usr/bin` or `/usr/local/bin` (so a distro's `node` link survives an upgrade);
- otherwise the running Node's own path.

If you move this folder, or a Node upgrade changes its path, run `launcher install` again.

### Actions

- Clicking the entry runs `sync --notify`.
- Right-click shows two more actions:
  - **Preview (dry run)** runs `sync --dry-run --notify`.
  - **Confirm held changes** runs `nopipeline confirm`. There is no dialog: the click is the confirmation, and it applies what the status note lists, with the same list rule (see [Confirm](#confirm)).

The result comes as a notification with an Open report button, and the status note holds the details.

The first real run only previews, and trashes over the limit are held. Both end with "Confirm from the menu", and clicking Confirm held changes applies exactly what the status note lists.

### Uninstall

Uninstall removes the entry only if it is one the tool wrote (it carries an `X-nopipeline` key). Otherwise it refuses and leaves the file.

## Automatic sync

`nopipeline auto install` sets up a systemd user timer, so the sync runs on its own. Systemd is the only supported setup.

```bash
nopipeline auto install                # or: node src/cli.ts auto install
nopipeline auto install --config ~/.config/nopipeline/trial.json
nopipeline auto uninstall
```

### What it installs

- `nopipeline-auto.service` and `nopipeline-auto.timer` in `~/.config/systemd/user/` (under `$XDG_CONFIG_HOME` if set). Another profile gets `nopipeline-auto-<profile>.service` and `.timer`.
- The timer wakes every 15 minutes (and once after a missed tick, for example after the laptop was off). The service runs `sync --auto` with the same Node as the launcher (see [Which Node it uses](#which-node-it-uses)).
- Install then reloads systemd and enables the timer. If systemd refuses (for example over SSH, with no user session), it says why, puts back what was there before (or removes what it wrote, on a first install) and exits `2`.
- The service stops a run that lasts over an hour (`TimeoutStartSec=1h`).
- Uninstall disables the timer and removes the two files, only if the tool wrote them (they carry an `X-nopipeline` comment). Otherwise it leaves them and says so.

### The first tick after installing

A profile that has synced before but has no `last-sync.json` yet (every profile, until it has finished a sync with this version) is due right away. So the first tick after `auto install`, within 15 minutes, runs a real sync if Notion is reachable and Obsidian is closed or its open tabs can be read. If you would rather watch the first run, run `nopipeline sync` yourself first.

### What is checked

Each tick runs these checks in order, and stops quietly at the first that fails:

1. The profile has records of an earlier sync. `--auto` never starts a first sync; do that by hand first.
2. The last finished sync is older than `autoSyncHours` (default 6). A failed run doesn't reset the clock, so it is retried at the next tick.
3. Obsidian is not running (Flatpak or native), or its open tabs can be read (see [Notes in use](#notes-in-use)).
4. `api.notion.com` can be reached within 5 seconds.
5. No other sync is running.

Each skip adds one line to `auto.log` in the profile's state folder (see [Where things are stored](usage.md#where-things-are-stored), which also lists `last-sync.json`, `auto-notified.json` and `auto-config-error.json`), which keeps its last 200 lines. The token is never written there.

### Notes in use

With Obsidian open, a run still goes ahead, but it leaves alone every note that is open in a tab or was edited in the last 5 minutes (and its Notion page). Those notes are listed under "Waiting" in the report and the status note, and they sync on a later run. A run that left notes waiting doesn't reset the `autoSyncHours` clock, so the timer tries again at the next tick, 15 minutes later. If Obsidian runs and its open tabs can't be read, the tick is skipped as `obsidian-open`, as before.

### What notifies

- A clean run: nothing.
- Notes that need a look, held trashes, or a failure: the same notification as a manual run, once. The same result on the next run doesn't notify again, so a broken token gives one popup, not one every 15 minutes. A clean run clears this.
- A profile that can't be loaded notifies once per distinct error; once it loads again, the same error notifies again.
- A popup that is never answered is given up on after 10 minutes, so it never stalls the timer. A notification that couldn't be shown (no notification server) is logged in `auto.log` and tried again at the next run.
- A skipped tick: nothing.

An automatic run never trashes over the limit and never applies a first sync: those stay held until you confirm them (see [Confirm](#confirm)).

### See it and stop it

```bash
systemctl --user list-timers 'nopipeline*'
journalctl --user -u nopipeline-auto.service
nopipeline auto uninstall
```

## Notifications

`--notify` ends a run with a desktop notification, sent with `notify-send`. It says one of:

- what changed;
- what needs a look;
- why the run stopped or failed;
- that another sync is already running.

Most of them have an **Open report** button. It opens the status note in Obsidian by its file path, through `xdg-open`, as `obsidian://open?path=…`, so the vault's name doesn't matter.

The `nopipeline` process waits for the button. A run started from a terminal with `--notify` returns only when the notification is clicked, dismissed or expires.

Without `notify-send` the run is unaffected and the log says so.

## Status note

Every run, a dry run and a failed run included, writes a note in the vault with its result, so you can read what happened without a terminal.

By default it is `nopipeline status.md` at the vault root. Set `statusNote` in the profile to move it, or to `null` for none (see [Configuration](configuration.md#keys)).

### Ownership

It starts with the frontmatter `nopipeline: status`. The tool writes the file only when it doesn't exist or already has that marker.

If a note of yours is at that path, it is left alone and the run says so (terminal, log and notification). Set `statusNote` to another path.

### What it holds

It holds a heading and a one-line result, for example:

- "Synced … — 12 changes, 2 notes need a look."
- "Preview — 5 changes, nothing was written."
- "Stopped — 22 notes would be trashed. Nothing was trashed."
- "First run of this profile — preview only."
- "Failed — …"

Under "Needs a look", when there is something:

- Each skipped note, with a link that opens it in Obsidian, a link to its Notion page when known, the reason, and one line on what to do (the same advice as in [When a note is skipped](troubleshooting.md#when-a-note-is-skipped)).
- Each conflict, with links to the note and its conflict copy.
- The trashes held back, with how to go ahead (the launcher's Confirm held changes, or `nopipeline confirm`).

Then comes what changed (or, for a preview, the plan), and a footer with the time, the profile and where the full output is.

### It is never synced

- It is rewritten whole on every run, so edits to it are lost.
- The vault scan skips every `.md` file whose frontmatter has the line `nopipeline: status`, at any path. So it is never a note, never in Notion, and its links and attachment names count for nothing.
- An old status note left in the vault after you move it or set `statusNote` to `null` is ignored the same way. Delete it if you like.
- A note of yours that happens to carry that line is skipped too.

### When the profile can't be read

A profile that can't be read has no vault to write to. That failure is only on the terminal and, with `--notify`, in the notification.

## Confirm

```bash
nopipeline confirm
```

applies what the last real run held (see [held changes](usage.md#held-changes)).

It never asks: running it (or clicking **Confirm held changes** in the launcher) is the confirmation, and it applies what the status note lists.

It syncs as `sync --notify` would, with `--yes` if the held run was a first-run preview, and with the held trashes allowed over the limit.

### The list rule

That holds only for the notes and attachments the last run listed.

- If the run now would trash anything that wasn't on the list, nothing over the limit goes ahead. The run holds again with a new list, and the notification says so.
- A trash that dropped off the list (a page restored, an edit that beat a delete) is fine.

With nothing held it says "Nothing is waiting for confirmation."

Exit code: the sync's own, `0` for nothing held.
