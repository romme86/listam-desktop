// What a dismissal of the ticket create panel MEANS.
//
// Worth testing rather than eyeballing, because one of the three outcomes
// deletes a row: get "untouched" wrong and pressing + and changing your mind
// either litters the board with blank cards or throws away real work. The rest
// of the panel is markup and RPC wiring (ui.mjs, no DOM in node); this module is
// the decision, so it is the part a test can reach.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
    TICKET_DRAFT_COMPLEXITY,
    emptyTicketDraft,
    ticketDraftFromItem,
    ticketDraftChecklist,
    ticketDraftFields,
    ticketDraftMissing,
    isUntouchedTicketDraft,
    planTicketDraftSettlement,
} from '../src/ui/ticket-draft.mjs'
import { DEFAULT_BOARD_CONFIG } from '@listam/domain/board'

const RIGOR_OFF = { ...DEFAULT_BOARD_CONFIG, rigorOn: false }
const ROW = { id: 'ticket-1' }

function filled (overrides = {}) {
    return {
        ...emptyTicketDraft(),
        description: 'Renew the passport',
        tasks: ['Book the appointment'],
        hours: '3',
        valueRate: 8,
        delayRate: 6,
        ...overrides,
    }
}

test('an empty panel starts on the one non-blank default', () => {
    const draft = emptyTicketDraft()
    assert.equal(draft.description, '')
    assert.deepEqual(draft.tasks, [''])
    assert.equal(draft.hours, '')
    assert.equal(draft.complexity, TICKET_DRAFT_COMPLEXITY)
    assert.equal(draft.valueRate, null)
    assert.equal(draft.delayRate, null)
})

test('a panel resumed from a live row is seeded with what the row already holds', () => {
    const draft = ticketDraftFromItem({
        description: 'Renew the passport',
        text: 'Renew the passport',
        checklist: [{ id: 'task-0', text: 'Book it', done: false }, { id: 'task-1', text: 'Pay', done: true }],
        estimatedHours: 3,
        estimatedComplexity: 70,
        valueRate: 8,
        delayRate: 6,
    })
    assert.equal(draft.description, 'Renew the passport')
    assert.deepEqual(draft.tasks, ['Book it', 'Pay'])
    assert.equal(draft.hours, '3')
    assert.equal(draft.complexity, 70)
    assert.equal(draft.valueRate, 8)
    assert.equal(draft.delayRate, 6)
})

test('a resumed panel falls back to the description-less title and one blank task row', () => {
    // A ticket whose description was folded into the block body still shows a
    // title; the panel must not open blank on top of it.
    const draft = ticketDraftFromItem({ text: 'Folded title', checklist: [] })
    assert.equal(draft.description, 'Folded title')
    assert.deepEqual(draft.tasks, [''])
    assert.equal(draft.complexity, TICKET_DRAFT_COMPLEXITY)
    assert.deepEqual(ticketDraftFromItem(null).tasks, [''])
})

test('task ids are positional, so they do not churn while the text is being typed', () => {
    // The old one-shot submit derived the id from the text LENGTH. Autosaving on
    // every keystroke with that scheme would give each character its own id.
    const half = ticketDraftChecklist({ tasks: ['Boo'] })
    const whole = ticketDraftChecklist({ tasks: ['Book the appointment'] })
    assert.deepEqual(half.map((t) => t.id), whole.map((t) => t.id))
    assert.deepEqual(whole, [{ id: 'task-0', text: 'Book the appointment', done: false }])
})

test('blank task rows never reach the ticket', () => {
    assert.deepEqual(ticketDraftChecklist({ tasks: ['', '  ', 'Real'] }), [
        { id: 'task-2', text: 'Real', done: false },
    ])
    assert.deepEqual(ticketDraftChecklist({ tasks: [] }), [])
    assert.deepEqual(ticketDraftChecklist(null), [])
})

test('the ticket title tracks the description, and a blank estimate is 0 rather than NaN', () => {
    const fields = ticketDraftFields(filled({ hours: '' }), false)
    assert.equal(fields.text, 'Renew the passport')
    assert.equal(fields.description, 'Renew the passport')
    assert.equal(fields.estimatedHours, 0)
    assert.equal(fields.estimatedComplexity, TICKET_DRAFT_COMPLEXITY)
    assert.equal(ticketDraftFields(filled({ hours: 'abc' }), false).estimatedHours, 0)
    assert.equal(ticketDraftFields(filled({ hours: '2.5' }), false).estimatedHours, 2.5)
})

test('the value rates are written only where the surface rates its items', () => {
    const off = ticketDraftFields(filled(), false)
    assert.equal('valueRate' in off, false, 'a rate written on a non-rating surface is a phantom badge')
    const on = ticketDraftFields(filled(), true)
    assert.equal(on.valueRate, 8)
    assert.equal(on.delayRate, 6)
})

test('a description alone is required even with rigor off', () => {
    assert.deepEqual(ticketDraftMissing(emptyTicketDraft(), RIGOR_OFF, false), ['description'])
    assert.deepEqual(ticketDraftMissing(filled(), RIGOR_OFF, false), [])
})

test('rigor adds the planning set; the value surface adds the rates', () => {
    assert.deepEqual(
        ticketDraftMissing(emptyTicketDraft(), DEFAULT_BOARD_CONFIG, false).sort(),
        ['checklist', 'description', 'hours'],
        'complexity has a default, so it is never missing',
    )
    assert.deepEqual(ticketDraftMissing(filled(), DEFAULT_BOARD_CONFIG, true), [])
    assert.deepEqual(
        ticketDraftMissing(filled({ valueRate: null }), DEFAULT_BOARD_CONFIG, true),
        ['value'],
    )
    // No config at all must fall back to the rigor-ON default, never to "no gate".
    assert.equal(ticketDraftMissing(emptyTicketDraft(), null, false).length > 1, true)
})

test('untouched means every field blank AND the one slider still on its default', () => {
    assert.equal(isUntouchedTicketDraft(emptyTicketDraft()), true)
    assert.equal(isUntouchedTicketDraft(filled()), false)
    for (const [label, patch] of [
        ['a typed description', { description: 'x' }],
        ['a typed task', { tasks: ['x'] }],
        ['an estimate', { hours: '2' }],
        ['a moved value slider', { valueRate: 1 }],
        ['a moved delay slider', { delayRate: 1 }],
        ['a moved complexity slider', { complexity: TICKET_DRAFT_COMPLEXITY + 1 }],
    ]) {
        assert.equal(isUntouchedTicketDraft({ ...emptyTicketDraft(), ...patch }), false, label)
    }
    // Whitespace is not work.
    assert.equal(isUntouchedTicketDraft({ ...emptyTicketDraft(), description: '   ', tasks: ['  '] }), true)
})

test('dismissing an untouched panel removes the row it opened', () => {
    assert.equal(planTicketDraftSettlement({
        item: ROW, draft: emptyTicketDraft(), config: DEFAULT_BOARD_CONFIG, isDraft: true,
    }), 'delete')
})

test('dismissing a COMPLETE panel finishes the ticket, however it was dismissed', () => {
    // This is what makes clicking outside safe: the last field is not lost, and
    // a finished ticket does not linger as a draft because the button was not
    // the way out.
    assert.equal(planTicketDraftSettlement({
        item: ROW, draft: filled(), config: DEFAULT_BOARD_CONFIG, valueOn: true, isDraft: true,
    }), 'commit')
})

test('dismissing an INCOMPLETE panel keeps the work as a draft', () => {
    assert.equal(planTicketDraftSettlement({
        item: ROW, draft: filled({ hours: '' }), config: DEFAULT_BOARD_CONFIG, isDraft: true,
    }), 'keep')
})

test('an already-committed row is left alone by a later dismissal', () => {
    // The button commits and then closes, which runs the settlement again. It
    // must not write a second time — nor un-commit anything.
    assert.equal(planTicketDraftSettlement({
        item: ROW, draft: filled(), config: DEFAULT_BOARD_CONFIG, valueOn: true, isDraft: false,
    }), 'none')
})

test('a row that vanished underneath the panel is not resurrected', () => {
    // Discard deletes, a peer may delete, a join may replace the base. Writing
    // the panel state back would recreate the ticket from nothing.
    assert.equal(planTicketDraftSettlement({
        item: null, draft: filled(), config: DEFAULT_BOARD_CONFIG, isDraft: true,
    }), 'none')
})

test('an untouched panel is deleted even if the row was somehow already committed', () => {
    // Order matters: the emptiness check runs before the draft check, so a blank
    // card can never survive by having lost its mark.
    assert.equal(planTicketDraftSettlement({
        item: ROW, draft: emptyTicketDraft(), config: DEFAULT_BOARD_CONFIG, isDraft: false,
    }), 'delete')
})

test('with rigor off a described draft commits on any dismissal', () => {
    assert.equal(planTicketDraftSettlement({
        item: ROW, draft: { ...emptyTicketDraft(), description: 'Quick idea' }, config: RIGOR_OFF, isDraft: true,
    }), 'commit')
    // ...but not when the surface still owes its value rates.
    assert.equal(planTicketDraftSettlement({
        item: ROW, draft: { ...emptyTicketDraft(), description: 'Quick idea' }, config: RIGOR_OFF, valueOn: true, isDraft: true,
    }), 'keep')
})
