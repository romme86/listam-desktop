import { createSlice } from '@reduxjs/toolkit'

// The facts @listam/client decodes out of the invite envelope. A bare-string
// invite from an older backend has no expiry, which is NOT the same as expired —
// see describeInvite in ../ui/pairing-status.mjs.
export const initialInviteState = {
    expiresAt: null,
    singleUse: true,
    liveInvites: 0,
    maxInvites: null,
}

export const initialSyncState = {
    autobaseInviteKey: '',
    // Sharing used to show a code with nothing around it: no countdown, no
    // "works once", no sign that minting a second code had just orphaned the
    // first. All three are in the envelope; this is where they land.
    invite: { ...initialInviteState },
    peerCount: 0,
    isWorkletReady: false,
    isJoining: false,
    joinPhase: null,
    // The last 'join-progress' heartbeat (every 10s while pairing). Null between
    // joins. `randomized` true is the carrier-NAT tell that traffic is relayed.
    joinProgress: null,
    // The last 'join-error' — kept as { reason, message } so the UI can resolve
    // the machine-readable reason through the catalog instead of showing the
    // backend's English message.
    joinError: null,
    networkStatus: 'connecting',
    baseId: null,
    epoch: null,
    hasReceivedSnapshot: false,
    writeBlock: null,
    recovery: null,
    // Ids of mutations the backend kept in its durable outbox because the writer
    // could not flush. The row still exists locally and will sync later — the UI
    // marks it rather than pretending the edit was lost or that it landed.
    pendingWriteIds: [],
    pendingWriteIdsByBase: {},
    projectionSourcesByBase: {},
}

const syncSlice = createSlice({
    name: 'sync',
    initialState: initialSyncState,
    reducers: {
        autobaseInviteKeySet(state, action) {
            state.autobaseInviteKey = action.payload || ''
            if (!state.autobaseInviteKey) state.invite = { ...initialInviteState }
        },
        // The whole decoded 'invite-key' event. Kept separate from the setter
        // above, which stays the plain-string path used by setState({ inviteKey }).
        autobaseInviteReceived(state, action) {
            const event = action.payload || {}
            state.autobaseInviteKey = event.key || ''
            state.invite = {
                expiresAt: Number.isFinite(event.expiresAt) ? event.expiresAt : null,
                singleUse: event.singleUse !== false,
                liveInvites: Number.isFinite(event.liveInvites) ? Math.max(0, event.liveInvites) : (event.key ? 1 : 0),
                maxInvites: Number.isFinite(event.maxInvites) ? event.maxInvites : null,
            }
        },
        joinProgressReceived(state, action) {
            const progress = action.payload
            state.joinProgress = progress && typeof progress === 'object' ? progress : null
        },
        joinErrorReceived(state, action) {
            const payload = action.payload || {}
            state.joinError = {
                reason: typeof payload.reason === 'string' && payload.reason ? payload.reason : 'unknown',
                message: typeof payload.message === 'string' ? payload.message : '',
                // A second failure with the SAME reason must still read as a new
                // event, or the UI cannot tell a repeat from a stale render.
                at: Number.isFinite(payload.at) ? payload.at : 0,
            }
            state.joinProgress = null
        },
        writeQueued(state, action) {
            const id = action.payload
            if (typeof id === 'string' && id && !state.pendingWriteIds.includes(id)) {
                state.pendingWriteIds.push(id)
            }
        },
        // The outbox drained. It reports a count rather than ids, so clear the
        // whole set: anything still queued re-announces itself on the next
        // refusal, and showing a stale badge is worse than briefly showing none.
        writesReplayed(state) {
            if (state.pendingWriteIds.length) state.pendingWriteIds = []
            state.pendingWriteIdsByBase = {}
        },
        projectionClosed(state, action) {
            delete state.projectionSourcesByBase[action.payload]
        },
        peerCountSet(state, action) { state.peerCount = Number.isFinite(action.payload) ? Math.max(0, action.payload) : 0 },
        workletReadySet(state, action) { state.isWorkletReady = !!action.payload },
        joiningSet(state, action) {
            state.isJoining = !!action.payload
            if (!state.isJoining) state.joinPhase = null
            // A new attempt must not open under the previous attempt's failure,
            // and a finished one must not keep a stale elapsed counter alive.
            state.joinProgress = null
            if (state.isJoining) state.joinError = null
        },
        joinPhaseSet(state, action) { state.joinPhase = action.payload || null },
        networkStatusSet(state, action) {
            if (['connecting', 'online', 'offline'].includes(action.payload)) state.networkStatus = action.payload
        },
        baseStateReceived(state, action) {
            state.baseId = typeof action.payload?.baseId === 'string' ? action.payload.baseId : null
            state.epoch = Number.isInteger(action.payload?.epoch) ? action.payload.epoch : null
        },
        snapshotReceived(state) { state.hasReceivedSnapshot = true },
        writeBlocked(state, action) { state.writeBlock = action.payload || null },
        writeBlockCleared(state) { state.writeBlock = null },
        recoveryRequired(state, action) { state.recovery = action.payload },
        recoveryCleared(state) { state.recovery = null },
        syncReset(state) {
            // `invite` is a nested object on initialSyncState — copy it, or every
            // reset would hand the slice the SAME object the initial state holds.
            Object.assign(state, {
                ...initialSyncState,
                invite: { ...initialInviteState },
                isWorkletReady: state.isWorkletReady,
            })
        },
    },
    extraReducers: (builder) => {
        builder.addCase('sync/projectionSnapshotReceived', (state, { payload }) => {
            state.projectionSourcesByBase ??= {}
            state.projectionSourcesByBase[payload.baseKey] = payload.source
            if (!payload.pendingWriteIds) return
            state.pendingWriteIdsByBase ??= {}
            const previous = new Set(state.pendingWriteIdsByBase[payload.baseKey] ?? [])
            state.pendingWriteIdsByBase[payload.baseKey] = payload.pendingWriteIds
            state.pendingWriteIds = [...new Set([
                ...state.pendingWriteIds.filter((id) => !previous.has(id)),
                ...Object.values(state.pendingWriteIdsByBase).flat(),
            ])]
        })
    },
})

export const syncActions = syncSlice.actions
export default syncSlice.reducer
