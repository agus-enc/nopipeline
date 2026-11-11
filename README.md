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

   The packages come from a repository on the [openSUSE Build Service](https://openbuildservice.org/) (OBS). Add it once; after that the system's normal upgrade brings new versions. The commands below use the OBS project `home:<user>:nopipeline`; the release notes of each version show the same commands.

   **Fedora (43, 44).** Fedora's own Node.js is enough:

   ```bash
   sudo dnf config-manager addrepo --from-repofile=https://download.opensuse.org/repositories/home:/<user>:/nopipeline/Fedora_$(rpm -E %fedora)/home:<user>:nopipeline.repo
   sudo dnf install nopipeline
   ```

   If `dnf config-manager` is not available, install the plugin first (`sudo dnf install dnf5-plugins` on current Fedora).

   *Already using the Copr repository?* Switch to this one and turn Copr off, so only one of the two is enabled (both ship the same package):

   ```bash
   sudo dnf copr disable chipp/nopipeline
   ```

   Then add the OBS repository as above; `sudo dnf upgrade` takes the OBS build. Copr keeps building for now, so nothing breaks if you wait.

   **Debian, Ubuntu and derivatives.** The Node.js that Debian and Ubuntu ship can't run nopipeline: it is built without TypeScript support. First install Node.js 22.22 or newer from [NodeSource](https://github.com/nodesource/distributions) and follow their instructions. The `nopipeline` command tells you if it finds the wrong Node. Then add the repository. Set `dist` in the first command to `Debian_13`; on Ubuntu use `xUbuntu_24.04` or `xUbuntu_26.04`. For Linux Mint, Pop!_OS and other Ubuntu derivatives use the repository of the Ubuntu release they are based on; for other Debian derivatives use `Debian_13`. The package is architecture-independent and only needs `nodejs (>= 22.22)`.

   Download the key first and check its fingerprint before you trust it: `gpg --show-keys` must print the 40 hex characters in [`packaging/obs-signing-key.fingerprint`](https://github.com/agus-enc/nopipeline/blob/main/packaging/obs-signing-key.fingerprint). Only then install it and add the repository:

   ```bash
   dist=Debian_13
   curl -fsSL https://download.opensuse.org/repositories/home:/<user>:/nopipeline/$dist/Release.key -o /tmp/nopipeline.key
   gpg --show-keys /tmp/nopipeline.key      # compare the fingerprint with the file above
   sudo gpg --dearmor --yes -o /usr/share/keyrings/nopipeline-archive-keyring.gpg /tmp/nopipeline.key
   sudo tee /etc/apt/sources.list.d/nopipeline.sources <<EOF
   Types: deb
   URIs: https://download.opensuse.org/repositories/home:/<user>:/nopipeline/$dist/
   Suites: ./
   Signed-By: /usr/share/keyrings/nopipeline-archive-keyring.gpg
   EOF
   sudo apt update && sudo apt install nopipeline
   ```

   **Arch and derivatives.** Arch's own `nodejs` works. Add this to `/etc/pacman.conf`:

   ```ini
   [home_<user>_nopipeline_Arch]
   Server = https://download.opensuse.org/repositories/home:/<user>:/nopipeline/Arch/$arch
   ```

   then import the repository key, trust it, and install. `<fingerprint>` is the 40 hex characters in [`packaging/obs-signing-key.fingerprint`](packaging/obs-signing-key.fingerprint); after the import, `sudo pacman-key --finger <fingerprint>` must find that key before you sign it:

   ```bash
   curl -fsSL "https://build.opensuse.org/projects/home:<user>:nopipeline/signing_keys/download?kind=gpg" | sudo pacman-key --add -
   sudo pacman-key --lsign-key <fingerprint>
   sudo pacman -Syu nopipeline
   ```

   The package does not add the repository by itself, and it keeps the repository key up to date. Removing the Arch package leaves the key trusted; remove it with `sudo pacman-key --delete <fingerprint>`.

   Other Linux, or to hack on it: from source. The project's `.npmrc` blocks install scripts and pins exact versions:

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

With a package, updates come with the system's normal upgrade: `sudo dnf upgrade`, `sudo apt update && sudo apt upgrade`, or `sudo pacman -Syu`.

To go back to an older version: `sudo dnf downgrade nopipeline` (while the repository still has it), `sudo apt install nopipeline=<version>` (see `apt list -a nopipeline`), or reinstall an older package from the pacman cache with `sudo pacman -U`. The changelog says if going back past a version is unsafe.

Before you remove the package (`dnf remove`, `apt remove` or `pacman -R`), remove what it set up: run `nopipeline auto uninstall` and `nopipeline launcher uninstall`, once for each profile you installed them for (add `--config <file>` for a profile other than the default). The package can't do that for you, because those files live in your home folder.

Removing the package does not remove the repository you added. Remove it too, or the next update check complains about it:

- **Debian, Ubuntu:** `sudo rm /etc/apt/sources.list.d/nopipeline.sources` (it points at a keyring that goes away with the package, so `apt update` would fail), then `sudo apt update`.
- **Arch:** delete the `[home_<user>_nopipeline_Arch]` section from `/etc/pacman.conf` (and the key, see above).
- **Fedora:** delete the `.repo` file that `dnf config-manager addrepo` saved in `/etc/yum.repos.d/` (`ls /etc/yum.repos.d | grep nopipeline`). To keep the file and only switch the repository off, use `sudo dnf config-manager setopt <repo id>.enabled=0`.

From a clone, `git pull`, then `npm ci` and `npm audit signatures` again. The launcher and timer point at the clone, so they need no reinstall unless you move the folder.

## If the repository key has expired

The repository is signed with a key that OBS renews about every two years, and each new package version carries the renewed key, so a system that keeps upgrading never notices. If you did not upgrade for a long time, the update fails with an expired-key error (`EXPKEYSIG` from apt, a signature error from dnf or pacman). Refresh the key once, then upgrade as usual:

- **Debian, Ubuntu:** download the key again. Set `dist` to the same value as when you installed (`Debian_13`, `xUbuntu_24.04` or `xUbuntu_26.04`); a fresh shell does not have it. The old keyring is only replaced when the download worked:

  ```bash
  dist=Debian_13
  curl -fsSL https://download.opensuse.org/repositories/home:/<user>:/nopipeline/$dist/Release.key -o /tmp/nopipeline.key &&
    gpg --show-keys /tmp/nopipeline.key &&
    sudo gpg --dearmor --yes -o /usr/share/keyrings/nopipeline-archive-keyring.gpg /tmp/nopipeline.key
  ```

  Compare the fingerprint `gpg --show-keys` prints with [`packaging/obs-signing-key.fingerprint`](https://github.com/agus-enc/nopipeline/blob/main/packaging/obs-signing-key.fingerprint).

- **Fedora:** `sudo dnf clean all`, then upgrade again; dnf asks to import the repository key. If it still says the key expired, remove the old copy first (`rpm -qa 'gpg-pubkey*'` lists them; `sudo rpm -e <name>` removes one) and upgrade again.
- **Arch:** `curl -fsSL "https://build.opensuse.org/projects/home:<user>:nopipeline/signing_keys/download?kind=gpg" | sudo pacman-key --add -`

These commands follow how each tool is documented; they have not been tried against a real expired key yet.

## Documentation

- [Setup](docs/setup.md): Notion connection, databases, install, the `setup` questions, Obsidian's Wikilinks setting, `npm link`, and a trial on copies.
- [Configuration](docs/configuration.md): the profile file, every key and its default, and where each profile keeps its state.
- [Usage](docs/usage.md): commands and options, exit codes, notes on how a run behaves, and where things are stored.
- [Desktop launcher, notifications, status note and automatic sync](docs/desktop.md): the app-menu entry, `--notify`, the status note, `confirm`, and the systemd timer for `--auto`.
- [How the sync treats your notes](docs/how-sync-works.md): ids, edits, merges, conflict copies, links, renames, deletes, backups and Notion's quirks.
- [Folders and projects](docs/folders-and-projects.md): how vault folders and Notion projects follow each other.
- [Attachments](docs/attachments.md): images, PDFs, audio, video and other files, and how to rename the attachment folder.
- [Troubleshooting](docs/troubleshooting.md): why a note is skipped, what to do, and known limitations.
- [Development](docs/development.md): checks, probes and live tests, releases, and the packages.

## License

MIT, see [LICENSE](LICENSE).
