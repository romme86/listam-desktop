// Leaf-board bridge config: port validation shared by the worker and the
// renderer, preference defaults/round-trips, and the store's bridge state
// slice. The TCP path itself is exercised end-to-end by
// hardware/leaf-peer/bridge-js (host + ESP32 against a real backend).
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LEAF_BRIDGE_PORT, normalizeLeafBridgePort } from '../src/leaf-bridge-config.mjs'
import { createLeafBridgeManager } from '../src/leaf-bridge-manager.mjs'
import { createDesktopStore, DEFAULT_PREFERENCES } from '../src/store.mjs'
import { loadUiPreferences, persistUiPreferences } from '../src/prefs.mjs'

const silentLog = { log() {}, info() {}, error() {} }

// Stands in for bare-tcp + the backend's startLeafBridge: records lifecycle
// calls and exposes the onStatus hook so tests can simulate leaves
// connecting and disconnecting.
function fakeBridgeRuntime() {
    const calls = { starts: [], closes: 0 }
    let currentOnStatus = null
    return {
        calls,
        pushConnections: (connections) => currentOnStatus?.({ connections }),
        load: async () => ({
            tcp: {},
            startLeafBridge: async ({ port, onStatus }) => {
                calls.starts.push(port)
                currentOnStatus = onStatus
                return {
                    port,
                    controlKey: `key-for-${port}`,
                    connections: () => 0,
                    close: async () => { calls.closes++ },
                }
            },
        }),
    }
}

function memoryStorage() {
    const map = new Map()
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
    }
}

test('normalizeLeafBridgePort accepts real ports and rejects everything else', () => {
    assert.equal(normalizeLeafBridgePort(9993), 9993)
    assert.equal(normalizeLeafBridgePort('4321'), 4321)
    assert.equal(normalizeLeafBridgePort(1), 1)
    assert.equal(normalizeLeafBridgePort(65535), 65535)
    for (const bad of [0, -1, 65536, 1.5, 'abc', '', null, undefined, NaN, Infinity]) {
        assert.equal(normalizeLeafBridgePort(bad), 0, `expected ${String(bad)} to normalize to 0`)
    }
})

test('leaf-bridge preferences default off and round-trip through storage', () => {
    assert.equal(DEFAULT_PREFERENCES.leafBridgeEnabled, false)
    assert.equal(DEFAULT_PREFERENCES.leafBridgePort, DEFAULT_LEAF_BRIDGE_PORT)

    const storage = memoryStorage()
    persistUiPreferences(storage, { ...DEFAULT_PREFERENCES, leafBridgeEnabled: true, leafBridgePort: 4321 })
    const loaded = loadUiPreferences(storage)
    assert.equal(loaded.leafBridgeEnabled, true)
    assert.equal(loaded.leafBridgePort, 4321)
})

test('loadUiPreferences drops corrupted leaf-bridge values', () => {
    const storage = memoryStorage()
    storage.setItem('listam.desktop.uiPreferences', JSON.stringify({
        leafBridgeEnabled: 'yes',
        leafBridgePort: 99999,
    }))
    const loaded = loadUiPreferences(storage)
    assert.equal(loaded.leafBridgeEnabled, undefined, 'non-boolean enabled flag is ignored')
    assert.equal(loaded.leafBridgePort, undefined, 'out-of-range port is ignored')
})

test('bridge manager: start publishes a running status with the control key', async () => {
    const runtime = fakeBridgeRuntime()
    const published = []
    const manager = createLeafBridgeManager({ load: runtime.load, log: silentLog, publish: (s) => published.push(s) })

    const status = await manager.handleAction({ action: 'start', port: 9993 })
    assert.equal(status.running, true)
    assert.equal(status.port, 9993)
    assert.equal(status.controlKey, 'key-for-9993')
    assert.equal(status.error, null)
    assert.deepEqual(published.at(-1), status)

    // Idempotent: same port again does not restart the listener.
    await manager.handleAction({ action: 'start', port: 9993 })
    assert.deepEqual(runtime.calls.starts, [9993])
})

test('bridge manager: port change restarts, stop closes and resets', async () => {
    const runtime = fakeBridgeRuntime()
    const manager = createLeafBridgeManager({ load: runtime.load, log: silentLog, publish: () => {} })

    await manager.start(9993)
    await manager.handleAction({ action: 'start', port: 4321 })
    assert.deepEqual(runtime.calls.starts, [9993, 4321])
    assert.equal(runtime.calls.closes, 1, 'old listener closed before rebinding')
    assert.equal(manager.snapshot().port, 4321)

    const stopped = await manager.handleAction({ action: 'stop' })
    assert.equal(runtime.calls.closes, 2)
    assert.deepEqual(stopped, { running: false, port: 0, controlKey: null, connections: 0, error: null })
})

test('bridge manager: leaf connect/disconnect updates published connections', async () => {
    const runtime = fakeBridgeRuntime()
    const published = []
    const manager = createLeafBridgeManager({ load: runtime.load, log: silentLog, publish: (s) => published.push(s) })

    await manager.start(9993)
    runtime.pushConnections(1)
    assert.equal(manager.snapshot().connections, 1)
    assert.equal(manager.snapshot().running, true, 'connection push keeps the rest of the status')
    runtime.pushConnections(0)
    assert.equal(manager.snapshot().connections, 0)
    assert.equal(published.length, 3)

    // A stale listener's late events must not touch the status after stop.
    await manager.stop()
    runtime.pushConnections(5)
    assert.equal(manager.snapshot().connections, 0)
})

test('bridge manager: invalid port and load failure surface as errors, not throws', async () => {
    const runtime = fakeBridgeRuntime()
    const manager = createLeafBridgeManager({ load: runtime.load, log: silentLog, publish: () => {} })

    const invalid = await manager.handleAction({ action: 'start', port: 'nope' })
    assert.equal(invalid.running, false)
    assert.match(invalid.error, /invalid leaf-bridge port/)
    assert.deepEqual(runtime.calls.starts, [], 'invalid port never reaches the listener')

    const broken = createLeafBridgeManager({
        load: async () => { throw new Error('bare-tcp missing') },
        log: silentLog,
        publish: () => {},
    })
    const failed = await broken.handleAction({ action: 'start', port: 9993 })
    assert.equal(failed.running, false)
    assert.equal(failed.error, 'bare-tcp missing')

    // 'status' (or any unknown action) just reports the current state.
    const report = await broken.handleAction({ action: 'status' })
    assert.equal(report.running, false)
})

test('store carries worker-pushed leaf-bridge status', () => {
    const store = createDesktopStore()
    assert.equal(store.getState().leafBridge, null)

    const status = { running: true, port: 9993, controlKey: 'ab'.repeat(32), connections: 1, error: null }
    store.setState({ leafBridge: status })
    assert.deepEqual(store.getState().leafBridge, status)

    store.setState({ leafBridge: { ...status, running: false } })
    assert.equal(store.getState().leafBridge.running, false)
})
