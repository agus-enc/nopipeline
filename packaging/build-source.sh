#!/usr/bin/env bash
# Builds the rpm source for nopipeline from the newest signed release tag.
# Run by Fedora Copr's "Custom" source method (no arguments, cwd = the result folder).
#
# Usage: build-source.sh [<git-url> [<result-dir> [<tag>]]]
#
# Only a tag signed by the release key can produce a build. The key is the line below, filled in when this script is
# pasted into Copr. It is never read from the repository, so a tampered repository cannot change which key is trusted.
set -euo pipefail

ALLOWED_SIGNERS='@RELEASE_SIGNERS@'

url=${1:-https://github.com/agus-enc/nopipeline.git}
result=${2:-.}
tag=${3:-}

# Git must not depend on the caller's configuration.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0

reported=
fail() {
  reported=1
  printf 'build-source: %s\n' "$*" >&2
  exit 1
}

work=$(mktemp -d)
cleanup() {
  local status=$?
  rm -rf "$work"
  if [ "$status" -ne 0 ] && [ -z "$reported" ]; then
    printf 'build-source: failed unexpectedly (exit %s)\n' "$status" >&2
  fi
}
trap cleanup EXIT

[ "${ALLOWED_SIGNERS#@}" = "$ALLOWED_SIGNERS" ] || fail "the release key was not filled in"
[[ $ALLOWED_SIGNERS =~ ^releases\ ssh-ed25519\ [A-Za-z0-9+/=]+$ ]] || fail "the release key line is malformed"
printf '%s\n' "$ALLOWED_SIGNERS" >"$work/allowed_signers"

result=$(realpath -m -- "$result")

git clone --quiet --bare -- "$url" "$work/repo.git" || fail "cannot clone $url"
git() { command git -C "$work/repo.git" "$@"; }

semver='^v[0-9]+\.[0-9]+\.[0-9]+$'
if [ -z "$tag" ]; then
  tag=$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | grep -E "$semver" | head -n 1 || true)
  [ -n "$tag" ] || fail "no release tag (vX.Y.Z) in $url"
fi
[[ $tag =~ $semver ]] || fail "$tag is not a release tag name (vX.Y.Z)"
version=${tag#v}

[ "$(git cat-file -t "refs/tags/$tag" 2>/dev/null || true)" = tag ] ||
  fail "$tag is not signed by the release key (it is not an annotated tag)"
verify_out=$(git -c gpg.format=ssh -c "gpg.ssh.allowedSignersFile=$work/allowed_signers" verify-tag "$tag" 2>&1) ||
  fail "$tag is not signed by the release key ($(printf '%s' "$verify_out" | tr '\n' ' '))"
# A signed tag object could have been stored under another name; the signed name must be this one.
[ "$(git cat-file tag "$tag" | sed -n 's/^tag //p;/^$/q' | head -n 1)" = "$tag" ] ||
  fail "$tag is not signed by the release key (the signed tag has another name)"
commit=$(git rev-parse "$tag^{commit}")

out="$work/out"
mkdir -p "$out"
mkdir "$work/tree"
git archive --format=tar --prefix="nopipeline-$version/" "$commit" | tar -x -C "$work/tree" ||
  fail "cannot archive $tag"
tree="$work/tree/nopipeline-$version"

pkg_version=$(cd "$tree" && node -p "require('./package.json').version") || fail "cannot read package.json"
[ "$pkg_version" = "$version" ] || fail "package.json says $pkg_version but the tag is $tag"
dep_count=$(cd "$tree" && node -p "Object.keys(require('./package.json').dependencies ?? {}).length") ||
  fail "cannot read package.json"

if [ "${NOPIPELINE_SKIP_AUDIT:-}" = 1 ] && [ "$dep_count" != 0 ]; then
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
  sed "s/@VERSION@/$version/g" "$template" >"$out/nopipeline.spec" || fail "cannot render the spec"
fi

mkdir -p -- "$result" || fail "cannot create $result"
for f in "$out"/*; do
  mv -f -- "$f" "$result/" || fail "cannot move $(basename "$f") into $result"
done
