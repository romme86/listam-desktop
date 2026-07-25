import { createSlice } from '@reduxjs/toolkit'
import { isLabelItem, isPresenceItem } from '@listam/domain'

const isLabelOnly = (item) => isLabelItem(item) && !isPresenceItem(item)

const labelsSlice = createSlice({
    name: 'labels',
    initialState: { itemsById: {} },
    reducers: {
        labelsApplied(state, action) {
            for (const item of action.payload ?? []) {
                if (isLabelOnly(item) && item.id) state.itemsById[item.id] = item
            }
        },
        labelsSnapshotApplied(state, action) {
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
                    state.itemsById[normalized.id] = normalized
                }
            }
        },
        labelItemApplied(state, action) {
            const item = action.payload
            if (isLabelOnly(item) && item.id) state.itemsById[item.id] = item
        },
        labelItemRemoved(state, action) {
            const item = action.payload
            if (item?.id) delete state.itemsById[item.id]
        },
        labelsCleared(state) { state.itemsById = {} },
    },
})

export const labelsActions = labelsSlice.actions
export default labelsSlice.reducer
