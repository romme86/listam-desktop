import { createSlice } from '@reduxjs/toolkit'
import { isLabelItem, isPlanItem, surfaceLabelKey } from '@listam/domain'
import { REGISTRY_LIST_TYPE } from '@listam/domain/list-registry'
import { isFromAuthoritativeBase, listBaseFromRegistryItem } from '@listam/domain/authoritative-base'
import {
    DEFAULT_LIST_ID,
    DEFAULT_LIST_TYPE,
    deleteListEntry,
    identityKey,
    normalizeListEntries,
    updateListEntry,
    upsertListEntry,
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

function replaceListItems(state, listId, listType, entries) {
    const list = ensureList(state, listId, listType)
    for (const itemId of list.itemIds) delete state.itemsById[itemId]
    const normalized = normalizeListEntries(
        entries
            .filter((entry) => !isLabelItem(entry) && !isPlanItem(entry) && !isSharedRegistryItem(entry))
            .map((entry) => ({
                ...entry,
                listId: entry.listId || listId,
                listType: entry.listType || list.type || listType,
            })),
    )
    list.itemIds = []
    for (const item of normalized) {
        const itemId = identityKey(item)
        state.itemsById[itemId] = item
        if (!list.itemIds.includes(itemId)) list.itemIds.push(itemId)
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
            state.itemsById[identityKey(item)] = item
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
    // independently, so the delete can land AFTER the seed — and identityKey
    // (listId + itemId, no base) makes it match, emptying the list that was just
    // shared. Ignore events from a base this list was promoted away from.
    // Fails open for lists the registry has not described yet.
    if (!routing && !isFromAuthoritativeBase(normalized, state.baseByListId)) return
    const itemId = identityKey(normalized)
    if (isPlanItem(normalized)) {
        if (operation === 'delete') delete state.itemsById[itemId]
        else state.itemsById[itemId] = normalized
        return
    }
    const listId = normalized.listId || DEFAULT_LIST_ID
    const listType = normalized.listType || DEFAULT_LIST_TYPE
    ensureList(state, listId, listType)
    removeIdentityFromOtherLists(state, itemId, listId)
    const current = entriesForList(state, listId)
    const next = operation === 'delete'
        ? deleteListEntry(current, normalized)
        : operation === 'update'
            ? updateListEntry(current, normalized)
            : upsertListEntry(current, normalized)
    replaceListItems(state, listId, listType, next)
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

export const selectAllItems = (state) => {
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
