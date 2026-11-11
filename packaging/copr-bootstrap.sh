#!/bin/sh
# Copr's custom script (4 kB limit): verifies the newest release tag, then runs the build-source.sh from that tag.
# Usage: copr-bootstrap.sh [<git-url> [<tag>]]   (cwd = the result folder; Copr passes no arguments)
# The key line below is filled in when this is pasted into Copr; it is never read from the repository.
set -eu

ALLOWED_SIGNERS='@RELEASE_SIGNERS@'
url=${1:-https://github.com/agus-enc/nopipeline.git}
tag=${2:-}

for name in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$name"; done
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0

reported=
fail() { reported=1; printf 'copr-bootstrap: %s\n' "$*" >&2; exit 1; }
work=$(mktemp -d)
cleanup() {
  status=$?
  rm -rf "$work"
  [ "$status" -eq 0 ] || [ -n "$reported" ] || printf 'copr-bootstrap: failed unexpectedly (exit %s)\n' "$status" >&2
}
trap cleanup EXIT

[ "${ALLOWED_SIGNERS#@}" = "$ALLOWED_SIGNERS" ] || fail "the release key was not filled in"
case $ALLOWED_SIGNERS in *"
"*) fail "the release key line is malformed" ;; esac
printf '%s\n' "$ALLOWED_SIGNERS" | grep -Eq '^releases ssh-ed25519 [A-Za-z0-9+/=]+$' || fail "the release key line is malformed"
printf '%s\n' "$ALLOWED_SIGNERS" >"$work/allowed_signers"

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

[ "$(gitc cat-file -t "refs/tags/$tag" 2>/dev/null || true)" = tag ] ||
  fail "$tag is not signed by the release key (it is not an annotated tag)"
# Only an SSH signature is accepted; git would check an OpenPGP or x509 one against the builder's own keyring.
gitc cat-file tag "refs/tags/$tag" | grep -q '^-----BEGIN SSH SIGNATURE-----$' ||
  fail "$tag is not signed by the release key (it carries no SSH signature)"
verify_out=$(gitc -c gpg.format=ssh -c gpg.ssh.program=ssh-keygen -c gpg.openpgp.program=false -c gpg.x509.program=false \
  -c "gpg.ssh.allowedSignersFile=$work/allowed_signers" verify-tag "refs/tags/$tag" 2>&1) ||
  fail "$tag is not signed by the release key${verify_out:+ ($(printf '%s' "$verify_out" | tr '\n' ' '))}"
[ "$(gitc cat-file tag "refs/tags/$tag" | sed -n 's/^tag //p;/^$/q' | head -n 1)" = "$tag" ] ||
  fail "$tag is not signed by the release key (the signed tag has another name)"

# The verified commit's own build-source.sh does the rest (and verifies the tag again with the same key).
gitc show "refs/tags/$tag^{commit}:packaging/build-source.sh" >"$work/build-source.sh.in" || fail "$tag has no packaging/build-source.sh"
sed "s|^ALLOWED_SIGNERS=.*|ALLOWED_SIGNERS='$ALLOWED_SIGNERS'|" "$work/build-source.sh.in" >"$work/build-source.sh"
sh "$work/build-source.sh" "$url" . "$tag"
