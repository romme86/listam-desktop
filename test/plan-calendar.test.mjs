import test from 'node:test'
import assert from 'node:assert/strict'
import { calendarMonth, calendarKeyDate } from '../src/ui/plan-calendar.mjs'

test('the calendar reaches past and future years without a current-week limit', () => {
    assert.equal(calendarMonth('2026-01').previous, '2025-12')
    assert.equal(calendarMonth('2035-12').next, '2036-01')
    assert.equal(calendarMonth('2026-09').offset, 1, 'September starts on Tuesday in a Monday-first grid')
    assert.equal(calendarMonth('2035-12').days.at(-1), '2035-12-31')
    assert.equal(calendarMonth('1000-01').previous, null)
    assert.equal(calendarMonth('9999-12').next, null)
    for (const month of ['', '2028-00', '2028-13', '2028-2', '10000-01']) assert.equal(calendarMonth(month), null)
})

test('February includes leap day only in leap years, including the century rule', () => {
    assert.equal(calendarMonth('2028-02').days.at(-1), '2028-02-29')
    assert.equal(calendarMonth('2027-02').days.at(-1), '2027-02-28')
    assert.equal(calendarMonth('2100-02').days.length, 28)
    assert.equal(calendarMonth('2400-02').days.length, 29)
})

test('keyboard navigation crosses month/year boundaries and clamps shorter months', () => {
    assert.equal(calendarKeyDate('2026-12-31', 'ArrowRight'), '2027-01-01')
    assert.equal(calendarKeyDate('2027-01-01', 'ArrowLeft'), '2026-12-31')
    assert.equal(calendarKeyDate('2028-02-25', 'ArrowDown'), '2028-03-03')
    assert.equal(calendarKeyDate('2028-01-31', 'PageDown'), '2028-02-29')
    assert.equal(calendarKeyDate('2027-03-31', 'PageUp'), '2027-02-28')
    assert.equal(calendarKeyDate('2026-09-08', 'Home'), '2026-09-07')
    assert.equal(calendarKeyDate('2026-09-08', 'End'), '2026-09-13')
    assert.equal(calendarKeyDate('2026-09-08', 'Enter'), null)
    assert.equal(calendarKeyDate('9999-12-31', 'ArrowRight'), null)
})

test('day navigation retains local dates across daylight saving transitions', () => {
    const original = process.env.TZ
    try {
        for (const zone of ['Europe/Zurich', 'America/Los_Angeles', 'Pacific/Auckland']) {
            process.env.TZ = zone
            assert.equal(calendarKeyDate('2026-03-29', 'ArrowRight'), '2026-03-30', zone)
            assert.equal(calendarKeyDate('2026-10-25', 'ArrowLeft'), '2026-10-24', zone)
            assert.equal(calendarMonth('2026-03').days.length, 31, zone)
        }
    } finally {
        if (original === undefined) delete process.env.TZ
        else process.env.TZ = original
    }
})
