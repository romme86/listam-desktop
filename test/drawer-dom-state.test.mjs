import test from 'node:test'
import assert from 'node:assert/strict'
import { createDrawerDomState } from '../src/ui/drawer-dom-state.mjs'

function fakeField ({ tagName = 'INPUT', type = 'text', value = '', checked } = {}) {
    return {
        tagName,
        type,
        value,
        ...(checked == null ? {} : { checked }),
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
    const dom = createDrawerDomState()
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
    const dom = createDrawerDomState()
    dom.commit('ticket:default:a')
    const snapshot = dom.capture(fakeHost({ fields: [fakeField({ value: 'old' })] }), 'ticket:default:a')
    const rebuilt = fakeField({ value: 'from peer' })
    dom.commit('ticket:default:a')
    dom.restore(fakeHost({ fields: [rebuilt] }), snapshot)

    assert.equal(rebuilt.value, 'from peer')
    assert.equal(rebuilt.focusCount, 0)
})

test('switching item, switching surface, or closing never carries focus', () => {
    const dom = createDrawerDomState()
    const focused = fakeField({ value: 'draft' })
    const host = fakeHost({ fields: [focused], focused })
    dom.commit('ticket:default:a')

    assert.equal(dom.capture(host, 'ticket:default:b'), null)
    assert.equal(dom.capture(host, 'inspector:default:a'), null)
    dom.clear()
    assert.equal(dom.capture(host, 'ticket:default:a'), null)
})

test('contenteditable focus is restored synchronously through its caret hook', () => {
    const dom = createDrawerDomState()
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
    const dom = createDrawerDomState()
    const checkbox = fakeField({ type: 'checkbox', checked: true })
    dom.commit('ticket:default:a')
    const snapshot = dom.capture(fakeHost({ fields: [checkbox], focused: checkbox }), 'ticket:default:a')
    const rebuilt = fakeField({ type: 'checkbox', checked: false })
    dom.commit('ticket:default:a')
    dom.restore(fakeHost({ fields: [rebuilt] }), snapshot)

    assert.equal(rebuilt.checked, true)
    assert.equal(rebuilt.focusCount, 1)
})
