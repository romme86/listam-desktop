import test from 'node:test'
import assert from 'node:assert/strict'
import { reduceRegistry, REGISTRY_LIST_TYPE, REGISTRY_LIST_ID } from '@listam/domain/list-registry'
import { createListReduction } from '@listam/domain/list-reducer'
import {
    newListMeta,
    newGroupMeta,
    patchListMeta,
    patchGroupMeta,
    deleteListMeta,
    deleteGroupMeta,
    nextListOrder,
    nextGroupOrder,
} from '../src/registry.mjs'

// Reduce a set of meta-items the way the store will (state.items -> registry).
const reg = (...metaItems) => reduceRegistry(metaItems)

test('newListMeta builds a well-formed registry meta-item; board writes the legacy wire type', () => {
    const meta = newListMeta({ id: 'work', name: 'Tokyo trip', type: 'board', groupId: 'home', order: 2 }, 5)
    assert.equal(meta.id, 'work', 'id IS the listId it describes')
    assert.equal(meta.listId, REGISTRY_LIST_ID)
    assert.equal(meta.listType, REGISTRY_LIST_TYPE)
    assert.equal(meta.regKind, 'list')
    assert.equal(meta.regName, 'Tokyo trip')
    assert.equal(meta.regType, 'kanban', 'boards travel under the legacy wire type for dual-read')
    assert.equal(meta.regGroupId, 'home')
    assert.equal(meta.regOrder, 2)
    assert.equal(meta.updatedAt, 5)

    // ...and reduceRegistry reads the canonical type back.
    assert.equal(reg(meta).lists[0].type, 'board')
})

test('patchListMeta preserves sibling fields and bumps updatedAt', () => {
    const initial = newListMeta({ id: 'g1', name: 'Groceries', type: 'shopping', groupId: 'home', order: 3, view: { isGridView: true } }, 1)
    const registry = reg(initial)

    const renamed = patchListMeta(registry, 'g1', { name: 'Food' }, 9)
    assert.equal(renamed.regName, 'Food')
    assert.equal(renamed.regGroupId, 'home', 'group preserved across a rename')
    assert.equal(renamed.regOrder, 3, 'order preserved across a rename')
    assert.equal(renamed.regView?.isGridView, true, 'view override preserved across a rename')
    assert.equal(renamed.updatedAt, 9)

    assert.equal(patchListMeta(registry, 'missing', { name: 'x' }, 9), null)
})

test('moveListToGroup-style patch only changes the group + order', () => {
    const a = newListMeta({ id: 'a', name: 'A', type: 'shopping', groupId: null, order: 0 }, 1)
    const b = newListMeta({ id: 'b', name: 'B', type: 'shopping', groupId: 'work', order: 0 }, 1)
    const registry = reg(a, b)

    const moved = patchListMeta(registry, 'a', { groupId: 'work', order: nextListOrder(registry, 'work') }, 2)
    assert.equal(moved.regGroupId, 'work')
    assert.equal(moved.regOrder, 1, 'appended after the existing work-group list')
    assert.equal(moved.regName, 'A', 'name untouched')
})

test('group rename builds a tombstone-free meta-item', () => {
    const group = newGroupMeta({ id: 'home', name: 'Home', order: 0 }, 1)
    const list = newListMeta({ id: 'g1', name: 'Groceries', type: 'shopping', groupId: 'home', order: 0 }, 1)
    const registry = reg(group, list)
    assert.deepEqual(registry.groups.map((g) => g.name), ['Home'])

    const renamed = patchGroupMeta(registry, 'home', { name: 'House' }, 2)
    assert.equal(renamed.regName, 'House')
    assert.equal(renamed.regDeleted, undefined)
})

test('a tombstone delete removes the entry once it LWW-replaces the live item by id', () => {
    // Tombstones don't delete by merely co-existing with the live item —
    // reduceRegistry keeps the live one. They delete because the store's
    // id-keyed reduction replaces the live item with the newer tombstone, so
    // allItems() ends up holding only the tombstone (which reduceRegistry drops).
    const group = newGroupMeta({ id: 'home', name: 'Home', order: 0 }, 1)
    const list = newListMeta({ id: 'g1', name: 'Groceries', type: 'shopping', groupId: 'home', order: 0 }, 1)
    const registry = reg(group, list)

    const listTomb = deleteListMeta(registry, 'g1', 3)
    assert.equal(listTomb.regDeleted, true)
    assert.equal(listTomb.id, 'g1')

    const reduction = createListReduction()
    reduction.applyOperation({ type: 'add', value: group })
    reduction.applyOperation({ type: 'add', value: list })
    reduction.applyOperation({ type: 'update', value: listTomb }) // newer update by id
    const afterListDelete = reduceRegistry(reduction.allItems())
    assert.equal(afterListDelete.lists.length, 0, 'list is gone')
    assert.deepEqual(afterListDelete.groups.map((g) => g.name), ['Home'], 'its group remains')

    const groupTomb = deleteGroupMeta(registry, 'home', 4)
    assert.equal(groupTomb.regDeleted, true)
    reduction.applyOperation({ type: 'update', value: groupTomb })
    assert.equal(reduceRegistry(reduction.allItems()).groups.length, 0, 'group is gone')
})

test('order allocation appends within a group and across groups', () => {
    const registry = reg(
        newGroupMeta({ id: 'home', name: 'Home', order: 0 }, 1),
        newGroupMeta({ id: 'work', name: 'Work', order: 1 }, 1),
        newListMeta({ id: 'a', name: 'A', type: 'shopping', groupId: 'home', order: 0 }, 1),
        newListMeta({ id: 'b', name: 'B', type: 'shopping', groupId: 'home', order: 1 }, 1),
    )
    assert.equal(nextListOrder(registry, 'home'), 2)
    assert.equal(nextListOrder(registry, 'work'), 0, 'empty group starts at 0')
    assert.equal(nextListOrder(registry, null), 0, 'ungrouped is its own bucket')
    assert.equal(nextGroupOrder(registry), 2)
})
