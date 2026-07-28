// The renderer is a plain DOM context: it has NO node_modules resolver, so every
// bare specifier it reaches must be redirected by the hand-maintained importmap
// in index.html. A missing entry is not a soft failure — the browser refuses the
// whole module graph, `#app` stays empty, and the app does not boot at all.
//
// That is not hypothetical. Release 1a.6 (desktop 6629625) added
// `@listam/domain/authoritative-base` to src/store/lists-slice.mjs without the
// matching importmap entry, and desktop main did not boot from that commit until
// this test was written. Nothing caught it: the 80 unit tests import through
// node, which resolves node_modules fine, so the renderer-only breakage was
// invisible to every gate.
//
// This walks the real graph rather than a hand-listed file set, so a new
// renderer module is covered the moment something imports it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const indexHtml = readFileSync(join(repoRoot, 'index.html'), 'utf8')

// Modules the renderer loads dynamically and is written to survive WITHOUT.
// Their bare specifiers are deliberately unmapped, so exempt them — but only
// these, and only while that stays true.
//
// src/owner-control.mjs pulls hyperdht + bare-fs (the bare module graph), which
// cannot load in a DOM context at all; main.mjs imports it under a `.catch(() =>
// null)` and the Servers pane renders an unavailable note. VERIFIED 2026-07-28
// against the live Pear app, not just the browser preview: the pane shows the
// `!ownerControl` branch, i.e. the import really does fail in production.
// Release 5 moves this client into a worker; DELETE this exemption then.
const OPTIONAL_MODULES = new Set(['src/owner-control.mjs'])

function parseImportMap() {
    const match = indexHtml.match(/<script type="importmap">\s*(\{[\s\S]*?\})\s*<\/script>/)
    assert.ok(match, 'index.html must contain an importmap')
    const parsed = JSON.parse(match[1])
    assert.ok(parsed.imports, 'importmap must have an "imports" object')
    return parsed.imports
}

function parseEntryScript() {
    const match = indexHtml.match(/<script type="module" src="([^"]+)"/)
    assert.ok(match, 'index.html must load a module entry script')
    return match[1]
}

// Deliberately regex-based, not a real parser: the renderer sources are plain
// ESM with no build step, and a parser dependency would be a heavier promise
// than this check needs.
//
// The patterns are tight on purpose. An earlier draft used `\s*` between the
// keyword and the quote, which spans newlines — it matched a `from` in one
// statement against a string literal several lines below and reported six
// phantom specifiers. Match only what real import syntax looks like:
const SPECIFIER_PATTERNS = [
    // `import x from '…'` / `export { x } from '…'`. The lookbehind keeps
    // `b4a.from(…)` and `Array.from(…)` out.
    /(?<![.\w])from[ \t]+['"]([^'"\n]+)['"]/g,
    // `import('…')` — the dynamic form main.mjs uses for optional modules.
    /(?<![.\w])import[ \t]*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    // `import '…'` for side effects only.
    /^[ \t]*import[ \t]+['"]([^'"\n]+)['"]/gm,
]

function specifiersIn(filePath) {
    // src/ui.mjs contains bytes BSD tooling reads as binary; decode explicitly.
    const source = readFileSync(filePath).toString('utf8')
    const found = new Set()
    for (const pattern of SPECIFIER_PATTERNS) {
        for (const match of source.matchAll(pattern)) found.add(match[1])
    }
    return found
}

const isBare = (spec) => !spec.startsWith('.') && !spec.startsWith('/')

// Walk every module the renderer can reach, following relative imports on disk
// and bare imports through the importmap. Returns the bare specifiers that the
// importmap does not cover, each with the file that asked for it.
function walkRendererGraph(imports) {
    const unmapped = new Map()
    const visited = new Set()
    const queue = [resolve(repoRoot, parseEntryScript())]

    while (queue.length > 0) {
        const filePath = queue.pop()
        if (visited.has(filePath) || !existsSync(filePath)) continue
        visited.add(filePath)

        const relPath = relative(repoRoot, filePath)
        if (OPTIONAL_MODULES.has(relPath)) continue

        for (const spec of specifiersIn(filePath)) {
            if (!isBare(spec)) {
                queue.push(resolve(dirname(filePath), spec))
                continue
            }
            const mapped = imports[spec]
            if (!mapped) {
                if (!unmapped.has(spec)) unmapped.set(spec, [])
                unmapped.get(spec).push(relPath)
                continue
            }
            // A mapped module is renderer code too — its own bare imports need
            // entries just as much (this is why redux/immer/reselect are in the
            // map: @reduxjs/toolkit's browser build imports them).
            queue.push(resolve(repoRoot, mapped))
        }
    }
    return { unmapped, visited }
}

test('every bare specifier the renderer can reach has an importmap entry', () => {
    const imports = parseImportMap()
    const { unmapped, visited } = walkRendererGraph(imports)

    assert.ok(visited.size > 20, `the walk must actually traverse the app, saw ${visited.size} modules`)

    const report = [...unmapped.entries()]
        .map(([spec, importers]) => `  ${spec}  <- ${importers.join(', ')}`)
        .join('\n')
    assert.equal(
        unmapped.size,
        0,
        `these bare specifiers would fail to resolve in the renderer; add them to the importmap in index.html:\n${report}`,
    )
})

test('every importmap entry points at a file that exists', () => {
    const imports = parseImportMap()
    const missing = []
    for (const [spec, target] of Object.entries(imports)) {
        if (!existsSync(resolve(repoRoot, target))) missing.push(`  ${spec} -> ${target}`)
    }
    assert.equal(missing.length, 0, `importmap entries point at files that do not exist:\n${missing.join('\n')}`)
})

test('the entry script and the authoritative-base guard are actually in the walked graph', () => {
    // Guards the guard: if the walk stops finding real modules (a rename, a
    // regex that stops matching), the test above would pass vacuously with an
    // empty graph. Pin the specific module whose missing entry broke boot.
    const imports = parseImportMap()
    const { visited } = walkRendererGraph(imports)
    const walked = new Set([...visited].map((f) => relative(repoRoot, f)))

    assert.ok(walked.has('src/main.mjs'), 'the renderer entry must be walked')
    assert.ok(walked.has('src/store/lists-slice.mjs'), 'the store slices must be walked')
    assert.ok(
        walked.has(relative(repoRoot, resolve(repoRoot, imports['@listam/domain/authoritative-base'] ?? 'missing'))),
        '@listam/domain/authoritative-base must resolve through the importmap into the graph',
    )
})
