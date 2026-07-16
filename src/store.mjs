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
import { configureStore, createSlice } from '@reduxjs/toolkit'
import { DEFAULT_LEAF_BRIDGE_PORT } from './leaf-bridge-config.mjs'
import listsReducer, { initialListsState, listsActions, selectAllItems } from './store/lists-slice.mjs'
import syncReducer, { initialSyncState, syncActions } from './store/sync-slice.mjs'
import devicesReducer, { devicesActions, selectMembershipRoster } from './store/devices-slice.mjs'
import boardConfigReducer, { boardConfigActions } from './store/board-config-slice.mjs'
import labelsReducer, { labelsActions } from './store/labels-slice.mjs'
import presenceReducer, { presenceActions } from './store/presence-slice.mjs'

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

function sameSnapshot(left, right) {
    if (left === right) return true
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    for (let i = 0; i < left.length; i++) {
        if (left[i] === right[i]) continue
        if (JSON.stringify(left[i]) !== JSON.stringify(right[i])) return false
    }
    return true
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
    // Overview (day plan) layout: 'focus' (spotlight + today) or 'planner'
    // (today agenda + week rail). Device-local, never replicated.
    overviewView: 'focus',
    // Legacy launch-default prefs. The desktop now always opens with NO list
    // selected, so these are no longer applied; kept only so older persisted
    // preference blobs round-trip cleanly through prefs.mjs.
    defaultListId: DEFAULT_LIST_ID,
    defaultSurfaceKey: '',
    // The former built-in surfaces (Groceries/Board/Todo) are now ordinary
    // deletable lists inside the 'general' group. Since they share the legacy
    // 'default' listId and so have no registry meta-item to tombstone, deleting
    // one records its surfaceKey here (device-local) to hide it from this rail.
    hiddenBuiltins: [],
    // A built-in's group placement now syncs via the BUILTIN-GROUP label channel
    // (@listam/domain/labels). This map stays as a device-local cache + fallback
    // for the synced value: surfaceKey -> groupId. Absent / 'general' = default
    // home. Lets a built-in be dragged into another group like any registry list.
    builtinGroups: {},
    // One-time guard: republish any pre-sync `builtinGroups` (which only ever
    // lived in localStorage) to the synced channel so existing placements reach
    // other devices. Flipped true after the migration runs once.
    builtinGroupsMigrated: false,
    // Collapsed rail groups, device-local: groupId -> true. Absent means
    // expanded. When collapsed, the group's surface rows are hidden and its
    // header shows a single badge summing the surfaces' counts.
    collapsedGroups: {},
    // This device's human-readable name, advertised to other peers via a synced
    // peer-label item (see @listam/domain/labels). Device-local source of truth
    // for the Settings input and for re-asserting the label once this device's
    // writer key is known. '' = not named yet.
    deviceName: '',
    // One-time guard: a friendly default device name is seeded on first run so
    // peers aren't nameless. Set true after seeding so a cleared name isn't re-seeded.
    deviceNameSeeded: false,
    leafBridgeEnabled: false,
    leafBridgePort: DEFAULT_LEAF_BRIDGE_PORT,
    // Desktop-hosted voice (leaf streams audio here, the worker transcribes with
    // whisper via bare-subprocess and writes the item into THIS base). All
    // device-local. voiceModelPath must point at a multilingual GGML model
    // (ggml-medium.bin, not .en) for non-English — see voice-italian bug.
    voiceEnabled: false,
    voiceModelPath: '',
    // '' = track the UI locale (whisper gets -l <ui lang>); 'auto' = whisper
    // auto-detect; any other value forces that language. Default '' so an Italian
    // UI transcribes Italian without per-clip mis-detection to English.
    voiceLocale: '',
    voicePrompt: '',
})

const DEFAULT_RUNTIME_STATE = Object.freeze({
    notices: [],
    diagnostics: [],
    leafBridge: null,
    voice: null,
})

const RUNTIME_KEYS = [...Object.keys(DEFAULT_RUNTIME_STATE), 'bootError']

const runtimeSlice = createSlice({
    name: 'runtime',
    initialState: DEFAULT_RUNTIME_STATE,
    reducers: {
        noticePushed(state, action) {
            state.notices = [...state.notices, action.payload].slice(-MAX_NOTICES)
        },
        noticeDismissed(state, action) {
            state.notices = state.notices.filter((notice) => notice.id !== action.payload)
        },
        patched(state, action) {
            for (const key of RUNTIME_KEYS) {
                if (Object.prototype.hasOwnProperty.call(action.payload ?? {}, key)) state[key] = action.payload[key]
            }
        },
    },
})

const preferencesSlice = createSlice({
    name: 'preferences',
    initialState: DEFAULT_PREFERENCES,
    reducers: {
        patched(state, action) {
            Object.assign(state, action.payload)
        },
    },
})

export const desktopActions = Object.freeze({
    lists: listsActions,
    sync: syncActions,
    devices: devicesActions,
    boardConfig: boardConfigActions,
    labels: labelsActions,
    presence: presenceActions,
    runtimePatched: runtimeSlice.actions.patched,
    preferencesPatched: preferencesSlice.actions.patched,
    noticePushed: runtimeSlice.actions.noticePushed,
    noticeDismissed: runtimeSlice.actions.noticeDismissed,
})

// Public selector for consumers that want the historical flat desktop shape.
// New code can instead use store.reduxStore.getState() and select a named slice.
export function selectDesktopState(rootState) {
    return {
        items: [
            ...selectAllItems(rootState),
            ...Object.values(rootState.labels.itemsById),
            ...Object.values(rootState.presence.itemsById),
        ],
        inviteKey: rootState.sync.autobaseInviteKey,
        peerCount: rootState.sync.peerCount,
        baseId: rootState.sync.baseId,
        epoch: rootState.sync.epoch,
        joinPhase: rootState.sync.joinPhase,
        isJoining: rootState.sync.isJoining,
        backendReady: rootState.sync.isWorkletReady,
        synced: rootState.sync.hasReceivedSnapshot,
        roster: selectMembershipRoster(rootState),
        boardConfig: rootState.boardConfig.config,
        boardConfigCanAdminister: rootState.boardConfig.canAdminister,
        recovery: rootState.sync.recovery,
        writeBlock: rootState.sync.writeBlock,
        ...rootState.runtime,
        preferences: rootState.preferences,
    }
}

export function createDesktopStore(initial = {}) {
    let noticeId = 0
    const reduxStore = configureStore({
        reducer: {
            lists: listsReducer,
            sync: syncReducer,
            devices: devicesReducer,
            boardConfig: boardConfigReducer,
            labels: labelsReducer,
            presence: presenceReducer,
            runtime: runtimeSlice.reducer,
            preferences: preferencesSlice.reducer,
        },
        preloadedState: {
            lists: initialListsState,
            sync: { ...initialSyncState },
            runtime: { ...DEFAULT_RUNTIME_STATE },
            preferences: { ...DEFAULT_PREFERENCES, ...(initial.preferences ?? {}) },
        },
    })
    const listeners = new Set()
    let transactionDepth = 0
    let transactionDirty = false
    let lastCompatibilityState = selectDesktopState(reduxStore.getState())

    function notifyCompatibilityListeners() {
        const next = selectDesktopState(reduxStore.getState())
        if (JSON.stringify(lastCompatibilityState) === JSON.stringify(next)) return
        lastCompatibilityState = next
        for (const listener of listeners) listener(next)
    }

    reduxStore.subscribe(() => {
        if (transactionDepth > 0) {
            transactionDirty = true
            return
        }
        notifyCompatibilityListeners()
    })

    function transaction(callback) {
        transactionDepth++
        try {
            return callback()
        } finally {
            transactionDepth--
            if (transactionDepth === 0 && transactionDirty) {
                transactionDirty = false
                notifyCompatibilityListeners()
            }
        }
    }

    function getState() {
        return selectDesktopState(reduxStore.getState())
    }

    function setState(partial) {
        transaction(() => {
            if (Object.prototype.hasOwnProperty.call(partial, 'items')) {
                reduxStore.dispatch(listsActions.selectedListItemsSynced(partial.items))
                reduxStore.dispatch(labelsActions.labelsApplied(partial.items))
                reduxStore.dispatch(presenceActions.presenceApplied(partial.items))
            }
            if (Object.prototype.hasOwnProperty.call(partial, 'inviteKey')) reduxStore.dispatch(syncActions.autobaseInviteKeySet(partial.inviteKey))
            if (Object.prototype.hasOwnProperty.call(partial, 'peerCount')) reduxStore.dispatch(syncActions.peerCountSet(partial.peerCount))
            if (Object.prototype.hasOwnProperty.call(partial, 'baseId') || Object.prototype.hasOwnProperty.call(partial, 'epoch')) {
                const sync = reduxStore.getState().sync
                reduxStore.dispatch(syncActions.baseStateReceived({ baseId: partial.baseId ?? sync.baseId, epoch: partial.epoch ?? sync.epoch }))
            }
            if (Object.prototype.hasOwnProperty.call(partial, 'joinPhase')) reduxStore.dispatch(syncActions.joinPhaseSet(partial.joinPhase))
            if (Object.prototype.hasOwnProperty.call(partial, 'isJoining')) reduxStore.dispatch(syncActions.joiningSet(partial.isJoining))
            if (Object.prototype.hasOwnProperty.call(partial, 'backendReady')) reduxStore.dispatch(syncActions.workletReadySet(partial.backendReady))
            if (partial.synced === true) reduxStore.dispatch(syncActions.snapshotReceived())
            if (partial.synced === false) reduxStore.dispatch(syncActions.syncReset())
            if (Object.prototype.hasOwnProperty.call(partial, 'writeBlock')) {
                reduxStore.dispatch(partial.writeBlock ? syncActions.writeBlocked(partial.writeBlock) : syncActions.writeBlockCleared())
            }
            if (Object.prototype.hasOwnProperty.call(partial, 'recovery')) {
                reduxStore.dispatch(partial.recovery ? syncActions.recoveryRequired(partial.recovery) : syncActions.recoveryCleared())
            }
            if (Object.prototype.hasOwnProperty.call(partial, 'roster')) reduxStore.dispatch(devicesActions.rosterReceived(partial.roster))
            if (Object.prototype.hasOwnProperty.call(partial, 'boardConfig') || Object.prototype.hasOwnProperty.call(partial, 'boardConfigCanAdminister')) {
                const board = reduxStore.getState().boardConfig
                reduxStore.dispatch(boardConfigActions.boardConfigReceived({
                    config: partial.boardConfig ?? board.config,
                    canAdminister: partial.boardConfigCanAdminister ?? board.canAdminister,
                }))
            }
            reduxStore.dispatch(runtimeSlice.actions.patched(partial))
            if (partial.preferences) reduxStore.dispatch(preferencesSlice.actions.patched(partial.preferences))
        })
    }

    function subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
    }

    function setPreferences(partial) {
        reduxStore.dispatch(preferencesSlice.actions.patched(partial))
    }

    function pushNotice(text, tone = 'info') {
        const notice = { id: ++noticeId, text, tone }
        reduxStore.dispatch(runtimeSlice.actions.noticePushed(notice))
        return notice.id
    }

    function dismissNotice(id) {
        reduxStore.dispatch(runtimeSlice.actions.noticeDismissed(id))
    }

    // A mutation went through again — writes flow, drop the write-block banner.
    function clearWriteBlock() {
        if (getState().writeBlock) reduxStore.dispatch(syncActions.writeBlockCleared())
    }

    function recordDiagnostic(label, detail, now) {
        const entry = {
            at: now,
            label: redactString(label),
            detail: detail === undefined ? undefined : redactForLog(detail),
        }
        return [...getState().diagnostics, entry].slice(-MAX_DIAGNOSTIC_EVENTS)
    }

    // Reduce one decoded backend event into state. `now` is injected so tests
    // are deterministic. Returns the diagnostic label recorded, or null when
    // the event type is unknown.
    function applyClientEvent(event, now = 0) {
        const before = getState()
        switch (event.type) {
            case 'sync-list': {
                transaction(() => {
                    reduxStore.dispatch(listsActions.selectedListItemsSynced(event.items ?? []))
                    reduxStore.dispatch(labelsActions.labelsApplied(event.items ?? []))
                    reduxStore.dispatch(presenceActions.presenceApplied(event.items ?? []))
                    reduxStore.dispatch(syncActions.snapshotReceived())
                    const items = getState().items
                    if (!before.synced || !sameSnapshot(before.items, items)) {
                        reduxStore.dispatch(runtimeSlice.actions.patched({ diagnostics: recordDiagnostic(`sync-list (${items.length} items)`, undefined, now) }))
                    }
                })
                return 'sync-list'
            }
            case 'add-from-backend':
            case 'update-from-backend':
            case 'delete-from-backend': {
                // A SHARED single-list base seeds its OWN self-describing registry
                // meta-item, which the backend pushes here tagged with `baseKey`.
                // The personal base's registry is authoritative for the nav, so
                // dropping it prevents a collision (same __registry__ id) from
                // clobbering the personal entry's regBaseKey (→ writes mis-route).
                if (event.item && event.item.listType === 'registry' && event.item.baseKey) {
                    return event.type
                }
                const current = event.item?.id
                    ? before.items.find((entry) => entry?.id === event.item.id)
                    : null
                if (event.type === 'delete-from-backend' && !current) return event.type
                if (event.type !== 'delete-from-backend' && current && JSON.stringify(current) === JSON.stringify(event.item)) {
                    return event.type
                }
                const type = event.type.split('-')[0]
                const listAction = type === 'add' ? listsActions.listItemAdded : type === 'update' ? listsActions.listItemUpdated : listsActions.listItemDeleted
                const labelAction = type === 'delete' ? labelsActions.labelItemRemoved : labelsActions.labelItemApplied
                const presenceAction = type === 'delete' ? presenceActions.presenceItemRemoved : presenceActions.presenceItemApplied
                transaction(() => {
                    reduxStore.dispatch(listAction(event.item))
                    reduxStore.dispatch(labelAction(event.item))
                    reduxStore.dispatch(presenceAction(event.item))
                    reduxStore.dispatch(runtimeSlice.actions.patched({ diagnostics: recordDiagnostic(event.type, undefined, now) }))
                })
                return event.type
            }
            case 'invite-key':
                transaction(() => {
                    reduxStore.dispatch(syncActions.autobaseInviteKeySet(event.key ?? ''))
                    reduxStore.dispatch(runtimeSlice.actions.patched({ diagnostics: recordDiagnostic(event.key ? 'invite-key (rotated)' : 'invite-key (cleared)', undefined, now) }))
                })
                return 'invite-key'
            case 'reset':
                transaction(() => {
                    reduxStore.dispatch(listsActions.listsCleared())
                    reduxStore.dispatch(syncActions.syncReset())
                    reduxStore.dispatch(devicesActions.rosterReceived(null))
                    reduxStore.dispatch(boardConfigActions.boardConfigReset())
                    reduxStore.dispatch(labelsActions.labelsCleared())
                    reduxStore.dispatch(presenceActions.presenceCleared())
                    reduxStore.dispatch(runtimeSlice.actions.patched({ diagnostics: recordDiagnostic('reset', undefined, now) }))
                })
                return 'reset'
            case 'message':
                return applyMessagePayload(event.payload, now)
            case 'message-empty':
                return null
            default:
                reduxStore.dispatch(runtimeSlice.actions.patched({ diagnostics: recordDiagnostic(`unhandled:${event.type}`, undefined, now) }))
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
            case 'base-state':
                setState({
                    baseId: typeof payload.baseId === 'string' ? payload.baseId : null,
                    epoch: Number.isInteger(payload.epoch) ? payload.epoch : null,
                    diagnostics: recordDiagnostic(`base-state ${payload.baseId ?? 'unknown'} epoch ${payload.epoch ?? '?'}`, undefined, now),
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
            case 'sync-stalled':
                // The backend refused a mutation (see @listam/backend lib/item.mjs
                // write gates) — remember why so the UI can say so instead of
                // dropping the change silently.
                setState({ writeBlock: type, diagnostics: recordDiagnostic(type, undefined, now) })
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
        reduxStore,
        dispatch: reduxStore.dispatch,
        getReduxState: reduxStore.getState,
        getState,
        subscribe,
        setState,
        setPreferences,
        pushNotice,
        dismissNotice,
        clearWriteBlock,
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
