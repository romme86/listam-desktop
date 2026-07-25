import { createSlice } from '@reduxjs/toolkit'
import { isPresenceItem } from '@listam/domain'

const presenceSlice = createSlice({
    name: 'presence',
    initialState: { itemsById: {} },
    reducers: {
        presenceApplied(state, action) {
            for (const item of action.payload ?? []) {
                if (isPresenceItem(item) && item.id) state.itemsById[item.id] = item
            }
        },
        presenceSnapshotApplied(state, action) {
            const { listId, listType, items } = action.payload ?? {}
            if (!listId || !listType || !Array.isArray(items) || !isPresenceItem({ listType })) return
            for (const [itemId, item] of Object.entries(state.itemsById)) {
                if (isPresenceItem(item)) delete state.itemsById[itemId]
            }
            for (const item of items) {
                const normalized = {
                    ...item,
                    listId: item?.listId || listId,
                    listType: item?.listType || listType,
                }
                if (isPresenceItem(normalized) && normalized.listId === listId && normalized.id) {
                    state.itemsById[normalized.id] = normalized
                }
            }
        },
        presenceItemApplied(state, action) {
            const item = action.payload
            if (isPresenceItem(item) && item.id) state.itemsById[item.id] = item
        },
        presenceItemRemoved(state, action) {
            const item = action.payload
            if (item?.id) delete state.itemsById[item.id]
        },
        presenceCleared(state) { state.itemsById = {} },
    },
})

export const presenceActions = presenceSlice.actions
export default presenceSlice.reducer
