import test from 'node:test'
import assert from 'node:assert/strict'
import { isEmptyBlock, cleanBlockDraft } from '../src/ui/structured-block-editor.mjs'

test('empty typed payloads disappear but intentional dividers and meaningful fields survive', () => {
    for (const block of [
        { type: 'markdown', text: '\u200b \n' }, { type: 'heading', text: '' },
        { type: 'checklist', items: [{ text: '', done: true }] },
        { type: 'numberedList', items: [] }, { type: 'links', links: [{ label: ' ', url: '' }] },
        { type: 'image', url: '', alt: '' }, { type: 'table', rows: [[' ', '']] },
        { type: 'callout', text: '' }, { type: 'code', text: '\n' },
    ]) assert.equal(isEmptyBlock(block), true, block.type)
    for (const block of [
        { type: 'divider' }, { type: 'image', url: '', alt: 'Description' },
        { type: 'links', links: [{ label: '', url: 'https://example.com' }] },
        { type: 'table', rows: [['', 'Cell']] }, { type: 'code', text: '[]' },
    ]) assert.equal(isEmptyBlock(block), false, block.type)
})

test('committing a structured list removes empty rows without changing checked state or formatting', () => {
    const block = { id: 'list', type: 'checklist', items: [{ text: '**Done**', done: true }, { text: '', done: false }] }
    assert.deepEqual(cleanBlockDraft(block), { ...block, items: [block.items[0]] })
    assert.equal(block.items.length, 2, 'the active draft stays intact')
    const link = { label: 'A | B', url: 'https://example.com/?x=a|b' }
    assert.deepEqual(cleanBlockDraft({ type: 'links', links: [link, { label: '', url: '' }] }).links, [link])
})
