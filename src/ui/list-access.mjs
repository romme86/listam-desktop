import { DEFAULT_LIST_ID } from '@listam/domain/identity'
import { reduceRegistry } from '@listam/domain/list-registry'

// Shared lists have independent writer sets and owner-signed board settings.
// Missing shared state must never fall back to the personal project's authority.
export function listAccess(state, listId) {
    const entry = listId === DEFAULT_LIST_ID ? null : reduceRegistry(state.items).lists.find((list) => list.id === listId)
    const baseKey = entry?.baseKey || null
    if (baseKey) return { baseKey, ...state.sharedListState?.[baseKey] }
    return { baseKey: null, roster: state.roster, boardConfig: state.boardConfig, canAdminister: !!state.boardConfigCanAdminister }
}
