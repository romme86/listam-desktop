import test from 'node:test'
import assert from 'node:assert/strict'
import { createSurfaceDomState } from '../src/ui/surface-dom-state.mjs'

const DRAWER_SCROLL = '.detail-split-scroll, .inspector-body'

function fakeField ({ tagName = 'INPUT', type = 'text', value = '', checked, id, placeholder } = {}) {
    return {
        tagName,
        type,
        value,
        ...(checked == null ? {} : { checked }),
        ...(id == null ? {} : { id }),
        ...(placeholder == null ? {} : { placeholder }),
        selectionStart: value.length,
        selectionEnd: value.length,
        focusCount: 0,
        focus () { this.focusCount += 1 },
        setSelectionRange (start, end) { this.selectionStart = start; this.selectionEnd = end },
    }
}

function fakeRichField () {
    return {
        tagName: 'DIV',
        isContentEditable: true,
        focusCount: 0,
        focus () { this.focusCount += 1 },
    }
}

function fakeHost ({ fields = [], focused = null, scrollTops = [0] } = {}) {
    const regions = scrollTops.map((scrollTop) => ({ scrollTop }))
    return {
        fields,
        regions,
        querySelectorAll: (selector) => selector.startsWith('input') ? fields : regions,
        contains: (element) => fields.includes(element) || regions.includes(element),
        ownerDocument: { activeElement: focused },
    }
}

test('a same-item drawer rebuild keeps the focused value, caret and scroll', () => {
    const dom = createSurfaceDomState({ scrollSelector: DRAWER_SCROLL })
    const typing = fakeField({ value: 'half typed' })
    typing.selectionStart = 4
    typing.selectionEnd = 7
    const before = fakeHost({ fields: [typing], focused: typing, scrollTops: [420] })
    dom.commit('ticket:default:a')

    const snapshot = dom.capture(before, 'ticket:default:a')
    const rebuilt = fakeField({ value: 'canonical' })
    const after = fakeHost({ fields: [rebuilt], scrollTops: [0] })
    dom.commit('ticket:default:a')
    dom.restore(after, snapshot)

    assert.equal(rebuilt.value, 'half typed')
    assert.equal(rebuilt.focusCount, 1)
    assert.deepEqual([rebuilt.selectionStart, rebuilt.selectionEnd], [4, 7])
    assert.equal(after.regions[0].scrollTop, 420)
})

test('an unfocused drawer field follows canonical state', () => {
    const dom = createSurfaceDomState({ scrollSelector: DRAWER_SCROLL })
    dom.commit('ticket:default:a')
    const snapshot = dom.capture(fakeHost({ fields: [fakeField({ value: 'old' })] }), 'ticket:default:a')
    const rebuilt = fakeField({ value: 'from peer' })
    dom.commit('ticket:default:a')
    dom.restore(fakeHost({ fields: [rebuilt] }), snapshot)

    assert.equal(rebuilt.value, 'from peer')
    assert.equal(rebuilt.focusCount, 0)
})

test('switching item, switching surface, or closing never carries focus', () => {
    const dom = createSurfaceDomState({ scrollSelector: DRAWER_SCROLL })
    const focused = fakeField({ value: 'draft' })
    const host = fakeHost({ fields: [focused], focused })
    dom.commit('ticket:default:a')

    assert.equal(dom.capture(host, 'ticket:default:b'), null)
    assert.equal(dom.capture(host, 'inspector:default:a'), null)
    dom.clear()
    assert.equal(dom.capture(host, 'ticket:default:a'), null)
})

test('contenteditable focus is restored synchronously through its caret hook', () => {
    const dom = createSurfaceDomState({ scrollSelector: DRAWER_SCROLL })
    const rich = fakeRichField()
    dom.commit('ticket:default:a')
    const snapshot = dom.capture(fakeHost({ fields: [rich], focused: rich }), 'ticket:default:a')
    const rebuilt = fakeRichField()
    let caretTarget = null
    dom.commit('ticket:default:a')
    dom.restore(fakeHost({ fields: [rebuilt] }), snapshot, {
        restoreContentEditable: (field) => { caretTarget = field },
    })

    assert.equal(rebuilt.focusCount, 1)
    assert.equal(caretTarget, rebuilt)
})

test('a focused checkbox keeps its in-progress checked state', () => {
    const dom = createSurfaceDomState({ scrollSelector: DRAWER_SCROLL })
    const checkbox = fakeField({ type: 'checkbox', checked: true })
    dom.commit('ticket:default:a')
    const snapshot = dom.capture(fakeHost({ fields: [checkbox], focused: checkbox }), 'ticket:default:a')
    const rebuilt = fakeField({ type: 'checkbox', checked: false })
    dom.commit('ticket:default:a')
    dom.restore(fakeHost({ fields: [rebuilt] }), snapshot)

    assert.equal(rebuilt.checked, true)
    assert.equal(rebuilt.focusCount, 1)
})

// --- the main pane -------------------------------------------------------
// Same machinery, no scroll container: the main pane scrolls the document.

test('a background re-render of the same pane keeps the field being typed into', () => {
    const dom = createSurfaceDomState()
    // The leaf-bridge port on the Peers pane: a presence heartbeat or a peer
    // count change rebuilds the pane every few seconds while it is open.
    const typing = fakeField({ type: 'number', value: '9995' })
    dom.commit('peers:null:false')
    const snapshot = dom.capture(fakeHost({ fields: [typing], focused: typing }), 'peers:null:false')

    const rebuilt = fakeField({ type: 'number', value: '9993' })
    dom.commit('peers:null:false')
    dom.restore(fakeHost({ fields: [rebuilt] }), snapshot)

    assert.equal(rebuilt.value, '9995')
    assert.equal(rebuilt.focusCount, 1)
})

test('a pane with no scroll container captures no scroll offsets', () => {
    const dom = createSurfaceDomState()
    const typing = fakeField({ value: 'code' })
    dom.commit('peers:null:false')
    const snapshot = dom.capture(fakeHost({ fields: [typing], focused: typing, scrollTops: [77] }), 'peers:null:false')

    assert.deepEqual(snapshot.scrollTops, [])
    // And restoring must not touch the regions it never captured.
    const after = fakeHost({ fields: [fakeField({ value: 'x' })], scrollTops: [0] })
    dom.commit('peers:null:false')
    dom.restore(after, snapshot)
    assert.equal(after.regions[0].scrollTop, 0)
})

test('switching pane drops the draft instead of pasting it into the next pane', () => {
    const dom = createSurfaceDomState()
    const typing = fakeField({ value: 'half typed' })
    const host = fakeHost({ fields: [typing], focused: typing })
    dom.commit('peers:null:false')

    assert.equal(dom.capture(host, 'lists:default:false'), null)
})

// Field identity inside a surface is positional, and a peer can change the shape
// of a pane while you type — a new list section, a server row, an item added
// remotely. Restoring by index alone would then paste the draft into a stranger.
test('a field that changed identity at that index does not inherit the draft', () => {
    const dom = createSurfaceDomState()
    const code = fakeField({ value: 'invite-code', placeholder: 'Pairing code' })
    dom.commit('peers:null:false')
    const snapshot = dom.capture(fakeHost({ fields: [code], focused: code }), 'peers:null:false')

    // A section above it appeared, so index 0 is now somebody else's field.
    const stranger = fakeField({ value: '', placeholder: 'Wi-Fi passphrase' })
    dom.commit('peers:null:false')
    dom.restore(fakeHost({ fields: [stranger] }), snapshot)

    assert.equal(stranger.value, '')
    assert.equal(stranger.focusCount, 0)
})
