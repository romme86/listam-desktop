// Desktop owner-control client (H1): pairs this desktop with the user's
// headless instances and sends signed, capability-scoped commands over an
// encrypted hyperdht connection. Pear-only (bare module graph) — the browser
// preview shows the pane in its unavailable state instead.
//
// The device key seed and the paired-server list live in the shared file
// secret store under the app's private storage directory.
import fs from 'bare-fs'
import { join } from 'bare-path'
import DHT from 'hyperdht'
import b4a from 'b4a'
import { randomBytes } from 'hypercore-crypto'
import { createFileSecretStore } from '@listam/secrets'
import {
    createDeviceKeyPair,
    createOwnerControlSession,
    parsePairingCode,
} from '@listam/owner-control'

const DEVICE_SEED_KEY = 'listam.control.v1.deviceSeed'
const PAIRED_SERVERS_KEY = 'listam.control.v1.pairedServers'
const REQUEST_TIMEOUT_MS = 30_000
// The dial gets its own (shorter) budget so a slow open + a slow request can't
// stack into a ~60s cold-path wait on REQUEST_TIMEOUT_MS twice.
const OPEN_TIMEOUT_MS = 15_000

export async function createOwnerControlManager({ Pear }) {
    const storageDir = Pear?.config?.storage
    if (!storageDir) throw new Error('Pear storage directory unavailable')

    const store = createFileSecretStore({ fs, path: join(storageDir, 'owner-control-keys.json') })
    let seedHex = await store.getItem(DEVICE_SEED_KEY)
    if (!seedHex) {
        seedHex = randomBytes(32).toString('hex')
        await store.setItem(DEVICE_SEED_KEY, seedHex)
    }
    const deviceKeyPair = createDeviceKeyPair(seedHex)

    let servers = []
    try {
        servers = JSON.parse(await store.getItem(PAIRED_SERVERS_KEY) ?? '[]')
        if (!Array.isArray(servers)) servers = []
    } catch {
        servers = []
    }

    const dht = new DHT()

    // ONE persistent encrypted connection per server, reused for every command.
    // hyperdht will not let us reconnect to a server key once a connection to it
    // has been torn down (a fresh dht.connect to the same key closes before it
    // opens — verified on a private testnet AND against a live mainnet peer), so
    // the previous connect-and-destroy-per-request pattern made the very first
    // command after pairing fail. Keep the socket open across requests instead;
    // the Servers pane's 20s poll holds it warm. Map values are the in-flight
    // open promise so concurrent first calls (auto-fetch + poll) share one dial.
    const connections = new Map() // serverPublicKeyHex -> Promise<{ socket, session }>

    function openConnection(serverPublicKeyHex) {
        const socket = dht.connect(b4a.from(serverPublicKeyHex, 'hex'))
        socket.on('error', () => {})
        const slot = new Promise((resolve, reject) => {
            const timer = setTimeout(() => { socket.destroy(); reject(new Error('control connection timed out')) }, OPEN_TIMEOUT_MS)
            socket.once('open', () => {
                clearTimeout(timer)
                const session = createOwnerControlSession({
                    keyPair: deviceKeyPair,
                    write: (line) => socket.write(line + '\n'),
                })
                let buffered = ''
                socket.on('data', (chunk) => {
                    buffered += b4a.toString(chunk)
                    let newline = buffered.indexOf('\n')
                    while (newline >= 0) {
                        session.handleLine(buffered.slice(0, newline))
                        buffered = buffered.slice(newline + 1)
                        newline = buffered.indexOf('\n')
                    }
                })
                resolve({ socket, session })
            })
            socket.once('close', () => { clearTimeout(timer); reject(new Error('control connection closed')) })
        })
        // Drop the cached slot the moment the socket dies (or the dial fails) so
        // the next call dials afresh rather than reusing a dead session.
        socket.once('close', () => { if (connections.get(serverPublicKeyHex) === slot) connections.delete(serverPublicKeyHex) })
        slot.catch(() => { if (connections.get(serverPublicKeyHex) === slot) connections.delete(serverPublicKeyHex) })
        connections.set(serverPublicKeyHex, slot)
        return slot
    }

    function getConnection(serverPublicKeyHex) {
        return connections.get(serverPublicKeyHex) ?? openConnection(serverPublicKeyHex)
    }

    async function runOnServer(serverPublicKeyHex, run) {
        const slot = getConnection(serverPublicKeyHex)
        let entry = await slot
        if (entry.socket.destroyed) {
            // Only evict the exact slot we observed dead: a concurrent caller may
            // already have installed a fresh connection between our await and now
            // (same `=== slot` guard the close handler and slot.catch use).
            if (connections.get(serverPublicKeyHex) === slot) connections.delete(serverPublicKeyHex)
            entry = await getConnection(serverPublicKeyHex)
        }
        // A request that times out leaves its entry in the reused session's
        // pending map until the socket closes (the session has no cancel API).
        // We deliberately don't destroy the socket on timeout — a fresh dial to
        // the same key would fail (hyperdht won't reconnect), so we'd rather keep
        // the warm connection and accept a tiny, close-bounded pending residue.
        return withTimeout(run(entry.session), REQUEST_TIMEOUT_MS)
    }

    return {
        deviceId: createOwnerControlSession({ keyPair: deviceKeyPair, write: () => {} }).deviceId,
        listServers() {
            return [...servers]
        },
        async pair(code, name) {
            const parsed = parsePairingCode(code)
            if (!parsed) return { ok: false, reason: 'invalid-code' }
            const result = await runOnServer(parsed.serverPublicKeyHex, (session) => session.pair(parsed.secretHex, name))
            if (result?.ok) {
                servers = [
                    ...servers.filter((entry) => entry.serverPublicKeyHex !== parsed.serverPublicKeyHex),
                    {
                        serverPublicKeyHex: parsed.serverPublicKeyHex,
                        name: typeof name === 'string' && name.trim() ? name.trim() : 'Headless device',
                        capabilities: result.capabilities ?? [],
                        pairedAt: Date.now(),
                    },
                ]
                await store.setItem(PAIRED_SERVERS_KEY, JSON.stringify(servers))
            }
            return result
        },
        request(serverPublicKeyHex, command, payload) {
            return runOnServer(serverPublicKeyHex, (session) => session.request(command, payload))
        },
        async close() {
            for (const slot of connections.values()) {
                slot.then(({ socket }) => socket.destroy(), () => {})
            }
            connections.clear()
            try {
                await dht.destroy()
            } catch {}
        },
    }
}

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('owner-control request timed out')), ms)
        Promise.resolve(promise).then(
            (value) => { clearTimeout(timer); resolve(value) },
            (error) => { clearTimeout(timer); reject(error) },
        )
    })
}
