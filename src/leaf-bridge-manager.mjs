// Worker-side lifecycle for the leaf-board bridge: one TCP listener that
// hardware/leaf-peer replicas (e.g. the ESP32-S3 leaf) dial to mirror this
// project's cores. The runtime pieces are injected — `load` resolves the
// bare-only modules (bare-tcp + @listam/backend's startLeafBridge) so the
// logic itself stays loadable and testable under plain Node.
import { normalizeLeafBridgePort } from './leaf-bridge-config.mjs'

const STOPPED = Object.freeze({ running: false, port: 0, controlKey: null, hubAddr: null, connections: 0, error: null })

// LAN address(es) a leaf should dial back to, as `ip:port` — surfaced in the
// status so the renderer can provision a leaf to this hub over Web Bluetooth.
// `os` is injected (bare-os in the worker) and optional, so this degrades to
// null under plain Node / in tests.
function hubAddrFromOs(os, port) {
    try {
        const ifaces = os?.networkInterfaces?.() ?? {}
        const out = []
        for (const list of Object.values(ifaces)) {
            for (const ni of list ?? []) {
                const v4 = ni.family === 'IPv4' || ni.family === 4
                if (v4 && !ni.internal) out.push(`${ni.address}:${port}`)
            }
        }
        return out.join(',') || null
    } catch {
        return null
    }
}

export function createLeafBridgeManager({ load, log, publish }) {
    let bridge = null
    let status = STOPPED
    // Bumped on every start/stop so a closed listener's straggling
    // socket-close events cannot overwrite the current bridge's status.
    let generation = 0

    function setStatus(next, { notify = true } = {}) {
        status = next
        if (notify) publish(status)
    }

    async function start(port) {
        if (bridge && status.running && status.port === port) return status
        await stop({ notify: false })
        const token = ++generation
        try {
            const { tcp, startLeafBridge, os } = await load()
            bridge = await startLeafBridge({
                port,
                logger: log,
                tcp,
                onStatus({ connections }) {
                    if (token !== generation) return
                    setStatus({ ...status, connections })
                },
            })
            setStatus({
                running: true,
                port: bridge.port,
                controlKey: bridge.controlKey,
                hubAddr: hubAddrFromOs(os, bridge.port),
                connections: 0,
                error: null,
            })
            log.info('leaf-bridge started', { port: bridge.port })
        } catch (error) {
            bridge = null
            const message = error?.message ?? String(error)
            setStatus({ ...STOPPED, port, error: message })
            log.error('leaf-bridge failed to start', { message })
        }
        return status
    }

    async function stop({ notify = true } = {}) {
        generation++
        if (bridge) {
            try {
                await bridge.close()
            } catch (error) {
                log.error('leaf-bridge close failed', { message: error?.message ?? String(error) })
            }
            bridge = null
        }
        setStatus(STOPPED, { notify })
        return status
    }

    // One renderer 'bridge' frame → one status reply.
    async function handleAction({ action, port }) {
        if (action === 'start') {
            const normalized = normalizeLeafBridgePort(port)
            if (normalized <= 0) return { ...status, error: `invalid leaf-bridge port: ${port}` }
            return start(normalized)
        }
        if (action === 'stop') return stop()
        return status
    }

    return {
        start,
        stop,
        handleAction,
        snapshot: () => status,
        publishStatus: () => publish(status),
    }
}
