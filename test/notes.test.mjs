// The notes index projection: which group a note lands in, and what its row is
// allowed to say about it.
//
// Archive semantics live here too. `isDone` on a note means FILED, not
// finished — a note is never completed — so the last two checks read the
// stylesheet the way responsive.test.mjs does: an archived note must recede
// without a strikethrough, and the active row must be marked by the inset acid
// edge rather than a border. Neither has any other alarm, and both are one
// careless copy of `.item-row.done` away from being wrong.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NOTES_LIST_TYPE } from '@listam/domain/identity'
import { isArchivedNote, noteBlockCount, noteExcerpt, projectNotes } from '../src/ui/notes.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(repoRoot, 'app.css'), 'utf8')

// A note as the voice notetaker writes it: an ordinary list item, nothing else.
function note(id, overrides = {}) {
    return {
        id,
        listId: 'fieldnotes',
        listType: NOTES_LIST_TYPE,
        text: id,
        isDone: false,
        timeOfCompletion: 0,
        updatedAt: 1,
        ...overrides,
    }
}

test('a plain note has no blocks and no excerpt; a document note has both', () => {
    const plain = note('Ask about the boiler')
    assert.equal(noteBlockCount(plain), 0)
    assert.equal(noteExcerpt(plain), '', 'a plain row is title + timestamp, nothing more')

    const doc = note('Cabin weekend', {
        blocks: [
            { id: 'b1', type: 'markdown', text: 'Leave Friday\nafter lunch.' },
            { id: 'b2', type: 'checklist', items: [{ text: 'Firewood', done: true }] },
        ],
    })
    assert.equal(noteBlockCount(doc), 2)
    assert.equal(noteExcerpt(doc), 'Leave Friday after lunch.', 'the excerpt is ONE line')
})

test('the excerpt reaches past empty and structured blocks', () => {
    // A note whose body is only a checklist or a table still previews something
    // — blockToText serializes those — and a leading empty block never wins.
    const afterEmpty = note('n', { blocks: [{ id: 'b1', type: 'markdown', text: '   ' }, { id: 'b2', type: 'markdown', text: 'Real text' }] })
    assert.equal(noteExcerpt(afterEmpty), 'Real text')

    const checklistOnly = note('n', { blocks: [{ id: 'b1', type: 'checklist', items: [{ text: 'Snow chains', done: false }] }] })
    assert.equal(noteExcerpt(checklistOnly), '[ ] Snow chains')

    // Unknown block types (a newer peer's) are not counted and not previewed —
    // normalizeBlocks drops them rather than guessing at their shape.
    const future = note('n', { blocks: [{ id: 'b1', type: 'sparkline', text: 'x' }] })
    assert.equal(noteBlockCount(future), 0)
    assert.equal(noteExcerpt(future), '')
})

test('archived is isDone, and it beats a pin — a filed note is filed', () => {
    const open = note('open')
    const filed = note('filed', { isDone: true })
    assert.equal(isArchivedNote(open), false)
    assert.equal(isArchivedNote(filed), true)

    const groups = projectNotes([open, filed], { isPinned: () => true })
    assert.deepEqual(groups.pinned.map((n) => n.id), ['open'])
    assert.deepEqual(groups.recent, [])
    assert.deepEqual(groups.archived.map((n) => n.id), ['filed'], 'a pin does not keep an archived note at the top forever')

    // Unarchiving is the same flag going the other way: the note walks back out
    // of Archived into whichever group it belonged to.
    const reopened = projectNotes([{ ...filed, isDone: false }], { isPinned: () => false })
    assert.deepEqual(reopened.archived, [])
    assert.deepEqual(reopened.recent.map((n) => n.id), ['filed'])
})

test('each group is newest-first, which is the only order a notes list has', () => {
    const notes = [
        note('old', { updatedAt: 10 }),
        note('newest', { updatedAt: 30 }),
        note('mid', { updatedAt: 20 }),
        note('filed-old', { isDone: true, updatedAt: 5 }),
        note('filed-new', { isDone: true, updatedAt: 25 }),
    ]
    const groups = projectNotes(notes)
    assert.deepEqual(groups.recent.map((n) => n.id), ['newest', 'mid', 'old'])
    assert.deepEqual(groups.archived.map((n) => n.id), ['filed-new', 'filed-old'])
    assert.deepEqual(groups.pinned, [])
})

test('the index search matches the title AND the body', () => {
    const notes = [
        note('Espresso grind settings', { blocks: [{ id: 'b1', type: 'markdown', text: '18g in, 36g out.' }] }),
        note('Cabin weekend', { blocks: [{ id: 'b2', type: 'markdown', text: 'Snow chains in the boot.' }] }),
    ]
    assert.deepEqual(projectNotes(notes, { query: 'espresso' }).recent.map((n) => n.id), ['Espresso grind settings'])
    assert.deepEqual(projectNotes(notes, { query: 'snow' }).recent.map((n) => n.id), ['Cabin weekend'], 'findable by its body')
    assert.deepEqual(projectNotes(notes, { query: '  ' }).recent.length, 2, 'a blank query filters nothing')
    assert.deepEqual(projectNotes(notes, { query: 'ristretto' }).recent, [])
})

test('the projection survives the junk a live mesh can hand it', () => {
    assert.deepEqual(projectNotes(null), { pinned: [], recent: [], archived: [] })
    assert.deepEqual(projectNotes([null, undefined]).recent, [])
    assert.equal(noteBlockCount(undefined), 0)
    assert.equal(noteExcerpt(null), '')
    assert.equal(isArchivedNote(null), false)
    // A note whose text a peer wrote as absent must still be searchable, not throw.
    assert.equal(projectNotes([note('n', { text: undefined })], { query: 'x' }).recent.length, 0)
})

test('an archived note recedes but is never struck through', () => {
    const rule = css.match(/\n\.note-row\.archived\s*\{([^}]*)\}/)
    assert.ok(rule, 'app.css must give an archived note row its own receding treatment')
    assert.match(rule[1], /background:\s*var\(--surface-2\)/, 'archived recedes onto surface-2')
    assert.match(rule[1], /color:\s*var\(--ink-faint\)/, 'archived recedes to ink-faint')
    for (const match of css.matchAll(/\.note-row[^{]*\{([^}]*)\}/g)) {
        assert.doesNotMatch(
            match[1],
            /line-through/,
            'a note is filed, never finished — the done-row strikethrough must not follow it here',
        )
    }
})

test('the open note is marked by the inset acid edge, not a border', () => {
    const rule = css.match(/\n\.note-row\.active\s*\{([^}]*)\}/)
    assert.ok(rule, 'app.css must mark the active note row')
    assert.match(rule[1], /background:\s*var\(--surface-2\)/)
    assert.match(rule[1], /box-shadow:\s*inset 2px 0 0 var\(--signal\)/)
    assert.doesNotMatch(rule[1], /border:/, 'depth here is a tonal shift, not a rule line')
})
