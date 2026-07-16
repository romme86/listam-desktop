import test from 'node:test'
import assert from 'node:assert/strict'
import { installSyncRecovery } from '../src/sync-recovery.mjs'

function eventTarget(initial = {}) {
    const listeners = new Map()
    return {
        ...initial,
        addEventListener(type, listener) { listeners.set(type, listener) },
        removeEventListener(type, listener) {
            if (listeners.get(type) === listener) listeners.delete(type)
        },
        emit(type) { return listeners.get(type)?.() },
        has(type) { return listeners.has(type) },
    }
}

test('sync recovery refreshes periodically and when a visible app resumes', async () => {
    const windowTarget = eventTarget()
    const documentTarget = eventTarget({ visibilityState: 'visible' })
    let intervalCallback
    let calls = 0
    const recovery = installSyncRecovery({
        requestSync: async () => { calls++ },
        windowTarget,
        documentTarget,
        setIntervalFn(callback) { intervalCallback = callback; return 7 },
        clearIntervalFn() {},
    })

    await recovery.refresh()
    assert.equal(calls, 1)

    await intervalCallback()
    assert.equal(calls, 2)

    documentTarget.visibilityState = 'hidden'
    await intervalCallback()
    assert.equal(calls, 2, 'hidden windows do not poll')

    documentTarget.visibilityState = 'visible'
    await documentTarget.emit('visibilitychange')
    assert.equal(calls, 3)

    recovery.dispose()
    assert.equal(windowTarget.has('focus'), false)
    assert.equal(documentTarget.has('visibilitychange'), false)
})

test('sync recovery coalesces concurrent repair requests', async () => {
    let release
    let calls = 0
    const pending = new Promise((resolve) => { release = resolve })
    const recovery = installSyncRecovery({
        requestSync: () => { calls++; return pending },
        windowTarget: null,
        documentTarget: null,
        setIntervalFn: null,
    })

    const first = recovery.refresh()
    const second = recovery.refresh()
    await Promise.resolve()
    assert.equal(calls, 1)
    assert.equal(first, second)
    release()
    await first
})
