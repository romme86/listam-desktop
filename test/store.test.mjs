import test from 'node:test'
import assert from 'node:assert/strict'
import { createDesktopStore, selectSummary, DEFAULT_PREFERENCES } from '../src/store.mjs'
import { loadUiPreferences, persistUiPreferences } from '../src/prefs.mjs'

function item(id, text, overrides = {}) {
    return {
        id,
        text,
        isDone: false,
        timeOfCompletion: 0,
        updatedAt: 1,
        listId: 'default',
        listType: 'shopping',
        ...overrides,
    }
}

test('store reduces backend item events through the shared id-keyed reduction', () => {
    const store = createDesktopStore()

    store.applyClientEvent({ type: 'sync-list', items: [item('a', 'Milk'), item('b', 'Bread')] })
    assert.deepEqual(store.getState().items.map((entry) => entry.text), ['Milk', 'Bread'])

    store.applyClientEvent({ type: 'add-from-backend', item: item('c', 'Eggs') })
    assert.equal(store.getState().items[0].text, 'Eggs')

    // Updates match by id — a same-name second item must not collapse.
    store.applyClientEvent({ type: 'add-from-backend', item: item('d', 'Milk') })
    store.applyClientEvent({ type: 'update-from-backend', item: item('a', 'Milk', { isDone: true, updatedAt: 2 }) })
    const state = store.getState()
    assert.equal(state.items.filter((entry) => entry.text === 'Milk').length, 2)
    assert.equal(state.items.find((entry) => entry.id === 'a').isDone, true)
    assert.equal(state.items.find((entry) => entry.id === 'd').isDone, false)

    store.applyClientEvent({ type: 'delete-from-backend', item: item('b', 'Bread') })
    assert.equal(store.getState().items.some((entry) => entry.id === 'b'), false)
})

test('store keeps items across every list bucket, not just default', () => {
    const store = createDesktopStore()

    const registryMeta = item('work', 'Tokyo trip', {
        listId: '__registry__',
        listType: 'registry',
        regKind: 'list',
        regName: 'Tokyo trip',
        regType: 'kanban',
        regGroupId: null,
        regOrder: 0,
    })
    store.applyClientEvent({
        type: 'sync-list',
        items: [item('a', 'Milk'), registryMeta, item('w1', 'Book flights', { listId: 'work', listType: 'kanban' })],
    })

    // The default-list projection order is unchanged for default items.
    assert.deepEqual(
        store.getState().items.filter((e) => e.listId === 'default').map((e) => e.text),
        ['Milk'],
    )
    // Registry meta-item and the non-default list item both survive the sync,
    // with their reg* fields intact (applyOperationToList would have dropped them).
    const meta = store.getState().items.find((e) => e.id === 'work')
    assert.equal(meta?.listType, 'registry')
    assert.equal(meta?.regType, 'kanban')
    assert.equal(store.getState().items.some((e) => e.id === 'w1' && e.listId === 'work'), true)

    // An incremental update to a non-default item must also survive (this is the
    // path the single-list reducer used to drop).
    store.applyClientEvent({
        type: 'update-from-backend',
        item: item('work', 'Kyoto trip', { listId: '__registry__', listType: 'registry', regName: 'Kyoto trip', updatedAt: 2 }),
    })
    assert.equal(store.getState().items.find((e) => e.id === 'work')?.regName, 'Kyoto trip')
    assert.equal(store.getState().items.some((e) => e.id === 'a' && e.listId === 'default'), true)
})

test('store tracks sync, membership, and recovery message payloads', () => {
    const store = createDesktopStore()

    store.applyClientEvent({ type: 'invite-key', key: 'z32invite' })
    store.applyClientEvent({ type: 'message', payload: { type: 'peer-count', count: 3 } })
    store.applyClientEvent({ type: 'message', payload: { type: 'join-phase', phase: 'pairing' } })
    assert.equal(store.getState().inviteKey, 'z32invite')
    assert.equal(store.getState().peerCount, 3)
    assert.equal(store.getState().joinPhase, 'pairing')

    store.setState({ isJoining: true })
    store.applyClientEvent({ type: 'message', payload: { type: 'join-success' } })
    assert.equal(store.getState().isJoining, false)
    assert.equal(store.getState().joinPhase, null)

    const roster = { canAdminister: true, members: [{ writerKey: 'aa', isOwner: true, isSelf: true }] }
    store.applyClientEvent({ type: 'message', payload: { type: 'membership-roster', roster } })
    assert.deepEqual(store.getState().roster, roster)

    store.applyClientEvent({ type: 'message', payload: { type: 'recovery-required', policy: 'interactive', reason: 'storage-corrupt' } })
    assert.deepEqual(store.getState().recovery, { policy: 'interactive', reason: 'storage-corrupt' })
    store.applyClientEvent({ type: 'message', payload: { type: 'recovery-complete', mode: 'retry' } })
    assert.equal(store.getState().recovery, null)

    store.applyClientEvent({ type: 'reset' })
    assert.deepEqual(store.getState().items, [])
    assert.equal(store.getState().inviteKey, '')
})

test('write refusals set writeBlock; success and reset clear it', () => {
    const store = createDesktopStore()
    assert.equal(store.getState().writeBlock, null)

    // The backend's mutation gates message the refusal cause (item.mjs gates:
    // not an accepted writer / local writer can't flush).
    store.applyClientEvent({ type: 'message', payload: { type: 'not-writable' } }, 5)
    assert.equal(store.getState().writeBlock, 'not-writable')
    assert.equal(store.getState().diagnostics.at(-1).label, 'not-writable')

    store.applyClientEvent({ type: 'message', payload: { type: 'sync-stalled' } }, 6)
    assert.equal(store.getState().writeBlock, 'sync-stalled')
    assert.equal(store.getState().diagnostics.at(-1).label, 'sync-stalled')

    // A successful mutation clears the block (ui.mjs calls this on ok:true).
    store.clearWriteBlock()
    assert.equal(store.getState().writeBlock, null)

    // A base reset also drops it — the new base starts unjudged.
    store.applyClientEvent({ type: 'message', payload: { type: 'not-writable' } }, 7)
    store.applyClientEvent({ type: 'reset' }, 8)
    assert.equal(store.getState().writeBlock, null)
})

test('diagnostics entries are redacted and bounded', () => {
    const store = createDesktopStore()
    const hexKey = 'a'.repeat(64)

    store.applyClientEvent({ type: 'message', payload: { type: 'join-error', message: `failed with key ${hexKey}` } }, 123)
    const entry = store.getState().diagnostics.at(-1)
    assert.equal(entry.at, 123)
    assert.equal(JSON.stringify(entry).includes(hexKey), false, 'raw key material never reaches diagnostics')

    for (let i = 0; i < 80; i++) {
        store.applyClientEvent({ type: 'message', payload: { type: 'peer-count', count: i } }, i)
    }
    assert.equal(store.getState().diagnostics.length, 50)
})

test('notices queue, cap, and dismiss; preferences merge over defaults', () => {
    const store = createDesktopStore({ preferences: { isGridView: true } })
    assert.equal(store.getState().preferences.isGridView, true)
    assert.equal(store.getState().preferences.categoriesEnabled, DEFAULT_PREFERENCES.categoriesEnabled)

    const first = store.pushNotice('one')
    for (const text of ['two', 'three', 'four', 'five']) store.pushNotice(text)
    assert.equal(store.getState().notices.length, 4, 'notice queue is capped')
    assert.equal(store.getState().notices.some((notice) => notice.id === first), false)

    const keep = store.getState().notices[0]
    store.dismissNotice(keep.id)
    assert.equal(store.getState().notices.some((notice) => notice.id === keep.id), false)

    store.setPreferences({ categoryHeaders: false })
    assert.equal(store.getState().preferences.categoryHeaders, false)

    assert.deepEqual(selectSummary([item('a', 'Milk', { isDone: true }), item('b', 'Bread')]), {
        total: 2,
        done: 1,
        remaining: 1,
    })
})

test('boardEnabled preference defaults off, round-trips, and persists per device', () => {
    const store = createDesktopStore()
    assert.equal(store.getState().preferences.boardEnabled, false)

    store.setPreferences({ boardEnabled: true })
    assert.equal(store.getState().preferences.boardEnabled, true)

    // Device-local persistence: a boolean key flows through the prefs codec
    // (it validates each key's typeof against DEFAULT_PREFERENCES) and reloads.
    const bag = new Map()
    const storage = { getItem: (k) => bag.get(k) ?? null, setItem: (k, v) => bag.set(k, v) }
    persistUiPreferences(storage, store.getState().preferences)
    assert.equal(loadUiPreferences(storage).boardEnabled, true)
})
