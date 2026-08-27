// Pear exposes no app suspend/resume event, so ./src/net-lifecycle.mjs drives
// RPC_NET_SUSPEND/RESUME off the two signals a renderer really has: the
// online/offline window events and a wall-clock gap in a timer that should have
// kept ticking. Both paths are only correct if they end in suspend-then-resume —
// @listam/backend's resumeNetwork() refuses to run on an unsuspended swarm, so a
// bare resume after a wake leaves the dead UDP sockets exactly as dead.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createNetLifecycle, LIFECYCLE_TICK_MS, SLEEP_GAP_MS } from '../src/net-lifecycle.mjs'

function harness({ tickMs = LIFECYCLE_TICK_MS, sleepGapMs = SLEEP_GAP_MS } = {}) {
    const calls = []
    const handlers = new Map()
    let clock = 0
    let tickFn = null
    let intervalMs = null

    const lifecycle = createNetLifecycle({
        suspend: async () => { calls.push('suspend') },
        resume: async () => { calls.push('resume') },
        events: {
            addEventListener: (type, fn) => handlers.set(type, fn),
            removeEventListener: (type, fn) => { if (handlers.get(type) === fn) handlers.delete(type) },
        },
        scheduler: {
            setInterval: (fn, ms) => { tickFn = fn; intervalMs = ms; return 'timer' },
            clearInterval: () => { tickFn = null },
        },
        now: () => clock,
        tickMs,
        sleepGapMs,
    })

    return {
        lifecycle,
        calls,
        handlers,
        get intervalMs() { return intervalMs },
        get timerLive() { return tickFn !== null },
        advance(ms) { clock += ms },
        tick() { tickFn?.() },
        fire(type) { handlers.get(type)?.() },
    }
}

test('waking from sleep re-binds the sockets with a suspend/resume pair, in order', async () => {
    const h = harness()
    h.lifecycle.start()

    // The process was frozen: the timer did not fire for far longer than its
    // interval. That gap IS the wake signal — there is no "about to sleep" event
    // in a renderer, so this is the only edge available to act on.
    h.advance(SLEEP_GAP_MS + 1000)
    h.tick()
    await h.lifecycle.settled()

    assert.deepEqual(h.calls, ['suspend', 'resume'])
})

test('an ordinary tick does nothing at all', async () => {
    const h = harness()
    h.lifecycle.start()
    assert.equal(h.intervalMs, LIFECYCLE_TICK_MS)

    for (let i = 0; i < 5; i++) {
        h.advance(LIFECYCLE_TICK_MS)
        h.tick()
    }
    await h.lifecycle.settled()

    assert.deepEqual(h.calls, [])
})

test('a stall shorter than the sleep gap is not treated as a wake', async () => {
    // GC pauses and a busy main thread both delay a timer. Cycling the swarm for
    // those would tear down working connections for no reason.
    const h = harness()
    h.lifecycle.start()

    h.advance(SLEEP_GAP_MS - 1)
    h.tick()
    await h.lifecycle.settled()

    assert.deepEqual(h.calls, [])
})

test('losing and regaining the network suspends then resumes', async () => {
    const h = harness()
    h.lifecycle.start()

    h.fire('offline')
    await h.lifecycle.settled()
    assert.deepEqual(h.calls, ['suspend'])

    h.fire('online')
    await h.lifecycle.settled()
    assert.deepEqual(h.calls, ['suspend', 'resume'])
})

test('a flapping connection never interleaves a suspend into the resume that follows it', async () => {
    const h = harness()
    h.lifecycle.start()

    h.fire('offline')
    h.fire('online')
    h.fire('offline')
    h.fire('online')
    await h.lifecycle.settled()

    assert.deepEqual(h.calls, ['suspend', 'resume', 'suspend', 'resume'])
})

test('a failed transition is reported and does not wedge the queue', async () => {
    const errors = []
    const handlers = new Map()
    const lifecycle = createNetLifecycle({
        suspend: async () => { throw new Error('worker gone') },
        resume: async () => {},
        events: {
            addEventListener: (type, fn) => handlers.set(type, fn),
            removeEventListener: () => {},
        },
        scheduler: { setInterval: () => 'timer', clearInterval: () => {} },
        onError: (error, reason) => errors.push([reason, error.message]),
    })
    lifecycle.start()

    handlers.get('offline')()
    await lifecycle.settled()
    assert.deepEqual(errors, [['offline', 'worker gone']])

    // A rejected transition must not poison the chain: the app keeps running,
    // and the next sleep/wake still gets its chance to re-bind the sockets.
    handlers.get('offline')()
    await lifecycle.settled()
    assert.equal(errors.length, 2)
})

test('stop clears the timer and detaches both listeners', () => {
    const h = harness()
    h.lifecycle.start()
    assert.deepEqual([...h.handlers.keys()].sort(), ['offline', 'online'])
    assert.equal(h.timerLive, true)

    h.lifecycle.stop()

    assert.deepEqual([...h.handlers.keys()], [])
    assert.equal(h.timerLive, false)
})
