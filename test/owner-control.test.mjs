// The renderer-side owner-control adapter. The transport it drives lives in the
// backend worker, so these tests stand in a fake client with the exact contract
// backend-boot.mjs provides: send(command, payload) -> Promise, and onEvent
// delivering decoded client events ({ type: 'message', payload }).
import test from 'node:test'
import assert from 'node:assert/strict'
import { RPC_CONTROL_LIST, RPC_CONTROL_PAIR, RPC_CONTROL_COMMAND } from '@listam/protocol'
import { createOwnerControlBridge } from '../src/owner-control.mjs'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)

function fakeClient() {
    const listeners = new Set()
    const sent = []
    return {
        sent,
        send(command, payload) {
            sent.push({ command, payload })
            return Promise.resolve('')
        },
        onEvent(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        // Push what the worker would emit for these commands.
        emit(payload) {
            for (const listener of listeners) listener({ type: 'message', payload })
        },
        listenerCount() { return listeners.size },
    }
}

function fakeStorage(initial = {}) {
    const map = new Map(Object.entries(initial))
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, v),
        read: (k) => map.get(k),
    }
}

test('boot hydrates the worker with the servers this device already knows', async () => {
    const client = fakeClient()
    const storage = fakeStorage({
        'listam.desktop.controlServers': JSON.stringify([{ serverPublicKeyHex: KEY_A, name: 'Geekom', capabilities: ['status:read'] }]),
    })
    const bridge = createOwnerControlBridge({ client, storage })
    await bridge.hydrated

    // The worker keeps its paired list in memory only, so a restart that did not
    // re-send it would show no servers at all.
    assert.equal(client.sent.length, 1)
    assert.equal(client.sent[0].command, RPC_CONTROL_LIST)
    assert.equal(client.sent[0].payload.servers[0].serverPublicKeyHex, KEY_A)
    assert.equal(bridge.listServers()[0].name, 'Geekom')
})

test('a malformed persisted list is discarded rather than replayed to the worker', () => {
    const client = fakeClient()
    const bridge = createOwnerControlBridge({
        client,
        storage: fakeStorage({ 'listam.desktop.controlServers': '{not json' }),
    })
    assert.deepEqual(bridge.listServers(), [])

    const bad = createOwnerControlBridge({
        client: fakeClient(),
        storage: fakeStorage({ 'listam.desktop.controlServers': JSON.stringify([{ serverPublicKeyHex: 'nope' }]) }),
    })
    assert.deepEqual(bad.listServers(), [], 'an entry that is not a 32-byte hex key is not a server')
    bridge.close()
    bad.close()
})

test('request resolves with the worker result for its own command and server', async () => {
    const client = fakeClient()
    const bridge = createOwnerControlBridge({ client, storage: fakeStorage() })

    const pending = bridge.request(KEY_A, 'status')
    assert.equal(client.sent.at(-1).command, RPC_CONTROL_COMMAND)

    // A result for a DIFFERENT server must not settle this one — the pane polls
    // several servers at once.
    client.emit({ type: 'owner-control-result', command: 'status', serverPublicKeyHex: KEY_B, result: { ok: true, wrong: true } })
    client.emit({ type: 'owner-control-result', command: 'status', serverPublicKeyHex: KEY_A, result: { ok: true, items: 7 } })

    assert.deepEqual(await pending, { ok: true, items: 7 })
    bridge.close()
})

test('concurrent identical requests each get an answer, in order', async () => {
    const client = fakeClient()
    const bridge = createOwnerControlBridge({ client, storage: fakeStorage() })

    const first = bridge.request(KEY_A, 'status')
    const second = bridge.request(KEY_A, 'status')
    client.emit({ type: 'owner-control-result', command: 'status', serverPublicKeyHex: KEY_A, result: { seq: 1 } })
    client.emit({ type: 'owner-control-result', command: 'status', serverPublicKeyHex: KEY_A, result: { seq: 2 } })

    assert.deepEqual(await first, { seq: 1 })
    assert.deepEqual(await second, { seq: 2 }, 'the second waiter must not be starved by the first')
    bridge.close()
})

test('pairing adopts and persists the server list the worker reports', async () => {
    const client = fakeClient()
    const storage = fakeStorage()
    const bridge = createOwnerControlBridge({ client, storage })

    const pending = bridge.pair('code', 'Geekom')
    assert.equal(client.sent.at(-1).command, RPC_CONTROL_PAIR)
    client.emit({
        type: 'owner-control-paired',
        ok: true,
        servers: [{ serverPublicKeyHex: KEY_A, name: 'Geekom', capabilities: ['status:read'] }],
    })

    const result = await pending
    assert.equal(result.ok, true)
    assert.equal(bridge.listServers().length, 1)
    // Survives a restart: the next boot reads this back and re-hydrates.
    assert.match(storage.read('listam.desktop.controlServers'), /Geekom/)
    bridge.close()
})

test('a request times out instead of hanging when the worker never answers', async () => {
    const client = fakeClient()
    const bridge = createOwnerControlBridge({ client, storage: fakeStorage(), timeoutMs: 20 })
    await assert.rejects(bridge.request(KEY_A, 'status'), /timed out/)
    bridge.close()
})

test('close detaches the event listener and rejects anything still waiting', async () => {
    const client = fakeClient()
    const bridge = createOwnerControlBridge({ client, storage: fakeStorage() })
    assert.equal(client.listenerCount(), 1)

    const pending = bridge.request(KEY_A, 'status')
    bridge.close()
    await assert.rejects(pending, /closed/)
    assert.equal(client.listenerCount(), 0, 'a closed bridge must not keep observing the backend')
})

test('the bridge is null without a client, so the pane falls back to unavailable', () => {
    assert.equal(createOwnerControlBridge({ client: null, storage: fakeStorage() }), null)
})

// The bridge and the worker agree on the RPC ids by importing them from
// @listam/protocol, so those cannot drift. The reply message `type` strings are
// plain literals on both sides, and a typo in one of them would be invisible:
// the send succeeds, no reply ever matches, and every call quietly times out
// after 30s. Pin them against the backend the app actually loads.
test('the reply types the bridge waits for are the ones the backend emits', async () => {
    const { readFileSync } = await import('node:fs')
    const backendSource = readFileSync(
        new URL('../node_modules/@listam/backend/backend.mjs', import.meta.url),
    ).toString('utf8')

    for (const type of ['owner-control-servers', 'owner-control-paired', 'owner-control-result']) {
        assert.ok(
            backendSource.includes(`'${type}'`),
            `the backend no longer emits '${type}'; the bridge would wait for a reply that never comes`,
        )
    }
    // And the fields the bridge correlates and reads on those messages.
    for (const field of ['serverPublicKeyHex', 'servers', 'deviceId']) {
        assert.ok(backendSource.includes(field), `the backend no longer sends '${field}'`)
    }
})
