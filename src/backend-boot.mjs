// Boots the embedded backend in a Pear worker and bridges it to the UI over
// the worker pipe. The renderer deliberately imports nothing bare-dependent —
// Pear's DOM loader rejects bare-* (and CJS like b4a), which is exactly why
// the backend lives in the worker (src/backend-worker.mjs). Frames are
// newline-delimited JSON; events arrive already decoded to client events.
import {
    RPC_UPDATE,
    RPC_REQUEST_SYNC,
    RPC_CREATE_INVITE,
    RPC_GET_MEMBERS,
    RPC_GET_BOARD_CONFIG,
    RPC_LIST_BACKUPS,
} from '@listam/protocol'

const BOOT_TIMEOUT_MS = 45000
export const REQUEST_TIMEOUT_MS = 12000
const WORKER_CLOSE_TIMEOUT_MS = 3000

// Replaying an exact, timestamped RPC_UPDATE is idempotent: the list reducer is
// keyed by item id and resolves the same LWW value. The remaining commands are
// read/refresh requests. Deliberately exclude RPC_ADD and RPC_MOVE — if their
// first reply was lost, blindly repeating them could create or move twice.
const RECOVERY_RETRY_SAFE_COMMANDS = new Set([
    RPC_UPDATE,
    RPC_REQUEST_SYNC,
    RPC_CREATE_INVITE,
    RPC_GET_MEMBERS,
    RPC_GET_BOARD_CONFIG,
    RPC_LIST_BACKUPS,
])

function isRecoverableWorkerError(error) {
    return error?.code === 'BACKEND_REQUEST_TIMEOUT'
        || /worker is not connected|worker pipe closed|worker is restarting/i.test(error?.message ?? '')
}

export async function bootDesktopBackend({ Pear, onEvent, onBridgeStatus, onVoiceStatus, requestTimeoutMs = REQUEST_TIMEOUT_MS }) {
    const applink = Pear?.config?.applink
    if (!applink) throw new Error('Pear applink unavailable')

    const base = applink.endsWith('/') ? applink : `${applink}/`
    const entry = new globalThis.URL('./src/backend-worker.mjs', base).href
    const pipe = Pear.worker.run(entry)

    const listeners = new Set()
    const pendingResponses = new Map()
    const decoder = new TextDecoder()
    let requestId = 0
    let ready = false
    let frameBuffer = ''
    let resolveClosed
    let stopping = false
    const closed = new Promise((resolve) => { resolveClosed = resolve })

    function write(frame) {
        pipe.write(`${JSON.stringify(frame)}\n`)
    }

    // One-way, data-free diagnostics persisted by the worker. This lets us
    // distinguish a backend that never replied from a response the renderer
    // failed to match, without logging item contents or other payloads.
    function traceRequest(phase, details = {}) {
        try {
            write({
                kind: 'renderer-trace',
                phase,
                id: details.id ?? null,
                requestKind: details.requestKind ?? null,
                command: details.command ?? null,
                matched: details.matched ?? null,
                subtype: details.subtype ?? null,
                errorAt: details.errorAt ?? null,
            })
        } catch { /* diagnostics are best-effort */ }
    }

    function dispatch(frame) {
        if (frame.kind === 'event') {
            const event = {
                ...frame.event,
                reply(value) {
                    write({ kind: 'reply', id: frame.id, data: value == null ? null : String(value) })
                },
            }
            for (const listener of listeners) {
                try {
                    listener(event)
                } catch (error) {
                    // A reducer/render exception must not abort this pipe data
                    // callback and strand a response frame queued behind the
                    // event. Record only the event type; never its payload.
                    traceRequest('event-listener-error', {
                        requestKind: 'event',
                        command: frame.event?.type ?? null,
                        subtype: frame.event?.payload?.type ?? null,
                        errorAt: String(error?.stack ?? '').split('\n').slice(1, 3).join(' | ').slice(0, 500) || null,
                    })
                }
            }
        } else if (frame.kind === 'res') {
            const pending = pendingResponses.get(frame.id)
            pendingResponses.delete(frame.id)
            traceRequest('response', {
                id: frame.id,
                requestKind: pending?.requestKind,
                command: pending?.command,
                matched: !!pending,
            })
            if (pending) {
                clearTimeout(pending.timer)
                pending.resolve(frame.data)
            }
        } else if (frame.kind === 'bridge-status') {
            onBridgeStatus?.(frame.status)
        } else if (frame.kind === 'voice-status') {
            onVoiceStatus?.(frame.status)
        }
    }

    function rejectPending(error) {
        for (const pending of pendingResponses.values()) {
            clearTimeout(pending.timer)
            pending.reject(error)
        }
        pendingResponses.clear()
    }

    async function stopWorker() {
        if (!stopping) {
            stopping = true
            ready = false
            rejectPending(new Error('Backend worker is restarting'))
            try { pipe.end() } catch { resolveClosed() }
        }
        let timer
        try {
            await Promise.race([
                closed,
                new Promise((resolve) => { timer = setTimeout(resolve, WORKER_CLOSE_TIMEOUT_MS) }),
            ])
        } finally {
            if (timer) clearTimeout(timer)
        }
    }

    function request(frame) {
        if (!ready) return Promise.reject(new Error('Backend worker is not connected'))
        const id = ++requestId
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingResponses.delete(id)
                traceRequest('timeout', {
                    id,
                    requestKind: frame.kind,
                    command: frame.command ?? frame.action ?? null,
                })
                const error = new Error(`Backend request timed out after ${requestTimeoutMs}ms`)
                error.code = 'BACKEND_REQUEST_TIMEOUT'
                reject(error)
            }, requestTimeoutMs)
            pendingResponses.set(id, {
                resolve,
                reject,
                timer,
                requestKind: frame.kind,
                command: frame.command ?? frame.action ?? null,
            })
            try {
                traceRequest('start', {
                    id,
                    requestKind: frame.kind,
                    command: frame.command ?? frame.action ?? null,
                })
                write({ ...frame, id })
            } catch (error) {
                clearTimeout(timer)
                pendingResponses.delete(id)
                reject(error)
            }
        })
    }

    const client = {
        async send(command, payload) {
            return request({
                kind: 'req',
                command,
                data: typeof payload === 'string' ? payload : JSON.stringify(payload ?? ''),
            })
        },
        onEvent(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        isConnected() {
            return ready
        },
        // Leaf-bridge control (Settings → leaf board). Returns the worker's
        // bridge status object: { running, port, controlKey, connections, error }.
        async bridge(action, options = {}) {
            const data = await request({ kind: 'bridge', action, port: options.port })
            try {
                return data ? JSON.parse(data) : null
            } catch {
                return null
            }
        },
        // Voice host control (Settings → voice). `action` is 'start'|'stop';
        // `config` carries { modelPath, binPath, locale, prompt, audioPort }.
        // Returns the worker's voice status { running, port, error }.
        async voice(action, config = {}) {
            const data = await request({ kind: 'voice', action, config })
            try {
                return data ? JSON.parse(data) : null
            } catch {
                return null
            }
        },
    }
    client.onEvent(onEvent)

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Backend worker did not become ready within ${BOOT_TIMEOUT_MS / 1000}s`))
        }, BOOT_TIMEOUT_MS)

        pipe.on('data', (chunk) => {
            frameBuffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
            let newline = frameBuffer.indexOf('\n')
            while (newline !== -1) {
                const line = frameBuffer.slice(0, newline)
                frameBuffer = frameBuffer.slice(newline + 1)
                if (line.trim()) handleLine(line)
                newline = frameBuffer.indexOf('\n')
            }
        })
        pipe.on('error', (error) => {
            const wasReady = ready
            ready = false
            rejectPending(error)
            if (!wasReady) {
                clearTimeout(timeout)
                reject(error)
            }
        })
        pipe.on('close', () => {
            ready = false
            rejectPending(new Error('Backend worker pipe closed'))
            resolveClosed()
            if (timeout) clearTimeout(timeout)
            reject(new Error('Backend worker pipe closed during boot'))
        })

        function handleLine(line) {
            let frame
            try {
                frame = JSON.parse(line)
            } catch {
                return
            }
            if (frame.kind === 'ready') {
                ready = true
                clearTimeout(timeout)
                resolve({
                    client,
                    secretsMode: frame.secretsMode,
                    shutdown: stopWorker,
                    dispose: stopWorker,
                })
            } else if (frame.kind === 'boot-error') {
                clearTimeout(timeout)
                reject(new Error(frame.message))
            } else {
                dispatch(frame)
            }
        }
    })
}

// Keep the DOM renderer alive while replacing only a wedged backend worker.
// The caller supplies a freshly booted backend plus a factory for replacements;
// this separation also makes the recovery policy testable without Pear.
export function createRecoveringBackendClient({
    initialBackend,
    startBackend,
    retrySafeCommands = RECOVERY_RETRY_SAFE_COMMANDS,
    onRecovering = null,
    onRecovered = null,
    onRecoveryFailed = null,
}) {
    if (!initialBackend?.client || typeof startBackend !== 'function') {
        throw new TypeError('A live backend and startBackend factory are required')
    }

    let active = initialBackend
    let recovery = null
    let disposed = false
    const listeners = new Set()
    const listenerUnsubscribes = new Map()

    function attachListeners(backend) {
        for (const listener of listeners) {
            const unsubscribe = backend.client.onEvent?.(listener)
            if (typeof unsubscribe === 'function') listenerUnsubscribes.set(listener, unsubscribe)
        }
    }

    async function recover(error) {
        if (disposed) throw new Error('Desktop backend has been disposed')
        if (recovery) return recovery

        const failed = active
        active = null
        recovery = (async () => {
            try { onRecovering?.(error) } catch { /* status callbacks are best-effort */ }
            for (const unsubscribe of listenerUnsubscribes.values()) {
                try { unsubscribe() } catch { /* old worker is already unhealthy */ }
            }
            listenerUnsubscribes.clear()
            try { await failed?.shutdown?.() } catch { /* replacement still proceeds */ }

            try {
                const replacement = await startBackend()
                if (disposed) {
                    await replacement?.shutdown?.()
                    throw new Error('Desktop backend has been disposed')
                }
                active = replacement
                attachListeners(replacement)
                try { onRecovered?.(replacement) } catch { /* status callbacks are best-effort */ }
                return replacement
            } catch (recoveryError) {
                try { onRecoveryFailed?.(recoveryError) } catch { /* status callbacks are best-effort */ }
                throw recoveryError
            }
        })()

        try {
            return await recovery
        } finally {
            recovery = null
        }
    }

    async function currentBackend() {
        if (disposed) throw new Error('Desktop backend has been disposed')
        if (recovery) return recovery
        if (active) return active
        return recover(new Error('Backend worker is not connected'))
    }

    async function runWithRecovery(invoke, { retry = false } = {}) {
        const backend = await currentBackend()
        try {
            return await invoke(backend.client)
        } catch (error) {
            if (!isRecoverableWorkerError(error) && backend.client.isConnected?.() !== false) throw error
            const replacement = await recover(error)
            if (!retry) throw error
            try {
                return await invoke(replacement.client)
            } catch (retryError) {
                // Leave the next user action a healthy process even when this
                // operation exhausted its one replay. Never loop indefinitely.
                if (isRecoverableWorkerError(retryError) || replacement.client.isConnected?.() === false) {
                    try { await recover(retryError) } catch { /* report the operation's own failure below */ }
                }
                throw retryError
            }
        }
    }

    const client = {
        send(command, payload) {
            return runWithRecovery(
                (target) => target.send(command, payload),
                { retry: retrySafeCommands.has(command) },
            )
        },
        bridge(action, options = {}) {
            return runWithRecovery((target) => target.bridge(action, options), { retry: true })
        },
        voice(action, config = {}) {
            return runWithRecovery((target) => target.voice(action, config), { retry: true })
        },
        onEvent(listener) {
            listeners.add(listener)
            const unsubscribe = active?.client.onEvent?.(listener)
            if (typeof unsubscribe === 'function') listenerUnsubscribes.set(listener, unsubscribe)
            return () => {
                listeners.delete(listener)
                try { listenerUnsubscribes.get(listener)?.() } catch { /* already closed */ }
                listenerUnsubscribes.delete(listener)
            }
        },
        isConnected() {
            return !disposed && !recovery && !!active?.client.isConnected?.()
        },
    }

    return {
        client,
        get secretsMode() { return active?.secretsMode ?? initialBackend.secretsMode },
        async shutdown() {
            disposed = true
            let backend = active
            if (recovery) {
                try { backend = await recovery } catch { backend = null }
            }
            active = null
            await backend?.shutdown?.()
        },
        recover,
    }
}

export async function bootRecoveringDesktopBackend(options) {
    const initialBackend = await bootDesktopBackend(options)
    return createRecoveringBackendClient({
        initialBackend,
        startBackend: () => bootDesktopBackend(options),
        onRecovering: options?.onRecovering,
        onRecovered: options?.onRecovered,
        onRecoveryFailed: options?.onRecoveryFailed,
    })
}
