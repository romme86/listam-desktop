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
import { createVoiceHost } from './voice-host-worker.mjs'

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

// Bare ABORTS the whole worker process on an uncaught exception or unhandled
// rejection — e.g. an error thrown from an autobase apply or a timer/replication
// callback. That silently kills the backend, so the pipe closes and every
// subsequent UI write fails with "Backend worker is not connected" ("Could not
// start the Listam backend"). Registering listeners suppresses the abort: we
// keep the worker alive (one recoverable error must never take the whole app
// down) and persist the full stack next to the app storage so the root cause is
// diagnosable. Errors are de-duped by message so a deterministic fault can't
// spam the log file.
const workerErrors = new Map()
function reportWorkerError(kind, err) {
    const message = err?.message ?? String(err)
    const stack = err?.stack ?? (err == null ? '' : String(err))
    const key = `${kind}:${message}`
    const prev = workerErrors.get(key)
    workerErrors.set(key, { kind, message, stack, count: (prev?.count ?? 0) + 1, at: nowIso() })
    try { log.error(`worker ${kind}`, { message, count: workerErrors.get(key).count }) } catch {}
    try {
        const out = [...workerErrors.values()]
            .map((e) => `[${e.at}] ${e.kind} (x${e.count}): ${e.message}\n${e.stack}\n`)
            .join('\n')
        fs.writeFileSync(join(Pear.config.storage, 'worker-errors.log'), out)
    } catch { /* diagnostics are best-effort */ }
    // Best-effort heads-up to the renderer; an unknown frame kind is ignored
    // safely by the boot bridge, so this never breaks older renderers.
    try { send({ kind: 'worker-error', message }) } catch { /* ignore */ }
}
function nowIso() {
    try { return new Date().toISOString() } catch { return String(Date.now()) }
}
globalThis.Bare?.on?.('uncaughtException', (err) => reportWorkerError('uncaughtException', err))
globalThis.Bare?.on?.('unhandledRejection', (err) => reportWorkerError('unhandledRejection', err))

// Lightweight item projection the desktop voice host reads for remove-by-text
// and registry resolution. Fed from the same decoded client events the renderer
// receives (tapped in createRpc below).
const voiceItems = new Map()
function projectVoiceEvent(event) {
    const type = event?.type
    if (type === 'sync-list') {
        voiceItems.clear()
        for (const item of (Array.isArray(event.items) ? event.items : [])) if (item?.id) voiceItems.set(item.id, item)
    } else if (type === 'add-from-backend' || type === 'update-from-backend') {
        if (event.item?.id) voiceItems.set(event.item.id, event.item)
    } else if (type === 'delete-from-backend') {
        if (event.item?.id) voiceItems.delete(event.item.id)
    } else if (type === 'reset') {
        voiceItems.clear()
    }
}

// Write into the DESKTOP's own base by invoking the backend request handler the
// renderer's RPCs already go through. The voice host uses this so a spoken add
// lands in the desktop list with no second peer/base/pairing.
function callBackend(command, payload) {
    return new Promise((resolve) => {
        if (!backendHandler) return resolve(null)
        let replied = null
        Promise.resolve(backendHandler({
            command,
            data: b4a.from(typeof payload === 'string' ? payload : JSON.stringify(payload ?? '')),
            reply(value) { replied = dataToString(value) },
        })).then(() => resolve(replied)).catch(() => resolve(replied))
    })
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
                    const event = decodeBackendRequest(command, payload)
                    projectVoiceEvent(event)
                    send({ kind: 'event', id, event })
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
    } else if (frame.kind === 'voice') {
        const status = await voiceHost.handleAction(frame)
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
    await maybeStartVoice()
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

// Desktop voice host: leaf audio → whisper (bare-subprocess) → intent → write to
// THIS base. Modules are imported only when voice is started, so a build without
// bare-subprocess still boots. Controlled by 'voice' frames from the renderer
// (Settings toggle) and, for dev/testing, the LISTAM_VOICE_* env.
const voiceHost = createVoiceHost({
    callBackend,
    getItems: () => [...voiceItems.values()],
    load: async () => {
        const [tcpModule, subprocessModule] = await Promise.all([import('bare-tcp'), import('bare-subprocess')])
        const { createStt } = await import('@listam/backend/lib/stt/index.mjs')
        const { startAudioBridge } = await import('@listam/backend/lib/audio-bridge.mjs')
        const { createVoiceController } = await import('@listam/backend/lib/voice-controller.mjs')
        const { createVoiceFeedbackHandler } = await import('@listam/backend/lib/voice-feedback.mjs')
        const { parseIntent, detectWake } = await import('@listam/domain/voice-intent')
        const { isRegistryItem } = await import('@listam/domain/list-registry')
        const { isLabelItem } = await import('@listam/domain/labels')
        return {
            tcp: tcpModule.default ?? tcpModule,
            subprocess: subprocessModule.default ?? subprocessModule,
            fs,
            tmpDir: Pear.config.storage,
            createStt, startAudioBridge, createVoiceController, createVoiceFeedbackHandler,
            parseIntent, detectWake, isRegistryItem, isLabelItem,
        }
    },
    log,
    publish: (status) => send({ kind: 'voice-status', status }),
})

function workerEnv() {
    return globalThis.Bare?.env ?? globalThis.process?.env ?? {}
}

async function maybeStartVoice() {
    const env = workerEnv()
    if (env.LISTAM_VOICE_ENABLED !== '1' || !env.LISTAM_VOICE_MODEL) return
    await voiceHost.start({
        modelPath: env.LISTAM_VOICE_MODEL,
        binPath: env.LISTAM_VOICE_BIN || 'whisper-cli',
        locale: env.LISTAM_VOICE_LOCALE || 'auto',
        prompt: env.LISTAM_VOICE_PROMPT || null,
        audioPort: Number(env.LISTAM_VOICE_PORT) || undefined,
    })
}

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
