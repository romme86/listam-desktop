// Fixture-backed stand-in for the embedded backend, used by the browser dev
// preview (?mock=1) so the UI can be exercised and compared against the
// design-guide examples without a Pear runtime. It speaks the same client
// surface (send + decoded events) and applies mutations with the shared
// id-keyed reduction, but nothing replicates.
import {
    RPC_ADD,
    RPC_UPDATE,
    RPC_DELETE,
    RPC_MOVE,
    RPC_JOIN_KEY,
    RPC_CREATE_INVITE,
    RPC_REQUEST_SYNC,
    RPC_GET_BOARD_CONFIG,
    RPC_SET_BOARD_CONFIG,
    RPC_EXPORT_DATA,
    RPC_EXPORT_SEED,
    RPC_IMPORT,
    RPC_SHARE_LIST,
    RPC_JOIN_LIST,
} from '@listam/protocol'
import { normalizeListItem } from '@listam/domain/list-reducer'
import { buildListMetaItem, buildGroupMetaItem } from '@listam/domain/list-registry'
import { buildMovedItem, isSameSurfaceMove } from '@listam/domain/list-move'
import { BOARD_WRITE_TYPE, isBoardType, normalizeBoardConfig, applyStatusTransition, doneStatusesOf } from '@listam/domain/board'
import { TODO_LIST_TYPE } from '@listam/domain/identity'
import { reductionFromItems } from './store.mjs'

// Grocery, board and to-do all live on the default list (the legacy desktop
// model — one list, three types via listType), so they surface as the built-in
// Groceries / Board / Todo rail entries. A separate registry list ("Hardware"
// in a "Projects" group) exercises the multi-list / groups feature on top.
const DEFAULT_LIST = 'default'
const HARDWARE_LIST = 'hardware'
const PROJECTS_GROUP = 'projects'

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
    let bridgeStatus = { running: false, port: 0, controlKey: null, hubAddr: null, connections: 0, error: null }
    let bridgeTimer = null
    let nextId = 0
    let items = FIXTURE_TEXTS.map(([text, isDone]) => normalizeListItem({
        id: `mock-${++nextId}`,
        text,
        isDone,
        timeOfCompletion: isDone ? 1 : 0,
        updatedAt: 1,
    }))

    // Board fixtures so ?mock=1 exercises the board, time-in-progress,
    // on-time badges and the congruency dashboard without a Pear runtime.
    const A = 'a1'.repeat(32)
    const B = 'b2'.repeat(32)
    const HOUR = 3600000
    let boardConfig = normalizeBoardConfig(null) // rigor ON by default
    const boardFixtures = [
        { text: 'Plan Tokyo itinerary', status: 'in_progress', priority: 'high', assignee: A, createdBy: A, estimatedHours: 6, estimatedComplexity: 45, inProgressMs: 4.2 * HOUR, inProgressSince: null, checklist: [{ id: 'k1', text: 'Confirm dates', done: true }, { id: 'k2', text: 'Compare flights', done: false }], blocks: [
            { id: 'blk-1', type: 'markdown', text: '# Trip overview\nTwo weeks across **Tokyo**, *Kyoto* and Osaka.\n## Getting around\nAnchor the trip around the [JR Pass](https://japanrailpass.net) and `book early`.' },
            { id: 'blk-2', type: 'callout', text: 'Reserve the ryokan before March — they fill fast.', tone: 'info' },
            { id: 'blk-3', type: 'checklist', items: [{ text: 'Pick travel dates', done: true }, { text: 'Compare flights', done: false }, { text: 'Reserve ryokan', done: false }] },
            { id: 'blk-4', type: 'numberedList', items: [{ text: 'Tokyo (5 nights)' }, { text: 'Kyoto (4 nights)' }, { text: 'Osaka (3 nights)' }] },
            { id: 'blk-5', type: 'links', links: [{ label: 'JR Pass', url: 'https://japanrailpass.net' }, { label: 'Hyperdia', url: 'https://www.hyperdia.com' }] },
            { id: 'blk-6', type: 'table', rows: [['City', 'Nights', 'Budget'], ['Tokyo', '5', 'CHF 1200'], ['Kyoto', '4', 'CHF 900']] },
            { id: 'blk-7', type: 'image', url: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="160" height="70"><rect width="160" height="70" fill="%23378ADD"/><text x="12" y="42" fill="white" font-family="sans-serif" font-size="16">Tokyo</text></svg>', alt: 'Tokyo' },
            { id: 'blk-8', type: 'code', text: 'itinerary --export pdf --days 12', lang: 'sh' },
        ] },
        { text: 'Book flights', status: 'todo', priority: 'medium', assignee: A, createdBy: A, estimatedHours: 3, estimatedComplexity: 30 },
        { text: 'Reserve ryokan', status: 'todo', priority: 'low', assignee: B, createdBy: B, estimatedHours: 2, estimatedComplexity: 20 },
        { text: 'Travel insurance', status: 'in_progress', priority: 'medium', assignee: B, createdBy: B, estimatedHours: 2, estimatedComplexity: 35, inProgressMs: 1 * HOUR, inProgressSince: null },
        { text: 'Renew passport', status: 'done', isDone: true, priority: 'high', assignee: A, createdBy: A, completedBy: A, estimatedHours: 4, estimatedComplexity: 50, inProgressMs: 3.9 * HOUR, actualInProgressHours: 3.9, timeliness: 'on_time' },
        { text: 'Visa check', status: 'done', isDone: true, priority: 'medium', assignee: B, createdBy: B, completedBy: B, estimatedHours: 2, estimatedComplexity: 25, inProgressMs: 2.8 * HOUR, actualInProgressHours: 2.8, timeliness: 'overtime' },
        { text: 'Get JR pass', status: 'done', isDone: true, priority: 'low', assignee: A, createdBy: A, completedBy: A, estimatedHours: 6, estimatedComplexity: 70, inProgressMs: 3.5 * HOUR, actualInProgressHours: 3.5, timeliness: 'undertime' },
    ].map((tk) => normalizeListItem({
        listId: DEFAULT_LIST,
        listType: BOARD_WRITE_TYPE,
        timeOfCompletion: tk.isDone ? 1 : 0,
        updatedAt: 1,
        ...tk,
        id: `mock-${++nextId}`,
        isDone: tk.isDone || false,
    })).filter(Boolean)

    // To-do fixtures so ?mock=1 exercises the plain-text to-do surface (no
    // categories, no grid — just checkbox rows).
    const todoFixtures = [
        ['Call the dentist', false],
        ['Reply to the landlord', false],
        ['Submit expense report', true],
        ['Water the plants', false],
    ].map(([text, isDone]) => normalizeListItem({
        listId: DEFAULT_LIST,
        listType: TODO_LIST_TYPE,
        text,
        isDone,
        timeOfCompletion: isDone ? 1 : 0,
        updatedAt: 1,
        id: `mock-${++nextId}`,
    })).filter(Boolean)

    // A second, named grocery list on its own listId — exercises the registry /
    // groups feature alongside the built-in default surfaces.
    const hardwareItems = [
        ['M3 screws', false],
        ['Wood glue', false],
        ['Sandpaper', true],
    ].map(([text, isDone]) => normalizeListItem({
        listId: HARDWARE_LIST,
        listType: 'shopping',
        text,
        isDone,
        timeOfCompletion: isDone ? 1 : 0,
        updatedAt: 1,
        id: `mock-${++nextId}`,
    })).filter(Boolean)

    // Registry meta-items declaring the named list + its group (the read path the
    // dynamic rail consumes for non-default lists).
    const registryFixtures = [
        buildGroupMetaItem({ id: PROJECTS_GROUP, name: 'Projects', order: 0, updatedAt: 1 }),
        buildListMetaItem({ id: HARDWARE_LIST, name: 'Hardware', type: 'shopping', groupId: PROJECTS_GROUP, order: 0, updatedAt: 1 }),
    ]

    // Keep the mock's own items multi-list (the single-list applyOperationToList
    // would drop registry meta-items and the non-default named list).
    const reduction = reductionFromItems([...items, ...boardFixtures, ...todoFixtures, ...hardwareItems, ...registryFixtures])
    items = reduction.allItems()

    function emit(event) {
        for (const listener of listeners) listener(event)
    }

    function syncList() {
        emit({ type: 'sync-list', items, raw: JSON.stringify(items) })
    }

    function emitBoardConfig() {
        emit({ type: 'message', raw: '', payload: { type: 'board-config', config: boardConfig, canAdminister: true } })
    }

    const client = {
        async send(command, payload) {
            if (command === RPC_ADD) {
                const extra = (payload && typeof payload === 'object') ? payload : {}
                const raw = {
                    listId: 'default',
                    timeOfCompletion: 0,
                    ...extra,
                    id: `mock-${++nextId}`,
                    text: typeof payload === 'string' ? payload : payload?.text,
                    isDone: extra.status === 'done',
                    updatedAt: nextId,
                }
                if (isBoardType(raw.listType)) {
                    raw.status = raw.status || 'todo'
                    raw.createdBy = A
                    if (typeof raw.inProgressMs !== 'number') raw.inProgressMs = 0
                    raw.inProgressSince = raw.status === 'in_progress' ? Date.now() : null
                }
                const item = normalizeListItem(raw)
                if (!item) return null
                reduction.applyOperation({ type: 'add', value: item })
                items = reduction.allItems()
                emit({ type: 'add-from-backend', item, raw: JSON.stringify(item) })
            } else if (command === RPC_UPDATE) {
                let item = payload?.item
                if (item && isBoardType(item.listType)) {
                    const existing = items.find((entry) => entry && entry.id === item.id)
                    item = applyStatusTransition(existing, item, item.updatedAt || Date.now(), {
                        writerKey: A,
                        doneStatuses: doneStatusesOf(boardConfig),
                    })
                }
                reduction.applyOperation({ type: 'update', value: item })
                items = reduction.allItems()
                emit({ type: 'update-from-backend', item, raw: JSON.stringify(item) })
            } else if (command === RPC_DELETE) {
                const item = payload?.item
                reduction.applyOperation({ type: 'delete', value: item })
                items = reduction.allItems()
                emit({ type: 'delete-from-backend', item, raw: JSON.stringify(item) })
            } else if (command === RPC_MOVE) {
                // Mirror the backend: same listId -> single in-place update;
                // different listId -> add destination then delete source.
                const source = payload?.item
                if (!source) return null
                const dest = normalizeListItem(buildMovedItem(source, payload?.targetListId, payload?.targetListType, {
                    fields: payload?.fields ?? null,
                    now: Date.now(),
                    writerKey: A,
                }))
                if (!dest) return null
                if (isSameSurfaceMove(source, payload?.targetListId)) {
                    reduction.applyOperation({ type: 'update', value: dest })
                    items = reduction.allItems()
                    emit({ type: 'update-from-backend', item: dest, raw: JSON.stringify(dest) })
                } else {
                    reduction.applyOperation({ type: 'add', value: dest })
                    emit({ type: 'add-from-backend', item: dest, raw: JSON.stringify(dest) })
                    reduction.applyOperation({ type: 'delete', value: source })
                    items = reduction.allItems()
                    emit({ type: 'delete-from-backend', item: source, raw: JSON.stringify(source) })
                }
            } else if (command === RPC_CREATE_INVITE) {
                emit({ type: 'invite-key', key: 'mock1nv1te'.repeat(10) })
            } else if (command === RPC_SHARE_LIST) {
                // Simulate promoting a list to its own base: stamp the registry
                // meta-item with a baseKey (drives the shared badge) and return an
                // invite. No real P2P — the real flow is proven by backend tests.
                const listId = payload?.listId
                if (!listId) return JSON.stringify({ ok: false, reason: 'bad-list' })
                const baseKey = `mockbase${listId}`.padEnd(64, '0').slice(0, 64)
                const existing = items.find((i) => i.listType === 'registry' && i.id === listId)
                const meta = buildListMetaItem({
                    id: listId,
                    name: existing?.regName || existing?.text || listId,
                    type: existing?.regType || 'shopping',
                    groupId: existing?.regGroupId ?? null,
                    order: existing?.regOrder ?? 0,
                    baseKey,
                    updatedAt: Date.now(),
                })
                reduction.applyOperation({ type: 'update', value: meta })
                items = reduction.allItems()
                emit({ type: 'update-from-backend', item: meta, raw: JSON.stringify(meta) })
                return JSON.stringify({ ok: true, invite: `mockShareInvite${listId}`.padEnd(52, 'x'), baseKey })
            } else if (command === RPC_JOIN_LIST) {
                const invite = payload?.invite
                if (!invite) return JSON.stringify({ ok: false, reason: 'bad-invite' })
                const listId = `joined-${invite.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'list'}`
                const baseKey = `mockjoined${listId}`.padEnd(64, '0').slice(0, 64)
                const meta = buildListMetaItem({ id: listId, name: 'Shared list', type: 'shopping', baseKey, updatedAt: Date.now() })
                reduction.applyOperation({ type: 'add', value: meta })
                items = reduction.allItems()
                emit({ type: 'add-from-backend', item: meta, raw: JSON.stringify(meta) })
                return JSON.stringify({ ok: true, baseKey, listId, writable: true })
            } else if (command === RPC_REQUEST_SYNC) {
                syncList()
            } else if (command === RPC_GET_BOARD_CONFIG) {
                emitBoardConfig()
            } else if (command === RPC_SET_BOARD_CONFIG) {
                boardConfig = normalizeBoardConfig({ ...boardConfig, ...(payload?.config || {}) })
                emitBoardConfig()
            } else if (command === RPC_JOIN_KEY) {
                emit({ type: 'message', payload: { type: 'join-phase', phase: 'pairing' }, raw: '' })
                setTimeout(() => emit({ type: 'message', payload: { type: 'join-error', message: 'Mock backend cannot join peers' }, raw: '' }), 800)
            } else if (command === RPC_EXPORT_DATA || command === RPC_EXPORT_SEED) {
                // The browser preview cannot load the bare crypto, so the mock
                // file is NOT actually encrypted — it just carries the envelope
                // shape so the export → download → import flow can be exercised.
                const kind = command === RPC_EXPORT_SEED ? 'seed' : 'data'
                const file = JSON.stringify({ format: 'listam-export', version: 1, kind, mock: true, items: kind === 'data' ? items : undefined })
                return JSON.stringify({ ok: true, kind, file })
            } else if (command === RPC_IMPORT) {
                let env = null
                try { env = JSON.parse(payload?.file) } catch { /* invalid */ }
                if (!env || env.format !== 'listam-export') return JSON.stringify({ ok: false, reason: 'invalid-file' })
                if (env.kind === 'seed') return JSON.stringify({ ok: true, kind: 'seed', restored: true })
                let count = 0
                for (const entry of Array.isArray(env.items) ? env.items : []) {
                    const item = normalizeListItem(entry)
                    if (!item) continue
                    reduction.applyOperation({ type: 'add', value: item })
                    items = reduction.allItems()
                    emit({ type: 'add-from-backend', item, raw: JSON.stringify(item) })
                    count++
                }
                return JSON.stringify({ ok: true, kind: 'data', applied: { items: count } })
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
                    hubAddr: `192.168.1.42:${options.port ?? 9993}`,
                    connections: 0,
                    error: null,
                }
                bridgeTimer = setTimeout(() => {
                    if (!bridgeStatus.running) return
                    bridgeStatus = { ...bridgeStatus, connections: 1 }
                    emitBridge()
                }, 1500)
            } else if (action === 'stop') {
                bridgeStatus = { running: false, port: 0, controlKey: null, hubAddr: null, connections: 0, error: null }
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
        emitBoardConfig()
    }

    return { client, start }
}
