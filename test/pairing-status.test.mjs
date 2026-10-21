// The pairing surfaces the 2026-08-26 4G failure exposed, tested where they are
// testable: pure projections, no DOM (desktop tests have none). The rendering in
// src/ui.mjs is a thin map from these shapes to elements, so covering the shapes
// covers what a person actually gets told.
import test from 'node:test'
import assert from 'node:assert/strict'
import { catalogByLocale, SUPPORTED_UI_LOCALES } from '@listam/i18n'
import {
    JOIN_SLOW_HINT_MS,
    joinErrorKey,
    canCancelJoin,
    describeJoinProgress,
    describeInvite,
    describeNetDiagnostics,
    formatCountdown,
} from '../src/ui/pairing-status.mjs'

// Every reason @listam/backend can put on a `join-error` broadcast.
const BACKEND_JOIN_REASONS = [
    'timeout',
    'invite-used',
    'invite-expired',
    'rejected',
    'invite-invalid',
    'no-network',
    'cancelled',
    'incomplete-credentials',
    'unknown',
    'not-ready',
    'join-timeout',
    'cannot-join-builtin',
    'list-id-conflict',
    'registry-write-failed',
]

test('every join-error reason resolves to a distinct catalog key', () => {
    const keys = BACKEND_JOIN_REASONS.map(joinErrorKey)
    assert.equal(new Set(keys).size, keys.length, 'each reason must say something different')
})

test('an unknown or missing reason degrades to the generic advice, never to silence', () => {
    for (const reason of ['something-new', '', null, undefined, 42]) {
        assert.equal(joinErrorKey(reason), 'joining.failed.unknown')
    }
})

test('every key these surfaces render exists in all six catalogs', () => {
    // A typo here does not throw — i18n falls back to echoing the raw key, so a
    // user gets "joining.failed.timeout" on screen. The gate has to be a test.
    const used = [
        ...BACKEND_JOIN_REASONS.map(joinErrorKey),
        'joining.elapsed',
        'joining.hint.slow',
        'joining.hint.relayed',
        'joining.cancel',
        'invite.singleUse',
        'invite.expiresIn',
        'invite.expired',
        'invite.regenerate',
        ...Object.keys(catalogByLocale.en).filter((key) => key.startsWith('invite.batch.')),
        'network.diagnostics.title',
        'network.diagnostics.relayed',
        'network.diagnostics.copy',
        'network.diagnostics.copied',
    ]
    for (const locale of SUPPORTED_UI_LOCALES) {
        const catalog = catalogByLocale[locale]
        const missing = used.filter((key) => typeof catalog[key] !== 'string' && typeof catalog[key] !== 'object')
        assert.deepEqual(missing, [], `${locale} is missing: ${missing.join(', ')}`)
    }
})

test('join progress reports elapsed seconds and escalates to the slow hint', () => {
    assert.equal(describeJoinProgress(null), null)

    const early = describeJoinProgress({ elapsedMs: 10000, randomized: null })
    assert.deepEqual(early, { seconds: 10, slow: false, relayed: false })

    const late = describeJoinProgress({ elapsedMs: JOIN_SLOW_HINT_MS, randomized: null })
    assert.equal(late.slow, true)
})

test('only an explicit randomized:true claims the connection is relayed', () => {
    // null is "the DHT has not answered yet", not "direct connections work".
    // Telling a user their network blocks direct connections on a null would be
    // guessing at exactly the fact they came to this screen to learn.
    assert.equal(describeJoinProgress({ elapsedMs: 0, randomized: null }).relayed, false)
    assert.equal(describeJoinProgress({ elapsedMs: 0, randomized: false }).relayed, false)
    assert.equal(describeJoinProgress({ elapsedMs: 0 }).relayed, false)
    assert.equal(describeJoinProgress({ elapsedMs: 0, randomized: true }).relayed, true)
})

test('a garbled heartbeat still renders a zeroed line rather than throwing', () => {
    assert.deepEqual(describeJoinProgress({ elapsedMs: -5 }), { seconds: 0, slow: false, relayed: false })
    assert.deepEqual(describeJoinProgress({}), { seconds: 0, slow: false, relayed: false })
})

test('formatCountdown pads seconds so the readout never jumps width', () => {
    assert.equal(formatCountdown(600000), '10:00')
    assert.equal(formatCountdown(65000), '1:05')
    assert.equal(formatCountdown(9000), '0:09')
    assert.equal(formatCountdown(0), '0:00')
    assert.equal(formatCountdown(-1), '0:00')
})

test('a live invite carries its countdown, its single-use flag and the live count', () => {
    const now = 1_000_000
    const invite = describeInvite({
        key: 'z32code',
        expiresAt: now + 245000,
        singleUse: true,
        liveInvites: 3,
    }, now)

    assert.equal(invite.code, 'z32code')
    assert.equal(invite.expired, false)
    assert.equal(invite.hasExpiry, true)
    assert.equal(invite.countdown, '4:05')
    assert.equal(invite.singleUse, true)
    assert.equal(invite.liveInvites, 3)
})

test('a code whose expiry has passed reads as expired, not as a working QR', () => {
    const now = 1_000_000
    const invite = describeInvite({ key: 'z32code', expiresAt: now - 1 }, now)
    assert.equal(invite.expired, true)
    assert.equal(invite.remainingMs, 0)
})

test('a legacy bare-string invite has no expiry, which is NOT expired', () => {
    // An older backend answers RPC_GET_KEY with a raw z32 code. Painting
    // "expired" over a code that still works would be a worse lie than showing
    // no countdown at all.
    const invite = describeInvite({ key: 'z32code', expiresAt: null }, 1_000_000)
    assert.equal(invite.hasExpiry, false)
    assert.equal(invite.expired, false)
    assert.equal(invite.countdown, '')
    assert.equal(invite.liveInvites, 1)
})

test('no invite yet renders as no code rather than as an expired one', () => {
    for (const value of [null, undefined, {}, { key: '' }]) {
        const invite = describeInvite(value, 1_000_000)
        assert.equal(invite.code, '')
        assert.equal(invite.expired, false)
        assert.equal(invite.liveInvites, 0)
    }
})

test('net diagnostics keep the backend field names and include the broadcast status', () => {
    const described = describeNetDiagnostics({
        ok: true,
        bootstrapped: true,
        online: true,
        firewalled: true,
        randomized: true,
        punches: 0,
        relaying: 2,
        relayConfigured: 1,
        tempConnections: 0,
        mainConnections: 3,
    }, { networkStatus: 'online' })

    assert.equal(described.relayed, true)
    assert.deepEqual(described.rows[0], ['networkStatus', 'online'])
    assert.deepEqual(described.rows.map(([key]) => key), [
        'networkStatus',
        'bootstrapped',
        'online',
        'firewalled',
        'randomized',
        'punches',
        'relaying',
        'relayConfigured',
        'tempConnections',
        'mainConnections',
    ])
    assert.match(described.text, /^networkStatus: online\n/)
    assert.match(described.text, /randomized: true/)
})

test('an unknown transport field renders as a dash, not as false', () => {
    // firewalled/randomized are null until the DHT answers. Rendering that as
    // "false" would assert the opposite of what is known.
    const described = describeNetDiagnostics({ ok: true, randomized: null, punches: 0 })
    assert.deepEqual(described.rows.find(([key]) => key === 'randomized'), ['randomized', '—'])
    assert.deepEqual(described.rows.find(([key]) => key === 'punches'), ['punches', '0'])
    assert.equal(described.relayed, false)
})

test('a failed or missing diagnostics reply yields nothing to render', () => {
    for (const reply of [null, undefined, {}, { ok: false }, 'nope']) {
        assert.equal(describeNetDiagnostics(reply), null)
    }
})

test('only the pairing wait is cancellable — a base swap in progress is not', () => {
    // RPC_CANCEL_JOIN can abort the 'pairing' wait and nothing else
    // (@listam/backend cancelJoinViaInvite, lib/network.mjs:1228). Past that the
    // guest is mid base-swap: the reply comes back { cancelled: false }, and a UI
    // that dismissed the loading pane on it would hand the workspace — and the
    // isJoining-gated ⌘K palette — to a user whose base is still being replaced.
    assert.equal(canCancelJoin('pairing'), true)
    assert.equal(canCancelJoin(null), true)
    assert.equal(canCancelJoin(undefined), true)
    assert.equal(canCancelJoin('permission'), false)
    assert.equal(canCancelJoin('syncing'), false)
})

test('single-list invalid codes reuse the explicit invalid-invitation explanation', () => {
    assert.equal(joinErrorKey('bad-invite'), 'joining.failed.inviteInvalid')
})
