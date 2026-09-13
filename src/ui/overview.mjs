// Overview and day-plan rendering.
//
// Extracted from ui.mjs as a self-contained renderer factory. The dependency
// boundary is explicit because the desktop renderer is plain browser ESM with
// no bundling step, and because navigation/actions remain owned by mountApp.
import { DEFAULT_LIST_ID } from '@listam/domain/identity'
import { reduceRegistry } from '@listam/domain/list-registry'
import { reduceSurfaceLabels } from '@listam/domain/labels'
import {
    VALUE_MAX,
    summarizeValue,
    aggregateCompletedValuePerDay,
    valueStatsForPeriod,
} from '@listam/domain/value'
import {
    reducePlan,
    groupPlanByDate,
    overduePlanRecords,
    toDateKey,
    shiftDateKey,
} from '@listam/domain/plan'
import { h, replaceChildren } from '../dom.mjs'
import { tablerIcon } from '../icons.mjs'
import { selectSummary } from '../store.mjs'
import { isBoardType, selectBoardConfig, doneStatusesOf } from '../ticket.mjs'

/**
 * Build the Overview renderer while keeping navigation and writes in mountApp.
 * Calendar dialogs and plan writes stay owned by mountApp.
 */
export function createOverviewSection ({
    main,
    store,
    locale,
    ui,
    actions,
    now,
    renderAll,
    openDialog,
    selectSurface,
    builtinDisplayName,
    typePredicate,
    iconForType,
    dropBefore,
    valueBadges,
    beacon,
}) {
    // --- Overview (the cross-list day plan) ---------------------------------
    // A read-only aggregation: items/lists flagged into a day (the synced plan
    // channel) joined back to their live source items. Marking done / editing a
    // row writes through to the SOURCE item; list-cards open their list and clear
    // from the plan when checked. Two layouts: Focus (spotlight + today) and
    // Planner (today agenda + a week rail). Calendar events are out of v1.
    function openSurfaceById(listId, type) {
        selectSurface(store.getState(), { listId, type })
    }
    function parsePlanKey(key) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '')
        return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(now())
    }
    function planSurfaceName(listId, type, registry, surfaceLabels) {
        if (listId === DEFAULT_LIST_ID) return builtinDisplayName(type, surfaceLabels)
        return registry.lists.find((l) => l.id === listId)?.name || listId
    }
    function renderOverviewPane(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const reduced = reducePlan(state.items)
        const byDate = groupPlanByDate(reduced)
        const registry = reduceRegistry(state.items)
        const surfaceLabels = reduceSurfaceLabels(state.items)
        const byKey = new Map()
        for (const it of state.items) byKey.set(`${it.listId}::${it.id}`, it)

        // Board tickets track "done" via status, not isDone — route their overview
        // checkbox through a board status change so the source column updates too.
        const boardConfig = selectBoardConfig(state)
        const boardDone = new Set(doneStatusesOf(boardConfig))
        const firstDoneStatus = doneStatusesOf(boardConfig)[0] || 'done'
        const firstOpenStatus = (boardConfig.states || []).map((s) => s.id).find((id) => !boardDone.has(id)) || 'todo'
        const isItemDone = (item) => (isBoardType(item.listType) ? (item.isDone || boardDone.has(item.status)) : !!item.isDone)
        const toggleItemDone = (item) => {
            if (isBoardType(item.listType)) actions.moveTicket(item, isItemDone(item) ? firstOpenStatus : firstDoneStatus)
            else actions.toggleItem(item)
        }

        const today = toDateKey(now())
        const tomorrowKey = shiftDateKey(today, 1)
        // The strip pages a week at a time; weekOffset 0 starts on today, negative
        // pages into the past, positive into the future.
        const anchor = shiftDateKey(today, ui.weekOffset * 7)
        const week = Array.from({ length: 7 }, (_, i) => shiftDateKey(anchor, i))
        // Keep the selected day within the visible week; fall back to today when
        // it's on-screen, else the first pill of the paged week.
        const selected = (ui.planDate && week.includes(ui.planDate))
            ? ui.planDate
            : (week.includes(today) ? today : week[0])
        const view = ['planner', 'value'].includes(state.preferences.overviewView) ? state.preferences.overviewView : 'focus'

        // Resolve a plan record to a renderable row, dropping dangling item refs.
        const resolve = (rec) => {
            if (rec.kind === 'list') {
                const scoped = state.items.filter((it) => it.listId === rec.refListId && typePredicate(rec.refType)(it))
                return {
                    rec,
                    kind: 'list',
                    listId: rec.refListId,
                    listType: rec.refType,
                    label: planSurfaceName(rec.refListId, rec.refType, registry, surfaceLabels),
                    count: selectSummary(scoped).remaining,
                }
            }
            const src = byKey.get(`${rec.refListId}::${rec.refItemId}`)
            if (!src) return null
            return {
                rec,
                kind: 'item',
                item: src,
                done: isItemDone(src),
                label: src.text,
                chip: planSurfaceName(rec.refListId, src.listType, registry, surfaceLabels),
            }
        }
        const resolveDay = (dateKey) => (byDate.get(dateKey) || []).map(resolve).filter(Boolean)
        // Derived carryover: entries parked on a past day that aren't done yet
        // surface under Today in their shared manual order. Their plannedFor is
        // retained while reordering, so origin badges remain accurate. Completing
        // writes through to the source; "move to today" (below) re-homes the entry
        // for real if the user wants it off the past.
        const carried = overduePlanRecords(reduced, today)
            .map(resolve)
            .filter(Boolean)
            .filter((r) => !r.done)
            // The carry-over tray is one reorderable collection even though its
            // records retain different origin dates. planOrder is therefore the
            // primary display key here; origin date remains a deterministic tie
            // breaker for trays that have never been manually ordered.
            .sort((a, b) => (
                (a.rec.planOrder - b.rec.planOrder) ||
                a.rec.plannedFor.localeCompare(b.rec.plannedFor) ||
                a.rec.ref.localeCompare(b.rec.ref)
            ))

        // Value rollups for the plan strip / rail: sum value + average delay over
        // the rated single items planned into a day (list-cards have no rate).
        const dayValueItems = (dateKey) => resolveDay(dateKey).filter((r) => r.kind === 'item').map((r) => r.item)
        const fmtAvg = (n) => String(Math.round(n * 10) / 10)
        const valueRollup = (summary) => summary.count === 0 ? null : h('span', { class: 'value-rollup label-sm', title: `${t('value.value')} · ${t('value.delay')}` },
            tablerIcon('coins', { size: 12 }), String(summary.totalValue),
            tablerIcon('hourglass', { size: 12 }), fmtAvg(summary.avgDelay))
        const weekValueBar = (() => {
            const roll = valueRollup(summarizeValue(week.flatMap(dayValueItems)))
            return roll ? h('div', { class: 'plan-weekbar' }, roll) : null
        })()

        // Every plan row is a drag SOURCE: dropping it onto a day pill (the strip)
        // or a week column re-plans it to that day (movePlanToDay). This is what
        // makes single-item days, done rows, and carried-over rows movable — not
        // only the multi-row days that also support reordering.
        const planControls = (resolved) => {
            const rec = resolved.rec
            let dragged = false
            const grip = h('button', {
                type: 'button', class: 'plan-grip', draggable: 'true',
                'aria-label': t('plan.pickDate'), title: t('plan.planFor'),
                'aria-haspopup': 'dialog', dataset: { planRef: rec.ref },
                onpointerdown: () => { dragged = false },
                onclick: (event) => {
                    event.stopPropagation()
                    if (dragged && event.detail !== 0) return
                    openDialog({ kind: 'plan-move', ref: rec.ref, label: resolved.label, dateKey: rec.plannedFor, month: rec.plannedFor.slice(0, 7),
                        onClose: () => queueMicrotask(() => {
                            const handle = [...main.querySelectorAll('.plan-grip')].find((el) => el.dataset.planRef === rec.ref)
                            handle?.focus({ preventScroll: true })
                        }),
                    })
                },
            }, tablerIcon('grip-vertical', { size: 14 }))
            return { grip, dnd: {
                draggable: 'true',
                ondragstart: (event) => {
                    dragged = true
                    ui.planDrag = { ref: rec.ref, fromDate: rec.plannedFor }
                    event.dataTransfer.effectAllowed = 'move'
                    try { event.dataTransfer.setData('text/plain', rec.ref) } catch { /* some platforms reject */ }
                    event.currentTarget.classList.add('dragging')
                    event.stopPropagation()
                },
                ondragend: (event) => { event.currentTarget.classList.remove('dragging', 'drop-before', 'drop-after'); ui.planDrag = null },
            } }
        }
        // A plan row can be a drop target for either an ordered collection (the
        // carry-over tray, whose records retain different origin dates) or one
        // day's agenda. Dropping across days inserts at the indicated row,
        // whereas dropping within the same collection only changes planOrder.
        const planReorderTarget = (rec, orderedRecords, index, { collection = false } = {}) => ({
            ondragover: (event) => {
                const d = ui.planDrag
                if (!d || d.ref === rec.ref) return
                if (collection && !orderedRecords.some((r) => r.ref === d.ref)) return
                event.preventDefault(); event.stopPropagation()
                const before = dropBefore(event, 'y')
                event.currentTarget.classList.toggle('drop-before', before)
                event.currentTarget.classList.toggle('drop-after', !before)
            },
            ondragleave: (event) => { event.currentTarget.classList.remove('drop-before', 'drop-after') },
            ondrop: (event) => {
                const d = ui.planDrag
                event.currentTarget.classList.remove('drop-before', 'drop-after')
                if (!d || d.ref === rec.ref) return
                if (collection && !orderedRecords.some((r) => r.ref === d.ref)) return
                event.preventDefault(); event.stopPropagation()
                ui.planDrag = null
                const before = dropBefore(event, 'y')
                const insertAt = before ? index : index + 1
                const fromIndex = orderedRecords.findIndex((r) => r.ref === d.ref)
                if (collection || d.fromDate === rec.plannedFor) {
                    if (fromIndex < 0) return
                    actions.reorderPlanRecords(orderedRecords, fromIndex, insertAt > fromIndex ? insertAt - 1 : insertAt)
                    return
                }
                actions.movePlanIntoDay(d.ref, rec.plannedFor, orderedRecords, insertAt)
            },
        })

        const planRow = (resolved, dayRecords, index, opts = {}) => {
            // Every row is a drag source (drop on a day pill/column to re-plan it to
            // another day) and a drop target, so a carry-over item can be inserted
            // before/after even when Today currently contains only one item.
            // The whole row remains draggable; clicking its grip opens the calendar.
            const records = Array.isArray(dayRecords) ? dayRecords : []
            const controls = planControls(resolved)
            const dnd = { ...controls.dnd, ...(records.length > 0 ? planReorderTarget(resolved.rec, records, index) : {}) }
            const { grip } = controls
            if (resolved.kind === 'list') {
                return h('div', { class: `plan-row plan-list-card${opts.spotlight ? ' spotlight' : ''}`, ...dnd },
                    grip,
                    h('button', {
                        class: 'plan-check',
                        'aria-label': t('plan.clearFromPlan'),
                        title: t('plan.clearFromPlan'),
                        onclick: () => actions.clearFromPlan(resolved.rec.ref),
                    }, tablerIcon('square', { size: opts.spotlight ? 22 : 18 })),
                    h('span', { class: 'glyph' }, tablerIcon(iconForType(resolved.listType), { size: 16 })),
                    h('span', { class: 'plan-text', onclick: () => openSurfaceById(resolved.listId, resolved.listType) }, resolved.label),
                    h('span', { class: 'plan-chip' }, t('plan.listItems', { count: resolved.count })),
                    h('button', {
                        class: 'plan-open',
                        'aria-label': t('plan.openList'),
                        onclick: () => openSurfaceById(resolved.listId, resolved.listType),
                    }, tablerIcon('chevron-right', { size: 16 })),
                )
            }
            const item = resolved.item
            if (ui.editingItemId === item.id) {
                const editInput = h('input', {
                    class: 'input',
                    value: item.text,
                    onkeydown: (event) => {
                        if (event.key === 'Enter') { actions.editItem(item, editInput.value); ui.editingItemId = null; renderAll() }
                        else if (event.key === 'Escape') { ui.editingItemId = null; renderAll() }
                    },
                    onblur: () => { ui.editingItemId = null; renderAll() },
                })
                queueMicrotask(() => editInput.focus())
                return h('div', { class: 'plan-row' }, editInput)
            }
            const done = isItemDone(item)
            return h('div', { class: `plan-row${done ? ' done' : ''}${opts.spotlight ? ' spotlight' : ''}`, ...dnd },
                grip,
                h('button', {
                    class: 'plan-check',
                    'aria-pressed': done ? 'true' : 'false',
                    'aria-label': t('main.item.toggle'),
                    onclick: () => toggleItemDone(item),
                }, tablerIcon(done ? 'square-check' : 'square', { size: opts.spotlight ? 22 : 18 })),
                h('span', { class: 'plan-text plan-text-open', title: t('plan.openList'), onclick: () => actions.openPlanItem(item) }, item.text),
                ...valueBadges(item),
                h('span', { class: 'plan-chip' }, resolved.chip),
                h('button', {
                    class: 'plan-remove',
                    'aria-label': t('plan.remove'),
                    title: t('plan.remove'),
                    onclick: () => actions.clearFromPlan(resolved.rec.ref),
                }, tablerIcon('x', { size: 14 })),
            )
        }

        // A carried-over row (shown only under Today): same check / open / clear
        // as a normal plan row, plus a badge for the past day it slipped from and
        // a one-click "move to today" shortcut. It's a drag source too, so a
        // slipped item can be dropped onto ANY day pill/column — not just today.
        // Its origin day stays intact while the tray's shared planOrder changes.
        const carryRow = (resolved, carryRecords, index) => {
            const rec = resolved.rec
            const controls = planControls(resolved)
            const dnd = {
                ...controls.dnd,
                ...(carryRecords.length > 1 ? planReorderTarget(rec, carryRecords, index, { collection: true }) : {}),
            }
            const { grip } = controls
            const badge = h('span', {
                class: 'plan-carry-badge label-sm',
                title: parsePlanKey(rec.plannedFor).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }),
            },
                tablerIcon('history', { size: 12 }),
                parsePlanKey(rec.plannedFor).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }),
            )
            const moveBtn = h('button', {
                class: 'plan-carry-move',
                'aria-label': t('plan.moveToToday'),
                title: t('plan.moveToToday'),
                onclick: () => actions.movePlanToDay(rec.ref, today),
            }, tablerIcon('calendar-up', { size: 16 }))
            if (resolved.kind === 'list') {
                return h('div', { class: 'plan-row plan-list-card plan-carry', ...dnd },
                    grip,
                    h('button', {
                        class: 'plan-check',
                        'aria-label': t('plan.clearFromPlan'),
                        title: t('plan.clearFromPlan'),
                        onclick: () => actions.clearFromPlan(rec.ref),
                    }, tablerIcon('square', { size: 18 })),
                    h('span', { class: 'glyph' }, tablerIcon(iconForType(resolved.listType), { size: 16 })),
                    h('span', { class: 'plan-text', onclick: () => openSurfaceById(resolved.listId, resolved.listType) }, resolved.label),
                    badge,
                    h('span', { class: 'plan-chip' }, t('plan.listItems', { count: resolved.count })),
                    moveBtn,
                    h('button', {
                        class: 'plan-open',
                        'aria-label': t('plan.openList'),
                        onclick: () => openSurfaceById(resolved.listId, resolved.listType),
                    }, tablerIcon('chevron-right', { size: 16 })),
                )
            }
            const item = resolved.item
            return h('div', { class: 'plan-row plan-carry', ...dnd },
                grip,
                h('button', {
                    class: 'plan-check',
                    'aria-pressed': 'false',
                    'aria-label': t('main.item.toggle'),
                    onclick: () => toggleItemDone(item),
                }, tablerIcon('square', { size: 18 })),
                h('span', { class: 'plan-text plan-text-open', title: t('plan.openList'), onclick: () => actions.openPlanItem(item) }, item.text),
                badge,
                ...valueBadges(item),
                h('span', { class: 'plan-chip' }, resolved.chip),
                moveBtn,
                h('button', {
                    class: 'plan-remove',
                    'aria-label': t('plan.remove'),
                    title: t('plan.remove'),
                    onclick: () => actions.clearFromPlan(rec.ref),
                }, tablerIcon('x', { size: 14 })),
            )
        }

        // One day's agenda: an optional carried-over tray (Today only), then the
        // spotlight (first pending) + next-up + a done tray.
        const dayAgenda = (dateKey) => {
            const rows = resolveDay(dateKey)
            // Carried-over work belongs to Today only; other days show just their own.
            const carriedHere = dateKey === today ? carried : []
            const pending = rows.filter((r) => !r.done)
            const done = rows.filter((r) => r.done)
            const pendingRecords = pending.map((r) => r.rec)
            if (rows.length === 0 && carriedHere.length === 0) {
                return h('div', { class: 'plan-empty' },
                    h('div', { class: 'plan-empty-icon' }, tablerIcon('flag', { size: 22 })),
                    h('p', { class: 'plan-empty-title' }, t('plan.empty.title')),
                    h('p', { class: 'label-md' }, t('plan.empty.hint')),
                    h('div', { class: 'plan-empty-tip label-sm' },
                        tablerIcon('flag', { size: 14 }),
                        h('span', {}, t('plan.flag')),
                        h('span', { class: 'plan-empty-tip-or' }, '·'),
                        h('kbd', {}, 'F'),
                    ),
                )
            }
            const parts = []
            if (carriedHere.length > 0) {
                parts.push(h('div', { class: 'plan-section-label plan-carry-label label-sm' },
                    tablerIcon('history', { size: 13 }),
                    h('span', {}, t('plan.carriedOver', { count: carriedHere.length })),
                ))
                const carryRecords = carriedHere.map((r) => r.rec)
                parts.push(h('div', { class: 'plan-rows plan-carry-rows' }, ...carriedHere.map((r, i) => carryRow(r, carryRecords, i))))
            }
            if (pending.length > 0) {
                parts.push(h('div', { class: 'plan-section-label label-sm' }, t('plan.now')))
                parts.push(h('div', { class: 'plan-spotlight-wrap' }, planRow(pending[0], pendingRecords, 0, { spotlight: true })))
                if (pending.length > 1) {
                    parts.push(h('div', { class: 'plan-section-label label-sm' }, t('plan.nextUp')))
                    parts.push(h('div', { class: 'plan-rows' }, ...pending.slice(1).map((r, i) => planRow(r, pendingRecords, i + 1))))
                }
            }
            if (done.length > 0) {
                parts.push(h('div', { class: 'plan-done-tray' },
                    h('span', { class: 'glyph done' }, tablerIcon('square-check', { size: 14 })),
                    h('span', { class: 'label-sm' }, t('plan.doneToday', { count: done.length })),
                ))
                parts.push(h('div', { class: 'plan-rows plan-done-rows' }, ...done.map((r) => planRow(r, [], 0))))
            }
            return h('div', {}, ...parts)
        }

        // The clickable + droppable day strip.
        const strip = h('div', { class: 'plan-strip' }, ...week.map((dk) => {
            const count = resolveDay(dk).length
            return h('button', {
                class: `plan-pill${dk === selected ? ' selected' : ''}${dk === today ? ' today' : ''}`,
                onclick: () => { ui.planDate = dk; renderAll() },
                ondragover: (event) => { if (ui.planDrag) { event.preventDefault(); event.currentTarget.classList.add('drop') } },
                ondragleave: (event) => { event.currentTarget.classList.remove('drop') },
                ondrop: (event) => {
                    event.preventDefault(); event.currentTarget.classList.remove('drop')
                    const d = ui.planDrag; ui.planDrag = null
                    if (d) actions.movePlanToDay(d.ref, dk)
                },
            },
                h('span', { class: 'pill-dow label-sm' }, dk === today ? t('plan.today') : dk === tomorrowKey ? t('plan.tomorrow') : parsePlanKey(dk).toLocaleDateString(undefined, { weekday: 'short' })),
                h('span', { class: 'pill-day' }, String(parsePlanKey(dk).getDate())),
                h('span', { class: `pill-count label-sm${count === 0 ? ' zero' : ''}` }, count > 0 ? String(count) : '·'),
                valueRollup(summarizeValue(dayValueItems(dk))),
            )
        }))

        // Page the strip a week at a time so past days are reachable; a Today jump
        // snaps back to the current week whenever the strip has drifted off it.
        const rangeDate = (key) => parsePlanKey(key).toLocaleDateString(undefined, {
            day: 'numeric', month: 'short', year: key.slice(0, 4) !== today.slice(0, 4) ? 'numeric' : undefined,
        })
        const rangeLabel = `${rangeDate(week[0])} – ${rangeDate(week[6])}`
        const stripNav = h('div', { class: 'plan-strip-nav' },
            h('button', {
                class: 'plan-week-btn', 'aria-label': t('plan.prevWeek'), title: t('plan.prevWeek'),
                onclick: () => { ui.weekOffset -= 1; ui.planDate = ''; renderAll() },
            }, tablerIcon('chevron-left', { size: 16 })),
            h('span', { class: 'plan-week-range label-sm' }, rangeLabel),
            h('button', {
                class: 'plan-week-btn', 'aria-label': t('plan.nextWeek'), title: t('plan.nextWeek'),
                onclick: () => { ui.weekOffset += 1; ui.planDate = ''; renderAll() },
            }, tablerIcon('chevron-right', { size: 16 })),
            ui.weekOffset === 0 ? null : h('button', {
                class: 'plan-today-btn label-sm',
                onclick: () => { ui.weekOffset = 0; ui.planDate = today; renderAll() },
            }, t('plan.today')),
        )
        const stripWrap = h('div', { class: 'plan-strip-wrap' }, stripNav, strip)

        const header = h('header', { class: 'page-header' },
            h('div', {},
                h('h1', { class: 'page-title title-lg' }, t('desktop.nav.overview')),
                h('div', { class: 'summary-bar label-md plan-subhead' },
                    beacon(state),
                    h('span', {}, parsePlanKey(today).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })),
                ),
            ),
            h('div', { class: 'header-actions' },
                h('span', { class: 'plan-viewtoggle' },
                    h('button', { class: `seg${view === 'focus' ? ' active' : ''}`, onclick: () => actions.setOverviewView('focus') }, t('plan.focus')),
                    h('button', { class: `seg${view === 'planner' ? ' active' : ''}`, onclick: () => actions.setOverviewView('planner') }, t('plan.planner')),
                    h('button', { class: `seg${view === 'value' ? ' active' : ''}`, onclick: () => actions.setOverviewView('value') }, t('value.tab')),
                ),
            ),
        )

        if (view === 'value') {
            return replaceChildren(main, header, renderValuePane(state))
        }

        if (view === 'planner') {
            const rail = h('div', { class: 'plan-week-rail' }, ...week.map((dk) => {
                const rows = resolveDay(dk)
                return h('section', {
                    class: `plan-week-day${dk === selected ? ' selected' : ''}${dk === today ? ' today' : ''}`,
                    onclick: () => { ui.planDate = dk; renderAll() },
                    ondragover: (event) => { if (ui.planDrag) { event.preventDefault(); event.currentTarget.classList.add('drop') } },
                    ondragleave: (event) => { event.currentTarget.classList.remove('drop') },
                    ondrop: (event) => { event.preventDefault(); event.currentTarget.classList.remove('drop'); const d = ui.planDrag; ui.planDrag = null; if (d) actions.movePlanToDay(d.ref, dk) },
                },
                    h('div', { class: 'plan-week-head' },
                        h('span', {}, dk === today ? t('plan.today') : dk === tomorrowKey ? t('plan.tomorrow') : parsePlanKey(dk).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })),
                        h('span', { class: 'plan-week-head-right' },
                            valueRollup(summarizeValue(dayValueItems(dk))),
                            h('span', { class: `pill-count label-sm${rows.length === 0 ? ' zero' : ''}` }, rows.length > 0 ? String(rows.length) : '·'),
                        ),
                    ),
                    rows.length === 0
                        ? h('div', { class: 'plan-week-empty label-sm' }, t('plan.empty.none'))
                        : h('div', { class: 'plan-week-rows' }, ...rows.map((r) => h('div', { class: `plan-week-row${r.done ? ' done' : ''}` },
                            tablerIcon(r.kind === 'list' ? iconForType(r.listType) : (r.done ? 'square-check' : 'square'), { size: 13 }),
                            h('span', {}, r.label),
                        ))),
                )
            }))
            return replaceChildren(main, header, stripWrap, weekValueBar,
                h('div', { class: 'plan-planner' },
                    h('div', { class: 'plan-agenda' }, dayAgenda(selected)),
                    rail,
                ),
            )
        }

        // Focus layout: selected-day agenda, plus a receded Tomorrow when on today.
        const parts = [header, stripWrap, weekValueBar, h('div', { class: 'plan-focus' }, dayAgenda(selected))]
        if (selected === today) {
            const tomorrow = resolveDay(tomorrowKey).filter((r) => !r.done)
            if (tomorrow.length > 0) {
                parts.push(h('div', { class: 'plan-tomorrow' },
                    h('div', { class: 'plan-section-label label-sm' }, t('plan.tomorrow')),
                    h('div', { class: 'plan-rows' }, ...tomorrow.map((r) => planRow(r, [], 0))),
                ))
            }
        }
        return replaceChildren(main, ...parts)
    }

    // The Overview "Value" tab: a two-series day chart (total completed value +
    // average delay) over the last 30 days, plus daily/monthly/quarterly/yearly
    // stat cards. Aggregates COMPLETED rated items across every surface.
    function renderValuePane(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const nowMs = now()
        const fmt1 = (n) => String(Math.round(n * 10) / 10)
        const series = aggregateCompletedValuePerDay(state.items, { daysBack: 30, nowMs })
        const hasData = series.some((d) => d.count > 0)

        const chart = buildValueChart(series)
        const legend = h('div', { class: 'value-legend label-sm' },
            h('span', { class: 'value-legend-item' }, h('span', { class: 'value-swatch value' }), tablerIcon('coins', { size: 13 }), t('value.chart.value')),
            h('span', { class: 'value-legend-item' }, h('span', { class: 'value-swatch delay' }), tablerIcon('hourglass', { size: 13 }), t('value.chart.delay')),
        )
        const axis = h('div', { class: 'value-axis label-sm' },
            h('span', {}, parsePlanKey(series[0].dateKey).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })),
            h('span', {}, parsePlanKey(series[series.length - 1].dateKey).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })),
        )

        const periods = [['day', t('value.stats.daily')], ['month', t('value.stats.monthly')], ['quarter', t('value.stats.quarterly')], ['year', t('value.stats.yearly')]]
        const cards = periods.map(([p, label]) => {
            const s = valueStatsForPeriod(state.items, p, { nowMs })
            return h('div', { class: 'value-stat-card' },
                h('div', { class: 'value-stat-label label-sm' }, label),
                h('div', { class: 'value-stat-num' }, tablerIcon('coins', { size: 16 }), s.count ? String(s.totalValue) : '—'),
                h('div', { class: 'value-stat-sub label-sm' }, s.count
                    ? h('span', {}, tablerIcon('hourglass', { size: 12 }), `${fmt1(s.avgDelay)} · ${t('congruency.completed', { count: s.count })}`)
                    : h('span', {}, t('value.empty'))),
            )
        })

        return h('div', { class: 'value-pane' },
            h('div', { class: 'value-chart-card' },
                legend,
                hasData ? chart : h('div', { class: 'value-empty' }, t('value.empty')),
                hasData ? axis : null,
            ),
            h('div', { class: 'value-stats' }, ...cards),
        )
    }

    // Inline-SVG dual-line chart. Value uses its own max; delay is fixed 1..10.
    // Built as an SVG string injected via innerHTML (the HTML parser creates the
    // SVG-namespaced nodes), mirroring how tablerIcon builds its markup.
    function buildValueChart(series) {
        const W = 640, H = 200, padL = 6, padR = 6, padT = 14, padB = 10
        const n = series.length
        const innerW = W - padL - padR
        const innerH = H - padT - padB
        const maxValue = Math.max(1, ...series.map((d) => d.totalValue))
        const xAt = (i) => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW)
        const yValue = (v) => padT + innerH - (v / maxValue) * innerH
        const yDelay = (v) => padT + innerH - (v / VALUE_MAX) * innerH
        const pts = (fn, key) => series.map((d, i) => `${xAt(i).toFixed(1)},${fn(d[key]).toFixed(1)}`).join(' ')
        const svg = `<svg viewBox="0 0 ${W} ${H}" class="value-chart-svg" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">`
            + `<line x1="${padL}" y1="${(padT + innerH).toFixed(1)}" x2="${W - padR}" y2="${(padT + innerH).toFixed(1)}" class="vc-axis" />`
            + `<polyline points="${pts(yValue, 'totalValue')}" class="vc-line vc-value" />`
            + `<polyline points="${pts(yDelay, 'avgDelay')}" class="vc-line vc-delay" />`
            + '</svg>'
        const wrap = h('div', { class: 'value-chart' })
        wrap.innerHTML = svg
        return wrap
    }


    return { renderOverviewPane }
}
