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
