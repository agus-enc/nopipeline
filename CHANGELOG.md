# Changelog

Newest first. Each section lists what a user notices.

## 0.3.0 — 2026-11-12

- Packages for Debian, Ubuntu and Arch, from the openSUSE Build Service (OBS), updated with the system's upgrade. Debian and Ubuntu need Node.js 22.22 or newer from NodeSource.
- Fedora moves to OBS too. Copr keeps building for now; if you use Copr, add the OBS repository and run `sudo dnf copr disable chipp/nopipeline` (see the README).
- On a Node.js that can't run TypeScript (the Debian and Ubuntu archive one), `nopipeline` now says so and points to NodeSource, instead of an obscure error.

## 0.2.0 — 2026-11-11

- Installable on Fedora from Copr, and updated with `dnf upgrade`.
- `nopipeline --version` shows the version.
- The status note and `last-run.log` name the version.
