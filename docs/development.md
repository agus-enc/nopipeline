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

## Releases

A release is a signed git tag `vX.Y.Z`. Copr builds the Fedora package only from a tag signed by the release key.

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

Or pass it for one tag: `git -c gpg.format=ssh -c user.signingkey=~/.ssh/nopipeline_release_ed25519 tag -s …`.

The same line is pasted into the Copr package's script (see [Packaging](#packaging)). The build trusts that copy, never the one in the repo.

### The changelog rule

`CHANGELOG.md` has one section per version, newest first, headed `## X.Y.Z — YYYY-MM-DD`. Write what a user notices, in short lines. If a version changes the format of anything stored (profile, state files, status note), say so, and say when `dnf downgrade` past this version is unsafe.

The newest heading must equal `version` in `package.json`; a test checks it.

### Cutting a release

1. Bump `version` in `package.json` and add the `CHANGELOG.md` section, with the heading's date set to the release day.
2. Merge to `main` after `npm run check` is green.
3. Check and print the commands:

   ```bash
   node scripts/release.ts
   ```

   It checks that the tree is clean, you are on `main` and equal to `origin/main`, `package.json` and the changelog agree, the tag doesn't exist, and `.release-signers` holds one valid line. It prints the problems it finds, or the commands to run. It never tags, pushes or builds.
4. Run the printed commands, in order: `git tag -s vX.Y.Z -m "nopipeline X.Y.Z"`, `git push origin vX.Y.Z`, then `copr-cli build-package chipp/nopipeline --name nopipeline`.

It also warns when `packaging/build-source.sh` changed since the previous tag. If so, update the script stored in Copr before the build (see below).

A fix that only touches packaging is a new patch version, so the version always equals the tag. Copr always builds the newest `vX.Y.Z` tag; there are no pre-release tags.

## Packaging

### What `build-source.sh` does

`packaging/build-source.sh` is a POSIX `sh` script that Copr runs to make the source of an rpm. It:

- ignores every `GIT_*` variable and the machine's git configuration;
- clones the repository and picks the newest `vX.Y.Z` tag;
- checks the tag is annotated and that its SSH signature (an OpenPGP or x509 one is refused, and those verifiers are disabled) is valid for the single key in its `ALLOWED_SIGNERS` line, and that the signed tag has that name; otherwise it stops;
- checks `package.json` says the tag's version;
- builds from `git archive` of the tag, so files marked `export-ignore` in `.gitattributes` (`test/`, `scripts/`, `.github/`) are left out;
- runs `npm ci --omit=dev --ignore-scripts` and `npm audit signatures`;
- writes `version.json` (version and commit), `nopipeline-<version>.tar.gz` and `nopipeline.spec` (from `packaging/fedora/nopipeline.spec.in`, with the version, date and one `Provides: bundled(nodejs-…)` line per shipped dependency).

It takes optional arguments (`[<git-url> [<result-dir> [<tag>]]]`). On Copr it runs with none, so the defaults apply: `https://github.com/agus-enc/nopipeline.git`, the current folder, and the newest tag.

### The Copr project

The project is `chipp/nopipeline`, with the chroots fedora-43 and fedora-44, each for x86_64 and aarch64. It has one package, `nopipeline`, with these settings (see [Copr's custom source method](https://docs.copr.fedorainfracloud.org/custom_source_method.html)):

| Field | Value |
| --- | --- |
| Source type | Custom |
| Script | `packaging/build-source.sh`, with `@RELEASE_SIGNERS@` replaced by the one line of `.release-signers` |
| Build dependencies | `git-core nodejs-npm openssh-clients tar` |
| Result directory | `.` |

The script is stored in Copr as a full copy with the key filled in, never as a stub that fetches repo code. Make the copy and check the placeholder is gone:

```bash
copy="$(mktemp)"
sed "s|@RELEASE_SIGNERS@|$(cat .release-signers)|" packaging/build-source.sh > "$copy"
grep -c '@RELEASE_SIGNERS@' "$copy"    # prints 0
grep -c "^ALLOWED_SIGNERS='releases ssh-ed25519 " "$copy"    # prints 1 (an empty .release-signers must not pass)
```

To update the stored script, upload the new copy (flags as in the Copr docs; see `copr-cli edit-package-custom --help`):

```bash
copr-cli edit-package-custom chipp/nopipeline --name nopipeline \
  --script "$copy" \
  --script-builddeps "git-core nodejs-npm openssh-clients tar" \
  --script-resultdir .
```

### Checking the package locally

`packaging/fedora/check-rpm.sh` builds the rpm from the current `HEAD` in a throwaway signed repo, then installs it in `fedora:43` and `fedora:44` containers. It is a manual check, not part of `npm test`. It needs git, ssh-keygen, npm, rpm-build, rpm, Docker and Node 22.22 or newer on the host, and the network. Commit your changes first, then run it from the repository root:

```bash
packaging/fedora/check-rpm.sh
```
