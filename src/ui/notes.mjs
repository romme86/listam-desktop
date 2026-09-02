// The notes index projection: how the raw items on a notes list become the
// three groups the index shows, and what a row is allowed to say about a note.
//
// A note is an ordinary list item. Plain, it is exactly what the voice
// notetaker writes — a title and nothing else. Open it and add a block and it
// gains `blocks`, the same ten-block body a board ticket carries; the row then
// earns an excerpt and a block count. `isDone` on a note means ARCHIVED, not
// done: a note is filed, never finished — which is why nothing here strikes a
// note through and why the row has no checkbox.
//
// Pure (no DOM, no client) so the projection unit-tests directly.
import { normalizeBlocks, blockToText } from '@listam/domain/board'

export function isArchivedNote(note) {
    return !!note && !!note.isDone
}

// How many body blocks a note carries. 0 = a plain note: title + timestamp and
// nothing else on the row.
export function noteBlockCount(note) {
    return normalizeBlocks(note?.blocks).length
}

// The one-line preview a document row adds under its title: the first text any
// block carries, flattened onto one line. Structured blocks serialize through
// blockToText, so a note whose whole body is a checklist or a table still
// previews something instead of showing an empty second line.
export function noteExcerpt(note) {
    for (const block of normalizeBlocks(note?.blocks)) {
        const text = blockToText(block).replace(/\s+/g, ' ').trim()
        if (text) return text
    }
    return ''
}

/**
 * Split notes into the index's Pinned / Recent / Archived groups.
 *
 * Archived wins over pinned — a filed note is filed, and a pin that outlived
 * the filing would keep it at the top of the index forever. Each group is
 * newest-first, which is the only order a notes list has.
 *
 * @param {object[]} notes Items already scoped to the active notes surface.
 * @param {object} [options]
 * @param {(note: object) => boolean} [options.isPinned] Pin test; the desktop
 *   passes the day-plan flag, the same star the row's F shortcut toggles.
 * @param {string} [options.query] Index search text — matched against the title
 *   and the excerpt, so a note is findable by its body as well as its name.
 */
export function projectNotes(notes, { isPinned = () => false, query = '' } = {}) {
    const q = String(query ?? '').trim().toLowerCase()
    const matches = (note) => !q
        || String(note.text ?? '').toLowerCase().includes(q)
        || noteExcerpt(note).toLowerCase().includes(q)
    const groups = { pinned: [], recent: [], archived: [] }
    for (const note of Array.isArray(notes) ? notes : []) {
        if (!note || !matches(note)) continue
        if (isArchivedNote(note)) groups.archived.push(note)
        else if (isPinned(note)) groups.pinned.push(note)
        else groups.recent.push(note)
    }
    const newestFirst = (a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
    for (const group of Object.values(groups)) group.sort(newestFirst)
    return groups
}
