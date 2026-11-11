#!/bin/sh
# Publishes the GitHub release for a tag: writes SHA256SUMS over the files in <out-dir>, then creates the release.
# When it already exists, published (a re-run of a failed workflow), nothing is uploaded or changed (a leftover draft is deleted and made again): published assets are never replaced
# (with immutable releases on they could not be anyway), and the caller carries on with the OBS and Copr triggers.
# `gh release create` with files creates a draft, uploads every file and then publishes
# (https://github.com/cli/cli/blob/trunk/pkg/cmd/release/create/create.go), the order GitHub recommends for immutable releases
# (https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases).
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

# `gh release view` also finds drafts. A draft is what an interrupted `gh release create` leaves behind (it creates a draft,
# uploads, then publishes); drafts are not served by releases/latest/download/, so one must not count as "already published".
# Only gh's "release not found" means there is none; any other failure stops here.
err=$(mktemp)
trap 'status=$?; rm -f "$err"; if [ "$status" -ne 0 ] && [ -z "$reported" ]; then printf "publish-release: failed unexpectedly (exit %s)\n" "$status" >&2; fi' EXIT
if state=$(gh release view "$tag" --json isDraft --jq .isDraft 2>"$err"); then
  :
elif grep -qi 'release not found' "$err"; then
  state=none
else
  fail "cannot look up release $tag: $(head -n 1 "$err")"
fi

if [ "$state" = true ]; then
  # --cleanup-tag is deliberately absent: the signed tag stays, only the draft goes.
  printf 'publish-release: release %s is an unpublished draft (an earlier run stopped half way); deleting the draft and creating it again.\n' "$tag"
  gh release delete "$tag" --yes
  state=none
fi

if [ "$state" = none ]; then
  printf '%s\n' "$notes" | gh release create "$tag" --verify-tag --title "nopipeline ${tag#v}" --notes-file - "$@"
else
  printf 'publish-release: release %s already exists; its files are left as they are.\n' "$tag"
fi
