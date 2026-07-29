// The window-size ladder in app.css is order-dependent and token-driven, and
// neither property is visible to any other gate — the 116 unit tests never load
// a stylesheet, and a broken breakpoint only shows up when someone drags the
// Pear window.
//
// That is not hypothetical. Before this file existed, `@media (max-width: 900px)`
// set `.sidebar { position: static; width: 100%; flex-direction: row }`, which
// reflowed the fixed rail into a full-width horizontal strip and pushed the
// content column off the bottom of the window. Every pane below 900px was
// unusable and nothing failed.
//
// These are structural checks over the stylesheet text, in the same spirit as
// importmap.test.mjs: cheap, no CSS parser dependency, and each one pins a
// failure mode that has no other alarm.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(repoRoot, 'app.css'), 'utf8')

// Media blocks are written per component rather than as one contiguous ladder,
// so global breakpoint order says nothing. Collect them and compare only within
// a selector — the scope where the cascade actually decides a winner.
function mediaBlocks() {
    const blocks = []
    const header = /@media\s*\(\s*(max|min)-width:\s*([\d.]+)(px|rem)\s*\)\s*\{/g
    for (const match of css.matchAll(header)) {
        // Walk braces from the block's opening `{` to find its real end; the
        // body contains nested rules, so a non-greedy regex mis-terminates.
        let depth = 1
        let i = match.index + match[0].length
        for (; i < css.length && depth > 0; i++) {
            if (css[i] === '{') depth++
            else if (css[i] === '}') depth--
        }
        blocks.push({
            kind: match[1],
            px: Number(match[2]) * (match[3] === 'rem' ? 16 : 1),
            body: css.slice(match.index + match[0].length, i - 1),
            index: match.index,
        })
    }
    return blocks
}

// Selectors declared directly inside a media block, normalised for comparison.
function selectorsIn(body) {
    return [...body.matchAll(/(^|\})\s*([^{}@]+?)\s*\{/g)]
        .map((m) => m[2].replace(/\s+/g, ' ').trim())
        .filter((s) => s.length > 0 && !s.startsWith('/*'))
}

function orderViolations(kind, isInverted) {
    const seen = new Map()
    const violations = []
    for (const block of mediaBlocks().filter((b) => b.kind === kind)) {
        for (const selector of selectorsIn(block.body)) {
            const previous = seen.get(selector)
            if (previous !== undefined && isInverted(previous, block.px)) {
                violations.push(`${selector}: ${kind}-width ${previous}px declared before ${block.px}px`)
            }
            seen.set(selector, block.px)
        }
    }
    return violations
}

test('a selector tightened at several max-widths is declared widest-first', () => {
    // Same-specificity rules: the LAST matching block wins. A `.main` capped at
    // 900px that sits before a `.main` capped at 1180px is silently overridden
    // at 900px, so the tighter tier stops applying exactly where it is needed.
    const blocks = mediaBlocks().filter((b) => b.kind === 'max')
    assert.ok(blocks.length >= 4, `expected a real max-width ladder, saw ${blocks.length} blocks`)

    const violations = orderViolations('max', (previous, current) => current > previous)
    assert.deepEqual(
        violations,
        [],
        `max-width blocks must be widest-first per selector; these invert and cancel the narrower tier:\n  ${violations.join('\n  ')}`,
    )
})

test('a selector widened at several min-widths is declared narrowest-first', () => {
    const blocks = mediaBlocks().filter((b) => b.kind === 'min')
    assert.ok(blocks.length >= 2, `expected a min-width ladder, saw ${blocks.length} blocks`)

    const violations = orderViolations('min', (previous, current) => current < previous)
    assert.deepEqual(violations, [], `min-width blocks must be narrowest-first per selector:\n  ${violations.join('\n  ')}`)
})

test('the token ladder scales --sidebar-width monotonically', () => {
    // The rail only ever gets narrower as the window does. A tier that widens it
    // would push the content column further right on a window that has less room,
    // which is the opposite of the ladder's whole purpose.
    const widths = mediaBlocks()
        .filter((b) => b.kind === 'max' && /--sidebar-width:/.test(b.body))
        .map((b) => ({ at: b.px, rail: Number(/--sidebar-width:\s*(\d+)px/.exec(b.body)[1]) }))
    assert.ok(widths.length >= 2, `expected the rail to be scaled by the ladder, saw ${widths.length} tiers`)

    const wrong = widths
        .map((w, i) => (i > 0 && w.rail >= widths[i - 1].rail ? `${w.at}px tier sets ${w.rail}px, not narrower than ${widths[i - 1].rail}px` : null))
        .filter(Boolean)
    assert.deepEqual(wrong, [], `the rail must narrow as the window does:\n  ${wrong.join('\n  ')}`)
})

test('the shell keeps one structure at every width', () => {
    // The rail is position:fixed and .main offsets itself by --sidebar-width.
    // Re-positioning the sidebar in a media query breaks that contract without
    // touching .main, which is exactly how the sub-900px layout collapsed.
    for (const block of mediaBlocks()) {
        for (const rule of block.body.matchAll(/\.sidebar\s*\{([^}]*)\}/g)) {
            assert.doesNotMatch(
                rule[1],
                /position\s*:\s*(static|relative)/,
                `the ${block.px}px block re-positions .sidebar out of the fixed rail; .main offsets itself by --sidebar-width and would be pushed off-screen`,
            )
            assert.doesNotMatch(
                rule[1],
                /flex-direction\s*:\s*row/,
                `the ${block.px}px block turns the sidebar into a horizontal strip; scale --sidebar-width instead`,
            )
        }
    }
})

test('.main can shrink below its content width', () => {
    // A flex item defaults to min-width:auto, which refuses to shrink past the
    // intrinsic width of its contents — the reason narrow windows overflowed
    // horizontally instead of reflowing. Cheap to lose in a refactor, and the
    // symptom (a page-level horizontal scrollbar) reads as a content bug.
    const rule = css.match(/\n\.main\s*\{([^}]*)\}/)
    assert.ok(rule, 'app.css must declare a .main rule')
    assert.match(rule[1], /min-width:\s*0/, '.main must set min-width: 0 so the content column can reflow')
    assert.match(rule[1], /margin-left:\s*var\(--sidebar-width\)/, '.main must clear the fixed rail')
})

test('the layout tokens the ladder scales are declared on :root', () => {
    // The ladder only re-declares tokens; if one is never defined at :root the
    // overrides land on nothing and the default tier silently has no styling.
    const root = css.match(/:root\s*\{([\s\S]*?)\n\}/)
    assert.ok(root, 'app.css must declare a :root token block')
    for (const token of ['--sidebar-width', '--gutter-base', '--section-gap', '--element-gap', '--content-max', '--titlebar-h']) {
        assert.match(root[1], new RegExp(`${token}:`), `${token} must be declared on :root`)
    }
})
