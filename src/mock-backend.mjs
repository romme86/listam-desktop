// Fixture-backed stand-in for the embedded backend, used by the browser dev
// preview (?mock=1) so the UI can be exercised and compared against the
// design-guide examples without a Pear runtime. It speaks the same client
// surface (send + decoded events) and applies mutations with the shared
// id-keyed reduction, but nothing replicates.
import {
    RPC_ADD,
    RPC_UPDATE,
    RPC_DELETE,
    RPC_JOIN_KEY,
    RPC_CREATE_INVITE,
    RPC_REQUEST_SYNC,
} from '@listam/protocol'
import { applyOperationToList, normalizeListItem } from '@listam/domain/list-reducer'

const FIXTURE_TEXTS = [
    ['Honeycrisp apples', false],
    ['Bananas', true],
    ['Hass avocados', false],
    ['Whole milk', true],
    ['Farm fresh eggs', false],
    ['Aged cheddar', true],
    ['Edamame pods', false],
    ['Vanilla ice cream', false],
    ['Sourdough bread', false],
    ['Paper towels', false],
]

export function createMockBackend() {
    const listeners = new Set()
    const bridgeListeners = new Set()
    let bridgeStatus = { running: false, port: 0, controlKey: null, connections: 0, error: null }
    let bridgeTimer = null
    let nextId = 0
    let items = FIXTURE_TEXTS.map(([text, isDone]) => normalizeListItem({
        id: `mock-${++nextId}`,
        text,
        isDone,
        timeOfCompletion: isDone ? 1 : 0,
        updatedAt: 1,
    }))

    function emit(event) {
        for (const listener of listeners) listener(event)
    }

    function syncList() {
        emit({ type: 'sync-list', items, raw: JSON.stringify(items) })
    }

    const client = {
        async send(command, payload) {
            if (command === RPC_ADD) {
                const item = normalizeListItem({
                    id: `mock-${++nextId}`,
                    text: typeof payload === 'string' ? payload : payload?.text,
                    isDone: false,
                    timeOfCompletion: 0,
                    updatedAt: nextId,
                })
                if (!item) return null
                items = applyOperationToList(items, { type: 'add', value: item })
                emit({ type: 'add-from-backend', item, raw: JSON.stringify(item) })
            } else if (command === RPC_UPDATE) {
                const item = payload?.item
                items = applyOperationToList(items, { type: 'update', value: item })
                emit({ type: 'update-from-backend', item, raw: JSON.stringify(item) })
            } else if (command === RPC_DELETE) {
                const item = payload?.item
                items = applyOperationToList(items, { type: 'delete', value: item })
                emit({ type: 'delete-from-backend', item, raw: JSON.stringify(item) })
            } else if (command === RPC_CREATE_INVITE) {
                emit({ type: 'invite-key', key: 'mock1nv1te'.repeat(10) })
            } else if (command === RPC_REQUEST_SYNC) {
                syncList()
            } else if (command === RPC_JOIN_KEY) {
                emit({ type: 'message', payload: { type: 'join-phase', phase: 'pairing' }, raw: '' })
                setTimeout(() => emit({ type: 'message', payload: { type: 'join-error', message: 'Mock backend cannot join peers' }, raw: '' }), 800)
            }
            return null
        },
        onEvent(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        isConnected() {
            return true
        },
        // Same surface as the worker bridge client: lets the design preview
        // show the leaf-board section's running states. A fake board
        // "connects" shortly after the bridge starts.
        async bridge(action, options = {}) {
            const emitBridge = () => {
                for (const listener of bridgeListeners) listener(bridgeStatus)
            }
            clearTimeout(bridgeTimer)
            if (action === 'start') {
                bridgeStatus = {
                    running: true,
                    port: options.port ?? 9993,
                    controlKey: 'fadefeed'.repeat(8),
                    connections: 0,
                    error: null,
                }
                bridgeTimer = setTimeout(() => {
                    if (!bridgeStatus.running) return
                    bridgeStatus = { ...bridgeStatus, connections: 1 }
                    emitBridge()
                }, 1500)
            } else if (action === 'stop') {
                bridgeStatus = { running: false, port: 0, controlKey: null, connections: 0, error: null }
            }
            emitBridge()
            return bridgeStatus
        },
        onBridgeStatus(listener) {
            bridgeListeners.add(listener)
            return () => bridgeListeners.delete(listener)
        },
    }

    function start() {
        syncList()
        emit({ type: 'invite-key', key: 'mock1nv1te'.repeat(10) })
        emit({ type: 'message', payload: { type: 'peer-count', count: 2 }, raw: '' })
        emit({
            type: 'message',
            raw: '',
            payload: {
                type: 'membership-roster',
                roster: {
                    canAdminister: true,
                    writers: [
                        { writerKey: 'a1'.repeat(32), isOwner: true, isSelf: true },
                        { writerKey: 'b2'.repeat(32), isOwner: false, isSelf: false },
                    ],
                },
            },
        })
    }

    return { client, start }
}
