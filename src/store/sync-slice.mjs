import { createSlice } from '@reduxjs/toolkit'

export const initialSyncState = {
    autobaseInviteKey: '',
    peerCount: 0,
    isWorkletReady: false,
    isJoining: false,
    joinPhase: null,
    networkStatus: 'connecting',
    baseId: null,
    epoch: null,
    hasReceivedSnapshot: false,
    writeBlock: null,
    recovery: null,
}

const syncSlice = createSlice({
    name: 'sync',
    initialState: initialSyncState,
    reducers: {
        autobaseInviteKeySet(state, action) { state.autobaseInviteKey = action.payload || '' },
        peerCountSet(state, action) { state.peerCount = Number.isFinite(action.payload) ? Math.max(0, action.payload) : 0 },
        workletReadySet(state, action) { state.isWorkletReady = !!action.payload },
        joiningSet(state, action) {
            state.isJoining = !!action.payload
            if (!state.isJoining) state.joinPhase = null
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
            Object.assign(state, { ...initialSyncState, isWorkletReady: state.isWorkletReady })
        },
    },
})

export const syncActions = syncSlice.actions
export default syncSlice.reducer
