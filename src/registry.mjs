// Desktop-side helpers that turn list/group intents into the registry
// meta-items the backend syncs. Pure (no DOM, no client) so they unit-test
// directly; the ui.mjs `actions` are thin wrappers that send(RPC_UPDATE,{item}).
//
// Every mutation re-emits a FULL meta-item built by the shared
// buildListMetaItem / buildGroupMetaItem: the item pipeline LWW-replaces the
// whole item by id, so a partial write would clobber sibling reg* fields. The
// inputs are always the *reduced* registry ({groups, lists}) from
// reduceRegistry(state.items), so a rebuild preserves the current name / type /
// group / order / view unless the patch overrides them.
import { buildListMetaItem, buildGroupMetaItem, isRegistryItem } from '@listam/domain/list-registry'
import { BOARD_WRITE_TYPE, isBoardType } from '@listam/domain/board'

// Board lists travel under the legacy wire type for mesh dual-read;
// reduceRegistry normalizes it back to 'board' on read.
function writeType(type) {
    return isBoardType(type) ? BOARD_WRITE_TYPE : (typeof type === 'string' ? type : '')
}

function findList(registry, id) {
    return registry?.lists?.find((entry) => entry.id === id) ?? null
}
function findGroup(registry, id) {
    return registry?.groups?.find((entry) => entry.id === id) ?? null
}

const groupKey = (groupId) => (groupId == null ? null : String(groupId))

// Next free order: append a list to the end of its group, or a group to the end
// of the rail. Concurrent appends settle by LWW; order stabilizes after sync.
export function nextListOrder(registry, groupId = null) {
    const key = groupKey(groupId)
    return (registry?.lists ?? [])
        .filter((entry) => groupKey(entry.groupId) === key)
        .reduce((max, entry) => Math.max(max, Number(entry.order) || 0), -1) + 1
}

export function nextGroupOrder(registry) {
    return (registry?.groups ?? [])
        .reduce((max, entry) => Math.max(max, Number(entry.order) || 0), -1) + 1
}

// Fresh list / group meta-items.
export function newListMeta({ id, name, type, groupId = null, order = 0, view }, updatedAt) {
    return buildListMetaItem({ id, name, type: writeType(type), groupId, order, view, updatedAt })
}

export function newGroupMeta({ id, name, order = 0 }, updatedAt) {
    return buildGroupMetaItem({ id, name, order, updatedAt })
}

// Rebuild a list / group meta-item from its current reduced entry, applying a
// patch and bumping updatedAt. Returns null if the entry is unknown.
export function patchListMeta(registry, id, patch = {}, updatedAt) {
    const cur = findList(registry, id)
    if (!cur) return null
    const next = { name: cur.name, type: cur.type, groupId: cur.groupId, order: cur.order, view: cur.view, ...patch }
    return buildListMetaItem({
        id,
        name: next.name,
        type: writeType(next.type),
        groupId: next.groupId,
        order: next.order,
        view: next.view,
        updatedAt,
    })
}

export function patchGroupMeta(registry, id, patch = {}, updatedAt) {
    const cur = findGroup(registry, id)
    if (!cur) return null
    const next = { name: cur.name, order: cur.order, ...patch }
    return buildGroupMetaItem({ id, name: next.name, order: next.order, updatedAt })
}

// Soft-delete tombstone (reduceRegistry drops regDeleted items).
export function deleteListMeta(registry, id, updatedAt) {
    const meta = patchListMeta(registry, id, {}, updatedAt)
    return meta ? { ...meta, regDeleted: true } : null
}

export function deleteGroupMeta(registry, id, updatedAt) {
    const meta = patchGroupMeta(registry, id, {}, updatedAt)
    return meta ? { ...meta, regDeleted: true } : null
}

// Lists that have items but no registry meta-item (legacy peers, or a 'default'
// list nobody has named yet). Surfaced under Ungrouped so a list is never hidden
// just because its descriptor hasn't synced. `nameFor(id, type)` supplies a
// display name — there's no regName to read. Returns toNavLibrary `extraLists`.
export function detectExtraLists(items, registry, nameFor = (id) => id) {
    const known = new Set((registry?.lists ?? []).map((entry) => entry.id))
    const seen = new Map()
    for (const item of Array.isArray(items) ? items : []) {
        if (!item || isRegistryItem(item)) continue
        const id = item.listId == null ? '' : String(item.listId)
        if (!id || known.has(id) || seen.has(id)) continue
        seen.set(id, { id, type: typeof item.listType === 'string' ? item.listType : '', name: nameFor(id, item.listType) })
    }
    return [...seen.values()]
}
