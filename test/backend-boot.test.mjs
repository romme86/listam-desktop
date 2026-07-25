import test from 'node:test'
import assert from 'node:assert/strict'
import { bootDesktopBackend, createRecoveringBackendClient } from '../src/backend-boot.mjs'

class FakePipe {
    constructor() { this.listeners = new Map(); this.writes = [] }
    on(type, listener) { this.listeners.set(type, listener) }
    write(value) { this.writes.push(value) }
    end() {}
    emit(type, value) { this.listeners.get(type)?.(value) }
}

async function bootFixture(requestTimeoutMs = 10, onEvent = () => {}) {
    const pipe = new FakePipe()
    const Pear = {
        config: { applink: 'pear://test/' },
        worker: { run: () => pipe },
    }
    const booting = bootDesktopBackend({ Pear, onEvent, requestTimeoutMs })
    pipe.emit('data', '{"kind":"ready","secretsMode":"secure-store"}\n')
    return { pipe, backend: await booting }
}

test('desktop worker requests reject instead of waiting forever', async () => {
    const { backend } = await bootFixture(5)
    await assert.rejects(
        backend.client.send(123, { value: true }),
        (error) => error?.code === 'BACKEND_REQUEST_TIMEOUT',
    )
})

test('closing the worker pipe rejects every in-flight request', async () => {
    const { pipe, backend } = await bootFixture(1000)
    const pending = backend.client.send(123)
    pipe.emit('close')
    await assert.rejects(pending, /pipe closed/)
    assert.equal(backend.client.isConnected(), false)
})

test('a worker response resolves and cancels its request timeout', async () => {
    const { pipe, backend } = await bootFixture(50)
    const pending = backend.client.send(123)
    const frame = JSON.parse(pipe.writes.at(-1))
    pipe.emit('data', `${JSON.stringify({ kind: 'res', id: frame.id, data: 'ok' })}\n`)
    assert.equal(await pending, 'ok')
})

test('an event listener exception cannot strand the response behind it', async () => {
    const { pipe, backend } = await bootFixture(50, () => { throw new Error('render failed') })
    const pending = backend.client.send(123)
    const request = JSON.parse(pipe.writes.at(-1))
    pipe.emit('data', [
        JSON.stringify({ kind: 'event', id: 99, event: { type: 'update-from-backend' } }),
        JSON.stringify({ kind: 'res', id: request.id, data: 'ok' }),
        '',
    ].join('\n'))

    assert.equal(await pending, 'ok')
    const traces = pipe.writes.map((line) => JSON.parse(line)).filter((frame) => frame.kind === 'renderer-trace')
    assert.ok(traces.some((frame) => frame.phase === 'event-listener-error'))
    assert.ok(traces.some((frame) => frame.phase === 'response' && frame.matched === true))
})

function timeoutError() {
    const error = new Error('Backend request timed out')
    error.code = 'BACKEND_REQUEST_TIMEOUT'
    return error
}

function recoveringFixture(firstSend, secondSend) {
    let starts = 0
    let shutdowns = 0
    const backend = (send) => ({
        secretsMode: 'secure-store',
        client: {
            send,
            bridge: async () => null,
            voice: async () => null,
            onEvent: () => () => {},
            isConnected: () => true,
        },
        async shutdown() { shutdowns++ },
    })
    const initialBackend = backend(firstSend)
    const recovering = createRecoveringBackendClient({
        initialBackend,
        async startBackend() { starts++; return backend(secondSend) },
    })
    return { recovering, starts: () => starts, shutdowns: () => shutdowns }
}

test('a timed-out item update replaces the worker and safely replays once', async () => {
    let replacementCalls = 0
    const fixture = recoveringFixture(
        async () => { throw timeoutError() },
        async (command, payload) => {
            replacementCalls++
            assert.equal(command, 3)
            assert.deepEqual(payload, { item: { id: 'todo-1', isDone: true, updatedAt: 10 } })
            return '{"ok":true,"reason":null}'
        },
    )

    const result = await fixture.recovering.client.send(3, {
        item: { id: 'todo-1', isDone: true, updatedAt: 10 },
    })

    assert.equal(result, '{"ok":true,"reason":null}')
    assert.equal(fixture.starts(), 1)
    assert.equal(fixture.shutdowns(), 1)
    assert.equal(replacementCalls, 1)
})

test('concurrent timeouts share one worker recovery', async () => {
    const gate = Promise.withResolvers()
    let initialCalls = 0
    let replacementCalls = 0
    const fixture = recoveringFixture(
        async () => {
            initialCalls++
            await gate.promise
            throw timeoutError()
        },
        async () => { replacementCalls++; return '{"ok":true}' },
    )

    const first = fixture.recovering.client.send(3, { item: { id: 'a' } })
    const second = fixture.recovering.client.send(3, { item: { id: 'b' } })
    gate.resolve()
    await Promise.all([first, second])

    assert.equal(initialCalls, 2)
    assert.equal(fixture.starts(), 1)
    assert.equal(fixture.shutdowns(), 1)
    assert.equal(replacementCalls, 2)
})

test('a timed-out non-idempotent add recovers the worker without replaying', async () => {
    let replacementCalls = 0
    const fixture = recoveringFixture(
        async () => { throw timeoutError() },
        async () => { replacementCalls++; return '{"ok":true}' },
    )

    await assert.rejects(fixture.recovering.client.send(2, { text: 'Do not duplicate me' }), {
        code: 'BACKEND_REQUEST_TIMEOUT',
    })
    assert.equal(fixture.starts(), 1)
    assert.equal(fixture.shutdowns(), 1)
    assert.equal(replacementCalls, 0)
})
