import test from 'node:test'
import assert from 'node:assert/strict'
import { RPC_REQUEST_SYNC } from '@listam/protocol'
import { reduceRegistry } from '@listam/domain/list-registry'
import { toNavLibrary, resolveLaunchList, flatten } from '@listam/domain/list-nav'
import { createMockBackend } from '../src/mock-backend.mjs'
import { detectExtraLists } from '../src/registry.mjs'

test('the mock backend seeds a registry the nav library reads into groups + lists', async () => {
    const { client } = createMockBackend()
    let synced = null
    client.onEvent((event) => { if (event.type === 'sync-list') synced = event.items })
    await client.send(RPC_REQUEST_SYNC)
    assert.ok(synced, 'sync-list emitted')

    const registry = reduceRegistry(synced)
    // The board's legacy wire type reads back as the canonical 'board'.
    assert.equal(registry.lists.find((l) => l.id === 'trip')?.type, 'board')

    const lib = toNavLibrary(registry, { defaultListId: 'default', ungroupedName: 'Ungrouped' })

    const home = lib.groups.find((g) => g.name === 'Home')
    assert.ok(home, 'Home group present')
    assert.deepEqual(
        home.listIds.map((id) => lib.listsById[id].name),
        ['Groceries', 'To-do'],
        'grouped lists are ordered by regOrder',
    )

    const ungrouped = lib.groups.at(-1)
    assert.equal(ungrouped.name, 'Ungrouped', 'implicit Ungrouped group is last')
    assert.deepEqual(ungrouped.listIds.map((id) => lib.listsById[id].name), ['Tokyo trip'])

    // The per-device default resolves to the grocery list.
    assert.equal(resolveLaunchList(lib, new Set(Object.keys(lib.listsById))), 'default')
})

test('detectExtraLists surfaces lists that have items but no meta-item; the grocery list always appears even with an empty registry', () => {
    const items = [
        { id: 'i1', listId: 'default', listType: 'shopping', text: 'Milk', isDone: false, timeOfCompletion: 0, updatedAt: 1 },
        { id: 'i2', listId: 'legacy', listType: 'todo', text: 'Old task', isDone: false, timeOfCompletion: 0, updatedAt: 1 },
        // A registry meta-item (id IS the listId it describes) names 'default'
        // and must NOT itself be mistaken for an extra list.
        { id: 'default', listId: '__registry__', listType: 'registry', text: 'Groceries', isDone: false, timeOfCompletion: 0, updatedAt: 1, regKind: 'list', regName: 'Groceries', regType: 'shopping', regGroupId: null, regOrder: 0 },
    ]

    // With a registry that already names 'default', only 'legacy' is extra.
    const withDefault = reduceRegistry(items)
    const extra = detectExtraLists(items, withDefault, (id) => `List ${id}`)
    assert.deepEqual(extra.map((l) => l.id), ['legacy'])
    assert.equal(extra[0].type, 'todo')
    assert.equal(extra[0].name, 'List legacy')

    // Empty registry → the grocery 'default' list still surfaces via extraLists,
    // so the nav is never list-less.
    const emptyReg = { groups: [], lists: [] }
    const lib = toNavLibrary(emptyReg, { extraLists: detectExtraLists(items, emptyReg, (id) => id), ungroupedName: 'Ungrouped' })
    assert.ok(flatten(lib).some((e) => e.listId === 'default'), 'default list present with no registry')
})
