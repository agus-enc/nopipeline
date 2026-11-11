#!/bin/sh
# Publishes the GitHub release for a tag: writes SHA256SUMS over the files in <out-dir>, then creates the release, or,
# when it already exists (a re-run of a failed workflow), uploads the files to it again with --clobber.
#
# Usage: publish-release.sh <out-dir> <tag>
#
# <out-dir> holds the release assets with their fixed names; every regular file in it is published, SHA256SUMS included.
# Needs gh (GH_TOKEN in the environment), node, sha256sum. Run from anywhere; the notes come from the repository this script is in.
set -eu

reported=
fail() {
  reported=1
  printf 'publish-release: %s\n' "$*" >&2
  exit 1
}
trap 'status=$?; if [ "$status" -ne 0 ] && [ -z "$reported" ]; then printf "publish-release: failed unexpectedly (exit %s)\n" "$status" >&2; fi' EXIT

[ $# -eq 2 ] || fail "usage: publish-release.sh <out-dir> <tag>"
out=$1
tag=$2
printf '%s\n' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || fail "the tag must look like v1.2.3"
[ -d "$out" ] || fail "$out is not a folder"
out=$(cd "$out" && pwd)
root=$(cd "$(dirname "$0")/.." && pwd)

# The notes first: if the changelog has no section for this version, nothing is published.
notes=$(cd "$root" && node scripts/release.ts --notes) || fail "cannot make the release notes"

# SHA256SUMS covers every other file (names only, so `sha256sum -c` works in the download folder). A re-run replaces it.
rm -f "$out/SHA256SUMS"
(
  cd "$out"
  set --
  for f in *; do
    [ -f "$f" ] || continue
    set -- "$@" "$f"
  done
  [ $# -gt 0 ] || exit 1
  sha256sum -- "$@" >SHA256SUMS
) || fail "no files to publish in $out"

set --
for f in "$out"/*; do
  [ -f "$f" ] && set -- "$@" "$f"
done

if gh release view "$tag" >/dev/null 2>&1; then
  gh release upload "$tag" "$@" --clobber
else
  printf '%s\n' "$notes" | gh release create "$tag" --verify-tag --title "nopipeline ${tag#v}" --notes-file - "$@"
fi
