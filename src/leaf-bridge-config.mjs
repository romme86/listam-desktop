// Shared between the renderer (settings UI, preferences) and the backend
// worker (TCP listener): the default port leaves dial and the validation for
// user-supplied ports. Kept dependency-free so both runtimes can import it.
export const DEFAULT_LEAF_BRIDGE_PORT = 9993

// Returns a valid TCP port (1–65535) or 0 when the value is unusable.
export function normalizeLeafBridgePort(value) {
    const port = Number(value)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return 0
    return port
}
