# Listam desktop installer

Builds a drag-install macOS DMG and a Windows zip for the Pear desktop app.
Pear apps are not packaged like Electron apps — the installer ships a tiny
**appling shell** (`Listam.app`, ~100 KB) that boots the real app from its P2P
drive via the Pear runtime; the app payload itself travels over the swarm, not
inside the DMG.

| Platform | Command | Output |
|---|---|---|
| macOS | `installer/build-macos.sh` | `Listam-<version>-<channel>.dmg` |
| Windows | `installer\build-windows.ps1` | `Listam-<version>-win32-x64.zip` |

## Build (macOS)

```sh
installer/build-macos.sh                  # stage + release production + build DMG
installer/build-macos.sh --release        # explicit equivalent for production
installer/build-macos.sh --channel beta --stage-only  # unpublished preview
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
2. For `production`, advances the release pointer and verifies that it equals
   the staged tip. Production cannot be built with `--stage-only`; use a beta
   channel for unpublished previews.
3. Generates `assets/listam.icns` from `assets/icon.png` if stale
   (`make-icns.swift` masks the artwork into the macOS squircle grid).
4. Assembles `Listam.app`: `launcher.sh` (with the link baked in) as the
   executable, Info.plist (`ch.saynode.listam.desktop`), the icns.
5. Ad-hoc codesigns the bundle and wraps it in a UDZO DMG with an
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
- **Release pointer:** production builds always move and verify the pointer.
  Use `--channel beta --stage-only` when you need a staged, unpublished tip.
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

## Build (Windows)

Windows ships the **native appling only** — there is no script-shell fallback,
and deliberately so: the native shell bootstraps the Pear runtime itself, so a
Windows user never has to install Pear first. (The Pear installer failing on
Windows is the reason this path exists.)

```powershell
installer\build-windows.ps1                        # production key from CMakeLists.txt
installer\build-windows.ps1 -Id <z32-key>          # another channel, verified against the exe
installer\build-windows.ps1 -Version 0.19.14 -Msix # also pack the MSIX (needs a cert)
```

Output: `installer/dist/Listam-<version>-win32-x64.zip`.

No `pear stage` happens here. The appling embeds a drive key and nothing else,
so **staging stays a macOS-side step** — cut the release with `build-macos.sh`
first, then build Windows against the same key. Nor does this build need
`node_modules/` or the `listam-packages` sibling: only `installer/appling/`.

Requirements — the script enters the MSVC environment itself, so a plain
PowerShell session is fine (`-SkipDevShell` if you are already in a Developer
PowerShell):

- Visual Studio with the **Desktop development with C++** workload
- `winget install Kitware.CMake Ninja-build.Ninja NASM.NASM`
  (**nasm is not optional** — bare enables `ASM_NASM` on `win32-x64` and fails
  deep inside a dependency without it)
- Working **outbound UDP**: configure pulls bare's prebuilt V8 for `win32-x64`
  over the Hyperswarm DHT (`mirror_drive`). A configure that hangs rather than
  errors is the DHT being unreachable.

Expect a long first build (~1.5 GB of native dependencies: boringssl, rocksdb,
libudx, …). V8 itself is a prebuilt, not compiled from source.

### Ship the zip, not the bare exe

`libpear` loads its boot splash from `<exe>\..\splash.png` **with an assert on
failure**, so a lone `Listam.exe` aborts on the very first run — precisely the
bootstrap path a new user takes. `splash.png` must sit beside `Listam.exe`.
Both the script and the CI job package the pair.

### Gotchas

- **Never `cmake --build build` with no target.** `cmake-pear` registers its
  `signtool` and `MakeAppx` steps as **ALL** targets, so a plain build fails on
  any machine without a code-signing certificate in its store. Build
  `--target listam_appling`.
- **MAX_PATH.** `libappling`'s test fixtures nest a 64-character key directory
  inside a `Pear Runtime.app/Contents/MacOS` path, which overflows Windows'
  260-character limit: git aborts the checkout with `Filename too long`
  minutes into the configure. `git config --global core.longpaths true`, or
  pass `-FetchBase C:\listam-deps` to shorten the dependency path instead.
  The script refuses to start without one of the two.
- **C11 atomics.** `bare` sets `C_STANDARD 11` and includes `<stdatomic.h>`,
  but MSVC keeps C11 atomics behind `/experimental:c11atomics` — without it
  every bare translation unit fails with
  `C1189: "C atomic support is not enabled"`. The script passes it via
  `CMAKE_C_FLAGS`, restating MSVC's stock `/DWIN32 /D_WINDOWS` because
  assigning that variable replaces the defaults instead of appending.
- **CRT mismatch.** `cmake-pear` compiles the appling with `/MT` while
  dependencies default to `/MD`; bare's link options assume the static CRT.
  The script puts every target on it with `CMAKE_MSVC_RUNTIME_LIBRARY`.
- **MSIX needs a signed cert to install at all**, which is why the zip is the
  default deliverable. `-Msix` is there for when a Developer ID exists.
- The `.exe` is unsigned, so SmartScreen shows "Windows protected your PC" →
  **More info → Run anyway**. Authenticode signing is the fix; there is no
  Windows equivalent of the macOS ad-hoc signature.
- `CMakeLists.txt` compiles `assets/win32/icon.ico` into the exe as a resource.
  `cmake-pear` only wires an icon into the MSIX, so without this the bare exe
  carries the blank default icon. Regenerate it from macOS after changing the
  artwork:
  ```sh
  installer/make-ico.py installer/appling/assets/win32/icon.png \
                        installer/appling/assets/win32/icon.ico
  ```

### Building it without a Windows machine

`.github/workflows/windows-appling.yml` runs the same script on a
`windows-latest` runner (manual dispatch — Actions → windows-appling → Run
workflow, with optional key/version inputs) and uploads `Listam.exe` +
`splash.png` as an artifact. This is the path to a Windows build from a Mac:
the appling links the static CRT and a Windows subsystem entry point, neither
of which cross-compiles from macOS.

## Seeding agent

`seed-agent.sh install` registers a LaunchAgent (`ch.saynode.listam.seed`)
that runs `pear seed production <this checkout>` at login and keeps it alive
(log: `~/Library/Logs/listam-seed.log`). `uninstall` / `status` to manage.
Without a live seeder, installs on other machines cannot fetch the app.

## Known limits / follow-ups

- The script-shell DMG (default, no toolchain needed) does not own the
  running Dock tile and needs Pear preinstalled — use `--native` once the
  appling is built.
- Neither the macOS nor the Windows build is signed by a real identity
  (ad-hoc on macOS, unsigned on Windows), so both trip their platform's
  gatekeeper on first launch.
- **Linux:** `appling/CMakeLists.txt` already carries the Linux settings and
  `add_app_image` produces an AppImage, but there is no build script or CI job
  for it yet — the Windows pair (`build-windows.ps1` + `windows-appling.yml`)
  is the template to copy.
