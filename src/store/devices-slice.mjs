import { createSlice } from '@reduxjs/toolkit'

export const initialDevicesState = {
    hasRoster: false,
    currentEpoch: 0,
    ownerWriterKey: null,
    canAdminister: false,
    localWriterKey: null,
    writable: false,
    writerIds: [],
    writersById: {},
}

const devicesSlice = createSlice({
    name: 'devices',
    initialState: initialDevicesState,
    reducers: {
        rosterReceived(state, action) {
            const roster = action.payload
            Object.assign(state, initialDevicesState)
            if (!roster) return
            const writers = Array.isArray(roster.writers) ? roster.writers : Array.isArray(roster.members) ? roster.members : []
            state.hasRoster = true
            state.currentEpoch = Number.isFinite(roster.currentEpoch) ? roster.currentEpoch : 0
            state.ownerWriterKey = roster.ownerWriterKey ?? null
            state.canAdminister = !!roster.canAdminister
            state.localWriterKey = typeof roster.localWriterKey === 'string' ? roster.localWriterKey : null
            state.writable = roster.writable !== false
            for (const member of writers) {
                if (!member?.writerKey) continue
                state.writerIds.push(member.writerKey)
                state.writersById[member.writerKey] = {
                    writerKey: member.writerKey,
                    isOwner: !!member.isOwner,
                    isSelf: !!member.isSelf,
                    joinedAt: typeof member.joinedAt === 'number' ? member.joinedAt : null,
                }
            }
        },
    },
})

export const devicesActions = devicesSlice.actions
export default devicesSlice.reducer

export function selectMembershipRoster(state) {
    const devices = state.devices
    if (!devices.hasRoster) return null
    return {
        currentEpoch: devices.currentEpoch,
        ownerWriterKey: devices.ownerWriterKey,
        canAdminister: devices.canAdminister,
        localWriterKey: devices.localWriterKey,
        writable: devices.writable,
        writers: devices.writerIds.map((id) => devices.writersById[id]).filter(Boolean),
    }
}
