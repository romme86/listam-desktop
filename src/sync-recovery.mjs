// Keep the renderer's in-memory projection converged with the durable backend
// view. Incremental events remain the fast path; this periodic full sync repairs
// a dropped worker-pipe event without requiring the user to restart the app.
export function installSyncRecovery({
    requestSync,
    windowTarget = globalThis.window,
    documentTarget = globalThis.document,
    intervalMs = 15_000,
    setIntervalFn = globalThis.setInterval?.bind(globalThis),
    clearIntervalFn = globalThis.clearInterval?.bind(globalThis),
}) {
    let inFlight = null

    const refresh = () => {
        if (inFlight) return inFlight
        inFlight = Promise.resolve()
            .then(requestSync)
            .catch(() => null)
            .finally(() => { inFlight = null })
        return inFlight
    }

    const onFocus = () => refresh()
    const onOnline = () => refresh()
    const onVisibility = () => {
        if (!documentTarget || documentTarget.visibilityState === 'visible') return refresh()
        return null
    }

    windowTarget?.addEventListener?.('focus', onFocus)
    windowTarget?.addEventListener?.('online', onOnline)
    documentTarget?.addEventListener?.('visibilitychange', onVisibility)
    const timer = setIntervalFn?.(() => {
        if (!documentTarget || documentTarget.visibilityState !== 'hidden') return refresh()
        return null
    }, intervalMs)

    return {
        refresh,
        dispose() {
            windowTarget?.removeEventListener?.('focus', onFocus)
            windowTarget?.removeEventListener?.('online', onOnline)
            documentTarget?.removeEventListener?.('visibilitychange', onVisibility)
            if (timer !== undefined) clearIntervalFn?.(timer)
        },
    }
}
