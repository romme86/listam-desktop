// Desktop owner-control bridge.
//
// This used to be a client in its own right: it imported hyperdht, bare-fs and
// bare-path and dialled paired headless instances straight from the renderer.
// That cannot work — Pear's DOM loader rejects bare-* exactly as it does for the
// backend, which is why the backend runs in a worker at all. main.mjs imported
// it under a `.catch(() => null)`, so the failure was silent and the Servers
// pane simply rendered its "unavailable" note forever. Verified in the live Pear
// app on 2026-07-28, not just the browser preview.
//
// The engine already existed on the other side of the pipe: @listam/backend runs
// the shared owner-control client inside the worker (the same one mobile drives),
// reachable over RPC_CONTROL_LIST / _PAIR / _COMMAND. So this file is now a thin
// renderer-side adapter that keeps the exact shape ui.mjs consumes —
// listServers() / pair() / request() — and holds no transport of its own.
//
// The paired-server list is non-secret metadata the worker keeps in memory; the
// device seed stays behind the backend's secure-storage boundary and is never
// seen here. We persist the list locally and hydrate the worker on boot, the
// same division of labour mobile uses.
import { RPC_CONTROL_LIST, RPC_CONTROL_PAIR, RPC_CONTROL_COMMAND } from '@listam/protocol'

const SERVERS_KEY = 'listam.desktop.controlServers'
const REQUEST_TIMEOUT_MS = 30_000

function loadServers(storage) {
    try {
        const parsed = JSON.parse(storage?.getItem?.(SERVERS_KEY) ?? '[]')
        if (!Array.isArray(parsed)) return []
        return parsed.filter((entry) => /^[0-9a-f]{64}$/.test(entry?.serverPublicKeyHex ?? ''))
    } catch {
        return []
    }
}

function persistServers(storage, servers) {
    try {
        storage?.setItem?.(SERVERS_KEY, JSON.stringify(servers))
    } catch { /* a full or unavailable store must not break the pane */ }
}

export function createOwnerControlBridge({ client, storage, timeoutMs = REQUEST_TIMEOUT_MS }) {
    if (!client) return null

    let servers = loadServers(storage)
    let deviceId = null

    // The worker answers over the one-way message channel, not as a reply to the
    // request frame, so replies are correlated by what they carry: pair results
    // by 'pair', command results by command+server. Waiters are a FIFO queue per
    // key — ui.mjs's busy flags keep duplicates rare, but two identical in-flight
    // requests must still each get an answer rather than one stealing the other's.
    const waiters = new Map()

    function waitFor(key) {
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject }
            entry.timer = setTimeout(() => {
                dropWaiter(key, entry)
                reject(new Error('owner-control request timed out'))
            }, timeoutMs)
            if (!waiters.has(key)) waiters.set(key, [])
            waiters.get(key).push(entry)
        })
    }

    function dropWaiter(key, entry) {
        const queue = waiters.get(key)
        if (!queue) return
        const index = queue.indexOf(entry)
        if (index >= 0) queue.splice(index, 1)
        if (queue.length === 0) waiters.delete(key)
    }

    function settle(key, value) {
        const queue = waiters.get(key)
        if (!queue || queue.length === 0) return
        const entry = queue.shift()
        if (queue.length === 0) waiters.delete(key)
        clearTimeout(entry.timer)
        entry.resolve(value)
    }

    function adoptServers(next) {
        if (!Array.isArray(next)) return
        servers = next.filter((entry) => /^[0-9a-f]{64}$/.test(entry?.serverPublicKeyHex ?? ''))
        persistServers(storage, servers)
    }

    const unsubscribe = client.onEvent((event) => {
        if (event?.type !== 'message') return
        const payload = event.payload
        switch (payload?.type) {
            case 'owner-control-servers':
                adoptServers(payload.servers)
                if (payload.deviceId) deviceId = payload.deviceId
                settle('list', servers)
                break
            case 'owner-control-paired':
                adoptServers(payload.servers)
                settle('pair', { ok: payload.ok === true, reason: payload.reason, servers })
                break
            case 'owner-control-result':
                settle(`cmd:${payload.command}:${payload.serverPublicKeyHex}`, payload.result)
                break
            default:
                break
        }
    })

    // Hand the worker the list this device already knows about. Without it a
    // restart would show no paired servers until the user paired again — the
    // worker's copy is in-memory only, by design.
    const hydrated = client
        .send(RPC_CONTROL_LIST, { servers })
        .catch(() => null)

    return {
        get deviceId() { return deviceId },
        hydrated,
        listServers() {
            return servers.map((entry) => ({ ...entry }))
        },
        async pair(code, name) {
            const reply = waitFor('pair')
            try {
                await client.send(RPC_CONTROL_PAIR, { code, name })
            } catch (error) {
                return { ok: false, reason: error?.message ?? 'send-failed' }
            }
            return reply
        },
        async request(serverPublicKeyHex, command, payload) {
            const reply = waitFor(`cmd:${command}:${serverPublicKeyHex}`)
            await client.send(RPC_CONTROL_COMMAND, { serverPublicKeyHex, command, payload })
            return reply
        },
        close() {
            unsubscribe?.()
            for (const queue of waiters.values()) {
                for (const entry of queue) {
                    clearTimeout(entry.timer)
                    entry.reject(new Error('owner-control bridge closed'))
                }
            }
            waiters.clear()
        },
    }
}
