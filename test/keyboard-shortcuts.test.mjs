import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldHandleAppShortcut } from '../src/ui/keyboard-shortcuts.mjs'

test('an open drawer suspends every app-wide shortcut', () => {
    assert.equal(shouldHandleAppShortcut({ drawerOpen: true }), false)
    assert.equal(shouldHandleAppShortcut({ drawerOpen: true, commandPaletteKey: true }), false)
})

test('typing and dialogs keep their existing shortcut protection', () => {
    assert.equal(shouldHandleAppShortcut({ typingTarget: true }), false)
    assert.equal(shouldHandleAppShortcut({ dialogOpen: true }), false)
})

test('the command palette remains global when no drawer is open', () => {
    assert.equal(shouldHandleAppShortcut({ typingTarget: true, commandPaletteKey: true }), true)
    assert.equal(shouldHandleAppShortcut({ dialogOpen: true, commandPaletteKey: true }), true)
})

test('ordinary app shortcuts still work on the main surface', () => {
    assert.equal(shouldHandleAppShortcut(), true)
})
