// Two spacing rules in the Settings dialog and the Analytics pane that nothing
// else can see fail.
//
// Structural checks over the stylesheet text, in the same spirit as
// responsive.test.mjs and importmap.test.mjs: no CSS parser, and each assertion
// pins a layout failure that produced a real complaint and had no other alarm.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(repoRoot, 'app.css'), 'utf8')

test('a control row that follows body text in Settings gets a gap above it', () => {
    // The dialog's rhythm gives every heading a fixed gap and strips margins off
    // the controls, which works for heading → control. It breaks for
    // heading → prose → control: `.settings .label-md` has no bottom margin and
    // `.settings .choice-row` has no top one, so the button ended up touching the
    // last line of text. "Flatten history" was the visible case (its status line
    // sits directly above the button); the seed export and Diagnostics share the
    // shape. Nothing but a screenshot catches this.
    const rule = css.match(/\.settings\s+\.label-md\s*\+\s*\.choice-row\s*\{([^}]*)\}/)
    assert.ok(rule, 'app.css must space a .choice-row that directly follows .label-md prose in Settings')
    const margin = rule[1].match(/margin-top:\s*([\d.]+)rem/)
    assert.ok(margin, 'the adjacency rule must set a margin-top')
    assert.ok(Number(margin[1]) >= 0.5, `the gap must be visible, got ${margin[1]}rem`)
})

test('the Settings rhythm the adjacency rule depends on is still in place', () => {
    // The rule above is a patch on two specific zero-margin declarations. If
    // either grows a margin of its own the gap doubles instead of appearing.
    assert.match(css, /\.settings\s+\.label-md\s*\{[^}]*margin:\s*0\.5rem\s+0\s+0\s*;/)
    assert.match(css, /\.settings\s+\.choice-row\s*\{[^}]*margin:\s*0\s*;/)
})

test('the Analytics pane carries the same insets as the pane it sits under', () => {
    // Congruency moved out of Settings into its own pane below Peers & Devices.
    // Its cards and legend already carry a 1rem inset; the page title and the
    // subtitle prose are shared with the (former) dialog layout and have none, so
    // without these two rules the pane's text hangs off the pane's left edge.
    assert.match(
        css,
        /\.main\[data-view="analytics"\]\s+\.page-header\s*\{[^}]*padding:\s*0\s+1rem/,
        'the Analytics page title must line up with the pane content',
    )
    assert.match(
        css,
        /\.main\[data-view="analytics"\]\s+\.analytics-note\s*\{[^}]*padding:\s*0\s+1rem/,
        'the Analytics subtitle must line up with the cards below it',
    )
})
