# Listam desktop installer

Builds a drag-install macOS DMG for the Pear desktop app. Pear apps are not
packaged like Electron apps — the installer ships a tiny **appling shell**
(`Listam.app`, ~100 KB) that boots the real app from its P2P drive via the
Pear runtime; the app payload itself travels over the swarm, not inside the
DMG.

## Build

```sh
installer/build-macos.sh                  # stage to 'production' + build DMG
installer/build-macos.sh --release        # also mark the staged tip as the release
installer/build-macos.sh --channel beta   # different channel = different key/identity
installer/build-macos.sh --skip-stage     # rebuild DMG without restaging
```

Output: `installer/dist/Listam-<version>-<channel>.dmg`. The full `pear stage`
log is kept at `installer/dist/stage-<channel>.jsonl`.

Steps performed:

1. `pear stage <channel>` of the app dir (capturing the `pear://` link).
   The ignore list excludes `.git`, `test/`, `design-guide/`, `installer/`
   and the secrets file — note that a custom ignore list **replaces** Pear's
   defaults, so `.git` must always be restated (both here and in
   `package.json`'s `pear.stage.ignore`).
2. Generates `assets/listam.icns` from `assets/icon.png` if stale
   (`make-icns.swift` masks the artwork into the macOS squircle grid).
3. Assembles `Listam.app`: `launcher.sh` (with the link baked in) as the
   executable, Info.plist (`ch.saynode.listam.desktop`), the icns.
4. Ad-hoc codesigns the bundle and wraps it in a UDZO DMG with an
   `/Applications` symlink.

## What the installed app does

`Listam.app` locates the Pear runtime and runs
`pear run --appling <bundle> pear://<key>`. If Pear is not installed it shows
a dialog pointing at [pears.com](https://pears.com). A fast nonzero exit
(e.g. the one-time trust approval Pear requires for an unknown key) shows a
dialog with the `pear run <link>` command to approve it from Terminal once.

## Distribution model

- **Channel/key:** `production` →
  `pear://h1jwexik1m9c75rqng8hico4oxqgmm8xskws684skmjepksq5r3o`.
  The key is minted by the local sidecar per (name, channel); staging from a
  different machine produces a *different* key, so always cut installers from
  the machine (or seeded drive) that owns this one.
- **Seeding:** installs fetch the drive over the swarm. Keep a seeder
  running, e.g. `pear seed production listam-desktop/` (the Geekom VMs are
  natural hosts). Updates ship by restaging — running apps follow the drive.
- **Release pointer:** without `--release` consumers run the staged tip
  (`tier: staging`). Mark releases deliberately: `pear release production .`
- **Gatekeeper:** the bundle is ad-hoc signed, not notarized. A DMG that
  arrives with a quarantine flag needs right-click → Open (or
  `xattr -dr com.apple.quarantine /Applications/Listam.app`).

## Native shell (appling/)

`appling/` is a vendored [pear-appling](https://github.com/holepunchto/pear-appling)
project (cmake-pear, libappling — the mechanism Keet uses): a compiled
`Listam.app` that owns the Dock tile, shows `assets/splash.png` while booting,
handles first-run trust in-GUI, and bootstraps the Pear runtime itself on a
fresh machine (no "install Pear first" dialog). Build it with cmake ≥ 4 +
ninja (Homebrew, or a Python venv: `python3 -m venv /tmp/pear-buildtools &&
/tmp/pear-buildtools/bin/pip install cmake ninja`):

```sh
cd installer/appling
npm i --ignore-scripts
PATH="/tmp/pear-buildtools/bin:$PATH" cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
PATH="/tmp/pear-buildtools/bin:$PATH" cmake --build build      # → build/Listam.app
cd ../.. && installer/build-macos.sh --native                  # DMG with the native shell
```

Configure fetches pinned holepunch deps (bare, libjstl, libappling, libfx,
libpear) from GitHub. The drive key is baked at compile time
(`-DLISTAM_ID=<z32-key>` to override, e.g. for a beta channel);
`build-macos.sh --native` refuses a bundle whose embedded key does not match
the staged channel. Signing is ad-hoc (`MACOS_SIGNING_IDENTITY "-"`) until a
Developer ID exists; the cmake build signs with the JIT entitlements the
runtime needs, so the bundle must not be re-signed casually.

## Seeding agent

`seed-agent.sh install` registers a LaunchAgent (`ch.saynode.listam.seed`)
that runs `pear seed production <this checkout>` at login and keeps it alive
(log: `~/Library/Logs/listam-seed.log`). `uninstall` / `status` to manage.
Without a live seeder, installs on other machines cannot fetch the app.

## Known limits / follow-ups

- The script-shell DMG (default, no toolchain needed) does not own the
  running Dock tile and needs Pear preinstalled — use `--native` once the
  appling is built.
- Windows/Linux installers: `appling/CMakeLists.txt` already carries the
  Windows/Linux settings; the MSIX/AppImage packaging steps run on those
  hosts, but no CI exists yet.
