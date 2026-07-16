import test from 'node:test'
import assert from 'node:assert/strict'

import { createVoiceHost, mutationOk } from '../src/voice-host-worker.mjs'

test('voice mutation requires an explicit successful backend acknowledgement', () => {
    assert.equal(mutationOk(JSON.stringify({ ok: true })), true)
    assert.equal(mutationOk({ ok: true }), true)

    assert.equal(mutationOk(JSON.stringify({ ok: false, reason: 'mutation-refused' })), false)
    assert.equal(mutationOk(null), false)
    assert.equal(mutationOk(undefined), false)
    assert.equal(mutationOk(''), false)
    assert.equal(mutationOk('not-json'), false)
    assert.equal(mutationOk({}), false)
})

test('voice startup persists the reason when the configured model is missing', async () => {
    const writes = []
    const host = createVoiceHost({
        callBackend: async () => JSON.stringify({ ok: true }),
        load: async () => ({
            fs: {
                writeFileSync: (path, contents) => writes.push({ path, contents }),
                statSync: () => { throw new Error('missing') },
            },
            tmpDir: '/app-storage',
            createStt: () => ({ available: async () => false }),
        }),
    })

    const status = await host.start({ modelPath: '/tmp/whisper.cpp/models/ggml-medium.bin' })

    assert.equal(status.running, false)
    assert.match(status.error, /whisper model not found/)
    assert.equal(writes.at(-1).path, '/app-storage/voice.log')
    assert.match(writes.at(-1).contents, /start failed.*whisper model not found/)
})
