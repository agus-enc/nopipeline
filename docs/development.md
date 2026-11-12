# Development

Checks, probes and live tests for working on nopipeline. [Back to README](../README.md)

```bash
npm run check                                  # type check and all tests
node scripts/check-vault.ts ~/Documents/<your vault>   # read-only: translate every note both ways and simulate edits in both apps, in memory
node scripts/check-vault.ts ~/Documents/<your vault> --digest   # also a digest of each note's Notion translation, to compare versions
node scripts/check-vault.ts ~/Documents/<your vault> --show "Folder/Note.md"   # one note's lines and its Notion translation
NOTION_TOKEN=... node scripts/probe.ts <scratch data source id>   # record real API output as fixtures
NOPIPELINE_LIVE=1 NOTION_TOKEN=... NOPIPELINE_SCRATCH_DATA_SOURCE=<id> npm test   # include the live API test
```

Point the probe and the live test only at a scratch database, never at the real one.

The live tests need the scratch notes database to have a `Project` relation to a scratch projects database (the connection must be connected to both), so the folder and project tests can run.

## Commits

Commit dates are in UTC, so the history doesn't show a time zone. Git takes the zone from `TZ`, so commit with it set:

```bash
TZ=UTC git commit
```

or add a repo-local alias once (`git config --local alias.c '!TZ=UTC git commit'`) and commit with `git c`. CI fails if any commit's author or committer date isn't `+0000`.

## Releases

A release is a signed git tag `vX.Y.Z`. **Pushing the tag is the whole release**: the release workflow checks it, publishes the GitHub release and starts the package builds on OBS. Packages are built only from a tag signed by the release key.

### The release key

The key is an SSH key used only to sign tags, kept at `~/.ssh/nopipeline_release_ed25519`. Its public half is in the repo as `.release-signers`, in git's [allowed signers format](https://man.archlinux.org/man/ssh-keygen.1#ALLOWED_SIGNERS): exactly one line, the principal `releases`, then the key, with no email and no comment after the key (the build script rejects one):

```
releases ssh-ed25519 AAAA…
```

Tell git to sign tags with it. Point `user.signingkey` at the private key file (not the `.pub`; the public file works only when the key is loaded in ssh-agent, see [git-config](https://git-scm.com/docs/git-config#Documentation/git-config.txt-usersigningKey)). Set it for this repository only, so other repositories keep their own settings:

```bash
git config --local gpg.format ssh
git config --local user.signingkey ~/.ssh/nopipeline_release_ed25519
```

Or pass it for one tag: `git -c gpg.format=ssh -c user.signingkey="$HOME"/.ssh/nopipeline_release_ed25519 tag -s …`.

The same line is stored in the `release` environment's variable `RELEASE_SIGNERS` (see [Packaging](#packaging)). The builds trust that copy, never the one in the tag's tree.

### The changelog rule

`CHANGELOG.md` has one section per version, newest first, headed `## X.Y.Z — YYYY-MM-DD`. Write what a user notices, in short lines. If a version changes the format of anything stored (profile, state files, status note), say so, and say when going back to an older package past this version is unsafe.

The newest heading must equal `version` in `package.json`; a test checks it.

### Cutting a release

1. Bump `version` in `package.json` and add the `CHANGELOG.md` section, with the heading's date set to the release day.
2. Merge to `main` after `npm run check` is green.
3. Check and print the commands:

   ```bash
   node scripts/release.ts
   ```

   It checks that the tree is clean, you are on `main` and equal to `origin/main`, `package.json` and the changelog agree, the tag doesn't exist, `.release-signers` holds one valid line, and `packaging/obs/project` and `packaging/obs-signing-key.fingerprint` no longer hold their placeholders (`home:CHANGE-ME:nopipeline`, forty zeros). It also downloads the OBS repo key with `packaging/obs-key.sh` and prints when it expires; it warns when that is within 180 days (a download failure is only a warning). It prints the problems it finds, or the two commands to run. It never tags, pushes or builds.
4. Run the printed commands, in order: `git tag -s vX.Y.Z -m "nopipeline X.Y.Z"` and `git push origin vX.Y.Z`. That is all: the pushed tag starts the release workflow (below). Watch it on the repository's Actions page.
5. The release notes come from `node scripts/release.ts --notes` (the workflow runs it): the version's `CHANGELOG.md` section, then the install commands per distro family built from the OBS project in `packaging/obs/project`, and the tag-verification command. `--notes` makes no git calls; it prints a `problem:` line to stderr and exits 1 if the section is missing or the OBS project or fingerprint is still a placeholder.

A fix that only touches packaging is a new patch version, so the version always equals the tag. Only plain `vX.Y.Z` tags release (the workflow's tag filter ignores `v1.2.3-rc1` and `v1.2`); there are no pre-release tags.

### What the release workflow does

`.github/workflows/release.yml` runs on a pushed tag `vX.Y.Z`. It has two jobs.

1. `build` has no secrets and a read-only token. It runs `npm ci`, `npm audit signatures` and `npm run check` on the tag.
2. `publish` runs in the `release` environment (which holds `RELEASE_SIGNERS` and `OBS_TOKEN`) and only if `build` passed. It:
   - checks that `.release-signers` in the tag equals the variable `RELEASE_SIGNERS`;
   - fetches the OBS repo key and checks its fingerprint against the pin (see [OBS repo key](#obs-repo-key)); a key that expires within 60 days only prints a notice;
   - runs `packaging/build-source.sh` for the tag, with the trusted key from `RELEASE_SIGNERS`. This verifies the tag (annotated, SSH signature by that key, signed name equals the tag, `package.json` version equals the tag) and builds the source tarball and the rpm, deb and Arch recipes, with the repo key inside;
   - builds and installs the Debian package and the Arch package in containers (`packaging/debian/check-deb.sh --from …`, `packaging/arch/check-arch.sh --from …`), on exactly the files that will be published;
   - creates the GitHub release (`packaging/publish-release.sh`): title `nopipeline X.Y.Z`, notes from `node scripts/release.ts --notes`, and the files plus `SHA256SUMS`;
   - triggers the OBS source-service run with `OBS_TOKEN`; OBS then downloads the files from `releases/latest/download/` and rebuilds every target.

A failure stops everything after it. The OBS trigger comes last, so nothing is built from a tag that failed a check.

### Re-running a failed run

Re-run it from the Actions page ("Re-run failed jobs"). Every step is safe to repeat: if the release page already exists and is published, `publish-release.sh` prints a notice and leaves it and its files alone (it never uploads over published files and never creates a second release); a leftover unpublished draft from an interrupted run (`gh release view` finds drafts too, and drafts are not served by `releases/latest/download/`) is deleted with `gh release delete --yes`, which keeps the tag, and the release is created again, and re-triggering OBS just rebuilds. Releases are created the way GitHub recommends for immutable releases: `gh release create` with files makes a draft, uploads every file, then publishes ([gh source](https://github.com/cli/cli/blob/trunk/pkg/cmd/release/create/create.go)). The workflow runs one release at a time (`concurrency: release`, never cancelling a running one), so two tags pushed close together cannot mix their files. GitHub keeps only one pending run per concurrency group, so pushing a third tag while one release runs cancels the older pending one ([docs](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs)); release that version again with a new patch tag.

The Debian package has no `Debtransform-Release`, so an OBS rebuild of the same version republishes `X.Y.Z-1` with a different hash; apt can report a hash mismatch for a short while after a re-run. `apt update` again fixes it. `debian.rules` also refuses to build when `version.json` and `debian/changelog` name different versions. A re-run does **not** refresh existing release notes. To change them, edit the section in `CHANGELOG.md` for the next release, or fix this release's page by hand:

```bash
node scripts/release.ts --notes > notes.md      # regenerate the notes (run it in a checkout of the tag)
gh release edit vX.Y.Z --notes-file notes.md
```

(or `gh release edit vX.Y.Z --notes "…"`; see `gh release edit --help`).

### When OBS fails to build

The workflow ends at the trigger and does not wait for OBS, so a failed OBS build does not show in GitHub. After a push, look at the package on build.opensuse.org, or the repo's results with `osc results <project> nopipeline`. OBS can mail you about build failures; this is a per-user subscription. In the OBS web interface it is the page `https://build.opensuse.org/my/subscriptions` (also reachable from the avatar menu in the header, "Change your notifications", where "Build failure" is ticked under the build results section), with the build failure event, and it has e-mail and web channels ([OBS blog, 2022](https://openbuildservice.org/2022/12/07/build-failures-for-web-notifications); [notifications, 2020](https://openbuildservice.org/2020/04/27/notifications-round-two/)). I could not find current official documentation of which mails are on by default, so turn it on yourself when you set the project up (one-time setup, below). A failed build means a patch release: fix the recipe, push a new tag.

### What protects a release (trust model)

The workflow file and `build-source.sh` both run **from the tag itself**, so the tag cannot vouch for itself: someone who can push a tag with a changed workflow could skip the checks. The real gates are outside the tag:

- the `release` environment only accepts tags matching `v*.*.*` and holds the secrets, so a workflow run on any other ref gets none of them;
- the tag ruleset allows only the repository admin to create, update or delete `v*` tags;
- `RELEASE_SIGNERS` is an environment variable only the repository owner can change ([environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments): on a personal repository only the owner can configure one), so a commit cannot swap the trusted key.

Whoever controls the GitHub account can publish packages: they can change these settings. This was accepted on purpose. Be clear about what else that means: anyone with `contents: write` on the repository (a collaborator, or a leaked token with that scope) can upload over release assets or create or move the "latest" release, and the tag ruleset does not cover releases. OBS downloads whatever `releases/latest/download/` serves, so **write access to releases is the ability to publish packages.** The OBS token itself is limited to one package and one operation (run its source services), but that only bounds the token, not what it rebuilds.

The mitigation is GitHub's immutable releases (turn them on once, see the setup step below): after a release is published, its assets and tag can no longer be changed or deleted. "latest" can still be moved to another release, so a new bad release is possible for someone with write access; if that ever matters, the next step is versioned download URLs in `_service`.

## Packaging

### OBS project files (`packaging/obs/`)

The Arch repository's database is named `<project with ':' replaced by '_'>_<repository>.db` on OBS (for example `home_manuelschneid3r_Arch.db` in [this listing](https://download.opensuse.org/repositories/home:/manuelschneid3r/Arch/x86_64/)), and pacman fetches `<section>.db`, so the `pacman.conf` section is `[<project with ':' → '_'>_Arch]` (README and release notes).

`project` holds the OBS project name (one line; the only place it is written). `_service` lists one `download_url` per file `build-source.sh` renders, each from `https://github.com/@REPO@/releases/latest/download/<name>`; `@REPO@` (`owner/repo`) is filled in when the file is uploaded to OBS, so a rehearsal repo works unchanged. `project-meta.xml.in` (with `@PROJECT@`) and `package-meta.xml` are the OBS metadata.

- `download_url` takes `protocol`, `host`, `port`, `path` (required), `filename`, `url` and a few switches, and `path` has no leading slash because the script builds `protocol://host/path` itself ([service definition](https://github.com/openSUSE/obs-service-download_url/blob/master/download_url.service), [script](https://github.com/openSUSE/obs-service-download_url/blob/master/download_url)). The script runs `wget`, which follows redirects by default (GitHub redirects `releases/latest/download/...` to its CDN); Confirmed in the rehearsal on 2026-11-12: `download_url` follows GitHub's redirect, and debtransform resolves `Debtransform-Tar` for the `_service:download_url:` files.
- OBS serves a project's signing key at `https://build.opensuse.org/projects/<project>/signing_keys/download?kind=gpg`. Checked on 2026-11-11 with a read-only GET for the public project `graphics:darktable`: HTTP 200 and an armored `PGP PUBLIC KEY BLOCK`, the same key as `https://download.opensuse.org/repositories/graphics:/darktable/Fedora_43/repodata/repomd.xml.key`. `obs-key.sh --project` keeps using it.
- Build paths in `project-meta.xml.in` are the `standard` repositories of `Fedora:43`, `Fedora:44`, `Debian:13`, `Ubuntu:24.04`, `Ubuntu:26.04` (x86_64 and aarch64) and `Arch:Core` and `Arch:Extra` (x86_64 only; `Arch:Community` is not used: Arch merged its `community` repository into `extra` in 2023). The Arch pair is the one `home:manuelschneid3r` uses, read from that project's public meta page (which still lists `Arch:Community` as well). The others are as listed on their public OBS pages. The rehearsal on 2026-11-12 built and published all 11 targets with these paths.

### One-time setup (outside the repo)

Done once by the owner, who types every credential. Nothing here is done by scripts or by Claude.

1. **openSUSE account** at <https://build.opensuse.org/> (sign up there). The username is public in the repository URLs, so use a non-personal one.
2. **OBS project.** Take `packaging/obs/project-meta.xml.in`, replace `@PROJECT@` with the project name (for example `home:<user>:nopipeline`; a home project is `home:<user>:…`), and create the project from it: web interface (Create project, then edit the meta as XML) or, with `osc` (`dnf install osc`; `osc` asks for your login the first time):

   ```bash
   sed 's|@PROJECT@|home:<user>:nopipeline|' packaging/obs/project-meta.xml.in | osc meta prj home:<user>:nopipeline -F -
   ```

   Then check the `<person>` element: `project-meta.xml.in` has none, and OBS may add you as maintainer on its own. Make sure your user is maintainer and has the build failure mail turned on (above).
3. **OBS package.** Create it from `packaging/obs/package-meta.xml`, then upload `_service` with `@REPO@` filled in (`owner/repo` of the GitHub repository):

   ```bash
   osc meta pkg home:<user>:nopipeline nopipeline -F packaging/obs/package-meta.xml
   osc co home:<user>:nopipeline nopipeline
   sed 's|@REPO@|agus-enc/nopipeline|' packaging/obs/_service > home:<user>:nopipeline/nopipeline/_service
   cd home:<user>:nopipeline/nopipeline && osc add _service && osc ci -m "source service"
   ```

4. **Package-scoped token.** `osc token --create --operation runservice <project> <package>` creates a token for one package that can only run its source services ([`osc token`](https://github.com/openSUSE/osc/blob/master/osc/commandline.py) usage: `osc token --create --operation <OPERATION> [<PROJECT> <PACKAGE>]`, operations `runservice, branch, release, rebuild, workflow`; [OBS tokens](https://openbuildservice.org/help/manuals/obs-user-guide/cha-obs-authorization-token) recommend binding a token to a package). The command prints the token string once. Do not paste it anywhere but step 6.
5. **GitHub `release` environment.** In the repository: Settings, Environments, New environment `release`; under "Deployment branches and tags" choose "Selected branches and tags" and add a **tag** rule `v*.*.*`. Or with the API ([deployment tag policies](https://docs.github.com/en/rest/deployments/branch-policies)):

   ```bash
   gh api -X PUT repos/agus-enc/nopipeline/environments/release --input - <<'EOF'
   {"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
   EOF
   gh api -X POST repos/agus-enc/nopipeline/environments/release/deployment-branch-policies -f name='v*.*.*' -f type=tag
   ```

6. **Variable and secrets** in that environment. `gh variable set` reads the value from stdin; `gh secret set` asks for the value with hidden input when run in a terminal, so type or paste each one when asked:

   ```bash
   gh variable set RELEASE_SIGNERS --env release < .release-signers
   gh secret set OBS_TOKEN --env release
   ```

7. **Tag ruleset.** Settings, Rules, Rulesets, New ruleset, New tag ruleset. Target pattern `v*`; enable Restrict creations, Restrict updates and Restrict deletions; add the "Repository admin" role to the bypass list so you can still push release tags. Rulesets are available for public repositories on the GitHub Free plan ([About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)). If this ever turns out unavailable, the environment's tag rule and `RELEASE_SIGNERS` are the protection that remains.
8. **Fill the placeholders and commit:** `packaging/obs/project` (the project name) and `packaging/obs-signing-key.fingerprint` (the OBS signing key's primary fingerprint). The real project `home:chipp:nopipeline` is expected to serve the same key as the test sub-project (the `home:chipp` key, RSA 4096; the pinned fingerprint is that key's), so after creating it, run this and check the output equals the pinned fingerprint. Get the fingerprint from the key a project serves:

   ```bash
   curl -fsSL "https://build.opensuse.org/projects/home:<user>:nopipeline/signing_keys/download?kind=gpg" | gpg --show-keys --with-colons | awk -F: '/^fpr:/ {print $10; exit}'
   ```

   and compare it with the signing key page of the project on build.opensuse.org before you commit it. Also replace every `<user>` in the README's install commands (`home:<user>`, `home:/<user>:/` in URLs and `home_<user>_` in the pacman section) with the real OBS project (done for `chipp`); `node scripts/release.ts` reports a problem while `<user>` is still anywhere in `README.md`.

9. **Immutable releases.** In the repository settings, enable "Immutable releases" ([docs](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases)). Once a release is published, its assets and tag cannot be changed or deleted, and the release gets an attestation. Do this before the first real release. Confirmed in the rehearsal on 2026-11-12: `gh release create` with files (draft, upload, publish) works with immutable releases on, and re-running a finished release run leaves the release untouched and only re-triggers OBS.

`node scripts/release.ts` refuses to print the release commands while the three placeholders (the project file, the fingerprint file and the README's `<user>`) are still there.

### Rehearsal results (2026-11-12)

A rehearsal with a public scratch repository and the OBS project `home:chipp:nopipeline:test` ran end to end: the release workflow, an immutable release, OBS building and publishing all 11 targets, and installs in containers (`fedora:44`; `debian:13` with NodeSource; `ubuntu:26.04`, whose archive Node prints the TypeScript message; `archlinux`, with signatures verified). The monthly key-check run by hand opened no issue, and a second tag moved "latest".

Confirmed: `download_url` follows GitHub's redirect; debtransform resolves `Debtransform-Tar` for `_service:download_url:` files; OBS signs the Arch packages and the database; `curl ... | pacman-key --add -` works; `gh release create` with files works with immutable releases on; re-running a finished release only re-triggers OBS.

Not confirmed: a package upgrade from one version to the next from the OBS repo (OBS keeps only the newest build, so there was nothing to upgrade from); how dnf5 treats an extended key (above); how long before the old expiry OBS extends the key (below).

### OBS repo key

OBS signs the repositories with a key of the project, which expires about two years after the last time it was extended. A user whose copy has expired gets `EXPKEYSIG` and cannot download the package that carries the new key, so each package ships the key and refreshes the user's copy on upgrade.

**The pin.** `packaging/obs-signing-key.fingerprint` holds the key's primary fingerprint. `packaging/obs-key.sh` downloads the key OBS serves, accepts it only if that fingerprint is its primary key (exit status 10 if the download holds no such key, 1 for any other failure; not 2, because `sh` and `awk` exit 2 on their own errors), and keeps only that primary key with its user ID and self-signatures. An OBS extension keeps the same fingerprint, so it needs no commit.

**At release.** The workflow runs `obs-key.sh` and bakes the key into the packages: `/usr/share/keyrings/nopipeline-archive-keyring.gpg` (deb; dpkg replaces it on upgrade, and the user's `.sources` file points at it) and `/usr/share/pacman/keyrings/nopipeline.gpg` and `nopipeline-trusted` (Arch; the install script runs `pacman-key --populate nopipeline`). A mismatch or a download failure fails the release before anything is published. The rpm ships no key file: the `.repo` file from OBS points at the key on OBS (`gpgkey=…/repodata/repomd.xml.key`).

**The obligation, about every two years.** Make at least one release between OBS extending the key and the old expiry, so the packages carry the extended key. What I could check: darktable's OBS key (created 2017-12-26) was re-signed on 2026-10-01 to expire in 2028-12 (about 2 years 2 months after the extension), and the key of `home:manuelschneid3r` (created 2017-10-27) on 2024-12-02 to expire in 2027-02 (read with `gpg --list-packets` on the keys served by `https://download.opensuse.org/repositories/graphics:/darktable/xUbuntu_26.04/Release.key` and the project's `signing_keys/download` URL). I could not find how long before the old expiry OBS extends, so this is **not confirmed**; the monthly check below catches the case where it has not. (See also the [OBS mailing list](https://lists.opensuse.org/archives/list/buildservice@lists.opensuse.org/thread/Z6AIHSMZDULWIOUA253QLAAGNT64G3GU) and a [2026 report](https://discuss.pixls.us/t/obs-gpg-signing-key-expired/60805) of an expired key.) `node scripts/release.ts` prints the expiry date of the key OBS serves and warns when it is within 180 days. The workflow only prints a notice when it is within 60 days; it never blocks a release.

**Fedora.** I could not confirm how dnf5 treats a key that is extended under the same key id. The [change proposal](https://www.fedoraproject.org/wiki/Changes/Dnf5ExpiredPGPKeys) and the [plugin's man page](https://man.archlinux.org/man/libdnf5-expired-pgp-keys.8.en) say the `expired-pgp-keys` plugin checks for expired imported keys before a transaction, asks to remove them (or removes them silently with `assumeyes`), and that this "allows importing an updated key later". They do not say the new copy is imported on its own. So a Fedora user may be asked about the expired key and then to import the current one from the `.repo` file's `gpgkey` URL; the README gives the refresh steps for a user stuck on it. To be re-checked at the first extension.

**The monthly check.** `.github/workflows/key-check.yml` runs on the 1st of each month at 06:17 UTC (and by hand: Actions, key-check, "Run workflow") and runs `scripts/key-check.ts`. It has no secrets and may only read the repo and write issues. It compares the key in the latest release (the `nopipeline-archive-keyring.gpg` asset) with the key OBS serves now, and opens one issue when:

- **"OBS repo key expires on YYYY-MM-DD"**: the shipped key expires within 90 days. The issue says whether OBS already serves the extended key (then tag a patch release, so the packages ship it) or has not extended it yet (then look at the project's signing keys on OBS).
- **"OBS repo key changed"**: the key OBS serves no longer has the pinned fingerprint.

It opens nothing if an open issue with the same title exists. If there is no release yet, or the latest release has no keyring asset (before the first OBS release), it prints a `::notice::` line and succeeds. If it cannot fetch something else, it fails the run (GitHub mails the owner) and opens no issue. Each issue links to this section.

**Release notes.** The `CHANGELOG.md` section of the release that ships an extended key says so, and, while the Fedora behaviour above is unconfirmed, the notes of the release before the old expiry warn Fedora users ahead of it.

**If the key changed.** Find out whether it was on purpose (OBS can replace a project's key; check the project's signing keys page and the OBS announcements). If not, treat it as an incident: do not release. If it was: put the new fingerprint in `packaging/obs-signing-key.fingerprint`, release a new version whose notes tell users to import the new key again (the README's expired-key commands do that), and remember that users on the old key must refresh it by hand, since a package signed with the new key cannot be verified with the old one.

**If the monthly check stopped.** GitHub disables scheduled workflows in a public repository after 60 days without repository activity ([docs](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule)). Re-enable it on the Actions page (key-check, "Enable workflow"), or with `gh workflow enable key-check.yml`. A release or any commit counts as activity.

### What `build-source.sh` does

`packaging/build-source.sh` is a POSIX `sh` script that the release workflow runs on the signed tag (with the trusted key filled in by `sed`) to make the sources of all three packages. It:

- ignores every `GIT_*` variable and the machine's git configuration;
- clones the repository and picks the newest `vX.Y.Z` tag;
- checks the tag is annotated and that its SSH signature (an OpenPGP or x509 one is refused, and those verifiers are disabled) is valid for the single key in its `ALLOWED_SIGNERS` line, and that the signed tag has that name; otherwise it stops;
- checks `package.json` says the tag's version;
- builds from `git archive` of the tag, so files marked `export-ignore` in `.gitattributes` (`test/`, `scripts/`, `.github/`) are left out;
- runs `npm ci --omit=dev --ignore-scripts` and `npm audit signatures`;
- writes `version.json` (version and commit) into the tarball, and `nopipeline.tar.gz`, `version` (one line) and `nopipeline.spec` (from `packaging/fedora/nopipeline.spec.in`, with the version, date and one `Provides: bundled(nodejs-…)` line per shipped dependency). If `NOPIPELINE_REPO_KEYS=<dir>` is set, the three repo key files in it are added to the tarball under `keys/` (any other entry fails the build). The rpm needs no Node to build and has no `%check`; the container checks run the installed package.
- when the tag has `packaging/debian/`, also writes the Debian recipe for OBS: `nopipeline.dsc` (from `nopipeline.dsc.in`, with `Version: X.Y.Z-1` and the tarball's sha256, md5 and size, computed with `node`), `debian.control`, `debian.rules` and `debian.changelog` (from `debian.changelog.in`, dated with `date -R`). OBS's [debtransform](https://github.com/openSUSE/obs-build/blob/master/debtransform) puts each `debian.<name>` file at `debian/<name>` on top of the tarball named by `Debtransform-Tar:`. Old tags without that folder build as before.
- when the tag has `packaging/arch/`, also writes the Arch recipe for OBS: `PKGBUILD` (from `PKGBUILD.in`, with the version and the tarball's sha256) and `nopipeline.install`, which runs `pacman-key --populate nopipeline` on install and upgrade (guarded: if pacman's keyring is not initialised it prints a hint instead of failing). The package ships `keys/nopipeline.gpg` and `keys/nopipeline-trusted` in `/usr/share/pacman/keyrings/`; if `--populate` fails the scriptlet prints a hint and the install goes on; removing the package does not untrust the key (it stays locally signed with owner trust 4; drop it with `pacman-key --delete <fingerprint>`, the fingerprint is in `packaging/obs-signing-key.fingerprint`); [pacman-key(8)](https://man.archlinux.org/man/pacman-key.8) says `--populate` reads `<name>.gpg` and the optional `<name>-trusted` (gpg ownertrust format) and `<name>-revoked` there.

It calls these tools: `git`, `ssh-keygen` (through git's SSH signature check), `node`, `npm`, `tar`, `sed`, `grep`, `head`, `tr`, `date`, `env`, `mktemp`, `realpath`, and `sh`, `rm`, `mkdir`, `cp` and `mv`. It trusts the `PATH` it runs with, which is fine on a GitHub Actions runner; do not run it with a `PATH` you do not control.

It takes optional arguments (`[<git-url> [<result-dir> [<tag>]]]`). The workflow passes the tag's repository and a result folder; with no arguments the defaults apply: `https://github.com/agus-enc/nopipeline.git`, the current folder, and the newest tag.

All three recipes install the one `packaging/nopipeline-launcher.sh` as `/usr/bin/nopipeline`. It runs `/usr/bin/node` on `src/cli.ts`, but first checks `process.features.typescript`; on a Node without it (the Debian and Ubuntu archive one) it prints that Node.js 22.22 or newer from NodeSource is needed and exits 1. The check scripts compare the installed file with it byte for byte (the rpm differs only in the first line: rpm rewrites `#!/bin/sh` to `#!/usr/bin/sh`).

### Checking the Debian recipe

`packaging/debian/check-deb.sh` (manual, run from the repository root after committing; needs Docker, gpg, curl and the network) builds the OBS source from `HEAD` with a throwaway repo key, lays out `debian/` as debtransform would, builds the `.deb` in `ubuntu:26.04`, installs and runs it in `ubuntu:26.04` and `debian:13`, and in `ubuntu:26.04` with the archive's own `nodejs` checks that `nopipeline --version` exits 1 with the TypeScript message (or, if that Node now supports TypeScript, that it runs, and prints a note). Both get Node 22.x from NodeSource (the same deb822 file its [setup script](https://deb.nodesource.com/setup_22.x) writes), because the distributions' own `nodejs` is built without TypeScript support and cannot run `src/cli.ts`.

### Checking the Arch recipe

`packaging/arch/check-arch.sh` (manual, run from the repository root after committing; needs Docker, gpg, curl and the network) builds the OBS source from `HEAD` with a throwaway repo key, then in an `archlinux` container runs `pacman -Syu`, builds the package with `makepkg` as a normal user, installs it with `pacman -U`, runs `nopipeline --version`, and checks the throwaway key is in pacman's keyring, locally signed. Arch's own `nodejs` supports TypeScript, so it is the Node under test.

### Checking the package locally

`packaging/fedora/check-rpm.sh` builds the rpm from the current `HEAD` in a throwaway signed repo, then installs it in `fedora:43` and `fedora:44` containers. It is a manual check, not part of `npm test`. It needs git, ssh-keygen, npm, rpm-build, rpm, Docker and Node 22.22 or newer on the host, and the network. Commit your changes first, then run it from the repository root:

```bash
packaging/fedora/check-rpm.sh
```
