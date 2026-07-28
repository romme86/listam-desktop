// The first test of code that used to live inside ui.mjs's mountApp closure.
//
// This is the point of Slice 2: the status/refresh logic was previously
// unreachable from a test — not because it needed a DOM, but because it was
// trapped in a 6k-line closure with no way in. As a factory it takes its
// collaborators as arguments, so a fake ownerControl can drive it in node.
//
// Only the non-DOM half is exercised here. The render functions call h(), which
// needs a document; those are covered by the DOM A/B in the mock preview and by
// the real-app pass (see test/DOM-SNAPSHOT.md).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServersSection } from '../src/ui/servers.mjs'

const KEY = 'aa'.repeat(32)

function harness ({ capabilities = ['status:read'], request } = {}) {
    const notices = []
    let renders = 0
    const section = createServersSection({
        ownerControl: {
            listServers: () => [{ serverPublicKeyHex: KEY, name: 'geekom', capabilities }],
            request,
            pair: async () => ({ ok: true }),
        },
        store: { pushNotice: (message, kind) => notices.push({ message, kind }) },
        locale: { i18n: { t: (key) => key } },
        now: () => 1_000,
        renderAll: () => { renders += 1 },
        openDialog: () => {},
        closeDialog: () => {},
        copyText: async () => {},
    })
    return { section, notices, renders: () => renders }
}

test('a successful status refresh caches the status and clears busy', async () => {
    const { section, renders } = harness({ request: async () => ({ ok: true, status: { peerCount: 3 } }) })
    await section.refreshServer(KEY)
    assert.deepEqual(section.state[KEY], {
        busy: false, status: { peerCount: 3 }, error: null, fetchedAt: 1_000,
    })
    assert.ok(renders() >= 1, 'the pane must be re-rendered once the status lands')
})

test('a refused status is recorded as an error with NO stale status left behind', async () => {
    const { section } = harness({ request: async () => ({ ok: false, reason: 'denied' }) })
    // Seed a previous good status, so this proves the failure path CLEARS it.
    section.state[KEY] = { status: { peerCount: 9 }, error: null }
    await section.refreshServer(KEY)
    assert.equal(section.state[KEY].status, undefined, 'a card must not show stats from a poll that failed')
    assert.equal(section.state[KEY].error, 'denied')
    assert.equal(section.state[KEY].busy, false)
})

test('a thrown request is caught and surfaces as an error, not an unhandled rejection', async () => {
    const { section } = harness({ request: async () => { throw new Error('dht timeout') } })
    await section.refreshServer(KEY)
    assert.equal(section.state[KEY].error, 'dht timeout')
    assert.equal(section.state[KEY].busy, false)
})

test('the busy flag blocks an overlapping poll', async () => {
    // The 20s auto-poll and a manual click can race; the second must be dropped
    // rather than firing a duplicate round-trip.
    let calls = 0
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const { section } = harness({ request: async () => { calls += 1; await gate; return { ok: true, status: {} } } })

    // Deliberately NOT `await section.refreshServer(...)` for the second call.
    // Awaiting it means that if the guard is ever removed, the second call waits
    // on a gate this test only releases afterwards — so the regression would
    // present as a HANG instead of a failed assertion, which reads like broken
    // infrastructure rather than a broken guard. Kick both off, let the
    // synchronous prefix run, then assert on the call count.
    const first = section.refreshServer(KEY)
    const second = section.refreshServer(KEY)
    await Promise.resolve()
    assert.equal(calls, 1, 'the second call must not reach ownerControl while the first is in flight')

    release()
    await Promise.all([first, second])
    assert.equal(section.state[KEY].busy, false)
})

test('a server without status:read is never polled at all', async () => {
    let calls = 0
    const { section } = harness({
        capabilities: ['invite:create'],
        request: async () => { calls += 1; return { ok: true, status: {} } },
    })
    await section.refreshServer(KEY)
    assert.equal(calls, 0, 'polling a server that would reject the request is pointless')
    assert.equal(section.state[KEY], undefined, 'and it must not leave a phantom entry')
})

test('a resolving poll does not clobber an invite minted while it was in flight', async () => {
    // The regression this guards: refreshServer used to write back its pre-await
    // snapshot, so an invite arriving mid-round-trip was lost.
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const { section } = harness({ request: async () => { await gate; return { ok: true, status: { peerCount: 1 } } } })

    const inFlight = section.refreshServer(KEY)
    section.state[KEY] = { ...section.state[KEY], invite: 'minted-while-polling' }
    release()
    await inFlight

    assert.equal(section.state[KEY].invite, 'minted-while-polling', 'the poll owns busy/status/error/fetchedAt only')
    assert.deepEqual(section.state[KEY].status, { peerCount: 1 })
})

test('shutdown drops the cached status AND the minted invite', async () => {
    const { section, notices } = harness({ request: async () => ({ ok: true }) })
    section.state[KEY] = { status: { peerCount: 2 }, error: 'old', invite: 'single-use-code' }
    await section.shutdownServer(KEY)
    // A single-use code is useless once the peer is gone, and stale stats would
    // read as "still online".
    assert.equal(section.state[KEY].status, undefined)
    assert.equal(section.state[KEY].invite, undefined)
    assert.equal(section.state[KEY].error, null)
    assert.ok(notices.some((n) => n.kind === 'success'))
})

test('serverCan reads the live capability list', () => {
    const { section } = harness({ capabilities: ['status:read', 'service:shutdown'], request: async () => ({ ok: true }) })
    assert.equal(section.serverCan(KEY, 'service:shutdown'), true)
    assert.equal(section.serverCan(KEY, 'export:create'), false)
    assert.equal(section.serverCan('unknown-key', 'status:read'), false)
})

test('with no ownerControl every entry point is inert rather than throwing', async () => {
    // This is the state the browser preview and any non-Pear runtime are in.
    const section = createServersSection({
        ownerControl: null,
        store: { pushNotice: () => {} },
        locale: { i18n: { t: (key) => key } },
        now: () => 0,
        renderAll: () => { throw new Error('must not re-render when there is nothing to show') },
        openDialog: () => {},
        closeDialog: () => {},
        copyText: async () => {},
    })
    await section.refreshServer(KEY)
    section.refreshAllServers()
    assert.deepEqual(section.state, {})
})
