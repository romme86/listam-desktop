// DOM-owned state for a surface that is rebuilt wholesale on every render.
//
// There is no VDOM here (see ../dom.mjs): the drawer, the item inspector and the
// whole main pane are thrown away and rebuilt from scratch on every store
// notify. Background peer, presence, diagnostics and sync updates fire several
// times a minute with nothing the user did to cause them, so a rebuild lands
// BETWEEN two keystrokes: the focused field is detached mid-word, focus falls to
// <body>, the half-typed draft is replaced by the canonical value — and every
// further keystroke is then read as a global single-key shortcut (t flips the
// theme, [ ] switch lists) because it no longer has a field to land in.
//
// Keep only the transient state the DOM itself owns — focused field, its value,
// caret and scroll offsets — and carry it across a rebuild of the SAME surface.
// Three rules keep that from causing worse problems than it fixes:
//
//   1. SAME KEY ONLY. A caret from the Peers pane means nothing in the board
//      pane that replaced it, and a draft from ticket A must not land in B.
//   2. ONLY THE FOCUSED FIELD'S VALUE IS CARRIED. An unfocused field has no
//      uncommitted draft, so it must follow the canonical (possibly just-synced)
//      value instead of a stale one.
//   3. THE FIELD AT THAT INDEX MUST STILL BE THE SAME FIELD. Field identity is
//      positional, which holds while a surface renders the same shape — but a
//      peer can add a row and shift the list. The signature check makes that
//      case drop the snapshot instead of pasting the draft into a stranger.
//
// This lives outside ui.mjs so it can be driven by a fake host in node: desktop
// tests have no DOM, and the surface used here is small enough (querySelectorAll,
// contains, ownerDocument.activeElement) to fake honestly.

const FIELD_SELECTOR = 'input, textarea, select, [contenteditable="true"]'
const SELECTABLE_INPUT_TYPES = new Set(['text', 'password', 'search', 'url', 'tel', 'email', ''])

function isContentEditable (field) {
    return !!field && (field.isContentEditable === true || field.getAttribute?.('contenteditable') === 'true')
}

function isSelectable (field) {
    if (!field) return false
    if (field.tagName === 'TEXTAREA') return true
    return field.tagName === 'INPUT' && SELECTABLE_INPUT_TYPES.has(field.type ?? '')
}

// What makes this field *this* field, independent of its value. Cheap, and
// stable across a rebuild that only changed content.
function signatureOf (field) {
    if (!field) return null
    return [field.tagName, field.type, field.id, field.name, field.placeholder]
        .map((part) => part ?? '')
        .join('|')
}

/**
 * @param {object} [options]
 * @param {string} [options.scrollSelector] Scroll containers inside the surface
 *   whose offsets must survive the rebuild. Omit when the surface does not
 *   scroll itself (the main pane scrolls the document, not a child).
 */
export function createSurfaceDomState ({ scrollSelector = '' } = {}) {
    let renderedKey = null

    const fields = (host) => [...(host.querySelectorAll(FIELD_SELECTOR) || [])]
    const scrollRegions = (host) => scrollSelector ? [...(host.querySelectorAll(scrollSelector) || [])] : []

    return {
        capture (host, key) {
            if (renderedKey !== key) return null
            // renderAll runs several times a minute on a live mesh with nobody
            // typing, and the main pane's subtree is the whole list. Only walk it
            // when focus is actually inside this surface — with focus elsewhere
            // there is no field index to record anyway.
            const active = host.ownerDocument?.activeElement || null
            const allFields = active && host.contains(active) ? fields(host) : []
            const focused = allFields.includes(active) ? active : null
            const hasValue = focused != null && 'value' in focused
            const hasChecked = focused != null && 'checked' in focused
            return {
                scrollTops: scrollRegions(host).map((region) => region.scrollTop || 0),
                fieldIndex: focused ? allFields.indexOf(focused) : -1,
                signature: signatureOf(focused),
                value: hasValue ? focused.value : null,
                checked: hasChecked ? !!focused.checked : null,
                selectionStart: focused && isSelectable(focused) ? focused.selectionStart : null,
                selectionEnd: focused && isSelectable(focused) ? focused.selectionEnd : null,
                contentEditable: isContentEditable(focused),
            }
        },

        commit (key) {
            renderedKey = key
        },

        clear () {
            renderedKey = null
        },

        restore (host, snapshot, { restoreContentEditable } = {}) {
            if (!snapshot) return
            const candidate = snapshot.fieldIndex >= 0 ? fields(host)[snapshot.fieldIndex] : null
            // Rule 3: the shape shifted under us (a peer added a row, a section
            // appeared) — carrying a draft into whatever now sits at that index
            // would be worse than losing the focus.
            const field = signatureOf(candidate) === snapshot.signature ? candidate : null
            if (field) {
                if (snapshot.value != null && 'value' in field) field.value = snapshot.value
                if (snapshot.checked != null && 'checked' in field) field.checked = snapshot.checked
                field.focus?.({ preventScroll: true })
                if (snapshot.contentEditable) {
                    restoreContentEditable?.(field)
                } else if (isSelectable(field)) {
                    const end = String(field.value ?? '').length
                    try {
                        field.setSelectionRange?.(
                            snapshot.selectionStart ?? end,
                            snapshot.selectionEnd ?? end,
                        )
                    } catch { /* a field type changed during the rebuild */ }
                }
            }
            // Restore scroll after focus so even engines that ignore preventScroll
            // cannot pull the rebuilt surface away from where the user was typing.
            const regions = scrollRegions(host)
            snapshot.scrollTops.forEach((top, index) => {
                if (regions[index]) regions[index].scrollTop = top
            })
        },
    }
}
