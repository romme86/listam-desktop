# Listam Desktop

Pear Desktop app for Listam (Phase 12 of the multi-app plan): the mobile
parity surface — one shared P2P list with invite create/join, peer and sync
status, list and grid views, grocery category grouping, and the shared UI
i18n catalogs — rebuilt for large screens around the shared packages.

## Architecture

- **Backend:** the same `@listam/backend` the mobile worklet runs, booted in
  a **Pear worker** (`src/backend-worker.mjs`, Bare side) via
  `@listam/backend/platform/pear` with the `desktop` storage namespace. The
  DOM renderer cannot load the bare-* module graph (Pear's app loader rejects
  it), so everything bare lives in the worker — mirroring mobile's worklet.
- **IPC contract:** newline-delimited JSON frames over the Pear worker pipe
  (`src/backend-boot.mjs` renderer side). Events are decoded worker-side with
  `@listam/client`, so the renderer consumes the same decoded client events
  as the mobile transport without bare-dependent imports. Secret persistence
  (`RPC_PERSIST_SECRET`) is answered inside the worker.
- **Dependencies note:** the backend's runtime deps (autobase, hyperswarm,
  corestore, …) are listed explicitly in `package.json` even though they are
  transitive — npm does not flatten deps of `file:`-linked packages into this
  app's `node_modules`, and the Pear drive resolves only within the app tree.
- **State:** `src/store.mjs`, fed only by decoded client events; item
  mutations reduce through `@listam/domain`'s id-keyed reduction.
- **UI:** vanilla DOM (`src/ui.mjs`) styled by `app.css`, which carries the
  Kinetic Minimalist v2 tokens (light + dark themes, motion layer — see
  `design-guide/proposals/2026-06-kinetic-minimalist-v2.md`). Keyboard-first:
  `N`/`/` add, `G` view toggle, `T` theme, `H` shortcut bar, arrows +
  `Space`/`Delete` on rows, `?` help. Theme and UI preferences persist
  locally via `src/prefs.mjs`.
- **i18n:** the shared Phase 9 catalogs (`en`, `es`, pseudo `en-XA`,
  long-string `en-XL`), selectable from the sidebar.
- **Secrets:** `src/secret-store.mjs` answers the backend's
  `RPC_PERSIST_SECRET` acks from an owner-only JSON file under the app
  storage dir (the documented file tier; OS-keychain integration is
  follow-up work).

## Icon

The canonical listam icon lives at `assets/icon.png` (copied from
`listam-mobile/assets/images/icon.png`); it is also the browser-preview
favicon. `assets/listam.icns` is generated from it by the installer build
(`installer/make-icns.swift` masks the artwork into the macOS squircle
grid) and is used by the packaged `Listam.app`, so Finder, Launchpad and the
DMG show the listam icon. The Dock tile of the *running* app still shows the
Pear runtime's icon — the GUI process is Pear's Electron; owning the Dock
tile needs a native [pear-appling](https://github.com/holepunchto/pear-appling)
shell (see `installer/README.md`). For dev-time cosmetics the runtime's
`icon.icns` (inside `Pear Runtime.app/Contents/Resources/`) can be replaced
with `assets/listam.icns`, but that affects every Pear app on the machine and
reverts on runtime updates.

## Package (macOS installer)

```sh
installer/build-macos.sh            # pear stage 'production' + Listam.app shell + DMG
installer/build-macos.sh --release  # also mark the release pointer
```

Produces `installer/dist/Listam-<version>-<channel>.dmg`: a drag-install
appling shell that boots the app from
`pear://h1jwexik1m9c75rqng8hico4oxqgmm8xskws684skmjepksq5r3o` via the Pear
runtime. Installs fetch the drive over the swarm, so keep a seeder running
(`pear seed production .`). Details and caveats: `installer/README.md`.

## Run

```sh
npm install
pear run --dev .        # desktop app with the embedded backend
```

Design preview without Pear (mock backend, fixture data):

```sh
npx serve .             # any static server
# open http://localhost:3000/?mock=1
```

## Test

```sh
npm test                # store + secret-store units, plus the two-instance
                        # invite/join/sync test on a private hyperdht testnet
npm run ci              # lint + test
```

The cross-instance test (`test/sync.test.mjs`) spawns two child-process
backends with separate storage roots on a private DHT bootstrap, pairs them
through a real BlindPairing invite, and asserts id-keyed convergence both
directions — the desktop rows of the plan's interaction matrix at the
protocol level.
