import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildUndoEntry, applyInverseWrite, guardOk, pushCapped } from '../src/undo.mjs'

// A fake RPC_UPDATE command id; the real value doesn't matter to these helpers.
const RPC_UPDATE = 2

test('buildUndoEntry freezes and clones preImage/touched', () => {
    const item = { id: 'x', text: 'a', updatedAt: 1 }
    const entry = buildUndoEntry({ kind: 'edit', itemId: 'x', preImage: item, touched: { text: 'b' } })
    assert.ok(Object.isFrozen(entry))
    assert.notEqual(entry.preImage, item, 'preImage is a copy, not the live item')
    assert.deepEqual(entry.touched, { text: 'b' })
    // Mutating the source item after capture must not affect the entry.
    item.text = 'mutated'
    assert.equal(entry.preImage.text, 'a')
})

test('applyInverseWrite: edit inverse restores prior text, stamped at apply not capture', () => {
    const preImage = { id: 'x', text: 'a', updatedAt: 100 }
    const entry = buildUndoEntry({ kind: 'edit', itemId: 'x', preImage, touched: { text: 'b' } })
    const { command, payload } = applyInverseWrite(entry, 999, RPC_UPDATE)
    assert.equal(command, RPC_UPDATE)
    assert.equal(payload.item.id, 'x')
    assert.equal(payload.item.text, 'a', 'restores the prior text')
    assert.equal(payload.item.updatedAt, 999, 'updatedAt is the apply-time now(), not the captured 100')
})

test('applyInverseWrite: toggle inverse restores isDone + timeOfCompletion', () => {
    const preImage = { id: 'x', text: 'a', isDone: false, timeOfCompletion: 0, updatedAt: 5 }
    const entry = buildUndoEntry({ kind: 'toggle', itemId: 'x', preImage, touched: { isDone: true, timeOfCompletion: 5 } })
    const { payload } = applyInverseWrite(entry, 42, RPC_UPDATE)
    assert.equal(payload.item.isDone, false)
    assert.equal(payload.item.timeOfCompletion, 0)
    assert.equal(payload.item.updatedAt, 42)
})

test('applyInverseWrite: delete inverse is RPC_UPDATE re-writing the SAME id (never RPC_ADD)', () => {
    const preImage = { id: 'keep-me', text: 'milk', order: 3, updatedAt: 7 }
    const entry = buildUndoEntry({ kind: 'delete', itemId: 'keep-me', preImage })
    const { command, payload } = applyInverseWrite(entry, 50, RPC_UPDATE)
    assert.equal(command, RPC_UPDATE, 'resurrect via UPDATE preserves the id')
    assert.equal(payload.item.id, 'keep-me')
    assert.equal(payload.item.order, 3, 'order preserved so position is restored')
    assert.equal(payload.item.updatedAt, 50)
})

test('guardOk: edit — same touched ok, changed touched refused, vanished refused', () => {
    const entry = buildUndoEntry({ kind: 'edit', itemId: 'x', preImage: { id: 'x', text: 'a' }, touched: { text: 'b' } })
    assert.equal(guardOk(entry, () => ({ id: 'x', text: 'b' })), true, 'still equals what we wrote')
    assert.equal(guardOk(entry, () => ({ id: 'x', text: 'edited elsewhere' })), false, 'touched field changed underneath')
    assert.equal(guardOk(entry, () => undefined), false, 'target vanished (remote delete)')
    // A change to an UNRELATED field must not block undo of the text edit.
    assert.equal(guardOk(entry, () => ({ id: 'x', text: 'b', isDone: true })), true)
})

test('guardOk: toggle — compares isDone + timeOfCompletion', () => {
    const entry = buildUndoEntry({ kind: 'toggle', itemId: 'x', preImage: { id: 'x', isDone: false, timeOfCompletion: 0 }, touched: { isDone: true, timeOfCompletion: 9 } })
    assert.equal(guardOk(entry, () => ({ id: 'x', isDone: true, timeOfCompletion: 9 })), true)
    assert.equal(guardOk(entry, () => ({ id: 'x', isDone: false, timeOfCompletion: 0 })), false, 're-toggled underneath')
})

test('guardOk: delete — ok while absent, refused once re-created', () => {
    const entry = buildUndoEntry({ kind: 'delete', itemId: 'x', preImage: { id: 'x', text: 'a' } })
    assert.equal(guardOk(entry, () => undefined), true, 'still deleted → safe to resurrect')
    assert.equal(guardOk(entry, () => ({ id: 'x', text: 'a' })), false, 'live again → refuse (would clobber)')
})

test('multi-level undo of the SAME item chains correctly (content-fingerprint, not updatedAt)', () => {
    // Simulate a store item edited twice: a -> b -> c, then undo twice.
    let current = { id: 'x', text: 'a', updatedAt: 1 }
    const lookup = () => current
    const apply = (entry, now) => { current = { ...current, ...applyInverseWrite(entry, now, RPC_UPDATE).payload.item } }

    const entry1 = buildUndoEntry({ kind: 'edit', itemId: 'x', preImage: { id: 'x', text: 'a', updatedAt: 1 }, touched: { text: 'b' } })
    current = { id: 'x', text: 'b', updatedAt: 2 }
    const entry2 = buildUndoEntry({ kind: 'edit', itemId: 'x', preImage: { id: 'x', text: 'b', updatedAt: 2 }, touched: { text: 'c' } })
    current = { id: 'x', text: 'c', updatedAt: 3 }

    const stack = [entry1, entry2]

    // Undo #1 (entry2): guard passes (text still 'c'), restores 'b'.
    assert.equal(guardOk(stack.at(-1), lookup), true)
    apply(stack.pop(), 100)
    assert.equal(current.text, 'b')

    // Undo #2 (entry1): guard must STILL pass even though updatedAt is now 100,
    // because we compare the touched text ('b'), not the timestamp.
    assert.equal(guardOk(stack.at(-1), lookup), true, 'an updatedAt-equality guard would wrongly fail here')
    apply(stack.pop(), 101)
    assert.equal(current.text, 'a')
})

test('pushCapped evicts the oldest beyond the cap', () => {
    const stack = []
    for (let i = 0; i < 55; i++) pushCapped(stack, i, 50)
    assert.equal(stack.length, 50)
    assert.equal(stack[0], 5, 'oldest 5 evicted')
    assert.equal(stack.at(-1), 54)
})
