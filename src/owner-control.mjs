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

    async function withSession(serverPublicKeyHex, run) {
        const socket = dht.connect(b4a.from(serverPublicKeyHex, 'hex'))
        socket.on('error', () => {})
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('control connection timed out')), REQUEST_TIMEOUT_MS)
            socket.once('open', () => { clearTimeout(timer); resolve() })
            socket.once('close', () => { clearTimeout(timer); reject(new Error('control connection closed')) })
        })
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
        try {
            return await withTimeout(run(session), REQUEST_TIMEOUT_MS)
        } finally {
            socket.destroy()
        }
    }

    return {
        deviceId: createOwnerControlSession({ keyPair: deviceKeyPair, write: () => {} }).deviceId,
        listServers() {
            return [...servers]
        },
        async pair(code, name) {
            const parsed = parsePairingCode(code)
            if (!parsed) return { ok: false, reason: 'invalid-code' }
            const result = await withSession(parsed.serverPublicKeyHex, (session) => session.pair(parsed.secretHex, name))
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
            return withSession(serverPublicKeyHex, (session) => session.request(command, payload))
        },
        async close() {
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
