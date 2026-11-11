#!/bin/sh
# Manual check of the Arch recipe (not part of npm test). Builds the OBS source from the current HEAD tree in a throwaway
# signed repo, with a throwaway OpenPGP repo key standing in for the OBS one, then in an archlinux container builds the
# package with makepkg as a normal user, installs it with pacman -U, runs it, and checks that pacman's keyring now holds
# the throwaway key, locally signed.
# Needs git, ssh-keygen, gpg, curl, npm, Docker, and the network (npm, the container image, Arch mirrors).
# It builds from `git archive HEAD`: commit your changes before running it. Touches only temp folders.
# Run from the repository root: packaging/arch/check-arch.sh
# With --from <folder> it skips the throwaway keys and repo and checks the files in <folder> instead (the release
# workflow's output folder), expecting pacman's keyring to end up with the key pinned in packaging/obs-signing-key.fingerprint.
#
# The container runs a full `pacman -Syu`: a partial upgrade (-Sy) breaks the image's nodejs (libcrypto mismatch).
set -eu

[ -f packaging/build-source.sh ] || { echo "check-arch: run this from the repository root" >&2; exit 1; }

from=
if [ "${1:-}" = "--from" ]; then
  [ $# -eq 2 ] && [ -d "$2" ] || { echo "usage: packaging/arch/check-arch.sh [--from <folder with the release files>]" >&2; exit 1; }
  from=$(cd "$2" && pwd)
elif [ $# -ne 0 ]; then
  echo "usage: packaging/arch/check-arch.sh [--from <folder with the release files>]" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Same rule as build-source.sh: git must not depend on the caller's configuration.
for name in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$name"; done
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1

step() { printf '\n== %s\n' "$*"; }
version=$(node -p "require('./package.json').version")

make_source() {
  step "throwaway repo key (OpenPGP, in a temporary GNUPGHOME) served to obs-key.sh through file://"
  mkdir -m 700 "$work/gnupg"
  GNUPGHOME="$work/gnupg" gpg --batch --quiet --passphrase '' --quick-generate-key 'check-arch <check-arch@example.invalid>' ed25519 sign never
  fpr=$(GNUPGHOME="$work/gnupg" gpg --batch --with-colons --list-keys | awk -F: '$1=="fpr"{print $10; exit}')
  GNUPGHOME="$work/gnupg" gpg --batch --quiet --export "$fpr" >"$work/repo-key.gpg"
  sh packaging/obs-key.sh "file://$work/repo-key.gpg" "$fpr" "$work/obs"
  ls -l "$work/obs/keys"

  step "throwaway signing key and signed repo for v$version (from the current HEAD tree)"
  ssh-keygen -q -N '' -t ed25519 -f "$work/key"
  mkdir "$work/repo"
  git archive HEAD | tar -x -C "$work/repo"
  git -C "$work/repo" init --quiet --initial-branch=main
  git -C "$work/repo" add -A
  git -C "$work/repo" -c user.name=Check -c user.email=check@example.com commit --quiet -m "check"
  git -C "$work/repo" -c user.name=Check -c user.email=check@example.com -c gpg.format=ssh -c "user.signingkey=$work/key" \
    tag -s -m "v$version" "v$version"

  step "build-source.sh with the throwaway key and the throwaway repo key"
  signer="releases $(cut -d' ' -f1,2 "$work/key.pub")"
  sed "s|@RELEASE_SIGNERS@|$signer|" packaging/build-source.sh >"$work/build-source.sh"
  mkdir "$src"
  NOPIPELINE_REPO_KEYS="$work/obs/keys" sh "$work/build-source.sh" "$work/repo" "$src"
  ls -l "$src"
}

if [ -n "$from" ]; then
  src=$from
  # The release files carry the real OBS repo key: its pinned fingerprint is what pacman's keyring must end up holding.
  fpr=$(tr -d ' \n' <packaging/obs-signing-key.fingerprint)
  uid_pattern=
  step "using the release files in $src"
else
  src="$work/src"
  uid_pattern=check-arch
  make_source
fi
for f in PKGBUILD nopipeline.install nopipeline.tar.gz; do
  [ -f "$src/$f" ] || { echo "check-arch: build-source.sh did not write $f" >&2; exit 1; }
done
cat "$src/PKGBUILD"

# Runs inside archlinux as root: build as a normal user, install, run, check the keyring.
cat >"$work/check.sh" <<'INNER'
set -eu
fpr=$1
uid_pattern=$2
pacman-key --init
pacman -Syu --noconfirm --needed base-devel nodejs
echo "nodejs: $(node --version)"
useradd -m builder
mkdir /home/builder/pkg
cp /src/PKGBUILD /src/nopipeline.install /src/nopipeline.tar.gz /home/builder/pkg/
chown -R builder /home/builder/pkg
su builder -c 'cd /home/builder/pkg && makepkg -f --noconfirm'
pkg=$(ls /home/builder/pkg/nopipeline-*-any.pkg.tar.*)
pacman -Qip "$pkg"
pacman -U --noconfirm "$pkg"
node --version
nopipeline --version
nopipeline --help >/dev/null
[ "$(stat -c %a /usr/bin/nopipeline)" = 755 ]
cmp /usr/bin/nopipeline /launcher.sh
for f in nopipeline.gpg nopipeline-trusted; do
  [ "$(stat -c %a "/usr/share/pacman/keyrings/$f")" = 644 ] || { echo "check-arch: bad mode on $f" >&2; exit 1; }
done
pacman-key --list-keys "$fpr"
# the throwaway key is in pacman's keyring and carries a local signature (lsign) from the keyring's master key
pacman-key --list-sigs "$fpr" | tee /tmp/sigs
[ -z "$uid_pattern" ] || grep -q "$uid_pattern" /tmp/sigs
grep -Eq '^sig +L .*Pacman Keyring Master Key' /tmp/sigs || { echo "check-arch: the throwaway key is not locally signed" >&2; exit 1; }
# when pacman-key --populate fails, the scriptlets print the hint and still succeed
mkdir /tmp/fake
printf '#!/bin/sh\nexit 1\n' >/tmp/fake/pacman-key
chmod +x /tmp/fake/pacman-key
for fn in post_install post_upgrade; do
  out=$(PATH=/tmp/fake:$PATH sh -c '. /src/nopipeline.install; '"$fn" 2>&1)
  printf '%s\n' "$out" | grep -q 'could not load the repo key' || { echo "check-arch: no hint from $fn" >&2; exit 1; }
done
# an upgrade (reinstall) runs post_upgrade without failing
pacman -U --noconfirm "$pkg"
INNER

step "archlinux: makepkg, pacman -U, run, keyring"
docker run --rm -v "$src:/src:ro,z" -v "$work/check.sh:/check.sh:ro,z" -v "$PWD/packaging/nopipeline-launcher.sh:/launcher.sh:ro,z" archlinux:latest sh /check.sh "$fpr" "$uid_pattern"

step "all checks passed"
