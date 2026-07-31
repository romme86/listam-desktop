import test from 'node:test'
import assert from 'node:assert/strict'
import { RPC_REQUEST_SYNC, RPC_SHARE_LIST } from '@listam/protocol'
import { buildBuiltinVisibilityItem, surfaceLabelKey } from '@listam/domain/labels'
import { reduceRegistry } from '@listam/domain/list-registry'
import { isBoardType, BOARD_LIST_TYPE } from '@listam/domain/board'
import { DEFAULT_LIST_TYPE, TODO_LIST_TYPE, isTodoType } from '@listam/domain/identity'
import { createMockBackend } from '../src/mock-backend.mjs'
import { detectExtraLists, visibleBuiltinSurfaceTypes } from '../src/registry.mjs'

test('a fresh desktop rail contains only the starter grocery surface', () => {
    assert.deepEqual(visibleBuiltinSurfaceTypes([]), [DEFAULT_LIST_TYPE])
})

test('legacy Board and Todo surfaces appear only when their default-bucket content exists', () => {
    const board = { id: 'b', listId: 'default', listType: 'kanban', text: 'Ship', updatedAt: 1 }
    const todo = { id: 't', listId: 'default', listType: TODO_LIST_TYPE, text: 'Call', updatedAt: 1 }
    assert.deepEqual(visibleBuiltinSurfaceTypes([board]), [DEFAULT_LIST_TYPE, BOARD_LIST_TYPE])
    assert.deepEqual(visibleBuiltinSurfaceTypes([todo]), [DEFAULT_LIST_TYPE, TODO_LIST_TYPE])
    assert.deepEqual(visibleBuiltinSurfaceTypes([board, todo]), [DEFAULT_LIST_TYPE, BOARD_LIST_TYPE, TODO_LIST_TYPE])
})

test('synced grocery deletion hides the starter surface until matching content resurrects it', () => {
    const hidden = buildBuiltinVisibilityItem({ listId: 'default', type: DEFAULT_LIST_TYPE, hidden: true, updatedAt: 10 })
    assert.deepEqual(visibleBuiltinSurfaceTypes([hidden]), [])

    const milk = { id: 'milk', listId: 'default', listType: DEFAULT_LIST_TYPE, text: 'Milk', updatedAt: 10 }
    assert.deepEqual(visibleBuiltinSurfaceTypes([hidden, milk]), [DEFAULT_LIST_TYPE])

    // Old local grocery hides are ignored; Board/Todo retain that legacy path.
    const localGrocery = surfaceLabelKey('default', DEFAULT_LIST_TYPE)
    const localTodo = surfaceLabelKey('default', TODO_LIST_TYPE)
    assert.deepEqual(visibleBuiltinSurfaceTypes([], [localGrocery]), [DEFAULT_LIST_TYPE])
    assert.deepEqual(visibleBuiltinSurfaceTypes([milk, { id: 't', listId: 'default', listType: TODO_LIST_TYPE, text: 'Call', updatedAt: 11 }], [localTodo]), [DEFAULT_LIST_TYPE])
})

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

test('the mock promotes default groceries into a distinct shared list', async () => {
    const { client } = createMockBackend()
    let synced = []
    client.onEvent((event) => { if (event.type === 'sync-list') synced = event.items })
    await client.send(RPC_REQUEST_SYNC)

    const beforeGroceries = synced.filter((item) => item.listId === 'default' && !isBoardType(item.listType) && !isTodoType(item.listType) && item.listType !== 'registry')
    const beforeBoards = synced.filter((item) => item.listId === 'default' && isBoardType(item.listType))
    const beforeTodos = synced.filter((item) => item.listId === 'default' && isTodoType(item.listType))

    const reply = JSON.parse(await client.send(RPC_SHARE_LIST, {
        listId: 'default',
        type: 'shopping',
        name: 'Groceries',
    }))
    assert.equal(reply.ok, true)
    assert.notEqual(reply.listId, 'default', 'the shared list gets a collision-free canonical id')
    assert.match(reply.baseKey, /^[0-9a-f]{64}$/)
    assert.equal(reply.listId, `list-${reply.baseKey}`)

    await client.send(RPC_REQUEST_SYNC)
    const registry = reduceRegistry(synced)
    const promoted = registry.lists.find((list) => list.id === reply.listId)
    assert.deepEqual(
        promoted && { name: promoted.name, type: promoted.type, baseKey: promoted.baseKey },
        { name: 'Groceries', type: 'shopping', baseKey: reply.baseKey },
    )
    assert.equal(synced.some((item) => item.listId === 'default' && !isBoardType(item.listType) && !isTodoType(item.listType) && item.listType !== 'registry'), false)
    assert.equal(synced.filter((item) => item.listId === reply.listId && item.listType === 'shopping').length, beforeGroceries.length)
    assert.equal(synced.filter((item) => item.listId === 'default' && isBoardType(item.listType)).length, beforeBoards.length)
    assert.equal(synced.filter((item) => item.listId === 'default' && isTodoType(item.listType)).length, beforeTodos.length)
})
