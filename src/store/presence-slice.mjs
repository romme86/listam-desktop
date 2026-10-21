import { createSlice } from '@reduxjs/toolkit'
import { isPresenceItem } from '@listam/domain'

const presenceSlice = createSlice({
    name: 'presence',
    initialState: { itemsById: {}, liveItemsById: {} },
    reducers: {
        livePresenceApplied(state, action) {
            const item = action.payload
            if (!isPresenceItem(item) || !item.id) return
            state.liveItemsById ??= {}
            const previous = state.liveItemsById[item.id]
            if (!previous || Number(item.updatedAt) > Number(previous.updatedAt)) state.liveItemsById[item.id] = item
        },
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
            if (item?.id && state.liveItemsById) delete state.liveItemsById[item.id]
        },
        presenceCleared(state) { state.itemsById = {}; state.liveItemsById = {} },
    },
    extraReducers: (builder) => {
        builder.addCase('sync/projectionSnapshotReceived', (state, { payload }) => {
            for (const [key, item] of Object.entries(state.itemsById)) {
                if (payload.role === 'personal' ? !item.baseKey : item.baseKey === payload.baseKey) delete state.itemsById[key]
            }
            for (const item of payload.items) {
                if (isPresenceItem(item) && item.id) state.itemsById[item.id] = item
            }
        })
    },
})

export const presenceActions = presenceSlice.actions
export default presenceSlice.reducer
