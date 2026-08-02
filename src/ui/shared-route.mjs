// Adopt the route returned by SHARE_LIST immediately. The replicated registry
// will eventually carry the same base key, but the currently selected surface
// predates that echo and must be able to write in the meantime.
export function adoptSharedListRoute (ui, { sourceListId, result } = {}) {
    if (!ui || ui.activeListId !== sourceListId) return false
    if (!result?.ok || typeof result.baseKey !== 'string' || !result.baseKey) return false
    ui.activeBaseKey = result.baseKey
    return true
}
