// Desktop UI state, fed exclusively by decoded @listam/client events so the
// projection logic matches the mobile Redux slices: the backend remains the
// source of truth, this store is the view of it. Item mutations go through
// @listam/domain's id-keyed reduction — the same code path mobile and the
// backend reduce with — so duplicate names never collapse by text.
//
// We hold a multi-list `createListReduction` rather than the single-list
// `applyOperationToList`: the latter re-buckets everything to 'default' and so
// silently drops any item whose listId differs (registry meta-items live under
// '__registry__', board tickets / named lists under their own ids). `allItems()`
// re-projects every bucket, so nothing is lost on an incremental event.
import { createListOperation, createListReduction } from '@listam/domain/list-reducer'
import { DEFAULT_LIST_ID, normalizeListId } from '@listam/domain/identity'
import { redactForLog, redactString } from '@listam/logging'
import { DEFAULT_LEAF_BRIDGE_PORT } from './leaf-bridge-config.mjs'

// Rebuild a reduction from a flat, possibly multi-list snapshot. Items are
// grouped by their normalized listId and replayed as per-list 'list' operations
// so each bucket keeps the snapshot order (a 'list' op appends in order, whereas
// 'add'/'update' prepend). The grouping key MUST match the reduction's own
// normalizeListId — two 'list' ops for one bucket would clear and replace it.
// Exported so the mock backend can keep its own items multi-list too.
export function reductionFromItems(items) {
    const reduction = createListReduction()
    const groups = new Map()
    for (const item of Array.isArray(items) ? items : []) {
        const listId = normalizeListId(item?.listId)
        const group = groups.get(listId) ?? { listType: item?.listType, items: [] }
        group.items.push(item)
        groups.set(listId, group)
    }
    for (const [listId, group] of groups) {
        reduction.applyOperation(createListOperation('list', group.items, { listId, listType: group.listType }))
    }
    return reduction
}

const MAX_DIAGNOSTIC_EVENTS = 50
const MAX_NOTICES = 4

export const DEFAULT_PREFERENCES = Object.freeze({
    localeChoice: 'system',
    isGridView: false,
    categoriesEnabled: true,
    categoryHeaders: true,
    theme: 'system',
    showKeyHints: true,
    // Per-device gate for the "New board" create option. Off by default; never
    // replicated (prefs are device-local). Hides board *creation*, not existing
    // boards synced from other peers.
    boardEnabled: false,
    // Which list opens on launch — a per-device launch preference (mirrors the
    // mobile/headless `defaultListId`), resolved against the synced registry via
    // resolveLaunchList. Not replicated.
    defaultListId: DEFAULT_LIST_ID,
    // Which (listId:type) SURFACE opens on launch — needed because the three
    // built-in surfaces (Groceries/Board/Todo) share listId 'default', so
    // defaultListId alone can't distinguish them. Takes precedence over
    // defaultListId in ensureActiveList. '' = fall back to defaultListId.
    // Device-local; must stay a string ('' not null) so prefs.mjs's typeof
    // type-guard preserves it.
    defaultSurfaceKey: '',
    // This device's human-readable name, advertised to other peers via a synced
    // peer-label item (see @listam/domain/labels). Device-local source of truth
    // for the Settings input and for re-asserting the label once this device's
    // writer key is known. '' = not named yet.
    deviceName: '',
    leafBridgeEnabled: false,
    leafBridgePort: DEFAULT_LEAF_BRIDGE_PORT,
})

export function createDesktopStore(initial = {}) {
    let noticeId = 0
    // Persistent id-keyed reduction across all list buckets; the source of
    // `state.items`. Rebuilt on each full sync and on reset.
    let reduction = createListReduction()
    let state = {
        items: [],
        inviteKey: '',
        peerCount: 0,
        joinPhase: null,
        isJoining: false,
        backendReady: false,
        roster: null,
        // Owner-signed board configuration pushed by the backend
        // (rigor mode, states, properties, rules, automations). null until the
        // first board-config message; selectors fall back to defaults.
        boardConfig: null,
        boardConfigCanAdminister: false,
        recovery: null,
        notices: [],
        diagnostics: [],
        // Live leaf-bridge state pushed by the backend worker; null until the
        // worker reports it. { running, port, controlKey, connections, error }
        leafBridge: null,
        preferences: { ...DEFAULT_PREFERENCES, ...(initial.preferences ?? {}) },
    }
    const listeners = new Set()

    function getState() {
        return state
    }

    function setState(partial) {
        state = { ...state, ...partial }
        for (const listener of listeners) listener(state)
    }

    function subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
    }

    function setPreferences(partial) {
        setState({ preferences: { ...state.preferences, ...partial } })
    }

    function pushNotice(text, tone = 'info') {
        const notice = { id: ++noticeId, text, tone }
        setState({ notices: [...state.notices, notice].slice(-MAX_NOTICES) })
        return notice.id
    }

    function dismissNotice(id) {
        setState({ notices: state.notices.filter((notice) => notice.id !== id) })
    }

    function recordDiagnostic(label, detail, now) {
        const entry = {
            at: now,
            label: redactString(label),
            detail: detail === undefined ? undefined : redactForLog(detail),
        }
        return [...state.diagnostics, entry].slice(-MAX_DIAGNOSTIC_EVENTS)
    }

    // Reduce one decoded backend event into state. `now` is injected so tests
    // are deterministic. Returns the diagnostic label recorded, or null when
    // the event type is unknown.
    function applyClientEvent(event, now = 0) {
        switch (event.type) {
            case 'sync-list': {
                // A full snapshot — reset the reduction so a re-sync replaces
                // rather than appends, then re-project every list bucket.
                reduction = reductionFromItems(event.items)
                const items = reduction.allItems()
                setState({ items, diagnostics: recordDiagnostic(`sync-list (${items.length} items)`, undefined, now) })
                return 'sync-list'
            }
            case 'add-from-backend':
            case 'update-from-backend':
            case 'delete-from-backend': {
                const type = event.type.split('-')[0]
                reduction.applyOperation({ type, value: event.item })
                setState({
                    items: reduction.allItems(),
                    diagnostics: recordDiagnostic(event.type, undefined, now),
                })
                return event.type
            }
            case 'invite-key':
                setState({
                    inviteKey: event.key ?? '',
                    diagnostics: recordDiagnostic(event.key ? 'invite-key (rotated)' : 'invite-key (cleared)', undefined, now),
                })
                return 'invite-key'
            case 'reset':
                reduction = createListReduction()
                setState({
                    items: [],
                    inviteKey: '',
                    roster: null,
                    diagnostics: recordDiagnostic('reset', undefined, now),
                })
                return 'reset'
            case 'message':
                return applyMessagePayload(event.payload, now)
            case 'message-empty':
                return null
            default:
                setState({ diagnostics: recordDiagnostic(`unhandled:${event.type}`, undefined, now) })
                return null
        }
    }

    function applyMessagePayload(payload, now) {
        const type = payload?.type
        switch (type) {
            case 'peer-count':
                setState({
                    peerCount: typeof payload.count === 'number' ? payload.count : 0,
                    diagnostics: recordDiagnostic(`peer-count ${payload.count}`, undefined, now),
                })
                return type
            case 'join-phase':
                setState({
                    joinPhase: payload.phase || null,
                    diagnostics: recordDiagnostic(`join-phase ${payload.phase || 'cleared'}`, undefined, now),
                })
                return type
            case 'join-success':
                setState({
                    isJoining: false,
                    joinPhase: null,
                    diagnostics: recordDiagnostic('join-success', undefined, now),
                })
                return type
            case 'join-error':
                setState({
                    isJoining: false,
                    joinPhase: null,
                    diagnostics: recordDiagnostic('join-error', payload.message, now),
                })
                return type
            case 'not-writable':
                setState({ diagnostics: recordDiagnostic('not-writable', undefined, now) })
                return type
            case 'membership-roster':
                setState({
                    roster: payload.roster ?? null,
                    diagnostics: recordDiagnostic('membership-roster', undefined, now),
                })
                return type
            case 'board-config':
                setState({
                    boardConfig: payload.config ?? null,
                    boardConfigCanAdminister: !!payload.canAdminister,
                    diagnostics: recordDiagnostic('board-config', undefined, now),
                })
                return type
            case 'config-denied':
                setState({ diagnostics: recordDiagnostic('config-denied', payload.reason, now) })
                return type
            case 'recovery-required':
                setState({
                    recovery: { policy: payload.policy ?? 'interactive', reason: payload.reason ?? 'storage-corrupt' },
                    diagnostics: recordDiagnostic('recovery-required', payload.reason, now),
                })
                return type
            case 'recovery-complete':
                setState({
                    recovery: null,
                    diagnostics: recordDiagnostic(`recovery-complete (${payload.mode})`, undefined, now),
                })
                return type
            case 'recovery-failed':
                setState({ diagnostics: recordDiagnostic('recovery-failed', payload.reason, now) })
                return type
            case 'member-removed':
            case 'member-removal-failed':
            case 'member-removal-incomplete':
            case 'owner-recovery-code':
            case 'owner-recovered':
            case 'owner-recovery-failed':
                setState({ diagnostics: recordDiagnostic(type, undefined, now) })
                return type
            default:
                setState({ diagnostics: recordDiagnostic(`message:${type ?? 'unknown'}`, undefined, now) })
                return null
        }
    }

    return {
        getState,
        subscribe,
        setState,
        setPreferences,
        pushNotice,
        dismissNotice,
        applyClientEvent,
    }
}

// Selectors shared by list and grid renderings.
export function selectSummary(items) {
    const total = items.length
    const done = items.filter((item) => item.isDone).length
    return { total, done, remaining: total - done }
}

export function selectDoneItems(items) {
    return items.filter((item) => item.isDone)
}
