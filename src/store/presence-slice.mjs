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
