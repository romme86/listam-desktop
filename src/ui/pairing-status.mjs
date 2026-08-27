// Pure projections for the pairing surfaces the 2026-08-26 4G failure exposed:
// the invite a sharer is looking at, the progress of a join in flight, the
// reason one failed, and what the transport is actually doing.
//
// None of this touches the DOM, so the rendering in ui.mjs stays a thin map from
// these shapes to elements and the logic itself is testable (desktop tests have
// no DOM). The backend already publishes every fact used here — this file only
// decides what a person should be told about it.

// A join that has been pairing this long is not "about to work": on carrier NAT
// it is either being relayed or it is going to hit the 120s deadline. Saying so
// is the difference between waiting on purpose and waiting in the dark.
export const JOIN_SLOW_HINT_MS = 30000

// join-error.reason is machine-readable precisely so the UI never has to echo
// the backend's English Error message. Every reason the backend can emit is
// mapped; an unmapped one degrades to the generic advice rather than to silence.
const JOIN_ERROR_KEYS = Object.freeze({
    'timeout': 'joining.failed.timeout',
    'invite-used': 'joining.failed.inviteUsed',
    'invite-expired': 'joining.failed.inviteExpired',
    'invite-invalid': 'joining.failed.inviteInvalid',
    'rejected': 'joining.failed.rejected',
    'no-network': 'joining.failed.noNetwork',
    'cancelled': 'joining.failed.cancelled',
    'incomplete-credentials': 'joining.failed.incompleteCredentials',
    'unknown': 'joining.failed.unknown',
})

/**
 * i18n key for a `join-error` reason.
 *
 * @param {unknown} reason
 * @returns {string}
 */
export function joinErrorKey (reason) {
    return (typeof reason === 'string' && JOIN_ERROR_KEYS[reason]) || JOIN_ERROR_KEYS.unknown
}

/**
 * What the join overlay should say about a `join-progress` heartbeat.
 *
 * @param {{ elapsedMs?: number, randomized?: boolean|null }|null|undefined} progress
 * @param {{ slowAfterMs?: number }} [options]
 * @returns {{ seconds: number, slow: boolean, relayed: boolean }|null}
 */
export function describeJoinProgress (progress, { slowAfterMs = JOIN_SLOW_HINT_MS } = {}) {
    if (!progress || typeof progress !== 'object') return null
    const elapsedMs = Number.isFinite(progress.elapsedMs) ? Math.max(0, progress.elapsedMs) : 0
    return {
        seconds: Math.floor(elapsedMs / 1000),
        slow: elapsedMs >= slowAfterMs,
        // `randomized` is the carrier-NAT tell: the NAT assigns a fresh port per
        // destination, so hyperdht cannot punch and the connection must be
        // relayed. Only an explicit true says so — null means "not known yet".
        relayed: progress.randomized === true,
    }
}

// Which join phases RPC_CANCEL_JOIN can actually abort. cancelJoinViaInvite
// holds an abort handle only for the 'pairing' wait (@listam/backend
// lib/network.mjs:1228); once pairing succeeds the guest is mid base-swap under
// 'permission' / 'syncing' and a cancel is a silent no-op. Offering — or acting
// on — a Stop there would tear down the loading pane while the base underneath
// is still being replaced, and would lift the isJoining guard that keeps the
// command palette from starting a second join.
const UNCANCELLABLE_JOIN_PHASES = Object.freeze(['permission', 'syncing'])

/**
 * @param {string|null|undefined} phase
 * @returns {boolean}
 */
export function canCancelJoin (phase) {
    return !UNCANCELLABLE_JOIN_PHASES.includes(phase ?? '')
}

/**
 * m:ss for an invite countdown. Deliberately not localized: it is a clock
 * readout, and every catalog renders it the same way.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatCountdown (ms) {
    const total = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000))
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * What the sharer should see next to a code. The envelope's facts — single-use,
 * a ~10 minute expiry, and how many codes are live — were invisible before, so
 * "the code stopped working" read as a bug rather than as an expiry, and minting
 * a code for a second friend silently killed the first one's.
 *
 * @param {{ key?: string, expiresAt?: number|null, singleUse?: boolean, liveInvites?: number }|null|undefined} invite
 * @param {number} now
 * @returns {{ code: string, hasExpiry: boolean, expired: boolean, remainingMs: number,
 *             countdown: string, singleUse: boolean, liveInvites: number }}
 */
export function describeInvite (invite, now) {
    const source = invite && typeof invite === 'object' ? invite : {}
    const code = typeof source.key === 'string' ? source.key : ''
    const singleUse = source.singleUse !== false
    if (!code) {
        return { code: '', hasExpiry: false, expired: false, remainingMs: 0, countdown: '', singleUse, liveInvites: 0 }
    }
    // An older backend answers RPC_GET_KEY with a bare z32 string and no expiry.
    // Absent is NOT expired — painting "expired" over a code that still works
    // would be a worse lie than showing no countdown at all.
    const hasExpiry = Number.isFinite(source.expiresAt) && source.expiresAt > 0
    const remainingMs = hasExpiry ? Math.max(0, source.expiresAt - now) : 0
    return {
        code,
        hasExpiry,
        expired: hasExpiry && remainingMs === 0,
        remainingMs,
        countdown: hasExpiry ? formatCountdown(remainingMs) : '',
        singleUse,
        liveInvites: Number.isFinite(source.liveInvites) ? Math.max(0, source.liveInvites) : 1,
    }
}

// Field order for the diagnostics dump. These stay untranslated on purpose:
// they are the transport's own names, and a copied diagnostic is only useful to
// whoever reads the backend logs next to it. The one sentence a *user* needs —
// "this network blocks direct connections" — is the translated `relayed` note.
const NET_DIAGNOSTIC_FIELDS = Object.freeze([
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

function formatDiagnosticValue (value) {
    if (value === null || value === undefined) return '—'
    return String(value)
}

/**
 * Turn an RPC_GET_NET_DIAGNOSTICS reply into rows plus the copyable text.
 *
 * @param {Record<string, unknown>|null|undefined} reply
 * @param {{ networkStatus?: string|null }} [context]
 * @returns {{ relayed: boolean, rows: Array<[string, string]>, text: string }|null}
 */
export function describeNetDiagnostics (reply, { networkStatus = null } = {}) {
    if (!reply || typeof reply !== 'object' || reply.ok !== true) return null
    const rows = /** @type {Array<[string, string]>} */ ([])
    // The status the backend last broadcast belongs in the dump: it is the value
    // behind the header dot, and a report that omits it cannot say whether this
    // device's own DHT was up when the pairing failed.
    if (networkStatus) rows.push(['networkStatus', networkStatus])
    for (const field of NET_DIAGNOSTIC_FIELDS) rows.push([field, formatDiagnosticValue(reply[field])])
    return {
        relayed: reply.randomized === true,
        rows,
        text: rows.map(([key, value]) => `${key}: ${value}`).join('\n'),
    }
}
