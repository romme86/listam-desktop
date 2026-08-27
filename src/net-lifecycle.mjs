// Keeps the swarm's UDP sockets alive across the two things that kill them on a
// long-lived desktop app: the machine sleeping, and the network dropping out.
//
// WHY THIS SHAPE. Pear's desktop runtime exposes no app suspend/resume event and
// no power monitor — the renderer is an ordinary DOM context, so the only
// lifecycle signals that actually exist here are the `online`/`offline` window
// events and a wall-clock gap in a timer that should have kept ticking. Those
// two are what this drives, and nothing is invented on top of them.
//
// `visibilitychange` is deliberately NOT used. On mobile a hidden app is a
// backgrounded app; on desktop a hidden window is a minimized one, and a peer
// that stopped replicating whenever its window was minimized would be a
// regression, not a fix.
//
// Both recoveries end in the SAME pair, in order: suspend, then resume.
// hyperswarm's resume() is what re-binds fresh UDP sockets through dht-rpc and
// re-announces the topic, and @listam/backend's resumeNetwork() refuses to run
// unless the swarm is actually suspended. So a bare resume after a wake is a
// no-op — the dead sockets stay dead, exactly the state where a host that had
// stepped away stopped being reachable and never recovered.

// Fires often enough that a real sleep is noticed within a tick of waking, and
// rarely enough to be free when nothing is happening.
export const LIFECYCLE_TICK_MS = 15000

// A timer scheduled every LIFECYCLE_TICK_MS that did not fire for a full minute
// means the process was frozen, not merely busy. Comfortably above any garbage
// collection or main-thread stall, comfortably below the shortest nap a laptop
// lid takes.
export const SLEEP_GAP_MS = 60000

/**
 * @param {object} options
 * @param {() => Promise<unknown>} options.suspend       sends RPC_NET_SUSPEND
 * @param {() => Promise<unknown>} options.resume        sends RPC_NET_RESUME
 * @param {{ addEventListener?: Function, removeEventListener?: Function }} [options.events]
 * @param {{ setInterval?: Function, clearInterval?: Function }} [options.scheduler]
 * @param {() => number} [options.now]
 * @param {number} [options.tickMs]
 * @param {number} [options.sleepGapMs]
 * @param {(error: unknown, reason: string) => void} [options.onError]
 * @param {(reason: string) => void} [options.onCycle]
 */
export function createNetLifecycle ({
    suspend,
    resume,
    events = globalThis,
    scheduler = globalThis,
    now = Date.now,
    tickMs = LIFECYCLE_TICK_MS,
    sleepGapMs = SLEEP_GAP_MS,
    onError = () => {},
    onCycle = () => {},
} = {}) {
    let timer = null
    let lastTick = 0
    // Every transition runs through one chain: an `offline` immediately followed
    // by an `online` (a flapping Wi-Fi handoff) must not interleave a suspend
    // with the resume that is supposed to follow it.
    let pending = Promise.resolve()

    function run (task, reason) {
        onCycle(reason)
        pending = pending.then(task).catch((error) => onError(error, reason))
        return pending
    }

    const onOffline = () => run(() => suspend(), 'offline')
    // The swarm is already suspended by the `offline` above, so this is the
    // re-bind. If the browser reported `online` without ever reporting
    // `offline`, resumeNetwork() sees an unsuspended swarm and answers
    // { resumed: false } — a no-op, not an error.
    const onOnline = () => run(() => resume(), 'online')
    const onWake = () => run(async () => {
        await suspend()
        await resume()
    }, 'wake')

    function tick () {
        const at = now()
        const elapsed = at - lastTick
        lastTick = at
        if (elapsed >= sleepGapMs) onWake()
    }

    function start () {
        if (timer !== null) return stop
        lastTick = now()
        timer = scheduler.setInterval?.(tick, tickMs) ?? null
        events.addEventListener?.('offline', onOffline)
        events.addEventListener?.('online', onOnline)
        return stop
    }

    function stop () {
        if (timer !== null) {
            scheduler.clearInterval?.(timer)
            timer = null
        }
        events.removeEventListener?.('offline', onOffline)
        events.removeEventListener?.('online', onOnline)
    }

    // `settled` lets a caller (and the tests) await the queue rather than guess.
    return { start, stop, settled: () => pending }
}
