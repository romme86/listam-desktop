import { h, replaceChildren } from '../dom.mjs'
import { tablerIcon } from '../icons.mjs'

// Keep date keys local throughout: UTC conversion can move a chosen day across
// midnight. The plan channel uses four-digit years.
const validMonth = (month) => /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month || '')
const monthKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
const dateKey = (date) => `${monthKey(date)}-${String(date.getDate()).padStart(2, '0')}`
const parseDate = (key) => new Date(...key.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0)))

export function calendarMonth(month) {
    if (!validMonth(month)) return null
    const first = parseDate(`${month}-01`)
    const previous = monthKey(new Date(first.getFullYear(), first.getMonth() - 1, 1))
    const next = monthKey(new Date(first.getFullYear(), first.getMonth() + 1, 1))
    const length = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
    return {
        previous: validMonth(previous) ? previous : null,
        next: validMonth(next) ? next : null,
        offset: (first.getDay() + 6) % 7,
        days: Array.from({ length }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`),
    }
}

export function calendarKeyDate(key, direction) {
    const date = parseDate(key)
    const weekday = (date.getDay() + 6) % 7
    const shift = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday }[direction]
    if (shift !== undefined) date.setDate(date.getDate() + shift)
    else if (direction === 'PageUp' || direction === 'PageDown') {
        const day = date.getDate()
        date.setDate(1)
        date.setMonth(date.getMonth() + (direction === 'PageUp' ? -1 : 1))
        const length = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
        date.setDate(Math.min(day, length))
    } else return null
    return validMonth(monthKey(date)) ? dateKey(date) : null
}

// Navigation lives on the dialog draft, so a peer update can rebuild the
// calendar without sending it back to the entry's original month.
export function renderPlanCalendar({ draft, today, i18n, onPick }) {
    const host = h('div', { class: 'plan-calendar' })
    const monthLabel = (month) => i18n.date(parseDate(`${month}-01`), { month: 'long', year: 'numeric' })
    const fullDate = (key) => i18n.date(parseDate(key), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    function render(focus = false) {
        const month = calendarMonth(draft.month)
        if (!month) return
        if (!month.days.includes(draft.focusDate)) {
            draft.focusDate = month.days.includes(draft.dateKey) ? draft.dateKey : month.days[0]
        }
        const navigate = (next) => {
            if (!calendarMonth(next)) return
            draft.month = next
            render()
        }
        const monthInput = h('input', {
            class: 'input plan-calendar-month', type: 'month', value: draft.month,
            min: '1000-01', max: '9999-12', 'aria-label': i18n.t('plan.pickDate'),
            onchange: () => {
                if (!monthInput.validity.valid || !validMonth(monthInput.value)) return
                navigate(monthInput.value)
                host.querySelector('input')?.focus()
            },
        })
        const nav = (target, icon) => h('button', {
            type: 'button', class: 'plan-week-btn', disabled: target ? null : '',
            'aria-label': target ? monthLabel(target) : monthLabel(draft.month),
            title: target ? monthLabel(target) : null,
            onclick: () => { if (target) { navigate(target); host.querySelector(`.plan-calendar-nav button:${icon === 'chevron-left' ? 'first' : 'last'}-child`)?.focus() } },
        }, tablerIcon(icon, { size: 16 }))
        replaceChildren(host,
            h('div', { class: 'plan-calendar-nav' }, nav(month.previous, 'chevron-left'), monthInput, nav(month.next, 'chevron-right')),
            h('div', { class: 'plan-calendar-grid', role: 'group', 'aria-label': monthLabel(draft.month) },
                ...Array.from({ length: 7 }, (_, i) => h('span', { class: 'plan-calendar-weekday label-sm', 'aria-hidden': 'true' }, i18n.date(new Date(2024, 0, 1 + i), { weekday: 'short' }))),
                ...Array.from({ length: month.offset }, () => h('span', { 'aria-hidden': 'true' })),
                ...month.days.map((key) => h('button', {
                    type: 'button', class: `plan-calendar-day label-md${key === draft.dateKey ? ' selected' : ''}${key === today ? ' today' : ''}`,
                    'aria-label': fullDate(key), 'aria-pressed': String(key === draft.dateKey),
                    'aria-current': key === today ? 'date' : null,
                    tabindex: key === draft.focusDate ? '0' : '-1', dataset: { date: key },
                    onfocus: () => { draft.focusDate = key },
                    onclick: () => onPick(key),
                    onkeydown: (event) => {
                        const next = calendarKeyDate(key, event.key)
                        if (!next) return
                        event.preventDefault()
                        draft.focusDate = next
                        draft.month = next.slice(0, 7)
                        render(true)
                    },
                }, String(Number(key.slice(-2))))),
            ),
        )
        if (focus) host.querySelector('[tabindex="0"]')?.focus()
    }
    render()
    return host
}
