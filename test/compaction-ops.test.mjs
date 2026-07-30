// The "flatten history" surface, minus its DOM half.
//
// Worth testing beyond the usual refactor argument: this is the code that
// decides whether the owner is TOLD the mesh is ready. Compaction cannot fork a
// peer that ignores the barrier, but a readiness claim the user cannot check is
// exactly the shape of the 2026-07-28 near-fork — a note asserting the mesh was
// updated when one peer was not. So the assertions below are mostly about the
// message, not the mechanism.
import test from 'node:test'
import assert from 'node:assert/strict'
import { RPC_COMPACT_HISTORY } from '@listam/protocol'
import { createCompactionOps } from '../src/ui/compaction.mjs'

const OWNER = '11'.repeat(32)
const PHONE = '22'.repeat(32)
const PI = '33'.repeat(32)

function harness (reply, { roster, peerLabels } = {}) {
    const sent = []
    const notices = []
    const ui = {}
    let renders = 0
    const ops = createCompactionOps({
        client: {
            send: async (command, payload) => {
                sent.push({ command, payload })
                const value = typeof reply === 'function' ? reply(payload) : reply
                return value === undefined ? null : JSON.stringify(value)
            },
        },
        ui,
        store: {
            pushNotice: (text, kind) => notices.push({ text, kind }),
            getState: () => ({
                roster: roster || { writers: [{ writerKey: OWNER, isSelf: true, isOwner: true }, { writerKey: PI }] },
                peerLabels: peerLabels || {},
            }),
        },
        // Echo the key and params so assertions read the intent, not a catalog.
        locale: { i18n: { t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) } },
        renderAll: () => { renders++ },
        closeDialog: () => {},
    })
    return { ops, sent, notices, ui, renders: () => renders }
}

test('readiness is fetched as a dry run, so asking never writes anything', async () => {
    const { ops, sent } = harness({ ok: false, reason: 'dry-run', canCompact: true, readiness: { ready: true, total: 2, readyCount: 2, blockers: [] } })
    await ops.refreshCompactionReadiness()

    assert.equal(sent.length, 1)
    assert.equal(sent[0].command, RPC_COMPACT_HISTORY)
    assert.deepEqual(sent[0].payload, { dryRun: true })
})

test('a blocked flatten names the device holding it back, by its synced label', async () => {
    const { ops } = harness(
        {
            ok: false,
            reason: 'dry-run',
            canCompact: false,
            readiness: { ready: false, total: 3, readyCount: 2, blockers: [{ writerKey: PI, reason: 'outdated' }] },
        },
        { peerLabels: { [PI]: 'pi-headless' } },
    )
    await ops.refreshCompactionReadiness()

    const text = ops.compactionStatusText()
    assert.match(text, /compaction\.notReady:/)
    assert.match(text, /pi-headless/, 'the user cannot act on a message that omits the device')
    assert.match(text, /"ready":2/)
    assert.match(text, /"total":3/)
})

test('an outdated blocker is told to update; a silent one is not', async () => {
    // The reason used to be discarded, so every blocker got "update them first" —
    // wrong, and unfalsifiable, for a device that is current but simply has not
    // published a heartbeat yet (offline, or only just started).
    const { ops } = harness(
        {
            ok: false,
            reason: 'dry-run',
            canCompact: false,
            readiness: {
                ready: false,
                total: 4,
                readyCount: 2,
                blockers: [{ writerKey: PI, reason: 'outdated' }, { writerKey: PHONE, reason: 'no-presence' }],
            },
        },
        { peerLabels: { [PI]: 'pi-headless', [PHONE]: 'gioieiere' } },
    )
    await ops.refreshCompactionReadiness()

    // The stub `t` echoes `key:{params}`, so each reason line carries exactly the
    // device names it was handed — which is the property under test.
    const lines = ops.compactionStatusText().split(' compaction.').map((part, i) => (i === 0 ? part : `compaction.${part}`))
    const outdated = lines.find((line) => line.startsWith('compaction.notReady.outdated'))
    const silent = lines.find((line) => line.startsWith('compaction.notReady.silent'))
    assert.ok(outdated, 'the out-of-date device must get its own instruction')
    assert.ok(silent, 'the silent device must get its own instruction')
    assert.match(outdated, /pi-headless/)
    assert.doesNotMatch(outdated, /gioieiere/, 'a silent device must not be reported as out of date')
    assert.match(silent, /gioieiere/)
    assert.doesNotMatch(silent, /pi-headless/)
})

test('an owner-attested blocker reads as silence, not as an old build', async () => {
    // `attested` means the owner vouched for a device that never spoke for itself.
    // For the user that is the same situation as no presence at all — there is
    // nothing to update.
    const { ops } = harness({
        ok: false,
        reason: 'dry-run',
        canCompact: false,
        readiness: { ready: false, total: 2, readyCount: 1, blockers: [{ writerKey: PHONE, reason: 'attested' }] },
    })
    await ops.refreshCompactionReadiness()

    const text = ops.compactionStatusText()
    assert.match(text, /compaction\.notReady\.silent:/)
    assert.doesNotMatch(text, /compaction\.notReady\.outdated/)
})

test('a blocker with no synced label still gets a usable name, never a bare key', async () => {
    const { ops } = harness({
        ok: false,
        reason: 'dry-run',
        canCompact: false,
        readiness: { ready: false, total: 2, readyCount: 1, blockers: [{ writerKey: PHONE, reason: 'no-presence' }] },
    })
    await ops.refreshCompactionReadiness()

    const names = ops.blockerNames([{ writerKey: PHONE }])
    assert.equal(names.length, 1)
    assert.ok(names[0], 'an unnamed peer produced an empty label')
    assert.notEqual(names[0], PHONE, 'showed the raw 64-char writer key')
})

test('a ready mesh reports ready rather than an empty blocker list', async () => {
    const { ops } = harness({ ok: false, reason: 'dry-run', canCompact: true, readiness: { ready: true, total: 2, readyCount: 2, blockers: [] } })
    await ops.refreshCompactionReadiness()
    assert.equal(ops.compactionStatusText(), 'compaction.ready')
})

test('running a flatten reports what it actually compacted', async () => {
    const { ops, notices, sent } = harness((payload) => (
        payload?.dryRun
            ? { ok: false, reason: 'dry-run', canCompact: true, readiness: { ready: true, total: 2, readyCount: 2, blockers: [] } }
            : { ok: true, sequence: 4, buckets: 3, items: 120 }
    ))
    await ops.runCompaction()

    assert.deepEqual(sent[0].payload, {}, 'the real run must not be a dry run')
    const success = notices.find((n) => n.kind === 'success')
    assert.match(success.text, /compaction\.done:/)
    assert.match(success.text, /"items":120/)
    assert.match(success.text, /"lists":3/)
})

test('a flatten refused mid-flight is surfaced with its reason, not as success', async () => {
    // The backend re-checks readiness at write time, so a device can drop out
    // between the dry run and the button press.
    const { ops, notices } = harness((payload) => (
        payload?.dryRun
            ? { ok: false, reason: 'dry-run', canCompact: true, readiness: { ready: true, total: 2, readyCount: 2, blockers: [] } }
            : { ok: false, reason: 'mesh-not-ready' }
    ))
    await ops.runCompaction()

    assert.equal(notices.some((n) => n.kind === 'success'), false)
    assert.equal(notices.find((n) => n.kind === 'error').text, 'compaction.error.meshNotReady')
})

test('a failed write is never reported as a compaction', async () => {
    const { ops, notices } = harness((payload) => (
        payload?.dryRun ? { ok: false, reason: 'dry-run', canCompact: true, readiness: { ready: true } } : { ok: false, reason: 'snapshot-failed' }
    ))
    await ops.runCompaction()
    assert.equal(notices.find((n) => n.kind === 'error').text, 'compaction.error.writeFailed')
})

test('an unknown refusal falls back to the generic message rather than a wire string', async () => {
    const { ops } = harness(null)
    assert.equal(ops.compactionErrorMessage('some-new-backend-reason'), 'compaction.error.generic')
    assert.equal(ops.compactionErrorMessage(undefined), 'compaction.error.generic')
})

test('a dropped reply leaves readiness null instead of claiming ready', async () => {
    const { ops, ui } = harness(undefined)
    await ops.refreshCompactionReadiness()
    assert.equal(ui.compaction, null)
    assert.equal(ops.compactionStatusText(), '')
})
