#!/bin/sh
# Fetches the OBS repository signing key and ships it only when its primary fingerprint is the pinned one.
#
# Usage: obs-key.sh <key-url> <fingerprint> <out-dir>
#        obs-key.sh --project <obs-project> <fingerprint> <out-dir>
#
# Writes <out-dir>/keys/{nopipeline-archive-keyring.gpg,nopipeline.gpg,nopipeline-trusted} and <out-dir>/expires
# (the primary key's expiry in Unix seconds, 0 for none). Nothing is written unless every check passes.
# Exit status: 0 ok; 2 the download has no key with the pinned fingerprint (scripts/key-check.ts tells this apart); 1 any other failure.
# gpg runs in a private temporary home: the caller's keyring is never read or changed.
set -eu

reported=
fail() {
  reported=1
  printf 'obs-key: %s\n' "$*" >&2
  exit 1
}

work=$(mktemp -d)
cleanup() {
  status=$?
  rm -rf "$work"
  if [ "$status" -ne 0 ] && [ -z "$reported" ]; then
    printf 'obs-key: failed unexpectedly (exit %s)\n' "$status" >&2
  fi
}
trap cleanup EXIT

# Like fail, but exit 2: the served key is not the pinned one.
mismatch() {
  reported=1
  printf 'obs-key: %s\n' "$*" >&2
  exit 2
}

# The one place that knows where OBS serves a project's signing key.
project_url() {
  printf 'https://build.opensuse.org/projects/%s/signing_keys/download?kind=gpg' "$1"
}

if [ "${1:-}" = "--project" ]; then
  [ $# -eq 4 ] || fail "usage: obs-key.sh --project <obs-project> <fingerprint> <out-dir>"
  project=$2
  [ -n "$project" ] || fail "the OBS project name is empty"
  case $project in *[!A-Za-z0-9:._-]*) fail "the OBS project name has characters outside letters, digits, : . _ -" ;; esac
  url=$(project_url "$project")
  shift 2
else
  [ $# -eq 3 ] || fail "usage: obs-key.sh <key-url> <fingerprint> <out-dir>"
  url=$1
  shift
fi
fingerprint=$1
out=$2

# grep -q passes when any one line matches, so a value with a line break is refused first.
case $fingerprint in *"
"*) fail "the fingerprint is not 40 hex characters" ;; esac
printf '%s\n' "$fingerprint" | grep -Eq '^[0-9A-Fa-f]{40}$' || fail "the fingerprint is not 40 hex characters"
fingerprint=$(printf '%s' "$fingerprint" | tr 'a-f' 'A-F')

export GNUPGHOME="$work/gnupg"
mkdir -m 700 "$GNUPGHOME"
gpgb() { gpg --batch --no-tty "$@"; }

curl -fsSL --proto '=https,file' --max-time 60 -o "$work/download" -- "$url" 2>/dev/null || fail "cannot download the key from $url"
gpgb --import "$work/download" >/dev/null 2>&1 || fail "the download from $url has no key"

# In --with-colons output the first fpr line after a pub line is that key's primary fingerprint.
primaries=$(gpgb --with-colons --fingerprint --list-keys 2>/dev/null | awk -F: '$1=="pub"{want=1;next} $1=="fpr"&&want{print $10;want=0}')
printf '%s\n' "$primaries" | grep -Fxq "$fingerprint" || mismatch "no key in the download has the pinned fingerprint"

# export-clean drops other people's certifications; export-minimal keeps only the newest self-signatures.
gpgb --export --export-options export-minimal,export-clean "$fingerprint" >"$work/key.gpg" 2>/dev/null || fail "cannot export the pinned key"
[ -s "$work/key.gpg" ] || fail "cannot export the pinned key"

# Field 7 of the pub line is the expiry (empty when the key does not expire).
expires=$(gpgb --with-colons --list-keys "$fingerprint" 2>/dev/null | awk -F: '$1=="pub"{print $7; exit}')
case $expires in '' ) expires=0 ;; *[!0-9]*) fail "cannot read the key's expiry" ;; esac

mkdir -p "$out/keys"
cp "$work/key.gpg" "$out/keys/nopipeline-archive-keyring.gpg"
cp "$work/key.gpg" "$out/keys/nopipeline.gpg"
printf '%s:4:\n' "$fingerprint" >"$out/keys/nopipeline-trusted"
printf '%s\n' "$expires" >"$out/expires"
