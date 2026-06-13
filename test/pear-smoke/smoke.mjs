// Bare-runtime smoke for the desktop leaf-bridge control plane: hosts the
// REAL src/backend-worker.mjs as a Pear worker (the symlinked src/ and
// node_modules/ make it resolvable inside this app's drive) and speaks the
// renderer's pipe protocol at it — bridge start → real RPC_ADD → wait for a
// leaf to connect → bridge stop. Run via test/pear-smoke/run-smoke.mjs, which
// parses the SMOKE markers and dials in the real Rust leaf-host.
//
// Uses its own dev storage (this app dir != listam-desktop), so it never
// touches a running desktop instance's corestore lease.
import b4a from 'b4a'
import { RPC_ADD } from '@listam/protocol'

const PORT = 9981
const STOP_AFTER_CONNECT_MS = 12_000
const TIMEOUT_MS = 120_000

const Pear = globalThis.Pear
const base = Pear.config.applink.endsWith('/') ? Pear.config.applink : `${Pear.config.applink}/`
const pipe = Pear.worker.run(new URL('./src/backend-worker.mjs', base).href)

const out = (...parts) => console.log('SMOKE', ...parts)
let nextId = 0
const pending = new Map()
let frameBuffer = ''
let sawConnection = false

const timeout = setTimeout(() => {
    out('TIMEOUT')
    exit(1)
}, TIMEOUT_MS)

function exit(code) {
    clearTimeout(timeout)
    try {
        pipe.end()
    } catch {
        // pipe may already be gone
    }
    setTimeout(() => globalThis.Bare?.exit?.(code), 200)
}

function write(frame) {
    pipe.write(`${JSON.stringify(frame)}\n`)
}

function request(frame) {
    const id = ++nextId
    return new Promise((resolve) => {
        pending.set(id, resolve)
        write({ ...frame, id })
    })
}

async function onReady() {
    out('READY')
    const data = await request({ kind: 'bridge', action: 'start', port: PORT })
    let status = null
    try {
        status = JSON.parse(data)
    } catch {
        // fall through to the failure marker
    }
    if (!status?.running || !status.controlKey) {
        out('START-FAILED', data)
        return exit(1)
    }
    out('CONTROL-KEY', status.controlKey)
    // A real item so the leaf has writer blocks to mirror, not just keys.
    await request({ kind: 'req', command: RPC_ADD, data: JSON.stringify({ text: 'smoke-item' }) })
    out('ITEM-ADDED')
}

function onStatus(status) {
    out('STATUS', JSON.stringify(status))
    if (status.connections >= 1 && !sawConnection) {
        sawConnection = true
        out('LEAF-CONNECTED')
        setTimeout(async () => {
            const data = await request({ kind: 'bridge', action: 'stop' })
            out('STOPPED', data)
            exit(0)
        }, STOP_AFTER_CONNECT_MS)
    }
}

function handleFrame(frame) {
    if (frame.kind === 'ready') {
        onReady().catch((error) => {
            out('SMOKE-ERROR', error?.message ?? String(error))
            exit(1)
        })
    } else if (frame.kind === 'boot-error') {
        out('BOOT-ERROR', frame.message)
        exit(1)
    } else if (frame.kind === 'res') {
        const resolve = pending.get(frame.id)
        pending.delete(frame.id)
        resolve?.(frame.data)
    } else if (frame.kind === 'bridge-status') {
        onStatus(frame.status)
    } else if (frame.kind === 'event') {
        // The worker forwards backend events and awaits a reply, renderer-style.
        write({ kind: 'reply', id: frame.id, data: null })
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
                handleFrame(JSON.parse(line))
            } catch {
                out('BAD-FRAME', line.slice(0, 80))
            }
        }
        newline = frameBuffer.indexOf('\n')
    }
})

pipe.on('close', () => {
    if (!sawConnection) {
        out('PIPE-CLOSED-EARLY')
        exit(1)
    }
})
