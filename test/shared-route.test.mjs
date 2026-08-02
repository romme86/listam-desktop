import test from 'node:test'
import assert from 'node:assert/strict'
import { adoptSharedListRoute } from '../src/ui/shared-route.mjs'

test('a selected named list adopts its shared base immediately after sharing', () => {
    const ui = { activeListId: 'spesa-2', activeBaseKey: null }
    const result = { ok: true, listId: 'spesa-2', baseKey: 'ab'.repeat(32) }

    assert.equal(adoptSharedListRoute(ui, { sourceListId: 'spesa-2', result }), true)
    assert.equal(ui.activeBaseKey, result.baseKey)
})

test('a share reply cannot reroute a different selected list', () => {
    const ui = { activeListId: 'work', activeBaseKey: 'old-route' }

    assert.equal(adoptSharedListRoute(ui, {
        sourceListId: 'spesa-2',
        result: { ok: true, baseKey: 'ab'.repeat(32) },
    }), false)
    assert.equal(ui.activeBaseKey, 'old-route')
})

test('a failed or incomplete share reply leaves the current route alone', () => {
    const ui = { activeListId: 'spesa-2', activeBaseKey: null }

    assert.equal(adoptSharedListRoute(ui, {
        sourceListId: 'spesa-2',
        result: { ok: false },
    }), false)
    assert.equal(ui.activeBaseKey, null)
})
