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

Store the "after" run in `localStorage` so it survives the reload, then compare from the "before" run.

```js
(async () => {
  // REQUIRED: mask what moves on its own between two captures — relative-time
  // tokens ("45m", "2d 4h") and short dates. Without this the Peers pane and the
  // Settings dialog report a DIFF for every A/B taken minutes apart.
  const norm = (s) => s
    .replace(/\b\d+[smhd]\b/g, '#T')
    .replace(/\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g, '#D');
  const enc = new TextEncoder();
  const hash = async (s) => { const b = await crypto.subtle.digest('SHA-256', enc.encode(norm(s))); return [...new Uint8Array(b)].slice(0,8).map(x=>x.toString(16).padStart(2,'0')).join(''); };
  const snap = async () => { const h = document.getElementById('app').outerHTML; return { hash: await hash(h), bytes: norm(h).length }; };
  const click = (pred) => { const el = [...document.querySelectorAll('.rail-row .nav-item, .rail-pinned .nav-item, .system-nav .nav-item, .sidebar .nav-item')].find(pred); if (el) { el.click(); return true } return false };
  const out = {};
  out.overview = await snap();
  for (const name of ['Groceries', 'Board', 'Todo', 'Hardware']) {
    out[name.toLowerCase()] = click(e => (e.textContent || '').trim().startsWith(name)) ? await snap() : { hash: 'CLICK-FAILED' };
  }
  out.peers = click(e => /peers/i.test(e.textContent || '')) ? await snap() : { hash: 'CLICK-FAILED' };
  const prev = JSON.parse(localStorage.getItem('__ab') || 'null');
  localStorage.setItem('__ab', JSON.stringify(out));
  if (!prev) return 'stored; make your edit, reload, run again';
  return Object.keys(out).map(k => `${k.padEnd(10)} ${out[k].hash === prev[k]?.hash && out[k].bytes === prev[k]?.bytes ? 'MATCH' : 'DIFF'}`).join('\n');
})()
```

Order matters — each step navigates, so a different order yields different snapshots.

## Caveats, all measured rather than assumed

- **Normalize, or the gate cries wolf.** The Peers pane and Settings dialog render
  `formatAgo`/`formatUptime` output, which changes at MINUTE granularity — not just the Overview's
  daily date. A raw-hash A/B taken ~40 minutes apart reported `peers` and `settings` as DIFF on a
  tree where nothing had changed. The tell was that **byte counts were identical** while hashes
  moved: same-width time strings with different digits. Confirmed by re-capturing on the unmodified
  tree and watching the hash move again on its own.
- `CLICK-FAILED` in the output means a surface was not reached — treat it as a failed run, not a
  pass. Do not use `if (click(...))` and silently omit the key, which hides the problem.
- **Reload with the navigator, not from inside the page.** An in-page `location.reload()` does not
  necessarily complete before the next evaluation runs; a capture then snapshots the PREVIOUS state.
  The tell is several surfaces sharing one hash (it re-snapshotted whatever was on screen, often the
  open Settings dialog).
- **These hashes are never committed goldens.** Always capture your own "before" in the same sitting
  as your "after".
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
