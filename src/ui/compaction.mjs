// "Flatten history" — the owner-facing half of history compaction.
//
// Joining a long-lived project is O(entire history): a guest replays every node
// before it can write, and on a base that has rotated epochs it holds no key for
// most of what it replays. Compaction writes a full snapshot plus an
// owner-signed barrier so future joins read the snapshot instead.
//
// WHY THIS SURFACE EXISTS AT ALL, rather than the backend just doing it:
// compaction only helps peers that understand the barrier, and the owner is
// making a project-wide call. The gate is therefore observed, not assumed — the
// backend derives readiness from the synced presence channel, and this module's
// job is to SAY WHO is holding it back. A greyed-out button with no explanation
// would reproduce the 2026-07-28 failure in UI form: a readiness claim nobody
// could check.
//
// State is not owned here (see ./backup.mjs on measuring that first): readiness
// is read by the settings dialog and refreshed on open, so it lives on the
// shared `ui` object.
import { RPC_COMPACT_HISTORY } from '@listam/protocol'
import { resolvePeerDisplay } from '@listam/domain/peer-display'
import { h } from '../dom.mjs'

/**
 * @param {object} deps
 * @param {object} deps.client        backend RPC client (send returns the raw reply)
 * @param {object} deps.ui            shared renderer state; owns `compaction`
 * @param {object} deps.store         desktop store (pushNotice + getState for peer names)
 * @param {object} deps.locale        i18n holder ({ i18n })
 * @param {() => void} deps.renderAll
 * @param {() => void} deps.closeDialog
 */
export function createCompactionOps ({ client, ui, store, locale, renderAll, closeDialog }) {
    async function request (payload) {
        const raw = await client.send(RPC_COMPACT_HISTORY, payload)
        try { return raw ? JSON.parse(raw) : null } catch { return null }
    }

    // Ask the backend what it would do, without writing anything.
    async function refreshCompactionReadiness () {
        const res = await request({ dryRun: true })
        ui.compaction = res || null
        renderAll()
        return ui.compaction
    }

    // A readiness result is only a point-in-time observation. A peer may report
    // support while Settings is open, so a blocked-looking control must still be
    // useful: re-check on press and continue to the irreversible confirmation as
    // soon as the mesh is ready. This also gives an explicit notice when it is
    // still blocked instead of letting a disabled button silently swallow clicks.
    async function requestCompactionConfirmation (onConfirm) {
        const info = await refreshCompactionReadiness()
        if (info?.canCompact) {
            onConfirm?.()
            return true
        }
        store.pushNotice(
            info ? compactionStatusText() : compactionErrorMessage(),
            'error',
        )
        return false
    }

    // Name the devices that are not ready, using the same synced peer labels the
    // Peers list shows — a raw writer key here would be unactionable.
    function blockerNames (blockers) {
        const state = store.getState?.() || {}
        const roster = state.roster || {}
        const labels = state.peerLabels || {}
        return (blockers || []).map(({ writerKey }) => {
            const writer = (roster.writers || []).find((w) => w.writerKey === writerKey)
            // `.display`, not `.name` — `name` is the raw synced label and is
            // empty for a peer nobody has named, which would render the blocker
            // list as a row of blanks. `display` falls back to the short
            // fingerprint (or the self label), which is what the Peers list shows.
            return resolvePeerDisplay({
                key: writerKey,
                name: labels[writerKey] || null,
                isSelf: !!writer?.isSelf,
                isOwner: !!writer?.isOwner,
                selfLabel: locale.i18n.t('peers.you'),
            }).display
        })
    }

    function compactionStatusText () {
        const t = locale.i18n.t.bind(locale.i18n)
        const info = ui.compaction
        if (!info) return ''
        const { readiness } = info
        if (readiness?.ready) return t('compaction.ready')
        const blockers = readiness?.blockers || []
        if (!blockers.length) return t('compaction.notReadyUnknown')

        // The reason MATTERS, and the first version of this message threw it away:
        // it said "N of M devices are up to date… update them first" for all three
        // cases. For `no-presence` / `attested` that is wrong advice — the device
        // may be perfectly up to date and simply not have published a heartbeat
        // yet (it is offline, or was only just started). Sending someone to
        // re-update a current device is exactly the kind of unfalsifiable
        // instruction this whole surface exists to avoid.
        const outdated = blockers.filter((b) => b.reason === 'outdated')
        // 'attested' means the owner vouched for a device that never spoke for
        // itself, which for the user is the same situation as silence.
        const silent = blockers.filter((b) => b.reason !== 'outdated')
        const lines = [t('compaction.notReady', {
            ready: readiness?.readyCount ?? 0,
            total: readiness?.total ?? 0,
        })]
        if (outdated.length) lines.push(t('compaction.notReady.outdated', { devices: blockerNames(outdated).join(', ') }))
        if (silent.length) lines.push(t('compaction.notReady.silent', { devices: blockerNames(silent).join(', ') }))
        return lines.join(' ')
    }

    // Every refusal the user can act on gets its own message; anything else falls
    // back to the generic one rather than leaking a wire string into the UI.
    function compactionErrorMessage (reason) {
        const t = locale.i18n.t.bind(locale.i18n)
        switch (reason) {
            case 'mesh-not-ready': return t('compaction.error.meshNotReady')
            case 'not-owner': return t('compaction.error.notOwner')
            case 'not-writable': return t('compaction.error.notWritable')
            case 'nothing-to-compact': return t('compaction.error.nothingToCompact')
            case 'snapshot-failed':
            case 'barrier-failed': return t('compaction.error.writeFailed')
            default: return t('compaction.error.generic')
        }
    }

    async function runCompaction () {
        const t = locale.i18n.t.bind(locale.i18n)
        closeDialog()
        store.pushNotice(t('compaction.working'), 'info')
        const res = await request({})
        if (res?.ok) {
            store.pushNotice(t('compaction.done', { items: res.items ?? 0, lists: res.buckets ?? 0 }), 'success')
        } else {
            store.pushNotice(compactionErrorMessage(res?.reason), 'error')
        }
        await refreshCompactionReadiness()
    }

    // The owner-only Settings block, in the same shapes the rest of that dialog
    // uses (category-heading / label-md / choice-row). Returns null when the
    // backend has not answered yet, or when this device is not the owner — a
    // disabled button with no explanation is worse than no section at all.
    function renderCompactionSection ({ onConfirm, isOwner }) {
        const t = locale.i18n.t.bind(locale.i18n)
        const info = ui.compaction
        if (!info || !isOwner) return null

        const ready = !!info.canCompact
        return h('div', {},
            h('h3', { class: 'category-heading label-sm' }, t('compaction.title')),
            h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('compaction.explain')),
            h('p', {
                class: 'label-md',
                style: `color: var(--${ready ? 'secondary' : 'danger'});`,
            }, compactionStatusText()),
            h('div', { class: 'choice-row' },
                h('button', {
                    class: 'btn btn-secondary',
                    onclick: () => { void requestCompactionConfirmation(onConfirm) },
                }, t(ready ? 'compaction.action' : 'compaction.checkAgain')),
            ),
        )
    }

    return {
        refreshCompactionReadiness,
        requestCompactionConfirmation,
        runCompaction,
        renderCompactionSection,
        // Exported for the settings dialog and for tests.
        compactionStatusText,
        compactionErrorMessage,
        blockerNames,
    }
}
