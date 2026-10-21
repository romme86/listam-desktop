import test from 'node:test'
import assert from 'node:assert/strict'
import { buildListMetaItem } from '@listam/domain/list-registry'
import { createDesktopStore } from '../src/store.mjs'
import { listAccess } from '../src/ui/list-access.mjs'

const meta = (id, baseKey) => buildListMetaItem({ id, name: id, type: 'board', baseKey, updatedAt: 1 })
const message = (store, payload) => store.applyClientEvent({ type: 'message', payload }, 1)

test('membership and strict mode remain isolated across personal and shared lists', () => {
    const store = createDesktopStore()
    store.setState({ items: [meta('work', 'aa'), meta('home', 'bb')] })
    const personal = { writers: [{ writerKey: 'personal', isSelf: true }], canAdminister: true }
    message(store, { type: 'membership-roster', roster: personal })
    message(store, { type: 'board-config', config: { rigorOn: true }, canAdminister: true })
    message(store, { type: 'membership-roster', baseKey: 'aa', roster: { writers: [{ writerKey: 'alice' }] } })
    message(store, { type: 'board-config', baseKey: 'aa', config: { rigorOn: false }, canAdminister: false })
    message(store, { type: 'membership-roster', baseKey: 'bb', roster: { writers: [{ writerKey: 'bob' }] } })
    message(store, { type: 'board-config', baseKey: 'bb', config: { rigorOn: true }, canAdminister: true })
    const state = store.getState()
    assert.equal(listAccess(state, 'work').roster.writers[0].writerKey, 'alice')
    assert.equal(listAccess(state, 'work').boardConfig.rigorOn, false)
    assert.equal(listAccess(state, 'work').canAdminister, false)
    assert.equal(listAccess(state, 'home').roster.writers[0].writerKey, 'bob')
    assert.equal(listAccess(state, 'home').boardConfig.rigorOn, true)
    assert.equal(listAccess(state, 'default').roster.writers[0].writerKey, 'personal')
    assert.equal(state.boardConfig.rigorOn, true)
})

test('an unloaded shared list never inherits personal members or editing authority', () => {
    const store = createDesktopStore()
    store.setState({ items: [meta('work', 'aa')], roster: { writers: [{ writerKey: 'private' }], canAdminister: true }, boardConfig: { rigorOn: false }, boardConfigCanAdminister: true })
    assert.deepEqual(listAccess(store.getState(), 'work'), { baseKey: 'aa' })
})

test('project reset clears the per-base member and config cache', () => {
    const store = createDesktopStore()
    message(store, { type: 'membership-roster', baseKey: 'aa', roster: { writers: [{ writerKey: 'alice' }] } })
    store.applyClientEvent({ type: 'reset' }, 2)
    assert.deepEqual(store.getState().sharedListState, {})
})
