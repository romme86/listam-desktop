// Runs @listam/backend under a Pear worker — the Bare side of the app, where
// the bare-* module graph resolves natively. The DOM renderer cannot load
// bare modules (Pear's app loader rejects them), so everything bare lives
// here and the renderer talks to this worker over the Pear worker pipe.
//
// Pipe protocol (newline-delimited JSON frames):
//   worker → renderer: { kind: 'ready', secretsMode }
//                      { kind: 'boot-error', message }
//                      { kind: 'event', id, event }   decoded client event
//                      { kind: 'res', id, data }      reply to a 'req' or 'bridge'
//                      { kind: 'bridge-status', status }  leaf-bridge state push
//   renderer → worker: { kind: 'req', id, command, data }  UI command
//                      { kind: 'reply', id, data }    answer to an 'event'
//                      { kind: 'bridge', id, action, port }  leaf-bridge control
//
// Events are decoded with @listam/client HERE so the renderer needs no
// bare-dependent imports at all; it receives ready-to-reduce client events.
import fs from 'bare-fs'
import { join } from 'bare-path'
import URL from 'bare-url'
import b4a from 'b4a'
// Note: '@listam/backend/backend', not the package index — the index
// re-exports the node platform adapter, whose node:buffer import does not
// exist under Bare.
import { startBackend } from '@listam/backend/backend'
import { createPearPlatform } from '@listam/backend/platform/pear'
import { decodeBackendRequest, dataToString } from '@listam/client'
import { RPC_PERSIST_SECRET } from '@listam/protocol'
import { createLogger } from '@listam/logging'
import { createFileSecretStore, prepareDesktopSecrets, persistDesktopSecret } from './secret-store.mjs'
import { normalizeLeafBridgePort } from './leaf-bridge-config.mjs'
import { createLeafBridgeManager } from './leaf-bridge-manager.mjs'

const log = createLogger({ app: 'desktop-worker' })
const Pear = globalThis.Pear
const pipe = Pear.worker.pipe()

let frameBuffer = ''
let eventId = 0
let backendHandler = null
let secretStore = null
const pendingEventReplies = new Map()

function send(frame) {
    pipe.write(`${JSON.stringify(frame)}\n`)
}

// Backend-originated RPC surface. Secret persistence is answered locally
// (the secret file lives on this side of the pipe); everything else is
// decoded and forwarded to the renderer.
function createRpc(handler) {
    backendHandler = handler
    return {
        request(command) {
            let firstReply = null
            return {
                command,
                send(data) {
                    const payload = dataToString(data)
                    if (command === RPC_PERSIST_SECRET) {
                        firstReply = persistDesktopSecret(payload, secretStore)
                            .then((result) => JSON.stringify({ stored: result.mode === 'secure-store', mode: result.mode }))
                            .catch(() => JSON.stringify({ stored: false }))
                        return
                    }
                    const id = ++eventId
                    firstReply = new Promise((resolve) => pendingEventReplies.set(id, resolve))
                    send({ kind: 'event', id, event: decodeBackendRequest(command, payload) })
                },
                reply() {
                    return firstReply ?? Promise.resolve(null)
                },
            }
        },
        close() {
            backendHandler = null
        },
    }
}

async function handleFrame(frame) {
    if (frame.kind === 'bridge') {
        const status = await bridgeManager.handleAction(frame)
        send({ kind: 'res', id: frame.id, data: JSON.stringify(status) })
    } else if (frame.kind === 'req') {
        if (!backendHandler) {
            send({ kind: 'res', id: frame.id, data: null })
            return
        }
        let replyData = null
        await backendHandler({
            command: frame.command,
            data: b4a.from(frame.data ?? ''),
            reply(value) {
                replyData = dataToString(value)
            },
        }, null)
        send({ kind: 'res', id: frame.id, data: replyData })
    } else if (frame.kind === 'reply') {
        const resolve = pendingEventReplies.get(frame.id)
        pendingEventReplies.delete(frame.id)
        resolve?.(frame.data)
    }
}

pipe.on('data', (chunk) => {
    frameBuffer += b4a.toString(chunk)
    let newline = frameBuffer.indexOf('\n')
    while (newline !== -1) {
        const line = frameBuffer.slice(0, newline)
        frameBuffer = frameBuffer.slice(newline + 1)
        if (line.trim()) {
            try {
                handleFrame(JSON.parse(line)).catch((error) => {
                    log.error('frame handling failed', { message: error?.message })
                })
            } catch (error) {
                log.error('bad frame', { line: line.slice(0, 120), message: error?.message })
            }
        }
        newline = frameBuffer.indexOf('\n')
    }
})

pipe.on('close', () => {
    globalThis.Bare?.exit?.(0)
})
pipe.on('end', () => {
    pipe.end()
})

async function main() {
    secretStore = createFileSecretStore({
        fs,
        path: join(Pear.config.storage, 'listam-desktop-secrets.json'),
    })
    const prepared = await prepareDesktopSecrets(secretStore)

    const platform = createPearPlatform({
        Pear,
        fs,
        join,
        fileURLToPath: URL.fileURLToPath,
        createRpc,
        storageNamespace: 'desktop',
        bootSecretPayload: JSON.stringify(prepared.backendPayload),
    })

    await startBackend(platform)
    await maybeStartLeafBridge()
    send({ kind: 'ready', secretsMode: prepared.mode })
    // Definitive initial bridge state for the renderer — covers the CLI-flag
    // boot path, whose earlier status push raced the renderer's listener.
    bridgeManager.publishStatus()
}

// TCP leaf bridge for hardware/leaf-peer replicas (e.g. the ESP32-S3 leaf).
// Started either at boot via `pear run … --leaf-bridge-port 9993` /
// LISTAM_LEAF_BRIDGE_PORT (dev path) or at runtime from the peers pane
// through 'bridge' frames. Bare has no Node `net`, so the bridge is handed
// `bare-tcp` (loaded only when enabled, so a build without the dep still
// boots).
const bridgeManager = createLeafBridgeManager({
    load: async () => {
        const tcpModule = await import('bare-tcp')
        const { startLeafBridge } = await import('@listam/backend/lib/leaf-bridge.mjs')
        // bare-os surfaces this host's LAN address so the bridge status can
        // tell the renderer the hub_addr to provision a leaf with. Optional:
        // a build without it just reports no hubAddr.
        let os = null
        try {
            const osModule = await import('bare-os')
            os = osModule.default ?? osModule
        } catch {
            /* no bare-os → hubAddr stays null */
        }
        return { tcp: tcpModule.default ?? tcpModule, startLeafBridge, os }
    },
    log,
    publish: (status) => send({ kind: 'bridge-status', status }),
})

function readLeafBridgePort() {
    const args = Array.isArray(Pear?.config?.args) ? Pear.config.args : []
    const flagIndex = args.indexOf('--leaf-bridge-port')
    if (flagIndex !== -1) {
        const port = normalizeLeafBridgePort(args[flagIndex + 1])
        if (port > 0) return port
    }
    const env = globalThis.Bare?.env ?? globalThis.process?.env ?? {}
    return normalizeLeafBridgePort(env.LISTAM_LEAF_BRIDGE_PORT)
}

async function maybeStartLeafBridge() {
    const port = readLeafBridgePort()
    if (port <= 0) return
    await bridgeManager.start(port)
}

main().catch((error) => {
    log.error('backend worker boot failed', { message: error?.message, stack: error?.stack })
    send({ kind: 'boot-error', message: error?.message ?? String(error) })
    setTimeout(() => globalThis.Bare?.exit?.(1), 100)
})
