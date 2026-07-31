import { createSlice } from '@reduxjs/toolkit'
import { isLabelItem, isPresenceItem } from '@listam/domain'
import { baseScopedKey } from '@listam/domain/identity'

const isLabelOnly = (item) => isLabelItem(item) && !isPresenceItem(item)

// Desktop Redux state is intentionally ephemeral, but older in-memory/preloaded
// states keyed label rows by bare `item.id`. Several independent label channels
// reuse the same surface id (for example `default:shopping`), so opportunistically
// migrate those legacy keys before every write. This keeps hot-reload/custom
// preloads safe without making the ordinary snapshot format carry a migration.
function migrateLegacyLabelKeys(state) {
    for (const [storedKey, item] of Object.entries(state.itemsById)) {
        if (!isLabelOnly(item) || !item?.id) continue
        const scopedKey = baseScopedKey(item)
        if (storedKey === scopedKey) continue

        const current = state.itemsById[scopedKey]
        const currentAt = typeof current?.updatedAt === 'number' ? current.updatedAt : 0
        const incomingAt = typeof item.updatedAt === 'number' ? item.updatedAt : 0
        if (!current || incomingAt >= currentAt) state.itemsById[scopedKey] = item
        delete state.itemsById[storedKey]
    }
}

const labelsSlice = createSlice({
    name: 'labels',
    initialState: { itemsById: {} },
    reducers: {
        labelsApplied(state, action) {
            migrateLegacyLabelKeys(state)
            for (const item of action.payload ?? []) {
                if (isLabelOnly(item) && item.id) state.itemsById[baseScopedKey(item)] = item
            }
        },
        labelsSnapshotApplied(state, action) {
            migrateLegacyLabelKeys(state)
            const { listId, listType, items } = action.payload ?? {}
            if (!listId || !listType || !Array.isArray(items) || !isLabelOnly({ listType })) return
            for (const [itemId, item] of Object.entries(state.itemsById)) {
                if (item.listId === listId || (!item.listId && item.listType === listType)) {
                    delete state.itemsById[itemId]
                }
            }
            for (const item of items) {
                const normalized = {
                    ...item,
                    listId: item?.listId || listId,
                    listType: item?.listType || listType,
                }
                if (isLabelOnly(normalized) && normalized.listId === listId && normalized.id) {
                    state.itemsById[baseScopedKey(normalized)] = normalized
                }
            }
        },
        labelItemApplied(state, action) {
            migrateLegacyLabelKeys(state)
            const item = action.payload
            if (isLabelOnly(item) && item.id) state.itemsById[baseScopedKey(item)] = item
        },
        labelItemRemoved(state, action) {
            migrateLegacyLabelKeys(state)
            const item = action.payload
            if (item?.id) delete state.itemsById[baseScopedKey(item)]
        },
        labelsCleared(state) { state.itemsById = {} },
    },
})

export const labelsActions = labelsSlice.actions
export default labelsSlice.reducer
