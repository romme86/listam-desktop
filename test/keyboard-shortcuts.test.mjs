import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldHandleAppShortcut, isTypingTarget, isTypingKeystroke } from '../src/ui/keyboard-shortcuts.mjs'

const el = (tagName, extra = {}) => ({ tagName, ...extra })

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

test('every kind of field counts as typing, and nothing else does', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'input', 'select']) {
        assert.equal(isTypingTarget(el(tag)), true, tag)
    }
    // The WYSIWYG block editors, including a node nested inside the editable host.
    assert.equal(isTypingTarget(el('DIV', { isContentEditable: true })), true)
    assert.equal(isTypingTarget(el('SPAN', { isContentEditable: true })), true)

    assert.equal(isTypingTarget(el('BODY')), false)
    assert.equal(isTypingTarget(el('DIV')), false)
    assert.equal(isTypingTarget(el('BUTTON')), false)
    // A list row: focusable, and the surface the arrow/flag shortcuts act on.
    assert.equal(isTypingTarget(el('DIV', { isContentEditable: false })), false)
    // Not elements at all — `document`, a text node, a detached null.
    assert.equal(isTypingTarget({}), false)
    assert.equal(isTypingTarget(null), false)
    assert.equal(isTypingTarget(undefined), false)
})

// The renderer rebuilds surfaces wholesale, so a background re-render can detach
// the field mid-word: the keystroke is retargeted to <body> while focus is
// already restored on the rebuilt field. Reading only event.target there turned
// the next character into a shortcut — t flipped the theme, [ ] left the pane.
test('a keystroke retargeted to body while a field holds focus is still typing', () => {
    assert.equal(isTypingKeystroke({ target: el('BODY') }, el('INPUT')), true)
    assert.equal(isTypingKeystroke({ target: el('INPUT') }, el('BODY')), true)
    assert.equal(isTypingKeystroke({ target: el('INPUT') }, el('INPUT')), true)
})

test('a keystroke with no field on either side stays a shortcut', () => {
    assert.equal(isTypingKeystroke({ target: el('DIV') }, el('BODY')), false)
    assert.equal(isTypingKeystroke({ target: el('BODY') }, null), false)
    assert.equal(isTypingKeystroke({}, undefined), false)
})
