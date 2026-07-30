// The dialog's DOM-owned state (scroll offset + focused field) across a rebuild.
//
// Worth testing rather than eyeballing: the bug this fixes was invisible in every
// existing gate. Nothing here needs a real DOM — the module touches four DOM
// methods, so a fake host drives it honestly in node — and the failure mode is
// an ORDERING mistake (capture after the swap, or restore before it), which reads
// as correct code and silently does nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDialogDomState } from '../src/ui/dialog-dom-state.mjs'

// A dialog host standing in for `dialogHost`: querySelector for the scroll body,
// querySelectorAll for the positional field list, contains + activeElement for
// "is the focus actually inside this dialog".
function fakeHost ({ scrollTop = 0, fields = [], focused = null } = {}) {
    const body = { scrollTop }
    const host = {
        body,
        fields,
        querySelector: (sel) => (sel === '.dialog-body' ? host.body : null),
        querySelectorAll: () => host.fields,
        contains: (el) => host.fields.includes(el) || el === host.body,
        ownerDocument: { activeElement: focused },
    }
    return host
}

function fakeField ({ tagName = 'INPUT', type = 'text', value = '' } = {}) {
    return {
        tagName,
        type,
        value,
        selectionStart: value.length,
        selectionEnd: value.length,
        focusCount: 0,
        focus () { this.focusCount += 1 },
        setSelectionRange (start, end) { this.selectionStart = start; this.selectionEnd = end },
    }
}

test('a same-kind rebuild carries the scroll offset across', () => {
    const dom = createDialogDomState()
    const before = fakeHost({ scrollTop: 900 })
    dom.commit('settings')

    const snapshot = dom.capture(before, 'settings')
    // The rebuild: a brand-new subtree, scrolled to the top like any fresh DOM.
    const after = fakeHost({ scrollTop: 0 })
    dom.commit('settings')
    dom.restore(after, snapshot)

    assert.equal(after.body.scrollTop, 900, 'the dialog snapped back to the top')
})

test('the FIRST render of a dialog carries nothing — there is no earlier state to keep', () => {
    const dom = createDialogDomState()
    assert.equal(dom.capture(fakeHost({ scrollTop: 900 }), 'settings'), null)
})

test('switching to a different dialog kind carries nothing', () => {
    // A scroll offset (or a caret) from Settings is meaningless in the dialog that
    // replaced it, and restoring it would scroll a short dialog for no reason.
    const dom = createDialogDomState()
    dom.commit('settings')
    assert.equal(dom.capture(fakeHost({ scrollTop: 900 }), 'backup'), null)
})

test('closing the dialog resets, so reopening starts at the top', () => {
    const dom = createDialogDomState()
    dom.commit('settings')
    dom.clear()
    assert.equal(dom.capture(fakeHost({ scrollTop: 900 }), 'settings'), null)
})

test('a focused field keeps its focus, its half-typed value and its caret', () => {
    const dom = createDialogDomState()
    const typing = fakeField({ value: 'kitchen-ma' })
    typing.selectionStart = 7
    typing.selectionEnd = 7
    const before = fakeHost({ scrollTop: 40, fields: [typing], focused: typing })
    dom.commit('settings')

    const snapshot = dom.capture(before, 'settings')
    // The rebuild reads the field's value from the store, so the in-progress text
    // is gone from the new node — which is exactly the loss being repaired.
    const rebuilt = fakeField({ value: 'kitchen' })
    const after = fakeHost({ scrollTop: 0, fields: [rebuilt] })
    dom.commit('settings')
    dom.restore(after, snapshot)

    assert.equal(rebuilt.value, 'kitchen-ma', 'half-typed text was thrown away')
    assert.equal(rebuilt.focusCount, 1, 'focus was not restored')
    assert.deepEqual([rebuilt.selectionStart, rebuilt.selectionEnd], [7, 7], 'the caret jumped')
})

test('an UNFOCUSED field is left alone, so a backend update is not clobbered by a stale draft', () => {
    const dom = createDialogDomState()
    const idle = fakeField({ value: 'old-name' })
    const before = fakeHost({ scrollTop: 40, fields: [idle], focused: null })
    dom.commit('settings')

    const snapshot = dom.capture(before, 'settings')
    const rebuilt = fakeField({ value: 'name-from-a-peer' })
    const after = fakeHost({ fields: [rebuilt] })
    dom.commit('settings')
    dom.restore(after, snapshot)

    assert.equal(rebuilt.value, 'name-from-a-peer', 'a value nobody was typing into overwrote a synced one')
    assert.equal(rebuilt.focusCount, 0, 'focus was stolen by a field the user had left')
})

test('focus outside the dialog is not dragged into it', () => {
    // The add-bar behind the backdrop, a rail row — a rebuild must not steal focus
    // from whatever legitimately holds it elsewhere in the app.
    const dom = createDialogDomState()
    const outside = fakeField({ value: 'milk' })
    const inside = fakeField({ value: '' })
    const before = fakeHost({ fields: [inside], focused: outside })
    dom.commit('settings')

    const snapshot = dom.capture(before, 'settings')
    assert.equal(snapshot.fieldIndex, -1)
    const rebuilt = fakeField({ value: '' })
    dom.restore(fakeHost({ fields: [rebuilt] }), snapshot)
    assert.equal(rebuilt.focusCount, 0)
})

test('a checkbox is never treated as a caret-bearing field', () => {
    // Reading selectionStart off a checkbox yields null and WRITING it throws, so
    // a switch row (Settings has several) must not be captured as a text field.
    const dom = createDialogDomState()
    const box = { tagName: 'INPUT', type: 'checkbox', checked: true }
    const before = fakeHost({ fields: [box], focused: box })
    dom.commit('settings')

    const snapshot = dom.capture(before, 'settings')
    assert.equal(snapshot.fieldIndex, -1)
})

test('a field that vanished from the rebuild is skipped rather than throwing', () => {
    // Sections appear and disappear in Settings (owner-only flatten, the backup
    // list), so the captured index can outlive the field it pointed at.
    const dom = createDialogDomState()
    const gone = fakeField({ value: 'x' })
    const before = fakeHost({ scrollTop: 120, fields: [gone, fakeField()], focused: null })
    dom.commit('settings')
    const snapshot = dom.capture(before, 'settings')
    snapshot.fieldIndex = 5

    const after = fakeHost({ fields: [] })
    dom.commit('settings')
    assert.doesNotThrow(() => dom.restore(after, snapshot))
    assert.equal(after.body.scrollTop, 120, 'the scroll restore must not be lost with the field')
})

test('restoring a caret on a type that stopped supporting selection does not throw', () => {
    const dom = createDialogDomState()
    const field = fakeField({ value: 'abc' })
    const before = fakeHost({ fields: [field], focused: field })
    dom.commit('settings')
    const snapshot = dom.capture(before, 'settings')

    const hostile = fakeField({ value: 'abc' })
    hostile.setSelectionRange = () => { throw new Error('InvalidStateError') }
    dom.commit('settings')
    assert.doesNotThrow(() => dom.restore(fakeHost({ fields: [hostile] }), snapshot))
    assert.equal(hostile.focusCount, 1, 'focus must survive a failed caret restore')
})
