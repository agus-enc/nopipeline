#!/bin/sh
# Builds the rpm source for nopipeline from the newest signed release tag.
# Run by Fedora Copr's "Custom" source method (no arguments, cwd = the result folder).
#
# Usage: build-source.sh [<git-url> [<result-dir> [<tag>]]]
#
# Only a tag signed by the release key can produce a build. The key is the line below, filled in when this script is
# pasted into Copr. It is never read from the repository, so a tampered repository cannot change which key is trusted.
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
printf '%s\n' "$tag" | grep -Eq "$semver" || fail "$tag is not a release tag name (vX.Y.Z)"
version=${tag#v}

[ "$(gitc cat-file -t "refs/tags/$tag" 2>/dev/null || true)" = tag ] ||
  fail "$tag is not signed by the release key (it is not an annotated tag)"
verify_out=$(gitc -c gpg.format=ssh -c gpg.ssh.program=ssh-keygen -c "gpg.ssh.allowedSignersFile=$work/allowed_signers" verify-tag "$tag" 2>&1) ||
  fail "$tag is not signed by the release key ($(printf '%s' "$verify_out" | tr '\n' ' '))"
# A signed tag object could have been stored under another name; the signed name must be this one.
[ "$(gitc cat-file tag "$tag" | sed -n 's/^tag //p;/^$/q' | head -n 1)" = "$tag" ] ||
  fail "$tag is not signed by the release key (the signed tag has another name)"
commit=$(gitc rev-parse "$tag^{commit}")

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
mkdir -p "$tree/node_modules"

printf '{ "version": "%s", "commit": "%s" }\n' "$version" "$commit" >"$tree/version.json"

tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$out/nopipeline-$version.tar.gz" \
  -C "$work/tree" "nopipeline-$version" || fail "cannot create the tarball"

template="$tree/packaging/fedora/nopipeline.spec.in"
if [ -f "$template" ]; then
  date=$(LC_ALL=C TZ=UTC date '+%a %b %d %Y') || fail "cannot read the date"
  # One Provides line per package that ships: lockfile entries with a version, not dev-only, and (when optional) really
  # installed by npm ci above. Lockfile order.
  (cd "$tree" && node -e '
    const fs = require("node:fs");
    const packages = require("./package-lock.json").packages ?? {};
    for (const [key, info] of Object.entries(packages)) {
      if (key === "" || info.dev || !info.version) continue;
      if (info.optional && !fs.existsSync(`${key}/package.json`)) continue;
      process.stdout.write(`Provides:       bundled(nodejs-${key.slice(key.lastIndexOf("node_modules/") + 13)}) = ${info.version}\n`);
    }
  ') >"$work/bundled" || fail "cannot read the bundled packages from the lockfile"
  sed -e "s/@VERSION@/$version/g" -e "s/@DATE@/$date/g" -e "/^@BUNDLED@\$/{r $work/bundled" -e d -e "}" "$template" >"$out/nopipeline.spec" ||
    fail "cannot render the spec"
fi

mkdir -p -- "$result" || fail "cannot create $result"
for f in "$out"/*; do
  mv -f -- "$f" "$result/" || fail "cannot move ${f##*/} into $result"
done
