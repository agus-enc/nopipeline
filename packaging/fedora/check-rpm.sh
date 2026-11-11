#!/bin/sh
# Manual check of the built package (not part of npm test): builds the rpm from the current HEAD tree in a throwaway
# signed repo, then installs it in fedora:43 and fedora:44 containers. Touches only temp folders; needs git,
# ssh-keygen, node, npm, rpmbuild, rpm and docker, and the network (npm and the container images).
# Run from the repository root: packaging/fedora/check-rpm.sh
set -eu

[ -f packaging/build-source.sh ] || { echo "check-rpm: run this from the repository root" >&2; exit 1; }
root=$(pwd)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Same rule as build-source.sh: git must not depend on the caller's configuration.
for name in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$name"; done
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1

step() { printf '\n== %s\n' "$*"; }
version=$(node -p "require('./package.json').version")

step "throwaway signing key and signed repo for v$version (from the current HEAD tree)"
ssh-keygen -q -N '' -t ed25519 -f "$work/key"
mkdir "$work/repo"
git archive HEAD | tar -x -C "$work/repo"
git -C "$work/repo" init --quiet --initial-branch=main
git -C "$work/repo" add -A
git -C "$work/repo" -c user.name=Check -c user.email=check@example.com commit --quiet -m "check"
git -C "$work/repo" -c user.name=Check -c user.email=check@example.com -c gpg.format=ssh -c "user.signingkey=$work/key" \
  tag -s -m "v$version" "v$version"

step "build-source.sh with the throwaway key (as Copr would run it)"
signer="releases $(cut -d' ' -f1,2 "$work/key.pub")"
sed "s|@RELEASE_SIGNERS@|$signer|" packaging/build-source.sh >"$work/build-source.sh"
mkdir "$work/src"
sh "$work/build-source.sh" "$work/repo" "$work/src"
ls -l "$work/src"

step "rpmbuild"
mkdir -p "$work/top/SOURCES"
cp "$work/src/nopipeline-$version.tar.gz" "$work/top/SOURCES/"
rpmbuild -ba --define "_topdir $work/top" "$work/src/nopipeline.spec"
rpm_file=$(ls "$work"/top/RPMS/noarch/nopipeline-*.rpm)

step "provides of the built rpm"
rpm -qp --provides "$rpm_file"
provides=$(rpm -qp --provides "$rpm_file")
for want in 'bundled(nodejs-@notionhq/client) = 5.' 'bundled(nodejs-node-diff3) = 3.'; do
  printf '%s\n' "$provides" | grep -qF "$want" || { echo "check-rpm: missing Provides: $want" >&2; exit 1; }
done
[ "$(printf '%s\n' "$provides" | grep -c '^bundled(')" = 2 ] || { echo "check-rpm: expected exactly two bundled Provides" >&2; exit 1; }

for n in 43 44; do
  step "fedora:$n"
  docker run --rm -v "$work/top/RPMS:/rpms:ro" "fedora:$n" \
    sh -c 'dnf -y install /rpms/noarch/*.rpm && nopipeline --version && nopipeline --help >/dev/null && node --version'
done

step "all checks passed"
