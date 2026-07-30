// DOM-owned state for the ticket drawer and the list-item inspector.
//
// Both surfaces are rebuilt wholesale on every render. Background peer,
// diagnostics and sync updates can therefore replace the focused field between
// two keystrokes even when the selected item did not change. Keep only the
// transient state the DOM owns — focused field/value/caret and scroll offsets —
// and only across a rebuild of the exact same surface + item.

const FIELD_SELECTOR = 'input, textarea, select, [contenteditable="true"]'
const SCROLL_SELECTOR = '.detail-split-scroll, .inspector-body'
const SELECTABLE_INPUT_TYPES = new Set(['text', 'password', 'search', 'url', 'tel', 'email', ''])

function isContentEditable (field) {
    return !!field && (field.isContentEditable === true || field.getAttribute?.('contenteditable') === 'true')
}

function isSelectable (field) {
    if (!field) return false
    if (field.tagName === 'TEXTAREA') return true
    return field.tagName === 'INPUT' && SELECTABLE_INPUT_TYPES.has(field.type ?? '')
}

export function createDrawerDomState () {
    let renderedKey = null

    const fields = (host) => [...(host.querySelectorAll(FIELD_SELECTOR) || [])]
    const scrollRegions = (host) => [...(host.querySelectorAll(SCROLL_SELECTOR) || [])]

    return {
        capture (host, key) {
            if (renderedKey !== key) return null
            const allFields = fields(host)
            const active = host.ownerDocument?.activeElement || null
            const focused = active && host.contains(active) && allFields.includes(active) ? active : null
            const hasValue = focused != null && 'value' in focused
            const hasChecked = focused != null && 'checked' in focused
            return {
                scrollTops: scrollRegions(host).map((region) => region.scrollTop || 0),
                fieldIndex: focused ? allFields.indexOf(focused) : -1,
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
            const field = snapshot.fieldIndex >= 0 ? fields(host)[snapshot.fieldIndex] : null
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
            // cannot pull the rebuilt drawer away from where the user was typing.
            const regions = scrollRegions(host)
            snapshot.scrollTops.forEach((top, index) => {
                if (regions[index]) regions[index].scrollTop = top
            })
        },
    }
}
