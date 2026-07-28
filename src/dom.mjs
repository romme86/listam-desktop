// The renderer's two DOM primitives.
//
// These live outside ui.mjs so that modules extracted OUT of ui.mjs can build
// DOM without importing ui.mjs back — which would be a cycle, and would also
// mean a node test of an extracted module had to pull in the whole renderer.
//
// There is no framework here on purpose: the desktop app has no build step, so
// `h` is a thin wrapper over document.createElement rather than a VDOM. Callers
// rebuild subtrees wholesale and let replaceChildren swap them in.

/** Replace a host's children, dropping null/undefined so callers can inline conditionals. */
export function replaceChildren (host, ...children) {
    host.replaceChildren(...children.filter((child) => child != null))
}

/**
 * Build an element. `class` sets className, `dataset` merges into dataset,
 * `onX` registers a listener, anything else becomes an attribute (skipped when
 * null/undefined, so optional attributes can be passed unconditionally).
 * Children are flattened; nulls are dropped and primitives become text nodes.
 */
export function h (tag, props = {}, ...children) {
    const el = document.createElement(tag)
    for (const [key, value] of Object.entries(props)) {
        if (key === 'class') el.className = value
        else if (key === 'dataset') Object.assign(el.dataset, value)
        else if (key.startsWith('on')) el.addEventListener(key.slice(2), value)
        else if (value !== undefined && value !== null) el.setAttribute(key, value)
    }
    for (const child of children.flat()) {
        if (child == null) continue
        el.append(child.nodeType ? child : document.createTextNode(String(child)))
    }
    return el
}
