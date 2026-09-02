import test from 'node:test'
import assert from 'node:assert/strict'
import { RPC_REQUEST_SYNC, RPC_SHARE_LIST } from '@listam/protocol'
import { buildBuiltinVisibilityItem, buildSurfaceLabelItem, surfaceLabelKey } from '@listam/domain/labels'
import { buildItemPlanEntry } from '@listam/domain/plan'
import { buildListMetaItem, reduceRegistry } from '@listam/domain/list-registry'
import { isBoardType, BOARD_LIST_TYPE } from '@listam/domain/board'
import { DEFAULT_LIST_TYPE, TODO_LIST_TYPE, isTodoType, NOTES_LIST_TYPE, isNotesType } from '@listam/domain/identity'
import { createMockBackend } from '../src/mock-backend.mjs'
import { detectExtraLists, visibleBuiltinSurfaceTypes } from '../src/registry.mjs'
import {
    surfaceForType,
    iconForType,
    typePredicate,
    builtinFallbackKey,
    isGroceryItem,
    isTodoItem,
    isNotesItem,
} from '../src/ui/list-types.mjs'
import { TABLER_PATHS } from '../src/tabler-icons.mjs'

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

test('the mock seeds grocery/board/todo on the default list + the named registry lists', async () => {
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

    // Notes is a NAMED list only — no built-in Notes surface — so the notes
    // fixtures live on their own listId and never on the default bucket.
    assert.equal(onDefault.filter((i) => isNotesType(i.listType)).length, 0, 'no notes on the default bucket')

    // The registry declares only the *named* extra lists + their group; the
    // default surfaces are built-ins, not registry entries.
    const registry = reduceRegistry(synced)
    assert.deepEqual(registry.groups.map((g) => g.name), ['Projects'])
    assert.deepEqual(registry.lists.map((l) => ({ id: l.id, name: l.name, type: l.type, groupId: l.groupId })), [
        { id: 'hardware', name: 'Hardware', type: 'shopping', groupId: 'projects' },
        { id: 'fieldnotes', name: 'Field notes', type: NOTES_LIST_TYPE, groupId: 'projects' },
    ])
    // The named lists' items live on their own listIds.
    assert.ok(synced.some((i) => i.listId === 'hardware' && i.text === 'M3 screws'))
    // Both index row shapes are seeded: a plain note and one with a block body.
    const notes = synced.filter((i) => i.listId === 'fieldnotes')
    assert.ok(notes.some((i) => !Array.isArray(i.blocks)), 'a plain note')
    assert.ok(notes.some((i) => Array.isArray(i.blocks) && i.blocks.length > 0), 'a note with blocks')
    assert.ok(notes.some((i) => i.isDone), 'an archived note')

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

// --- the list-type seam --------------------------------------------------
// Which pane renders a type, which rail icon marks it, which localized name a
// built-in falls back to, and which items belong to it. All four were
// hard-coded "board? todo? otherwise grocery" chains, and that otherwise is
// exactly how a fourth type ends up wearing the grocery surface.

const item = (id, listType, overrides = {}) => ({
    id, listId: 'l1', listType, text: id, isDone: false, timeOfCompletion: 0, updatedAt: 1, ...overrides,
})

test('every list type routes to its own pane and its own rail icon', () => {
    assert.equal(surfaceForType(DEFAULT_LIST_TYPE), 'lists')
    assert.equal(surfaceForType('kanban'), 'board', 'the legacy board wire type still routes to the board')
    assert.equal(surfaceForType(BOARD_LIST_TYPE), 'board')
    assert.equal(surfaceForType(TODO_LIST_TYPE), 'todo')
    assert.equal(surfaceForType(NOTES_LIST_TYPE), 'notes')
    // Forward compat: normalizeListType accepts anything a newer peer invents,
    // so an unknown type must still land on a real pane rather than nowhere.
    assert.equal(surfaceForType('recipes'), 'lists')

    assert.equal(iconForType(NOTES_LIST_TYPE), 'notes')
    const icons = [DEFAULT_LIST_TYPE, BOARD_LIST_TYPE, TODO_LIST_TYPE, NOTES_LIST_TYPE].map(iconForType)
    assert.equal(new Set(icons).size, icons.length, 'each surface is told apart by its icon in the rail')
})

test('every icon a list type asks for is actually vendored', () => {
    // tablerIcon falls back to the grocery basket for a name it does not have,
    // so an un-vendored glyph is invisible at runtime: the notes list would
    // simply wear the basket and nothing would fail.
    for (const type of [DEFAULT_LIST_TYPE, BOARD_LIST_TYPE, 'kanban', TODO_LIST_TYPE, NOTES_LIST_TYPE]) {
        assert.ok(TABLER_PATHS[iconForType(type)], `${type} -> '${iconForType(type)}' is not in tabler-icons.mjs`)
    }
})

test('isGroceryItem excludes every type that has a surface of its own — notes included', () => {
    const grocery = item('milk', DEFAULT_LIST_TYPE)
    const note = item('boiler', NOTES_LIST_TYPE)
    assert.equal(isGroceryItem(grocery), true)
    assert.equal(isGroceryItem(item('ship', 'kanban')), false)
    assert.equal(isGroceryItem(item('call', TODO_LIST_TYPE)), false)
    // The regression this closes: the voice notetaker has been writing real
    // 'notes' items since the backend shipped them, and "not board, not todo"
    // is TRUE for a note — so every one of them rendered, was counted and was
    // categorized as a grocery row.
    assert.equal(isGroceryItem(note), false)
    assert.equal(isNotesItem(note), true)
    assert.equal(isTodoItem(note), false)

    // The meta-item buckets share state.items and stay excluded as well.
    assert.equal(isGroceryItem(buildListMetaItem({ id: 'l1', name: 'Hardware', type: 'shopping', updatedAt: 1 })), false)
    assert.equal(isGroceryItem(buildSurfaceLabelItem({ listId: 'default', type: TODO_LIST_TYPE, name: 'Chores', updatedAt: 1 })), false)
    assert.equal(isGroceryItem(buildItemPlanEntry({ listId: 'l1', itemId: 'milk', plannedFor: '2026-09-01', updatedAt: 1 })), false)
    assert.equal(isGroceryItem(null), false)
})

test('typePredicate scopes a surface to its own items', () => {
    const items = [
        item('milk', DEFAULT_LIST_TYPE),
        item('ship', 'kanban'),
        item('call', TODO_LIST_TYPE),
        item('boiler', NOTES_LIST_TYPE),
    ]
    const idsOn = (type) => items.filter(typePredicate(type)).map((i) => i.id)
    assert.deepEqual(idsOn(DEFAULT_LIST_TYPE), ['milk'])
    assert.deepEqual(idsOn(BOARD_LIST_TYPE), ['ship'])
    assert.deepEqual(idsOn(TODO_LIST_TYPE), ['call'])
    assert.deepEqual(idsOn(NOTES_LIST_TYPE), ['boiler'])
})

test('builtinFallbackKey names each type instead of defaulting it to Groceries', () => {
    assert.equal(builtinFallbackKey(DEFAULT_LIST_TYPE), 'desktop.rail.groceries')
    assert.equal(builtinFallbackKey('kanban'), 'desktop.rail.board')
    assert.equal(builtinFallbackKey(TODO_LIST_TYPE), 'desktop.rail.todo')
    assert.equal(builtinFallbackKey(NOTES_LIST_TYPE), 'desktop.rail.notes')
})

test('notes never becomes a built-in surface — it is a named list only', () => {
    // The default bucket is the legacy compatibility container for Groceries /
    // Board / Todo. Notes is net-new and always registry-backed, so even notes
    // content parked on 'default' must not conjure a fourth built-in row.
    const stray = { id: 'n', listId: 'default', listType: NOTES_LIST_TYPE, text: 'Boiler', isDone: false, timeOfCompletion: 0, updatedAt: 1 }
    assert.deepEqual(visibleBuiltinSurfaceTypes([stray]), [DEFAULT_LIST_TYPE])
})
