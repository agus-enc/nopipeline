#!/bin/sh
# Builds the rpm source for nopipeline from the newest signed release tag.
# Run by the release workflow (.github/workflows/release.yml), which fills in the key below with sed.
#
# Usage: build-source.sh [<git-url> [<result-dir> [<tag>]]]
#
# Output: nopipeline.tar.gz (top folder nopipeline-<version>/), nopipeline.spec and version (one line, X.Y.Z).
# NOPIPELINE_REPO_KEYS=<dir> (optional) names a folder holding exactly the three repo key files; they are put into the
# tarball under nopipeline-<version>/keys/. Unset or empty: no keys folder.
# If the tag has packaging/debian/, the Debian recipe for OBS is also written: nopipeline.dsc, debian.control,
# debian.rules and debian.changelog (the dsc carries the tarball's checksums, so it is rendered after the tarball).
# If the tag has packaging/arch/, the Arch recipe for OBS is also written: PKGBUILD (with the tarball's sha256) and
# nopipeline.install.
#
# Only a tag signed by the release key can produce a build. The key is the line below, filled in by the release
# workflow from its RELEASE_SIGNERS variable. It is never read from the repository, so a tampered repository cannot change which key is trusted.
set -eu

ALLOWED_SIGNERS='@RELEASE_SIGNERS@'

url=${1:-https://github.com/agus-enc/nopipeline.git}
result=${2:-.}
tag=${3:-}

# Git must not depend on the caller's configuration: drop every GIT_* variable (GIT_CONFIG_COUNT, GIT_CONFIG_PARAMETERS,
# GIT_DIR, ...) and set only what is needed.
for name in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$name"; done
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0

reported=
fail() {
  reported=1
  printf 'build-source: %s\n' "$*" >&2
  exit 1
}

work=$(mktemp -d)
cleanup() {
  status=$?
  rm -rf "$work"
  if [ "$status" -ne 0 ] && [ -z "$reported" ]; then
    printf 'build-source: failed unexpectedly (exit %s)\n' "$status" >&2
  fi
}
trap cleanup EXIT

[ "${ALLOWED_SIGNERS#@}" = "$ALLOWED_SIGNERS" ] || fail "the release key was not filled in"
# grep -q passes when any one line matches, so a value with a line break is refused before it is checked.
case $ALLOWED_SIGNERS in *"
"*) fail "the release key line is malformed" ;; esac
printf '%s\n' "$ALLOWED_SIGNERS" | grep -Eq '^releases ssh-ed25519 [A-Za-z0-9+/=]+$' || fail "the release key line is malformed"
printf '%s\n' "$ALLOWED_SIGNERS" >"$work/allowed_signers"

result=$(realpath -m -- "$result")

git clone --quiet --bare -- "$url" "$work/repo.git" || fail "cannot clone $url"
gitc() { git -C "$work/repo.git" "$@"; }

semver='^v[0-9]+\.[0-9]+\.[0-9]+$'
if [ -z "$tag" ]; then
  tag=$(gitc tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | grep -E "$semver" | head -n 1 || true)
  [ -n "$tag" ] || fail "no release tag (vX.Y.Z) in $url"
fi
case $tag in *"
"*) fail "the tag name is not a release tag name (vX.Y.Z)" ;; esac
printf '%s\n' "$tag" | grep -Eq "$semver" || fail "$tag is not a release tag name (vX.Y.Z)"
version=${tag#v}

[ "$(gitc cat-file -t "refs/tags/$tag" 2>/dev/null || true)" = tag ] ||
  fail "$tag is not signed by the release key (it is not an annotated tag)"
# git picks the verifier from the signature's armor, not from gpg.format, so an OpenPGP or x509 signature would be checked
# against the builder's own keyring. Only an SSH signature is accepted, and the other verifiers are disabled.
gitc cat-file tag "refs/tags/$tag" | grep -q '^-----BEGIN SSH SIGNATURE-----$' ||
  fail "$tag is not signed by the release key (it carries no SSH signature)"
verify_out=$(gitc -c gpg.format=ssh -c gpg.ssh.program=ssh-keygen -c gpg.openpgp.program=false -c gpg.x509.program=false \
  -c "gpg.ssh.allowedSignersFile=$work/allowed_signers" verify-tag "refs/tags/$tag" 2>&1) ||
  fail "$tag is not signed by the release key${verify_out:+ ($(printf '%s' "$verify_out" | tr '\n' ' '))}"
# A signed tag object could have been stored under another name; the signed name must be this one.
[ "$(gitc cat-file tag "refs/tags/$tag" | sed -n 's/^tag //p;/^$/q' | head -n 1)" = "$tag" ] ||
  fail "$tag is not signed by the release key (the signed tag has another name)"
commit=$(gitc rev-parse "refs/tags/$tag^{commit}")

out="$work/out"
mkdir -p "$out"
mkdir "$work/tree"
gitc archive --format=tar --prefix="nopipeline-$version/" -o "$work/source.tar" "$commit" || fail "cannot archive $tag"
tar -x -C "$work/tree" -f "$work/source.tar" || fail "cannot unpack the archive of $tag"
tree="$work/tree/nopipeline-$version"

pkg_version=$(cd "$tree" && node -p "require('./package.json').version") || fail "cannot read package.json"
[ "$pkg_version" = "$version" ] || fail "package.json says $pkg_version but the tag is $tag"
# What npm ci would install (dependencies, optional and peer ones too): anything but the root entry in the lockfile.
installs=$(cd "$tree" && node -p "Object.keys(require('./package-lock.json').packages ?? {}).filter((k) => k !== '').length") ||
  fail "cannot read package-lock.json"

# Checked now, before the slow npm steps, so a wrong keys folder fails fast.
keys=${NOPIPELINE_REPO_KEYS:-}
key_names="nopipeline-archive-keyring.gpg nopipeline.gpg nopipeline-trusted"
if [ -n "$keys" ]; then
  [ -d "$keys" ] && [ ! -L "$keys" ] || fail "NOPIPELINE_REPO_KEYS is not a folder: $keys"
  for entry in "$keys"/* "$keys"/.[!.]* "$keys"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    case " $key_names " in
      *" ${entry##*/} "*) [ -f "$entry" ] && [ ! -L "$entry" ] || fail "${entry##*/} in the keys folder is not a regular file" ;;
      *) fail "unexpected entry in the keys folder: ${entry##*/}" ;;
    esac
  done
  for name in $key_names; do
    [ -f "$keys/$name" ] || fail "the keys folder has no $name"
  done
fi

if [ "${NOPIPELINE_SKIP_AUDIT:-}" = 1 ] && [ "$installs" != 0 ]; then
  fail "NOPIPELINE_SKIP_AUDIT is only allowed for a tree with no dependencies"
fi
(
  cd "$tree"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund >&2
) || fail "npm ci failed"
if [ "${NOPIPELINE_SKIP_AUDIT:-}" != 1 ]; then
  (cd "$tree" && npm audit signatures >&2) || fail "npm audit signatures failed"
fi
if [ "${NOPIPELINE_SKIP_AUDIT:-}" = 1 ]; then
  # The lockfile check above can be fooled (lockfileVersion 1 has no "packages" key); what npm ci installed cannot.
  for entry in "$tree"/node_modules/* "$tree"/node_modules/.[!.]*; do
    [ -e "$entry" ] || continue
    [ "${entry##*/}" = .package-lock.json ] || fail "NOPIPELINE_SKIP_AUDIT is only allowed for a tree with no dependencies"
  done
fi
mkdir -p "$tree/node_modules"

printf '{ "version": "%s", "commit": "%s" }\n' "$version" "$commit" >"$tree/version.json"

if [ -n "${NOPIPELINE_REPO_KEYS:-}" ]; then
  mkdir "$tree/keys" 2>/dev/null || fail "the tagged tree already has a keys folder"
  for name in $key_names; do
    cp -- "$keys/$name" "$tree/keys/$name" || fail "cannot copy $name"
  done
fi

tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$out/nopipeline.tar.gz" \
  -C "$work/tree" "nopipeline-$version" || fail "cannot create the tarball"

printf '%s\n' "$version" >"$out/version"

template="$tree/packaging/fedora/nopipeline.spec.in"
if [ -f "$template" ]; then
  date=$(LC_ALL=C TZ=UTC date '+%a %b %d %Y') || fail "cannot read the date"
  # One Provides line per package that ships: each lockfile entry whose package.json exists after npm ci, so the list is
  # exactly what npm ci put in node_modules (workspace links included; dev-only and skipped optional entries are not
  # there). Lockfile order.
  (cd "$tree" && node -e '
    const fs = require("node:fs");
    const packages = require("./package-lock.json").packages ?? {};
    for (const [key, info] of Object.entries(packages)) {
      if (!key.startsWith("node_modules/") && !key.includes("/node_modules/")) continue;
      let installed;
      try { installed = JSON.parse(fs.readFileSync(`${key}/package.json`, "utf8")); } catch { continue; }
      const version = typeof installed.version === "string" && installed.version ? installed.version : info.version;
      if (!version) continue;
      process.stdout.write(`Provides:       bundled(nodejs-${key.slice(key.lastIndexOf("node_modules/") + 13)}) = ${version}\n`);
    }
  ') >"$work/bundled" || fail "cannot read the bundled packages from the lockfile"
  sed -e "s/@VERSION@/$version/g" -e "s/@DATE@/$date/g" -e "/^@BUNDLED@\$/{r $work/bundled" -e d -e "}" "$template" >"$out/nopipeline.spec" ||
    fail "cannot render the spec"
fi

# The Debian recipe for OBS (debtransform maps debian.* to debian/*). Only a tag that carries packaging/debian/ gets one.
if [ -d "$tree/packaging/debian" ]; then
  deb="$tree/packaging/debian"
  date_rfc=$(LC_ALL=C TZ=UTC date -R) || fail "cannot read the date"
  sums=$(node -e '
    const { createHash } = require("node:crypto");
    const data = require("node:fs").readFileSync(process.argv[1]);
    for (const algo of ["sha256", "md5"]) console.log(createHash(algo).update(data).digest("hex"));
    console.log(data.length);
  ' "$out/nopipeline.tar.gz") || fail "cannot checksum the tarball"
  sha256=$(printf '%s\n' "$sums" | sed -n 1p)
  md5=$(printf '%s\n' "$sums" | sed -n 2p)
  size=$(printf '%s\n' "$sums" | sed -n 3p)
  sed -e "s/@VERSION@/$version/g" -e "s/@SHA256@/$sha256/g" -e "s/@MD5@/$md5/g" -e "s/@SIZE@/$size/g" \
    "$deb/nopipeline.dsc.in" >"$out/nopipeline.dsc" || fail "cannot render the dsc"
  sed -e "s/@VERSION@/$version/g" -e "s/@DATE_RFC2822@/$date_rfc/g" "$deb/debian.changelog.in" >"$out/debian.changelog" ||
    fail "cannot render the Debian changelog"
  cp -- "$deb/debian.control" "$deb/debian.rules" "$out/" || fail "cannot copy the Debian files"
  chmod 755 "$out/debian.rules"
fi

# The Arch recipe for OBS. Only a tag that carries packaging/arch/ gets one; the tarball's sha256 goes into the PKGBUILD.
if [ -d "$tree/packaging/arch" ]; then
  arch="$tree/packaging/arch"
  sha256=$(node -e '
    const { createHash } = require("node:crypto");
    console.log(createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"));
  ' "$out/nopipeline.tar.gz") || fail "cannot checksum the tarball"
  sed -e "s/@VERSION@/$version/g" -e "s/@SHA256@/$sha256/g" "$arch/PKGBUILD.in" >"$out/PKGBUILD" || fail "cannot render the PKGBUILD"
  cp -- "$arch/nopipeline.install" "$out/" || fail "cannot copy nopipeline.install"
fi

mkdir -p -- "$result" || fail "cannot create $result"
for f in "$out"/*; do
  mv -f -- "$f" "$result/" || fail "cannot move ${f##*/} into $result"
done
