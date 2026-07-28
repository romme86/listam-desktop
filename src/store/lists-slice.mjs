import { createSlice } from '@reduxjs/toolkit'
import { isLabelItem, isPlanItem, surfaceLabelKey } from '@listam/domain'
import { REGISTRY_LIST_TYPE } from '@listam/domain/list-registry'
import { isFromAuthoritativeBase, listBaseFromRegistryItem } from '@listam/domain/authoritative-base'
import {
    DEFAULT_LIST_ID,
    DEFAULT_LIST_TYPE,
    baseScopedKey,
    isStaleUpdate,
    normalizeListEntries,
} from '@listam/domain/identity'

export const DEFAULT_PROJECT_ID = 'personal'
export const DEFAULT_FOLDER_ID = 'personal-root'
export const DEFAULT_SURFACE_ID = surfaceLabelKey(DEFAULT_LIST_ID, DEFAULT_LIST_TYPE)

export const initialListsState = {
    selectedProjectId: DEFAULT_PROJECT_ID,
    selectedListId: DEFAULT_SURFACE_ID,
    projectIds: [DEFAULT_PROJECT_ID],
    projectsById: {
        [DEFAULT_PROJECT_ID]: {
            id: DEFAULT_PROJECT_ID,
            name: 'Personal',
            folderIds: [DEFAULT_FOLDER_ID],
            listIds: [DEFAULT_LIST_ID],
        },
    },
    folderIds: [DEFAULT_FOLDER_ID],
    foldersById: {
        [DEFAULT_FOLDER_ID]: {
            id: DEFAULT_FOLDER_ID,
            projectId: DEFAULT_PROJECT_ID,
            name: 'Lists',
            listIds: [DEFAULT_LIST_ID],
        },
    },
    listIds: [DEFAULT_LIST_ID],
    listsById: {
        [DEFAULT_LIST_ID]: {
            id: DEFAULT_LIST_ID,
            projectId: DEFAULT_PROJECT_ID,
            folderId: DEFAULT_FOLDER_ID,
            name: 'Shopping',
            type: DEFAULT_LIST_TYPE,
            itemIds: [],
        },
    },
    itemsById: {},
    // listId -> the base its items must come from (null = the personal base).
    // Maintained incrementally from personal registry meta-items as they arrive,
    // so the guard below is an O(1) lookup rather than a re-reduce per event.
    baseByListId: {},
}

function ensureProject(state, projectId) {
    if (!state.projectsById[projectId]) {
        state.projectsById[projectId] = {
            id: projectId,
            name: projectId === DEFAULT_PROJECT_ID ? 'Personal' : 'Project',
            folderIds: [],
            listIds: [],
        }
        state.projectIds.push(projectId)
    }
    return state.projectsById[projectId]
}

function ensureFolder(state, folderId, projectId) {
    ensureProject(state, projectId)
    if (!state.foldersById[folderId]) {
        state.foldersById[folderId] = {
            id: folderId,
            projectId,
            name: folderId === DEFAULT_FOLDER_ID ? 'Lists' : 'Folder',
            listIds: [],
        }
        state.folderIds.push(folderId)
    }
    const project = state.projectsById[projectId]
    if (!project.folderIds.includes(folderId)) project.folderIds.push(folderId)
    return state.foldersById[folderId]
}

function ensureList(state, listId, listType, projectId = state.selectedProjectId) {
    ensureProject(state, projectId)
    ensureFolder(state, DEFAULT_FOLDER_ID, projectId)
    if (!state.listsById[listId]) {
        state.listsById[listId] = {
            id: listId,
            projectId,
            folderId: DEFAULT_FOLDER_ID,
            name: listId === DEFAULT_LIST_ID ? 'Shopping' : 'List',
            type: listType,
            itemIds: [],
        }
        state.listIds.push(listId)
    } else if (listType) {
        state.listsById[listId].type = listType
    }
    const project = state.projectsById[projectId]
    const folder = state.foldersById[DEFAULT_FOLDER_ID]
    if (!project.listIds.includes(listId)) project.listIds.push(listId)
    if (!folder.listIds.includes(listId)) folder.listIds.push(listId)
    return state.listsById[listId]
}

function isSharedRegistryItem(entry) {
    return entry?.listType === REGISTRY_LIST_TYPE && !!entry?.baseKey
}

function entriesForList(state, listId) {
    const list = state.listsById[listId]
    if (!list) return []
    return list.itemIds.map((id) => state.itemsById[id]).filter(Boolean)
}

// True when a bucket already holds exactly these items, in this order.
// Compared per item rather than over the whole state: an authoritative snapshot
// is small, and this runs once per sync rather than once per dispatch.
function bucketUnchanged(state, list, normalized) {
    if (!list || list.itemIds.length !== normalized.length) return false
    for (let i = 0; i < normalized.length; i++) {
        const current = state.itemsById[list.itemIds[i]]
        if (!current) return false
        const next = normalized[i]
        if (current === next) continue
        if (baseScopedKey(current) !== baseScopedKey(next)) return false
        if (JSON.stringify(current) !== JSON.stringify(next)) return false
    }
    return true
}

function replaceListItems(state, listId, listType, entries) {
    const normalizedIncoming = normalizeListEntries(
        entries
            .filter((entry) => !isLabelItem(entry) && !isPlanItem(entry) && !isSharedRegistryItem(entry))
            .map((entry) => ({
                ...entry,
                listId: entry.listId || listId,
                listType: entry.listType || state.listsById[listId]?.type || listType,
            })),
    )

    // A re-sync that carries what we already hold must not touch state. Immer
    // turns any write into a new root object, and the store notifies on
    // reference change — so rewriting identical content would re-render every
    // subscriber for nothing. This is what the whole-state JSON.stringify in
    // store.mjs used to paper over, at ~4 ms per dispatch on 5,000 items.
    if (bucketUnchanged(state, state.listsById[listId], normalizedIncoming)) return

    const list = ensureList(state, listId, listType)
    for (const itemId of list.itemIds) delete state.itemsById[itemId]
    const normalized = normalizedIncoming
    // A Set for the duplicate check, not itemIds.includes(). Every item add,
    // update and delete routes through here, so the linear scan inside this loop
    // made each one O(n^2) — ~25 million comparisons per keystroke on a
    // 5,000-item list, which measured at ~137 ms per edit.
    list.itemIds = []
    const seen = new Set()
    for (const item of normalized) {
        const itemId = baseScopedKey(item)
        state.itemsById[itemId] = item
        if (seen.has(itemId)) continue
        seen.add(itemId)
        list.itemIds.push(itemId)
    }
}

function replaceExactBucket(state, { listId, listType, items }) {
    // Plan records are a cross-list overlay kept directly in itemsById. They
    // deliberately have no ListRecord, so an authoritative snapshot must clear
    // the old overlay refs explicitly before installing the current set.
    if (isPlanItem({ listType })) {
        for (const [itemId, item] of Object.entries(state.itemsById)) {
            if (isPlanItem(item)) delete state.itemsById[itemId]
        }
        for (const item of normalizeListEntries(items.map((entry) => ({
            ...entry,
            listId: entry?.listId || listId,
            listType: entry?.listType || listType,
        })))) {
            if (!isPlanItem(item) || item.listId !== listId) continue
            state.itemsById[baseScopedKey(item)] = item
        }
        return
    }

    // Labels (including presence) live in dedicated slices. Do not create a
    // phantom list record for their reserved buckets here.
    if (isLabelItem({ listType })) return

    replaceListItems(state, listId, listType, items)
}

function removeIdentityFromOtherLists(state, identity, targetListId) {
    for (const listId of state.listIds) {
        if (listId === targetListId) continue
        const list = state.listsById[listId]
        if (!list?.itemIds.includes(identity)) continue
        list.itemIds = list.itemIds.filter((id) => id !== identity)
        delete state.itemsById[identity]
    }
}

function applyItemProjection(state, entry, operation) {
    if (!entry || isLabelItem(entry) || isSharedRegistryItem(entry)) return
    const normalized = normalizeListEntries([entry])[0]
    if (!normalized) return

    // Keep the routing index current: a registry meta-item is what declares
    // where a list's items live.
    const routing = listBaseFromRegistryItem(normalized)
    if (routing) state.baseByListId[routing.listId] = routing.baseKey

    // Sharing a list re-seeds its items into a new base with the SAME ids and
    // then tombstones the personal copies. Those two bases replicate
    // independently, so the delete can land AFTER the seed. Ignore events from a
    // base this list was promoted away from. Fails open for lists the registry
    // has not described yet — which is precisely the window the race lives in,
    // so it is NOT the whole fix: rows are keyed by baseScopedKey below, making
    // the personal tombstone and the shared copy different rows outright.
    if (!routing && !isFromAuthoritativeBase(normalized, state.baseByListId)) return
    const itemId = baseScopedKey(normalized)
    if (isPlanItem(normalized)) {
        if (operation === 'delete') delete state.itemsById[itemId]
        else state.itemsById[itemId] = normalized
        return
    }
    const listId = normalized.listId || DEFAULT_LIST_ID
    const listType = normalized.listType || DEFAULT_LIST_TYPE
    const list = ensureList(state, listId, listType)
    removeIdentityFromOtherLists(state, itemId, listId)

    // Keyed mutation, not a bucket rewrite.
    //
    // This used to materialize the whole bucket into an array, run the
    // upsert/update/delete helper over it, and hand the result to
    // replaceListItems — which then deleted and re-added every itemsById key
    // through Immer proxies. For a ONE-item change. Measured at ~47 ms per edit
    // on a 5,000-item list even after the O(n^2) scan was removed, because the
    // cost is the rewrite itself, not the search.
    //
    // The semantics below are exactly those of upsertListEntry / updateListEntry
    // / deleteListEntry in @listam/domain/identity, applied in place:
    //   add    — prepend when new; otherwise merge and move to the front
    //   update — append when new; ignore a stale write; otherwise merge in place
    //   delete — drop it
    const at = list.itemIds.indexOf(itemId)

    if (operation === 'delete') {
        if (at !== -1) list.itemIds.splice(at, 1)
        delete state.itemsById[itemId]
        return
    }

    if (at === -1) {
        state.itemsById[itemId] = normalized
        // add goes to the front, update to the back — matching 'front' vs
        // 'preserve' placement in the shared helpers.
        if (operation === 'update') list.itemIds.push(itemId)
        else list.itemIds.unshift(itemId)
        return
    }

    const existing = state.itemsById[itemId]
    // Only 'preserve' placement (update) honours staleness; an explicit add
    // always wins, exactly as upsertListEntry does.
    if (operation === 'update' && isStaleUpdate(existing, normalized)) return

    state.itemsById[itemId] = { ...existing, ...normalized }
    if (operation !== 'update' && at !== 0) {
        list.itemIds.splice(at, 1)
        list.itemIds.unshift(itemId)
    }
}

const listsSlice = createSlice({
    name: 'lists',
    initialState: initialListsState,
    reducers: {
        selectedListChanged(state, action) {
            const projectId = action.payload.projectId || state.selectedProjectId
            const navId = action.payload.listId || DEFAULT_SURFACE_ID
            const separator = navId.indexOf(':')
            const listId = separator > 0 ? navId.slice(0, separator) : navId
            ensureList(state, listId, action.payload.listType || DEFAULT_LIST_TYPE, projectId)
            state.selectedProjectId = projectId
            state.selectedListId = navId
        },
        selectedListItemsSynced(state, action) {
            const exact = !Array.isArray(action.payload)
                && typeof action.payload?.listId === 'string'
                && typeof action.payload?.listType === 'string'
                && Array.isArray(action.payload?.items)
            if (exact) {
                replaceExactBucket(state, action.payload)
                return
            }

            const items = Array.isArray(action.payload) ? action.payload : action.payload?.items
            const groups = new Map()
            for (const entry of Array.isArray(items) ? items : []) {
                if (isLabelItem(entry) || isPlanItem(entry)) continue
                const listId = entry?.listId || DEFAULT_LIST_ID
                const group = groups.get(listId) ?? { listType: entry?.listType || DEFAULT_LIST_TYPE, items: [] }
                group.items.push(entry)
                groups.set(listId, group)
            }
            if (groups.size === 0) groups.set(DEFAULT_LIST_ID, { listType: DEFAULT_LIST_TYPE, items: [] })
            for (const [listId, group] of groups) replaceListItems(state, listId, group.listType, group.items)
        },
        listItemAdded(state, action) {
            applyItemProjection(state, action.payload, 'add')
        },
        listItemUpdated(state, action) {
            applyItemProjection(state, action.payload, 'update')
        },
        listItemDeleted(state, action) {
            applyItemProjection(state, action.payload, 'delete')
        },
        selectedListCleared(state) {
            replaceListItems(state, DEFAULT_LIST_ID, DEFAULT_LIST_TYPE, [])
        },
        listsCleared(state) {
            state.selectedProjectId = DEFAULT_PROJECT_ID
            state.selectedListId = DEFAULT_SURFACE_ID
            state.projectIds = [DEFAULT_PROJECT_ID]
            state.projectsById = { [DEFAULT_PROJECT_ID]: { ...initialListsState.projectsById[DEFAULT_PROJECT_ID], folderIds: [DEFAULT_FOLDER_ID], listIds: [DEFAULT_LIST_ID] } }
            state.folderIds = [DEFAULT_FOLDER_ID]
            state.foldersById = { [DEFAULT_FOLDER_ID]: { ...initialListsState.foldersById[DEFAULT_FOLDER_ID], listIds: [DEFAULT_LIST_ID] } }
            state.listIds = [DEFAULT_LIST_ID]
            state.listsById = { [DEFAULT_LIST_ID]: { ...initialListsState.listsById[DEFAULT_LIST_ID], itemIds: [] } }
            state.itemsById = {}
        },
    },
})

export const listsActions = listsSlice.actions
export default listsSlice.reducer

// One-entry memo keyed on the lists slice reference. This walks every list and
// every item, and the desktop store calls it on each notification, so an
// unrelated action (a peer label, a preference) used to pay for a full rebuild.
// Redux hands back the same slice object when nothing in it changed, which makes
// a reference check both exact and O(1).
let _allItemsCacheKey = null
let _allItemsCacheValue = null

export const selectAllItems = (state) => {
    if (state.lists === _allItemsCacheKey) return _allItemsCacheValue
    const computed = computeAllItems(state)
    _allItemsCacheKey = state.lists
    _allItemsCacheValue = computed
    return computed
}

const computeAllItems = (state) => {
    const items = []
    const seen = new Set()
    for (const listId of state.lists.listIds) {
        for (const itemId of state.lists.listsById[listId]?.itemIds ?? []) {
            const item = state.lists.itemsById[itemId]
            if (!item || seen.has(itemId)) continue
            seen.add(itemId)
            items.push(item)
        }
    }
    // Cross-list overlays such as plan items intentionally have no ListRecord.
    for (const [itemId, item] of Object.entries(state.lists.itemsById)) {
        if (!seen.has(itemId)) items.push(item)
    }
    return items
}
