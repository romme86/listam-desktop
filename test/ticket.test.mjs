import test from 'node:test'
import assert from 'node:assert/strict'
import {
    selectBoardConfig,
    groupByStatus,
    ticketBadges,
    selectWriterStats,
    validateRigorDraft,
    buildStatusChange,
    formatDuration,
    deltaPercent,
    BLOCK_TYPES,
    createBlock,
    blockToText,
    blockFromText,
    normalizeBlocks,
    renderInlineMarkdown,
    escapeHtml,
} from '../src/ticket.mjs'
import { createDesktopStore } from '../src/store.mjs'
import { DEFAULT_BOARD_CONFIG, TIMELINESS } from '@listam/domain/board'

const HOUR = 3600000

function ticket (id, overrides = {}) {
    return {
        id,
        text: overrides.text ?? id,
        isDone: overrides.isDone ?? false,
        timeOfCompletion: 0,
        updatedAt: 1,
        listId: 'default',
        listType: 'kanban',
        status: 'todo',
        ...overrides,
    }
}

test('groupByStatus places tickets into config columns and drops non-tickets', () => {
    const items = [
        ticket('a', { status: 'todo' }),
        ticket('b', { status: 'done', isDone: true }),
        ticket('c', { status: 'nonsense' }), // unknown -> first column
        { id: 'g', text: 'Milk', isDone: false, timeOfCompletion: 0, listType: 'shopping' },
    ]
    const cols = groupByStatus(items, DEFAULT_BOARD_CONFIG)
    const todo = cols.find((c) => c.state.id === 'todo')
    const done = cols.find((c) => c.state.id === 'done')
    assert.deepEqual(todo.tickets.map((t) => t.id).sort(), ['a', 'c'])
    assert.deepEqual(done.tickets.map((t) => t.id), ['b'])
    // grocery item never appears on the board
    assert.equal(cols.some((c) => c.tickets.some((t) => t.id === 'g')), false)
})

test('ticketBadges extends a live in-progress timer to now', () => {
    const running = ticket('a', { status: 'in_progress', inProgressMs: 1 * HOUR, inProgressSince: 1000 })
    const badges = ticketBadges(running, 1000 + 2 * HOUR)
    assert.equal(badges.inProgressMs, 3 * HOUR) // 1h closed + 2h open
    assert.equal(badges.running, true)

    const idle = ticket('b', { status: 'todo', inProgressMs: 90 * 60000 })
    assert.equal(ticketBadges(idle, 0).inProgressMs, 90 * 60000)
})

test('ticketBadges surfaces checklist progress and frozen timeliness', () => {
    const done = ticket('a', {
        status: 'done', isDone: true, timeliness: TIMELINESS.OVERTIME, estimatedHours: 6,
        checklist: [{ id: '1', done: true }, { id: '2', done: false }],
    })
    const b = ticketBadges(done, 0)
    assert.equal(b.checklistDone, 1)
    assert.equal(b.checklistTotal, 2)
    assert.equal(b.timeliness, TIMELINESS.OVERTIME)
})

test('validateRigorDraft gates on rigor mode', () => {
    const on = { ...DEFAULT_BOARD_CONFIG, rigorOn: true }
    const off = { ...DEFAULT_BOARD_CONFIG, rigorOn: false }
    assert.equal(validateRigorDraft({}, off).ok, true)
    assert.deepEqual(validateRigorDraft({}, on).missing, ['description', 'checklist', 'hours', 'complexity'])
})

test('buildStatusChange returns a bumped payload or null for a no-op', () => {
    const t = ticket('a', { status: 'todo', updatedAt: 1 })
    const moved = buildStatusChange(t, 'in_progress', 9999)
    assert.equal(moved.status, 'in_progress')
    assert.equal(moved.updatedAt, 9999)
    assert.equal(buildStatusChange(t, 'todo', 9999), null)
})

test('selectWriterStats derives congruency from completed tickets', () => {
    const items = [
        ticket('a', { completedBy: 'u', estimatedComplexity: 50, timeliness: TIMELINESS.ON_TIME }),
        ticket('b', { completedBy: 'u', estimatedComplexity: 50, timeliness: TIMELINESS.OVERTIME }),
        ticket('c', { status: 'todo' }), // not completed -> excluded
    ]
    const stats = selectWriterStats(items)
    assert.equal(stats.length, 1)
    assert.equal(stats[0].user, 'u')
    assert.equal(stats[0].count, 2)
})

test('formatDuration and deltaPercent format for display', () => {
    assert.equal(formatDuration(0), '0m')
    assert.equal(formatDuration(90 * 60000), '1h 30m')
    assert.equal(deltaPercent(8, 6), 33)
    assert.equal(deltaPercent(3, 6), -50)
    assert.equal(deltaPercent(5, 0), null)
})

test('selectBoardConfig falls back to defaults and reads store board-config', () => {
    assert.equal(selectBoardConfig(undefined).rigorOn, true)
    const store = createDesktopStore()
    store.applyClientEvent({ type: 'message', payload: { type: 'board-config', config: { ...DEFAULT_BOARD_CONFIG, rigorOn: false }, canAdminister: true } })
    const cfg = selectBoardConfig(store.getState())
    assert.equal(cfg.rigorOn, false)
    assert.equal(store.getState().boardConfigCanAdminister, true)
})

// --- block-based body ------------------------------------------------------

test('BLOCK_TYPES covers the eight mockup block types', () => {
    assert.deepEqual(
        BLOCK_TYPES.map((b) => b.type),
        ['markdown', 'checklist', 'numberedList', 'links', 'image', 'table', 'callout', 'code'],
    )
})

test('createBlock makes a well-shaped empty block per type', () => {
    assert.deepEqual(createBlock('markdown', 'a'), { id: 'a', type: 'markdown', text: '' })
    assert.deepEqual(createBlock('checklist', 'b').items, [{ text: '', done: false }])
    assert.deepEqual(createBlock('table', 'c').rows, [['', ''], ['', '']])
    // unknown type falls back to markdown
    assert.equal(createBlock('nonsense', 'd').type, 'markdown')
})

test('normalizeBlocks drops malformed entries', () => {
    const blocks = normalizeBlocks([
        { id: 'a', type: 'markdown', text: 'ok' },
        { id: 'b', type: 'nope' }, // unknown type
        { type: 'code', text: 'x' }, // missing id
        null,
        { id: 'c', type: 'code', text: 'y' },
    ])
    assert.deepEqual(blocks.map((b) => b.id), ['a', 'c'])
})

test('block text round-trips through blockToText/blockFromText', () => {
    const checklist = { id: '1', type: 'checklist', items: [{ text: 'done one', done: true }, { text: 'todo two', done: false }] }
    assert.equal(blockToText(checklist), '[x] done one\n[ ] todo two')
    assert.deepEqual(blockFromText('checklist', blockToText(checklist)).items, checklist.items)

    const numbered = { id: '2', type: 'numberedList', items: [{ text: 'first' }, { text: 'second' }] }
    assert.equal(blockToText(numbered), 'first\nsecond')
    assert.deepEqual(blockFromText('numberedList', '1. first\n2. second').items, numbered.items)

    const links = { id: '3', type: 'links', links: [{ label: 'Site', url: 'https://a.test' }] }
    assert.equal(blockToText(links), 'Site | https://a.test')
    assert.deepEqual(blockFromText('links', 'Site | https://a.test').links, links.links)

    const table = { id: '4', type: 'table', rows: [['A', 'B'], ['1', '2']] }
    assert.equal(blockToText(table), 'A, B\n1, 2')
    assert.deepEqual(blockFromText('table', blockToText(table)).rows, table.rows)

    const image = { id: '5', type: 'image', url: 'https://i.test/x.png', alt: 'pic' }
    assert.deepEqual(blockFromText('image', blockToText(image)), { url: 'https://i.test/x.png', alt: 'pic' })

    assert.deepEqual(blockFromText('markdown', 'plain **text**'), { text: 'plain **text**' })
})

test('renderInlineMarkdown renders the whitelisted subset and is XSS-safe', () => {
    assert.equal(renderInlineMarkdown('**bold**'), '<strong>bold</strong>')
    assert.equal(renderInlineMarkdown('a *b* c'), 'a <em>b</em> c')
    assert.equal(renderInlineMarkdown('use `code`'), 'use <code>code</code>')
    assert.equal(
        renderInlineMarkdown('[site](https://a.test)'),
        '<a href="https://a.test" target="_blank" rel="noopener noreferrer">site</a>',
    )
    assert.equal(renderInlineMarkdown('line1\nline2'), 'line1<br>line2')
    // raw HTML is escaped, never injected
    assert.equal(renderInlineMarkdown('<img src=x onerror=alert(1)>').includes('<img'), false)
    assert.match(renderInlineMarkdown('<script>'), /&lt;script&gt;/)
    // javascript: links are not turned into anchors
    assert.equal(renderInlineMarkdown('[x](javascript:alert(1))').includes('<a'), false)
})

test('escapeHtml escapes the dangerous characters', () => {
    assert.equal(escapeHtml('<a href="b">&\'</a>'), '&lt;a href=&quot;b&quot;&gt;&amp;&#39;&lt;/a&gt;')
})

// Block-level markdown -> HTML is now markdownToHtml in @listam/domain/markdown,
// covered by that package's markdown.test.mjs (incl. headings + round trip).
