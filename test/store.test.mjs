import test from 'node:test'
import assert from 'node:assert/strict'
import {
    createDesktopStore,
    decodeSyncListSnapshot,
    desktopActions,
    selectDesktopState,
    selectSummary,
    DEFAULT_PREFERENCES,
} from '../src/store.mjs'
import { loadUiPreferences, persistUiPreferences } from '../src/prefs.mjs'
import {
    buildItemPlanEntry,
    buildPeerLabelItem,
    buildPresenceItem,
    isPlanItem,
    PEER_LABEL_LIST_ID,
    PEER_LABEL_LIST_TYPE,
    PLAN_LIST_ID,
    PLAN_LIST_TYPE,
    PRESENCE_LIST_ID,
    PRESENCE_LIST_TYPE,
} from '@listam/domain'

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

test('desktop state is owned by named Redux slices with a flat compatibility view', () => {
    const store = createDesktopStore({ preferences: { theme: 'dark' } })
    const root = store.getReduxState()

    assert.deepEqual(Object.keys(root), [
        'lists',
        'sync',
        'devices',
        'boardConfig',
        'labels',
        'presence',
        'runtime',
        'preferences',
    ])
    assert.deepEqual(root.lists.itemsById, {})
    assert.equal(root.sync.isWorkletReady, false)
    assert.equal(root.runtime.leafBridge, null)
    assert.equal(root.preferences.theme, 'dark')
    assert.deepEqual(store.getState(), selectDesktopState(root))

    let observed = null
    const unsubscribe = store.subscribe((state) => { observed = state })
    store.dispatch(desktopActions.lists.selectedListItemsSynced([item('a', 'Milk')]))
    store.dispatch(desktopActions.sync.snapshotReceived())
    store.dispatch(desktopActions.sync.workletReadySet(true))
    unsubscribe()

    assert.equal(Object.values(store.getReduxState().lists.itemsById)[0].text, 'Milk')
    assert.equal(store.getReduxState().sync.hasReceivedSnapshot, true)
    assert.equal(store.getReduxState().sync.isWorkletReady, true)
    assert.equal(observed.backendReady, true)
    assert.equal(observed.items[0].text, 'Milk')

    // The legacy bridge still merges preference patches, but Redux owns them.
    store.setState({ preferences: { categoryHeaders: false } })
    assert.equal(store.getReduxState().preferences.categoryHeaders, false)
})

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

test('structured sync snapshots replace stale reserved buckets exactly', () => {
    const store = createDesktopStore()
    const oldPlan = buildItemPlanEntry({ listId: 'default', itemId: 'old', plannedFor: '2026-07-10', updatedAt: 1 })
    const newPlan = buildItemPlanEntry({ listId: 'default', itemId: 'new', plannedFor: '2026-07-17', updatedAt: 2 })
    const oldPeer = buildPeerLabelItem({ writerKey: 'old-peer', name: 'Old', updatedAt: 1 })
    const newPeer = buildPeerLabelItem({ writerKey: 'new-peer', name: 'New', updatedAt: 2 })
    const oldPresence = buildPresenceItem({ writerKey: 'old-peer', lastActiveAt: 1 })

    store.applyClientEvent({ type: 'add-from-backend', item: oldPlan })
    store.applyClientEvent({ type: 'add-from-backend', item: oldPeer })
    store.applyClientEvent({ type: 'add-from-backend', item: oldPresence })

    store.applyClientEvent({
        type: 'sync-list',
        items: { list: [newPlan], listId: PLAN_LIST_ID, listType: PLAN_LIST_TYPE },
    })
    store.applyClientEvent({
        type: 'sync-list',
        items: { list: [newPeer], listId: PEER_LABEL_LIST_ID, listType: PEER_LABEL_LIST_TYPE },
    })
    store.applyClientEvent({
        type: 'sync-list',
        items: { list: [], listId: PRESENCE_LIST_ID, listType: PRESENCE_LIST_TYPE },
    })

    const state = store.getState()
    assert.deepEqual(state.items.filter(isPlanItem).map((entry) => entry.id), [newPlan.id])
    assert.equal(state.items.some((entry) => entry.id === oldPeer.id), false)
    assert.equal(state.items.some((entry) => entry.id === newPeer.id), true)
    assert.equal(state.items.some((entry) => entry.id === oldPresence.id), false)
})

test('sync snapshot decoder preserves arrays and understands structured buckets', () => {
    assert.deepEqual(decodeSyncListSnapshot([{ id: 'a' }]), {
        mode: 'legacy',
        items: [{ id: 'a' }],
    })
    assert.deepEqual(decodeSyncListSnapshot({
        list: [{ id: 'p', listId: PLAN_LIST_ID, listType: PLAN_LIST_TYPE }],
        listId: PLAN_LIST_ID,
        listType: PLAN_LIST_TYPE,
    }), {
        mode: 'bucket',
        items: [{ id: 'p', listId: PLAN_LIST_ID, listType: PLAN_LIST_TYPE }],
        listId: PLAN_LIST_ID,
        listType: PLAN_LIST_TYPE,
    })
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

test('recovery sync is quiet when unchanged and preserves projected extra lists', () => {
    const store = createDesktopStore()
    const defaultItems = [item('a', 'Milk')]
    const named = item('n1', 'Hardware', { listId: 'named', listType: 'shopping' })
    let renders = 0
    store.subscribe(() => { renders++ })

    store.applyClientEvent({ type: 'sync-list', items: defaultItems })
    store.applyClientEvent({ type: 'add-from-backend', item: named })
    assert.equal(renders, 2)

    store.applyClientEvent({ type: 'sync-list', items: defaultItems })
    assert.equal(renders, 2, 'identical authoritative snapshot does not re-render')
    assert.equal(store.getState().items.some((entry) => entry.id === 'n1'), true)

    store.applyClientEvent({ type: 'sync-list', items: [item('b', 'Bread')] })
    assert.equal(renders, 3)
    assert.equal(store.getState().items.some((entry) => entry.id === 'a'), false)
    assert.equal(store.getState().items.some((entry) => entry.id === 'n1'), true)
})

test('idempotent projected items do not notify subscribers', () => {
    const store = createDesktopStore()
    const first = item('n1', 'Hardware', { listId: 'named', listType: 'shopping' })
    const second = item('n2', 'Paint', { listId: 'named', listType: 'shopping' })
    let renders = 0
    store.subscribe(() => { renders++ })

    store.applyClientEvent({ type: 'add-from-backend', item: first })
    store.applyClientEvent({ type: 'add-from-backend', item: second })
    const before = store.getState().items.map((entry) => entry.id)
    store.applyClientEvent({ type: 'add-from-backend', item: { ...first } })

    assert.equal(renders, 2)
    assert.deepEqual(store.getState().items.map((entry) => entry.id), before)
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

    const roster = { canAdminister: true, writers: [{ writerKey: 'aa', isOwner: true, isSelf: true }] }
    store.applyClientEvent({ type: 'message', payload: { type: 'membership-roster', roster } })
    assert.equal(store.getState().roster.canAdminister, true)
    assert.equal(store.getState().roster.writers[0].writerKey, 'aa')
    const refreshedRoster = { canAdminister: false, writers: [{ writerKey: 'bb', isSelf: true }] }
    assert.doesNotThrow(() => {
        store.applyClientEvent({ type: 'message', payload: { type: 'membership-roster', roster: refreshedRoster } })
    })
    assert.deepEqual(store.getState().roster.writers.map((writer) => writer.writerKey), ['bb'])

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

    store.applyClientEvent({ type: 'message', payload: { type: 'epoch-key-stale' } }, 7)
    assert.equal(store.getState().writeBlock, 'epoch-key-stale')
    assert.equal(store.getState().diagnostics.at(-1).label, 'epoch-key-stale')

    // A successful mutation clears the block (ui.mjs calls this on ok:true).
    store.clearWriteBlock()
    assert.equal(store.getState().writeBlock, null)

    // A base reset also drops it — the new base starts unjudged.
    store.applyClientEvent({ type: 'message', payload: { type: 'not-writable' } }, 8)
    store.applyClientEvent({ type: 'reset' }, 9)
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
    assert.equal(DEFAULT_PREFERENCES.categoriesEnabled, false)
    assert.equal(DEFAULT_PREFERENCES.categoryHeaders, false)

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

// Sharing a list PROMOTES it: its items are re-seeded into a new single-list
// base with the SAME ids, then the personal copies are tombstoned. The two bases
// replicate independently, so the delete can arrive AFTER the seed — and
// identityKey (listId + itemId, no base) makes it match. Without a guard the
// list that was just shared goes empty.
test('a late personal tombstone cannot empty a list that was just shared', () => {
    const store = createDesktopStore()
    const SHARED = 'a1b2c3'

    // The personal registry declares that this list's items now live in a
    // shared base.
    store.applyClientEvent({
        type: 'add-from-backend',
        item: {
            id: 'holiday', listId: '__registry__', listType: 'registry',
            regKind: 'list', regName: 'Holiday', regType: 'todo', regBaseKey: SHARED,
            text: 'Holiday', isDone: false, timeOfCompletion: 0, updatedAt: 1,
        },
    }, 1)

    // The shared base seeds the item.
    store.applyClientEvent({
        type: 'add-from-backend',
        item: {
            id: 'x1', text: 'Passports', listId: 'holiday', listType: 'todo',
            baseKey: SHARED, isDone: false, timeOfCompletion: 0, updatedAt: 2,
        },
    }, 2)
    assert.equal(store.getState().items.some((i) => i.id === 'x1'), true, 'the seeded item is present')

    // The personal base's tombstone for the SAME id arrives late, untagged.
    store.applyClientEvent({
        type: 'delete-from-backend',
        item: {
            id: 'x1', text: 'Passports', listId: 'holiday', listType: 'todo',
            isDone: false, timeOfCompletion: 0, updatedAt: 3,
        },
    }, 3)

    assert.equal(
        store.getState().items.some((i) => i.id === 'x1'),
        true,
        'an event from the base this list was promoted away from must be ignored',
    )
})

test('the base guard fails open for a list the registry has not described', () => {
    // Dropping items because the registry has not replicated yet would turn a
    // slow sync into data loss.
    const store = createDesktopStore()
    store.applyClientEvent({
        type: 'add-from-backend',
        item: {
            id: 'y1', text: 'Milk', listId: 'not-in-registry', listType: 'shopping',
            baseKey: 'ffff', isDone: false, timeOfCompletion: 0, updatedAt: 1,
        },
    }, 1)
    assert.equal(store.getState().items.some((i) => i.id === 'y1'), true)
})

// A write the backend could not flush is now KEPT in its durable outbox and
// replayed later, so it is not a failure — the row exists and will sync. The UI
// must say "not synced yet" rather than either losing it or implying it landed.
test('a queued write marks the row pending without raising a write block', () => {
    const store = createDesktopStore()

    store.applyClientEvent({ type: 'message', payload: { type: 'write-queued', id: 'x1', listId: 'default' } }, 1)

    assert.deepEqual(store.getState().pendingWriteIds, ['x1'])
    assert.equal(store.getState().writeBlock, null, 'a kept write is not a blocked write')
})

test('queued ids do not duplicate when the same row is refused twice', () => {
    const store = createDesktopStore()
    for (let i = 0; i < 3; i++) {
        store.applyClientEvent({ type: 'message', payload: { type: 'write-queued', id: 'x1' } }, i)
    }
    assert.deepEqual(store.getState().pendingWriteIds, ['x1'])
})

test('a successful replay clears the pending marks', () => {
    const store = createDesktopStore()
    store.applyClientEvent({ type: 'message', payload: { type: 'write-queued', id: 'x1' } }, 1)
    store.applyClientEvent({ type: 'message', payload: { type: 'write-queued', id: 'x2' } }, 2)

    store.applyClientEvent({ type: 'message', payload: { type: 'write-replayed', count: 2 } }, 3)

    assert.deepEqual(store.getState().pendingWriteIds, [])
})

test('queued edits whose world moved on raise a block that asks the user', () => {
    // Epoch rotated or the list changed base while the edit sat queued. It is
    // still held; only the user can say whether a stale edit is still wanted.
    const store = createDesktopStore()
    store.applyClientEvent({
        type: 'message',
        payload: { type: 'write-needs-decision', blocked: [{ id: 'x1', reason: 'epoch-changed' }] },
    }, 1)

    assert.equal(store.getState().writeBlock, 'write-needs-decision')
})
