// The two pieces of dialog state that live in the DOM, not in `ui`.
//
// There is no VDOM in this renderer (see ../dom.mjs): a dialog is rebuilt
// wholesale on every render, and renderAll runs on every store notify — a
// diagnostics entry, a presence heartbeat, a peer-count change. On a live mesh
// that is several rebuilds a minute with nothing the user did to cause them, and
// each one threw away:
//
//   • the scroll offset  — an open Settings dialog snapped back to the top while
//     it was being read, which is the "it glitches like it re-renders" report;
//   • the focused field  — a device name being typed lost focus, caret, and the
//     half-typed text with it, mid-word.
//
// Neither is a re-render bug. They are state that only the DOM was holding, so
// carry them across a rebuild instead. Two rules keep that from causing worse
// problems than it fixes:
//
//   1. SAME KIND ONLY. A scroll offset or caret from the Settings dialog means
//      nothing in the backup-password dialog that replaced it.
//   2. ONLY A FOCUSED FIELD'S VALUE IS CARRIED. That is the same rule
//      editableText uses in ui.mjs, and it is what stops a stale draft nobody is
//      typing into from clobbering a value the backend just updated.
//
// This lives outside ui.mjs so it can be driven by a fake host in node: desktop
// tests have no DOM, and the surface used here is small enough (querySelector,
// querySelectorAll, contains, ownerDocument.activeElement) to fake honestly.

// Restoring a caret is only meaningful — and only legal — on the text-like input
// types. Reading selectionStart off a checkbox yields null; WRITING it throws.
const SELECTABLE_INPUT_TYPES = new Set(['text', 'password', 'search', 'url', 'tel', 'email', ''])

function isSelectable (el) {
    if (!el) return false
    if (el.tagName === 'TEXTAREA') return true
    return el.tagName === 'INPUT' && SELECTABLE_INPUT_TYPES.has(el.type ?? '')
}

export function createDialogDomState () {
    // The kind currently ON SCREEN — set by commit() after a successful render,
    // so a capture can tell a re-render of the same dialog apart from a swap to
    // another one.
    let renderedKind = null

    function fields (host) {
        return [...(host.querySelectorAll('input, textarea') || [])]
    }

    return {
        /**
         * Snapshot the on-screen dialog, or null when there is nothing to carry.
         * Field identity is POSITIONAL: a dialog of a given kind builds the same
         * field list every render, so the nth field is the same field.
         */
        capture (host, kind) {
            if (renderedKind !== kind) return null
            const body = host.querySelector('.dialog-body')
            if (!body) return null
            const active = host.ownerDocument?.activeElement || null
            const focused = active && host.contains(active) && isSelectable(active) ? active : null
            return {
                scrollTop: body.scrollTop || 0,
                fieldIndex: focused ? fields(host).indexOf(focused) : -1,
                value: focused ? focused.value : null,
                selectionStart: focused ? focused.selectionStart : null,
                selectionEnd: focused ? focused.selectionEnd : null,
            }
        },

        /** Record what is now on screen. Call after the rebuild, before restore. */
        commit (kind) {
            renderedKind = kind
        },

        /** Nothing is on screen — the next capture must not carry anything. */
        clear () {
            renderedKind = null
        },

        restore (host, snapshot) {
            if (!snapshot) return
            const body = host.querySelector('.dialog-body')
            // Assigning past the new scrollHeight is clamped by the browser, so a
            // dialog that shrank lands at its own bottom rather than at the top.
            if (body && snapshot.scrollTop > 0) body.scrollTop = snapshot.scrollTop
            if (snapshot.fieldIndex < 0) return
            const field = fields(host)[snapshot.fieldIndex]
            if (!field) return
            if (snapshot.value != null) field.value = snapshot.value
            // Synchronous: a dialog that autofocuses in a microtask still wins,
            // which is its pre-existing behaviour and not this module's call.
            field.focus?.({ preventScroll: true })
            try {
                field.setSelectionRange?.(
                    snapshot.selectionStart ?? field.value.length,
                    snapshot.selectionEnd ?? field.value.length,
                )
            } catch { /* the type stopped supporting selection; focus alone is enough */ }
        },
    }
}
