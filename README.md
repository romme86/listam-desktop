# Listam Desktop

Pear Desktop app for Listam (Phase 12 of the multi-app plan): the mobile
parity surface — one shared P2P list with invite create/join, peer and sync
status, list and grid views, grocery category grouping, and the shared UI
i18n catalogs — rebuilt for large screens around the shared packages.

## Architecture

- **Backend:** the same `@listam/backend` the mobile worklet runs, booted
  in-process under Pear via `@listam/backend/platform/pear` with the
  `desktop` storage namespace (own storage root + storage lease).
- **IPC contract:** `createBackendChannel()` from `@listam/client` — an
  in-process duplex speaking the same RPC command surface and decoded events
  as the mobile worklet transport.
- **State:** `src/store.mjs`, fed only by decoded client events; item
  mutations reduce through `@listam/domain`'s id-keyed reduction.
- **UI:** vanilla DOM (`src/ui.mjs`) styled by `app.css`, which transcribes
  the kinetic-minimalist tokens from `design-guide/`. Keyboard-first:
  `N`/`/` add, `G` view toggle, arrows + `Space`/`Delete` on rows, `?` help.
- **i18n:** the shared Phase 9 catalogs (`en`, `es`, pseudo `en-XA`,
  long-string `en-XL`), selectable from the sidebar.
- **Secrets:** `src/secret-store.mjs` answers the backend's
  `RPC_PERSIST_SECRET` acks from an owner-only JSON file under the app
  storage dir (the documented file tier; OS-keychain integration is
  follow-up work).

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
