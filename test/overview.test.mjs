import test from 'node:test'
import assert from 'node:assert/strict'
import { buildItemPlanEntry, buildListPlanEntry } from '@listam/domain/plan'
import { createOverviewSection } from '../src/ui/overview.mjs'

// A small event/element harness exercises the actual rendered controls. Native
// pointer-to-drag recognition still belongs to the browser smoke check.
class Element {
    nodeType = 1
    children = []
    attrs = {}
    dataset = {}
    events = {}
    className = ''
    classList = {
        add: (...names) => { this.className += ` ${names.join(' ')}` },
        remove: (...names) => { this.className = this.className.split(' ').filter((s) => !names.includes(s)).join(' ') },
        toggle: (name, on) => on ? this.classList.add(name) : this.classList.remove(name),
    }
    constructor(tag) { this.tagName = tag.toUpperCase() }
    setAttribute(key, value) { this.attrs[key] = value }
    addEventListener(name, fn) { this.events[name] = fn }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node) } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes) }
    findAll(cls) { return [this, ...this.children.flatMap((child) => child.findAll(cls))].filter((el) => el.className.split(' ').includes(cls)) }
    fire(name, props = {}) {
        let stopped = false
        const event = { target: this, detail: 1, preventDefault() {}, stopPropagation() { stopped = true }, ...props }
        for (let current = this; current; current = current.parent) {
            event.currentTarget = current
            current.events[name]?.(event)
            if (stopped) break
        }
    }
}

function overview(t, view = 'focus', listType = 'todo') {
    t.mock.method(globalThis, 'queueMicrotask', () => {})
    const previous = globalThis.document
    globalThis.document = {
        createElement: (tag) => new Element(tag),
        createElementNS: (_, tag) => new Element(tag),
        createTextNode: (text) => Object.assign(new Element('#text'), { text }),
    }
    t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous })
    const main = new Element('main')
    const now = new Date(2026, 8, 8).getTime()
    const items = ['today', 'next', 'carry', 'done'].map((id) => ({ id, listId: 'default', listType, text: id, status: id === 'done' ? 'done' : 'todo', isDone: id === 'done', updatedAt: 1 }))
    const state = { preferences: { overviewView: view }, items: [
        ...items,
        ...items.map((item, i) => buildItemPlanEntry({ listId: item.listId, itemId: item.id, plannedFor: item.id === 'carry' ? '2026-09-07' : '2026-09-08', planOrder: i, updatedAt: 2 })),
        buildListPlanEntry({ listId: 'default', listType: 'todo', plannedFor: '2026-09-07', planOrder: 4, updatedAt: 2 }),
    ] }
    const opened = []
    const moved = []
    const reordered = []
    const toggled = []
    const ticketsMoved = []
    const ui = { weekOffset: 0 }
    createOverviewSection({
        main, store: { getState: () => state }, locale: { i18n: { t: (key) => key } }, ui,
        actions: {
            movePlanToDay: (...args) => moved.push(args),
            reorderPlanRecords: (...args) => reordered.push(args),
            toggleItem: (item) => toggled.push(item),
            moveTicket: (...args) => ticketsMoved.push(args),
        },
        now: () => now, renderAll() {}, openDialog: (draft) => opened.push(draft), selectSurface() {},
        builtinDisplayName: () => 'Todo', typePredicate: () => () => true, iconForType: () => 'list',
        dropBefore: () => true, valueBadges: () => [], beacon: () => null,
    }).renderOverviewPane(state)
    return { main, ui, opened, moved, reordered, toggled, ticketsMoved }
}

test('planner week controls complete and reopen source items without selecting the day', (t) => {
    const { main, ui, toggled } = overview(t, 'planner')
    const controls = main.findAll('plan-week-check')
    assert.equal(controls.length, 3)
    assert.deepEqual(controls.map((el) => el.attrs['aria-pressed']), ['false', 'false', 'true'])
    for (const control of controls) {
        assert.equal(control.tagName, 'BUTTON')
        control.fire('click')
    }
    assert.deepEqual(toggled.map((item) => item.id), ['today', 'next', 'done'])
    assert.equal(ui.planDate, undefined)
    main.findAll('plan-week-row')[0].fire('click')
    assert.equal(ui.planDate, '2026-09-08', 'clicking the rest of a row still selects its day')
})

test('planner week controls route board completion and reopening through status changes', (t) => {
    const { main, toggled, ticketsMoved } = overview(t, 'planner', 'board')
    const controls = main.findAll('plan-week-check')
    controls[0].fire('click')
    controls[2].fire('click')
    assert.equal(toggled.length, 0)
    assert.deepEqual(ticketsMoved.map(([item, status]) => [item.id, status]), [['today', 'done'], ['done', 'todo']])
})

for (const view of ['focus', 'planner']) {
    test(`every ${view} agenda handle opens a date calendar for its own ref`, (t) => {
        const { main, opened } = overview(t, view)
        const grips = main.findAll('plan-grip')
        assert.equal(grips.length, 5, 'includes a whole list, carried item, spotlight, next-up and done item')
        for (const grip of grips) {
            assert.equal(grip.tagName, 'BUTTON')
            assert.equal(grip.attrs['aria-haspopup'], 'dialog')
            grip.fire('click')
            assert.equal(opened.at(-1).kind, 'plan-move')
            assert.equal(opened.at(-1).ref, grip.dataset.planRef)
        }
        assert.equal(opened.find((d) => d.label === 'carry').dateKey, '2026-09-07')
    })
}

test('dragging a handle moves its entry and suppresses a trailing click; a fresh click still opens', (t) => {
    const { main, ui, opened, moved } = overview(t)
    const grip = main.findAll('plan-grip')[0]
    const dataTransfer = { setData() {} }
    grip.fire('pointerdown')
    grip.fire('dragstart', { dataTransfer })
    assert.equal(ui.planDrag.ref, grip.dataset.planRef)
    assert.equal(dataTransfer.effectAllowed, 'move')
    main.findAll('plan-pill')[6].fire('drop')
    grip.fire('dragend')
    grip.fire('click')
    assert.deepEqual(moved, [[grip.dataset.planRef, '2026-09-14']])
    assert.equal(ui.planDrag, null)
    assert.equal(opened.length, 0)
    grip.fire('pointerdown')
    grip.fire('click')
    assert.equal(opened.length, 1)
})

test('whole-row reordering and keyboard activation survive the clickable handle', (t) => {
    const { main, opened, reordered } = overview(t)
    const grips = main.findAll('plan-grip')
    const source = grips.find((el) => el.dataset.planRef.endsWith('::next'))
    const target = grips.find((el) => el.dataset.planRef.endsWith('::today'))
    source.parent.fire('dragstart', { dataTransfer: { setData() {} } })
    target.parent.fire('drop')
    source.parent.fire('dragend')
    assert.equal(reordered.length, 1)
    assert.deepEqual(reordered[0].slice(1), [1, 0])
    source.fire('click', { detail: 0 })
    assert.equal(opened[0].ref, source.dataset.planRef)
})
