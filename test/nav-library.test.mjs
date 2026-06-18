import test from 'node:test'
import assert from 'node:assert/strict'
import { RPC_REQUEST_SYNC } from '@listam/protocol'
import { reduceRegistry } from '@listam/domain/list-registry'
import { isBoardType, BOARD_LIST_TYPE } from '@listam/domain/board'
import { isTodoType } from '@listam/domain/identity'
import { createMockBackend } from '../src/mock-backend.mjs'
import { detectExtraLists } from '../src/registry.mjs'

test('the mock seeds grocery/board/todo on the default list + a named registry list', async () => {
    const { client } = createMockBackend()
    let synced = null
    client.onEvent((event) => { if (event.type === 'sync-list') synced = event.items })
    await client.send(RPC_REQUEST_SYNC)
    assert.ok(synced, 'sync-list emitted')

    // Legacy desktop model: grocery, board AND to-do all live on listId 'default'
    // (differentiated by listType) — they surface as the built-in rail entries.
    const onDefault = synced.filter((i) => i.listId === 'default')
    assert.ok(onDefault.some((i) => isBoardType(i.listType)), 'board tickets on default')
    assert.ok(onDefault.some((i) => isTodoType(i.listType)), 'to-do items on default')
    assert.ok(onDefault.some((i) => !isBoardType(i.listType) && !isTodoType(i.listType) && i.listType !== 'registry'), 'grocery items on default')

    // The registry declares only the *named* extra list + its group; the default
    // surfaces are built-ins, not registry entries.
    const registry = reduceRegistry(synced)
    assert.deepEqual(registry.groups.map((g) => g.name), ['Projects'])
    assert.deepEqual(registry.lists.map((l) => ({ id: l.id, name: l.name, type: l.type, groupId: l.groupId })), [
        { id: 'hardware', name: 'Hardware', type: 'shopping', groupId: 'projects' },
    ])
    // The named list's items live on its own listId.
    assert.ok(synced.some((i) => i.listId === 'hardware' && i.text === 'M3 screws'))

    // The board's legacy wire value normalizes to the canonical type on read.
    assert.equal(BOARD_LIST_TYPE, 'board')
})

test('legacy default-only data adds NO registry surfaces (built-ins cover it); a separate list does surface', () => {
    // Real/legacy data: everything on listId 'default', no registry meta-items.
    const legacy = [
        { id: 'a', listId: 'default', listType: 'shopping', text: 'Milk', isDone: false, timeOfCompletion: 0, updatedAt: 1 },
        { id: 'b', listId: 'default', listType: 'kanban', text: 'Ship', status: 'todo', isDone: false, timeOfCompletion: 0, updatedAt: 1 },
        { id: 'c', listId: 'default', listType: 'todo', text: 'Call', isDone: false, timeOfCompletion: 0, updatedAt: 1 },
    ]
    const reg = reduceRegistry(legacy)
    // The rail excludes the default list from registry surfaces (it's the
    // built-ins), so legacy default-only data yields zero extra registry rows.
    const extraNonDefault = detectExtraLists(legacy, reg, (id) => id).filter((l) => l.id !== 'default')
    assert.deepEqual(extraNonDefault, [], 'no registry surfaces — board/todo come from built-ins')

    // A genuinely separate list (items, no meta-item) still surfaces.
    const withWork = [...legacy, { id: 'w', listId: 'work', listType: 'shopping', text: 'Tape', isDone: false, timeOfCompletion: 0, updatedAt: 1 }]
    const extras = detectExtraLists(withWork, reduceRegistry(withWork), (id) => id).filter((l) => l.id !== 'default')
    assert.deepEqual(extras.map((l) => l.id), ['work'])
})
