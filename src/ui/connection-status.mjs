// Cached screens are editable while their history is still being validated.
// A connected peer alone must not turn that provisional state into "Synced".
export function connectionStatusKey(state, idleKey = 'header.status.ready') {
    if (!state.backendReady) return 'header.status.starting'
    if (state.isCatchingUp) return 'desktop.beacon.syncing'
    return state.peerCount > 0 ? 'header.status.synced' : idleKey
}

export function syncBeaconState(state) {
    if (state.recovery) return 'attention'
    if (state.isJoining || state.joinPhase || state.isCatchingUp) return 'syncing'
    return state.peerCount > 0 ? 'live' : 'local'
}
