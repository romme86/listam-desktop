# Kinetic Minimalist v2 — Desktop UI & Design System Redesign

**Status: phases 1–2 IMPLEMENTED (2026-06-11, user-approved); phases 3–4
open.** The guide merge (phase 4) has not happened yet, so
`design-guide/kinetic_minimalist/DESIGN.md` still reflects v1 — where the
shipped app and the guide disagree (done-recede, dark theme, scrollbars,
label floor, `title-lg` page titles), this document is the intended state.

- Date: 2026-06-11
- Scope: `listam-desktop` (`app.css`, `src/ui.mjs` IA) and `design-guide/`
- Non-scope: shared packages (except additive i18n keys), mobile, protocol —
  nothing here changes the RPC surface or domain model.

## 0. Implementation status

Shipped in `app.css` / `src/ui.mjs` / `src/prefs.mjs` / `src/main.mjs`:

- Tokens v2 (semantic surfaces/inks/signals), light + dark palettes via
  `html[data-theme]`, `prefers-color-scheme` pre-JS fallback, persisted
  `theme` preference (`system → light → dark`, sidebar control + `T`).
- The `--ink-block` contrast amendment (§4.2) — found when the first dark
  mockup put acid text on near-white.
- Done-recede + selection-pending (§6.3 selection-ink layer not yet built).
- Beacon `live`/`local` states on the summary dot (hollow ring when 0 peers,
  breathing acid when live); `syncing`/`attention` shapes pending.
- Motion layer (§4.6): row enter / remote-arrival pulse / completion flash /
  un-complete / animated exits with staggered clear-done, dialog + notice +
  pane + hint-bar transitions, badge pop, duplicate-add shake,
  `prefers-reduced-motion` honored (CSS + JS delays).
- Shortcut hint bar (new component, §6.10): tonal bottom strip, hide via its
  ✕ or `H`, re-show via sidebar toggle or `H`, persisted preference.
- Floors: visible scrollbars, 11px label floor, `title-lg` page titles,
  add-input draft/focus survive re-renders.

Phase-3 items shipped 2026-06-12 (user-directed): the **three-zone sidebar**
(brand row, list rail with Overview/Todo/Travel as disabled "soon"
placeholders, status strip + Peers/Activity/Settings system nav), a
**Settings dialog** (theme / shortcut-bar / language — the old sidebar locale
stack and footer controls moved there), **Tabler outline icons** vendored in
`src/tabler-icons.mjs` replacing the emoji glyph set (nav, categories,
controls — stroke icons inherit ink, so they theme automatically), a
**summonable add-bar** (hidden until `N` or the header +; `Esc`/empty-blur
dismisses), and **window chrome** (drag-region titlebar + `<pear-ctrl>`
traffic lights; dark native window background). The backend also moved into
a Pear worker (see README architecture) — that unblocked the embedded
backend under the current Pear runtime.

Open: project switcher menu, inspector, ⌘K palette, trust-grammar dialogs,
multi-select selection-ink, density attribute, guide merge + screen regen.

---

## 1. Parameters

The seven properties this proposal optimizes for, chosen from what listam
actually is: a local-first P2P app whose desktop surface should be the power
surface, heading from one shared list toward projects holding multiple typed
lists.

| # | Parameter | Why it matters here |
|---|-----------|---------------------|
| P1 | **Sync legibility** | There is no server and no "saved ✓" crutch. The UI must answer at a glance: does this data exist only on this device, is it replicating, who is live. Today that's one 8px dot and a number. |
| P2 | **Structural headroom** | The roadmap model is *project (= one Autobase base) → multiple typed lists, sharing per-project*. The IA must be designed for that target now and rendered degenerate (one project, one list) today, so multi-list doesn't force a second redesign. The `personal_ops_overview_rounded` and `todo_board_rounded` screens already sketch this. |
| P3 | **Keyboard-first throughput** | Desktop differentiates from mobile parity by speed. Every action reachable from the home row; mouse optional. Today: good seeds (`N`, `/`, `G`, arrows), no palette, no multi-select. |
| P4 | **Trust grammar** | Joining replaces your base; member removal and storage reset are irreversible. These need a distinct visual register — a mode you can feel — not just a red button in an ordinary dialog. |
| P5 | **Tonal depth, two themes** | Keep the no-shadow surface-ladder DNA, but formalize tokens so a true dark theme falls out mechanically. Today: light only, and the Pear window background is hardcoded. |
| P6 | **Motion as protocol feedback** | The system is named *Kinetic* Minimalist and currently has no kinetics. Remote peers change your screen while you look at it; those changes should announce and attribute themselves. Local actions stay instant. |
| P7 | **Contrast & scale floors** | Acid `#C3F400` on white is ~1.4:1 — never text on light. 10px mono labels, fully hidden scrollbars, and solid-black done rows all fail desktop ergonomics. WCAG AA against every surface step. |

## 2. What stays (the DNA)

These are working and are the brand; v2 keeps them verbatim:

- Monochrome + **one** acid signal (`#C3F400`). Solid fills, no gradients, no
  shadows — depth by tonal shift only ("carved, not floating").
- No-line lists: gaps and alignment as structure.
- Geist for content, JetBrains Mono for data/metadata.
- The zero-checkbox rule: state is fill, never a widget.
- Fixed left sidebar, generous section rhythm.
- Grey-fill inputs with the 2px black left-edge focus accent (signature move).
- Keyboard-first ethos; `?` help; i18n through the shared catalogs including
  `en-XA`/`en-XL` stress locales.

## 3. Contradictions v2 resolves

The current guide disagrees with its own example screens and implementation:

1. **Sharp vs rounded.** `DESIGN.md` mandates 0px radius; every `*_rounded`
   example screen and `app.css` ship rounded corners. → **Rounded is
   canonical.** Sharpness lives in type, alignment, and the rectilinear grid;
   a semantic radius scale (§4.5) replaces the prohibition.
2. **"Hierarchy by weight, never size."** The guide caps page titles at 14px;
   the example screens render ~20px titles. → Adopt a small real scale (§4.4):
   one earned size step for orientation, weight/case for everything else.
3. **Done = solid black row.** Striking in a screenshot; in use it makes
   *history* the loudest element on screen, and it cannot invert in dark mode.
   → **Done recedes, selection inks** (§6.3). The iconic black inversion is
   reassigned from a persistent state to a transient, intentional one.
4. **Hidden scrollbars, 10px labels, acid-as-text.** → Floors in §7.

## 4. Design tokens v2

### 4.1 Naming model

Three families, all theme-paired. Rename the M3-transcribed soup
(`surface-container-lowest`…) into roles the code actually uses:

- **Surfaces** — the tonal ladder: `--surface-0` (canvas) → `--surface-3`
  (pressed/selected-mute), plus `--card` (row/card fill) and the inverse pair.
- **Inks** — `--ink`, `--ink-mute`, `--ink-faint` (metadata; AA-large only).
- **Signals** — `--signal`/`--on-signal` (acid), `--danger`/`--on-danger` +
  containers. **No third hue.** Pending/offline states are carried by shape
  (§4.3), not by adding amber.

### 4.2 Palette

| Token | Light | Dark | Role |
|---|---|---|---|
| `--surface-0` | `#FBF9F9` | `#101212` | canvas |
| `--surface-1` | `#F5F3F3` | `#161919` | sidebar, panels |
| `--surface-2` | `#EFEDED` | `#1D2121` | fills, hover, receded rows |
| `--surface-3` | `#E3E2E2` | `#252A2A` | pressed, selected-mute |
| `--card` | `#FFFFFF` | `#181B1B` | item rows, kv rows |
| `--ink` | `#1B1C1C` | `#F1EFEF` | primary text, selection fill |
| `--ink-mute` | `#5D5F5F` | `#B0ABAB` | secondary text |
| `--ink-faint` | `#7E7576` | `#8A8485` | metadata, mono labels (AA-large only) |
| `--line` | `#CFC4C5` | `#34393A` | hairline of last resort (dense tables only) |
| `--signal` | `#C3F400` | `#C3F400` | live/active/success |
| `--on-signal` | `#161E00` | `#161E00` | text on acid |
| `--danger` | `#BA1A1A` | `#FFB4AB` | destructive, attention |
| `--danger-container` | `#FFDAD6` / on `#93000A` | `#93000A` / on `#FFDAD6` | warnings |

Hard rules:

- Acid is **never text on light surfaces**; as a fill it always pairs with
  `--on-signal`; as text only on `--ink-block`.
- **`--ink-block` is theme-constant near-black and does not invert.** The
  first mockup flipped the active-nav block to `--ink` in dark mode, which
  resolves to near-white and put acid text on a light fill (~1.4:1) — exactly
  the failure the previous rule was meant to prevent. Any block that carries
  acid text (active nav, active locale) uses `--ink-block`: `#1B1C1C` light /
  `#000000` dark.
- Acid stays identical across themes — it is the brand constant.
- Adoption PR includes an AA audit table of every ink×surface pair actually
  used; `--ink-faint` is restricted to ≥14px mono or non-text.

Theme switching: `html[data-theme="light" | "dark"]`, default follows
`prefers-color-scheme`; choice persists in preferences next to `isGridView`,
and `backend-boot` applies the persisted theme to the Pear window background
at startup (replacing the hardcoded `#fbf9f9`).

### 4.3 State-is-shape: the sync beacon

One component answers P1 everywhere it appears. Four states, distinguished by
**shape + fill**, so they survive monochrome rendering and color-blindness:

| State | Render | Meaning |
|---|---|---|
| `live` | solid acid dot | peers connected, replicating |
| `local` | hollow dot (2px `--ink-mute` ring) | ready, **this device only** — the honest default |
| `syncing` | half-filled dot, slow rotation | join/replication in progress (reduced-motion: static half) |
| `attention` | `--danger` **square** | join-error, recovery-required, not-writable |

Placements: sidebar status strip (always visible), list pane summary, peers
pane, and per-item provenance in the inspector.

### 4.4 Typography

| Role | Spec | Use |
|---|---|---|
| `display` | Geist 24/32 600 | Overview numerals, empty-state titles |
| `title` | Geist 20/28 600 | pane titles (retires the 14px caps page-title) |
| `headline` | Geist 14/20 600, caps, 0.05em | section anchors (unchanged) |
| `body` | Geist 16/24 400 | items, dialog copy |
| `body-sm` | Geist 14/20 400 | dense rows (compact density) |
| `label` | Mono 12/16 500 | buttons, nav, badges |
| `label-sm` | Mono 11/16 500 | chips, timestamps — **10px retired** |
| `data` | Mono 13/20 400, `tabular-nums` | quantities, keys, fingerprints |

Follow-up: bundle Geist + JetBrains Mono locally (both OFL) so the system-stack
fallback stops drifting per-OS; keeps the no-CDN constraint.

### 4.5 Space, radius, density

- 4px base grid: `--sp-1…--sp-16` (4…64px). `--section-gap` 4rem and
  `--element-gap` 1rem survive as aliases.
- Radius, semantic: `--r-field: 4px` (inputs), `--r-row: 8px` (rows/cards),
  `--r-dialog: 12px`, `--r-pill: 999px`.
- Density: `html[data-density="comfortable" | "compact"]` — row padding
  12/16px → 6/12px, `body` → `body-sm`, element gap 1rem → 0.5rem. Toggle in
  Settings and palette. Replaces the pressure to misuse grid view as a
  density mode.

### 4.6 Motion

| Token | Value | Use |
|---|---|---|
| `--t-instant` | 0 | local mutations (optimistic, no transition) |
| `--t-fast` | 120ms ease-out | hover, fill changes, focus |
| `--t-base` | 200ms cubic-bezier(.2,0,0,1) | pane swaps, dialogs, row arrival |
| `--t-pulse` | 600ms decay | remote-arrival acid pulse |

**Remote-arrival choreography** (the "kinetic" earned): a row created/edited by
a peer slides in over `--t-base` with a 2px acid left edge that decays over
`--t-pulse`, and a batched provenance toast ("3 items · cassandrina-node").
Local actions never animate state — they're already done.
`prefers-reduced-motion`: opacity-only, no rotation, no slide.

## 5. Information architecture v2

```
┌──────────────┬─────────────────────────────────────┬──────────────┐
│ A project    │  list pane                          │  inspector   │
│   switcher   │   title · meta        actions ⌘K    │  (toggle I)  │
│──────────────│   add-bar ───────────────── hint    │  provenance  │
│ B list rail  │   beacon · summary · clear done     │  writer/dev  │
│   Overview*  │   SECTION                           │  timestamps  │
│   Groceries  │     row · row · row                 │  category    │
│   Todo*      │   SECTION                           │              │
│──────────────│     row · row                       │              │
│ C status     │                                     │              │
│   beacon+peers│                                    │              │
│   Peers&Dev  │                                     │              │
│   Activity   │                                     │              │
│   Settings   │                                     │              │
└──────────────┴─────────────────────────────────────┴──────────────┘
* reserved, rendered when multi-list/Overview land
```

**Sidebar = three zones** (today's degenerate render in parentheses):

- **A — Project switcher.** Project name + key-fingerprint chip; menu:
  switch / create / join project. (Today: the "Listam" wordmark + fingerprint;
  join lives here because joining *is* switching bases.)
- **B — List rail.** Typed lists with glyph + remaining-count badge;
  `Overview` pinned on top once cross-list views exist. (Today: one list.)
- **C — System zone.** Replaces the locale button stack: a **status strip**
  (beacon + "N peers" + device name, click → Peers pane), then Peers &
  Devices, Activity, Settings. Locale selection moves into Settings.

**Main canvas:** max-width 64rem → 76rem on a 12-col grid; list rows cap at a
readable measure (~66ch) while sections/boards can use full width.

**Inspector (new, right, 320px, toggle `I`):** provenance (added/edited by
which writer & device, when), replication state beacon, category override,
and future fields (notes, quantity). Desktop finally uses its width; dialogs
stop being the only detail surface.

**Command palette (⌘K):** actions (add, share, join, switch list/project,
toggle view/density/theme, copy invite, clear done) + fuzzy jump-to-item.
Keyboard map grows: `J/K` aliases for arrows, `E` edit, `I` inspector — all
listed in `?`.

**Panes:** Lists · Peers & Devices (trust center: invite lifecycle, members +
roles, owned devices / owner-control) · Activity (the diagnostics pane,
renamed for humans; raw event log remains under a "system log" disclosure) ·
Settings (dialog: locale, theme, density, categories).

**Trust grammar (P4):** the three irreversible surfaces — join-confirm,
member-remove, storage-reset — render as a distinct mode: dialog on
`--inverse-surface` (near-black in light theme), inverse ink, danger accents,
verb-first button labels ("Replace my data", not "OK"). One pattern, three
uses; everyday dialogs stay on canvas.

## 6. Component deltas

| Component | v1 | v2 |
|---|---|---|
| 6.1 Buttons | primary/secondary/critical/danger | + `ghost` (text-only, header actions); acid `critical` reserved for go-live affordances (Share/Invite); `danger` only inside trust surfaces |
| 6.2 Inputs | grey fill, black left edge | unchanged + error state (danger left edge) + inline `kbd` hint chip in add-bar |
| 6.3 Item row | done = solid black | **done recedes**: `--surface-2`, `--ink-faint`, optional strikethrough; completion *moment* gets an acid flash (`--t-pulse`). **Selection inks**: multi-select rows fill `--ink`/inverse text — the brand inversion, now meaning "in your hand", with `Space` toggle, `Esc` clear |
| 6.4 Beacon | one `.dot.live` | the four-state shape grammar (§4.3) |
| 6.5 Toasts | `.notice` bottom-left | bottom-center of content column; success = acid fill; provenance toasts batch per peer; max 3 + overflow counter |
| 6.6 Chips | role-chip | + category chip, fingerprint chip (mono, `data`), state chip |
| 6.7 Scrollbars | hidden globally | 8px overlay thumb (`--surface-3`, hover `--ink-faint`), auto-hide; never `display:none` |
| 6.8 Palette | — | new: ⌘K, listbox semantics, mono labels, acid active row |
| 6.9 Empty states | text block | + the keyboard cheat-row inline (it's the onboarding) |
| 6.10 Hint bar | — | new: fixed tonal strip below the content column with the core key map (`N G Space Del T ?`); hide via its ✕ or `H`, re-show via the sidebar toggle or `H`; preference persisted; slides in/out |

## 7. Accessibility & i18n floors

- AA contrast for every text/surface pair in the audit table; acid-as-text
  only on ink.
- 2px ink focus ring + 2px offset, everywhere (kept), including rows in both
  themes.
- Type floor 11px; hit targets ≥24px on row controls, ≥40px primary actions.
- `en-XL` long-string locale must not break layout: rows wrap, sidebar
  truncates with full text on hover/focus.
- `prefers-reduced-motion` (§4.6) and `forced-colors` (Windows HC) passes —
  state-is-shape makes both nearly free.
- Roles: rows stay `role="button"` + `aria-pressed`; palette is
  `role="listbox"`; beacon carries `aria-label` with the state name.

## 8. CSS architecture & migration

Keep zero-build vanilla CSS; split `app.css` with cascade layers, loaded as
plain files (Pear-friendly, no tooling):

```
styles/
  tokens.css      @layer tokens     — palettes, themes, type, space, motion
  base.css        @layer base       — reset, typography roles, scrollbars
  components.css  @layer components — btn, input, row, beacon, chip, toast…
  panes.css       @layer panes      — shell, sidebar zones, inspector, palette
```

Phased adoption, each shippable alone:

1. **Tokens + themes + floors** — CSS-only: semantic tokens, dark theme,
   contrast/scrollbar/label fixes. No markup changes; biggest visible win.
2. **Components** — beacon, done-recede/selection-ink, toasts, density
   attribute, input states.
3. **IA** — sidebar zones + status strip (locale → Settings), inspector,
   command palette, trust-surface dialogs. `ui.mjs` grows ~300 lines; store
   gains `selection` and `theme/density` preferences.
4. **Design-guide v2** — fold this proposal into
   `kinetic_minimalist/DESIGN.md` (tokens front-matter + prose), regenerate
   example screens, note the retired rules (sharp corners, black done rows,
   hidden scrollbars, 10px labels).

## 9. Open questions

- Grid view: keep (large-target "shopping mode") or retire in favor of
  compact density? Proposal: keep, de-emphasize to palette/Settings.
- Owner-control pairing UI: stays in Peers & Devices or moves to Settings →
  Devices once it grows capabilities?
- Project switcher copy for multi-project: human name vs key fingerprint
  prominence (trust vs friendliness).
- Local font bundling licensing/packaging step (OFL — needs the files vendored
  under `assets/fonts/`).
