import test from 'node:test'
import assert from 'node:assert/strict'
import { connectionStatusKey, syncBeaconState } from '../src/ui/connection-status.mjs'

test('cached or pending history retains the existing syncing label and beacon despite connected peers', () => {
    const state = { backendReady: true, peerCount: 2, isCatchingUp: true }
    assert.equal(connectionStatusKey(state), 'desktop.beacon.syncing')
    assert.equal(syncBeaconState(state), 'syncing')
    state.isCatchingUp = false
    assert.equal(connectionStatusKey(state), 'header.status.synced')
    assert.equal(syncBeaconState(state), 'live')
})

test('attention, startup and local-only states keep their existing precedence', () => {
    assert.equal(syncBeaconState({ recovery: {}, isCatchingUp: true }), 'attention')
    assert.equal(connectionStatusKey({ backendReady: false, isCatchingUp: true }), 'header.status.starting')
    assert.equal(connectionStatusKey({ backendReady: true, peerCount: 0 }, 'header.status.online'), 'header.status.online')
    assert.equal(syncBeaconState({ peerCount: 0 }), 'local')
})
