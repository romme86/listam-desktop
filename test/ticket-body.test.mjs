import test from 'node:test'
import assert from 'node:assert/strict'
import { TICKET_TASKS_BLOCK_ID, ticketTasks, evaluateRules, DEFAULT_BOARD_CONFIG } from '@listam/domain/board'
import { foldTicketTasks, ticketBodyFields } from '../src/ui/ticket-body.mjs'
import { ticketDraftFields, emptyTicketDraft } from '../src/ui/ticket-draft.mjs'

test('creation tasks seed one leading body list while preserving existing content', () => {
    const notes = { id: 'notes', type: 'markdown', text: 'Keep these notes' }
    const draft = { ...emptyTicketDraft(), description: 'Title', tasks: ['One', ' ', 'Two'] }
    const fields = ticketDraftFields(draft, false, [notes])
    assert.deepEqual(fields.blocks, [
        { id: TICKET_TASKS_BLOCK_ID, type: 'checklist', items: [{ text: 'One', done: false }, { text: 'Two', done: false }] }, notes,
    ])
    assert.equal(ticketTasks(fields).length, 2, 'compatibility mirror is not counted twice')
    assert.deepEqual(ticketDraftFields({ ...draft, tasks: [''] }, false, fields.blocks).blocks, [notes])
})

test('legacy tasks retain completion and fold once without replacing reordered blocks', () => {
    const item = { checklist: [{ id: 'old', text: 'Already done', done: true }], blocks: [{ id: 'future', type: 'future-widget', payload: 42 }] }
    const blocks = foldTicketTasks(item)
    assert.equal(blocks[0].items[0].done, true)
    assert.deepEqual(blocks[1], item.blocks[0])
    const reordered = blocks.toReversed()
    assert.deepEqual(foldTicketTasks({ ...item, blocks: reordered }), reordered)
    assert.equal(ticketTasks({ ...item, blocks }).length, 1)
})

test('editing and removing the creation list updates the existing completion gate', () => {
    const item = ticketDraftFields({ ...emptyTicketDraft(), tasks: ['One'] }, false)
    const blocks = structuredClone(item.blocks)
    blocks[0].items[0].text = 'Edited'
    blocks[0].items[0].done = true
    const edited = { ...item, ...ticketBodyFields(item, blocks), status: 'done' }
    assert.deepEqual(edited.checklist, [{ id: 'task-0', text: 'Edited', done: true }])
    assert.equal(evaluateRules(DEFAULT_BOARD_CONFIG, edited).ok, true)
    blocks[0].items.push({ text: 'Another', done: false })
    const incomplete = { ...edited, ...ticketBodyFields(edited, blocks) }
    assert.equal(evaluateRules(DEFAULT_BOARD_CONFIG, incomplete).ok, false)
    const removed = { ...incomplete, ...ticketBodyFields(incomplete, []) }
    assert.deepEqual(removed.checklist, [])
    assert.deepEqual(foldTicketTasks(removed), [], 'deleted tasks must not reappear on reopen')
})
