# DOM snapshot A/B — the gate for extracting code out of `src/ui.mjs`

`src/ui.mjs` is ~6.3k lines and **no automated test imports it**. Desktop also has no type
checking (`eslint.config.mjs` enables zero `@typescript-eslint/*` rules — it supplies a parser only —
and there is no jsconfig/tsconfig, so the JSDoc is not a gate). So when code moves out of `ui.mjs`,
almost nothing catches a mistake.

This is the check that does: **the rendered DOM must be byte-identical before and after.** Extraction
with an observable diff is a failed extraction.

This file exists so that two runs are *comparable*. Capture the same way both times, or the
comparison means nothing.

## Procedure

1. Start the mock preview: `.claude/launch.json` → `desktop-mock` (serves the repo on :5051).
2. Open `http://localhost:5051/index.html?mock=1`. The mock backend uses fixtures, so there is no
   P2P and no real user data.
3. Run the snippet below in the page **before** your edit, keep the output, make the edit, reload,
   run it **again**, and diff. Every hash must match.

```js
(async () => {
  const enc = new TextEncoder();
  const hash = async (s) => { const b = await crypto.subtle.digest('SHA-256', enc.encode(s)); return [...new Uint8Array(b)].slice(0,8).map(x=>x.toString(16).padStart(2,'0')).join(''); };
  const snap = async () => { const h = document.getElementById('app').outerHTML; return { hash: await hash(h), bytes: h.length }; };
  const click = (pred) => { const el = [...document.querySelectorAll('.rail-row .nav-item, .rail-pinned .nav-item, .system-nav .nav-item, .sidebar .nav-item')].find(pred); if (el) { el.click(); return true } return false };
  const out = {};
  out.overview = await snap();
  for (const name of ['Groceries', 'Board', 'Todo', 'Hardware']) {
    if (click(e => (e.textContent || '').trim().startsWith(name))) out[name.toLowerCase()] = await snap();
  }
  if (click(e => /peers/i.test(e.textContent || ''))) out.peers = await snap();
  if (click(e => /settings/i.test(e.textContent || ''))) out.settings = await snap();
  return JSON.stringify(out, null, 1);
})()
```

Order matters — each step navigates, so a different order yields different snapshots.

## Reference capture (2026-07-28, desktop `d54d505`)

| surface | hash | bytes |
|---|---|---|
| overview | `ade82653dadf2d11` | 12,658 |
| groceries | `8776518bb6045d80` | 35,958 |
| board | `42f80a007c633fe8` | 33,948 |
| todo | `cddecfea7c24518f` | 20,316 |
| hardware | `c7f229e8bd1a6f2e` | 18,936 |
| peers | `2e4da26fe76602f4` | 13,897 |
| settings | `18524d1a63b6968e` | 22,406 |

## Caveats, all measured rather than assumed

- **These hashes are NOT committed goldens and they rot.** The Overview renders today's date
  (`Today 28 · Tomorrow 29 · Thu 30`), so its hash changes daily and the week strip changes weekly.
  Always re-capture your own "before" in the same sitting as your "after". The table above is a
  reference point, not an expected value.
- Within a sitting the capture **is** deterministic: overview/groceries/board hashed identically
  across full reloads hours apart on the same source.
- A frozen clock is possible if committed goldens are ever wanted: `mountApp` already accepts
  `env.now`, `ui.mjs` contains exactly ONE `Date.now()` (the `env.now` fallback) and zero
  `Math.random`. `src/main.mjs` does not currently pass `env`.
- **The mock cannot reach every surface.** Join overlay, recovery, and live server states need real
  P2P. Do not extract code that only renders in those states behind this gate alone — verify those
  in a real Pear build.
- This gate does not run in CI. It needs a browser; a node DOM shim was considered and declined.
  `npm run ci` still has to pass, and so does the real-app pass (stage to the **beta** channel, seed,
  launch, drive it) — see the decomposition plan.

## Also required for any new module

`test/importmap.test.mjs` gates both halves of "the renderer has no resolver": a bare specifier needs
an importmap entry in `index.html`, and a relative import must exist on disk. A new `src/` module
reached by a relative import needs no importmap entry, but a typo'd path kills boot — that is what
the second check is for.
