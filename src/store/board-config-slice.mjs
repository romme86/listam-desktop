import { createSlice } from '@reduxjs/toolkit'
import { normalizeBoardConfig } from '@listam/domain/board'

export const initialBoardConfigState = { config: null, canAdminister: false }

const boardConfigSlice = createSlice({
    name: 'boardConfig',
    initialState: initialBoardConfigState,
    reducers: {
        boardConfigReceived(state, action) {
            state.config = normalizeBoardConfig(action.payload?.config ?? null)
            state.canAdminister = !!action.payload?.canAdminister
        },
        boardConfigReset(state) {
            state.config = null
            state.canAdminister = false
        },
    },
})

export const boardConfigActions = boardConfigSlice.actions
export default boardConfigSlice.reducer
