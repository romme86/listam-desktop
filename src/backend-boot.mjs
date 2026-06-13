// Boots the embedded backend in a Pear worker and bridges it to the UI over
// the worker pipe. The renderer deliberately imports nothing bare-dependent —
// Pear's DOM loader rejects bare-* (and CJS like b4a), which is exactly why
// the backend lives in the worker (src/backend-worker.mjs). Frames are
// newline-delimited JSON; events arrive already decoded to client events.
const BOOT_TIMEOUT_MS = 45000

export async function bootDesktopBackend({ Pear, onEvent, onBridgeStatus }) {
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

    function write(frame) {
        pipe.write(`${JSON.stringify(frame)}\n`)
    }

    function dispatch(frame) {
        if (frame.kind === 'event') {
            const event = {
                ...frame.event,
                reply(value) {
                    write({ kind: 'reply', id: frame.id, data: value == null ? null : String(value) })
                },
            }
            for (const listener of listeners) listener(event)
        } else if (frame.kind === 'res') {
            const resolve = pendingResponses.get(frame.id)
            pendingResponses.delete(frame.id)
            resolve?.(frame.data)
        } else if (frame.kind === 'bridge-status') {
            onBridgeStatus?.(frame.status)
        }
    }

    const client = {
        async send(command, payload) {
            if (!ready) throw new Error('Backend worker is not connected')
            const id = ++requestId
            const response = new Promise((resolve) => pendingResponses.set(id, resolve))
            write({
                kind: 'req',
                id,
                command,
                data: typeof payload === 'string' ? payload : JSON.stringify(payload ?? ''),
            })
            return response
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
            if (!ready) throw new Error('Backend worker is not connected')
            const id = ++requestId
            const response = new Promise((resolve) => pendingResponses.set(id, resolve))
            write({ kind: 'bridge', id, action, port: options.port })
            const data = await response
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
            if (!ready) {
                clearTimeout(timeout)
                reject(error)
            }
        })
        pipe.on('close', () => {
            ready = false
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
                    shutdown: () => pipe.end(),
                    dispose: () => pipe.end(),
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
